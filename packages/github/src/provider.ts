// GitHub pull-request facts (FACTS_GITHUB, docs/profile-format.md#github-pull-requests):
//
//   github_pr        the pull request: state, size, author, base, signatures
//   github_paths     changed files that match the fact's path list
//   github_checks    required checks of the base branch on the head commit
//   github_property  a repository custom property
//   github_workflows the GitHub Actions files it changes (workflows.ts)
//   github_release   whether it only moves a version (release.ts)
//   github_bump      whether it only bumps npm dependency versions (bump.ts)
//   github_copilot   Copilot's code review (reviews.ts)
//   github_app_approval whether a GitHub App's approval of the head stands (reviews.ts)
//
// Read-only: this file sends GET requests to the GitHub REST API; GraphQL
// queries for review threads and editors (a POST to /graphql, as GitHub's
// GraphQL API takes; only the queries in reviews.ts, never a mutation: used
// by github_copilot and the CodeRabbit module); and, for a GitHub App, the
// one POST that creates an installation token. github_bump also reads the
// npm registry, without the token (npm.ts). All GitHub
// facts of one decision come from one snapshot: the pull request and its
// commits are read once, then only the parts the facts need, each once.
// If GitHub's head commit is not the one the request names, every GitHub
// fact of the decision is missing ("stale"). Nothing is guessed.

import {
  FactError, FactStaleError, FactUnavailableError,
  type FactProvider, type FactResult, type FactScope,
} from '@pointsman/module-api';
import { APP_SLUG as APP_SLUG_PATTERN, GITHUB_TIMEOUT_MS, RELEASE_CHANGELOGS, type GitHubFactQuery, type PullRequestRef } from './definition';
import { MAX_CODEOWNERS_BYTES, ownerLookup, parseCodeowners } from './codeowners';
import { matchesAny } from './glob';
import { manifestsOf, NOT_RELEASE, onlyVersionMoves, releaseFacts, type ReleaseFacts } from './release';
import { ageInDays, bumpFacts, devOnlyInRepository, manifestsToRead, NO_BUMP, type BumpFacts } from './bump';
import { publishTimes, REGISTRY_TIMEOUT_MS } from './npm';
import {
  actionFolderOf, actionFolders, countWorkflows, kindOf, MAX_FILE_BYTES, MAX_PARSED_FILES, workflowSettings,
  type WorkflowFile, type WorkflowSettings,
} from './workflows';
import {
  appApprovalFacts, comments, copilotFacts, EDITORS_QUERY, editors, REVIEW_STATE_QUERY, reviews, reviewState, statusHistory,
  type Comment, type Editors, type Review, type ReviewState, type Status,
} from './reviews';

const API = 'https://api.github.com';
const USER_AGENT = 'pointsman (+https://github.com/geolonia/pointsman)';
const PER_PAGE = 100;
/** Larger pull requests fail path facts (`error`): 10 calls are enough. GitHub itself lists 3,000. */
export const MAX_FILES = 1000;
/** Pages of the activity list (100 pushes each) read for pushed_by_author; older pushes stay unknown. */
export const MAX_PUSH_PAGES = 5;
/** GitHub lists at most 250 commits of a pull request. */
const MAX_COMMITS = 250;
/** The compare API lists at most this many files. */
const COMPARE_MAX_FILES = 300;
/** Check runs and statuses on the head: more fail `github_checks` (`error`). */
const MAX_CHECKS = 300;
/** Pages of reviews and of comments (100 each) read; a pull request with more fails the facts that need them (`error`). */
export const MAX_REVIEW_PAGES = 5;
/** Pages of the head commit's status history (100 each); more fail the facts that need it. */
export const MAX_STATUS_PAGES = 3;
const DEPENDABOT = 'dependabot[bot]';
/** The account GitHub signs its own commits with (web edits, Dependabot). */
const WEB_FLOW = 'web-flow';
/** The largest package.json github_bump reads. */
export const MAX_MANIFEST_BYTES = 512 * 1024;
/** The package.json files of a repository github_bump reads for dev_only; a repository with more fails the fact. */
export const MAX_REPOSITORY_MANIFESTS = 50;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A GitHub App's slug: lower case letters, digits and hyphens. */
const APP_SLUG = new RegExp(APP_SLUG_PATTERN);
const PASSED = new Set(['success', 'neutral', 'skipped']);
/** A repository as "owner/name"; "." and ".." are not names. */
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A team owner "@org/slug"; "." and ".." are not slugs (they would change the API path). */
const TEAM = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(?!\.\.?$)([A-Za-z0-9._-]{1,100})$/;
/** Where GitHub looks for CODEOWNERS, in its order. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

// ---- authentication ----

/** Gives a token for the repositories of one owner. Never logged. */
export interface GitHubAuth {
  token(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string>;
}

/** One token for every repository (FACTS_GITHUB "token"). */
export class TokenAuth implements GitHubAuth {
  private readonly value: string;
  constructor(token: string) {
    this.value = token;
  }
  async token(): Promise<string> {
    return this.value;
  }
}

const b64url = (bytes: Uint8Array | string): string => {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** DER length bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/** A PKCS#1 RSA key (GitHub's "BEGIN RSA PRIVATE KEY") wrapped as PKCS#8, which WebCrypto reads. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  // AlgorithmIdentifier: rsaEncryption, NULL parameters.
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(pkcs1.length)];
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  const total = body.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(total), ...body, ...pkcs1]);
  return out;
}

/** The key's DER bytes as PKCS#8, from a PEM in either format; null when it is not one. */
export function privateKeyDer(pem: string): Uint8Array<ArrayBuffer> | null {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
  if (!m || Boolean(m[1]) !== Boolean(m[3])) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(m[2]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 64) return null;
  return m[1] ? pkcs1ToPkcs8(bytes) : bytes;
}

/** Permissions GitHub has only as "write"; a read-only token leaves them out. */
const WRITE_ONLY = new Set(['workflows']);

/** The permissions of a token, from those the installation has. */
export type Scope = (granted: Record<string, string>) => Record<string, string>;

/**
 * What the facts read (docs/github-connector.md): pull requests, files,
 * checks, statuses, workflow runs, custom properties, organization members.
 */
export const FACTS_PERMISSIONS = ['metadata', 'contents', 'pull_requests', 'checks', 'statuses', 'actions', 'repository_custom_properties', 'members'];

/** The facts' scope: of the permissions the facts use, those the installation has, as "read" only. */
export const readOnly: Scope = (granted) =>
  Object.fromEntries(FACTS_PERMISSIONS.filter((p) => granted[p] !== undefined && !WRITE_ONLY.has(p)).map((p) => [p, 'read']));

/**
 * A GitHub App (FACTS_GITHUB "app"): signs a JWT with the app's private key,
 * finds the app's installation for the repository and creates an
 * installation token, kept until five minutes before it expires (one hour).
 * The token is down-scoped (default: read-only, whatever the app may do),
 * so even an app with write permissions gives the facts a token that only
 * reads. The app for facts should still have read permissions only
 * (docs/github-connector.md).
 */
export class GitHubAppAuth implements GitHubAuth {
  private readonly appId: string;
  private readonly der: Uint8Array<ArrayBuffer>;
  private readonly scope: Scope;
  private readonly perRepository: boolean;
  private key: Promise<CryptoKey> | undefined;
  private readonly tokens = new Map<string, { token: Promise<string>; until: number }>();
  /** The app's slug, as each installation's answer names it. */
  private readonly slugs = new Map<string, string>();
  /** The clock (tests set it). */
  now: () => number = () => Date.now();

  /** perRepository: each token only for the one repository (the connector's); default one per owner (the facts read org data too). */
  constructor(appId: string, privateKeyPem: string, scope: Scope = readOnly, perRepository = false) {
    const der = privateKeyDer(privateKeyPem);
    if (!der) throw new Error('not a PEM private key');
    this.appId = appId;
    this.der = der;
    this.scope = scope;
    this.perRepository = perRepository;
  }

  private key_(pr: PullRequestRef): string {
    return (this.perRepository ? `${pr.owner}/${pr.repo}` : pr.owner).toLowerCase();
  }

  private async jwt(): Promise<string> {
    this.key ??= crypto.subtle.importKey('pkcs8', this.der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    let key: CryptoKey;
    try {
      key = await this.key;
    } catch {
      this.key = undefined;
      throw new FactError('the GitHub App key cannot be read');
    }
    const now = Math.floor(this.now() / 1000);
    // Issued a minute early against clock drift; GitHub allows at most 10 minutes.
    const payload = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }))}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
    return `${payload}.${b64url(new Uint8Array(signature))}`;
  }

  token(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string> {
    // One installation per owner.
    const id = this.key_(pr);
    const cached = this.tokens.get(id);
    if (cached && cached.until > this.now()) return cached.token;
    const entry = { token: this.create(pr, fetchFn), until: this.now() + 60_000 };
    this.tokens.set(id, entry);
    entry.token.then(
      () => undefined,
      () => { if (this.tokens.get(id) === entry) this.tokens.delete(id); },
    );
    return entry.token;
  }

  /**
   * The app's slug, from the installation's answer (its bot is
   * "<slug>[bot]"). Gets a token first when none was made yet; a FactError
   * when GitHub did not name it.
   */
  async slug(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string> {
    await this.token(pr, fetchFn);
    const slug = this.slugs.get(this.key_(pr));
    if (!slug) throw new FactError('GitHub installation: no app slug');
    return slug;
  }

  private async create(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string> {
    const jwt = await this.jwt();
    const signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    const installation = await getJson(fetchFn, `/repos/${pr.owner}/${pr.repo}/installation`, jwt, signal, 'installation');
    const { id: installationId, permissions: granted, app_slug: slug } = installation as { id?: unknown; permissions?: unknown; app_slug?: unknown };
    if (typeof installationId !== 'number') throw new FactError('GitHub installation: unexpected answer');
    if (typeof slug === 'string' && APP_SLUG.test(slug)) this.slugs.set(this.key_(pr), slug);
    const permissions = this.scope(isObject(granted) ? Object.fromEntries(Object.entries(granted).filter((e): e is [string, string] => typeof e[1] === 'string')) : {});
    if (Object.keys(permissions).length === 0) throw new FactError('GitHub installation: the app has none of the permissions needed');
    // The only request that is not a GET: it creates a token, it changes no repository.
    const res = await fetchFn(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST', headers: { ...headers(jwt), 'content-type': 'application/json' }, body: JSON.stringify({ permissions, ...(this.perRepository && { repositories: [pr.repo] }) }), redirect: 'manual', signal,
    });
    const body = await readJson(res, 'installation token');
    const { token, expires_at: expiresAt } = body as { token?: unknown; expires_at?: unknown };
    const until = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (typeof token !== 'string' || token === '' || !Number.isFinite(until)) throw new FactError('GitHub installation token: unexpected answer');
    const entry = this.tokens.get(this.key_(pr));
    if (entry) entry.until = until - 5 * 60_000;
    return token;
  }
}

// ---- requests ----

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
}

