// The review side of a pull request, as the snapshot reads it (provider.ts):
// reviews, conversation comments, commit statuses with their history,
// review threads and review requests. Plain data with the author's login
// and account id, so a fact can accept only a service's real account
// (docs/modules.md, "Facts from reviews and comments"). Also the Copilot
// facts, which need nothing else.

import { FactError } from '@pointsman/module-api';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const time = (v: unknown): string => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : '');

/** An account as GitHub names it: login, account id, and whether it is an app's bot. */
export interface Account {
  login: string;
  id: number | null;
  bot: boolean;
}

function account(v: unknown): Account {
  // A deleted account ("ghost") has no user: nobody a fact accepts.
  if (!isObject(v)) return { login: '', id: null, bot: false };
  return { login: typeof v.login === 'string' ? v.login : '', id: id(v.id ?? v.databaseId), bot: v.type === 'Bot' || v.__typename === 'Bot' };
}

/** A review: who, its state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING), the commit it is on, and when. */
export interface Review {
  /** GitHub's id of the review (REST id, GraphQL databaseId); null when not given. */
  id: number | null;
  by: Account;
  state: string;
  commit: string | null;
  body: string;
  at: string;
}

export function reviews(v: unknown): Review[] {
  if (!Array.isArray(v)) throw new FactError('GitHub reviews: unexpected answer');
  return v.map((r) => {
    if (!isObject(r) || typeof r.state !== 'string') throw new FactError('GitHub reviews: unexpected answer');
    return {
      id: id(r.id),
      by: account(r.user),
      state: r.state,
      commit: typeof r.commit_id === 'string' ? r.commit_id.toLowerCase() : null,
      body: typeof r.body === 'string' ? r.body : '',
      at: time(r.submitted_at),
    };
  });
}

/** A comment in the pull request's conversation. `app`: the GitHub App it was made through, if any. */
export interface Comment {
  /** GitHub's id of the comment (REST id, GraphQL databaseId); null when not given. */
  id: number | null;
  by: Account;
  app: number | null;
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE … */
  association: string;
  body: string;
  created: string;
  updated: string;
}

export function comments(v: unknown): Comment[] {
  if (!Array.isArray(v)) throw new FactError('GitHub comments: unexpected answer');
  return v.map((c) => {
    if (!isObject(c)) throw new FactError('GitHub comments: unexpected answer');
    const app = isObject(c.performed_via_github_app) ? id(c.performed_via_github_app.id) : null;
    return {
      id: id(c.id),
      by: account(c.user),
      app,
      association: typeof c.author_association === 'string' ? c.author_association : 'NONE',
      body: typeof c.body === 'string' ? c.body : '',
      created: time(c.created_at),
      updated: time(c.updated_at ?? c.created_at),
    };
  });
}

/** One status a commit got (its history, not only the latest of each context). */
export interface Status {
  context: string;
  state: string;
  description: string;
  by: Account;
  at: string;
}

export function statusHistory(v: unknown): Status[] {
  if (!Array.isArray(v)) throw new FactError('GitHub statuses: unexpected answer');
  return v.map((s) => {
    if (!isObject(s) || typeof s.context !== 'string' || typeof s.state !== 'string') throw new FactError('GitHub statuses: unexpected answer');
    return { context: s.context, state: s.state, description: typeof s.description === 'string' ? s.description : '', by: account(s.creator), at: time(s.created_at) };
  });
}

/** Review threads and requested reviewers, from GitHub's GraphQL API. */
export interface ReviewState {
  /** Who is asked to review: accounts and teams (a team has login "<org>/<slug>" and bot false). */
  requested: Account[];
  /** Each thread: resolved or not, and who started it. Null when there are more than one page. */
  threads: { resolved: boolean; by: Account }[] | null;
}

