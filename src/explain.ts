// A profile in plain sentences, in English or Japanese, for the people who
// approve it (docs/profile-format.md#explain). The rules are compiled with the
// engine's own parser, so the sentences say what the engine does, not what a
// comment says.
//
// Like src/policy.ts, this file is also imported by a script under Node.js
// (scripts/explain-profile.mjs), so it uses only TypeScript syntax that Node
// can strip, and imports policy.ts with its extension.

import { compileCondition, peopleAnswers, peopleCheck, PolicyError, profileActions } from './policy.ts';
import type { DecisionOperand, FactOperand, Node, Op, Operand, QuestionOperand, RequiredProfiles, Value } from './policy.ts';
import type { FactSpec, Profile, Question } from './types.ts';

export type Lang = 'en' | 'ja';

export interface Explanation {
  profile: string;
  version: number;
  lang: Lang;
  title: string;
  description: string;
  /** Which model answers, or that no model is asked. */
  model: string;
  /** What the model sees of the request. */
  input: string;
  questions: string[];
  facts: string[];
  requires: string[];
  /** One sentence per rule, in order; `rule` is the index the decision log uses. */
  rules: { rule: number; when: string; action: string; text: string }[];
  /** How rules are checked, and the action when none matches. */
  order: string;
  default: string;
  /** Which actions a person checks, and how they can answer. */
  people: string[];
  notes: string[];
}

// ---- words ----

/** A half-width space between Japanese and an ASCII word, none next to full-width brackets. */
function jaSpace(word: string, before: boolean): string {
  return /[\x21-\x7e]/.test(before ? word.charAt(0) : word.charAt(word.length - 1)) ? ' ' : '';
}

