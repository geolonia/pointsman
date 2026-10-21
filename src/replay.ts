// Replay: what a changed policy would have decided on the decisions already
// logged (docs/profile-format.md#replay). Policy only: the logged answers and
// facts are kept as they were, so no model is called, and the questions,
// facts and requires must stay the same.
//
// Earlier decisions (requires) are read from the snapshot kept with each
// decision, as they were at the time: their action, outcome and reviewed,
// and the values the old rules read. When a new rule reads a value the old
// ones did not keep, that decision cannot be replayed exactly: it is counted
// as inexact and left out of every other number.

import { compilePolicy, peopleCheck, PolicyError, type CompiledPolicy, type PolicyProfile, type RequiredProfiles } from './policy';
import type { DecisionRecord, RequiredSnapshot } from './log';
import type { Answer, Fact, FactMissingReason, Profile, RequiredDecisionInput } from './types';

const ACTION = /^[a-z][a-z0-9_-]{0,62}$/;
export const REPLAY_LIMIT = { default: 200, max: 500 };
/** At most this many rules in a policy sent for a replay: each one runs on every decision. */
const MAX_RULES = 500;
/** The changed decisions listed in a replay; the counts cover all of them. */
const LISTED = 50;

type Policy = Profile['policy'];

export interface ReplayResult {
  profile: string;
  /** The published version whose decisions were replayed. */
  version: number;
  /** How many decisions were replayed exactly, and the time they span (ISO 8601). */
  replayed: number;
  from: string | null;
  to: string | null;
  /** Decisions where a new rule reads a value of an earlier decision that was not kept: not replayed, not counted elsewhere. */
  inexact: number;
  /** Logged decisions the new rules could not run on (an answer they read is not in the log): not counted elsewhere. */
  skipped: number;
  /** Replayed decisions whose action would change. */
  changed: number;
  /** Actions before (as logged) and after (with the new policy). */
  actions: { before: Record<string, number>; after: Record<string, number> };
  /** Each change of action, with how often it happened, most frequent first. */
  transitions: { from: string; to: string; count: number }[];
  /**
   * People: how many decisions went to a person (an action in people_check)
   * and would with the new policy; and of those a person answered, how often
   * the new rules give that answer.
   */
  people: { before: number; after: number; checked: number; matched: number };
  /** Up to 50 changed decisions, newest first. */
  changes: {
    decision_id: string;
    created_at: string;
    ref?: string;
    before: { action: string; rule: number | null };
    after: { action: string; rule: number | null };
    person?: string;
  }[];
}

/** Checks a policy sent for a replay; the conditions are checked when compiled. Returns the problem, or null. */
export function policyShapeError(policy: unknown): string | null {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) return '"policy" must be an object';
  const p = policy as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!['rules', 'default', 'people_check', 'people_answers'].includes(k)) return `"policy.${k}" is not a policy field`;
  }
  if (typeof p.default !== 'string' || !ACTION.test(p.default)) return '"policy.default" must be an action name';
  if (p.rules !== undefined) {
    if (!Array.isArray(p.rules)) return '"policy.rules" must be a list';
    if (p.rules.length > MAX_RULES) return `"policy.rules" may have at most ${MAX_RULES} rules`;
    for (const [i, r] of p.rules.entries()) {
      if (typeof r !== 'object' || r === null || Array.isArray(r)) return `"policy.rules[${i}]" must be an object`;
      const keys = Object.keys(r as object);
      const { when, action } = r as Record<string, unknown>;
      if (keys.some((k) => k !== 'when' && k !== 'action')) return `"policy.rules[${i}]" has only when and action`;
      if (typeof when !== 'string' || when === '') return `"policy.rules[${i}].when" must be a condition`;
      if (typeof action !== 'string' || !ACTION.test(action)) return `"policy.rules[${i}].action" must be an action name`;
    }
  }
  for (const k of ['people_check', 'people_answers'] as const) {
    const v = p[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((a) => typeof a !== 'string' || !ACTION.test(a)) || new Set(v).size !== v.length) {
      return `"policy.${k}" must be a list of different action names`;
    }
  }
  if (Array.isArray(p.people_answers) && (p.people_answers.length === 0 || p.people_answers.includes('review'))) {
    return '"policy.people_answers" must name at least one answer, and not review';
  }
  return null;
}