/** The JSON body of a 2xx answer; otherwise a FactError that names `what` and the status (never the token). */
async function readJson(res: Response, what: string): Promise<unknown> {
  if (res.status >= 200 && res.status < 300) {
    try {
      return await res.json();
    } catch {
      throw new FactError(`GitHub ${what}: not JSON`);
    }
  }
  await res.body?.cancel();
  // Redirects are not followed: they would carry the token to another place.
  if (res.status >= 300 && res.status < 400) throw new FactError(`GitHub ${what}: redirect ${res.status} not followed`);
  // A secondary rate limit is a 403 with retry-after.
  if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
    throw new FactError(`GitHub ${what}: rate limited (${res.status})`);
  }
  // Not there, or this token may not see it: the facts are unavailable for it.
  if (res.status === 404 || res.status === 403) throw new FactUnavailableError(`GitHub ${what}: ${res.status}`);
  throw new FactError(`GitHub ${what}: ${res.status}`);
}

/** The way this file reads GitHub's REST API: a GET. */
function get(fetchFn: typeof fetch, path: string, token: string, signal: AbortSignal): Promise<Response> {
  return fetchFn(`${API}${path}`, { method: 'GET', headers: headers(token), redirect: 'manual', signal });
}

async function getJson(fetchFn: typeof fetch, path: string, token: string, signal: AbortSignal, what: string): Promise<unknown> {
  return readJson(await get(fetchFn, path, token, signal), what);
}

/**
 * A GraphQL query (GitHub's GraphQL API takes a POST). Only queries this
 * file defines, never a mutation; their `data`, or a FactError when GitHub
 * answers with errors.
 */
async function graphql(fetchFn: typeof fetch, query: string, variables: Record<string, unknown>, token: string, signal: AbortSignal, what: string): Promise<unknown> {
  if (!/^query\b/.test(query)) throw new FactError('only GraphQL queries are sent');
  const res = await fetchFn(`${API}/graphql`, {
    method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), redirect: 'manual', signal,
  });
  const body = await readJson(res, what);
  if (!isObject(body) || (body.errors !== undefined && body.errors !== null) || !isObject(body.data)) throw new FactError(`GitHub ${what}: unexpected answer`);
  return body.data;
}

// ---- answers ----

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface PullRequest {
  open: boolean;
  merged: boolean;
  draft: boolean;
  title: string;
  /** The description; empty when there is none. */
  body: string;
  head: string;
  /** The head branch and its repository ("owner/name"; null when a fork was deleted). */
  headRef: string;
  headRepo: string | null;
  fork: boolean;
  base: string;
  /** The base branch's commit as GitHub shows it with the pull request; null when not given. */
  baseSha: string | null;
  defaultBranch: string;
  repoId: number;
  ownerIsOrg: boolean;
  author: string;
  authorIsBot: boolean;
  changedLines: number;
  files: number;
  commits: number;
}

function pullRequest(v: unknown): PullRequest {
  const bad = () => new FactError('GitHub pull request: unexpected answer');
  if (!isObject(v) || !isObject(v.head) || !isObject(v.base) || !isObject(v.user) || !isObject(v.base.repo) || !isObject(v.base.repo.owner)) throw bad();
  const { head, base, user } = v;
  const baseRepo = v.base.repo;
  const headRepo = head.repo;
  const n = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null);
  const pr = {
    open: v.state === 'open',
    merged: v.merged,
    draft: v.draft,
    title: v.title,
    head: typeof head.sha === 'string' ? head.sha.toLowerCase() : null,
    headRef: head.ref,
    headRepo: isObject(headRepo) && typeof headRepo.full_name === 'string' && FULL_NAME.test(headRepo.full_name) ? headRepo.full_name : null,
    // A fork that was deleted has no head repository: treat it as a fork.
    fork: !isObject(headRepo) || headRepo.id !== baseRepo.id,
    base: base.ref,
    baseSha: typeof base.sha === 'string' && /^[0-9a-f]{40}$/i.test(base.sha) ? base.sha.toLowerCase() : null,
    defaultBranch: baseRepo.default_branch,
    ownerIsOrg: (baseRepo.owner as Record<string, unknown>).type === 'Organization',
    author: user.login,
    authorIsBot: user.type === 'Bot',
    additions: n(v.additions),
    deletions: n(v.deletions),
    files: n(v.changed_files),
    commits: n(v.commits),
  };
  if (typeof v.state !== 'string' || typeof pr.merged !== 'boolean' || typeof pr.draft !== 'boolean' || typeof pr.title !== 'string'
    || pr.head === null || typeof pr.headRef !== 'string' || typeof pr.base !== 'string' || typeof pr.defaultBranch !== 'string' || typeof pr.author !== 'string'
    || pr.additions === null || pr.deletions === null || pr.files === null || pr.commits === null || typeof baseRepo.id !== 'number') throw bad();
  return {
    open: pr.open, merged: pr.merged, draft: pr.draft, title: pr.title, body: typeof v.body === 'string' ? v.body : '', head: pr.head, headRef: pr.headRef, headRepo: pr.headRepo, fork: pr.fork,
    base: pr.base, baseSha: pr.baseSha, defaultBranch: pr.defaultBranch, repoId: baseRepo.id as number, ownerIsOrg: pr.ownerIsOrg, author: pr.author, authorIsBot: pr.authorIsBot,
    changedLines: pr.additions + pr.deletions, files: pr.files, commits: pr.commits,
  };
}

/** "WIP" as a word in the title, for example "WIP: …", "[WIP] …", "… (wip)". */
export const isWipTitle = (title: string): boolean => /(^|[^A-Za-z0-9])wip([^A-Za-z0-9]|$)/i.test(title);

