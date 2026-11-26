// Retention of the decision log (src/retention.ts, DecisionLog.purge).

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DecisionLog } from '../../src/log-d1';
import { BATCH, MIN_DAYS, purgeOldDecisions, retentionDays } from '../../src/retention';
import { ConfigError } from '../../src/decide';

const DB = (env as unknown as { DB: D1Database }).DB;

describe('retentionDays', () => {
  it('is undefined when DECISION_LOG_DAYS is unset or empty: nothing is deleted', () => {
    expect(retentionDays(undefined)).toBeUndefined();
    expect(retentionDays('')).toBeUndefined();
  });

  it('reads whole days from the minimum up', () => {
    expect(retentionDays('365')).toBe(365);
    expect(retentionDays(String(MIN_DAYS))).toBe(MIN_DAYS);
  });

  it('refuses anything else as a configuration error', () => {
    for (const bad of ['0', '29', '-1', '1.5', '365d', ' 365', 'abc', '1000000']) {
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

describe('D1DecisionLog.purge', () => {
  const log = new D1DecisionLog(DB);
  const OLD = '2025-01-01T00:00:00.000Z';
  const NEW = '2026-11-01T00:00:00.000Z';
  const BEFORE = '2026-01-01T00:00:00.000Z';

  /** A decision row as the log stores it, with only what this test needs. */
  async function row(id: string, created: string, extra: { review_status?: string; callback_status?: string } = {}) {
    await DB.prepare(
      `INSERT INTO decisions (id, created_at, client, profile_id, profile_version, model, action, answers, state_hash, review_status, callback_status)
       VALUES (?, ?, 'c', 'p', 1, 'mock', 'a', '{}', 'h', ?, ?)`,
    ).bind(id, created, extra.review_status ?? null, extra.callback_status ?? null).run();
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
