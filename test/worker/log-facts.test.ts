// The decision log as facts read it (src/log-facts.ts, docs/modules.md):
// only the asking client's decisions, only of profiles its token may use,
// never discarded ones; no log for a test token. And the D1 query behind it.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeLog } from './helpers';
import { D1DecisionLog } from '../../src/log-d1';
import { factContext, factLogFor } from '../../src/log-facts';
import { makeDecision } from '../../src/decide';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { DecisionRecord } from '../../src/log';
import type { TokenRecord } from '../../src/auth';
import type { DecisionContext, FactProvider } from '@pointsman/module-api';
import type { Profile } from '../../src/types';

const DB = (env as unknown as { DB: D1Database }).DB;

const record = (over: Partial<DecisionRecord>): DecisionRecord => ({
  decision_id: crypto.randomUUID(), created_at: '2026-10-22T10:00:00.000Z', client: 'executor', profile: 'next-step', profile_version: 1,
  model: 'none', action: 'wait', rule: 0, answers: {}, state_hash: 'x',
  facts: { budget: { missing: false, values: { author: 'alice', pull_request: 'octo-org/demo#1' }, source: 'test' }, gone: { missing: true, reason: 'error' } },
  ...over,
});
const token = (over: Partial<TokenRecord> = {}): TokenRecord => ({ client: 'executor', profiles: ['next-step', 'risk'], created_at: '', ...over });

describe('the log for facts', () => {
  it('only the client\'s decisions, only of profiles its token may use, never discarded ones', async () => {
    const log = new D1DecisionLog(DB);
    const mine = record({ created_at: '2026-10-22T10:00:00.000Z' });
    const newer = record({ created_at: '2026-10-22T11:00:00.000Z', action: 'review' });
    const old = record({ created_at: '2026-10-20T10:00:00.000Z' });
    const other = record({ client: 'someone-else' });
    const outOfScope = record({ profile: 'secret' });
    const discarded = record({ created_at: '2026-10-22T10:30:00.000Z' });
    for (const r of [mine, newer, old, other, outOfScope, discarded]) await log.insert(r);
    await log.discard(discarded.decision_id, '2026-10-22T10:31:00.000Z');

    const rows = await factLogFor(log, token()).recent({ profiles: ['next-step', 'secret'], since: '2026-10-22T00:00:00.000Z', limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([newer.decision_id, mine.decision_id]);
    expect(rows[1]).toEqual({
      id: mine.decision_id, created_at: mine.created_at, profile: 'next-step', action: 'wait',
      facts: { budget: { missing: false, values: { author: 'alice', pull_request: 'octo-org/demo#1' } }, gone: { missing: true } },
    });
    // A token for every profile may read every profile, still only its own client's decisions.
    const all = await factLogFor(log, token({ profiles: ['*'] })).recent({ profiles: ['secret'], since: '2026-10-01T00:00:00.000Z', limit: 10 });
    expect(all.map((r) => r.id)).toEqual([outOfScope.decision_id]);
    // The limit holds.
    expect(await factLogFor(log, token()).recent({ profiles: ['next-step'], since: '2026-10-01T00:00:00.000Z', limit: 1 })).toHaveLength(1);
  });

  it('refuses a since that is not a time', async () => {
    await expect(factLogFor(fakeLog(), token()).recent({ profiles: ['next-step'], since: 'yesterday', limit: 1 })).rejects.toThrow();
  });

  it('no log for a test token', () => {
    expect(factContext(fakeLog(), token({ test: true }), 'next-step')).toBeUndefined();
    const ctx = factContext(fakeLog(), token(), 'next-step', new Date('2026-10-22T12:00:00Z'));
    expect(ctx).toMatchObject({ client: 'executor', profile: 'next-step', now: '2026-10-22T12:00:00.000Z' });
  });
});

describe('a decision gives its facts the context', () => {
  const profile: Profile = {
    id: 'next-step', version: 1, title: 'Next step', model: 'none', questions: [],
    facts: [{ name: 'pr', type: 'github_pr', at: '$.pull_request' }],
    policy: { rules: [], default_action: 'wait' },
  } as unknown as Profile;

  async function contextOf(client: TokenRecord): Promise<DecisionContext | undefined> {
    const seen: { context?: DecisionContext; called: boolean } = { called: false };
    const facts: FactProvider = {
      async lookup(_q, _s, _scope, context) {
        seen.called = true;
        if (context) seen.context = context;
        throw new Error('not needed');
      },
    };
    const store = new MemoryProfileStore([profile]);
    const res = await makeDecision({ store, adapterFor: () => new MockAdapter(), log: fakeLog(), facts }, client, 'next-step',
      { state: { pull_request: { repo: 'octo-org/demo', number: 1, head: 'a'.repeat(40) } } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(seen.called).toBe(true);
    return seen.context;
  }

  it('with the client, the profile and the client\'s log', async () => {
    const ctx = await contextOf(token());
    expect(ctx).toMatchObject({ client: 'executor', profile: 'next-step' });
    expect(Number.isFinite(Date.parse(ctx!.now))).toBe(true);
    expect(typeof ctx!.log.recent).toBe('function');
  });

  it('none for a test token', async () => {
    expect(await contextOf(token({ test: true }))).toBeUndefined();
  });
});