/** A commit: whether its signature is verified, and whether Dependabot made it and GitHub signed it. */
interface Commit { sha: string; verified: boolean; byDependabot: boolean }

function commits(v: unknown): Commit[] {
  if (!Array.isArray(v)) throw new FactError('GitHub commits: unexpected answer');
  return v.map((c) => {
    if (!isObject(c) || typeof c.sha !== 'string' || !isObject(c.commit)) throw new FactError('GitHub commits: unexpected answer');
    const verification = c.commit.verification;
    // The GitHub accounts of the commit's author and committer (null when the email belongs to none).
    const author = isObject(c.author) ? c.author : null;
    const committer = isObject(c.committer) ? c.committer : null;
    const byDependabot = author?.login === DEPENDABOT && author.type === 'Bot' && committer?.login === WEB_FLOW;
    return { sha: c.sha.toLowerCase(), verified: isObject(verification) && verification.verified === true, byDependabot };
  });
}

/**
 * Whether every commit is verified. For a pull request by Dependabot, each
 * commit must also be Dependabot's own: authored by dependabot[bot] and
 * committed (so signed) by GitHub, not a commit someone else added and
 * signed with their own key.
 */
export function allVerified(list: Commit[], dependabot: boolean): boolean {
  return list.every((c) => c.verified && (!dependabot || c.byDependabot));
}

/** A changed file: its name, then its earlier name when it was renamed. */
interface Change { names: string[]; removed: boolean; status: string; patch: string | null }

/** Changed files of one page; a renamed file counts with both names. */
function changedFiles(v: unknown): Change[] {
  if (!Array.isArray(v)) throw new FactError('GitHub files: unexpected answer');
  return v.map((f) => {
    if (!isObject(f) || typeof f.filename !== 'string') throw new FactError('GitHub files: unexpected answer');
    const names = typeof f.previous_filename === 'string' ? [f.filename, f.previous_filename] : [f.filename];
    return { names, removed: f.status === 'removed', status: typeof f.status === 'string' ? f.status : '', patch: typeof f.patch === 'string' ? f.patch : null };
  });
}

/** A file of a commit's tree. */
interface TreeFile { sha: string; size: number }

/** The files of a recursive tree, by path. A tree GitHub cut short fails the fact. */
function treeFiles(v: unknown): Map<string, TreeFile> {
  if (!isObject(v) || !Array.isArray(v.tree) || typeof v.truncated !== 'boolean') throw new FactError('GitHub tree: unexpected answer');
  if (v.truncated) throw new FactError('the repository tree is too large to read');
  const out = new Map<string, TreeFile>();
  for (const e of v.tree) {
    if (!isObject(e) || typeof e.path !== 'string' || typeof e.type !== 'string') throw new FactError('GitHub tree: unexpected answer');
    if (e.type !== 'blob') continue;
    if (typeof e.sha !== 'string' || typeof e.size !== 'number') throw new FactError('GitHub tree: unexpected answer');
    out.set(e.path, { sha: e.sha, size: e.size });
  }
  return out;
}

/** A required check: its name, and the app that must report it (null: any). */
type Required = { context: string; app: number | null };
/** A workflow that a ruleset requires: its path, the repository it comes from, and the ref or commit it runs at. */
type RequiredWorkflow = { path: string; repository: number | null; ref: string };

/**
 * The workflows the rulesets require, each once. A workflow run names its
 * file by path only (workflowRuns), so two required workflows with the same
 * path from another repository or ref could not be told apart: one run would
 * count for both. That fails the fact instead.
 */
function requiredWorkflows(v: unknown): RequiredWorkflow[] {
  if (!Array.isArray(v)) throw new FactError('GitHub rules: unexpected answer');
  const out = new Map<string, RequiredWorkflow>();
  for (const rule of v) {
    if (!isObject(rule) || rule.type !== 'workflows') continue;
    const workflows = isObject(rule.parameters) ? rule.parameters.workflows : undefined;
    if (!Array.isArray(workflows)) throw new FactError('GitHub rules: unexpected answer');
    for (const w of workflows) {
      if (!isObject(w) || typeof w.path !== 'string') throw new FactError('GitHub rules: unexpected answer');
      const found: RequiredWorkflow = {
        path: w.path,
        repository: typeof w.repository_id === 'number' ? w.repository_id : null,
        ref: typeof w.sha === 'string' ? w.sha : typeof w.ref === 'string' ? w.ref : '',
      };
      const same = out.get(found.path);
      if (same && (same.repository !== found.repository || same.ref !== found.ref)) {
        throw new FactError(`GitHub rules: two required workflows have the path ${found.path}`);
      }
      out.set(found.path, found);
    }
  }
  return [...out.values()];
}

function requiredFromRules(v: unknown): Required[] {
  if (!Array.isArray(v)) throw new FactError('GitHub rules: unexpected answer');
  const out: Required[] = [];
  for (const rule of v) {
    if (!isObject(rule) || rule.type !== 'required_status_checks') continue;
    const checks = isObject(rule.parameters) ? rule.parameters.required_status_checks : undefined;
    if (!Array.isArray(checks)) throw new FactError('GitHub rules: unexpected answer');
    for (const c of checks) {
      if (!isObject(c) || typeof c.context !== 'string') throw new FactError('GitHub rules: unexpected answer');
      out.push({ context: c.context, app: typeof c.integration_id === 'number' ? c.integration_id : null });
    }
  }
  return out;
}

function requiredFromBranch(v: unknown): Required[] {
  if (!isObject(v)) throw new FactError('GitHub branch: unexpected answer');
  // A protected branch whose protection this token cannot see: its required checks are not known.
  if (v.protected === true && !isObject(v.protection)) throw new FactUnavailableError('GitHub branch: protection not visible');
  const rsc = isObject(v.protection) ? v.protection.required_status_checks : undefined;
  if (!isObject(rsc)) return [];
  if (Array.isArray(rsc.checks)) {
    // app_id -1 or null: any app may report it.
    return rsc.checks.filter(isObject).filter((c) => typeof c.context === 'string')
      .map((c) => ({ context: c.context as string, app: typeof c.app_id === 'number' && c.app_id > 0 ? c.app_id : null }));
  }
  return Array.isArray(rsc.contexts) ? rsc.contexts.filter((c): c is string => typeof c === 'string').map((context) => ({ context, app: null })) : [];
}

type Result = 'passed' | 'pending' | 'failed';
interface Run { name: string; app: number | null; result: Result; at: string }

function checkRuns(v: unknown): { total: number; runs: Run[] } {
  if (!isObject(v) || typeof v.total_count !== 'number' || !Array.isArray(v.check_runs)) throw new FactError('GitHub check runs: unexpected answer');
  return {
    total: v.total_count,
    runs: v.check_runs.map((r) => {
      if (!isObject(r) || typeof r.name !== 'string') throw new FactError('GitHub check runs: unexpected answer');
      const result: Result = r.status !== 'completed' ? 'pending' : PASSED.has(String(r.conclusion)) ? 'passed' : 'failed';
      return { name: r.name, app: isObject(r.app) && typeof r.app.id === 'number' ? r.app.id : null, result, at: String(r.started_at ?? '') };
    }),
  };
}

function statuses(v: unknown): { total: number; runs: Run[] } {
  if (!isObject(v) || typeof v.total_count !== 'number' || !Array.isArray(v.statuses)) throw new FactError('GitHub statuses: unexpected answer');
  return {
    total: v.total_count,
    runs: v.statuses.map((s) => {
      if (!isObject(s) || typeof s.context !== 'string') throw new FactError('GitHub statuses: unexpected answer');
      const result: Result = s.state === 'success' ? 'passed' : s.state === 'pending' ? 'pending' : 'failed';
      return { name: s.context, app: null, result, at: String(s.updated_at ?? '') };
    }),
  };
}

interface WorkflowRun { path: string; required: boolean; result: Result; at: string }

