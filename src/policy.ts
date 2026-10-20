// Policy rules: a small condition language over the answers, without eval.
//
//   condition  := or
//   or         := and ("or" and)*
//   and        := not ("and" not)*
//   not        := "not" not | "(" or ")" | comparison
//   comparison := operand ("==" | "!=" | ">=" | ">" | "<=" | "<") operand
//   operand    := reference | number | string | true | false
//   reference  := <question name> "." field | "facts." <fact name> "." fact field
//               | "decisions." <name> "." decision field
//   field      := value | p | yes | score | probabilities.<option or level>
//   fact field := missing, or a field of the fact's type (FACT_FIELDS)
//   decision field := missing | action | outcome | reviewed
//               | "answers." <question of that profile> "." field
//               | "facts." <fact of that profile> "." fact field
//
// Strings use single or double quotes. Examples:
//   team.p >= 0.85
//   stuck.yes >= 0.9 and phase.value != 'rolling_back'
//   not (urgent.value == true) or effort.value <= 1
//
// Conditions are compiled against the profile, so a typo in a question name,
// a field the question type does not have, an unknown option, or comparing
// values of different types fails profile validation, not a request.
//
// Facts (docs/profile-format.md#facts) can be missing: a lookup failed, or a
// field has no value (no nearest feature found). A comparison with a missing
// value is unknown, and unknown follows three-valued logic (false and
// unknown = false, true or unknown = true, not unknown = unknown). A rule
// matches only when its condition is true, so a missing fact never makes a
// rule match by accident; `facts.<name>.missing == true` is always known.
//
// Decisions (docs/decision-chains.md) are the earlier decisions a profile
// `requires`, read from the decision log. They are checked against the
// required profile; at run time a decision that was not given, or a value
// that is missing or of another type (an older version of that profile), is
// unknown too.
//
// This file is also imported by the profile validator under Node.js, so it
// uses only TypeScript syntax that Node can strip (no enums, no parameter
// properties) and imports types only.

import type { Answer, Fact, FactSpec, FactType, Profile, Question, RequiredDecisionInput } from './types';

type Kind = 'number' | 'string' | 'boolean';

/** Why a fact can be missing (types.ts FactMissingReason), for facts.<fact>.reason. */
const MISSING_REASONS: string[] = ['no_location', 'unavailable', 'timeout', 'error'];
type Value = number | string | boolean;
type Op = '==' | '!=' | '>=' | '>' | '<=' | '<';

type QuestionOperand = { kind: Kind; question: string; field: string; key?: string };
type FactOperand = { kind: Kind; fact: string; field: string };
type DecisionOperand =
  | { kind: Kind; decision: string; field: 'missing' | 'action' | 'outcome' | 'reviewed'; path: string; allowed?: string[] }
  | { kind: Kind; decision: string; inner: QuestionOperand | FactOperand; path: string };

type Operand =
  | { kind: Kind; literal: Value }
  | QuestionOperand
  | FactOperand
  | DecisionOperand;

/** The parts of a profile that rules are compiled against. */
export type PolicyProfile = Pick<Profile, 'questions' | 'policy' | 'facts' | 'requires'>;
/** A required profile, by id: what decisions.<name>.* is checked against. */
export type RequiredProfiles = Record<string, PolicyProfile | undefined>;

type Node =
  | { type: 'and' | 'or'; left: Node; right: Node }
  | { type: 'not'; operand: Node }
  | { type: 'cmp'; op: Op; left: Operand; right: Operand };

export class PolicyError extends Error {
  override name = 'PolicyError';
}

// ---- tokenizer ----

type Token =
  | { t: 'op'; v: Op }
  | { t: 'paren'; v: '(' | ')' }
  | { t: 'word'; v: string }
  | { t: 'number'; v: number }
  | { t: 'string'; v: string };

const TOKEN = /\s*(?:(==|!=|>=|<=|>|<)|([()])|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z0-9_.-]+))/y;
const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) throw new PolicyError(`unexpected character at position ${start + 1}`);
    const [, op, paren, str, word] = m;
    if (op) tokens.push({ t: 'op', v: op as Op });
    else if (paren) tokens.push({ t: 'paren', v: paren as '(' | ')' });
    else if (str) tokens.push({ t: 'string', v: str.slice(1, -1).replace(/\\(.)/g, '$1') });
    else if (word !== undefined && NUMBER.test(word)) tokens.push({ t: 'number', v: Number(word) });
    else tokens.push({ t: 'word', v: word! });
  }
  return tokens;
}

// ---- references ----

