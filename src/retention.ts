// Retention of the decision log: a deployment may set
// DECISION_LOG_DAYS, and the cron trigger then deletes decisions older than
// that, with their feedback. Unset, nothing is deleted (as before).
// A decision whose review or callback is still pending stays until it is done
// (DecisionLog.purge). See docs/decision-log.md#retention.

import { ConfigError } from './decide';
import type { DecisionLog } from './log';

/** The shortest period: shorter would delete decisions while their stats and replays still use them. */
export const MIN_DAYS = 30;
/** Decisions deleted per cron run (every 5 minutes): about 140,000 a day. */
export const BATCH = 500;

/** The retention period in days from DECISION_LOG_DAYS; undefined when unset. Throws ConfigError on a bad value. */
export function retentionDays(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) < MIN_DAYS) {
    throw new ConfigError(`DECISION_LOG_DAYS must be a whole number of days, at least ${MIN_DAYS}`);
  }
  return Number(value);
}

/** Deletes one batch of decisions older than `days` days at `now`; returns how many. */
export async function purgeOldDecisions(log: Pick<DecisionLog, 'purge'>, days: number, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - days * 86_400_000).toISOString();
  return log.purge(before, BATCH);
}
