// GitHub pull-request facts (FACTS_GITHUB, docs/profile-format.md#github-pull-requests):
//
//   github_pr        the pull request: state, size, author, base, signatures
//   github_paths     changed files that match the fact's path list
//   github_checks    required checks of the base branch on the head commit
//   github_property  a repository custom property
//
// Read-only: this file only sends GET requests to the GitHub API (and, for a
// GitHub App, the one POST that creates an installation token). All GitHub
// facts of one decision come from one snapshot: the pull request and its
// commits are read once, then only the parts the facts need, each once.
// If GitHub's head commit is not the one the request names, every GitHub
// fact of the decision is missing ("stale"). Nothing is guessed.

import {
  FactError, FactStaleError, FactUnavailableError, GITHUB_TIMEOUT_MS,
  type FactProvider, type FactResult, type FactScope, type GitHubFactQuery, type PullRequestRef,
} from './facts';
import { ownersOf, parseCodeowners } from './codeowners';
import { matchesAny } from './glob';

const API = 'https://api.github.com';
const USER_AGENT = 'pointsman (+https://github.com/geolonia/pointsman)';
const PER_PAGE = 100;
/** Larger pull requests fail path facts (`error`): 10 calls are enough. GitHub itself lists 3,000. */
export const MAX_FILES = 1000;
/** Pages of the activity list (100 pushes each) read for pushed_by_author; older pushes stay unknown. */
export const MAX_PUSH_PAGES = 5;
/** GitHub lists at most 250 commits of a pull request. */
const MAX_COMMITS = 250;
/** Check runs and statuses on the head: more fail `github_checks` (`error`). */
const MAX_CHECKS = 300;
const DEPENDABOT = 'dependabot[bot]';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
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
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier: rsaEncryption, NULL parameters.
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(pkcs1.length)];
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  const total = body.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(total), ...body, ...pkcs1]);
  return out;
}

/** The key's DER bytes as PKCS#8, from a PEM in either format; null when it is not one. */
export function privateKeyDer(pem: string): Uint8Array | null {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
  if (!m || Boolean(m[1]) !== Boolean(m[3])) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[2]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 64) return null;
  return m[1] ? pkcs1ToPkcs8(bytes) : bytes;
}

/**
 * A GitHub App (FACTS_GITHUB "app"): signs a JWT with the app's private key,
 * finds the app's installation for the repository and creates an
 * installation token, kept until five minutes before it expires (one hour).
 * The app should have read permissions only; Pointsman only reads.
 */
export class GitHubAppAuth implements GitHubAuth {
  private readonly appId: string;
  private readonly der: Uint8Array;
  private key: Promise<CryptoKey> | undefined;
  private readonly tokens = new Map<string, { token: Promise<string>; until: number }>();
  /** The clock (tests set it). */
  now: () => number = () => Date.now();