const W = {
  en: {
    model: (m: string, f: string[]) => `The AI model ${m} answers the questions${f.length ? ` (if it fails: ${f.join(', then ')})` : ''}.`,
    noModel: 'No AI is asked: this profile decides with rules only.',
    input: (parts: string[]) => `The AI sees these parts of the request: ${parts.join(', ')}.`,
    inputPart: (name: string, path: string) => `${name} (${path})`,
    heading: (title: string, id: string, v: number) => `${title} (${id}, v${v})`,
    join: ' ',
    wholeInput: 'The AI sees the whole request.',
    noInput: 'No AI is asked, so no part of the request is sent to a model.',
    noul: (q: string, i: string) => `${q} (yes or no): ${i}`,
    yesMeans: (t: string) => `Yes means: ${t}`,
    noMeans: (t: string) => `No means: ${t}`,
    choice: (q: string, n: number, i: string) => `${q} (one of ${n} options): ${i}`,
    options: (o: string[]) => `Options: ${o.join('; ')}.`,
    score: (q: string, max: number, i: string) => `${q} (a level from 0 to ${max}): ${i}`,
    levels: (l: string[]) => `Levels: ${l.join('; ')}.`,
    inside: (f: string, layer: string, at: string) => `${f}: whether the place (${at}) is inside an area of the layer "${layer}", with the area's rank and class.`,
    nearest: (f: string, layer: string, at: string) => `${f}: the nearest feature of the layer "${layer}" to the place (${at}), with its distance and name.`,
    detour: (f: string, mode: string, at: string, route: boolean) =>
      `${f}: how much longer the way around the closed section (${at}) is ${mode}${route ? '; the way itself is kept for people and maps' : ''}.`,
    byCar: 'by car',
    onFoot: 'on foot',
    factsHidden: 'The AI does not see facts; only the rules use them.',
    requires: (n: string, p: string | undefined, optional: boolean) =>
      `${n}: an earlier decision ${p === undefined ? 'of another profile' : `of the profile "${p}"`} about the same thing${optional ? ' (may be missing)' : ''}.`,
    rule: (cond: string, action: string) => `If ${cond}, the action is ${action}.`,
    order: 'The rules are checked in this order; the first one that matches gives the action.',
    noRules: 'This profile has no rules.',
    default: (a: string) => `If no rule matches, the action is ${a}.`,
    check: (a: string[]) => `A person checks these actions before they count: ${a.join(', ')}.`,
    answers: (a: string[]) => `The person answers with one of: ${a.join(', ')}.`,
    unknown: 'When a fact or an earlier decision is missing, comparisons with its values are unknown. A rule matches only when its condition is certainly true, so a missing value never makes a rule match by itself; only a check whether something is missing (and why) can.',
    asWritten: 'The question texts are shown as they are written in the profile.',
    outcome: 'The outcome of an earlier decision is the person\'s answer when a person checked it, otherwise its action.',
    corrected: 'The answers of an earlier decision are a person\'s corrected answers when a person corrected them, otherwise the AI\'s.',
    unreadable: (when: string, msg: string) => `this condition, which could not be read (${msg}): ${when}`,
    hidden: (when: string) => `this condition on an earlier decision that is not shown here: ${when}`,
    // conditions
    q: (name: string) => `"${name}"`,
    is: (s: string, v: string) => `${s} is ${v}`,
    isNot: (s: string, v: string) => `${s} is not ${v}`,
    cmp: { '>=': 'at least', '>': 'more than', '<=': 'at most', '<': 'less than' } as Record<string, string>,
    yes: 'yes',
    no: 'no',
    probYes: (q: string) => `the probability that ${q} is yes`,
    probOption: (q: string, o: string) => `the probability that ${q} is ${o}`,
    sure: (q: string) => `the AI's certainty about ${q}`,
    level: (q: string) => `the most likely level of ${q}`,
    weighted: (q: string) => `the weighted level of ${q}`,
    levelName: (n: number, name: string) => `${n} ("${name}")`,
    orHigher: (v: string) => `${v} or higher`,
    orLower: (v: string) => `${v} or lower`,
    above: (v: string) => `above ${v}`,
    below: (v: string) => `below ${v}`,
    factMissing: (f: string, missing: boolean) => (missing ? `the fact ${f} is missing` : `the fact ${f} was found`),
    factReason: (f: string) => `the reason the fact ${f} is missing`,
    reasons: { no_location: 'no location in the request', unavailable: 'the data is not available', timeout: 'the lookup took too long', error: 'an error' } as Record<string, string>,
    inArea: (f: string, yes: boolean) => (yes ? `the place is inside ${f}` : `the place is not inside ${f}`),
    rank: (f: string) => `the rank of ${f}`,
    class: (f: string) => `the class of ${f}`,
    found: (f: string, yes: boolean) => (yes ? `a nearest ${f} was found` : `no nearest ${f} was found`),
    distance: (f: string) => `the distance to the nearest ${f}`,
    name: (f: string) => `the name of the nearest ${f}`,
    possible: (f: string, yes: boolean) => (yes ? `there is a way around (${f})` : `there is no way around (${f})`),
    extra: (f: string) => `the extra distance of the way around (${f})`,
    decMissing: (d: string, missing: boolean) => (missing ? `the earlier decision ${d} is missing` : `the earlier decision ${d} exists`),
    decAction: (d: string) => `the action of the earlier decision ${d}`,
    decOutcome: (d: string) => `the outcome of the earlier decision ${d}`,
    decReviewed: (d: string, yes: boolean) => (yes ? `a person checked the earlier decision ${d}` : `no person checked the earlier decision ${d}`),
    inDecision: (text: string, d: string) => `${text} (in the earlier decision ${d})`,
    and: ' and ',
    or: ' or ',
    not: (s: string) => `not (${s})`,
    group: (s: string) => `(${s})`,
    gloss: (v: string, g: string) => `${v} (${g})`,
  },
  ja: {
    model: (m: string, f: string[]) => `質問には AI モデル ${m} が答えます${f.length ? `（失敗したときは ${f.join('、次に ')}）` : ''}。`,
    noModel: 'AI は使いません。このプロファイルはルールだけで決めます。',
    input: (parts: string[]) => `AI が見るのは、リクエストの次の部分です：${parts.join('、')}。`,
    inputPart: (name: string, path: string) => `${name}（${path}）`,
    heading: (title: string, id: string, v: number) => `${title}（${id}、v${v}）`,
    join: '',
    wholeInput: 'AI はリクエスト全体を見ます。',
    noInput: 'AI を使わないので、リクエストはモデルに送られません。',
    noul: (q: string, i: string) => `${q}（はい／いいえ）：${i}`,
    yesMeans: (t: string) => `はい：${t}`,
    noMeans: (t: string) => `いいえ：${t}`,
    choice: (q: string, n: number, i: string) => `${q}（${n} 個の選択肢から 1 つ）：${i}`,
    options: (o: string[]) => `選択肢：${o.join('、')}。`,
    score: (q: string, max: number, i: string) => `${q}（レベル 0〜${max}）：${i}`,
    levels: (l: string[]) => `レベル：${l.join('、')}。`,
    inside: (f: string, layer: string, at: string) => `${f}：場所（${at}）がレイヤー「${layer}」の範囲内かどうかと、その範囲のランクと区分。`,
    nearest: (f: string, layer: string, at: string) => `${f}：場所（${at}）から最も近い、レイヤー「${layer}」の地物と、その距離と名前。`,
    detour: (f: string, mode: string, at: string, route: boolean) =>
      `${f}：通れない区間（${at}）を${mode}避けると、どれだけ遠回りになるか${route ? '。迂回路そのものも、人と地図のために残します' : ''}。`,
    byCar: '車で',
    onFoot: '歩いて',
    factsHidden: 'AI は事実を見ません。事実を使うのはルールだけです。',
    requires: (n: string, p: string | undefined, optional: boolean) =>
      `${n}：同じものについての、${p === undefined ? '別のプロファイル' : `プロファイル「${p}」`}の前の判定${optional ? '（なくてもかまいません）' : ''}。`,
    rule: (cond: string, action: string) => `${cond}${/[\x21-\x7e]$/.test(cond) ? ' ' : ''}なら、アクションは ${action} です。`,
    order: 'ルールは上から順に確かめ、最初に当てはまったルールでアクションが決まります。',
    noRules: 'このプロファイルにはルールがありません。',
    default: (a: string) => `どのルールにも当てはまらなければ、アクションは ${a} です。`,
    check: (a: string[]) => `次のアクションは、人が確認してから有効になります：${a.join('、')}。`,
    answers: (a: string[]) => `人は次のどれかで答えます：${a.join('、')}。`,
    unknown: '事実や前の判定が欠けているとき、その値との比較は「不明」になります。ルールは条件が確かに成り立つときだけ当てはまるので、欠けた値だけでルールが当てはまることはありません。当てはまるのは、欠けているかどうか（とその理由）を確かめる条件だけです。',
    asWritten: '質問の文は、プロファイルに書かれたとおりに示します。',
    outcome: '前の判定の結果は、人が確認した場合はその人の答え、そうでなければその判定のアクションです。',
    corrected: '前の判定の答えは、人が直した場合はその答え、そうでなければ AI の答えです。',
    unreadable: (when: string, msg: string) => `読めなかった条件（${msg}）：${when} `,
    hidden: (when: string) => `ここでは示さない前の判定についての条件：${when} `,
    q: (name: string) => `「${name}」`,
    is: (s: string, v: string) => `${s}が${jaSpace(v, true)}${v}`,
    isNot: (s: string, v: string) => `${s}が${jaSpace(v, true)}${v}${jaSpace(v, false)}以外`,
    cmp: { '>=': '以上', '>': 'を超える', '<=': '以下', '<': '未満' } as Record<string, string>,
    yes: '「はい」',
    no: '「いいえ」',
    probYes: (q: string) => `${q}が「はい」である確率`,
    probOption: (q: string, o: string) => `${q}が${jaSpace(o, true)}${o}${jaSpace(o, false)}である確率`,
    sure: (q: string) => `${q}についての AI の確信度`,
    level: (q: string) => `${q}で最も可能性が高いレベル`,
    weighted: (q: string) => `${q}の加重平均のレベル`,
    levelName: (n: number, name: string) => `${n}（${name}）`,
    orHigher: (v: string) => `${v}${jaSpace(v, false)}以上`,
    orLower: (v: string) => `${v}${jaSpace(v, false)}以下`,
    above: (v: string) => `${v}${jaSpace(v, false)}を超える`,
    below: (v: string) => `${v}${jaSpace(v, false)}未満`,
    factMissing: (f: string, missing: boolean) => (missing ? `事実${f}が得られない` : `事実${f}が得られた`),
    factReason: (f: string) => `事実${f}が得られない理由`,
    reasons: { no_location: 'リクエストに位置がない', unavailable: 'データが使えない', timeout: '調べるのに時間がかかりすぎた', error: 'エラー' } as Record<string, string>,
    inArea: (f: string, yes: boolean) => (yes ? `場所が${f}の範囲内` : `場所が${f}の範囲外`),
    rank: (f: string) => `${f}のランク`,
    class: (f: string) => `${f}の区分`,
    found: (f: string, yes: boolean) => (yes ? `最寄りの${f}が見つかった` : `最寄りの${f}が見つからない`),
    distance: (f: string) => `最寄りの${f}までの距離`,
    name: (f: string) => `最寄りの${f}の名前`,
    possible: (f: string, yes: boolean) => (yes ? `迂回路（${f}）がある` : `迂回路（${f}）がない`),
    extra: (f: string) => `迂回路（${f}）で遠回りになる距離`,
    decMissing: (d: string, missing: boolean) => (missing ? `前の判定${d}がない` : `前の判定${d}がある`),
    decAction: (d: string) => `前の判定${d}のアクション`,
    decOutcome: (d: string) => `前の判定${d}の結果`,
    decReviewed: (d: string, yes: boolean) => (yes ? `前の判定${d}を人が確認した` : `前の判定${d}を人が確認していない`),
    inDecision: (text: string, d: string) => `前の判定${d}の${text}`,
    and: '、かつ',
    or: '、または',
    not: (s: string) => `（${s}）ではない`,
    group: (s: string) => `（${s}）`,
    gloss: (v: string, g: string) => `${v}（${g}）`,
  },
};

