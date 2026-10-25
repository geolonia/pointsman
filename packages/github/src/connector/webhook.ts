// GitHub webhooks for the connector (docs/github-connector.md): the signature
// check, and which pull requests an event is about. The payload is only a
// hint: the connector reads the pull request again with its own token before
// it asks Pointsman, so a replayed or stale event can at most cause a check
// of the current state.

/** Larger bodies are refused before they are read in full. GitHub sends at most 25 MB; events about pull requests are far smaller. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/**
 * Checks `X-Hub-Signature-256`: an HMAC-SHA256 of the raw body with the
 * webhook secret. WebCrypto's verify compares in constant time.
 */
export async function verifySignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  const m = SIGNATURE.exec(header ?? '');
  if (!m || secret === '') return false;
  const signature = new Uint8Array(32);
  for (let i = 0; i < 32; i++) signature[i] = parseInt(m[1]!.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, body);
}

/** The SHA-256 of a body, hex: a replay with a new delivery id has the same body. */
export async function bodyDigest(body: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A pull request an event is about. */
export interface PullRequestTarget {
  /** owner/name as GitHub writes it. */
  repo: string;
  number: number;
}

const PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'edited']);
const REVIEW_ACTIONS = new Set(['submitted', 'dismissed']);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function repoOf(payload: Record<string, unknown>): string | undefined {
  const name = isObject(payload.repository) ? payload.repository.full_name : undefined;
  return typeof name === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(name) ? name : undefined;
}

/** The numbers of a check suite's pull requests in this repository (none for pull requests from forks). */
function numbersOf(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((p) => p.number).filter(isNumber);
}

/**
 * The pull requests an event is about. Events of the connector's own app
 * (its check suites) are left out: they would start the next run. A closed
 * pull request only with `closed` (the decision comment is on: it shows the
 * merge or the close).
 */
export function targetsOf(event: string, payload: unknown, appId: number, closed = false): PullRequestTarget[] {
  if (!isObject(payload)) return [];
  const repo = repoOf(payload);
  if (!repo) return [];
  const action = payload.action;
  const one = (pr: unknown): PullRequestTarget[] => (isObject(pr) && isNumber(pr.number) ? [{ repo, number: pr.number }] : []);
  switch (event) {
    case 'pull_request':
      return typeof action === 'string' && (PR_ACTIONS.has(action) || (closed && action === 'closed')) ? one(payload.pull_request) : [];
    case 'pull_request_review':
      return typeof action === 'string' && REVIEW_ACTIONS.has(action) ? one(payload.pull_request) : [];
    // A finished check suite (one per app and push), not each check run:
    // fewer runs, and each one asks Pointsman.
    case 'check_suite': {
      if (action !== 'completed') return [];
      const suite = payload.check_suite;
      if (!isObject(suite)) return [];
      const app = isObject(suite.app) ? suite.app.id : undefined;
      if (app === appId) return [];
      return [...new Set(numbersOf(suite.pull_requests))].map((number) => ({ repo, number }));
    }
    default:
      return [];
  }
}

/** A review event that a bot account sent: the review's id and the bot's login (lower case). */
export interface BotReview {
  id: number;
  login: string;
}

/**
 * The review a `pull_request_review` event is about, when a bot account sent
 * it: the connector's own approvals and dismissals come so, and the pull
 * request's object leaves out those about reviews it recorded giving, sent by
 * its own bot (pull-request.ts `accept`). Undefined for any other event or
 * sender, so a person who dismisses the connector's approval still starts a run.
 */
export function botReviewOf(event: string, payload: unknown): BotReview | undefined {
  if (event !== 'pull_request_review' || !isObject(payload)) return undefined;
  const sender = payload.sender;
  if (!isObject(sender) || sender.type !== 'Bot' || typeof sender.login !== 'string') return undefined;
  const review = payload.review;
  return isObject(review) && isNumber(review.id) ? { id: review.id, login: sender.login.toLowerCase() } : undefined;
}

/** The person who sent an answer: their account, from the event's `sender` (checked again with GitHub before it counts). */
export interface Answerer {
  login: string;
  id: number;
}

