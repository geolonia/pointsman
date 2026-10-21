// Test cases for a profile (docs/profile-format.md#test-cases): examples with
// the action a person expects, run against the profile's rules.
//
// A case gives either `answers` (the AI's answers, written short, plus facts
// and earlier decisions): then only the rules are checked, without a model;
// or a `state` (a real request): then a deployed Pointsman's model answers
// it and the rules here are applied to those answers
// (scripts/test-profile.mjs --url).
//
// Like src/policy.ts, this file is imported by a script under Node.js, so it
// uses only TypeScript syntax that Node can strip.

import { compilePolicy, FACT_FIELDS, peopleAnswers, profileActions } from './policy.ts';
import type { RequiredProfiles } from './policy.ts';
import type { Answer, Fact, FactMissingReason, FactType, Profile, Question, RequiredDecisionInput } from './types.ts';

export interface TestCase {
  name: string;
  /** The action a person expects. */
  expect: string;
  /** The AI's answers, short: see answerOf. */
  answers?: Record<string, unknown>;
  /** Facts by name: their field values, or "missing" (or { missing: reason }). Not given = missing. */
  facts?: Record<string, unknown>;
  /** Earlier decisions by the name in requires: { outcome, action, reviewed, answers, facts }, or "missing". */
  decisions?: Record<string, unknown>;
  /** A real request, answered by a deployed model. */
  state?: unknown;
}

export interface CaseFile {
  /** The profile id the cases are for. */
  profile: string;
  cases: TestCase[];
}

export interface CaseResult {
  name: string;
  expect: string;
  /** The action the rules gave; undefined when the case could not run. */
  got?: string;
  /** Index of the matching rule; null = the default. */
  rule?: number | null;
  status: 'pass' | 'fail' | 'skip' | 'error';
  /** Why a case was skipped or could not run. */
  message?: string;
}

const MISSING_REASONS: FactMissingReason[] = ['no_location', 'unavailable', 'timeout', 'error'];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isProbability = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/** Thrown for a case that does not fit its profile; the message says where. */
export class CaseError extends Error {
  override name = 'CaseError';
}

function top(probabilities: Record<string, number>): [string, number] {
  let best: [string, number] | undefined;
  for (const [k, v] of Object.entries(probabilities)) if (!best || v > best[1]) best = [k, v];
  return best!;
}

function probabilities(where: string, value: Record<string, unknown>, allowed: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!allowed.includes(k)) throw new CaseError(`${where}: "${k}" is not one of ${allowed.join(', ')}`);
    if (!isProbability(v)) throw new CaseError(`${where}: the probability of "${k}" must be a number from 0 to 1`);
    out[k] = v;
  }
  if (Object.keys(out).length === 0) throw new CaseError(`${where}: give at least one probability`);
  return out;
}

/**
 * One answer, written short, in the engine's format (src/models/normalize.ts
 * does the same for a model's answer):
 *
 * - yes/no: true or false (certain), or the probability of yes (0.85)
 * - choice: an option (certain), or probabilities by option ({ a: 0.7, b: 0.3 })
 * - score: a level (2, certain), or probabilities by level ({ "1": 0.2, "2": 0.8 });
 *   the weighted level is computed from them
 */
export function answerOf(q: Question, value: unknown, where: string): Answer {
  switch (q.type) {
    case 'noul': {
      const yes = value === true ? 1 : value === false ? 0 : value;
      if (!isProbability(yes)) throw new CaseError(`${where}: give true, false, or the probability of yes (0 to 1)`);
      const v = yes >= 0.5;
      return { type: 'noul', value: v, p: v ? yes : 1 - yes, yes };
    }
    case 'choice': {
      const options = q.criteria.map((c) => c.value);
      const probs = typeof value === 'string' ? probabilities(where, { [value]: 1 }, options)
        : isObject(value) ? probabilities(where, value, options) : undefined;
      if (!probs) throw new CaseError(`${where}: give an option, or probabilities by option`);
      const [v, p] = top(probs);
      return { type: 'choice', value: v, p, probabilities: probs };
    }
    case 'score': {
      const levels = q.criteria.map((_, i) => String(i));
      const probs = typeof value === 'number' && Number.isInteger(value) ? probabilities(where, { [String(value)]: 1 }, levels)
        : isObject(value) ? probabilities(where, value, levels) : undefined;
      if (!probs) throw new CaseError(`${where}: give a level (0 to ${levels.length - 1}), or probabilities by level`);
      const [v, p] = top(probs);
      const total = Object.values(probs).reduce((a, b) => a + b, 0);
      if (total === 0) throw new CaseError(`${where}: the probabilities cannot all be 0`);
      const score = Object.entries(probs).reduce((a, [k, x]) => a + Number(k) * x, 0) / total;
      return { type: 'score', value: Number(v), p, score, probabilities: probs };
    }
  }
}