type Words = (typeof W)['en'];

// ---- conditions ----

const PROBABILITY_FIELDS = new Set(['p', 'yes', 'probabilities']);

function num(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

function percent(v: number): string {
  return `${Math.round(v * 1000) / 10} %`;
}

/** The comparison with the reference on the left: `0.7 <= x` becomes `x >= 0.7`. */
const FLIP: Record<Op, Op> = { '==': '==', '!=': '!=', '>=': '<=', '>': '<', '<=': '>=', '<': '>' };

interface Ctx {
  w: Words;
  questions: Question[];
  facts: FactSpec[];
  /** For rules on earlier decisions: the required profile's questions and facts, by the name in requires. */
  inner?: Record<string, Ctx>;
}

/** A sentence for one comparison between a reference and a literal. */
function sentence(ref: Operand, op: Op, lit: Value, ctx: Ctx): string {
  if ('decision' in ref) return decisionSentence(ref, op, lit, ctx);
  if ('fact' in ref) return factSentence(ref, op, lit, ctx);
  return questionSentence(ref as QuestionOperand, op, lit, ctx);
}

/** A numeric comparison: "<subject> is at least 70 %". */
function numeric(subject: string, op: Op, value: string, w: Words): string {
  if (op === '==') return w.is(subject, value);
  if (op === '!=') return w.isNot(subject, value);
  return w === W.ja ? `${subject}が ${value} ${w.cmp[op]}` : `${subject} is ${w.cmp[op]} ${value}`;
}

/** true for `== true` and `!= false`. */
function truth(op: Op, lit: Value): boolean {
  return op === '==' ? lit === true : lit === false;
}

function quoted(v: Value, w: Words): string {
  return w === W.ja ? `「${String(v)}」` : `"${String(v)}"`;
}

function questionSentence(ref: QuestionOperand, op: Op, lit: Value, ctx: Ctx): string {
  const { w } = ctx;
  const q = ctx.questions.find((x) => x.name === ref.question);
  const name = w.q(ref.question);
  if (ref.field === 'value' && q?.type === 'noul') return w.is(name, truth(op, lit) ? w.yes : w.no);
  if (ref.field === 'value' && q?.type === 'choice') return (op === '==' ? w.is : w.isNot)(name, quoted(lit, w));
  if (ref.field === 'yes') return numeric(w.probYes(name), op, percent(lit as number), w);
  if (ref.field === 'p') return numeric(w.sure(name), op, percent(lit as number), w);
  if (ref.field === 'probabilities') {
    const option = q?.type === 'score' ? levelOf(q, Number(ref.key), w) : quoted(ref.key!, w);
    return numeric(w.probOption(name, option), op, percent(lit as number), w);
  }
  if (ref.field === 'value' && q?.type === 'score') return levelSentence(w.level(name), op, lit as number, q, w);
  if (ref.field === 'score') return numeric(w.weighted(name), op, num(lit as number), w);
  return numeric(name, op, String(lit), w);
}

function levelOf(q: Question, n: number, w: Words): string {
  const label = q.type === 'score' ? q.criteria[n] : undefined;
  return label === undefined ? String(n) : w.levelName(n, label);
}

/** Score levels by name: "level 2 ("Clear enough") or higher". */
function levelSentence(subject: string, op: Op, n: number, q: Question, w: Words): string {
  const at = Number.isInteger(n) ? levelOf(q, n, w) : num(n);
  const words: Record<Op, (v: string) => string> = {
    '==': (v) => v, '!=': (v) => v, '>=': w.orHigher, '<=': w.orLower, '>': w.above, '<': w.below,
  };
  if (op === '==') return w.is(subject, at);
  if (op === '!=') return w.isNot(subject, at);
  return w === W.ja ? `${subject}が ${words[op](at)}` : `${subject} is ${words[op](at)}`;
}

function factSentence(ref: FactOperand, op: Op, lit: Value, ctx: Ctx): string {
  const { w } = ctx;
  const name = w.q(ref.fact);
  const spec = ctx.facts.find((f) => f.name === ref.fact);
  if (ref.field === 'missing') return w.factMissing(name, truth(op, lit));
  if (ref.field === 'reason') {
    const gloss = Object.hasOwn(w.reasons, String(lit)) ? w.reasons[String(lit)] : undefined;
    return (op === '==' ? w.is : w.isNot)(w.factReason(name), gloss ? w.gloss(String(lit), gloss) : String(lit));
  }
  switch (spec?.type) {
    case 'inside':
      if (ref.field === 'inside') return w.inArea(name, truth(op, lit));
      if (ref.field === 'rank') return numeric(w.rank(name), op, num(lit as number), w);
      if (ref.field === 'class') return (op === '==' ? w.is : w.isNot)(w.class(name), quoted(lit, w));
      break;
    case 'nearest':
      if (ref.field === 'found') return w.found(name, truth(op, lit));
      if (ref.field === 'distance_m') return numeric(w.distance(name), op, `${num(lit as number)} m`, w);
      if (ref.field === 'name') return (op === '==' ? w.is : w.isNot)(w.name(name), quoted(lit, w));
      break;
    case 'detour':
      if (ref.field === 'possible') return w.possible(name, truth(op, lit));
      if (ref.field === 'extra_m') return numeric(w.extra(name), op, `${num(lit as number)} m`, w);
      break;
  }
  return numeric(`${name}.${ref.field}`, op, String(lit), w);
}

function decisionSentence(ref: DecisionOperand, op: Op, lit: Value, ctx: Ctx): string {
  const { w } = ctx;
  const name = w.q(ref.decision);
  if ('inner' in ref) {
    // A question or fact of the required profile: its sentence, said to be about that decision.
    const inner = ctx.inner?.[ref.decision] ?? { w, questions: [], facts: [] };
    return w.inDecision(sentence(ref.inner, op, lit, inner), name);
  }
  if (ref.field === 'missing') return w.decMissing(name, truth(op, lit));
  if (ref.field === 'reviewed') return w.decReviewed(name, truth(op, lit));
  const subject = ref.field === 'action' ? w.decAction(name) : w.decOutcome(name);
  return (op === '==' ? w.is : w.isNot)(subject, String(lit));
}

function operandText(o: Operand, ctx: Ctx): string {
  const { w } = ctx;
  if ('literal' in o) return String(o.literal);
  if ('decision' in o) return `${w.q(o.decision)}.${o.path}`;
  if ('fact' in o) return `${w.q(o.fact)}.${o.field}`;
  return `${w.q(o.question)}.${o.field}${o.key !== undefined ? `.${o.key}` : ''}`;
}

function conditionText(node: Node, ctx: Ctx, parent?: Node['type']): string {
  const { w } = ctx;
  switch (node.type) {
    case 'and':
    case 'or': {
      const text = conditionText(node.left, ctx, node.type) + w[node.type] + conditionText(node.right, ctx, node.type);
      // Brackets only where and and or meet: "a and b or c" is read as (a and b) or c.
      return parent && parent !== node.type && parent !== 'not' ? w.group(text) : text;
    }
    case 'not':
      return w.not(conditionText(node.operand, ctx, 'not'));
    case 'cmp': {
      const { left, right } = node;
      if ('literal' in right && !('literal' in left)) return sentence(left, node.op, right.literal, ctx);
      if ('literal' in left && !('literal' in right)) return sentence(right, FLIP[node.op], left.literal, ctx);
      // Two references: plain, with the operator.
      return `${operandText(left, ctx)} ${node.op} ${operandText(right, ctx)}`;
    }
  }
}

// ---- the profile ----

function questionText(q: Question, w: Words): string {
  const name = w.q(q.name);
  switch (q.type) {
    case 'noul': {
      const parts = [w.noul(name, q.instructions)];
      if (q.criteria?.true) parts.push(w.yesMeans(q.criteria.true));
      if (q.criteria?.false) parts.push(w.noMeans(q.criteria.false));
      return parts.join(' ');
    }
    case 'choice':
      return `${w.choice(name, q.criteria.length, q.instructions)} ${w.options(q.criteria.map((c) => (c.description ? `${c.value} (${c.description})` : c.value)))}`;
    case 'score':
      return `${w.score(name, q.criteria.length - 1, q.instructions)} ${w.levels(q.criteria.map((c, i) => `${i} ${c}`))}`;
  }
}

function factText(f: FactSpec, w: Words): string {
  const name = w.q(f.name);
  switch (f.type) {
    case 'inside':
      return w.inside(name, f.layer ?? '', f.at);
    case 'nearest':
      return w.nearest(name, f.layer ?? '', f.at);
    case 'detour':
      return w.detour(name, f.mode === 'walk' ? w.onFoot : w.byCar, f.at, f.route === true);
  }
}

/**
 * Explain a profile. `required` holds the profiles it requires, by id, so that
 * rules reading earlier decisions can be put in words. Leave out the ones the
 * reader may not see: they are not named, and a rule that reads them (or any
 * rule that cannot be compiled) is shown as written, with the reason.
 */
export function explainProfile(profile: Profile, lang: Lang, required: Record<string, Profile | undefined> = {}): Explanation {
  const w: Words = W[lang];
  const ctx: Ctx = {
    w,
    questions: profile.questions,
    facts: profile.facts ?? [],
    inner: Object.fromEntries((profile.requires ?? []).map((r) => {
      const p = Object.hasOwn(required, r.profile) ? required[r.profile] : undefined;
      return [r.name, { w, questions: p?.questions ?? [], facts: p?.facts ?? [] }];
    })),
  };
  const policyRequired: RequiredProfiles = required;
  const asksModel = profile.questions.length > 0;

  // Rules on a required profile that was not given are not compiled: the
  // parser's message would name that profile.
  // Each decisions.<name>. reference is matched like the parser does: the
  // longest name first, since names may contain dots.
  const names = [...(profile.requires ?? [])].sort((a, b) => b.name.length - a.name.length);
  const readsHidden = (when: string) => [...when.matchAll(/decisions\.[A-Za-z0-9_.-]+/g)].some(([word]) => {
    const r = names.find((x) => word.startsWith(`decisions.${x.name}.`));
    return r !== undefined && !(Object.hasOwn(required, r.profile) && required[r.profile]);
  });
  const rules = (profile.policy.rules ?? []).map((r, i) => {
    let when: string;
    if (readsHidden(r.when)) return { rule: i, when: r.when, action: r.action, text: w.rule(w.hidden(r.when), r.action) };
    try {
      when = conditionText(compileCondition(r.when, profile.questions, profile.facts, profile.requires, policyRequired), ctx);
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      when = w.unreadable(r.when, err.message);
    }
    return { rule: i, when: r.when, action: r.action, text: w.rule(when, r.action) };
  });

  const people: string[] = [];
  const checked = peopleCheck(profile).filter((a) => profileActions(profile).includes(a));
  if (checked.length) people.push(w.check(checked), w.answers(peopleAnswers(profile)));

  const notes: string[] = [];
  if (asksModel) notes.push(w.asWritten);
  if (profile.facts?.length) notes.push(w.factsHidden);
  if (profile.facts?.length || profile.requires?.length) notes.push(w.unknown);
  if ((profile.policy.rules ?? []).some((r) => /\bdecisions\.\S+\.outcome\b/.test(r.when))) notes.push(w.outcome);
  if ((profile.policy.rules ?? []).some((r) => /\bdecisions\.\S+\.answers\./.test(r.when))) notes.push(w.corrected);

  return {
    profile: profile.id,
    version: profile.version,
    lang,
    title: profile.title[lang],
    description: profile.description[lang],
    model: asksModel ? w.model(profile.model, profile.fallback_models ?? []) : w.noModel,
    input: !asksModel ? w.noInput : profile.input?.length ? w.input(profile.input.map((i) => w.inputPart(i.name, i.path))) : w.wholeInput,
    questions: profile.questions.map((q) => questionText(q, w)),
    facts: (profile.facts ?? []).map((f) => factText(f, w)),
    // A required profile is named only when it was given: the caller may not be allowed to see it.
    requires: (profile.requires ?? []).map((r) => w.requires(w.q(r.name), Object.hasOwn(required, r.profile) && required[r.profile] ? r.profile : undefined, r.optional === true)),
    rules,
    order: rules.length ? w.order : w.noRules,
    default: w.default(profile.policy.default),
    people,
    notes,
  };
}

const HEADINGS = {
  en: { questions: 'Questions for the AI', facts: 'Facts', requires: 'Earlier decisions', rules: 'Rules', people: 'People', notes: 'Notes' },
  ja: { questions: 'AI への質問', facts: '事実', requires: '前の判定', rules: 'ルール', people: '人の確認', notes: '補足' },
};

/** The explanation as Markdown, for people and for agents to show as is. */
export function explanationText(e: Explanation): string {
  const h = HEADINGS[e.lang];
  const list = (items: string[]) => items.map((s) => `- ${s}`).join('\n');
  const w = W[e.lang];
  const out = [`# ${w.heading(e.title, e.profile, e.version)}`, e.description, `${e.model}${w.join}${e.input}`];
  if (e.questions.length) out.push(`## ${h.questions}`, list(e.questions));
  if (e.facts.length) out.push(`## ${h.facts}`, list(e.facts));
  if (e.requires.length) out.push(`## ${h.requires}`, list(e.requires));
  out.push(`## ${h.rules}`, e.order, e.rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n'), e.default);
  if (e.people.length) out.push(`## ${h.people}`, e.people.join(w.join));
  if (e.notes.length) out.push(`## ${h.notes}`, list(e.notes));
  return `${out.filter((s) => s !== '').join('\n\n')}\n`;
}
