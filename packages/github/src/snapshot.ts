// One decision's reads of one pull request at one head commit (Snapshot),
// shared by every GitHub-based fact of the decision, also those of other
// modules (snapshotOf). The pull request and its commits are read once and
// checked against the requested head; then only the parts the facts need,
// each once. A push or a new base while a list is read makes the facts
// stale. The answers are checked in answers.ts.

import { FactError, FactStaleError, FactUnavailableError, type FactScope } from '@pointsman/module-api';
import { GITHUB_TIMEOUT_MS, type PullRequestRef } from './definition';
import { MAX_CODEOWNERS_BYTES, ownerLookup, parseCodeowners } from './codeowners';
import { isObject } from './github-http';
import { rateLimited } from './rate-limit';
import { manifestsOf, NOT_RELEASE, onlyVersionMoves, releaseFacts, type ReleaseFacts } from './release';
import { ageInDays, bumpFacts, devOnlyInRepository, manifestsToRead, NO_BUMP, type BumpFacts } from './bump';
import { publishTimes, REGISTRY_TIMEOUT_MS } from './npm';
import { actionFolderOf, actionFolders, kindOf, MAX_FILE_BYTES, MAX_PARSED_FILES, type WorkflowFile } from './workflows';
import {
  comments, EDITORS_QUERY, editors, REVIEW_STATE_QUERY, reviews, reviewState, statusHistory,
  type Comment, type Editors, type Review, type ReviewState, type Status,
} from './reviews';
import type { GitHubAuth } from './auth';
import { get, getJson, graphql, nextCursor, readJson } from './requests';
import {
  changedFiles, checkRuns, commits, pullRequest, pushes, requiredFromBranch, requiredFromRules, requiredWorkflows, statuses, treeFiles, workflowRuns,
  type Change, type Commit, type PullRequest, type Push, type Required, type Result, type Run, type TreeFile, type WorkflowRun,
} from './answers';
import { changeSignature, hunkRanges, movedStart } from './rebase';