function answersOf(questions: Question[], given: unknown, where: string): Record<string, Answer> {
  if (!isObject(given)) throw new CaseError(`${where}: answers must be an object, by question name`);
  for (const k of Object.keys(given)) {
    if (!questions.some((q) => q.name === k)) throw new CaseError(`${where}: "${k}" is not a question of this profile`);
  }
  const out: Record<string, Answer> = {};
  for (const q of questions) {
    // Every question: the engine always has every answer.
    if (!Object.hasOwn(given, q.name)) throw new CaseError(`${where}: no answer for "${q.name}"`);
    out[q.name] = answerOf(q, given[q.name], `${where}.${q.name}`);
  }
  return out;
}

function factsOf(profile: Pick<Profile, 'facts'>, given: unknown, where: string): Record<string, Fact> {
  if (given === undefined) return {};
  if (!isObject(given)) throw new CaseError(`${where}: facts must be an object, by fact name`);
  const out: Record<string, Fact> = {};
  for (const [name, value] of Object.entries(given)) {
    const spec = (profile.facts ?? []).find((f) => f.name === name);
    if (!spec) throw new CaseError(`${where}: "${name}" is not a fact of this profile`);
    const at = `${where}.${name}`;
    if (value === 'missing') {
      out[name] = { missing: true, reason: 'unavailable' };
      continue;
    }
    if (!isObject(value)) throw new CaseError(`${at}: give the fact's fields, or "missing"`);
    if (Object.hasOwn(value, 'missing')) {
      const reason = value.missing === true ? 'unavailable' : value.missing;
      if (Object.keys(value).length !== 1 || !MISSING_REASONS.includes(reason as FactMissingReason)) {
        throw new CaseError(`${at}: missing must be true or a reason (${MISSING_REASONS.join(', ')}), and alone`);
      }
      out[name] = { missing: true, reason: reason as FactMissingReason };
      continue;
    }
    const fields = FACT_FIELDS[spec.type];
    const values: Record<string, string | number | boolean | null> = {};
    for (const [field, v] of Object.entries(value)) {
      const kind = Object.hasOwn(fields, field) ? fields[field] : undefined;
      if (!kind) throw new CaseError(`${at}: ${spec.type} facts have ${Object.keys(fields).join(', ')}`);
      if (v !== null && typeof v !== kind) throw new CaseError(`${at}.${field}: must be a ${kind} (or null for no value)`);
      values[field] = v as string | number | boolean | null;
    }
    out[name] = { missing: false, values: shaped(spec.type, values, at), source: 'test case' };
  }
  return out;
}

/**
 * A fact's values as the engine's providers give them (src/facts-gsi.ts,
 * src/facts-routing.ts), so a case cannot pass on values the engine never
 * produces: the first field says whether something was found, and decides
 * the others. Not inside: rank 0, class "". Not found, or no way around: no
 * values. Otherwise every field is needed, except a name and a route.
 */
const SHAPES: Record<FactType, { key: string; absent: Record<string, string | number | null>; optional: string[] }> = {
  inside: { key: 'inside', absent: { rank: 0, class: '' }, optional: [] },
  nearest: { key: 'found', absent: { distance_m: null, name: null }, optional: ['name'] },
  detour: { key: 'possible', absent: { extra_m: null, route: null }, optional: ['route'] },
};

