// Policy rules: a small condition language over the answers, without eval.
//
//   condition  := or
//   or         := and ("or" and)*
//   and        := not ("and" not)*
//   not        := "not" not | "(" or ")" | comparison
//   comparison := operand ("==" | "!=" | ">=" | ">" | "<=" | "<") operand
//   operand    := reference | number | string | true | false
//   reference  := <question name> "." field | "facts." <fact name> "." fact field
//   field      := value | p | yes | score | probabilities.<option or level>
//   fact field := missing, or a field of the fact's type (FACT_FIELDS)
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
// This file is also imported by the profile validator under Node.js, so it
// uses only TypeScript syntax that Node can strip (no enums, no parameter
// properties) and imports types only.

import type { Answer, Fact, FactSpec, FactType, Profile, Question } from './types';

type Kind = 'number' | 'string' | 'boolean';
type Value = number | string | boolean;
type Op = '==' | '!=' | '>=' | '>' | '<=' | '<';

type Operand =
  | { kind: Kind; literal: Value }
  | { kind: Kind; question: string; field: string; key?: string }
  | { kind: Kind; fact: string; field: string };

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
  // Extra metres around a closed section. No way around: possible false, no extra_m.
  detour: { possible: 'boolean', extra_m: 'number' },
};

/** Reserved prefix of fact references; no question name may start with it. */
export const FACTS_PREFIX = 'facts.';

function resolveFact(word: string, facts: FactSpec[]): Operand {
  const rest = word.slice(FACTS_PREFIX.length);
  // Fact names may contain dots too: longest first, as for questions.
  const f = [...facts].sort((a, b) => b.name.length - a.name.length).find((x) => rest.startsWith(`${x.name}.`));
  if (!f) throw new PolicyError(`"${word}" does not refer to a fact of this profile`);
  const field = rest.slice(f.name.length + 1);
  if (field === 'missing') return { kind: 'boolean', fact: f.name, field };
  const kind = Object.hasOwn(FACT_FIELDS[f.type], field) ? FACT_FIELDS[f.type][field] : undefined;
  if (!kind) throw new PolicyError(`"${word}": ${f.type} facts have missing, ${Object.keys(FACT_FIELDS[f.type]).join(', ')}`);
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
  pos = 0;

  constructor(tokens: Token[], questions: Question[], facts: FactSpec[]) {
    this.tokens = tokens;
    this.questions = questions;
    this.facts = facts;
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
      if ('question' in ref && ref.kind === 'string' && 'literal' in lit) {
        const q = this.questions.find((x) => x.name === ref.question)!;
        if (!optionsOf(q)!.includes(lit.literal as string)) {
          throw new PolicyError(`"${String(lit.literal)}" is not an option of "${q.name}"`);
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
        return t.v.startsWith(FACTS_PREFIX) ? resolveFact(t.v, this.facts) : resolveReference(t.v, this.questions);
      default:
        throw new PolicyError(`unexpected "${t.v}"`);
    }
  }
}

// ---- evaluation ----

/** undefined = unknown (a missing fact, or a fact field without a value). */
function valueOf(operand: Operand, answers: Record<string, Answer>, facts: Record<string, Fact>): Value | undefined {
  if ('literal' in operand) return operand.literal;
  if ('fact' in operand) {
    const f = facts[operand.fact];
    if (!f) return operand.field === 'missing' ? true : undefined; // never looked up
    if (operand.field === 'missing') return f.missing;
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
function evaluate(node: Node, answers: Record<string, Answer>, facts: Record<string, Fact>): boolean | null {
  switch (node.type) {
    case 'and': {
      const l = evaluate(node.left, answers, facts);
      if (l === false) return false;
      const r = evaluate(node.right, answers, facts);
      if (r === false) return false;
      return l === true && r === true ? true : null;
    }
    case 'or': {
      const l = evaluate(node.left, answers, facts);
      if (l === true) return true;
      const r = evaluate(node.right, answers, facts);
      if (r === true) return true;
      return l === false && r === false ? false : null;
    }
    case 'not': {
      const v = evaluate(node.operand, answers, facts);
      return v === null ? null : !v;
    }
    case 'cmp': {
      const l = valueOf(node.left, answers, facts);
      const r = valueOf(node.right, answers, facts);
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
  decide(answers: Record<string, Answer>, facts?: Record<string, Fact>): { action: string; rule: number | null };
}

/** Compile one condition; throws PolicyError with a readable message. */
export function compileCondition(condition: string, questions: Question[], facts: FactSpec[] = []): Node {
  return new Parser(tokenize(condition), questions, facts).parse();
}

/** Compile all rules of a profile. Throws PolicyError naming the rule. */
export function compilePolicy(profile: Pick<Profile, 'questions' | 'policy' | 'facts'>): CompiledPolicy {
  const rules = (profile.policy.rules ?? []).map((rule, i) => {
    try {
      return { action: rule.action, when: compileCondition(rule.when, profile.questions, profile.facts) };
    } catch (err) {
      if (err instanceof PolicyError) throw new PolicyError(`rule ${i}: ${err.message}`);
      throw err;
    }
  });
  return {
    decide(answers, facts = {}) {
      for (const [i, rule] of rules.entries()) {
        if (evaluate(rule.when, answers, facts) === true) return { action: rule.action, rule: i };
      }
      return { action: profile.policy.default, rule: null };
    },
  };
}

/** Validation errors for all rules, as [rule index, message]. */
export function policyErrors(profile: Pick<Profile, 'questions' | 'policy' | 'facts'>): [number, string][] {
  const errors: [number, string][] = [];
  for (const [i, rule] of (profile.policy.rules ?? []).entries()) {
    try {
      compileCondition(rule.when, profile.questions, profile.facts);
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      errors.push([i, err.message]);
    }
  }
  return errors;
}