const FIELDS: Record<Question['type'], Record<string, Kind>> = {
  noul: { value: 'boolean', p: 'number', yes: 'number' },
  choice: { value: 'string', p: 'number' },
  score: { value: 'number', p: 'number', score: 'number' },
};

/**
 * Fields of each fact type, for rules. Every fact also has `missing`. The
 * lookup result is checked against this table (src/facts.ts).
 */
export const FACT_FIELDS: Record<FactType, Record<string, Kind>> = {
  // Inside an area of a layer; rank and class describe it (for example a
  // flood depth class). Not inside: rank 0, class "".
  inside: { inside: 'boolean', rank: 'number', class: 'string' },
  // The nearest feature of a layer. Not found: found false, no distance or name.
  nearest: { found: 'boolean', distance_m: 'number', name: 'string' },
  // Extra metres around a closed section. No way around: possible false, no
  // extra_m. route: the way around (encoded polyline, precision 6), for
  // people and maps; null when not known.
  detour: { possible: 'boolean', extra_m: 'number', route: 'string' },
};

/** Fields for people and maps, not for rules: a rule cannot refer to them. */
const DISPLAY_FIELDS: Partial<Record<FactType, string[]>> = { detour: ['route'] };

/** Reserved prefix of fact references; no question name may start with it. */
export const FACTS_PREFIX = 'facts.';
/** Reserved prefix of references to required decisions; no question name may start with it. */
export const DECISIONS_PREFIX = 'decisions.';

/** The actions a profile's rules can give. */
export function profileActions(profile: Pick<Profile, 'policy'>): string[] {
  return [...new Set([...(profile.policy.rules ?? []).map((r) => r.action), profile.policy.default])];
}

/** The answers a person may give: people_answers, or the actions without review plus reject. */
export function peopleAnswers(profile: Pick<Profile, 'policy'>): string[] {
  return profile.policy.people_answers ?? [...new Set([...profileActions(profile).filter((a) => a !== 'review'), 'reject'])];
}

/** The actions a person checks: people_check, or [review]. */
export function peopleCheck(profile: Pick<Profile, 'policy'>): string[] {
  return profile.policy.people_check ?? ['review'];
}

const DECISION_FIELDS = { missing: 'boolean', action: 'string', outcome: 'string', reviewed: 'boolean' } as const;

function resolveDecision(word: string, requires: PolicyProfile['requires'], required: RequiredProfiles): Operand {
  const rest = word.slice(DECISIONS_PREFIX.length);
  // Names may contain dots: longest first, as for questions and facts.
  const r = [...(requires ?? [])].sort((a, b) => b.name.length - a.name.length).find((x) => rest.startsWith(`${x.name}.`));
  if (!r) throw new PolicyError(`"${word}" does not refer to a required decision of this profile`);
  const p = Object.hasOwn(required, r.profile) ? required[r.profile] : undefined;
  if (!p) throw new PolicyError(`"${word}": the required profile "${r.profile}" is not known`);
  const field = rest.slice(r.name.length + 1);
  if (field === 'action' || field === 'outcome') {
    const allowed = field === 'action' ? profileActions(p) : [...new Set([...profileActions(p), ...peopleAnswers(p)])];
    return { kind: 'string', decision: r.name, field, path: field, allowed };
  }
  if (field === 'missing' || field === 'reviewed') return { kind: DECISION_FIELDS[field], decision: r.name, field, path: field };
  // An error inside names the whole reference and the required profile.
  const inside = (resolve: () => Operand): Operand => {
    try {
      return resolve();
    } catch (err) {
      if (err instanceof PolicyError) throw new PolicyError(`"${word}" in ${r.profile}: ${err.message.replace('of this profile', `of ${r.profile}`)}`);
      throw err;
    }
  };
  if (field.startsWith('answers.')) {
    const inner = inside(() => resolveReference(field.slice('answers.'.length), p.questions));
    return { kind: inner.kind, decision: r.name, inner: inner as QuestionOperand, path: field };
  }
  if (field.startsWith(FACTS_PREFIX)) {
    const inner = inside(() => resolveFact(field, p.facts ?? []));
    return { kind: inner.kind, decision: r.name, inner: inner as FactOperand, path: field };
  }
  throw new PolicyError(`"${word}": decisions have missing, action, outcome, reviewed, answers.<question>.<field>, facts.<fact>.<field>`);
}

