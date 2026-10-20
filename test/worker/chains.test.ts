// Decision chains (docs/decision-chains.md), with the real D1 decision log:
// a final profile reads earlier decisions by id, a person's answer counts,
// replaced reviews leave the queue, and every unusable id gives one answer.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { D1DecisionLog } from '../../src/log';
import { noCallbacks } from './helpers';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import * as contract from '../../generated/openapi-validators.mjs';

const DB = (env as unknown as { DB: D1Database }).DB;
const triage = (bundled as Profile[]).find((p) => p.id === 'issue-triage')!;
// The mock answers team = backend with p 0.9: every first step is a review.
const first: Profile = { ...triage, policy: { rules: [{ when: 'team.p >= 0.95', action: 'auto' }], default: 'review' } };
const other: Profile = { ...triage, id: 'other-triage', policy: { default: 'auto' } };
const final: Profile = {
  id: 'triage-final',
  version: 1,
  title: { en: 'Final', ja: '最終' },
  description: { en: 'Final step', ja: '最後の段階' },
  model: 'none',
  requires: [{ name: 'triage', profile: 'issue-triage' }, { name: 'extra', profile: 'other-triage', optional: true }],
  questions: [],
  policy: {
    rules: [
      { when: "decisions.triage.outcome == 'auto' and decisions.triage.answers.team.value == 'frontend'", action: 'ship' },
      { when: "decisions.triage.outcome == 'reject'", action: 'drop' },
    ],
    default: 'wait',
    people_check: ['wait'],
  },
};
// A third step, to check what a required decision itself required.
const last: Profile = {
  ...final,
  id: 'triage-last',
  requires: [{ name: 'final', profile: 'triage-final' }, { name: 'triage', profile: 'issue-triage' }],
  policy: { rules: [{ when: "decisions.final.action == 'ship'", action: 'close' }], default: 'keep' },
};

const ALL = newToken();
const SECOND = newToken();
const FINAL_ONLY = newToken();
const TEST = newToken();

function setup() {
  const tokens = new MemoryTokenStore();
  const deps: Deps = {
    store: new MemoryProfileStore([first, other, final, last]),
    tokens,
    log: new D1DecisionLog(DB),
    adapterFor: () => new MockAdapter(),
    callbacks: noCallbacks,
  };
  const app = createApp(() => deps);
  const call = async (method: string, path: string, body?: unknown, token = ALL, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }, env);
    return { status: res.status, data: res.status === 204 ? null : await res.json<any>() };
  };
  return { call, tokens };
}

const issue = { issue: { title: 'Login page is blank', body: 'Since this morning.' } };

