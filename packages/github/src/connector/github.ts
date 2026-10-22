// What the connector reads and writes on GitHub, with the write app's
// installation token, down-scoped to what it needs: read the pull request,
// write check runs, and only when the deployment switched actions on, write
// pull requests (docs/github-connector.md).

import { FactError, FactUnavailableError } from '@pointsman/module-api';
import { GitHubAppAuth, type Scope } from '../provider.ts';
import { GITHUB_TIMEOUT_MS } from '../definition.ts';

const API = 'https://api.github.com';
const USER_AGENT = 'pointsman-github-connector (+https://github.com/geolonia/pointsman)';
const LEVEL = { read: 1, write: 2 } as Record<string, number>;

/** The permissions the connector asks for; each one only up to what the app has. */
export const CONNECTOR_PERMISSIONS: Record<string, 'read' | 'write'> = { metadata: 'read', pull_requests: 'read', checks: 'write' };
/** With actions switched on: comments, labels, review requests and reviews need pull requests: write. */
export const ACTING_PERMISSIONS: Record<string, 'read' | 'write'> = { ...CONNECTOR_PERMISSIONS, pull_requests: 'write' };

/** Each permission it needs, at most at the level the app has; none the app lacks. */
export const connectorScope: Scope = (granted) => scopeOf(CONNECTOR_PERMISSIONS, granted);
export const actingScope: Scope = (granted) => scopeOf(ACTING_PERMISSIONS, granted);

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
}

export interface ConnectorGitHub {
  pullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  /** The id of the app's check run with this name on this commit, if there is one. */
  findCheckRun(repo: string, head: string, name: string): Promise<number | undefined>;
  createCheckRun(repo: string, head: string, name: string, output: CheckRunOutput): Promise<number>;
  updateCheckRun(repo: string, id: number, output: CheckRunOutput): Promise<void>;
  /** Whether the app already wrote a comment with this marker. */
  findComment(repo: string, number: number, marker: string): Promise<boolean>;
  createComment(repo: string, number: number, body: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  requestReviewers(repo: string, number: number, reviewers: string[]): Promise<void>;
  /** Bot approvals still standing (not dismissed) that carry the marker; the caller matches them with the ids it recorded. */
  ownApprovals(repo: string, number: number): Promise<OwnApproval[]>;
  approve(repo: string, number: number, head: string, body: string): Promise<number>;
  dismissReview(repo: string, number: number, id: number, message: string): Promise<void>;
}

/** Every comment and review the connector writes starts with this; with the head and profile it is the action's trace. */
export const MARKER = '<!-- pointsman';
export const markerOf = (head: string, profile: string, kind: string) => `${MARKER} ${kind} ${profile} ${head} -->`;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SHA = /^[0-9a-f]{40}$/;

export class AppGitHub implements ConnectorGitHub {
  readonly #auth: GitHubAppAuth;
  readonly #appId: number;
  readonly #fetch: typeof fetch;

  /** acting: actions are switched on, so the token may write pull requests. */
  constructor(appId: number, privateKey: string, fetchFn: typeof fetch = (u, i) => fetch(u, i), acting = false) {
    // Each token only for the one repository, with only these permissions.
    this.#auth = new GitHubAppAuth(String(appId), privateKey, acting ? actingScope : connectorScope, true);
    this.#appId = appId;
    this.#fetch = fetchFn;
  }

  async #call(repo: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, what: string, body?: unknown): Promise<unknown> {
    const [owner, name] = repo.split('/') as [string, string];
    let token: string;
    try {
      token = await this.#auth.token({ owner, repo: name, number: 0, head: '' }, this.#fetch);
    } catch (err) {
      throw new GitHubError(`GitHub app token: ${err instanceof Error ? err.message : String(err)}`, tokenRetry(err));
    }
    let res: Response;
    try {
      res = await this.#fetch(`${API}/repos/${owner}/${name}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
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
    if (res.status === 204) return null;
    if (res.status >= 200 && res.status < 300) {
      try {
        return await res.json();
      } catch {
        throw new GitHubError(`GitHub ${what}: not JSON`, true);
      }
    }
    await res.body?.cancel();
    // Busy, down or rate limited: later. Anything else (no permission, not found) needs a person.
    const retry = res.status >= 500 || res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
    throw new GitHubError(`GitHub ${what}: ${res.status}`, retry, res.status);
  }

  async pullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const pr = await this.#call(repo, 'GET', `/pulls/${number}`, 'pull request');
    if (!isObject(pr) || !isObject(pr.head) || typeof pr.head.sha !== 'string' || !SHA.test(pr.head.sha) || !isObject(pr.base)) {
      throw new GitHubError('GitHub pull request: unexpected answer', false);
    }
    return {
      open: pr.state === 'open',
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

  async createComment(repo: string, number: number, body: string): Promise<void> {
    await this.#call(repo, 'POST', `/issues/${number}/comments`, 'comment', { body });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#call(repo, 'POST', `/issues/${number}/labels`, 'labels', { labels });
  }

  async requestReviewers(repo: string, number: number, reviewers: string[]): Promise<void> {
    await this.#call(repo, 'POST', `/pulls/${number}/requested_reviewers`, 'review request', { reviewers });
  }

  async ownApprovals(repo: string, number: number): Promise<OwnApproval[]> {
    const reviews = await this.#list(repo, `/pulls/${number}/reviews`, 'reviews');
    return reviews
      .filter((r) => r.state === 'APPROVED' && typeof r.body === 'string' && r.body.startsWith(MARKER)
        && isObject(r.user) && r.user.type === 'Bot' && typeof r.id === 'number' && typeof r.commit_id === 'string')
      .map((r) => ({ id: r.id as number, commit: r.commit_id as string, marker: (r.body as string).split('\n', 1)[0]! }));
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
    output: { title: o.title.slice(0, 255), summary: o.summary.slice(0, 60_000) },
  };
}