function shaped(type: FactType, values: Record<string, string | number | boolean | null>, where: string): Record<string, string | number | boolean | null> {
  const { key, absent, optional } = SHAPES[type];
  if (typeof values[key] !== 'boolean') throw new CaseError(`${where}.${key}: give true or false`);
  if (values[key] === false) {
    for (const [field, v] of Object.entries(values)) {
      if (field !== key && v !== absent[field]) throw new CaseError(`${where}.${field}: when ${key} is false, the engine gives ${JSON.stringify(absent[field])}; leave it out`);
    }
    return { [key]: false, ...absent };
  }
  const out = { ...values };
  for (const field of Object.keys(absent)) {
    if (out[field] === undefined || out[field] === null) {
      if (!optional.includes(field)) throw new CaseError(`${where}.${field}: needed when ${key} is true`);
      out[field] = null;
    }
  }
  return out;
}

function decisionsOf(profile: Profile, required: Record<string, Profile | undefined>, given: unknown, where: string): Record<string, RequiredDecisionInput> {
  if (given === undefined) return {};
  if (!isObject(given)) throw new CaseError(`${where}: decisions must be an object, by the names in requires`);
  const out: Record<string, RequiredDecisionInput> = {};
  for (const [name, value] of Object.entries(given)) {
    const r = (profile.requires ?? []).find((x) => x.name === name);
    if (!r) throw new CaseError(`${where}: "${name}" is not in this profile's requires`);
    if (value === 'missing') continue;
    const at = `${where}.${name}`;
    const p = Object.hasOwn(required, r.profile) ? required[r.profile] : undefined;
    if (!p) throw new CaseError(`${at}: the required profile "${r.profile}" is not known`);
    if (!isObject(value)) throw new CaseError(`${at}: give { outcome, action, reviewed, answers, facts }, or "missing"`);
    for (const k of Object.keys(value)) {
      if (!['outcome', 'action', 'reviewed', 'answers', 'facts'].includes(k)) throw new CaseError(`${at}: unknown field "${k}"`);
    }
    if (value.reviewed !== undefined && typeof value.reviewed !== 'boolean') throw new CaseError(`${at}.reviewed: must be true or false`);
    const reviewed = value.reviewed === true;
    // Without a person, the outcome is the action; with one, it is their answer.
    const action = value.action ?? (reviewed ? undefined : value.outcome);
    const outcome = value.outcome ?? value.action;
    if (typeof action !== 'string') throw new CaseError(`${at}: give its action${reviewed ? ' (with reviewed: true, the action and the person\'s outcome are separate)' : ' or outcome'}`);
    if (typeof outcome !== 'string') throw new CaseError(`${at}: give its outcome`);
    const actions = profileActions(p);
    if (!actions.includes(action)) throw new CaseError(`${at}.action: "${action}" is not an action of ${r.profile} (${actions.join(', ')})`);
    if (!reviewed && outcome !== action) throw new CaseError(`${at}: without reviewed: true, the outcome is the action`);
    const answers = [...new Set([...actions, ...peopleAnswers(p)])];
    if (!answers.includes(outcome)) throw new CaseError(`${at}.outcome: "${outcome}" is not an outcome of ${r.profile} (${answers.join(', ')})`);
    out[name] = {
      action,
      outcome,
      reviewed,
      // Not all answers are needed here: rules read only some, and a missing one is unknown.
      answers: value.answers === undefined ? {} : partialAnswers(p.questions, value.answers, `${at}.answers`),
      facts: factsOf(p, value.facts, `${at}.facts`),
    };
  }
  return out;
}

function partialAnswers(questions: Question[], given: unknown, where: string): Record<string, Answer> {
  if (!isObject(given)) throw new CaseError(`${where}: must be an object, by question name`);
  const out: Record<string, Answer> = {};
  for (const [k, v] of Object.entries(given)) {
    const q = questions.find((x) => x.name === k);
    if (!q) throw new CaseError(`${where}: "${k}" is not a question of that profile`);
    out[k] = answerOf(q, v, `${where}.${k}`);
  }
  return out;
}