describe('decision chains', () => {
  let s: ReturnType<typeof setup>;
  let ref: string;
  beforeEach(async () => {
    s = setup();
    ref = `example:${crypto.randomUUID()}`;
    s.tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    s.tokens.records.set(await hashToken(SECOND), { client: 'second', profiles: ['*'], created_at: '' });
    s.tokens.records.set(await hashToken(FINAL_ONLY), { client: 'all', profiles: ['triage-final'], created_at: '' });
    s.tokens.records.set(await hashToken(TEST), { client: 'checks', profiles: ['*'], created_at: '', test: true });
  });

  const decideFirst = async (r = ref, token = ALL) => {
    const { status, data } = await s.call('POST', '/v1/decide/issue-triage', { state: issue, ref: r }, token);
    expect(status).toBe(200);
    return data.decision_id as string;
  };
  const decideFinal = (decisions: Record<string, string>, extra: Record<string, unknown> = {}, token = ALL, headers: Record<string, string> = {}) =>
    s.call('POST', '/v1/decide/triage-final', { state: {}, ref, decisions, ...extra }, token, headers);

  it('reads the first decision, and a person\'s answer once its review is resolved', async () => {
    const id = await decideFirst();
    const before = await decideFinal({ triage: id });
    expect(before.status).toBe(200);
    expect(contract.decision(before.data), JSON.stringify(contract.decision.errors)).toBe(true);
    expect(before.data).toMatchObject({ action: 'wait', model: 'none', answers: {}, review: { status: 'pending' } });
    expect(before.data.requires.triage).toMatchObject({
      decision: id, profile: 'issue-triage', profile_version: first.version, action: 'review', outcome: 'review', reviewed: false,
    });
    expect(before.data.requires.triage.read).toMatchObject({ outcome: 'review' });
    expect(before.data.replaces).toBeUndefined();

    const resolved = await s.call('POST', `/v1/reviews/${id}/resolve`, { action: 'auto', correct: { team: 'frontend' }, by: 'x' });
    expect(resolved.status).toBe(200);
    const after = await decideFinal({ triage: id });
    expect(after.data).toMatchObject({ action: 'ship', replaces: before.data.decision_id });
    expect(after.data.requires.triage).toMatchObject({ outcome: 'auto', reviewed: true });
    expect(after.data.requires.triage.read).toMatchObject({ outcome: 'auto', 'answers.team.value': 'frontend' });
    expect(after.data.review).toBeUndefined();

    // The replaced final decision's review left the queue.
    const old = await s.call('GET', `/v1/decisions/${before.data.decision_id}`);
    expect(old.data.review.status).toBe('superseded');
    expect(contract.decisionRecord(old.data), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
    const queue = await s.call('GET', '/v1/reviews?profile=triage-final');
    expect(queue.data.reviews.map((r: { decision_id: string }) => r.decision_id)).not.toContain(before.data.decision_id);
    const stats = await s.call('GET', '/v1/stats/triage-final');
    expect(stats.data.reviews.superseded).toBeGreaterThanOrEqual(1);
    expect(contract.profileStats(stats.data), JSON.stringify(contract.profileStats.errors)).toBe(true);
  });

  it('keeps a person\'s answer on a final decision: a new one is refused', async () => {
    const id = await decideFirst();
    const made = await decideFinal({ triage: id });
    expect((await s.call('POST', `/v1/reviews/${made.data.decision_id}/resolve`, { action: 'ship', by: 'x' })).status).toBe(200);
    const again = await decideFinal({ triage: id });
    expect(again.status).toBe(409);
    expect(again.data.error.code).toBe('resolved_by_person');
    expect(contract.error(again.data)).toBe(true);
  });

  const decideLast = (decisions: Record<string, string>) => s.call('POST', '/v1/decide/triage-last', { state: {}, ref, decisions });

  it('builds on a chained decision, but not on one that was replaced', async () => {
    const id = await decideFirst();
    const a = await decideFinal({ triage: id });
    const ok = await decideLast({ final: a.data.decision_id, triage: id });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ action: 'keep', requires: { final: { decision: a.data.decision_id, action: 'wait' } } });

    const b = await decideFinal({ triage: id });
    const replaced = await decideLast({ final: a.data.decision_id, triage: id });
    expect(replaced.status).toBe(400);
    expect(replaced.data.error.message).toBe('decisions.final is not a usable decision');
    expect((await decideLast({ final: b.data.decision_id, triage: id })).status).toBe(200);
  });

  it('refuses decisions that do not fit each other', async () => {
    // The final decision used one first decision; the request names another
    // first decision of the same report.
    const used = await decideFirst();
    const another = await decideFirst();
    const f = await decideFinal({ triage: used });
    const res = await decideLast({ final: f.data.decision_id, triage: another });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toBe('decisions.final is not a usable decision');
  });

  it('gives the same answer for every unusable decision', async () => {
    const id = await decideFirst();
    const otherRef = await decideFirst(`example:${crypto.randomUUID()}`);
    const otherClient = await decideFirst(ref, SECOND);
    const otherProfile = (await s.call('POST', '/v1/decide/other-triage', { state: issue, ref })).data.decision_id as string;
    const message = 'decisions.triage is not a usable decision';
    for (const bad of [crypto.randomUUID(), otherRef, otherClient, otherProfile]) {
      const res = await decideFinal({ triage: bad });
      expect(res.status, bad).toBe(400);
      expect(res.data.error.message).toBe(message);
    }
    // Out of the token's scope: the same answer as for an unknown id.
    const scoped = await decideFinal({ triage: id }, {}, FINAL_ONLY);
    expect(scoped.status).toBe(400);
    expect(scoped.data.error.message).toBe(message);
  });

  it('refuses requests that do not fit the profile', async () => {
    const id = await decideFirst();
    const cases: [unknown, RegExp][] = [
      [{ state: {}, ref, decisions: {} }, /1 to 8 entries/],
      [{ state: {}, ref, decisions: { triage: 'nope' } }, /must be a decision id/],
      [{ state: {}, ref, decisions: { triage: id, extra: id } }, /same decision twice/],
      [{ state: {}, ref, decisions: { triage: id, more: crypto.randomUUID() } }, /requires no decision of that name/],
      [{ state: {}, ref, decisions: { extra: crypto.randomUUID() } }, /"decisions.triage" is required/],
      [{ state: {}, decisions: { triage: id } }, /"ref" is required/],
    ];
    for (const [body, message] of cases) {
      const res = await s.call('POST', '/v1/decide/triage-final', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.data.error.message).toMatch(message);
    }
    const unchained = await s.call('POST', '/v1/decide/issue-triage', { state: issue, ref, decisions: { triage: id } });
    expect(unchained.status).toBe(400);
    expect(unchained.data.error.message).toMatch(/requires no decisions/);
  });

  it('refuses test tokens: their decisions are not logged', async () => {
    const id = await decideFirst();
    const withDecisions = await s.call('POST', '/v1/decide/issue-triage', { state: issue, ref, decisions: { triage: id } }, TEST);
    expect(withDecisions.status).toBe(400);
    expect(withDecisions.data.error.message).toMatch(/test token cannot send decisions/);
    const chained = await s.call('POST', '/v1/decide/triage-final', { state: {}, ref }, TEST);
    expect(chained.status).toBe(400);
    expect(chained.data.error.message).toMatch(/test token cannot decide a profile that requires/);
  });

  it('reads an optional decision when it is given', async () => {
    const id = await decideFirst();
    const extra = (await s.call('POST', '/v1/decide/other-triage', { state: issue, ref })).data.decision_id as string;
    const res = await decideFinal({ triage: id, extra });
    expect(res.status).toBe(200);
    expect(Object.keys(res.data.requires).sort()).toEqual(['extra', 'triage']);
  });

  it('answers a repeated Idempotency-Key with the logged decision, and refuses another request with it', async () => {
    const id = await decideFirst();
    const key = { 'idempotency-key': `final-${crypto.randomUUID()}` };
    const a = await decideFinal({ triage: id }, {}, ALL, key);
    const b = await decideFinal({ triage: id }, {}, ALL, key);
    expect(b.status).toBe(200);
    expect(b.data.decision_id).toBe(a.data.decision_id);
    expect(b.data.requires).toEqual(a.data.requires);
    expect(contract.decision(b.data), JSON.stringify(contract.decision.errors)).toBe(true);
    // Not superseded by its own repeat.
    expect((await s.call('GET', `/v1/decisions/${a.data.decision_id}`)).data.review.status).toBe('pending');

    const conflict = await decideFinal({ triage: id }, { state: { changed: true } }, ALL, key);
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe('idempotency_conflict');
    // Another client may use the same key.
    const second = await s.call('POST', '/v1/decide/issue-triage', { state: issue, ref }, SECOND, key);
    expect(second.status).toBe(200);

    const bad = await decideFinal({ triage: id }, {}, ALL, { 'idempotency-key': 'has space' });
    expect(bad.status).toBe(400);
  });

  it('hides required decisions of profiles out of the reader\'s scope, and the request digest', async () => {
    const id = await decideFirst();
    const made = await decideFinal({ triage: id }, {}, ALL, { 'idempotency-key': `k-${crypto.randomUUID()}` });
    const full = await s.call('GET', `/v1/decisions/${made.data.decision_id}`);
    expect(full.data.requires.triage.decision).toBe(id);
    expect(full.data.request_digest).toBeUndefined();
    expect(full.data.idempotency_key).toMatch(/^k-/);
    const scoped = await s.call('GET', `/v1/decisions/${made.data.decision_id}`, undefined, FINAL_ONLY);
    expect(scoped.status).toBe(200);
    expect(scoped.data.requires.triage).toEqual({ decision: null });
    expect(contract.decisionRecord(scoped.data), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
  });
});
