// The decision in the pull request, railway style (docs/github-connector.md#the-decision-comment):
// a signal for each profile's latest decision, a line with stations for the
// pull request's progress, and a switch for why the decision took its track.
// The check run's title is the signal and the action; its details are the
// line and the switch. The comment is one per pull request, updated in place
// (pull-request.ts).
//
// Only what the check run shows goes in: the action, the rule, the facts'
// names and why one is missing, the AI answers' values, a pending review.
// Never text from the pull request, and every value is checked or cleaned
// first, so nothing in it can add markdown, HTML or a mention.

import type { Decision } from './engine.ts';
import type { SignalColour, SignalSpec } from './settings.ts';

/** The first line of the decision comment: how the connector finds it again (with its own bot account). */
export const COMMENT_MARKER = '<!-- pointsman decision-comment -->';

export interface Signal {
  colour: SignalColour;
  /** The word next to it: colour is never the only sign. */
  text: string;
}

const EMOJI: Record<SignalColour, string> = { red: '🔴', yellow: '🟡', green: '🟢' };
/** The default word of each colour. */
export const SIGNAL_WORDS: Record<SignalColour, string> = { red: 'needs a person', yellow: 'waiting', green: 'go' };
/** Actions with a signal of their own when the deployment sets none (docs/github-connector.md#signals). */
export const DEFAULT_SIGNALS: Record<string, SignalColour> = {
  review: 'red', 'ask-person': 'red',
  wait: 'yellow', 'in-progress': 'yellow', queue: 'yellow', retry: 'yellow',
  approve: 'green', pass: 'green', done: 'green',
};

/**
 * The signal for a decision: the deployment's own for this profile and
 * action, else the default for the action, else yellow "decided: <action>".
 * A decision a person still checks is red, whatever its action.
 */
export function signalOf(signals: Record<string, Record<string, SignalSpec>> | undefined, d: Decision): Signal {
  if (d.review?.status === 'pending') return { colour: 'red', text: 'a person checks first' };
  const own = signals && Object.hasOwn(signals, d.profile) && Object.hasOwn(signals[d.profile]!, d.action) ? signals[d.profile]![d.action] : undefined;
  if (own) return { colour: own.signal, text: own.text ?? SIGNAL_WORDS[own.signal] };
  if (Object.hasOwn(DEFAULT_SIGNALS, d.action)) {
    const colour = DEFAULT_SIGNALS[d.action]!;
    return { colour, text: SIGNAL_WORDS[colour] };
  }
  return { colour: 'yellow', text: `decided: ${d.action}` };
}

export const signalMark = (s: Signal) => EMOJI[s.colour];

/** The stations of the line, in order. */
export const STATIONS = ['draft', 'ready', 'reviewed', 'approved', 'merged'] as const;
export type Station = (typeof STATIONS)[number];

const CAPTIONS: Partial<Record<Station, string>> = {
  draft: 'draft: work in progress',
  ready: 'ready for review',
  approved: 'approved by Pointsman on this commit',
};

/**
 * Where the pull request is, from what the connector knows for sure: a draft;
 * approved when its own approval of this commit stands; else ready. It reads
 * no one else's reviews, and closed pull requests get no run, so the train is
 * never at "reviewed" or "merged".
 */
export function stationOf(draft: boolean, approvedByApp: boolean): Station {
  if (draft) return 'draft';
  return approvedByApp ? 'approved' : 'ready';
}

/** The line, with the train under its station (none: no train). */
export function lineArt(at: Station | undefined): string {
  const sep = ' ─── ';
  const line = STATIONS.join(sep);
  if (!at) return line;
  const column = STATIONS.slice(0, STATIONS.indexOf(at)).reduce((n, s) => n + s.length + sep.length, 0);
  return `${line}\n${' '.repeat(column)}🚆 ${CAPTIONS[at] ?? at}`;
}