export const REVIEW_STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewRequests(first: 100) { totalCount nodes { requestedReviewer { __typename ... on Bot { login databaseId } ... on User { login databaseId } ... on Team { combinedSlug } ... on Mannequin { login } } } }
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved comments(first: 1) { nodes { author { __typename login ... on Bot { databaseId } ... on User { databaseId } } } } } }
    }
  }
}`;

/** The answer to REVIEW_STATE_QUERY, with its head commit (checked by the caller). */
export function reviewState(v: unknown): ReviewState & { head: string } {
  const bad = () => new FactError('GitHub review threads: unexpected answer');
  const pr = isObject(v) && isObject(v.repository) ? v.repository.pullRequest : undefined;
  if (!isObject(pr) || typeof pr.headRefOid !== 'string' || !isObject(pr.reviewRequests) || !isObject(pr.reviewThreads)) throw bad();
  const rr = pr.reviewRequests;
  const rt = pr.reviewThreads;
  if (!Array.isArray(rr.nodes) || typeof rr.totalCount !== 'number' || !Array.isArray(rt.nodes) || !isObject(rt.pageInfo)) throw bad();
  // More requests than one page: who is asked is not known.
  if (rr.totalCount > rr.nodes.length) throw new FactError('GitHub review requests: too many');
  const requested = rr.nodes.map((n): Account => {
    const r = isObject(n) ? n.requestedReviewer : undefined;
    if (!isObject(r)) return { login: '', id: null, bot: false };
    if (r.__typename === 'Team') return { login: typeof r.combinedSlug === 'string' ? r.combinedSlug : '', id: null, bot: false };
    return account(r);
  });
  const threads = rt.pageInfo.hasNextPage === false
    ? rt.nodes.map((t) => {
      if (!isObject(t) || typeof t.isResolved !== 'boolean') throw bad();
      const first = isObject(t.comments) && Array.isArray(t.comments.nodes) ? t.comments.nodes[0] : undefined;
      return { resolved: t.isResolved, by: account(isObject(first) ? first.author : undefined) };
    })
    : null;
  return { head: pr.headRefOid.toLowerCase(), requested, threads };
}

/**
 * Who last edited each comment and review of the pull request (GraphQL):
 * by id, the editor's account, or null when it was never edited. People
 * with write access can edit a bot's comment; the text then is no longer
 * only the bot's.
 */
export interface Editors {
  comments: Map<number, Account | null>;
  reviews: Map<number, Account | null>;
}

export const EDITORS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      comments(last: 100) { totalCount nodes { databaseId editor { __typename login ... on Bot { databaseId } ... on User { databaseId } } } }
      reviews(last: 100) { totalCount nodes { databaseId editor { __typename login ... on Bot { databaseId } ... on User { databaseId } } } }
    }
  }
}`;

/** The answer to EDITORS_QUERY, with its head commit (checked by the caller). More than 100 comments or reviews: a FactError. */
export function editors(v: unknown): Editors & { head: string } {
  const bad = () => new FactError('GitHub editors: unexpected answer');
  const pr = isObject(v) && isObject(v.repository) ? v.repository.pullRequest : undefined;
  if (!isObject(pr) || typeof pr.headRefOid !== 'string') throw bad();
  const read = (conn: unknown, what: string): Map<number, Account | null> => {
    if (!isObject(conn) || typeof conn.totalCount !== 'number' || !Array.isArray(conn.nodes)) throw bad();
    if (conn.totalCount > conn.nodes.length) throw new FactError(`GitHub ${what}: more than ${conn.nodes.length}, their editors are not known`);
    const out = new Map<number, Account | null>();
    for (const n of conn.nodes) {
      const key = isObject(n) ? id(n.databaseId) : null;
      if (key === null) throw bad();
      out.set(key, isObject(n) && isObject(n.editor) ? account(n.editor) : null);
    }
    return out;
  };
  return { head: pr.headRefOid.toLowerCase(), comments: read(pr.comments, 'comments'), reviews: read(pr.reviews, 'reviews') };
}

/** A service's account: its bot's login (as REST names it, with "[bot]") and account id. */
export interface ServiceAccount {
  login: string;
  id: number;
}

/**
 * Whether an account is the service's: the same account id, and the login
 * with or without "[bot]" (GraphQL leaves it out). Logins can be taken by
 * anyone; the id is checked too.
 */
export function isService(a: Account, service: ServiceAccount): boolean {
  if (a.id !== service.id) return false;
  const name = service.login.replace(/\[bot\]$/, '').toLowerCase();
  const login = a.login.toLowerCase();
  return login === name || login === `${name}[bot]`;
}

/** Copilot's code review bot (the same on every repository). */
export const COPILOT: ServiceAccount = { login: 'copilot-pull-request-reviewer[bot]', id: 175728472 };

/** Reviews that decide: approve, request changes, or a dismissed one (which takes back the earlier verdict). */
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** The latest decisive review of these, or undefined. GitHub lists reviews oldest first. */
export function latestVerdict(list: Review[]): Review | undefined {
  return list.filter((r) => DECISIVE.has(r.state)).at(-1);
}

/** The values of a `github_copilot` fact. */
export function copilotFacts(all: Review[], state: ReviewState, head: string): { requested: boolean; reviewed_head: boolean; approved_head: boolean; reviews: number } {
  const own = all.filter((r) => r.state !== 'PENDING' && isService(r.by, COPILOT));
  const verdict = latestVerdict(own);
  return {
    requested: state.requested.some((a) => isService(a, COPILOT)),
    reviewed_head: own.some((r) => r.commit === head),
    approved_head: verdict?.state === 'APPROVED' && verdict.commit === head,
    reviews: own.length,
  };
}
