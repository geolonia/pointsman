// What the connector reads and writes on GitHub, with the write app's
// installation token, down-scoped to what it needs: read the pull request,
// write check runs, and only when the deployment switched actions on, write
// pull requests (docs/github-connector.md).

import { FactError, FactUnavailableError } from '@pointsman/module-api';
import { GitHubAppAuth, type Scope } from '../provider.ts';
import { GITHUB_TIMEOUT_MS } from '../definition.ts';
import type { ReviewRef, ReviewSummary } from './comment.ts';

const API = 'https://api.github.com';
const USER_AGENT = 'pointsman-github-connector (+https://github.com/geolonia/pointsman)';
const LEVEL = { read: 1, write: 2 } as Record<string, number>;

/** The permissions the connector asks for; each one only up to what the app has. */
export const CONNECTOR_PERMISSIONS: Record<string, 'read' | 'write'> = { metadata: 'read', pull_requests: 'read', checks: 'write' };
/** With actions switched on: comments, labels, review requests and reviews need pull requests: write. */
export const ACTING_PERMISSIONS: Record<string, 'read' | 'write'> = { ...CONNECTOR_PERMISSIONS, pull_requests: 'write' };
/** With a profile that gets the diff: GitHub gives a private repository's diff only with contents: read. */
export const DIFF_PERMISSIONS: Record<string, 'read' | 'write'> = { contents: 'read' };

/** Each permission it needs, at most at the level the app has; none the app lacks. */
export const connectorScope: Scope = (granted) => scopeOf(CONNECTOR_PERMISSIONS, granted);
export const actingScope: Scope = (granted) => scopeOf(ACTING_PERMISSIONS, granted);
/** The scope for these settings: acting adds pull requests: write, diff adds contents: read. */
export const scopeFor = (acting: boolean, diff: boolean): Scope => (granted) =>
  scopeOf({ ...(acting ? ACTING_PERMISSIONS : CONNECTOR_PERMISSIONS), ...(diff && DIFF_PERMISSIONS) }, granted);

function scopeOf(wanted: Record<string, 'read' | 'write'>, granted: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, want] of Object.entries(wanted)) {
    const has = LEVEL[granted[p] ?? ''] ?? 0;
    if (has > 0) out[p] = has >= LEVEL[want]! ? want : 'read';
  }
  return out;
};

/** A failed request. `retry`: worth trying again later (GitHub busy, down or not reached). */
export class GitHubError extends Error {
  override name = 'GitHubError';
  readonly retry: boolean;
  readonly status: number | undefined;
  constructor(message: string, retry: boolean, status?: number) {
    super(message);
    this.retry = retry;
    this.status = status;
  }
}

/**
 * Whether a failure to get a token may pass later: GitHub busy, rate limited
 * or not reached. Not installed, no permission, a broken key: a person fixes it.
 */
function tokenRetry(err: unknown): boolean {
  if (err instanceof FactUnavailableError) return false;
  const message = err instanceof Error ? err.message : '';
  if (/rate limited|: 5\d\d$/.test(message)) return true;
  // Errors of fetch itself (network, timeout) are not FactErrors.
  return !(err instanceof FactError);
}

export interface PullRequestInfo {
  open: boolean;
  /** Closed by a merge. */
  merged: boolean;
  /** The author's login (only compared with reviewers', never shown). */
  author: string;
  head: string;
  draft: boolean;
  base: string;
  title: string;
  body: string;
  /** The head is in another repository (a fork). */
  fork: boolean;
  labels: string[];
  /** Logins asked for a review and not answered yet. */
  requestedReviewers: string[];
}

/** One of the app's approvals on a pull request. */
export interface OwnApproval {
  id: number;
  commit: string;
  /** The first line of its body (the connector's marker). */
  marker?: string;
}

export interface CheckRunOutput {
  /** The decision it shows. */
  externalId: string;
  conclusion: 'neutral' | 'success' | 'failure' | 'action_required';
  title: string;
  summary: string;
  /** The check run's details (shown below the summary). */
  text?: string;
}