/**
 * An answer given inside the pull request (docs/github-connector.md#answering-in-the-pull-request):
 * a click on a button of one of the connector's check runs, or a `/pointsman <answer>` comment.
 * Only a hint: the pull request's object binds it to its own record of the question and checks
 * the person with GitHub (answers.ts).
 */
export type AnswerEvent =
  | { kind: 'button'; checkRun: number; head: string; externalId: string; identifier: string }
  /** `head`: the first 7 characters of the commit the person answers about, as the command names it. */
  | { kind: 'command'; answer: string; head: string };

export interface AnswerHint {
  targets: PullRequestTarget[];
  answer: AnswerEvent;
  by: Answerer;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;
/** The connector's button identifiers (answers.ts): nothing else is passed on. */
const IDENTIFIER = /^[1-3]-[0-9a-f]{8}$/;
/**
 * The whole comment, trimmed: exactly this one line. An action name, lower
 * case, as Pointsman writes it, and the head commit the answer is about (its
 * first 7 characters, as the decision comment shows them).
 */
const COMMAND = /^\/pointsman ([a-z0-9][a-z0-9_-]{0,63}) ([0-9a-f]{7})$/;

/**
 * A person's account, from an event's sender: only a `User` (never a bot, an
 * app or the `ghost` account of a deleted user) with a login and an id.
 */
function userOf(v: unknown): Answerer | undefined {
  if (!isObject(v) || v.type !== 'User' || typeof v.login !== 'string' || !LOGIN.test(v.login) || !isNumber(v.id)) return undefined;
  return v.login.toLowerCase() === 'ghost' ? undefined : { login: v.login, id: v.id };
}

/**
 * The answer and short head of a `/pointsman <answer> <head>` comment: only
 * when the whole comment, trimmed, is that one line (no other text, no
 * quote, no code block, no upper case, the head given). Anything else is not
 * a command.
 */
export function commandOf(body: unknown): { answer: string; head: string } | undefined {
  const m = typeof body === 'string' ? COMMAND.exec(body.trim()) : null;
  return m ? { answer: m[1]!, head: m[2]! } : undefined;
}

/**
 * The answer an event carries, with the pull requests it may be about, or
 * undefined. A click: `check_run` `requested_action` on one of the
 * connector's own check runs (its app id), with one of its identifiers. A
 * comment, only with `command`: `issue_comment` `created` on a pull request,
 * by a person, that is exactly a command. Edits and deletions are never
 * answers, and nothing from a bot or app is.
 */
export function answerOf(event: string, payload: unknown, appId: number, command: boolean): AnswerHint | undefined {
  if (!isObject(payload)) return undefined;
  const repo = repoOf(payload);
  const by = userOf(payload.sender);
  if (!repo || !by) return undefined;
  if (event === 'check_run' && payload.action === 'requested_action') {
    const run = payload.check_run;
    const requested = payload.requested_action;
    if (!isObject(run) || !isObject(run.app) || run.app.id !== appId || !isNumber(run.id)) return undefined;
    if (typeof run.head_sha !== 'string' || !SHA.test(run.head_sha) || typeof run.external_id !== 'string') return undefined;
    if (!isObject(requested) || typeof requested.identifier !== 'string' || !IDENTIFIER.test(requested.identifier)) return undefined;
    // Only to find the pull request's object, which takes the click only for a check run it recorded.
    const targets = [...new Set(numbersOf(run.pull_requests))].map((number) => ({ repo, number }));
    return targets.length === 0 ? undefined : {
      targets, by, answer: { kind: 'button', checkRun: run.id, head: run.head_sha, externalId: run.external_id, identifier: requested.identifier },
    };
  }
  if (event === 'issue_comment' && command && payload.action === 'created') {
    const issue = payload.issue;
    const comment = payload.comment;
    // A comment on a pull request (an issue has no pull_request), written by the sender.
    if (!isObject(issue) || !isObject(issue.pull_request) || !isNumber(issue.number) || !isObject(comment)) return undefined;
    if (userOf(comment.user)?.id !== by.id) return undefined;
    const command = commandOf(comment.body);
    return command === undefined ? undefined : { targets: [{ repo, number: issue.number }], by, answer: { kind: 'command', ...command } };
  }
  return undefined;
}
