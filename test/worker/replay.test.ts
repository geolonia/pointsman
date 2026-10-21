// Replay a changed policy on logged decisions (src/replay.ts, POST /v1/profiles/{id}/replay).

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import type { DecisionRecord, RequiredSnapshot } from '../../src/log';
import { MockAdapter } from '../../src/models/mock';
import { PolicyError } from '../../src/policy';
import { MemoryProfileStore } from '../../src/profiles/store';
import { compileDraft, inputFromSnapshot, policyShapeError, replay as replayCompiled, unchangedPartError } from '../../src/replay';

/** Compile, then replay, as the route does. */
const replay = (base: Profile, policy: Profile['policy'], records: DecisionRecord[], req: Record<string, Profile | undefined>) =>
  replayCompiled(base, policy, compileDraft(base, policy, req), records, req);
import type { Answer, Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import { fakeLog, noCallbacks } from './helpers';
import * as contract from '../../generated/openapi-validators.mjs';

const all = bundled as Profile[];
const byId = (id: string) => all.find((p) => p.id === id)!;
const required = Object.fromEntries(all.map((p) => [p.id, p]));
const check = byId('road-restriction-check');
const final = byId('road-closure-final');

const yes = (p: number): Answer => ({ type: 'noul', value: p >= 0.5, p: p >= 0.5 ? p : 1 - p, yes: p });
const sure = (value: string): Answer => ({ type: 'choice', value, p: 0.95, probabilities: { [value]: 0.95 } });
const level = (n: number): Answer => ({ type: 'score', value: n, p: 0.9, score: n, probabilities: { [String(n)]: 0.9 } });
let n = 0;

/** A logged decision of road-restriction-check, as the engine would have made it. */
function logged(danger: number, rank: number, extra: Partial<DecisionRecord> = {}): DecisionRecord {
  n++;
  return {
    decision_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    created_at: new Date(Date.UTC(2026, 9, 21, 0, 0, 100 - n)).toISOString(),
    client: 'bridge',
    ref: `report-${n}`,
    profile: check.id,
    profile_version: check.version,
    model: 'clef-flash',
    action: '',
    rule: null,
    answers: { category: sure('closedWeather'), status_matches: yes(0.9), danger: yes(danger), clarity: level(3) },
    facts: { flood: { missing: false, values: { inside: rank > 0, rank, class: rank ? '3 to 5 m' : '' }, source: 'test' } },
    state_hash: 'x',
    ...extra,
  };
}

/** The same decision with the action the published rules give, as logged. */
function asLogged(record: DecisionRecord): DecisionRecord {
  const [r] = replay(check, check.policy, [{ ...record, action: 'x' }], required).changes;
  return { ...record, action: r!.after.action, rule: r!.after.rule };
}

describe('replay', () => {
  it('gives the logged actions back with the published policy', () => {
    const records = [logged(0.9, 0), logged(0.45, 5), logged(0.1, 0), logged(0.1, 5)].map(asLogged);
    expect(records.map((r) => r.action)).toEqual(['urgent', 'urgent', 'publish', 'review']);
    const r = replay(check, check.policy, records, required);
    expect(r).toMatchObject({ replayed: 4, skipped: 0, changed: 0, inexact: 0, transitions: [], changes: [] });
    expect(r.actions.before).toEqual(r.actions.after);
  });

  it('counts changes, transitions and what people answered, newest first', () => {
    const records = [
      asLogged(logged(0.6, 0)), // review now; urgent with danger >= 0.5
      { ...asLogged(logged(0.55, 0)), review: { status: 'resolved' as const, final_action: 'urgent' } },
      { ...asLogged(logged(0.1, 5)), review: { status: 'resolved' as const, final_action: 'publish' } },
      asLogged(logged(0.1, 0)),
    ];
    // A lower danger threshold, and deep flood zones no longer go to a person.
    const policy = {
      ...check.policy,
      rules: check.policy.rules!.map((r) => (r.when === 'danger.yes >= 0.7' ? { ...r, when: 'danger.yes >= 0.5' } : r))
        .filter((r) => r.when !== 'facts.flood.rank >= 5'),
    };
    const r = replay(check, policy, records, required);
    expect(r.replayed).toBe(4);
    expect(r.changed).toBe(3);
    expect(r.transitions).toEqual([
      { from: 'review', to: 'urgent', count: 2 },
      { from: 'review', to: 'publish', count: 1 },
    ]);
    // To a person (review or urgent): 3 reviews before; after, the 2 that become urgent.
    expect(r.people).toEqual({ before: 3, after: 2, checked: 2, matched: 2 });
    expect(r.changes.map((c) => [c.ref, c.before.action, c.after.action, c.person])).toEqual([
      ['report-' + (n - 3), 'review', 'urgent', undefined],
      ['report-' + (n - 2), 'review', 'urgent', 'urgent'],
      ['report-' + (n - 1), 'review', 'publish', 'publish'],
    ]);
    expect(r.changes[0]!.after.rule).toBe(0);
    expect(r.from! < r.to!).toBe(true);
  });

  it('skips a logged decision that lacks an answer the new rules read', () => {
    const record = asLogged(logged(0.1, 0));
    const { danger: _, ...answers } = record.answers;
    const r = replay(check, check.policy, [{ ...record, answers }, asLogged(logged(0.1, 0))], required);
    expect(r.skipped).toBe(1);
    expect(r.replayed).toBe(1);
  });

  it('throws PolicyError for a condition that does not fit the profile, or a people_check outside the policy', () => {
    expect(() => compileDraft(check, { rules: [{ when: 'colour.value == true', action: 'urgent' }], default: 'review' }, required)).toThrow(PolicyError);
    expect(() => compileDraft(check, { default: 'review', people_check: ['urgent'] }, required)).toThrow(/people_check: "urgent" is not an action of this policy \(review\)/);
  });

  it('counts decisions going to a person with the draft\'s people_check', () => {
    const records = [logged(0.9, 0), logged(0.1, 5)].map(asLogged); // urgent, review
    const r = replay(check, { ...check.policy, people_check: ['review'] }, records, required);
    // Before (published people_check [review, urgent]): both. After: only review.
    expect(r.people).toMatchObject({ before: 2, after: 1 });
  });
});

describe('replay with earlier decisions', () => {
  const snap = (outcome: string, read: RequiredSnapshot['read'] = {}, reviewed = false): RequiredSnapshot => ({
    decision: '00000000-0000-4000-8000-000000000999', profile: check.id, profile_version: check.version, action: reviewed ? 'review' : outcome, outcome, reviewed, read,
  });
  const finalRecord = (requires: Record<string, RequiredSnapshot>, action: string, rule: number | null): DecisionRecord => ({
    ...logged(0, 0), profile: final.id, profile_version: final.version, model: 'none', answers: {}, facts: {}, requires, action, rule,
  });

  it('reads earlier decisions from the snapshot as they were', () => {
    const records = [
      finalRecord({ check: snap('reject', { outcome: 'reject' }, true) }, 'reject', 0),
      finalRecord({ check: snap('publish', { outcome: 'publish' }) }, 'publish', 3),
    ];
    // Rejections now wait for a person.
    const policy = { ...final.policy, rules: final.policy.rules!.map((r) => (r.action === 'reject' ? { ...r, action: 'review' } : r)) };
    const r = replay(final, policy, records, required);
    expect(r).toMatchObject({ replayed: 2, changed: 1, inexact: 0, transitions: [{ from: 'reject', to: 'review', count: 1 }] });
  });

  it('counts a decision as inexact when a new rule reads a value the snapshot did not keep', () => {
    const record = finalRecord({ check: snap('publish', { outcome: 'publish' }) }, 'publish', 3);
    const policy = { ...final.policy, rules: [{ when: 'decisions.check.answers.danger.yes >= 0.3', action: 'urgent' }, ...final.policy.rules!] };
    const r = replay(final, policy, [record], required);
    // Not replayed: a made-up value would decide it. Counted only as inexact.
    expect(r).toMatchObject({ replayed: 0, changed: 0, inexact: 1, transitions: [], from: null, to: null });
    expect(r.actions).toEqual({ before: {}, after: {} });
    const kept = finalRecord({ check: snap('publish', { outcome: 'publish', 'answers.danger.yes': 0.4 }) }, 'publish', 3);
    expect(replay(final, policy, [kept], required)).toMatchObject({ changed: 1, inexact: 0, transitions: [{ from: 'publish', to: 'urgent', count: 1 }] });
  });

  it('rebuilds answers and facts from the values read, longest name first', () => {
    const input = inputFromSnapshot(snap('publish', {
      'answers.danger.yes': 0.4,
      'answers.category.probabilities.closedWeather': 0.9,
      'answers.clarity.score': null,
      'facts.flood.rank': 5,
      'facts.shelter.missing': true,
      'facts.shelter.reason': 'timeout',
    }), check);
    expect(input).toEqual({
      action: 'publish', outcome: 'publish', reviewed: false,
      answers: { danger: { type: 'noul', yes: 0.4 }, category: { type: 'choice', probabilities: { closedWeather: 0.9 } } },
      facts: { flood: { missing: false, values: { rank: 5 }, source: 'replay' }, shelter: { missing: true, reason: 'timeout' } },
    });
    // Without the required profile, only action, outcome and reviewed are known.
    expect(inputFromSnapshot(snap('publish', { 'answers.danger.yes': 0.4 }), undefined).answers).toEqual({});
  });
});

describe('policyShapeError and unchangedPartError', () => {
  it('checks the shape of a policy sent for a replay', () => {
    expect(policyShapeError({ default: 'review', rules: [{ when: 'x.p > 0', action: 'auto' }] })).toBeNull();
    for (const [policy, message] of [
      [null, '"policy" must be an object'],
      [{ rules: [] }, '"policy.default" must be an action name'],
      [{ default: 'Review' }, '"policy.default" must be an action name'],
      [{ default: 'review', extra: 1 }, '"policy.extra" is not a policy field'],
      [{ default: 'review', rules: {} }, '"policy.rules" must be a list'],
      [{ default: 'review', rules: [{ when: '', action: 'auto' }] }, '"policy.rules[0].when" must be a condition'],
      [{ default: 'review', rules: [{ when: 'a', action: 'auto', note: 1 }] }, '"policy.rules[0]" has only when and action'],
      [{ default: 'review', people_check: ['review', 'review'] }, '"policy.people_check" must be a list of different action names'],
      [{ default: 'review', people_answers: ['review'] }, '"policy.people_answers" must name at least one answer, and not review'],
    ] as const) {
      expect(policyShapeError(policy), JSON.stringify(policy)).toBe(message);
    }
  });

  it('compares only the parts a draft gives, whatever the key order', () => {
    const q = check.questions.map((x) => Object.fromEntries(Object.entries(x).reverse()));
    expect(unchangedPartError(check, { questions: q as Profile['questions'] })).toBeNull();
    expect(unchangedPartError(check, {})).toBeNull();
    expect(unchangedPartError(check, { questions: check.questions.slice(1) })).toMatch(/^the draft's questions differ from version \d+: a replay changes only the policy/);
    expect(unchangedPartError(byId('issue-triage'), { facts: [] })).toBeNull();
  });
});

describe('POST /v1/profiles/{id}/replay', () => {
  const ALL = newToken();
  const CHECK_ONLY = newToken();
  const TEST = newToken();
  const records = [logged(0.6, 0), logged(0.1, 0)].map(asLogged);
  let calls: [string, number, number][];
  let post: (id: string, body: unknown, token?: string) => Promise<Response>;

  beforeEach(async () => {
    calls = [];
    const tokens = new MemoryTokenStore();
    tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    tokens.records.set(await hashToken(CHECK_ONLY), { client: 'check', profiles: ['road-restriction-check', 'road-closure-final'], created_at: '' });
    tokens.records.set(await hashToken(TEST), { client: 'checks', profiles: ['*'], created_at: '', test: true });
    const log = fakeLog({ recent: async (profile, version, limit) => { calls.push([profile, version, limit]); return profile === check.id ? records : []; } });
    const app = createApp(() => ({ store: new MemoryProfileStore(all), tokens, log, adapterFor: () => new MockAdapter(), callbacks: noCallbacks }));
    post = async (id, body, token = ALL) => app.request(`/v1/profiles/${id}/replay`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }, env);
  });

  const lower = { ...check.policy, rules: check.policy.rules!.map((r) => (r.when === 'danger.yes >= 0.7' ? { ...r, when: 'danger.yes >= 0.5' } : r)) };

  it('replays the newest decisions of the latest version, and fits the contract', async () => {
    const res = await post(check.id, { policy: lower, questions: check.questions, facts: check.facts, requires: [], limit: 10 });
    expect(res.status).toBe(200);
    const body = await res.json<{ replayed: number; changed: number; transitions: unknown[] }>();
    expect(contract.replayResult(body), JSON.stringify(contract.replayResult.errors)).toBe(true);
    expect(body).toMatchObject({ replayed: 2, changed: 1, transitions: [{ from: 'review', to: 'urgent', count: 1 }] });
    expect(calls).toEqual([[check.id, check.version, 10]]);
  });

  it('uses 200 decisions by default, and the version asked for', async () => {
    expect((await post(check.id, { policy: lower, version: check.version })).status).toBe(200);
    expect(calls).toEqual([[check.id, check.version, 200]]);
  });

  it('answers the same 403 for a guessed hidden required profile, right or wrong, before comparing', async () => {
    const guess = (profile: string) => post(final.id, { policy: final.policy, requires: [{ name: 'check', profile: 'road-restriction-check' }, { name: 'evacuation', profile, optional: true }] }, CHECK_ONLY);
    const right = await guess('evacuation-access-check');
    const wrong = await guess('some-other-profile');
    expect([right.status, wrong.status]).toEqual([403, 403]);
    expect(await right.json()).toEqual(await wrong.json());
    expect(calls).toEqual([]);
  });

  it('refuses a draft whose questions, facts or requires differ', async () => {
    const res = await post(check.id, { policy: lower, questions: check.questions.slice(1) });
    expect(res.status).toBe(409);
    const conflict = await res.json<{ error: { code: string } }>();
    expect(contract.error(conflict), JSON.stringify(contract.error.errors)).toBe(true);
    expect(conflict.error.code).toBe('not_policy_only');
    expect(calls).toEqual([]);
  });

  it('refuses a condition that does not fit, and bad bodies, before reading the log', async () => {
    const bad = await post(check.id, { policy: { rules: [{ when: 'colour.value == true', action: 'urgent' }], default: 'review' } });
    expect(bad.status).toBe(400);
    const invalid = await bad.json<{ error: { code: string; message: string } }>();
    expect(contract.error(invalid), JSON.stringify(contract.error.errors)).toBe(true);
    expect(invalid.error).toMatchObject({ code: 'invalid_policy', message: expect.stringContaining('rule 0') });
    expect(calls).toEqual([]);
    const many = { default: 'review', rules: Array.from({ length: 501 }, () => ({ when: 'danger.yes >= 0.5', action: 'urgent' })) };
    expect((await post(check.id, { policy: many })).status).toBe(400);
    let deep: unknown = [];
    for (let i = 0; i < 30; i++) deep = [deep];
    const nested = await post(check.id, { policy: lower, questions: deep });
    expect(nested.status).toBe(409);
    expect((await nested.json<{ error: { message: string } }>()).error.message).toBe("the draft's questions are nested too deeply");
    for (const body of ['nope', '[]', { policy: lower, limit: 0 }, { policy: lower, limit: 501 }, { policy: lower, version: 1.5 }, { policy: lower, extra: 1 }, { policy: lower, facts: {} }, {}]) {
      expect((await post(check.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(check.id, { policy: lower, version: 999 })).status).toBe(404);
    expect((await post('no-such-profile', { policy: lower })).status).toBe(404);
  });

  it('needs every required profile in scope, and refuses test tokens and profiles out of scope', async () => {
    const finalPolicy = { policy: final.policy };
    expect((await post(final.id, finalPolicy)).status).toBe(200);
    // road-closure-final requires evacuation-access-check, which this token may not use.
    const res = await post(final.id, finalPolicy, CHECK_ONLY);
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { message: string } }>()).error.message).toBe('not allowed to use a profile that this profile requires');
    expect((await post('issue-triage', { policy: { default: 'review' } }, CHECK_ONLY)).status).toBe(403);
    expect((await post(check.id, { policy: lower }, TEST)).status).toBe(403);
  });
});