function workflowRuns(v: unknown): { total: number; runs: WorkflowRun[] } {
  if (!isObject(v) || typeof v.total_count !== 'number' || !Array.isArray(v.workflow_runs)) throw new FactError('GitHub workflow runs: unexpected answer');
  return {
    total: v.total_count,
    runs: v.workflow_runs.map((r) => {
      if (!isObject(r) || typeof r.path !== 'string') throw new FactError('GitHub workflow runs: unexpected answer');
      const result: Result = r.status !== 'completed' ? 'pending' : PASSED.has(String(r.conclusion)) ? 'passed' : 'failed';
      return {
        // The workflow file's path as a ruleset names it: without "@<ref>", and without the
        // "<owner>/<repo>/" that GitHub puts before a workflow from another repository.
        path: r.path.replace(/@.*$/, '').replace(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/(?=\.github\/workflows\/)/, ''),
        required: typeof r.workflow_url === 'string' && r.workflow_url.includes('/actions/required_workflows/'),
        result,
        at: String(r.created_at ?? ''),
      };
    }),
  };
}

/** The value of a custom property as text; "unset" when it has none. */
function propertyValue(v: unknown, name: string): string {
  if (!Array.isArray(v)) throw new FactError('GitHub custom properties: unexpected answer');
  const p = v.find((x) => isObject(x) && x.property_name === name) as Record<string, unknown> | undefined;
  const value = p?.value;
  if (value === undefined || value === null || value === '') return 'unset';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return value.length === 0 ? 'unset' : [...value].sort().join(',');
  throw new FactError('GitHub custom properties: unexpected answer');
}

/** A push to the head branch, from the repository activity list. `created`: the push that created the branch. */
interface Push { before: string; after: string; actor: string; at: string; created: boolean }

function pushes(v: unknown): Push[] {
  if (!Array.isArray(v)) throw new FactError('GitHub activity: unexpected answer');
  return v.map((a) => {
    if (!isObject(a) || typeof a.after !== 'string' || typeof a.before !== 'string') throw new FactError('GitHub activity: unexpected answer');
    // A deleted account has no login: it is not the author.
    const actor = isObject(a.actor) && typeof a.actor.login === 'string' ? a.actor.login : '';
    return { before: a.before.toLowerCase(), after: a.after.toLowerCase(), actor, at: String(a.timestamp ?? ''), created: a.activity_type === 'branch_creation' };
  });
}

/**
 * Who pushed the pull request's commits: "yes" when every commit came in a
 * push by the author, "no" when one came in a push by someone else, and
 * "unavailable" otherwise (pushes older than the activity list, or more
 * commits than GitHub lists). A push brings the commits after its "before"
 * commit up to its head; when "before" is not one of the pull request's
 * commits (a new branch, a force push), every commit up to its head that no
 * earlier push brought.
 */
export function pushedByAuthor(commits: { sha: string }[] | null, list: Push[] | null, author: string): 'yes' | 'no' | 'unavailable' {
  if (!commits || !list) return 'unavailable';
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  const by = new Map<number, string>();
  // The list is newest first: reversed, pushes in the same second keep their real order (the sort is stable).
  for (const push of [...list].reverse().sort((a, b) => a.at.localeCompare(b.at))) {
    const k = index.get(push.after);
    if (k === undefined) continue;
    // Commits up to "before" came earlier, maybe in a push older than the list.
    const stop = index.get(push.before) ?? -1;
    for (let j = k; j > stop && !by.has(j); j--) by.set(j, push.actor.toLowerCase());
  }
  if ([...by.values()].some((actor) => actor !== author.toLowerCase())) return 'no';
  return commits.length > 0 && by.size === commits.length ? 'yes' : 'unavailable';
}

/** The "after" cursor of a Link header's next page; null when there is none. Only the cursor is used, never the URL. */
export function nextCursor(link: string | null): string | null {
  const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
  if (!m) return null;
  try {
    const after = new URL(m[1]!).searchParams.get('after');
    return after && after.length <= 500 ? after : null;
  } catch {
    return null;
  }
}

/**
 * A change as text that two changes can be compared by, like `git
 * patch-id`: per file its path, status, earlier name, and every line of its
 * patch (context, removed and added lines, in order, with a mark where each
 * hunk starts). The hunks' line numbers are kept, except in the files of
 * `loose`, which the base changed between the two changes (a rebase moves
 * the lines there): sameChange has checked the places there itself. Null when a file has no patch (binary, too large, or a rename
 * without changes).
 */
export function changeSignature(files: unknown[], loose: ReadonlySet<string> = new Set()): string | null {
  const out: { path: string; status: string | null; from: string | null; lines: string[] }[] = [];
  for (const f of files) {
    if (!isObject(f) || typeof f.filename !== 'string') throw new FactError('GitHub compare: unexpected answer');
    if (typeof f.patch !== 'string') return null;
    // "@@ -12,3 +14,4 @@ function name": in a loose file the numbers go, the mark (and the text after it) stays.
    const lines = loose.has(f.filename)
      ? f.patch.split('\n').map((line) => (line.startsWith('@@') ? line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, '@@') : line))
      : f.patch.split('\n');
    out.push({ path: f.filename, status: typeof f.status === 'string' ? f.status : null, from: typeof f.previous_filename === 'string' ? f.previous_filename : null, lines });
  }
  return JSON.stringify(out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** Each hunk's start and length on the old side of a patch ("@@ -start,length ..."), in order. */
export function hunkRanges(patch: string): { start: number; length: number }[] {
  const out: { start: number; length: number }[] = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) out.push({ start: Number(m[1]), length: m[2] === undefined ? 1 : Number(m[2]) });
  return out;
}

/**
 * Where lines `start`..`start + length - 1` of a file are after the base's
 * own change of that file (its patch from one merge base to the other); null
 * when the base changed any of them, so the place cannot be followed.
 */
export function movedStart(start: number, length: number, basePatch: string): number | null {
  const end = start + Math.max(length, 1) - 1;
  let offset = 0;
  for (const m of basePatch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) {
    const a = Number(m[1]);
    const removed = m[2] === undefined ? 1 : Number(m[2]);
    const added = m[3] === undefined ? 1 : Number(m[3]);
    if (removed === 0) {
      // Lines inserted after line a.
      if (a < start) offset += added;
      else if (a >= end) break;
      else return null;
    } else if (a + removed - 1 < start) offset += added - removed;
    else if (a > end) break;
    else return null;
  }
  return start + offset;
}

const base64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));

// ---- the snapshot ----

/** Pages 1..n of a list, read at the same time. */
const pages = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/**
 * One decision's reads of one pull request at one head commit. Shared by
 * every GitHub-based fact of the decision, also those of other modules
 * (snapshotOf), so they describe the same moment and read GitHub once.
 */
export class Snapshot {
  private readonly parts = new Map<string, Promise<unknown>>();
  /** The pull request and its commits, checked against the requested head. */
  readonly base: Promise<{ pr: PullRequest; commits: Commit[] | null }>;
  private readonly signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  private readonly token: Promise<string>;
  private readonly ref: PullRequestRef;
  private readonly fetchFn: typeof fetch;

  constructor(ref: PullRequestRef, fetchFn: typeof fetch, auth: GitHubAuth) {
    this.ref = ref;
    this.fetchFn = fetchFn;
    this.token = auth.token(ref, fetchFn);
    this.base = this.loadBase();
    // Every fact awaits base; this keeps an unawaited failure from being reported twice.
    this.base.catch(() => undefined);
  }

  private get repoPath(): string {
    return `/repos/${this.ref.owner}/${this.ref.repo}`;
  }

  private async json(path: string, what: string): Promise<unknown> {
    return getJson(this.fetchFn, path, await this.token, this.signal, what);
  }

  /** A page of a list, and the cursor of the next page from the Link header. */
  private async page(path: string, what: string): Promise<{ body: unknown; next: string | null }> {
    const res = await get(this.fetchFn, path, await this.token, this.signal);
    const next = nextCursor(res.headers.get('link'));
    return { body: await readJson(res, what), next };
  }

  private async loadBase(): Promise<{ pr: PullRequest; commits: Commit[] | null }> {
    const path = `${this.repoPath}/pulls/${this.ref.number}`;
    // The first page of commits with the pull request: both are checked against the head.
    const [prJson, first] = await Promise.all([
      this.json(path, 'pull request'),
      this.json(`${path}/commits?per_page=${PER_PAGE}&page=1`, 'commits'),
    ]);
    const pr = pullRequest(prJson);
    if (pr.head !== this.ref.head) throw new FactStaleError('the pull request has another head commit');
    let list = commits(first);
    if (pr.commits > MAX_COMMITS) return { pr, commits: null };
    if (pr.commits > PER_PAGE) {
      const rest = await Promise.all(pages(Math.ceil(pr.commits / PER_PAGE)).slice(1)
        .map(async (p) => commits(await this.json(`${path}/commits?per_page=${PER_PAGE}&page=${p}`, 'commits'))));
      list = [...list, ...rest.flat()];
    }
    // The list ends with the head; otherwise the pull request changed while it was read.
    if (list.length === 0 || list[list.length - 1]!.sha !== this.ref.head) throw new FactStaleError('the commits end with another head commit');
    if (list.length !== pr.commits) throw new FactError('GitHub commits: the list does not match the pull request');
    return { pr, commits: list };
  }

