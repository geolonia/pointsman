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
