// Retention of the decision log (src/retention.ts, DecisionLog.purge).

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { D1DecisionLog } from '../../src/log-d1';
import { BATCH, MAX_DAYS, MIN_DAYS, purgeOldDecisions, retentionDays, runRetention } from '../../src/retention';
import { ConfigError } from '../../src/decide';

const DB = (env as unknown as { DB: D1Database }).DB;

describe('retentionDays', () => {
  it('is undefined when DECISION_LOG_DAYS is unset or empty: nothing is deleted', () => {
    expect(retentionDays(undefined)).toBeUndefined();
    expect(retentionDays('')).toBeUndefined();
  });

  it('reads whole days from the minimum to the maximum', () => {
    expect(retentionDays('365')).toBe(365);
    expect(retentionDays(String(MIN_DAYS))).toBe(MIN_DAYS);
    expect(retentionDays(String(MAX_DAYS))).toBe(MAX_DAYS);
  });

  it('refuses anything else as a configuration error', () => {
    for (const bad of ['0', '29', String(MAX_DAYS + 1), '-1', '1.5', '365d', ' 365', 'abc', '1000000']) {
      expect(() => retentionDays(bad), bad).toThrow(ConfigError);
    }
  });
});

describe('purgeOldDecisions', () => {
  it('asks the log for one batch before now minus the days', async () => {
    const calls: [string, number][] = [];
    const n = await purgeOldDecisions({ purge: async (before, limit) => { calls.push([before, limit]); return 7; } }, 365, new Date('2027-11-26T00:00:00Z'));
    expect(n).toBe(7);
    expect(calls).toEqual([['2026-11-26T00:00:00.000Z', BATCH]]);
  });
});