/** JSON with sorted keys, to compare parts of two profiles. Deeper than any profile part is "too deep". */
function canonical(value: unknown, depth = 0): string {
  if (depth > 20) throw new PolicyError('too deeply nested');
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The parts of a draft that must not change for a policy-only replay. Only
 * the parts the draft gives are compared. Returns the first one that differs.
 */
export function unchangedPartError(base: Profile, draft: Partial<Pick<Profile, 'questions' | 'facts' | 'requires'>>): string | null {
  for (const k of ['questions', 'facts', 'requires'] as const) {
    if (draft[k] === undefined) continue;
    let same: boolean;
    try {
      same = canonical(draft[k]) === canonical(base[k] ?? []);
    } catch (err) {
      if (err instanceof PolicyError) return `the draft's ${k} are nested too deeply`;
      throw err;
    }
    if (!same) {
      return `the draft's ${k} differ from version ${base.version}: a replay changes only the policy (publish the new ${k} first)`;
    }
  }
  return null;
}

/** Longest name first: names may contain dots, as in the parser. */
function byPrefix<T extends { name: string }>(items: T[], path: string): T | undefined {
  return [...items].sort((a, b) => b.name.length - a.name.length).find((x) => path.startsWith(`${x.name}.`));
}

/**
 * An earlier decision as the rules saw it, from the snapshot: action,
 * outcome, reviewed, and the answers and facts the old rules read. Values
 * that were not read are left out, so new rules reading them get unknown.
 */
export function inputFromSnapshot(snapshot: RequiredSnapshot, required: PolicyProfile | undefined): RequiredDecisionInput {
  const answers: Record<string, Record<string, unknown>> = {};
  const facts: Record<string, { missing?: boolean; reason?: string; values: Record<string, unknown> }> = {};
  for (const [path, value] of Object.entries(snapshot.read)) {
    if (value === null) continue; // unknown then, unknown now
    if (path.startsWith('answers.') && required) {
      const q = byPrefix(required.questions, path.slice('answers.'.length));
      if (!q) continue;
      const field = path.slice('answers.'.length + q.name.length + 1);
      const a = (answers[q.name] ??= { type: q.type });
      if (field.startsWith('probabilities.')) ((a.probabilities ??= {}) as Record<string, unknown>)[field.slice('probabilities.'.length)] = value;
      else a[field] = value;
    } else if (path.startsWith('facts.') && required) {
      const f = byPrefix(required.facts ?? [], path.slice('facts.'.length));
      if (!f) continue;
      const field = path.slice('facts.'.length + f.name.length + 1);
      const fact = (facts[f.name] ??= { values: {} });
      if (field === 'missing') fact.missing = value === true;
      else if (field === 'reason') fact.reason = String(value);
      else fact.values[field] = value;
    }
  }
  const factsOut: Record<string, Fact> = {};
  for (const [name, f] of Object.entries(facts)) {
    // A fact the old rules read only for "missing == false" is known to be there, with unknown values.
    factsOut[name] = f.missing === true || f.reason !== undefined
      ? { missing: true, reason: (f.reason ?? 'unavailable') as FactMissingReason }
      : { missing: false, values: f.values as Record<string, string | number | boolean | null>, source: 'replay' };
  }
  return {
    action: snapshot.action,
    outcome: snapshot.outcome,
    reviewed: snapshot.reviewed,
    answers: answers as unknown as Record<string, Answer>,
    facts: factsOut,
  };
}

/** The paths that are always known for a required decision, besides what its snapshot read. */
const ALWAYS = new Set(['missing', 'action', 'outcome', 'reviewed']);

/**
 * Compile a draft policy against the base profile. Throws PolicyError when a
 * condition does not fit, or people_check names an action the policy does
 * not have. Done before the log is read.
 */
export function compileDraft(base: Profile, policy: Policy, required: RequiredProfiles): CompiledPolicy {
  const draft: PolicyProfile = { ...base, policy };
  const actions = new Set([...(policy.rules ?? []).map((r) => r.action), policy.default]);
  for (const a of policy.people_check ?? []) {
    if (!actions.has(a)) throw new PolicyError(`people_check: "${a}" is not an action of this policy (${[...actions].join(', ')})`);
  }
  return compilePolicy(draft, required);
}

/**
 * Replay `records` (decisions of `base`, newest first) with `policy`, already
 * compiled with compileDraft.
 */
export function replay(base: Profile, policy: Policy, compiled: CompiledPolicy, records: DecisionRecord[], required: RequiredProfiles): ReplayResult {
  const toPersonBefore = peopleCheck(base);
  const toPersonAfter = peopleCheck({ policy });
  const result: ReplayResult = {
    profile: base.id,
    version: base.version,
    replayed: 0,
    from: null,
    to: null,
    inexact: 0,
    skipped: 0,
    changed: 0,
    actions: { before: {}, after: {} },
    transitions: [],
    people: { before: 0, after: 0, checked: 0, matched: 0 },
    changes: [],
  };
  const transitions = new Map<string, number>();
  for (const record of records) {
    const decisions: Record<string, RequiredDecisionInput> = {};
    for (const [name, snapshot] of Object.entries(record.requires ?? {})) {
      const r = base.requires?.find((x) => x.name === name);
      decisions[name] = inputFromSnapshot(snapshot, r ? required[r.profile] : undefined);
    }
    // Inexact when a rule reads a value of an earlier decision that its
    // snapshot did not keep: a rebuilt value would be made up (an absent fact
    // reads as missing, absent probabilities as 0), so the decision is not
    // replayed. Every rule's reads count, also rules after the one that would
    // match, so this errs on the side of inexact.
    const needed = compiled.read(decisions);
    const inexact = Object.entries(needed).some(([name, paths]) => {
      const kept = record.requires?.[name];
      return kept !== undefined && Object.keys(paths).some((p) => !ALWAYS.has(p) && !Object.hasOwn(kept.read, p));
    });
    if (inexact) {
      result.inexact++;
      continue;
    }
    let after: { action: string; rule: number | null };
    try {
      after = compiled.decide(record.answers, record.facts ?? {}, decisions);
    } catch (err) {
      // A logged decision without an answer the new rules read; the rules
      // cannot run on it.
      if (!(err instanceof PolicyError)) throw err;
      result.skipped++;
      continue;
    }
    result.replayed++;
    result.to ??= record.created_at;
    result.from = record.created_at;
    const before = { action: record.action, rule: record.rule };
    result.actions.before[before.action] = (result.actions.before[before.action] ?? 0) + 1;
    result.actions.after[after.action] = (result.actions.after[after.action] ?? 0) + 1;
    if (toPersonBefore.includes(before.action)) result.people.before++;
    if (toPersonAfter.includes(after.action)) result.people.after++;
    const person = record.review?.status === 'resolved' ? record.review.final_action : undefined;
    if (person !== undefined) {
      result.people.checked++;
      if (person === after.action) result.people.matched++;
    }
    if (after.action !== before.action) {
      result.changed++;
      const key = `${before.action}\u0000${after.action}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
      if (result.changes.length < LISTED) {
        result.changes.push({
          decision_id: record.decision_id,
          created_at: record.created_at,
          ...(record.ref !== undefined && { ref: record.ref }),
          before,
          after,
          ...(person !== undefined && { person }),
        });
      }
    }
  }
  result.transitions = [...transitions].map(([k, count]) => {
    const [from, to] = k.split('\u0000') as [string, string];
    return { from, to, count };
  }).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return result;
}
