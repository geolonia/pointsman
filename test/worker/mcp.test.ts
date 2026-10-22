// MCP endpoint (/mcp): JSON-RPC over Streamable HTTP, with API tokens.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken, newToken, tokenKey } from '../../src/auth';
import { D1DecisionLog } from '../../src/log-d1';

const ALL = newToken();
const DEPLOY_ONLY = newToken();
const TEST_ONLY = newToken();
const DB = (env as unknown as { DB: D1Database }).DB;

beforeEach(async () => {
  for (const [token, client, profiles] of [[ALL, 'agent', ['*']], [DEPLOY_ONLY, 'deploy-bot', ['deploy-progress']]] as const) {
    await env.TOKENS.put(tokenKey(await hashToken(token)), JSON.stringify({ client, profiles, created_at: '' }));
  }
  await env.TOKENS.put(tokenKey(await hashToken(TEST_ONLY)), JSON.stringify({ client: 'examples-check', profiles: ['*'], created_at: '', test: true }));
});

let nextId = 1;

/** One JSON-RPC request; returns the result (or error) from the event stream. */
async function rpc(method: string, params: unknown = {}, token: string | null = ALL) {
  const res = await exports.default.fetch('http://pointsman.test/mcp', {
    method: 'POST',
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, headers: res.headers, text };
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return { status: 200, message: data.at(-1) };
}

async function call(name: string, args: Record<string, unknown>, token: string | null = ALL) {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  const result = r.message.result;
  return { isError: result.isError === true, text: result.content[0].text as string };
}

describe('/mcp', () => {
  it('needs a valid token', async () => {
    const r = await rpc('tools/list', {}, null);
    expect(r.status).toBe(401);
    expect(r.headers?.get('www-authenticate')).toBe('Bearer');
    expect((await rpc('tools/list', {}, newToken())).status).toBe(401);
  });

  it('initializes and offers list_profiles, explain_profile, decide and get_decision (no feedback for tokens)', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.message.result.serverInfo.name).toBe('pointsman');
    const tools = (await rpc('tools/list')).message.result.tools.map((t: any) => t.name).sort();
    expect(tools).toEqual(['decide', 'explain_profile', 'get_decision', 'list_profiles', 'replay_profile']);
  });

  it('explains an MCP-visible profile in scope, and hides the others', async () => {
    const en = await call('explain_profile', { profile: 'issue-triage' });
    expect(en.isError).toBe(false);
    const e = JSON.parse(en.text);
    expect(e.rules[0].text).toBe('If the AI\'s certainty about "team" is at least 85 %, the action is auto.');
    expect(e.text).toContain('# Issue triage (issue-triage, v');
    const ja = JSON.parse((await call('explain_profile', { profile: 'issue-triage', lang: 'ja' })).text);
    expect(ja.rules[0].text).toBe('「team」についての AI の確信度が 85 % 以上なら、アクションは auto です。');
    // Not MCP-visible, out of scope, unknown, or an unknown version: all look the same.
    for (const [args, token] of [[{ profile: 'deploy-progress' }, ALL], [{ profile: 'issue-triage' }, DEPLOY_ONLY], [{ profile: 'nope' }, ALL]] as const) {
      const r = await call('explain_profile', args, token);
      expect(r).toEqual({ isError: true, text: `unknown profile "${args.profile}"` });
    }
    expect((await call('explain_profile', { profile: 'issue-triage', version: 99 })).isError).toBe(true);
  });

  it('replays a changed policy of an MCP-visible profile, and hides the others', async () => {
    // Two logged decisions of issue-triage through the real log.
    for (const ref of ['mcp-replay:1', 'mcp-replay:2']) {
      const d = await call('decide', { profile: 'issue-triage', state: { title: 'Blank page', body: 'Since today.' }, ref });
      expect(d.isError).toBe(false);
    }
    const r = await call('replay_profile', { profile: 'issue-triage', policy: { default: 'review' }, limit: 2 });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body).toMatchObject({ profile: 'issue-triage', replayed: 2 });
    expect(body.actions.after).toEqual({ review: 2 });
    // Not MCP-visible, out of scope, unknown: all look the same.
    for (const [args, token] of [[{ profile: 'deploy-progress' }, ALL], [{ profile: 'issue-triage' }, DEPLOY_ONLY], [{ profile: 'nope' }, ALL]] as const) {
      expect(await call('replay_profile', { ...args, policy: { default: 'review' } }, token)).toEqual({ isError: true, text: `unknown profile "${args.profile}"` });
    }
    const bad = await call('replay_profile', { profile: 'issue-triage', policy: { default: 'review', rules: [{ when: 'colour.p > 0', action: 'auto' }] } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^invalid_policy: rule 0: /);
  });

  it('lists only profiles that are MCP-visible and in scope', async () => {
    const all = JSON.parse((await call('list_profiles', {})).text);
    // deploy-progress does not set mcp.visible.
    expect(all.profiles.map((p: any) => p.id)).toEqual(['issue-triage']);
    expect(all.profiles[0]).toMatchObject({
      version: 1,
      state: { fields: ['title', 'body'] },
      actions: ['auto', 'review'],
    });
    expect(all.profiles[0].questions[0]).toMatchObject({ name: 'team', type: 'choice', options: ['backend', 'frontend', 'docs'] });
    expect(JSON.parse((await call('list_profiles', {}, DEPLOY_ONLY)).text).profiles).toEqual([]);
  });

  it('decides and logs the decision with the token client', async () => {
    const r = await call('decide', { profile: 'issue-triage', state: { title: 'Login page is blank', body: 'Since this morning.' }, ref: 'mcp:1' });
    expect(r.isError).toBe(false);
    const d = JSON.parse(r.text);
    expect(d).toMatchObject({ profile: 'issue-triage', profile_version: 1, action: 'auto', ref: 'mcp:1' });
    expect(d.answers.team.value).toBe('backend');
    const row = await DB.prepare('SELECT client, ref FROM decisions WHERE id = ?').bind(d.decision_id).first();
    expect(row).toEqual({ client: 'agent', ref: 'mcp:1' });
  });

  it.each([
    ['a profile that is not MCP-visible', ALL, { profile: 'deploy-progress', state: 'x' }, 'unknown profile "deploy-progress"'],
    ['a profile out of scope', DEPLOY_ONLY, { profile: 'issue-triage', state: { title: 't' } }, 'unknown profile "issue-triage"'],
    ['an unknown profile', ALL, { profile: 'nope', state: 'x' }, 'unknown profile "nope"'],
    ['a state without the input fields', ALL, { profile: 'issue-triage', state: { other: 1 } }, 'at least one of: title, body'],
    ['a raw payload instead of the input fields', ALL, { profile: 'issue-triage', state: { issue: { title: 't' } } }, 'at least one of: title, body'],
    ['a text state for a profile with input fields', ALL, { profile: 'issue-triage', state: 'just text' }, 'at least one of: title, body'],
    ['an empty text state', ALL, { profile: 'issue-triage', state: ' ' }, 'invalid_request'],
  ])('decide refuses %s', async (_, token, args, message) => {
    const r = await call('decide', args, token);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(message);
  });

  it('gets a decision in scope, without state or callback_url', async () => {
    const d = JSON.parse((await call('decide', { profile: 'issue-triage', state: { title: 'T' } })).text);
    const got = await call('get_decision', { decision_id: d.decision_id });
    expect(got.isError).toBe(false);
    const record = JSON.parse(got.text);
    expect(record).toMatchObject({ decision_id: d.decision_id, client: 'agent', feedback: [] });
    expect(record.state).toBeUndefined();
    expect(record.callback_url).toBeUndefined();

    expect((await call('get_decision', { decision_id: d.decision_id }, DEPLOY_ONLY)).isError).toBe(true);

    // A decision of a profile that is not MCP-visible (made through REST) looks unknown.
    const rest = await exports.default.fetch('http://pointsman.test/v1/decide/deploy-progress', {
      method: 'POST',
      headers: { authorization: `Bearer ${ALL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'No stack event for 40 minutes.' }),
    });
    const hidden = (await rest.json<any>()).decision_id;
    const got2 = await call('get_decision', { decision_id: hidden });
    expect(got2.isError).toBe(true);
    expect(got2.text).toContain('unknown decision');
    expect((await call('get_decision', { decision_id: 'not-a-uuid' })).text).toContain('unknown decision');
  });

  it('answers a repeated idempotency_key with the logged decision', async () => {
    const args = { profile: 'issue-triage', state: { title: 'T' }, ref: 'mcp:2', idempotency_key: `mcp-${crypto.randomUUID()}` };
    const a = JSON.parse((await call('decide', args)).text);
    const b = JSON.parse((await call('decide', args)).text);
    expect(b.decision_id).toBe(a.decision_id);
    const conflict = await call('decide', { ...args, state: { title: 'Other' } });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain('idempotency_conflict');
    const unchained = await call('decide', { profile: 'issue-triage', state: { title: 'T' }, ref: 'mcp:3', decisions: { x: crypto.randomUUID() } });
    expect(unchained.isError).toBe(true);
    expect(unchained.text).toContain('requires no decisions');
  });

  it('hides required decisions of profiles that are not MCP-visible, and the request digest', async () => {
    const visible = JSON.parse((await call('decide', { profile: 'issue-triage', state: { title: 'T' }, ref: 'mcp:4' })).text);
    const snap = (decision: string, profile: string) => ({ decision, profile, profile_version: 1, action: 'auto', outcome: 'auto', reviewed: false, read: {} });
    const id = crypto.randomUUID();
    // Written directly: no bundled MCP-visible profile has requires.
    await new D1DecisionLog(DB).insert({
      decision_id: id, ref: 'mcp:4', answers: visible.answers, action: 'auto', profile: 'issue-triage', profile_version: 1,
      model: 'mock', created_at: new Date().toISOString(), rule: null, client: 'agent', state_hash: '0'.repeat(64),
      requires: { seen: snap(visible.decision_id, 'issue-triage'), unseen: snap(crypto.randomUUID(), 'deploy-progress') },
      idempotency_key: 'k', request_digest: '1'.repeat(64),
    });
    const record = JSON.parse((await call('get_decision', { decision_id: id })).text);
    expect(record.requires.seen.decision).toBe(visible.decision_id);
    expect(record.requires.unseen).toEqual({ decision: null });
    expect(record.request_digest).toBeUndefined();
  });
});

describe('test tokens', () => {
  it('are refused: over MCP they could read logged decisions', async () => {
    const r = await rpc('tools/list', {}, TEST_ONLY);
    expect(r.status).toBe(403);
    expect(r.text).toContain('a test token may only decide');
  });
});
