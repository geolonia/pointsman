// The decision in the pull request, railway style (docs/github-connector.md#the-decision-comment):
// a signal for each profile's latest decision, a line with stations for the
// pull request's progress, and a switch for why the decision took its track.
// The check run's title is the signal and the action; its details are the
// line and the switch. The comment is one per pull request, updated in place
// (pull-request.ts).
//
// Only what the check run shows goes in: the action, the rule, the facts'
// names and why one is missing, the AI answers' values, a pending review or
// a person's answer (with the login of who gave it in the pull request, never
// with "@").
// Never text from the pull request, and every value is checked or cleaned
// first, so nothing in it can add markdown, HTML or a mention.

import { actionOf, type Decision } from './engine.ts';
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
 * A decision a person still checks is red, whatever its action; once a
 * person answered, the signal is their answer's.
 */
export function signalOf(signals: Record<string, Record<string, SignalSpec>> | undefined, decision: Decision): Signal {
  if (decision.review?.status === 'pending') return { colour: 'red', text: 'a person checks first' };
  const d = { profile: decision.profile, action: actionOf(decision) };
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

/** Where the train stands: at a station, or off the line (closed without merging). */
export interface Position {
  at: Station | 'closed';
  /** At "approved": the app's own approval of this commit stands (its caption says so). */
  ownApproval?: boolean;
  /** At "approved": an approval of this commit stands (not only of an older one). */
  onHead?: boolean;
}

const CAPTIONS: Record<Station, string> = {
  draft: 'draft: work in progress',
  ready: 'ready for review',
  reviewed: 'reviewed on this commit',
  approved: 'approved',
  merged: 'merged',
};
const OWN_APPROVAL = 'approved by Pointsman on this commit';
const HEAD_APPROVAL = 'approved on this commit';
/** Under the line of a pull request closed without merging: no train on it. */
export const CLOSED_TEXT = 'closed without merging';

/** One review as the connector reads it (github.ts): never its text. */
export interface ReviewRef {
  id: number;
  /** GitHub's state: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
  /** The commit it was given on ('' when GitHub no longer has it). */
  commit: string;
  /** The reviewer, lower case, as REST names them (a bot "<slug>[bot]"): only compared, never shown. */
  login: string;
  /** By the app's own bot account. */
  own: boolean;
}

/** What GitHub says about the reviews: its review decision (the merge box's, by the repository's rules) and the newest reviews. */
export interface ReviewSummary {
  /** The head commit GitHub decided for. */
  head: string;
  /** null: the repository requires no review, so GitHub decides nothing. */
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  reviews: ReviewRef[];
}

/** What the reviews say about this head. */
export interface HeadReviews {
  /** A review (a comment, a change request or an approval) of this head by someone other than the author. */
  reviewed: boolean;
  /** GitHub's review decision is APPROVED. */
  approved: boolean;
  /** The app's own latest verdict is an approval of this head. */
  ownApproved: boolean;
  /** Someone's (not the author's) latest verdict is an approval of this head. */
  headApproved: boolean;
}

export const NO_REVIEWS: HeadReviews = { reviewed: false, approved: false, ownApproved: false, headApproved: false };

const SUBMITTED = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
/** The states that set a reviewer's verdict; a later comment leaves it as it was. */
const VERDICT = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * What GitHub says about this head. Approved only by GitHub's own review
 * decision, as the merge box shows it under the repository's rules (whose
 * approvals count, how many, whether a new commit dismisses them); with no
 * review rule GitHub decides nothing, and the train is never at "approved".
 * Reviewed: someone other than the author reviewed this head (dismissed and
 * pending reviews do not count).
 */
export function reviewStateOf(summary: ReviewSummary, head: string, author: string): HeadReviews {
  // The author unknown (or a deleted account): no review is known to be someone else's.
  const known = author !== '' && author.toLowerCase() !== 'ghost';
  const others = known ? summary.reviews.filter((r) => r.login !== '' && r.login !== author.toLowerCase()).sort((a, b) => a.id - b.id) : [];
  const verdicts = new Map<string, ReviewRef>();
  for (const r of others) if (VERDICT.has(r.state)) verdicts.set(r.login, r);
  const onHead = [...verdicts.values()].filter((r) => r.state === 'APPROVED' && r.commit === head);
  const approved = summary.decision === 'APPROVED';
  return {
    reviewed: others.some((r) => SUBMITTED.has(r.state) && r.commit === head),
    approved,
    ownApproved: approved && onHead.some((r) => r.own),
    headApproved: approved && onHead.length > 0,
  };
}

/**
 * Where the pull request is, from GitHub's state: merged, or closed without
 * merging; a draft; approved when GitHub's review decision is; reviewed once
 * someone other than the author reviewed this head; else ready.
 */
export function positionOf(pr: { open: boolean; merged: boolean; draft: boolean }, reviews: HeadReviews): Position {
  if (!pr.open) return { at: pr.merged ? 'merged' : 'closed' };
  if (pr.draft) return { at: 'draft' };
  if (reviews.approved) return { at: 'approved', ownApproval: reviews.ownApproved, onHead: reviews.headApproved };
  return { at: reviews.reviewed ? 'reviewed' : 'ready' };
}