  constructor(appId: string, privateKeyPem: string) {
    const der = privateKeyDer(privateKeyPem);
    if (!der) throw new Error('not a PEM private key');
    this.appId = appId;
    this.der = der;
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
    const id = pr.owner.toLowerCase();
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

  private async create(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string> {
    const jwt = await this.jwt();
    const signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    const installation = await getJson(fetchFn, `/repos/${pr.owner}/${pr.repo}/installation`, jwt, signal, 'installation');
    const installationId = (installation as { id?: unknown }).id;
    if (typeof installationId !== 'number') throw new FactError('GitHub installation: unexpected answer');
    // The only request that is not a GET: it creates a token, it changes no repository.
    const res = await fetchFn(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST', headers: headers(jwt), redirect: 'manual', signal,
    });
    const body = await readJson(res, 'installation token');
    const { token, expires_at: expiresAt } = body as { token?: unknown; expires_at?: unknown };
    const until = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (typeof token !== 'string' || token === '' || !Number.isFinite(until)) throw new FactError('GitHub installation token: unexpected answer');
    const entry = this.tokens.get(pr.owner.toLowerCase());
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

/** The only way this file reads GitHub: a GET. */
function get(fetchFn: typeof fetch, path: string, token: string, signal: AbortSignal): Promise<Response> {
  return fetchFn(`${API}${path}`, { method: 'GET', headers: headers(token), redirect: 'manual', signal });
}

async function getJson(fetchFn: typeof fetch, path: string, token: string, signal: AbortSignal, what: string): Promise<unknown> {
  return readJson(await get(fetchFn, path, token, signal), what);
}

// ---- answers ----

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

interface PullRequest {
  open: boolean;
  merged: boolean;
  draft: boolean;
  title: string;
  head: string;
  /** The head branch and its repository ("owner/name"; null when a fork was deleted). */
  headRef: string;
  headRepo: string | null;
  fork: boolean;
  base: string;
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
    open: pr.open, merged: pr.merged, draft: pr.draft, title: pr.title, head: pr.head, headRef: pr.headRef, headRepo: pr.headRepo, fork: pr.fork,
    base: pr.base, defaultBranch: pr.defaultBranch, repoId: baseRepo.id as number, ownerIsOrg: pr.ownerIsOrg, author: pr.author, authorIsBot: pr.authorIsBot,
    changedLines: pr.additions + pr.deletions, files: pr.files, commits: pr.commits,
  };
}

/** "WIP" as a word in the title, for example "WIP: …", "[WIP] …", "… (wip)". */
export const isWipTitle = (title: string): boolean => /(^|[^A-Za-z0-9])wip([^A-Za-z0-9]|$)/i.test(title);

interface Commit { sha: string; verified: boolean }

function commits(v: unknown): Commit[] {
  if (!Array.isArray(v)) throw new FactError('GitHub commits: unexpected answer');
  return v.map((c) => {
    if (!isObject(c) || typeof c.sha !== 'string' || !isObject(c.commit)) throw new FactError('GitHub commits: unexpected answer');
    const verification = c.commit.verification;
    return { sha: c.sha.toLowerCase(), verified: isObject(verification) && verification.verified === true };
  });
}

/** Changed paths of one page; a renamed file counts with both names. */
function filePaths(v: unknown): string[][] {
  if (!Array.isArray(v)) throw new FactError('GitHub files: unexpected answer');
  return v.map((f) => {
    if (!isObject(f) || typeof f.filename !== 'string') throw new FactError('GitHub files: unexpected answer');
    return typeof f.previous_filename === 'string' ? [f.filename, f.previous_filename] : [f.filename];
  });
}

/** A required check: its name, and the app that must report it (null: any). */
type Required = { context: string; app: number | null };
/** A workflow that a ruleset requires: its path, and the repository it comes from. */
type RequiredWorkflow = { path: string };

function requiredWorkflows(v: unknown): RequiredWorkflow[] {
  if (!Array.isArray(v)) throw new FactError('GitHub rules: unexpected answer');
  const out: RequiredWorkflow[] = [];
  for (const rule of v) {
    if (!isObject(rule) || rule.type !== 'workflows') continue;
    const workflows = isObject(rule.parameters) ? rule.parameters.workflows : undefined;
    if (!Array.isArray(workflows)) throw new FactError('GitHub rules: unexpected answer');
    for (const w of workflows) {
      if (!isObject(w) || typeof w.path !== 'string') throw new FactError('GitHub rules: unexpected answer');
      out.push({ path: w.path });
    }
  }
  return out;
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
  for (const push of [...list].sort((a, b) => a.at.localeCompare(b.at))) {
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

const base64Text = (b64: string): string => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));

// ---- the snapshot ----

/** Pages 1..n of a list, read at the same time. */
const pages = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

class Snapshot {
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
  files(): Promise<string[][]> {
    return this.part('files', async () => {
      const { pr } = await this.base;
      if (pr.files > MAX_FILES) throw new FactError(`the pull request changes more than ${MAX_FILES} files`);
      const all = (await Promise.all(pages(Math.ceil(pr.files / PER_PAGE)).map(async (p) =>
        filePaths(await this.json(`${this.repoPath}/pulls/${this.ref.number}/files?per_page=${PER_PAGE}&page=${p}`, 'files'))))).flat();
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
      return base64Text(file.content);
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
   * read. CODEOWNERS or a team that cannot be read fails the fact.
   */
  soleCodeOwner(): Promise<boolean> {
    return this.part('owner', async () => {
      const { pr } = await this.base;
      if (pr.files === 0 || pr.files > MAX_FILES) return false;
      const [files, text] = await Promise.all([this.files(), this.codeowners()]);
      if (text === null) return false;
      const rules = parseCodeowners(text);
      const author = pr.author.toLowerCase();
      const owners = new Set<string>();
      for (const names of files) {
        for (const name of names) {
          const o = ownersOf(rules, name);
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

  properties(): Promise<unknown> {
    return this.part('properties', () => this.json(`${this.repoPath}/properties/values`, 'custom properties'));
  }
}

export interface GitHubOptions {
  auth: GitHubAuth;
  fetch?: typeof fetch;
  /** The name of Pointsman's own check run: never counted as a required check. */
  ignoreCheck?: string | undefined;
}

export class GitHubFactProvider implements FactProvider<GitHubFactQuery> {
  private readonly auth: GitHubAuth;
  private readonly fetchFn: typeof fetch;
  private readonly ignoreCheck: string | undefined;

  constructor({ auth, fetch: fetchFn, ignoreCheck }: GitHubOptions) {
    this.auth = auth;
    // A wrapper, not fetch itself: Workers refuse an unbound global fetch.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.ignoreCheck = ignoreCheck || undefined;
  }

  /** The decision's snapshot of this pull request: made by the first fact, shared by the others. */
  private snapshot(pr: PullRequestRef, scope: FactScope | undefined): Snapshot {
    const key = `github:${pr.owner}/${pr.repo}#${pr.number}@${pr.head}`.toLowerCase();
    let s = scope?.get(key) as Snapshot | undefined;
    if (!s) {
      s = new Snapshot(pr, this.fetchFn, this.auth);
      scope?.set(key, s);
    }
    return s;
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
            all_commits_verified: list ? list.every((c) => c.verified) : null,
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
    }
  }
}
