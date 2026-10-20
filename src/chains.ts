// Decision chains (docs/decision-chains.md): the earlier decisions a profile
// `requires`, read from the decision log by id. The caller sends only ids;
// actions, answers and facts come from the log, so a caller cannot claim a
// result. Every reason a decision cannot be used gives the same answer, so a
// caller cannot find out which decisions exist (P-TOKEN-SCOPE).

import { canUse, type TokenRecord } from './auth';
import type { DecisionLog, DecisionRecord, RequiredSnapshot } from './log';
import type { CompiledPolicy, RequiredProfiles } from './policy';
import type { ProfileStore } from './profiles/store';
import type { Answer, Profile, RequiredDecisionInput } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REQUIRED = 8;

/** Checks the shape of `decisions` in a request; returns an error message or null. */
export function decisionsError(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '"decisions" must be an object of names and decision ids';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_REQUIRED) return `"decisions" must have 1 to ${MAX_REQUIRED} entries`;
  for (const [name, id] of entries) {
    if (typeof id !== 'string' || !UUID.test(id)) return `"decisions.${name}" must be a decision id`;
  }
  if (new Set(entries.map(([, id]) => id)).size !== entries.length) return '"decisions" names the same decision twice';
  return null;
}

/** The answer a person gave counts: their corrected values replace the model's. */
function answersAfterReview(record: DecisionRecord): Record<string, Answer> {
  const final = record.review?.status === 'resolved' ? record.review.final_answers : undefined;
  if (!final) return record.answers;
  const out: Record<string, Answer> = { ...record.answers };
  for (const [name, a] of Object.entries(final)) {
    const model = record.answers[name];
    if (!model || a.source !== 'human' || a.value === model.value) continue;
    // A person's value is certain; the model's probabilities no longer apply.
    if (model.type === 'noul' && typeof a.value === 'boolean') out[name] = { type: 'noul', value: a.value, p: 1, yes: a.value ? 1 : 0 };
    if (model.type === 'choice' && typeof a.value === 'string') out[name] = { type: 'choice', value: a.value, p: 1, probabilities: { [a.value]: 1 } };
    if (model.type === 'score' && typeof a.value === 'number') {
      out[name] = { type: 'score', value: a.value, p: 1, score: a.value, probabilities: { [String(a.value)]: 1 } };
    }
  }
  return out;
}

/** What rules read from a logged decision. */
export function inputOf(record: DecisionRecord): RequiredDecisionInput {
  const reviewed = record.review?.status === 'resolved';
  return {
    action: record.action,
    outcome: reviewed && record.review?.final_action ? record.review.final_action : record.action,
    reviewed,
    answers: answersAfterReview(record),
    facts: record.facts ?? {},
  };
}

export type RequiredDecisions =
  | {
      ok: true;
      inputs: Record<string, RequiredDecisionInput>;
      records: Record<string, DecisionRecord>;
      /** The required profiles, latest version, for compiling the rules. */
      profiles: RequiredProfiles;
    }
  | { ok: false; message: string };

/**
 * Reads and checks the required decisions of a request. `ref` is required
 * when the profile has requires (checked by the caller).
 */
export async function loadRequired(
  profile: Profile,
  given: Record<string, string> | undefined,
  ref: string,
  client: TokenRecord,
  log: DecisionLog,
  store: ProfileStore,
): Promise<RequiredDecisions> {
  const requires = profile.requires ?? [];
  const decisions = given ?? {};
  for (const name of Object.keys(decisions)) {
    if (!requires.some((r) => r.name === name)) return { ok: false, message: `"decisions.${name}": the profile requires no decision of that name` };
  }
  const unusable = (name: string) => ({ ok: false as const, message: `decisions.${name} is not a usable decision` });
  const inputs: Record<string, RequiredDecisionInput> = {};
  const records: Record<string, DecisionRecord> = {};
  for (const r of requires) {
    const id = Object.hasOwn(decisions, r.name) ? decisions[r.name] : undefined;
    if (id === undefined) {
      if (r.optional) continue;
      return { ok: false, message: `"decisions.${r.name}" is required by the profile` };
    }
    const record = await log.get(id);
    // One answer for every reason: unknown, out of scope, another profile,
    // another report or client, or replaced.
    if (!record || !canUse(client, record.profile) || record.profile !== r.profile || record.ref !== ref
      || record.client !== client.client || record.review?.status === 'superseded') {
      return unusable(r.name);
    }
    // Only the newest decision of its step for this report counts.
    if ((await log.latestFor(record.profile, ref, client.client))?.decision_id !== record.decision_id) return unusable(r.name);
    records[r.name] = record;
    inputs[r.name] = inputOf(record);
  }
  // The decisions fit each other: a required decision that itself used one
  // of the same profile as another given here must have used that one. An
  // optional one that does not fit was made for an earlier state of the
  // report (for example an evacuation check from before the first check was
  // made again): it is left out, as if it had not run, so the step is decided
  // from the decisions that are current. A required one that does not fit is
  // refused.
  const optional = (name: string) => requires.some((r) => r.name === name && r.optional);
  for (const [name, record] of Object.entries(records)) {
    if (!records[name]) continue;
    for (const snap of Object.values(record.requires ?? {})) {
      const otherName = Object.keys(records).find((n) => records[n]!.profile === snap.profile);
      if (otherName === undefined || records[otherName]!.decision_id === snap.decision) continue;
      const drop = optional(name) ? name : optional(otherName) ? otherName : undefined;
      if (drop === undefined) return unusable(name);
      delete records[drop];
      delete inputs[drop];
      if (drop === name) break;
    }
  }
  const profiles: RequiredProfiles = {};
  for (const r of requires) profiles[r.profile] = (await store.get(r.profile)) ?? undefined;
  return { ok: true, inputs, records, profiles };
}

/** The snapshot kept with the decision: what the rules read from each required decision. */
export function snapshotOf(required: Extract<RequiredDecisions, { ok: true }>, policy: CompiledPolicy): Record<string, RequiredSnapshot> {
  const read = policy.read(required.inputs);
  const out: Record<string, RequiredSnapshot> = {};
  for (const [name, record] of Object.entries(required.records)) {
    const input = required.inputs[name]!;
    out[name] = {
      decision: record.decision_id,
      profile: record.profile,
      profile_version: record.profile_version,
      action: input.action,
      outcome: input.outcome,
      reviewed: input.reviewed,
      read: read[name] ?? {},
    };
  }
  return out;
}

/**
 * `requires` as a reader may see it: a required decision of a profile the
 * reader may not use (or, through MCP, that is not visible) is shown as
 * { decision: null }, as if unknown.
 */
export function visibleRequires(
  requires: Record<string, RequiredSnapshot> | undefined,
  visible: (profile: string) => boolean,
): Record<string, RequiredSnapshot | { decision: null }> | undefined {
  if (!requires) return undefined;
  const out: Record<string, RequiredSnapshot | { decision: null }> = {};
  for (const [name, snap] of Object.entries(requires)) out[name] = visible(snap.profile) ? snap : { decision: null };
  return out;
}
