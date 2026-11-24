// Callback delivery: claims, sends and records the callback of a resolved
// decision, and the scheduled retry of the callbacks that are due
// (docs/reviews.md "Callbacks"; signing and one attempt are in
// src/callbacks.ts). It uses no runtime-specific API (docs/adapters.md).

import { attempt, failedAttempt } from './callbacks';
import type { Deps } from './decide';
import type { DecisionRecord } from './log';

/** Longer than one attempt (10 s timeout), so a claim never expires mid-send. */
const CLAIM_LEASE_MS = 60_000;

/** The current time; tests pass their own. */
export type Clock = () => Date;
const systemClock: Clock = () => new Date();

/**
 * One callback attempt for a resolved decision. The callback is claimed
 * first, so the first delivery and the cron retry can never send the same
 * attempt twice; only the claimant sends and records the outcome. The claim,
 * the signing time and the next retry each read the clock when they happen.
 */
export async function deliver(d: DecisionRecord, deps: Pick<Deps, 'log' | 'callbacks'>, clock: Clock = systemClock): Promise<void> {
  const now = clock();
  const claim = {
    id: crypto.randomUUID(),
    now: now.toISOString(),
    leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
    attempts: d.callback?.attempts ?? 0,
  };
  if (!(await deps.log.claimCallback(d.decision_id, claim))) return; // someone else has it
  let state;
  try {
    state = await attempt(d, { ...deps.callbacks, clock });
  } catch (err) {
    // Counted like any failed attempt, so a record that always throws ends as failed.
    state = failedAttempt(d, err instanceof Error ? err.message : String(err), clock);
  }
  await deps.log.recordCallback(d.decision_id, state, claim.id);
  if (state.status !== 'delivered') console.error(`callback for ${d.decision_id}: ${state.last_error} (${state.status})`);
}

/**
 * Retry every callback that is due (run by the scheduled handler). Each item
 * reads the clock itself, so a slow receiver does not age the later claims
 * and signatures. An error in one item is logged and the batch goes on. An
 * error in the attempt is recorded as a failed attempt (deliver); an error in
 * the claim or the record leaves the item to a later run once its lease
 * runs out, so a callback can be sent again (at least once, docs/reviews.md).
 */
export async function retryDueCallbacks(deps: Pick<Deps, 'log' | 'callbacks'>, clock: Clock = systemClock): Promise<number> {
  const due = await deps.log.dueCallbacks(clock().toISOString(), 50);
  for (const d of due) {
    try {
      await deliver(d, deps, clock);
    } catch (err) {
      console.error(`callback for ${d.decision_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return due.length;
}