  private part<T>(name: string, load: () => Promise<T>): Promise<T> {
    let p = this.parts.get(name) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.parts.set(name, p);
    }
    return p;
  }

  /** The changed paths, one entry per file (a renamed file has both names). */
  async files(): Promise<string[][]> {
    return (await this.changes()).map((c) => c.names);
  }

  /**
   * github_release (release.ts): from the changed files and their patches,
   * then, for a version-only change, each changed package.json at the head.
   */
  async release(changelogs: string[], versionFiles: string[], textFiles: string[]): Promise<ReleaseFacts> {
    const files = await this.changes();
    const facts = releaseFacts(files, changelogs, versionFiles, textFiles);
    const manifests = manifestsOf(files);
    if (!facts.version_only || manifests.length === 0) return facts;
    const heads = new Map(await Promise.all(manifests.map(async (path) => [path, await this.textAtHead(path)] as const)));
    return onlyVersionMoves(files, heads, facts.from, facts.to) ? facts : NOT_RELEASE;
  }

  /**
   * A file's text at the head commit, by the contents API; null when it is
   * not UTF-8 text. Larger than MAX_MANIFEST_BYTES fails the fact.
   */
  private textAtHead(path: string): Promise<string | null> {
    return this.textAt(path, this.ref.head);
  }

  /** A file's text at a commit, as textAtHead. */
  private textAt(path: string, sha: string): Promise<string | null> {
    return this.part(`text:${sha}:${path}`, async () => {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const v = await this.json(`${this.repoPath}/contents/${encoded}?ref=${sha}`, 'file');
      if (!isObject(v) || v.type !== 'file' || v.encoding !== 'base64' || typeof v.content !== 'string') throw new FactError('GitHub file: unexpected answer');
      const tooLarge = new FactError(`GitHub file: larger than ${MAX_MANIFEST_BYTES} bytes`);
      if ((typeof v.size === 'number' && v.size > MAX_MANIFEST_BYTES) || v.content.length > MAX_MANIFEST_BYTES * 2) throw tooLarge;
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64Bytes(v.content));
      } catch {
        return null;
      }
    });
  }

  /**
   * github_bump (bump.ts): the changed files, then each changed package.json
   * at the head, then the publish time of each bumped version from the npm
   * registry and, when the rest says dev only, every other package.json of
   * the repository at the head (the tree, then each file). Not a bump:
   * NO_BUMP, and nothing past the file list is read.
   */
  bump(now: number): Promise<BumpFacts> {
    return this.part('bump', async () => {
      const files = await this.changes();
      const manifests = manifestsToRead(files);
      if (!manifests) return NO_BUMP;
      const heads = new Map<string, string>();
      await Promise.all(manifests.map(async (path) => {
        const text = await this.textAtHead(path);
        if (text === null) throw new FactError('GitHub file: a package.json that is not UTF-8 text');
        heads.set(path, text);
      }));
      const found = bumpFacts(files, heads);
      if (!found) return NO_BUMP;
      const [ages, devOnly] = await Promise.all([
        this.releaseAges(found.versions, now),
        found.facts.dev_only ? this.repositoryDevOnly(heads, new Set(found.devNames)) : Promise.resolve(false),
      ]);
      // No version to look up (no spec understood, so semver is "none"): the strictest age.
      return { ...found.facts, dev_only: devOnly, release_age_days: ages.length > 0 ? Math.min(...ages) : 0 };
    });
  }

  /** The age in days of each version, from the npm registry. */
  private async releaseAges(found: { name: string; version: string }[], now: number): Promise<number[]> {
    // One limit for every registry read; the first failure stops the others (the fact is missing anyway).
    const stop = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(REGISTRY_TIMEOUT_MS), stop.signal]);
    const byName = new Map<string, string[]>();
    for (const { name, version } of found) byName.set(name, [...(byName.get(name) ?? []), version]);
    let times: number[][];
    try {
      times = await Promise.all([...byName].map(async ([name, versions]) => [...(await publishTimes(this.fetchFn, name, versions, signal)).values()]));
    } finally {
      stop.abort();
    }
    return times.flat().map((ms) => ageInDays(ms, now));
  }

  /**
   * Whether no package.json of the repository at the head lists one of
   * `names` outside devDependencies: the recursive tree (cut short fails
   * the fact), then each package.json not read already, by its blob. More
   * than MAX_REPOSITORY_MANIFESTS, or one larger than MAX_MANIFEST_BYTES,
   * fails the fact.
   */
  private async repositoryDevOnly(heads: Map<string, string>, names: Set<string>): Promise<boolean> {
    const tree = await this.tree(this.ref.head);
    const found = [...tree].filter(([path]) => path === 'package.json' || path.endsWith('/package.json'));
    // Every changed package.json is in the tree at the head; one that is not cannot be placed.
    if ([...heads.keys()].some((path) => !tree.has(path))) throw new FactError('GitHub tree: a changed package.json is not in the tree');
    if (found.length > MAX_REPOSITORY_MANIFESTS) throw new FactError(`more than ${MAX_REPOSITORY_MANIFESTS} package.json files in the repository`);
    const texts = await Promise.all(found.map(async ([path, file]) => {
      const known = heads.get(path);
      if (known !== undefined) return known;
      if (file.size > MAX_MANIFEST_BYTES) throw new FactError(`GitHub file: larger than ${MAX_MANIFEST_BYTES} bytes`);
      return this.blob(file.sha);
    }));
    return devOnlyInRepository(texts, names);
  }

  /** The changed files, with their names and whether they were removed. */
  private changes(): Promise<Change[]> {
    return this.part('files', async () => {
      const { pr } = await this.base;
      if (pr.files > MAX_FILES) throw new FactError(`the pull request changes more than ${MAX_FILES} files`);
      const all = (await Promise.all(pages(Math.ceil(pr.files / PER_PAGE)).map(async (p) =>
        changedFiles(await this.json(`${this.repoPath}/pulls/${this.ref.number}/files?per_page=${PER_PAGE}&page=${p}`, 'files'))))).flat();
      if (all.length !== pr.files) throw new FactError('GitHub files: the list does not match the pull request');
      // The file list is the pull request's current one, not the one at a commit:
      // read the head once more, so a push in between makes the facts stale.
      const again = pullRequest(await this.json(`${this.repoPath}/pulls/${this.ref.number}`, 'pull request'));
      if (again.head !== this.ref.head) throw new FactStaleError('the pull request changed while its files were read');
      return all;
    });
  }

  /** Whether the author is a member of the owning organization; null when GitHub does not tell. */
  member(): Promise<boolean | null> {
    return this.part('member', async () => {
      const { pr } = await this.base;
      if (pr.authorIsBot) return false;
      if (!pr.ownerIsOrg) return pr.author.toLowerCase() === this.ref.owner.toLowerCase();
      if (!LOGIN.test(pr.author)) return null;
      const res = await get(this.fetchFn, `/orgs/${this.ref.owner}/members/${pr.author}`, await this.token, this.signal);
      if (res.status === 204) return true;
      if (res.status === 404) return false;
      // 302: this token is not a member, so GitHub shows public members only. 403: no
      // permission to read members. Not known either way.
      if (res.status === 302 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') !== '0' && !res.headers.has('retry-after'))) {
        await res.body?.cancel();
        return null;
      }
      await readJson(res, 'organization member');
      throw new FactError(`GitHub organization member: ${res.status}`);
    });
  }

  /** The required checks of the base branch and the latest result of each on the head. */
  checks(ignore: string | undefined): Promise<{ required: number; green: boolean; pending: boolean; failed: boolean }> {
    return this.part('checks', async () => {
      const { pr } = await this.base;
      const branch = encodeURIComponent(pr.base);
      const sha = this.ref.head;
      const [rules, branchJson, runsJson, statusJson] = await Promise.all([
        this.json(`${this.repoPath}/rules/branches/${branch}?per_page=${PER_PAGE}`, 'rules'),
        this.json(`${this.repoPath}/branches/${branch}`, 'branch'),
        this.json(`${this.repoPath}/commits/${sha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=1`, 'check runs'),
        this.json(`${this.repoPath}/commits/${sha}/status?per_page=${PER_PAGE}&page=1`, 'statuses'),
      ]);
      if (Array.isArray(rules) && rules.length >= PER_PAGE) throw new FactError('GitHub rules: too many rules');
      // Workflows that a ruleset requires: matched with the workflow runs of the head.
      const workflows = requiredWorkflows(rules);
      let wfRuns: WorkflowRun[] = [];
      if (workflows.length > 0) {
        const w = workflowRuns(await this.json(`${this.repoPath}/actions/runs?head_sha=${sha}&per_page=${PER_PAGE}`, 'workflow runs'));
        if (w.total > PER_PAGE || w.runs.length !== w.total) throw new FactError('too many workflow runs on the head commit');
        wfRuns = w.runs;
      }
      const first = checkRuns(runsJson);
      const status = statuses(statusJson);
      if (first.total > MAX_CHECKS || status.total > PER_PAGE) throw new FactError('too many checks on the head commit');
      const more = await Promise.all(pages(Math.ceil(first.total / PER_PAGE)).slice(1).map(async (p) =>
        checkRuns(await this.json(`${this.repoPath}/commits/${sha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=${p}`, 'check runs')).runs));
      const runs = [...first.runs, ...more.flat()];
      if (runs.length !== first.total || status.runs.length !== status.total) throw new FactError('GitHub checks: the list does not match');

      const required = new Map<string, Required>();
      for (const r of [...requiredFromRules(rules), ...requiredFromBranch(branchJson)]) {
        // Pointsman's own check is never waited for.
        if (r.context === ignore) continue;
        required.set(`${r.context}\u0000${r.app ?? ''}`, r);
      }
      const latest = <T extends { at: string }>(list: T[]) => list.sort((a, b) => b.at.localeCompare(a.at))[0];
      const workflowResults = workflows.map((w): Result => {
        // Only a run that GitHub started for the ruleset counts, not a workflow of this
        // repository at the same path: a pull request can change that one.
        const run = latest(wfRuns.filter((x) => x.path === w.path && x.required));
        return run ? run.result : 'pending';
      });
      const checkResults = [...required.values()].map((r): Result => {
        const run = latest(runs.filter((x) => x.name === r.context && (r.app === null || x.app === r.app)));
        // A commit status cannot show which app sent it: it counts only where any app may report.
        const s = r.app === null ? latest(status.runs.filter((x) => x.name === r.context)) : undefined;
        const found = [run, s].filter((x): x is Run => x !== undefined).map((x) => x.result);
        // Not reported yet: pending. A check run and a status that disagree: the stricter one.
        if (found.length === 0) return 'pending';
        return found.includes('failed') ? 'failed' : found.includes('pending') ? 'pending' : 'passed';
      });
      const results = [...checkResults, ...workflowResults];
      const failed = results.includes('failed');
      return {
        required: results.length,
        green: results.length > 0 && results.every((x) => x === 'passed'),
        pending: !failed && results.includes('pending'),
        failed,
      };
    });
  }

  /**
   * The pushes to the head branch, newest first, page by page back to the
   * push that created the branch, at most MAX_PUSH_PAGES pages; null when
   * GitHub does not show them to this token. Pushes older than the pages
   * read stay unknown, which pushedByAuthor turns into "unavailable".
   */
  pushes(): Promise<Push[] | null> {
    return this.part('pushes', async () => {
      const { pr } = await this.base;
      if (!pr.headRepo) return null;
      const all: Push[] = [];
      let after: string | null = null;
      for (let p = 0; p < MAX_PUSH_PAGES; p++) {
        const q = new URLSearchParams({ ref: `refs/heads/${pr.headRef}`, per_page: String(PER_PAGE) });
        if (after) q.set('after', after);
        let page: { body: unknown; next: string | null };
        try {
          page = await this.page(`/repos/${pr.headRepo}/activity?${q}`, 'activity');
        } catch (err) {
          // Not shown (no access, or a private fork): not known; a later page that
          // is not shown leaves the older pushes unknown. Other failures fail the fact.
          if (err instanceof FactUnavailableError) return p === 0 ? null : all;
          throw err;
        }
        const list = pushes(page.body);
        // Newest first: pushes older than the one that created the branch belong
        // to an earlier branch of the same name.
        const created = list.findIndex((x) => x.created);
        all.push(...(created < 0 ? list : list.slice(0, created + 1)));
        if (list.length === 0 || created >= 0 || !page.next) break;
        after = page.next;
      }
      return all;
    });
  }

  /** The CODEOWNERS file of the base branch; null when there is none. */
  codeowners(): Promise<string | null> {
    return this.part('codeowners', async () => {
      const { pr } = await this.base;
      const ref = encodeURIComponent(pr.base);
      const found = await Promise.all(CODEOWNERS_PATHS.map(async (path) => {
        try {
          return await this.json(`${this.repoPath}/contents/${path}?ref=${ref}`, 'CODEOWNERS');
        } catch (err) {
          // 404: not at this place. Anything else (403, 5xx): CODEOWNERS cannot be read.
          if (err instanceof FactUnavailableError && /: 404$/.test(err.message)) return null;
          throw err;
        }
      }));
      const file = found.find((f) => f !== null);
      if (file === undefined) return null;
      if (!isObject(file) || file.encoding !== 'base64' || typeof file.content !== 'string') throw new FactError('GitHub CODEOWNERS: unexpected answer');
      // Too large: refused before decoding (by GitHub's size, and by the base64 text), and after.
      const tooLarge = new FactError(`GitHub CODEOWNERS: larger than ${MAX_CODEOWNERS_BYTES} bytes`);
      if ((typeof file.size === 'number' && file.size > MAX_CODEOWNERS_BYTES) || file.content.length > MAX_CODEOWNERS_BYTES * 2) throw tooLarge;
      const bytes = base64Bytes(file.content);
      if (bytes.length > MAX_CODEOWNERS_BYTES) throw tooLarge;
      return new TextDecoder().decode(bytes);
    });
  }

  /** The members of a team, by login (at most 100; more is "more than one"). */
  private team(org: string, slug: string): Promise<string[]> {
    return this.part(`team:${org}/${slug}`.toLowerCase(), async () => {
      const v = await this.json(`/orgs/${org}/teams/${slug}/members?per_page=${PER_PAGE}`, 'team members');
      if (!Array.isArray(v)) throw new FactError('GitHub team members: unexpected answer');
      return v.map((m) => (isObject(m) && typeof m.login === 'string' ? m.login.toLowerCase() : ''));
    });
  }

  /**
   * Whether the author is the only code owner of every changed file (both
   * names of a renamed file), by CODEOWNERS on the base branch. A team owns
   * as its members. False without CODEOWNERS, for a file without an owner,
   * for an email owner, for no changed files, and for more files than are
   * read. CODEOWNERS or a team that cannot be read fails the fact, and so
   * does CODEOWNERS over its limits (codeowners.ts).
   */
  soleCodeOwner(): Promise<boolean> {
    return this.part('owner', async () => {
      const { pr } = await this.base;
      if (pr.files === 0 || pr.files > MAX_FILES) return false;
      const [files, text] = await Promise.all([this.files(), this.codeowners()]);
      if (text === null) return false;
      const ownersOf = ownerLookup(parseCodeowners(text));
      const author = pr.author.toLowerCase();
      const owners = new Set<string>();
      for (const names of files) {
        for (const name of names) {
          const o = ownersOf(name);
          if (!o || o.length === 0) return false;
          for (const x of o) owners.add(x);
        }
      }
      for (const owner of owners) {
        const team = TEAM.exec(owner);
        if (team) {
          const members = await this.team(team[1]!, team[2]!);
          if (members.length !== 1 || members[0] !== author) return false;
        } else if (owner.toLowerCase() !== `@${author}`) {
          // Another person, or an email address that cannot be tied to the author.
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Pages of a list until one is not full; `max` full pages fail (so the
   * limit is fewer than max × 100 entries). Pages are read one after another:
   * an entry deleted in between can move an entry to an earlier page.
   */
  private async list<T>(path: string, what: string, max: number, parse: (v: unknown) => T[]): Promise<T[]> {
    const out: T[] = [];
    for (let p = 1; p <= max; p++) {
      const page = parse(await this.json(`${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${p}`, what));
      out.push(...page);
      if (page.length < PER_PAGE) return out;
    }
    throw new FactError(`GitHub ${what}: more than ${max * PER_PAGE}`);
  }

  /**
   * Reads the pull request once more after a list: a push while the list
   * was read makes the facts that use it stale, so nothing written about a
   * newer head is taken for this one.
   */
  private async stillAtHead(what: string): Promise<void> {
    const again = pullRequest(await this.json(`${this.repoPath}/pulls/${this.ref.number}`, 'pull request'));
    if (again.head !== this.ref.head) throw new FactStaleError(`the pull request changed while its ${what} were read`);
  }

  /** The pull request's reviews, oldest first. */
  reviews(): Promise<Review[]> {
    return this.part('reviews', async () => {
      await this.base;
      const list = await this.list(`${this.repoPath}/pulls/${this.ref.number}/reviews`, 'reviews', MAX_REVIEW_PAGES, reviews);
      await this.stillAtHead('reviews');
      return list;
    });
  }

  /** The comments of the pull request's conversation, oldest first. */
  comments(): Promise<Comment[]> {
    return this.part('comments', async () => {
      await this.base;
      const list = await this.list(`${this.repoPath}/issues/${this.ref.number}/comments`, 'comments', MAX_REVIEW_PAGES, comments);
      await this.stillAtHead('comments');
      return list;
    });
  }

  /** Every status the head commit got, newest first (GitHub's order). */
  headStatuses(): Promise<Status[]> {
    return this.part('statuses', async () => {
      await this.base;
      return this.list(`${this.repoPath}/commits/${this.ref.head}/statuses`, 'statuses', MAX_STATUS_PAGES, statusHistory);
    });
  }

  /** Review requests and review threads (GraphQL), checked against the head. */
  reviewState(): Promise<ReviewState> {
    return this.part('reviewState', async () => {
      await this.base;
      const data = await graphql(this.fetchFn, REVIEW_STATE_QUERY, { owner: this.ref.owner, name: this.ref.repo, number: this.ref.number }, await this.token, this.signal, 'review threads');
      const { head, ...state } = reviewState(data);
      if (head !== this.ref.head) throw new FactStaleError('the pull request changed while its reviews were read');
      return state;
    });
  }

  /**
   * Who last edited each comment and review (GraphQL), checked against the
   * head. Read after the comments and reviews themselves, so an edit made
   * while they were read shows here.
   */
  editors(): Promise<Editors> {
    return this.part('editors', async () => {
      await Promise.all([this.comments(), this.reviews()]);
      const data = await graphql(this.fetchFn, EDITORS_QUERY, { owner: this.ref.owner, name: this.ref.repo, number: this.ref.number }, await this.token, this.signal, 'editors');
      const { head, ...found } = editors(data);
      if (head !== this.ref.head) throw new FactStaleError('the pull request changed while its comments were read');
      return found;
    });
  }

  /**
   * When the head commit was pushed: the newest push to the head branch that
   * ended at it; null when not known (no push in the activity list, a fork
   * GitHub does not show, a head that was pushed before the pages read).
   */
  async headPushedAt(): Promise<string | null> {
    const list = await this.pushes();
    const push = list?.find((p) => p.after === this.ref.head && Number.isFinite(Date.parse(p.at)));
    return push?.at ?? null;
  }

  /**
   * The status history of the head commits of the repository's newest other
   * pull requests (at most `n`, open or closed): for telling whether a
   * service runs in the repository at all.
   */
  recentHeadStatuses(n: number): Promise<Status[][]> {
    return this.part(`recent:${n}`, async () => {
      const list = await this.json(`${this.repoPath}/pulls?state=all&sort=created&direction=desc&per_page=${Math.min(n + 1, PER_PAGE)}`, 'pull requests');
      if (!Array.isArray(list)) throw new FactError('GitHub pull requests: unexpected answer');
      const heads = list
        .filter((p) => isObject(p) && p.number !== this.ref.number && isObject(p.head) && typeof p.head.sha === 'string' && /^[0-9a-f]{40}$/i.test(p.head.sha))
        .slice(0, n)
        .map((p) => ((p as Record<string, Record<string, string>>).head!.sha!).toLowerCase());
      return Promise.all(heads.map(async (sha) => statusHistory(await this.json(`${this.repoPath}/commits/${sha}/statuses?per_page=${PER_PAGE}`, 'statuses'))));
    });
  }

  /**
   * The change from the base branch to a commit, as the compare API shows it
   * (from their merge base): the merge base and the changed files. Null when
   * it cannot be compared: more files than the API lists, or no merge base.
   */
  private changeOf(sha: string): Promise<{ mergeBase: string; files: unknown[] } | null> {
    return this.part(`change:${sha}`, async () => {
      const { pr } = await this.base;
      // The base commit read with the pull request, not the branch: both commits are compared with the same base.
      if (!pr.baseSha) return null;
      const v = await this.json(`${this.repoPath}/compare/${pr.baseSha}...${sha}`, 'compare');
      if (!isObject(v) || !Array.isArray(v.files)) throw new FactError('GitHub compare: unexpected answer');
      // The API lists at most 300 files, and none for a very large comparison: a list that may be cut short cannot be compared.
      if (v.files.length === 0 || v.files.length >= COMPARE_MAX_FILES) return null;
      const mergeBase = isObject(v.merge_base_commit) && typeof v.merge_base_commit.sha === 'string' ? v.merge_base_commit.sha : null;
      return mergeBase === null ? null : { mergeBase, files: v.files };
    });
  }

  /** The base branch's change of each file from one merge base to another (its patch, null when none is given); null when not known (too many, or not listed). */
  private async baseMoved(from: string, to: string): Promise<Map<string, string | null> | null> {
    const v = await this.json(`${this.repoPath}/compare/${from}...${to}`, 'compare');
    if (!isObject(v) || !Array.isArray(v.files)) throw new FactError('GitHub compare: unexpected answer');
    if (v.files.length >= COMPARE_MAX_FILES || (v.files.length === 0 && v.status !== 'identical')) return null;
    const changed = new Map<string, string | null>();
    for (const f of v.files) {
      if (!isObject(f) || typeof f.filename !== 'string') throw new FactError('GitHub compare: unexpected answer');
      const patch = typeof f.patch === 'string' ? f.patch : null;
      changed.set(f.filename, patch);
      // A rename by the base: the place under the old name is not followed.
      if (typeof f.previous_filename === 'string') changed.set(f.previous_filename, null);
    }
    return changed;
  }

  /**
   * Whether commit `b` makes the same change as commit `a` (rebase_only):
   * the same files with the same patches, line numbers included. Where the
   * base changed a file between the two merge bases (a rebase), the lines
   * may have moved: there each hunk of `a` is followed through the base's
   * own change of the file, and must land where the hunk of `b` is (else
   * false, another place), on lines the base did not change (else null). So
   * an edit moved to an identical block is not the same change. Null when it
   * cannot be told.
   */
  async sameChange(a: string, b: string): Promise<boolean | null> {
    const [x, y] = await Promise.all([this.changeOf(a), this.changeOf(b)]);
    if (x === null || y === null) return null;
    let loose = new Set<string>();
    if (x.mergeBase !== y.mergeBase) {
      const moved = await this.baseMoved(x.mergeBase, y.mergeBase);
      if (moved === null) return null;
      const approved = new Map((x.files as Record<string, unknown>[]).map((f) => [String(f.filename), f]));
      for (const f of y.files as Record<string, unknown>[]) {
        const path = String(f.filename);
        if (!moved.has(path) && !(typeof f.previous_filename === 'string' && moved.has(f.previous_filename))) continue;
        const before = approved.get(path);
        // Not in the approved change: the signatures differ anyway.
        if (!before) continue;
        const basePatch = moved.get(path) ?? null;
        if (basePatch === null || typeof f.patch !== 'string' || typeof before.patch !== 'string') return null;
        const [was, now] = [hunkRanges(before.patch), hunkRanges(f.patch)];
        if (was.length !== now.length) return false;
        for (let i = 0; i < was.length; i++) {
          const at = movedStart(was[i]!.start, was[i]!.length, basePatch);
          if (at === null) return null;
          if (at !== now[i]!.start || was[i]!.length !== now[i]!.length) return false;
        }
        loose.add(path);
      }
    }
    const [sa, sb] = [changeSignature(x.files, loose), changeSignature(y.files, loose)];
    return sa === null || sb === null ? null : sa === sb;
  }


  properties(): Promise<unknown> {
    return this.part('properties', () => this.json(`${this.repoPath}/properties/values`, 'custom properties'));
  }

  /** The files of a commit, by path. */
  private tree(sha: string): Promise<Map<string, TreeFile>> {
    return this.part(`tree:${sha}`, async () => treeFiles(await this.json(`${this.repoPath}/git/trees/${sha}?recursive=1`, 'tree')));
  }

  /** A file's text; null when it is not UTF-8 text. */
  private blob(sha: string): Promise<string | null> {
    return this.part(`blob:${sha}`, async () => {
      const v = await this.json(`${this.repoPath}/git/blobs/${sha}`, 'file');
      if (!isObject(v) || v.encoding !== 'base64' || typeof v.content !== 'string') throw new FactError('GitHub file: unexpected answer');
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64Bytes(v.content));
      } catch {
        return null;
      }
    });
  }

  /**
   * The changed files in the `github_workflows` scope, read at the head
   * commit and at the base tip: workflows, every file of a local action
   * (a folder with an `action.yml` at head or at base), and scanner
   * settings. Workflows and `action.yml` files are read as text, at most 50
   * of them and 256 KB each; the others only count.
   */
  workflowFiles(): Promise<WorkflowFile[]> {
    return this.part('workflows', async () => {
      const { pr } = await this.base;
      if (!pr.baseSha) throw new FactError('GitHub pull request: no base commit');
      const changes = await this.changes();
      if (changes.length === 0) return [];
      const [head, base] = await Promise.all([this.tree(this.ref.head), this.tree(pr.baseSha)]);
      const folders = actionFolders([...head.keys(), ...base.keys()]);
      let parsed = 0;
      const files = changes.map(async (c): Promise<WorkflowFile | null> => {
        const [name, previous = name] = c.names as [string, string?];
        const kind = kindOf(name, folders);
        // A file moved out of the scope is gone from it.
        const removed = c.removed || kind === null;
        const k = kind ?? kindOf(previous, folders);
        if (k === null) return null;
        const folder = k === 'action' || k === 'action_file' ? actionFolderOf(kind ? name : previous, folders) ?? undefined : undefined;
        const at = removed ? undefined : head.get(name);
        const file: WorkflowFile = { path: kind ? name : previous, kind: k, ...(folder !== undefined && { folder }), removed, bytes: at?.size ?? 0, head: null, base: null };
        if (removed || (k !== 'workflow' && k !== 'action')) return file;
        // Not in the head tree (a submodule, a link GitHub does not list): it cannot be read.
        if (!at || at.size > MAX_FILE_BYTES || ++parsed > MAX_PARSED_FILES) return { ...file, unreadable: true };
        // A file renamed into the scope is new there: its earlier version was not a workflow or action.
        const before = kindOf(previous, folders) === k ? base.get(previous) : undefined;
        const [h, b] = await Promise.all([
          this.blob(at.sha),
          before && before.size <= MAX_FILE_BYTES ? this.blob(before.sha) : Promise.resolve(null),
        ]);
        return h === null ? { ...file, unreadable: true } : { ...file, head: h, base: b };
      });
      return (await Promise.all(files)).filter((f): f is WorkflowFile => f !== null);
    });
  }
}

/**
 * The decision's snapshot of a pull request: made by the first fact that
 * asks, by any module, and shared through the decision's scope. A module
 * that reads GitHub this way uses the GitHub module's settings (index.ts,
 * githubAuthFrom), so it reads with the same token.
 */
export function snapshotOf(pr: PullRequestRef, scope: FactScope | undefined, fetchFn: typeof fetch, auth: GitHubAuth): Snapshot {
  const key = `github:${pr.owner}/${pr.repo}#${pr.number}@${pr.head}`.toLowerCase();
  let s = scope?.get(key) as Snapshot | undefined;
  if (!(s instanceof Snapshot)) {
    s = new Snapshot(pr, fetchFn, auth);
    scope?.set(key, s);
  }
  return s;
}

export interface GitHubOptions {
  auth: GitHubAuth;
  fetch?: typeof fetch;
  /** The name of Pointsman's own check run: never counted as a required check. */
  ignoreCheck?: string | undefined;
  /** The clock, for github_bump's release ages (tests set it). */
  now?: () => number;
}

export class GitHubFactProvider implements FactProvider<GitHubFactQuery> {
  private readonly auth: GitHubAuth;
  private readonly fetchFn: typeof fetch;
  private readonly ignoreCheck: string | undefined;
  private readonly now: () => number;

  constructor({ auth, fetch: fetchFn, ignoreCheck, now }: GitHubOptions) {
    this.now = now ?? (() => Date.now());
    this.auth = auth;
    // A wrapper, not fetch itself: Workers refuse an unbound global fetch.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.ignoreCheck = ignoreCheck || undefined;
  }

  /** The decision's snapshot of this pull request: made by the first fact, shared by the others. */
  snapshot(pr: PullRequestRef, scope: FactScope | undefined): Snapshot {
    return snapshotOf(pr, scope, this.fetchFn, this.auth);
  }

  async lookup(query: GitHubFactQuery, signal: AbortSignal, scope?: FactScope): Promise<FactResult> {
    // No signal for the reads: the snapshot is shared by every fact of the
    // decision, so one fact's time limit must not cancel it for the others.
    // The snapshot has its own limit; lookupFacts stops waiting at the fact's.
    void signal;
    const s = this.snapshot(query.pr, scope);
    const { pr, commits: list } = await s.base;
    const source = `GitHub ${query.pr.owner}/${query.pr.repo}#${query.pr.number} at ${query.pr.head.slice(0, 7)}`;
    switch (query.type) {
      case 'github_pr':
        return {
          values: {
            open: pr.open, merged: pr.merged, draft: pr.draft, wip_title: isWipTitle(pr.title),
            files: pr.files, changed_lines: pr.changedLines, base_is_default: pr.base === pr.defaultBranch,
            author_member: await s.member(),
            author_dependabot: pr.author === DEPENDABOT && pr.authorIsBot,
            fork: pr.fork,
            all_commits_verified: list ? allVerified(list, pr.author === DEPENDABOT && pr.authorIsBot) : null,
            pushed_by_author: pushedByAuthor(list, await s.pushes(), pr.author),
            author_sole_code_owner: await s.soleCodeOwner(),
          },
          source,
        };
      case 'github_paths': {
        const paths = query.paths ?? [];
        const except = query.except ?? [];
        const ok = (n: string) => matchesAny(n, paths) && !matchesAny(n, except);
        // A renamed file has two names. It counts for any and count when one
        // of them counts, and for all only when both do: a file moved out of
        // a listed or excepted folder is still seen.
        const files = await s.files();
        const count = files.filter((names) => names.some(ok)).length;
        return { values: { any: count > 0, all: files.length > 0 && files.every((names) => names.every(ok)), count }, source };
      }
      case 'github_checks':
        return { values: await s.checks(this.ignoreCheck), source };
      case 'github_property': {
        if (!query.property) throw new FactError('no property name');
        return { values: { value: propertyValue(await s.properties(), query.property) }, source };
      }
      case 'github_workflows': {
        const settings: WorkflowSettings = workflowSettings(query.workflows);
        return { values: { ...countWorkflows(await s.workflowFiles(), `${query.pr.owner}/${query.pr.repo}`, settings) }, source };
      }
      case 'github_copilot': {
        const [all, state] = await Promise.all([s.reviews(), s.reviewState()]);
        return { values: copilotFacts(all, state, query.pr.head), source };
      }
      case 'github_app_approval': {
        if (!query.app) throw new FactError('no app');
        return { values: appApprovalFacts(await s.reviews(), query.app, query.pr.head), source };
      }
      case 'github_release': {
        if (!query.versionFiles) throw new FactError('no version files');
        return { values: { ...await s.release(query.changelogs ?? RELEASE_CHANGELOGS, query.versionFiles, query.textFiles ?? []) }, source };
      }
      case 'github_bump': {
        const values = await s.bump(this.now());
        return { values: { ...values }, source: values.applies ? `${source}; npm registry` : source };
      }
    }
  }
}