/**
 * The widest line of the art, in columns: it does not wrap on a phone. Longer
 * text is stacked on more lines, or cut with "…".
 */
export const MAX_COLUMNS = 60;

// East Asian wide and fullwidth characters (and emoji) take two columns in a monospace font. A safeguard:
// what reaches the art is checked or cleaned to ASCII first.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** The columns a text takes in a monospace font (box characters count one: see the note on the art below). */
export function columns(text: string): number {
  let n = 0;
  for (const ch of text) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/** The text cut to `max` columns, with "…" when cut. */
function cut(text: string, max: number): string {
  if (columns(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (columns(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** A line of the art, never wider than MAX_COLUMNS. */
const fit = (line: string) => cut(line, MAX_COLUMNS);

// The art (line and switch) keeps three rules, so it lines up in any monospace font:
// - Text of varying length (names, rules, reasons) only at the end of a line, after the rails.
// - No emoji in it (two columns in most fonts, not in all).
// - Every rail line is only box characters up to where its text starts, and all
//   of them are of East Asian width "ambiguous": a Japanese font that draws them
//   two columns wide widens the whole drawing, but its junctions still line up.
//   Station names have their own line above the rail.

/** Between two stations: two sleepers. */
const SPAN = '━━━┿━━━┿━━━';
const EDGE = '━━━';
/** The column of each station on the rail. */
const STATION_COLUMN = STATIONS.map((_, i) => EDGE.length + i * (SPAN.length + 1));

/**
 * The line: station names, the rail with the train's station and the ones
 * before it filled (● passed, ○ still ahead), and the train (▲) under its
 * station with a caption. None: no train and nothing filled. Closed without
 * merging: nothing filled and no train; a line under the rail says so.
 */
export function lineArt(position: Position | Station | undefined): string {
  const pos: Position | undefined = typeof position === 'string' ? { at: position } : position;
  let names = '';
  STATIONS.forEach((s, i) => {
    const start = Math.max(names.length === 0 ? 0 : names.length + 1, STATION_COLUMN[i]! - Math.floor((s.length - 1) / 2));
    names = names.padEnd(start) + s;
  });
  const index = pos && pos.at !== 'closed' ? STATIONS.indexOf(pos.at) : -1;
  const rail = `${EDGE}${STATIONS.map((_, i) => (i <= index ? '●' : '○')).join(SPAN)}${EDGE}`;
  if (!pos) return [names, rail].join('\n');
  if (pos.at === 'closed') return [names, rail, `${' '.repeat(EDGE.length)}${CLOSED_TEXT}`].join('\n');
  const column = STATION_COLUMN[index]!;
  const caption = pos.at === 'approved' && pos.ownApproval ? OWN_APPROVAL : pos.at === 'approved' && pos.onHead ? HEAD_APPROVAL : CAPTIONS[pos.at];
  const train = `${' '.repeat(column)}▲`;
  // The caption after the train, or on its own line when that is too wide.
  const after = `${train} ${caption}`;
  const lines = columns(after) <= MAX_COLUMNS ? [after] : [train, fit(`${' '.repeat(Math.max(0, MAX_COLUMNS - columns(caption)))}${caption}`)];
  return [names, rail, ...lines].join('\n');
}

/** Names as the engine gives them (fact and question names); anything else is not shown. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** A fact's name as the engine checks it (engine.ts). */
const FACT_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
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

const listed = (items: string[]) => (items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `+${items.length - MAX_LISTED} more`] : items);

/** A profile's or an action's name as the engine checked it (engine.ts); anything else is cleaned. */
const label = (name: string) => (NAME.test(name) ? name : clean(name, 64));

/** A GitHub login: shown without "@", so it mentions nobody. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** Who answered in the pull request (the connector's note), when it is a login. */
const answeredBy = (d: Decision) => (typeof d.answered_by === 'string' && LOGIN.test(d.answered_by) ? d.answered_by : undefined);

/** The legs of the points: the track taken is heavy, the one not taken light. */
const TAKEN = '━━━┿━━━┿━━━';
const NOT_TAKEN = '───┼───┼───';

/**
 * Lines beside the track (┃) for one kind of input: its name, then `head` and
 * the items on one line when that fits, else one a line.
 */
function beside(name: string, head: string, items: string[]): string[] {
  const inline = `┃ ${name.padEnd(6)} ${[head, items.join(', ')].filter(Boolean).join(' ')}`;
  if (columns(inline) <= MAX_COLUMNS) return [inline];
  return [...(head ? [head] : []), ...items].map((row, i) => fit(`┃ ${(i === 0 ? name : '').padEnd(6)} ${row}`));
}

/**
 * Why the decision took its track: the track passes the facts and the AI
 * answers, then reaches the points. Rules are checked in order and the first
 * that matches sets the action, so a rule's points send the train off to the
 * right (heavy) and the later rules and the default are the track not taken
 * (light); with no rule matched, the rules' points are not taken and the
 * train goes on to the default. Only these two tracks are drawn: the
 * connector knows no other action of the profile.
 */
export function switchArt(d: Decision, head: string): string {
  // Every fact the engine accepted (engine.ts: names up to 100 characters) counts; a long name is shown cut.
  const facts = Object.entries(d.facts ?? {}).filter(([name]) => FACT_NAME.test(name));
  const missing = facts.filter(([, f]) => f.missing).map(([name, f]) => `${cut(name, 40)} (${clean(f.reason ?? 'missing', 40)})`);
  const factLines = facts.length === 0 ? beside('facts', '– none asked', [])
    : missing.length === 0 ? beside('facts', `✓ ${facts.length} read`, [])
      : beside('facts', `✕ ${missing.length} of ${facts.length} missing:`, listed(missing));
  const answers = answersOf(d);
  const aiLines = beside('AI', answers.length === 0 ? '– none asked' : '', listed(answers));
  // The rules' own action (the track taken); a person's answer is a line of its own below.
  const action = label(d.action);
  const why = d.rule === null ? 'the default' : `rule ${d.rule + 1}`;
  // The track taken, with its action and why; "← why" on the next line (`next`, the rail below) when too wide.
  const taken = (junction: string, next: string) => {
    const line = `${junction}${TAKEN} ${action}`;
    const full = `${line}  ← ${why}`;
    if (columns(full) <= MAX_COLUMNS) return [full, ...(next ? [next] : [])];
    return [fit(line), `${next || ' '}${' '.repeat(TAKEN.length)} ← ${why}`];
  };
  const points = d.rule === null
    ? ['┃', `┠${NOT_TAKEN} no rule matched`, '┃', ...taken('┗', '')]
    : ['┃', ...taken('┡', '│'), `└${NOT_TAKEN} later rules and the default: not taken`];
  return [
    `${cut(label(d.profile), MAX_COLUMNS - 10)} @ ${head.slice(0, 7)}`,
    ...factLines,
    ...aiLines,
    ...points,
    ...(d.review?.status === 'pending' ? ['waiting for a person to check this decision'] : []),
    ...(d.review?.status === 'resolved'
      ? [answeredBy(d) ? fit(`answered by ${answeredBy(d)}: ${label(actionOf(d))}`) : `a person answered: ${cut(label(actionOf(d)), MAX_COLUMNS - 20)}`] : []),
  ].join('\n');
}

const fence = (text: string) => `\`\`\`text\n${text.replace(/`/g, "'")}\n\`\`\``;

/** The check run's details: the line and this decision's switch. */
export function checkText(d: Decision, head: string, at: Position | Station | undefined): string {
  return [fence(lineArt(at)), '', fence(switchArt(d, head))].join('\n');
}

/**
 * The comment for the latest decision of each profile (in the order given).
 * Nothing in it changes from run to run unless a decision, its signal or the
 * pull request's station does: no decision ids, no times.
 */
export function commentBody(decisions: Decision[], signals: Record<string, Record<string, SignalSpec>> | undefined, head: string, at: Position | Station | undefined, commands: Record<string, string[]> = {}): string {
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
    const by = d.review?.status === 'resolved' ? (answeredBy(d) ? `answered by ${answeredBy(d)}` : 'a person') : d.rule === null ? 'default' : `rule ${d.rule + 1}`;
    return `| \`${d.profile}\` | ${signalMark(s)} ${s.text} | \`${actionOf(d)}\` | ${by} |`;
  });
  // The row shows what is acted on (a person's answer once given); the switch shows why the rules gave their action, and the answer below it.
  const switches = decisions.map((d) => `<details><summary><code>${d.profile}</code>: why <code>${d.action}</code>${d.review?.status === 'resolved' ? `; ${answeredBy(d) ? `answered by ${answeredBy(d)}:` : 'a person answered'} <code>${actionOf(d)}</code>` : ''}</summary>\n\n${fence(switchArt(d, head))}\n\n</details>`);
  // An open question that the command may answer: its answers, as fixed text (action names, checked in the settings).
  const asks = decisions.filter((d) => d.review?.status === 'pending' && Object.hasOwn(commands, d.profile))
    .map((d) => `<code>${d.profile}</code> waits for a person about commit ${head.slice(0, 12)}: answer with a comment of one line, ${commands[d.profile]!.map((a) => `\`/pointsman ${a} ${head.slice(0, 12)}\``).join(' or ')}. Only people with write access can answer; not the author of the pull request, and not the person who pushed this commit.`);
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
    ...asks.flatMap((a) => [a, '']),
    ...switches.flatMap((s) => [s, '']),
    `<sub>For commit ${head.slice(0, 7)}. One comment, updated when a decision changes; the check runs \`Pointsman: <profile>\` have the decision ids.</sub>`,
  ].join('\n');
}