function resolveFact(word: string, facts: FactSpec[]): Operand {
  const rest = word.slice(FACTS_PREFIX.length);
  // Fact names may contain dots too: longest first, as for questions.
  const f = [...facts].sort((a, b) => b.name.length - a.name.length).find((x) => rest.startsWith(`${x.name}.`));
  if (!f) throw new PolicyError(`"${word}" does not refer to a fact of this profile`);
  const field = rest.slice(f.name.length + 1);
  if (field === 'missing') return { kind: 'boolean', fact: f.name, field };
  // Why a fact is missing; unknown when it is not missing.
  if (field === 'reason') return { kind: 'string', fact: f.name, field };
  const display = DISPLAY_FIELDS[f.type] ?? [];
  const kind = Object.hasOwn(FACT_FIELDS[f.type], field) && !display.includes(field) ? FACT_FIELDS[f.type][field] : undefined;
  const fields = Object.keys(FACT_FIELDS[f.type]).filter((x) => !display.includes(x));
  if (!kind) throw new PolicyError(`"${word}": ${f.type} facts have missing, reason, ${fields.join(', ')}`);
  return { kind, fact: f.name, field };
}

function optionsOf(q: Question): string[] | null {
  if (q.type === 'choice') return q.criteria.map((c) => c.value);
  if (q.type === 'score') return q.criteria.map((_, i) => String(i));
  return null;
}

/**
 * Question names may contain dots, so a reference is matched against the
 * profile's question names, longest first.
 */
function resolveReference(word: string, questions: Question[]): Operand {
  const byLength = [...questions].sort((a, b) => b.name.length - a.name.length);
  const q = byLength.find((x) => word.startsWith(`${x.name}.`));
  if (!q) throw new PolicyError(`"${word}" does not refer to a question of this profile`);
  const field = word.slice(q.name.length + 1);
  if (field.startsWith('probabilities.')) {
    const key = field.slice('probabilities.'.length);
    const options = optionsOf(q);
    if (!options) throw new PolicyError(`"${word}": ${q.type} questions have no probabilities`);
    if (!options.includes(key)) throw new PolicyError(`"${word}": "${key}" is not an option of "${q.name}"`);
    return { kind: 'number', question: q.name, field: 'probabilities', key };
  }
  // hasOwn: a field name like "constructor" must not match Object.prototype.
  const kind = Object.hasOwn(FIELDS[q.type], field) ? FIELDS[q.type][field] : undefined;
  if (!kind) {
    throw new PolicyError(
      `"${word}": ${q.type} questions have ${Object.keys(FIELDS[q.type]).join(', ')}${optionsOf(q) ? ', probabilities.<option>' : ''}`,
    );
  }
  return { kind, question: q.name, field };
}

// ---- parser ----

class Parser {
  tokens: Token[];
  questions: Question[];
  facts: FactSpec[];
  requires: PolicyProfile['requires'];
  required: RequiredProfiles;
  pos = 0;

