// The check run of a decision (docs/github-connector.md): neutral, so it
// never blocks a merge. Its title is the signal and the action, its summary
// says which action was done or why not, and how a person answers where
// they are asked; its details are the line and the switch (comment.ts).
// Also the check run for an answer that is not a decision to act on. The run
// writes them (pull-request.ts).

import { actionOf, type CheckedAnswer, type Decision } from './engine.ts';
import { asButtons, type ActionSpec, type SignalSpec } from './settings.ts';
import { checkText, clean, commandFor, type Position, type Station, signalMark, signalOf } from './comment.ts';
import type { CheckRunOutput } from './github.ts';
import { LOGIN } from './records.ts';

/** What happened to a decision's action, for its check run. */
export type ActOutcome =
  | { kind: 'none' }
  | { kind: 'done'; text: string }
  | { kind: 'skipped'; text: string };

/** What is not acted on: an answer that is not a decision, a test decision, or a question that could not be read back. */
export type NotActed = Exclude<CheckedAnswer, { kind: 'decision' }> | { kind: 'unreadable'; status: string };

/** The check run for a decision: neutral, so it never blocks a merge; it says which action was done or why not. */
export function describe(spec: ActionSpec): string {
  switch (spec.do) {
    case 'comment': return 'comment written';
    case 'label': return `labels added: ${spec.labels.join(', ')}`;
    case 'request_reviewer': return `review requested from ${spec.reviewers.join(', ')}`;
    case 'approve': return 'approved this commit';
    case 'keep_approval': return 'approval of this commit kept';
    case 'copilot_review': return 'review requested from Copilot';
  }
}

/** What the check run's title and details show besides the decision (comment.ts). */
export interface CheckView {
  signals?: Record<string, Record<string, SignalSpec>> | undefined;
  /** With the head: the line and the switch in the details. */
  head?: string;
  station?: Position | Station;
  /** A question open in the pull request (answers.ts): the answers offered, and whether the command is on. */
  asking?: { offered: string[]; command: boolean };
}

export function checkOutput(d: Decision, outcome: ActOutcome = { kind: 'none' }, view: CheckView = {}): CheckRunOutput {
  const missing = Object.entries(d.facts ?? {}).filter(([, f]) => f.missing).map(([name, f]) => `\`${name.slice(0, 100)}\` (${clean(f.reason ?? 'missing', 300)})`);
  const answered = d.review?.status === 'resolved';
  const action = actionOf(d);
  // Who answered in the pull request, without "@" (no mention); an answer given in Pointsman's queue names nobody.
  const by = answered ? answererOf(d) : undefined;
  const lines = [
    `Pointsman decided **${d.action}** with the profile \`${d.profile}\` (version ${d.profile_version}), ${d.rule === null ? 'by its default' : `by rule ${d.rule + 1}`}.`,
    ...(answered ? ['', by ? `Answered by ${by} in the pull request: **${action}**; that answer is the action.` : `A person answered **${action}** in Pointsman's review queue; that answer is the action.`] : []),
    '',
    outcome.kind === 'none'
      ? 'Shadow mode: this check shows the decision and never blocks; Pointsman acts on nothing for it.'
      : `${outcome.kind === 'done' ? 'Done' : 'Not done'}: ${outcome.text}. This check never blocks.`,
    ...(missing.length > 0 ? ['', `Missing facts: ${missing.join(', ')}.`] : []),
    ...(d.review?.status === 'pending' ? ['', 'Waiting for a person: a person checks this decision before it counts. Their answer is used once they give it.'] : []),
    ...(d.review?.status === 'pending' && view.asking ? ['', askingText(view.asking, view.head ?? '', d.decision_id)] : []),
    '',
    `Decision \`${d.decision_id}\``,
  ];
  // The signal and the action, as the comment shows them: "🟢 approve", "🔴 review (shadow)".
  const signal = signalOf(view.signals, d);
  const title = `${signalMark(signal)} ${action}${d.review?.status === 'pending' ? ': a person checks first' : by ? `: answered by ${by}` : answered ? ': a person\'s answer' : ''}${outcome.kind === 'none' ? ' (shadow)' : ''}`;
  return {
    externalId: d.decision_id, conclusion: 'neutral', title, summary: lines.join('\n'),
    ...(view.head !== undefined && { text: checkText(d, view.head, view.station) }),
  };
}

/** How a person answers in the pull request: the buttons, and the command where it is on. */
function askingText(asking: { offered: string[]; command: boolean }, head: string, decisionId: string): string {
  const ways = [
    ...(asButtons(asking.offered) ? ['with a button above'] : []),
    // The command names the commit and the question, so it never answers a question about a later push or one that replaced this one.
    ...(asking.command && head ? [`with a comment of one line: ${asking.offered.map((a) => `\`${commandFor(a, head, decisionId)}\``).join(', ')}`] : []),
  ];
  return `Answer in the pull request ${ways.join(', or ')}. Only people with write access can answer; not the author of the pull request, and not the person who pushed this commit.`;
}

/** The login of the person who answered in the pull request, when it is one. */
function answererOf(d: Decision): string | undefined {
  return typeof d.answered_by === 'string' && LOGIN.test(d.answered_by) ? d.answered_by : undefined;
}

/** The check run for a test decision or an answer that is not a decision: neutral, and nothing was done. */
export function notActedOnOutput(profile: string, answer: NotActed, note?: string): CheckRunOutput {
  const lines = answer.kind === 'test'
    ? [
      `Pointsman answered with a **test decision** for the profile \`${profile}\` (\`test: true\`, decided **${answer.decision.action}**). A test decision is not logged, so nothing was done for it.`,
      '',
      'The connector\'s token is probably a test token: give it a token that is not one (scripts/tokens.mjs without --test). This check never blocks.',
      '',
      `Decision \`${answer.decision.decision_id}\``,
    ]
    : answer.kind === 'unreadable'
      ? [
        `Pointsman refused to read back the decision a person was asked about for the profile \`${profile}\` (${answer.status}), so their answer could not be read. Nothing was done for it; it is read again on the next event or recheck.`,
        '',
        'This check never blocks.',
      ]
      : [
        `Pointsman's answer for the profile \`${profile}\` is not a decision the connector can use: ${answer.reason}. Nothing was done for it, and it is not tried again until the next event or recheck.`,
        '',
        'This check never blocks.',
      ];
  if (note) lines.splice(1, 0, '', note);
  return {
    externalId: answer.kind === 'test' ? answer.decision.decision_id : answer.kind === 'unreadable' ? 'unreadable-answer' : 'invalid-answer',
    conclusion: 'neutral',
    title: answer.kind === 'test' ? 'test decision: nothing done' : answer.kind === 'unreadable' ? 'answer could not be read: nothing done' : 'invalid answer: nothing done',
    summary: lines.join('\n'),
    // Replaces the details of an earlier decision on this check run.
    text: 'No decision to show: nothing was done for this profile. The decision comment shows no decision from this answer.',
  };
}