/** Problems with the file's shape, before any case runs. */
export function caseFileErrors(file: unknown, profile: Profile): string[] {
  if (!isObject(file)) return ['a case file is an object with profile and cases'];
  const errors: string[] = [];
  if (file.profile !== profile.id) errors.push(`profile: "${String(file.profile)}" is not "${profile.id}"`);
  if (!Array.isArray(file.cases) || file.cases.length === 0) return [...errors, 'cases: give at least one case'];
  const actions = profileActions(profile);
  const names = new Set<string>();
  file.cases.forEach((c: unknown, i: number) => {
    const at = `cases[${i}]`;
    if (!isObject(c)) return errors.push(`${at}: must be an object`);
    for (const k of Object.keys(c)) {
      if (!['name', 'expect', 'answers', 'facts', 'decisions', 'state'].includes(k)) errors.push(`${at}: unknown field "${k}"`);
    }
    if (typeof c.name !== 'string' || c.name === '') errors.push(`${at}.name: required`);
    else if (names.has(c.name)) errors.push(`${at}.name: "${c.name}" is used twice`);
    else names.add(c.name);
    if (typeof c.expect !== 'string' || !actions.includes(c.expect)) errors.push(`${at}.expect: must be one of ${actions.join(', ')}`);
    if ((c.answers === undefined) === (c.state === undefined)) errors.push(`${at}: give either answers or state`);
    if (c.state !== undefined && (c.facts !== undefined || c.decisions !== undefined)) {
      errors.push(`${at}: with state, the facts come from the deployment; give facts and decisions only with answers`);
    }
    return undefined;
  });
  return errors;
}

/** The inputs of a case with answers, in the engine's format; throws CaseError. */
export function caseInputs(c: TestCase, profile: Profile, required: Record<string, Profile | undefined> = {}) {
  return {
    answers: answersOf(profile.questions, c.answers, 'answers'),
    facts: factsOf(profile, c.facts, 'facts'),
    decisions: decisionsOf(profile, required, c.decisions, 'decisions'),
  };
}

/**
 * Run the cases that give answers. Cases with a state are skipped here: they
 * need a model (scripts/test-profile.mjs --url answers them, then calls
 * judge). The file's shape is checked first (caseFileErrors).
 */
export function runCases(file: CaseFile, profile: Profile, required: Record<string, Profile | undefined> = {}): CaseResult[] {
  const policy = compilePolicy(profile, required as RequiredProfiles);
  return file.cases.map((c) => {
    if (c.state !== undefined) return { name: c.name, expect: c.expect, status: 'skip', message: 'needs a model: run with --url' };
    try {
      const { answers, facts, decisions } = caseInputs(c, profile, required);
      return judge(c, policy.decide(answers, facts, decisions));
    } catch (err) {
      if (!(err instanceof CaseError)) throw err;
      return { name: c.name, expect: c.expect, status: 'error', message: err.message };
    }
  });
}

/** Compare what the rules gave with what the case expects. */
export function judge(c: Pick<TestCase, 'name' | 'expect'>, result: { action: string; rule: number | null }): CaseResult {
  return { name: c.name, expect: c.expect, got: result.action, rule: result.rule, status: result.action === c.expect ? 'pass' : 'fail' };
}

/**
 * Check that facts from a deployed profile fit this profile's facts: each
 * fact there, with the fields of its type. Returns the problem, or null.
 */
export function factsFit(profile: Profile, facts: Record<string, Fact>): string | null {
  for (const f of profile.facts ?? []) {
    const got = Object.hasOwn(facts, f.name) ? facts[f.name] : undefined;
    if (!got) return `the deployed profile has no fact "${f.name}"`;
    if (!got.missing && Object.keys(FACT_FIELDS[f.type]).some((field) => !Object.hasOwn(got.values, field))) {
      return `the deployed fact "${f.name}" is not a ${f.type} fact`;
    }
  }
  return null;
}

/**
 * Check that answers from a deployed profile fit this profile's questions,
 * so its rules can be applied to them: same names, types, and options or
 * levels. Returns the problem, or null.
 */
export function answersFit(profile: Profile, answers: Record<string, Answer>): string | null {
  for (const q of profile.questions) {
    const a = Object.hasOwn(answers, q.name) ? answers[q.name] : undefined;
    if (!a || a.type !== q.type) return `the deployed profile has no ${q.type} answer for "${q.name}"`;
    const allowed = q.type === 'choice' ? q.criteria.map((c) => c.value) : q.type === 'score' ? q.criteria.map((_, i) => String(i)) : [];
    // Only checks that the deployed options are among the file's: an option
    // or level the file adds cannot be told apart from one that was renamed.
    if ('probabilities' in a && Object.keys(a.probabilities).some((k) => !allowed.includes(k))) {
      return `the deployed profile's options for "${q.name}" differ`;
    }
  }
  return null;
}
