// GitHub's REST answers as the facts use them: the pull request, its
// commits, changed files, tree, required checks, check runs, statuses,
// workflow runs, custom properties and pushes. Pure functions: each checks
// the shape of one answer and throws a FactError when it is not the
// expected one. Nothing here reads GitHub (snapshot.ts does).

import { FactError, FactUnavailableError } from '@pointsman/module-api';
import { isObject } from './github-http';

export const DEPENDABOT = 'dependabot[bot]';
/** The account GitHub signs its own commits with (web edits, Dependabot). */
const WEB_FLOW = 'web-flow';
const PASSED = new Set(['success', 'neutral', 'skipped']);
/** A repository as "owner/name"; "." and ".." are not names. */
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

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

export function pullRequest(v: unknown): PullRequest {
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
export interface Commit { sha: string; verified: boolean; byDependabot: boolean }

export function commits(v: unknown): Commit[] {
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
export interface Change { names: string[]; removed: boolean; status: string; patch: string | null }

/** Changed files of one page; a renamed file counts with both names. */
export function changedFiles(v: unknown): Change[] {
  if (!Array.isArray(v)) throw new FactError('GitHub files: unexpected answer');
  return v.map((f) => {
    if (!isObject(f) || typeof f.filename !== 'string') throw new FactError('GitHub files: unexpected answer');
    const names = typeof f.previous_filename === 'string' ? [f.filename, f.previous_filename] : [f.filename];
    return { names, removed: f.status === 'removed', status: typeof f.status === 'string' ? f.status : '', patch: typeof f.patch === 'string' ? f.patch : null };
  });
}

/** A file of a commit's tree. */
export interface TreeFile { sha: string; size: number }

/** The files of a recursive tree, by path. A tree GitHub cut short fails the fact. */
export function treeFiles(v: unknown): Map<string, TreeFile> {
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
export type Required = { context: string; app: number | null };
/** A workflow that a ruleset requires: its path, the repository it comes from, and the ref or commit it runs at. */
type RequiredWorkflow = { path: string; repository: number | null; ref: string };

/**
 * The workflows the rulesets require, each once. A workflow run names its
 * file by path only (workflowRuns), so two required workflows with the same
 * path from another repository or ref could not be told apart: one run would
 * count for both. That fails the fact instead.
 */
export function requiredWorkflows(v: unknown): RequiredWorkflow[] {
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

export function requiredFromRules(v: unknown): Required[] {
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

export function requiredFromBranch(v: unknown): Required[] {
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

export type Result = 'passed' | 'pending' | 'failed';
export interface Run { name: string; app: number | null; result: Result; at: string }

export function checkRuns(v: unknown): { total: number; runs: Run[] } {
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

export function statuses(v: unknown): { total: number; runs: Run[] } {
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

export interface WorkflowRun { path: string; required: boolean; result: Result; at: string }

export function workflowRuns(v: unknown): { total: number; runs: WorkflowRun[] } {
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
export function propertyValue(v: unknown, name: string): string {
  if (!Array.isArray(v)) throw new FactError('GitHub custom properties: unexpected answer');
  const p = v.find((x) => isObject(x) && x.property_name === name) as Record<string, unknown> | undefined;
  const value = p?.value;
  if (value === undefined || value === null || value === '') return 'unset';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return value.length === 0 ? 'unset' : [...value].sort().join(',');
  throw new FactError('GitHub custom properties: unexpected answer');
}

/** A push to the head branch, from the repository activity list. `created`: the push that created the branch. */
export interface Push { before: string; after: string; actor: string; at: string; created: boolean }

export function pushes(v: unknown): Push[] {
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