export interface ConnectorGitHub {
  pullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  /** The id of the app's check run with this name on this commit, if there is one. */
  findCheckRun(repo: string, head: string, name: string): Promise<number | undefined>;
  createCheckRun(repo: string, head: string, name: string, output: CheckRunOutput): Promise<number>;
  updateCheckRun(repo: string, id: number, output: CheckRunOutput): Promise<void>;
  /** Whether the app already wrote a comment with this marker. */
  findComment(repo: string, number: number, marker: string): Promise<boolean>;
  /** Writes a comment; its id. */
  createComment(repo: string, number: number, body: string): Promise<number>;
  /**
   * The id of the oldest comment that starts with this marker and was written
   * by the app's own bot account (`<app slug>[bot]`); a person's or another
   * app's comment with the same marker is never taken for its own.
   */
  findOwnComment(repo: string, number: number, marker: string): Promise<number | undefined>;
  updateComment(repo: string, id: number, body: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  requestReviewers(repo: string, number: number, reviewers: string[]): Promise<void>;
  /** The app's bot login, "<app slug>[bot]", lower case. */
  botLogin(repo: string): Promise<string>;
  /** The app's own approvals still standing (not dismissed) that carry the marker: only reviews by the app's bot account; the caller matches them with the ids it recorded. */
  ownApprovals(repo: string, number: number): Promise<OwnApproval[]>;
  /** GitHub's review decision and the newest 100 reviews, without their text (one GraphQL query): where the train stands (comment.ts). */
  reviewSummary(repo: string, number: number): Promise<ReviewSummary>;
  /** The unified diff, cut to `max` characters; empty and cut when GitHub does not give one (too large). */
  diff(repo: string, number: number, max: number): Promise<{ diff: string; truncated: boolean }>;
  approve(repo: string, number: number, head: string, body: string): Promise<number>;
  dismissReview(repo: string, number: number, id: number, message: string): Promise<void>;
}

/** Every comment and review the connector writes starts with this; with the head and profile it is the action's trace. */
export const MARKER = '<!-- pointsman';
export const markerOf = (head: string, profile: string, kind: string) => `${MARKER} ${kind} ${profile} ${head} -->`;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SHA = /^[0-9a-f]{40}$/;
/** GitHub's review decisions (GraphQL PullRequestReviewDecision). */
const DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
/** Only this query is sent to GraphQL: it reads, never writes. The newest 100 reviews: those of the head are among them. */
const REVIEW_SUMMARY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewDecision
      reviews(last: 100) { nodes { databaseId state commit { oid } author { __typename login } } }
    }
  }
}`;

export class AppGitHub implements ConnectorGitHub {
  readonly #auth: GitHubAppAuth;
  readonly #appId: number;
  readonly #fetch: typeof fetch;

  /** acting: actions are switched on, so the token may write pull requests; diff: a profile gets the diff, so it may read contents. */
  constructor(appId: number, privateKey: string, fetchFn: typeof fetch = (u, i) => fetch(u, i), acting = false, diff = false) {
    // Each token only for the one repository, with only these permissions.
    this.#auth = new GitHubAppAuth(String(appId), privateKey, scopeFor(acting, diff), true);
    this.#appId = appId;
    this.#fetch = fetchFn;
  }

  async #call(repo: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, what: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<unknown> {
    const res = await this.#send(repo, method, path, what, body, accept);
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      throw new GitHubError(`GitHub ${what}: not JSON`, true);
    }
  }

  /** A successful answer (2xx), or a GitHubError. */
  async #send(repo: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, what: string, body: unknown, accept: string): Promise<Response> {
    const [owner, name] = repo.split('/') as [string, string];
    let token: string;
    try {
      token = await this.#auth.token({ owner, repo: name, number: 0, head: '' }, this.#fetch);
    } catch (err) {
      throw new GitHubError(`GitHub app token: ${err instanceof Error ? err.message : String(err)}`, tokenRetry(err));
    }
    let res: Response;
    try {
      // GraphQL has one URL for every repository; the token is still the one repository's.
      res = await this.#fetch(path === '/graphql' ? `${API}/graphql` : `${API}/repos/${owner}/${name}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      // Not reached, or too slow: later.
      throw new GitHubError(`GitHub ${what}: ${err instanceof Error ? err.name : 'error'}`, true);
    }
    if (res.status >= 200 && res.status < 300) return res;
    // A secondary rate limit is a 403 that may carry neither header; only its message says so.
    const message = res.status === 403 ? (await res.text().catch(() => '')).slice(0, 2000) : (await res.body?.cancel(), '');
    // Busy, down or rate limited: later. Anything else (no permission, not found) needs a person.
    const retry = res.status >= 500 || res.status === 429
      || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after') || /rate limit/i.test(message)));
    throw new GitHubError(`GitHub ${what}: ${res.status}`, retry, res.status);
  }

  async pullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const pr = await this.#call(repo, 'GET', `/pulls/${number}`, 'pull request');
    if (!isObject(pr) || !isObject(pr.head) || typeof pr.head.sha !== 'string' || !SHA.test(pr.head.sha) || !isObject(pr.base)) {
      throw new GitHubError('GitHub pull request: unexpected answer', false);
    }
    return {
      open: pr.state === 'open',
      merged: pr.merged === true || (typeof pr.merged_at === 'string' && pr.merged_at !== ''),
      author: isObject(pr.user) && typeof pr.user.login === 'string' ? pr.user.login : '',
      head: pr.head.sha,
      draft: pr.draft === true,
      base: typeof pr.base.ref === 'string' ? pr.base.ref : '',
      title: typeof pr.title === 'string' ? pr.title : '',
      body: typeof pr.body === 'string' ? pr.body : '',
      fork: !isObject(pr.head.repo) || !isObject(pr.base.repo) || pr.head.repo.full_name !== pr.base.repo.full_name,
      labels: Array.isArray(pr.labels) ? pr.labels.filter(isObject).map((l) => l.name).filter((n): n is string => typeof n === 'string') : [],
      requestedReviewers: Array.isArray(pr.requested_reviewers)
        ? pr.requested_reviewers.filter(isObject).map((u) => u.login).filter((n): n is string => typeof n === 'string') : [],
    };
  }

  /** Every page of a list (100 each, at most 10 pages). */
  async #list(repo: string, path: string, what: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.#call(repo, 'GET', `${path}?per_page=100&page=${page}`, what);
      const items = Array.isArray(data) ? data.filter(isObject) : [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  async findComment(repo: string, number: number, marker: string): Promise<boolean> {
    const comments = await this.#list(repo, `/issues/${number}/comments`, 'comments');
    return comments.some((c) => typeof c.body === 'string' && c.body.startsWith(marker)
      && isObject(c.performed_via_github_app) && c.performed_via_github_app.id === this.#appId);
  }

  async createComment(repo: string, number: number, body: string): Promise<number> {
    const comment = await this.#call(repo, 'POST', `/issues/${number}/comments`, 'comment', { body });
    if (!isObject(comment) || typeof comment.id !== 'number') throw new GitHubError('GitHub comment: unexpected answer', false);
    return comment.id;
  }

  async findOwnComment(repo: string, number: number, marker: string): Promise<number | undefined> {
    const comments = await this.#list(repo, `/issues/${number}/comments`, 'comments');
    const bot = await this.#botLogin(repo);
    const own = comments.filter((c) => typeof c.id === 'number' && typeof c.body === 'string' && c.body.startsWith(marker)
      && isObject(c.user) && c.user.type === 'Bot' && typeof c.user.login === 'string' && c.user.login.toLowerCase() === bot);
    return own.length === 0 ? undefined : Math.min(...own.map((c) => c.id as number));
  }

  async updateComment(repo: string, id: number, body: string): Promise<void> {
    await this.#call(repo, 'PATCH', `/issues/comments/${id}`, 'comment', { body });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#call(repo, 'POST', `/issues/${number}/labels`, 'labels', { labels });
  }

  async requestReviewers(repo: string, number: number, reviewers: string[]): Promise<void> {
    await this.#call(repo, 'POST', `/pulls/${number}/requested_reviewers`, 'review request', { reviewers });
  }

  async botLogin(repo: string): Promise<string> {
    return (await this.#botLogin(repo)).toLowerCase();
  }

  /** The app's bot login, "<slug>[bot]" (lower case), from the installation's answer. */
  async #botLogin(repo: string): Promise<string> {
    const [owner, name] = repo.split('/') as [string, string];
    try {
      return `${await this.#auth.slug({ owner, repo: name, number: 0, head: '' }, this.#fetch)}[bot]`;
    } catch (err) {
      throw new GitHubError(`GitHub app token: ${err instanceof Error ? err.message : String(err)}`, tokenRetry(err));
    }
  }

  async reviewSummary(repo: string, number: number): Promise<ReviewSummary> {
    const [owner, name] = repo.split('/') as [string, string];
    const answer = await this.#call(repo, 'POST', '/graphql', 'review decision', { query: REVIEW_SUMMARY_QUERY, variables: { owner, name, number } });
    const pr = isObject(answer) && isObject(answer.data) && isObject(answer.data.repository) ? answer.data.repository.pullRequest : undefined;
    // Errors (also a rate limit: GraphQL answers it with 200) or no pull request: not a summary to place the train by.
    if (!isObject(answer) || (answer.errors !== undefined && answer.errors !== null) || !isObject(pr) || typeof pr.headRefOid !== 'string' || !isObject(pr.reviews) || !Array.isArray(pr.reviews.nodes)) {
      throw new GitHubError('GitHub review decision: unexpected answer', false);
    }
    const decision = typeof pr.reviewDecision === 'string' && DECISIONS.has(pr.reviewDecision) ? pr.reviewDecision as ReviewSummary['decision'] : null;
    const bot = (await this.#botLogin(repo)).toLowerCase();
    const reviews: ReviewRef[] = pr.reviews.nodes.filter(isObject)
      .filter((r) => typeof r.databaseId === 'number' && typeof r.state === 'string')
      .map((r) => {
        const author = isObject(r.author) && typeof r.author.login === 'string' ? r.author : undefined;
        const isBot = author?.__typename === 'Bot';
        // As REST names them: a bot is "<slug>[bot]" (GraphQL leaves "[bot]" out). A deleted account: a reviewer of its own.
        const login = author ? `${(author.login as string).toLowerCase()}${isBot ? '[bot]' : ''}` : `ghost:${r.databaseId as number}`;
        const commit = isObject(r.commit) && typeof r.commit.oid === 'string' ? r.commit.oid : '';
        return { id: r.databaseId as number, state: r.state as string, commit, login, own: isBot && login === bot };
      });
    return { head: pr.headRefOid, decision, reviews };
  }

  async ownApprovals(repo: string, number: number): Promise<OwnApproval[]> {
    const reviews = await this.#list(repo, `/pulls/${number}/reviews`, 'reviews');
    // Only this app's bot: another app's review with the same marker is not its own.
    const bot = await this.#botLogin(repo);
    return reviews
      .filter((r) => r.state === 'APPROVED' && typeof r.body === 'string' && r.body.startsWith(MARKER)
        && isObject(r.user) && r.user.type === 'Bot' && typeof r.user.login === 'string' && r.user.login.toLowerCase() === bot
        && typeof r.id === 'number' && typeof r.commit_id === 'string')
      .map((r) => ({ id: r.id as number, commit: r.commit_id as string, marker: (r.body as string).split('\n', 1)[0]! }));
  }

  async diff(repo: string, number: number, max: number): Promise<{ diff: string; truncated: boolean }> {
    let res: Response;
    try {
      res = await this.#send(repo, 'GET', `/pulls/${number}`, 'diff', undefined, 'application/vnd.github.diff');
    } catch (err) {
      // 406: GitHub gives no diff for a very large pull request.
      if (err instanceof GitHubError && err.status === 406) return { diff: '', truncated: true };
      throw err;
    }
    // No body: not known to be empty.
    if (!res.body) return { diff: '', truncated: true };
    // Read only up to the limit, however large the diff is.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    let more = false;
    try {
      while (text.length <= max) {
        const { done, value } = await reader.read();
        if (done) break;
        text += value;
      }
      more = text.length > max;
    } catch (err) {
      throw new GitHubError(`GitHub diff: ${err instanceof Error ? err.name : 'error'}`, true);
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { diff: text.slice(0, max), truncated: more };
  }

  async approve(repo: string, number: number, head: string, body: string): Promise<number> {
    // commit_id: the approval is for the decided commit only, also if a push came in between.
    const review = await this.#call(repo, 'POST', `/pulls/${number}/reviews`, 'review', { commit_id: head, event: 'APPROVE', body });
    if (!isObject(review) || typeof review.id !== 'number') throw new GitHubError('GitHub review: unexpected answer', false);
    return review.id;
  }

  async dismissReview(repo: string, number: number, id: number, message: string): Promise<void> {
    await this.#call(repo, 'PUT', `/pulls/${number}/reviews/${id}/dismissals`, 'dismissal', { message, event: 'DISMISS' });
  }

  async findCheckRun(repo: string, head: string, name: string): Promise<number | undefined> {
    // Filtered by name and app, so one page is the rule; at most 10 are read.
    for (let page = 1; page <= 10; page++) {
      const data = await this.#call(repo, 'GET', `/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&app_id=${this.#appId}&filter=latest&per_page=100&page=${page}`, 'check runs');
      const runs = isObject(data) && Array.isArray(data.check_runs) ? data.check_runs : [];
      const run = runs.find((r) => isObject(r) && r.name === name && isObject(r.app) && r.app.id === this.#appId);
      if (isObject(run) && typeof run.id === 'number') return run.id;
      if (runs.length < 100) return undefined;
    }
    return undefined;
  }

  async createCheckRun(repo: string, head: string, name: string, output: CheckRunOutput): Promise<number> {
    const run = await this.#call(repo, 'POST', '/check-runs', 'check run', { name, head_sha: head, ...checkRunBody(output) });
    if (!isObject(run) || typeof run.id !== 'number') throw new GitHubError('GitHub check run: unexpected answer', false);
    return run.id;
  }

  async updateCheckRun(repo: string, id: number, output: CheckRunOutput): Promise<void> {
    await this.#call(repo, 'PATCH', `/check-runs/${id}`, 'check run', checkRunBody(output));
  }
}

function checkRunBody(o: CheckRunOutput) {
  return {
    status: 'completed',
    conclusion: o.conclusion,
    external_id: o.externalId,
    output: { title: o.title.slice(0, 255), summary: o.summary.slice(0, 60_000), ...(o.text !== undefined && { text: o.text.slice(0, 60_000) }) },
  };
}
