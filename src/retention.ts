// Retention of the decision log: a deployment may set DECISION_LOG_DAYS, and
// the cron trigger then deletes decisions older than that, with their
// feedback. Unset, nothing is deleted (as before). A decision whose review or
// callback is still pending stays until it is done (DecisionLog.purge).
// See docs/decision-log.md#retention.
//
// The setting controls only this background job, so a bad value stops the
// deletion (with an error in the log), not the API. The config check
// (scripts/check-config.mjs) refuses it before a deploy.

import { ConfigError } from './decide';
import type { DecisionLog } from './log';
import { retentionProblem } from './retention-days';

export { MAX_DAYS, MIN_DAYS } from './retention-days';
/** Decisions deleted per cron run (every 5 minutes): at most 144,000 a day. */
export const BATCH = 500;

/** The retention period in days from DECISION_LOG_DAYS; undefined when unset. Throws ConfigError on a bad value. */
export function retentionDays(value: string | undefined): number | undefined {
  const problem = retentionProblem(value);
  if (problem) throw new ConfigError(problem);
  return value === undefined || value === '' ? undefined : Number(value);
}

/** Deletes one batch of decisions older than `days` days at `now`; returns how many. */
export async function purgeOldDecisions(log: Pick<DecisionLog, 'purge'>, days: number, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - days * 86_400_000).toISOString();
  return log.purge(before, BATCH);
}

/**
 * The cron's part: one batch when DECISION_LOG_DAYS is set. Never throws: a
 * bad value or a failing delete is logged (the setting's name and the error,
 * never data), and the next run tries again. Returns how many were deleted.
 */
export async function runRetention(log: Pick<DecisionLog, 'purge'>, value: string | undefined, now: Date = new Date()): Promise<number> {
  let days: number | undefined;
  try {
    days = retentionDays(value);
  } catch (err) {
    console.error(`decision log retention: ${(err as Error).message}; nothing deleted`);
    return 0;
  }
  if (days === undefined) return 0;
  try {
    const n = await purgeOldDecisions(log, days, now);
    if (n > 0) console.log(`decision log retention: deleted ${n} decisions older than ${days} days`);
    return n;
  } catch (err) {
    console.error(`decision log retention failed: ${(err as Error).message}`);
    return 0;
  }
}