  constructor(tokens: Token[], questions: Question[], facts: FactSpec[], requires: PolicyProfile['requires'] = [], required: RequiredProfiles = {}) {
    this.tokens = tokens;
    this.questions = questions;
    this.facts = facts;
    this.requires = requires;
    this.required = required;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  isWord(v: string): boolean {
    const t = this.peek();
    return t?.t === 'word' && t.v === v;
  }

  parse(): Node {
    if (this.tokens.length === 0) throw new PolicyError('empty condition');
    const node = this.or();
    const rest = this.peek();
    if (rest) throw new PolicyError(`unexpected "${String(rest.v)}"`);
    return node;
  }

  or(): Node {
    let left = this.and();
    while (this.isWord('or')) {
      this.pos++;
      left = { type: 'or', left, right: this.and() };
    }
    return left;
  }

  and(): Node {
    let left = this.not();
    while (this.isWord('and')) {
      this.pos++;
      left = { type: 'and', left, right: this.not() };
    }
    return left;
  }

  not(): Node {
    if (this.isWord('not')) {
      this.pos++;
      return { type: 'not', operand: this.not() };
    }
    const t = this.peek();
    if (t?.t === 'paren' && t.v === '(') {
      this.pos++;
      const node = this.or();
      const close = this.peek();
      if (close?.t !== 'paren' || close.v !== ')') throw new PolicyError('missing ")"');
      this.pos++;
      return node;
    }
    return this.comparison();
  }

  comparison(): Node {
    const left = this.operand();
    const op = this.peek();
    if (op?.t !== 'op') throw new PolicyError('expected a comparison (==, !=, >=, >, <=, <)');
    this.pos++;
    const right = this.operand();
    if ('literal' in left && 'literal' in right) {
      throw new PolicyError('a comparison must refer to a question or a fact');
    }
    if (left.kind !== right.kind) {
      throw new PolicyError(`cannot compare ${left.kind} with ${right.kind}`);
    }
    if (left.kind !== 'number' && op.v !== '==' && op.v !== '!=') {
      throw new PolicyError(`${op.v} works only on numbers`);
    }
    for (const [ref, lit] of [[left, right], [right, left]] as const) {
      if (!('literal' in lit) || ref.kind !== 'string') continue;
      if ('question' in ref) {
        const q = this.questions.find((x) => x.name === ref.question)!;
        if (!optionsOf(q)!.includes(lit.literal as string)) {
          throw new PolicyError(`"${String(lit.literal)}" is not an option of "${q.name}"`);
        }
      }
      const reason = 'fact' in ref ? ref.field === 'reason' : 'inner' in ref && 'fact' in ref.inner && ref.inner.field === 'reason';
      if (reason && !MISSING_REASONS.includes(lit.literal as string)) {
        throw new PolicyError(`"${String(lit.literal)}" is not a reason a fact can be missing (${MISSING_REASONS.join(', ')})`);
      }
      if ('decision' in ref && 'allowed' in ref && ref.allowed && !ref.allowed.includes(lit.literal as string)) {
        throw new PolicyError(`"${String(lit.literal)}" is not an ${ref.field} of decisions.${ref.decision} (${ref.allowed.join(', ')})`);
      }
      if ('decision' in ref && 'inner' in ref && 'question' in ref.inner) {
        const inner = ref.inner;
        const r = this.requires!.find((x) => x.name === ref.decision)!;
        const q = this.required[r.profile]!.questions.find((x) => x.name === inner.question)!;
        if (!optionsOf(q)!.includes(lit.literal as string)) {
          throw new PolicyError(`"${String(lit.literal)}" is not an option of "${q.name}" in ${r.profile}`);
        }
      }
    }
    return { type: 'cmp', op: op.v, left, right };
  }

  operand(): Operand {
    const t = this.peek();
    if (!t) throw new PolicyError('unexpected end of condition');
    this.pos++;
    switch (t.t) {
      case 'number':
        return { kind: 'number', literal: t.v };
      case 'string':
        return { kind: 'string', literal: t.v };
      case 'word':
        if (t.v === 'true' || t.v === 'false') return { kind: 'boolean', literal: t.v === 'true' };
        if (['and', 'or', 'not'].includes(t.v)) throw new PolicyError(`unexpected "${t.v}"`);
        if (t.v.startsWith(DECISIONS_PREFIX)) return resolveDecision(t.v, this.requires, this.required);
        return t.v.startsWith(FACTS_PREFIX) ? resolveFact(t.v, this.facts) : resolveReference(t.v, this.questions);
      default:
        throw new PolicyError(`unexpected "${t.v}"`);
    }
  }
}

// ---- evaluation ----

type Decisions = Record<string, RequiredDecisionInput | undefined>;

/** A required decision's value; undefined = unknown (not given, missing, or of another type). */
function decisionValue(operand: DecisionOperand, decisions: Decisions): Value | undefined {
  const d = Object.hasOwn(decisions, operand.decision) ? decisions[operand.decision] : undefined;
  if ('field' in operand && operand.field === 'missing') return !d;
  if (!d) return undefined;
  let v: Value | undefined;
  if ('inner' in operand) {
    try {
      v = valueOf(operand.inner, d.answers ?? {}, d.facts ?? {}, {});
    } catch (err) {
      // An answer that decision does not have (an older version of its profile).
      if (err instanceof PolicyError) return undefined;
      throw err;
    }
  } else {
    // missing was answered above; the other fields are on the decision.
    v = d[operand.field as 'action' | 'outcome' | 'reviewed'];
  }
  return typeof v === operand.kind ? v : undefined;
}

/** undefined = unknown (a missing fact, or a fact field without a value). */
function valueOf(operand: Operand, answers: Record<string, Answer>, facts: Record<string, Fact>, decisions: Decisions): Value | undefined {
  if ('literal' in operand) return operand.literal;
  if ('decision' in operand) return decisionValue(operand, decisions);
  if ('fact' in operand) {
    const f = facts[operand.fact];
    if (!f) return operand.field === 'missing' ? true : undefined; // never looked up
    if (operand.field === 'missing') return f.missing;
    if (operand.field === 'reason') return f.missing ? f.reason : undefined;
    if (f.missing) return undefined;
    const v = Object.hasOwn(f.values, operand.field) ? f.values[operand.field] : undefined;
    return v === null ? undefined : v;
  }
  const a = answers[operand.question];
  if (!a) throw new PolicyError(`no answer for "${operand.question}"`);
  if (operand.field === 'probabilities') {
    // hasOwn: an option named like an Object.prototype member ("constructor")
    // that the model left out reads as 0, not as an inherited function.
    if (!('probabilities' in a) || !Object.hasOwn(a.probabilities, operand.key!)) return 0;
    return a.probabilities[operand.key!]!;
  }
  return (a as unknown as Record<string, Value>)[operand.field]!;
}

/** true, false, or null for unknown (three-valued logic, see the top of the file). */
function evaluate(node: Node, answers: Record<string, Answer>, facts: Record<string, Fact>, decisions: Decisions): boolean | null {
  switch (node.type) {
    case 'and': {
      const l = evaluate(node.left, answers, facts, decisions);
      if (l === false) return false;
      const r = evaluate(node.right, answers, facts, decisions);
      if (r === false) return false;
      return l === true && r === true ? true : null;
    }
    case 'or': {
      const l = evaluate(node.left, answers, facts, decisions);
      if (l === true) return true;
      const r = evaluate(node.right, answers, facts, decisions);
      if (r === true) return true;
      return l === false && r === false ? false : null;
    }
    case 'not': {
      const v = evaluate(node.operand, answers, facts, decisions);
      return v === null ? null : !v;
    }
    case 'cmp': {
      const l = valueOf(node.left, answers, facts, decisions);
      const r = valueOf(node.right, answers, facts, decisions);
      if (l === undefined || r === undefined) return null;
      if (node.op === '==') return l === r;
      if (node.op === '!=') return l !== r;
      // The parser allows ordering only between numbers (see comparison()).
      const a = l as number;
      const b = r as number;
      switch (node.op) {
        case '>=': return a >= b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '<': return a < b;
      }
    }
  }
}

// ---- public API ----

export interface CompiledPolicy {
  /**
   * The action, and the index of the matching rule (null = default). A rule
   * matches only when its condition is true, not when it is unknown.
   */
  decide(answers: Record<string, Answer>, facts?: Record<string, Fact>, decisions?: Decisions): { action: string; rule: number | null };
  /**
   * Every value the rules read from required decisions, by decision name and
   * path (for example "outcome", "answers.danger.yes"); null = unknown. Kept
   * with the decision, so the log explains the result later.
   */
  read(decisions: Decisions): Record<string, Record<string, Value | null>>;
}

/** Compile one condition; throws PolicyError with a readable message. */
export function compileCondition(condition: string, questions: Question[], facts: FactSpec[] = [], requires: PolicyProfile['requires'] = [], required: RequiredProfiles = {}): Node {
  return new Parser(tokenize(condition), questions, facts, requires, required).parse();
}

function decisionOperands(node: Node, out: DecisionOperand[]): DecisionOperand[] {
  if (node.type === 'not') return decisionOperands(node.operand, out);
  if (node.type === 'and' || node.type === 'or') return decisionOperands(node.right, decisionOperands(node.left, out));
  for (const o of [node.left, node.right]) if ('decision' in o) out.push(o);
  return out;
}

/** Compile all rules of a profile. Throws PolicyError naming the rule. */
export function compilePolicy(profile: PolicyProfile, required: RequiredProfiles = {}): CompiledPolicy {
  const rules = (profile.policy.rules ?? []).map((rule, i) => {
    try {
      return { action: rule.action, when: compileCondition(rule.when, profile.questions, profile.facts, profile.requires, required) };
    } catch (err) {
      if (err instanceof PolicyError) throw new PolicyError(`rule ${i}: ${err.message}`);
      throw err;
    }
  });
  const reads = rules.flatMap((r) => decisionOperands(r.when, []));
  return {
    decide(answers, facts = {}, decisions = {}) {
      for (const [i, rule] of rules.entries()) {
        if (evaluate(rule.when, answers, facts, decisions) === true) return { action: rule.action, rule: i };
      }
      return { action: profile.policy.default, rule: null };
    },
    read(decisions) {
      const out: Record<string, Record<string, Value | null>> = {};
      for (const o of reads) {
        (out[o.decision] ??= {})[o.path] = decisionValue(o, decisions) ?? null;
      }
      return out;
    },
  };
}

/** Validation errors for all rules, as [rule index, message]. */
export function policyErrors(profile: PolicyProfile, required: RequiredProfiles = {}): [number, string][] {
  const errors: [number, string][] = [];
  for (const [i, rule] of (profile.policy.rules ?? []).entries()) {
    try {
      compileCondition(rule.when, profile.questions, profile.facts, profile.requires, required);
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      errors.push([i, err.message]);
    }
  }
  return errors;
}
