import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeLog, noCallbacks } from './helpers';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken, tokenKey } from '../../src/auth';
import { canonicalJson, hashState, type DecisionLog } from '../../src/log';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import * as contract from '../../generated/openapi-validators.mjs';

const BASE = 'http://pointsman.test';
const ALL = newToken();
const TRIAGE_ONLY = newToken();
const DB = (env as unknown as { DB: D1Database }).DB;

beforeEach(async () => {
  for (const [token, client, profiles] of [[ALL, 'all', ['*']], [TRIAGE_ONLY, 'triage', ['issue-triage']]] as const) {
    await env.TOKENS.put(tokenKey(await hashToken(token)), JSON.stringify({ client, profiles, created_at: '' }));
  }
});

function call(method: string, path: string, body?: unknown, token = ALL) {
  return exports.default.fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const issue = { issue: { title: 'Login page is blank', body: 'Since this morning.', reporter: 'someone' } };

async function decide(profile = 'issue-triage', body: Record<string, unknown> = { state: issue, ref: 'example:1' }, token = ALL) {
  const res = await call('POST', `/v1/decide/${profile}`, body, token);
  expect(res.status).toBe(200);
  return (await res.json<any>()).decision_id as string;
}

async function getRecord(id: string, token = ALL) {
  const res = await call('GET', `/v1/decisions/${id}`, undefined, token);
  return { res, data: res.status === 200 ? await res.json<any>() : await res.json<any>() };
}

describe('decision log', () => {
  it('stores every decision with profile version, model, client and rule', async () => {
    const id = await decide();
    const { res, data } = await getRecord(id);
    expect(res.status).toBe(200);
    expect(contract.decisionRecord(data), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
    expect(data).toMatchObject({
      decision_id: id,
      client: 'all',
      ref: 'example:1',
      profile: 'issue-triage',
      profile_version: 1,
      model: 'mock',
      action: 'auto',
      rule: 0,
      feedback: [],
    });
    expect(data.answers.team).toMatchObject({ value: 'backend', p: 0.9 });
    expect(Date.parse(data.created_at)).not.toBeNaN();
  });

  it('records rule null when the default action applied', async () => {
    const { data } = await getRecord(await decide('deploy-progress', { state: 'No event for 40 minutes.' }));
    expect(data).toMatchObject({ action: 'continue', rule: null });
    expect(data.ref).toBeUndefined();
  });

  it('stores only a hash of the state by default', async () => {
    const id = await decide();
    const { data } = await getRecord(id);
    // The hash is of the state sent to the model (after the input mapping).
    expect(data.state_hash).toBe(await hashState({ title: issue.issue.title, body: issue.issue.body }));
    expect(data.state).toBeUndefined();
    const row = await DB.prepare('SELECT state FROM decisions WHERE id = ?').bind(id).first<{ state: string | null }>();
    expect(row?.state).toBeNull();
  });

  it('does not return the callback_url', async () => {
    const id = await decide('issue-triage', { state: issue, callback_url: 'https://example.com/cb' });
    const { data } = await getRecord(id);
    expect(data.callback_url).toBeUndefined();
    const row = await DB.prepare('SELECT callback_url FROM decisions WHERE id = ?').bind(id).first<{ callback_url: string }>();
    expect(row?.callback_url).toBe('https://example.com/cb');
  });

  it('never stores the token', async () => {
    const id = await decide();
    const row = await DB.prepare('SELECT * FROM decisions WHERE id = ?').bind(id).first();
    expect(JSON.stringify(row)).not.toContain(ALL);
  });

  it.each([
    ['an unknown id', '00000000-0000-4000-8000-000000000000'],
    ['a malformed id', 'not-a-uuid'],
  ])('answers 404 for %s', async (_, id) => {
    const { res, data } = await getRecord(id);
    expect(res.status).toBe(404);
    expect(data.error.code).toBe('decision_not_found');
  });

  it('hides decisions of profiles out of the token scope', async () => {
    const id = await decide('deploy-progress', { state: 'text' });
    const { res } = await getRecord(id, TRIAGE_ONLY);
    expect(res.status).toBe(404);
    expect((await call('POST', `/v1/decisions/${id}/feedback`, { correct: { stuck: true }, by: 'x' }, TRIAGE_ONLY)).status).toBe(404);
  });
});

describe('store_state', () => {
  const profiles = (bundled as Profile[]).map((p) => (p.id === 'deploy-progress' ? { ...p, log: { store_state: true } } : p));
  const tokens = new MemoryTokenStore();
  const stored: unknown[] = [];
  const log: DecisionLog = fakeLog({ insert: async (r) => void stored.push(r) });

  it('stores the full state when the profile asks for it', async () => {
    tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    const deps: Deps = { callbacks: noCallbacks, store: new MemoryProfileStore(profiles), tokens, log, adapterFor: () => new MockAdapter() };
    const res = await createApp(() => deps).request('/v1/decide/deploy-progress', {
      method: 'POST',
      headers: { authorization: `Bearer ${ALL}` },
      body: JSON.stringify({ state: { events: ['a', 'b'] } }),
    }, env);
    expect(res.status).toBe(200);
    expect(stored[0]).toMatchObject({ state: { events: ['a', 'b'] }, state_hash: await hashState({ events: ['a', 'b'] }) });
  });

  it('answers 500 and returns no decision when the log fails', async () => {
    tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    const failing: DecisionLog = { ...log, insert: async () => { throw new Error('D1 down'); } };
    const deps: Deps = { callbacks: noCallbacks, store: new MemoryProfileStore(profiles), tokens, log: failing, adapterFor: () => new MockAdapter() };
    const res = await createApp(() => deps).request('/v1/decide/deploy-progress', {
      method: 'POST',
      headers: { authorization: `Bearer ${ALL}` },
      body: JSON.stringify({ state: 'x' }),
    }, env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('decision_id');
    expect(text).not.toContain('D1 down');
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
  it('writes values JSON cannot hold as null, like JSON.stringify does in arrays', () => {
    expect(canonicalJson([undefined, () => 1, 1])).toBe(JSON.stringify([undefined, () => 1, 1]));
    expect(canonicalJson([undefined])).toBe('[null]');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });

  it('gives equal hashes for equal states with different key order', async () => {
    expect(await hashState({ a: 1, b: 2 })).toBe(await hashState({ b: 2, a: 1 }));
    expect(await hashState('text')).not.toBe(await hashState('text '));
  });
});

describe('feedback', () => {
  it('is stored and linked to the decision', async () => {
    const id = await decide();
    const res = await call('POST', `/v1/decisions/${id}/feedback`, {
      correct: { team: 'frontend', urgent: true, effort: 2 },
      by: 'reviewer@example.com',
      note: 'Login is frontend.',
    });
    expect(res.status).toBe(204);
    await call('POST', `/v1/decisions/${id}/feedback`, { correct: { team: 'docs' }, by: 'second' });

    const { data } = await getRecord(id);
    expect(contract.decisionRecord(data), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
    expect(data.feedback).toHaveLength(2);
    expect(data.feedback[0]).toMatchObject({
      client: 'all',
      by: 'reviewer@example.com',
      correct: { team: 'frontend', urgent: true, effort: 2 },
      note: 'Login is frontend.',
    });
    expect(data.feedback[1]).toMatchObject({ by: 'second', correct: { team: 'docs' } });
    expect(data.feedback[1].note).toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{', 'body must be valid JSON'],
    ['an array', [], 'body must be a JSON object'],
    ['no by', { correct: { team: 'docs' } }, '"by"'],
    ['an empty by', { correct: { team: 'docs' }, by: ' ' }, '"by"'],
    ['a too long note', { correct: { team: 'docs' }, by: 'x', note: 'n'.repeat(1001) }, '"note"'],
    ['an unknown field', { correct: { team: 'docs' }, by: 'x', score: 1 }, 'unknown field'],
    ['no correct', { by: 'x' }, '"correct"'],
    ['an empty correct', { correct: {}, by: 'x' }, '"correct"'],
    ['an unknown question', { correct: { teem: 'docs' }, by: 'x' }, '"teem" is not a question'],
    ['an unknown option', { correct: { team: 'ops' }, by: 'x' }, 'must be one of: backend, frontend, docs'],
    ['a non-boolean noul', { correct: { urgent: 'yes' }, by: 'x' }, 'must be true or false'],
    ['a score out of range', { correct: { effort: 4 }, by: 'x' }, 'level from 0 to 3'],
    ['a fractional score', { correct: { effort: 1.5 }, by: 'x' }, 'level from 0 to 3'],
  ])('rejects %s', async (_, body, message) => {
    const id = await decide();
    const res = await exports.default.fetch(`${BASE}/v1/decisions/${id}/feedback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ALL}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const data = await res.json<any>();
    expect(contract.error(data)).toBe(true);
    expect(data.error.message).toContain(message);
    expect((await getRecord(id)).data.feedback).toEqual([]);
  });

  it('answers 404 for an unknown decision', async () => {
    const res = await call('POST', '/v1/decisions/00000000-0000-4000-8000-000000000000/feedback', { correct: { team: 'docs' }, by: 'x' });
    expect(res.status).toBe(404);
  });

  it('answers 409 when the profile version is gone', async () => {
    const id = await decide();
    await DB.prepare('UPDATE decisions SET profile_version = 99 WHERE id = ?').bind(id).run();
    const res = await call('POST', `/v1/decisions/${id}/feedback`, { correct: { team: 'docs' }, by: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe('profile_version_gone');
  });

  it('requires a token', async () => {
    const id = await decide();
    const res = await exports.default.fetch(`${BASE}/v1/decisions/${id}/feedback`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});
