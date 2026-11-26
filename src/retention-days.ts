// DECISION_LOG_DAYS, checked without the engine (src/retention.ts), so the
// config check (scripts/check-config.mjs) can read it too. No imports.

/** The shortest period: shorter would delete decisions while their stats and replays still use them. */
export const MIN_DAYS = 30;
/** The longest: 100 years. A larger value would be a typo that keeps everything. */
export const MAX_DAYS = 36_500;

/** What is wrong with a DECISION_LOG_DAYS value, or null when it is fine (or unset). */
export function retentionProblem(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) < MIN_DAYS || Number(value) > MAX_DAYS) {
    return `DECISION_LOG_DAYS must be a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}`;
  }
  return null;
}