describe('runRetention (the cron\'s part)', () => {
  const errors: string[] = [];
  beforeEach(() => {
    errors.length = 0;
    vi.spyOn(console, 'error').mockImplementation((m: string) => { errors.push(m); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const counting = () => {
    const calls: string[] = [];
    return { calls, log: { purge: async (before: string) => { calls.push(before); return 3; } } };
  };

  it('deletes one batch when set, nothing when unset', async () => {
    const set = counting();
    expect(await runRetention(set.log, '365', new Date('2027-11-26T00:00:00Z'))).toBe(3);
    expect(set.calls).toEqual(['2026-11-26T00:00:00.000Z']);
    const unset = counting();
    expect(await runRetention(unset.log, undefined)).toBe(0);
    expect(await runRetention(unset.log, '')).toBe(0);
    expect(unset.calls).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a bad value deletes nothing and is logged, never thrown', async () => {
    const bad = counting();
    expect(await runRetention(bad.log, '7')).toBe(0);
    expect(bad.calls).toEqual([]);
    expect(errors).toEqual(['decision log retention: DECISION_LOG_DAYS must be a whole number of days from 30 to 36500; nothing deleted']);
  });

  it('a failing delete is logged, never thrown', async () => {
    expect(await runRetention({ purge: async () => { throw new Error('D1 is down'); } }, '365')).toBe(0);
    expect(errors).toEqual(['decision log retention failed: D1 is down']);
  });
});

describe('D1DecisionLog.purge', () => {
  const log = new D1DecisionLog(DB);
  const OLD = '2025-01-01T00:00:00.000Z';
  const NEW = '2026-11-01T00:00:00.000Z';
  const BEFORE = '2026-01-01T00:00:00.000Z';

  /** A decision row as the log stores it, with only what this test needs. */
  async function row(id: string, created: string, extra: { review_status?: string; callback_status?: string; callback_claim?: string; discarded_at?: string } = {}) {
    await DB.prepare(
      `INSERT INTO decisions (id, created_at, client, profile_id, profile_version, model, action, answers, state_hash, review_status, callback_status, callback_claim, discarded_at)
       VALUES (?, ?, 'c', 'p', 1, 'mock', 'a', '{}', 'h', ?, ?, ?, ?)`,
    ).bind(id, created, extra.review_status ?? null, extra.callback_status ?? null, extra.callback_claim ?? null, extra.discarded_at ?? null).run();
  }
  async function feedback(decisionId: string) {
    await DB.prepare(`INSERT INTO feedback (decision_id, created_at, client, by, correct) VALUES (?, ?, 'c', 'someone', '{}')`).bind(decisionId, NEW).run();
  }
  async function ids() {
    return (await DB.prepare('SELECT id FROM decisions ORDER BY id').all<{ id: string }>()).results.map((r) => r.id);
  }
  async function feedbackFor() {
    return (await DB.prepare('SELECT decision_id FROM feedback ORDER BY decision_id').all<{ decision_id: string }>()).results.map((r) => r.decision_id);
  }

  beforeEach(async () => {
    await DB.batch([DB.prepare('DELETE FROM feedback'), DB.prepare('DELETE FROM decisions')]);
  });

  it('deletes old decisions and their feedback; keeps new ones, and old ones a person or a callback still waits for', async () => {
    await row('old-plain', OLD);
    await row('old-resolved', OLD, { review_status: 'resolved', callback_status: 'delivered' });
    await row('old-superseded', OLD, { review_status: 'superseded' });
    await row('old-failed-callback', OLD, { callback_status: 'failed' });
    await row('old-pending-review', OLD, { review_status: 'pending' });
    await row('old-pending-callback', OLD, { review_status: 'resolved', callback_status: 'pending' });
    await row('new', NEW);
    await feedback('old-plain');
    await feedback('old-pending-review');
    await feedback('new');

    expect(await log.purge(BEFORE, 100)).toBe(4);
    expect(await ids()).toEqual(['new', 'old-pending-callback', 'old-pending-review']);
    // Feedback goes with its decision, and only then.
    expect(await feedbackFor()).toEqual(['new', 'old-pending-review']);
  });

  it('keeps a callback while it is being sent, or pending without a review; deletes a discarded decision', async () => {
    // Claimed by a run sending it now: the status stays pending until recordCallback.
    await row('sending', OLD, { callback_status: 'pending', callback_claim: 'run-1' });
    await row('callback-no-review', OLD, { callback_status: 'pending' });
    await row('superseded-callback', OLD, { review_status: 'superseded', callback_status: 'pending' });
    await row('resolved-no-callback', OLD, { review_status: 'resolved' });
    await row('discarded', OLD, { discarded_at: OLD });
    expect(await log.purge(BEFORE, 100)).toBe(2);
    expect(await ids()).toEqual(['callback-no-review', 'sending', 'superseded-callback']);
  });

  it('deletes more decisions in one call than D1 takes as parameters (the ids go as one JSON value)', async () => {
    const many = Array.from({ length: 150 }, (_, i) => `d-${String(i).padStart(3, '0')}`);
    await DB.batch(many.map((id) => DB.prepare(
      `INSERT INTO decisions (id, created_at, client, profile_id, profile_version, model, action, answers, state_hash) VALUES (?, ?, 'c', 'p', 1, 'mock', 'a', '{}', 'h')`,
    ).bind(id, OLD)));
    await feedback('d-149');
    expect(await log.purge(BEFORE, 150)).toBe(150);
    expect(await ids()).toEqual([]);
    expect(await feedbackFor()).toEqual([]);
  });

  it('checks again when it deletes: a review that became pending since the select keeps its decision and feedback', async () => {
    await row('turns-pending', OLD);
    await row('stays-done', OLD);
    await feedback('turns-pending');
    // Between the select and the delete, a review of this decision starts.
    const racing = new Proxy(DB, {
      get(target, prop) {
        if (prop !== 'batch') return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
        return async (statements: D1PreparedStatement[]) => {
          await target.prepare(`UPDATE decisions SET review_status = 'pending' WHERE id = 'turns-pending'`).run();
          return target.batch(statements);
        };
      },
    });
    expect(await new D1DecisionLog(racing).purge(BEFORE, 100)).toBe(1);
    expect(await ids()).toEqual(['turns-pending']);
    expect(await feedbackFor()).toEqual(['turns-pending']);
  });

  it('deletes at most `limit` decisions per call, oldest first', async () => {
    await row('a', '2025-01-01T00:00:00.000Z');
    await row('b', '2025-02-01T00:00:00.000Z');
    await row('c', '2025-03-01T00:00:00.000Z');
    expect(await log.purge(BEFORE, 2)).toBe(2);
    expect(await ids()).toEqual(['c']);
    expect(await log.purge(BEFORE, 2)).toBe(1);
    expect(await log.purge(BEFORE, 2)).toBe(0);
    expect(await ids()).toEqual([]);
  });

  it('deletes nothing made at or after the time given', async () => {
    await row('at', BEFORE);
    expect(await log.purge(BEFORE, 100)).toBe(0);
    expect(await ids()).toEqual(['at']);
  });
});

describe('the cron handler', () => {
  beforeEach(async () => {
    await DB.batch([DB.prepare('DELETE FROM feedback'), DB.prepare('DELETE FROM decisions')]);
    await DB.prepare(
      `INSERT INTO decisions (id, created_at, client, profile_id, profile_version, model, action, answers, state_hash) VALUES ('ancient', '2020-01-01T00:00:00.000Z', 'c', 'p', 1, 'mock', 'a', '{}', 'h')`,
    ).run();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function tick(vars: Record<string, string | undefined>) {
    const ctx = createExecutionContext();
    await worker.scheduled({} as ScheduledController, { ...(env as object), ...vars } as never, ctx);
    await waitOnExecutionContext(ctx);
    return (await DB.prepare('SELECT COUNT(*) AS n FROM decisions').first<{ n: number }>())!.n;
  }

  it('deletes old decisions when DECISION_LOG_DAYS is set', async () => {
    expect(await tick({ DECISION_LOG_DAYS: '365' })).toBe(0);
  });

  it('deletes nothing when it is unset', async () => {
    expect(await tick({ DECISION_LOG_DAYS: undefined })).toBe(1);
  });
});