const PER_PAGE = 100;
/** Larger pull requests fail path facts (`error`): 10 calls are enough. GitHub itself lists 3,000. */
export const MAX_FILES = 1000;
/** Pages of the activity list (100 pushes each) read for pushed_by_author; older pushes stay unknown. */
export const MAX_PUSH_PAGES = 5;
/** Teams that own the changed files, read at the same time; with more, author_sole_code_owner has no value and none is read. */
export const MAX_OWNER_TEAMS = 20;
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
/** The largest package.json github_bump reads. */
export const MAX_MANIFEST_BYTES = 512 * 1024;
/** The package.json files of a repository github_bump reads for dev_only; a repository with more fails the fact. */
export const MAX_REPOSITORY_MANIFESTS = 50;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** A team owner "@org/slug"; "." and ".." are not slugs (they would change the API path). */
const TEAM = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(?!\.\.?$)([A-Za-z0-9._-]{1,100})$/;
/** Where GitHub looks for CODEOWNERS, in its order. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

const base64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));

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
    // The base the caller decided on, when it names one (the GitHub connector does): another base is another change.
    if (this.ref.base !== undefined && pr.base !== this.ref.base) throw new FactStaleError('the pull request has another base branch');
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
      // read it once more, so a push or a new base in between makes the facts stale.
      await this.stillAtHead('files');
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
      // permission to read members. Not known either way; but a rate limit is an error.
      if (res.status === 302 || res.status === 403) {
        if (await rateLimited(res)) throw new FactError(`GitHub organization member: rate limited (${res.status})`);
        return null;
      }
      await readJson(res, 'organization member');
      throw new FactError(`GitHub organization member: ${res.status}`);
    });
  }

  /** The required checks of the base branch and the latest result of each on the head. */
  checks(ignore: string | undefined): Promise<{ required: number; green: boolean; pending: boolean; failed: boolean }> {
    // Keyed by the ignored check too: providers with other settings can share the snapshot.
    return this.part(`checks:${ignore ?? ''}`, async () => {
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
          if (err instanceof FactUnavailableError && err.message.endsWith(': 404')) return null;
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

  /**
   * The members of a team, by login (at most 100; more is "more than one").
   * None for a team that does not exist (404), for example one deleted
   * while CODEOWNERS still names it: such a team is an owner that is not
   * the author, so the author is not the only owner.
   */
  private team(org: string, slug: string): Promise<string[]> {
    return this.part(`team:${org}/${slug}`.toLowerCase(), async () => {
      let v: unknown;
      try {
        v = await this.json(`/orgs/${org}/teams/${slug}/members?per_page=${PER_PAGE}`, 'team members');
      } catch (err) {
        if (err instanceof FactUnavailableError && err.message.endsWith(': 404')) return [];
        throw err;
      }
      if (!Array.isArray(v)) throw new FactError('GitHub team members: unexpected answer');
      return v.map((m) => (isObject(m) && typeof m.login === 'string' ? m.login.toLowerCase() : ''));
    });
  }

  /**
   * Whether the author is the only code owner of every changed file (both
   * names of a renamed file), by CODEOWNERS on the base branch. A team owns
   * as its members, and a team that does not exist has none. False without
   * CODEOWNERS, for a file without an owner, for an email owner, for no
   * changed files, and for more files than are read. CODEOWNERS or a team
   * that cannot be read fails it, and so do CODEOWNERS over its limits
   * (codeowners.ts) and more than MAX_OWNER_TEAMS teams (none is read);
   * github_pr then gives no value. Teams are read at the same time. A push
   * or a new base while the files are read is stale, also when CODEOWNERS
   * failed first.
   */
  soleCodeOwner(): Promise<boolean> {
    return this.part('owner', async () => {
      const { pr } = await this.base;
      if (pr.files === 0 || pr.files > MAX_FILES) return false;
      // Both settle first: a stale file list wins over a CODEOWNERS failure.
      const [filesRead, textRead] = await Promise.allSettled([this.files(), this.codeowners()]);
      if (filesRead.status === 'rejected') throw filesRead.reason;
      if (textRead.status === 'rejected') throw textRead.reason;
      const files = filesRead.value;
      const text = textRead.value;
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
      const teams: [string, string][] = [];
      for (const owner of owners) {
        const team = TEAM.exec(owner);
        if (team) teams.push([team[1]!, team[2]!]);
        // Another person, or an email address that cannot be tied to the author.
        else if (owner.toLowerCase() !== `@${author}`) return false;
      }
      if (teams.length > MAX_OWNER_TEAMS) throw new FactError(`GitHub CODEOWNERS: more than ${MAX_OWNER_TEAMS} teams own the changed files`);
      const members = await Promise.all(teams.map(([org, slug]) => this.team(org, slug)));
      return members.every((m) => m.length === 1 && m[0] === author);
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
   * Reads the pull request once more after a list: a push or a new base
   * while the list was read makes the facts that use it stale, so nothing
   * written about a newer head, or read against another base, is taken for
   * this one. The base is compared with the one the snapshot read first.
   */
  private async stillAtHead(what: string): Promise<void> {
    const { pr } = await this.base;
    const again = pullRequest(await this.json(`${this.repoPath}/pulls/${this.ref.number}`, 'pull request'));
    if (again.head !== this.ref.head || again.base !== pr.base) throw new FactStaleError(`the pull request changed while its ${what} were read`);
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

  /** Review requests and review threads (GraphQL), checked against the head. They do not depend on the base, so it is not compared here. */
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
    // Only a base that moved forward from `from` gives patches from it; otherwise (behind,
    // diverged) the patches start at another commit and the places cannot be followed.
    if (v.status !== 'ahead' && v.status !== 'identical') return null;
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
  // The base is part of the key: facts asked for another base never share a snapshot (a branch name is case-sensitive).
  const key = `${`github:${pr.owner}/${pr.repo}#${pr.number}@${pr.head}`.toLowerCase()}${pr.base === undefined ? '' : ` base:${pr.base}`}`;
  let s = scope?.get(key) as Snapshot | undefined;
  if (!(s instanceof Snapshot)) {
    s = new Snapshot(pr, fetchFn, auth);
    scope?.set(key, s);
  }
  return s;
}