/** Names as the engine gives them (fact and question names); anything else is not shown. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_LISTED = 8;

/** Text from the engine (a fact's reason): only plain characters, cut short. */
export function clean(text: string, max: number): string {
  const plain = text.replace(/[^A-Za-z0-9 _.,:;()/=+-]/g, '_').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** The AI answers' values, by question: only names and values of the known shapes. */
export function answersOf(d: Decision): string[] {
  const answers = d.answers;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return [];
  const out: string[] = [];
  for (const [name, a] of Object.entries(answers as Record<string, unknown>)) {
    if (!NAME.test(name) || a === null || typeof a !== 'object') continue;
    const { type, value } = a as { type?: unknown; value?: unknown };
    if (type === 'noul' && typeof value === 'boolean') out.push(`${name}: ${value ? 'yes' : 'no'}`);
    else if (type === 'choice' && typeof value === 'string') out.push(`${name}: ${NAME.test(value) ? value : '?'}`);
    else if (type === 'score' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out.push(`${name}: level ${value}`);
  }
  return out;
}

const listed = (items: string[]) => (items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `+${items.length - MAX_LISTED} more`] : items).join(', ');

/** Why the decision took its track: facts, AI answers, and the rule that set it. */
export function switchArt(d: Decision, head: string): string {
  const facts = Object.entries(d.facts ?? {}).filter(([name]) => NAME.test(name));
  const missing = facts.filter(([, f]) => f.missing).map(([name, f]) => `${name} (${clean(f.reason ?? 'missing', 40)})`);
  const factLine = facts.length === 0 ? '– none asked'
    : missing.length === 0 ? `✓ ${facts.length} read`
      : `✕ ${missing.length} of ${facts.length} missing: ${listed(missing)}`;
  const answers = answersOf(d);
  const why = d.rule === null ? 'the default (no rule matched)' : `rule ${d.rule + 1}`;
  return [
    `${d.profile} @ ${head.slice(0, 7)}`,
    '  ║',
    `  ╠═ facts  ${factLine}`,
    `  ╠═ AI     ${answers.length === 0 ? '– none asked' : listed(answers)}`,
    '  ║',
    `  ╚═▶ ${d.action}   ← ${why}`,
    ...(d.review?.status === 'pending' ? ['      a person checks this decision before it counts'] : []),
  ].join('\n');
}

const fence = (text: string) => `\`\`\`text\n${text.replace(/`/g, "'")}\n\`\`\``;

/** The check run's details: the line and this decision's switch. */
export function checkText(d: Decision, head: string, at: Station | undefined): string {
  return [fence(lineArt(at)), '', fence(switchArt(d, head))].join('\n');
}

/**
 * The comment for the latest decision of each profile (in the order given).
 * Nothing in it changes from run to run unless a decision, its signal or the
 * pull request's station does: no decision ids, no times.
 */
export function commentBody(decisions: Decision[], signals: Record<string, Record<string, SignalSpec>> | undefined, head: string, at: Station | undefined): string {
  // None (all skipped on this commit, or the last one no longer stands): a short neutral text, so an older one is not left standing.
  if (decisions.length === 0) {
    return [
      COMMENT_MARKER,
      '### 🚦 Pointsman',
      '',
      `No decision to show for commit ${head.slice(0, 7)}: its profiles have not decided on it yet, or their last decision no longer stands.`,
      '',
      fence(lineArt(at)),
    ].join('\n');
  }
  const rows = decisions.map((d) => {
    const s = signalOf(signals, d);
    return `| \`${d.profile}\` | ${signalMark(s)} ${s.text} | \`${d.action}\` | ${d.rule === null ? 'default' : `rule ${d.rule + 1}`} |`;
  });
  const switches = decisions.map((d) => `<details><summary><code>${d.profile}</code>: why <code>${d.action}</code></summary>\n\n${fence(switchArt(d, head))}\n\n</details>`);
  return [
    COMMENT_MARKER,
    '### 🚦 Pointsman',
    '',
    '| Profile | Signal | Decision | Set by |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    fence(lineArt(at)),
    '',
    ...switches.flatMap((s) => [s, '']),
    `<sub>For commit ${head.slice(0, 7)}. One comment, updated when a decision changes; the check runs \`Pointsman: <profile>\` have the decision ids.</sub>`,
  ].join('\n');
}
