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
// As in the FIWARE demo: a second step with its own question that requires
// the first, and an end step for which the second is optional.
const follow: Profile = { ...triage, id: 'triage-follow', requires: [{ name: 'triage', profile: 'issue-triage' }], policy: { default: 'noted' } };
const end: Profile = {
  ...final,
  id: 'triage-end',
  requires: [{ name: 'triage', profile: 'issue-triage' }, { name: 'follow', profile: 'triage-follow', optional: true }],
  policy: { rules: [{ when: "decisions.follow.outcome == 'noted'", action: 'with-follow' }], default: 'without-follow' },
};

const ALL = newToken();
const SECOND = newToken();
const FINAL_ONLY = newToken();
const TEST = newToken();

const tokens = new MemoryTokenStore();

function setup() {
  return setupWith({});
}

/** The app with some log methods replaced (to run a race at a fixed point) or other profiles. */
const after: Profile = {
  ...end,
  id: 'triage-after',
  requires: [{ name: 'follow', profile: 'triage-follow' }, { name: 'triage', profile: 'issue-triage', optional: true }],
};

function setupWith(log: Partial<D1DecisionLog>, profiles = [first, other, final, last, follow, end, after]) {
  const real = new D1DecisionLog(DB);
  const deps: Deps = {
    store: new MemoryProfileStore(profiles),
    tokens,
    log: Object.assign(real, log),
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
    const f = await decideFinal({ triage: used });
    expect(f.status).toBe(200);
    const another = await decideFirst();
    const res = await decideLast({ final: f.data.decision_id, triage: another });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toBe('decisions.final is not a usable decision');
  });

  it('leaves out an optional decision made for an earlier first decision, and decides from the current ones', async () => {
    const t1 = await decideFirst();
    const f1 = await s.call('POST', '/v1/decide/triage-follow', { state: issue, ref, decisions: { triage: t1 } });
    expect(f1.status).toBe(200);
    expect(f1.data.requires.triage.decision).toBe(t1);
    const decideEnd = (decisions: Record<string, string>) => s.call('POST', '/v1/decide/triage-end', { state: {}, ref, decisions });
    // Both current: the second step counts.
    const both = await decideEnd({ triage: t1, follow: f1.data.decision_id });
    expect(both.data).toMatchObject({ action: 'with-follow', requires: { follow: { decision: f1.data.decision_id } } });
    // The first step is made again: the second step was made for the old one.
    const t2 = await decideFirst();
    const res = await decideEnd({ triage: t2, follow: f1.data.decision_id });
    expect(res.status).toBe(200);
    expect(res.data.action).toBe('without-follow');
    expect(res.data.requires.triage.decision).toBe(t2);
    expect(res.data.requires.follow).toBeUndefined();
  });

  it('still refuses a required decision made for an older one, also when the other is optional', async () => {
    // Here the follow-up is required and the first step optional: the stale one is required.
    const t1 = await decideFirst();
    const f1 = await s.call('POST', '/v1/decide/triage-follow', { state: issue, ref, decisions: { triage: t1 } });
    const t2 = await decideFirst();
    const res = await s.call('POST', '/v1/decide/triage-after', { state: {}, ref, decisions: { follow: f1.data.decision_id, triage: t2 } });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toBe('decisions.follow is not a usable decision');
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

  it('uses only the newest decision of a step for the report', async () => {
    const older = await decideFirst();
    const newer = await decideFirst();
    const res = await decideFinal({ triage: older });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toBe('decisions.triage is not a usable decision');
    expect((await decideFinal({ triage: newer })).status).toBe(200);
  });

  it('refuses to resolve a final decision that a newer one replaced', async () => {
    const id = await decideFirst();
    const a = await decideFinal({ triage: id });
    await decideFinal({ triage: id });
    const res = await s.call('POST', `/v1/reviews/${a.data.decision_id}/resolve`, { action: 'ship', by: 'x' });
    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe('not_pending');
  });

  it('discards a decision made while a person resolved the one it replaces', async () => {
    const id = await decideFirst();
    const a = await decideFinal({ triage: id });
    // A person resolves the earlier final decision while the new one is made:
    // after the check that it is not resolved, before the new one is logged.
    const log = new D1DecisionLog(DB);
    const latestFor = log.latestFor.bind(log);
    const racing = setupWith({
      latestFor: async (...args) => {
        const found = await latestFor(...args);
        if (found?.decision_id === a.data.decision_id) {
          expect((await s.call('POST', `/v1/reviews/${a.data.decision_id}/resolve`, { action: 'ship', by: 'x' })).status).toBe(200);
        }
        return found;
      },
    });
    const key = { 'idempotency-key': `race-${crypto.randomUUID()}` };
    const body = { state: {}, ref, decisions: { triage: id } };
    const res = await racing.call('POST', '/v1/decide/triage-final', body, ALL, key);
    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe('resolved_by_person');
    // The resolved answer stays the one that counts, also for a retry.
    expect((await s.call('POST', '/v1/decide/triage-final', body, ALL, key)).data.error.code).toBe('resolved_by_person');
    expect((await s.call('GET', `/v1/decisions/${a.data.decision_id}`)).data.review.status).toBe('resolved');
    expect((await decideFinal({ triage: id })).data.error.code).toBe('resolved_by_person');
  });

  it('a retry after a failure between logging and the check keeps the person\'s answer', async () => {
    const id = await decideFirst();
    const a = await decideFinal({ triage: id });
    // The first try logs the new decision, then fails before it could check
    // whether a person resolved the earlier one meanwhile (who did).
    const log = new D1DecisionLog(DB);
    const insert = log.insert.bind(log);
    const failing = setupWith({
      insert: async (r) => {
        // Resolved just before the new decision is logged (after it, the
        // resolve would be refused).
        expect((await s.call('POST', `/v1/reviews/${a.data.decision_id}/resolve`, { action: 'ship', by: 'x' })).status).toBe(200);
        await insert(r);
        throw new Error('connection lost');
      },
      byIdempotencyKey: async () => null,
    });
    const key = { 'idempotency-key': `crash-${crypto.randomUUID()}` };
    const body = { state: {}, ref, decisions: { triage: id } };
    expect((await failing.call('POST', '/v1/decide/triage-final', body, ALL, key)).status).toBe(500);
    const before = (await s.call('GET', '/v1/stats/triage-final')).data;
    const retry = await s.call('POST', '/v1/decide/triage-final', body, ALL, key);
    expect(retry.status).toBe(409);
    expect(retry.data.error.code).toBe('resolved_by_person');
    // The logged one never counts: not usable, not in the stats.
    const stats = (await s.call('GET', '/v1/stats/triage-final')).data;
    expect(stats.decisions).toBe(before.decisions - 1);
    const last = await s.call('POST', '/v1/decide/triage-last', { state: {}, ref, decisions: { final: a.data.decision_id, triage: id } });
    expect(last.status).toBe(200);
  });

  it('lists reviews without the request digest and with out-of-scope decisions hidden', async () => {
    const id = await decideFirst();
    const made = await decideFinal({ triage: id }, {}, ALL, { 'idempotency-key': `q-${crypto.randomUUID()}` });
    const queue = await s.call('GET', '/v1/reviews?profile=triage-final', undefined, FINAL_ONLY);
    expect(queue.status).toBe(200);
    expect(contract.reviewList(queue.data), JSON.stringify(contract.reviewList.errors)).toBe(true);
    const item = queue.data.reviews.find((r: { decision_id: string }) => r.decision_id === made.data.decision_id);
    expect(item.requires.triage).toEqual({ decision: null });
    expect(item.request_digest).toBeUndefined();
  });

  it('a retry after a new profile version is the same request', async () => {
    const id = await decideFirst();
    const key = { 'idempotency-key': `v-${crypto.randomUUID()}` };
    const a = await decideFinal({ triage: id }, {}, ALL, key);
    const newer = setupWith({}, [first, other, { ...final, version: 2 }, last]);
    const b = await newer.call('POST', '/v1/decide/triage-final', { state: {}, ref, decisions: { triage: id } }, ALL, key);
    expect(b.status).toBe(200);
    expect(b.data.decision_id).toBe(a.data.decision_id);
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
