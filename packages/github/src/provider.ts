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
// This file turns the snapshot's reads into the facts' values. The parts:
// auth.ts (the token), requests.ts (how a request is sent and its answer
// read), answers.ts (the REST answers' shapes), snapshot.ts (the reads),
// rebase.ts (rebase_only's comparison, for the CodeRabbit module).
//
// Read-only: the snapshot sends GET requests to the GitHub REST API; GraphQL
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
  FactError, FactStaleError,
  type FactProvider, type FactResult, type FactScope,
} from '@pointsman/module-api';
import { RELEASE_CHANGELOGS, type GitHubFactQuery, type PullRequestRef } from './definition';
import { matchesAny } from './glob';
import { countWorkflows, workflowSettings, type WorkflowSettings } from './workflows';
import { appApprovalFacts, copilotFacts } from './reviews';
import type { GitHubAuth } from './auth';
import { allVerified, DEPENDABOT, isWipTitle, propertyValue, pushedByAuthor } from './answers';
import { snapshotOf, type Snapshot } from './snapshot';

/**
 * The value of a read, or `fallback` when the read fails: the field's value
 * for "not known" (no value, or "unavailable"), never a known value.
 * Stale still fails: the facts would describe another change. The failure
 * goes to the log by field (its message names no token).
 */
async function orNotKnown<T, F>(read: Promise<T>, fallback: F, field: string, source: string): Promise<T | F> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof FactStaleError) throw err;
    console.warn(`github_pr ${field}: not known (${source}): ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
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
      case 'github_pr': {
        // Three more reads, at the same time. Each that fails gives only its own
        // field the value for "not known" (no value; for pushed_by_author
        // "unavailable", as when GitHub does not show the pushes), so the
        // pull request's own fields stay;
        // a push or a new base in between still makes the whole fact stale.
        const [member, pushes, sole] = await Promise.all([
          orNotKnown(s.member(), null, 'author_member', source),
          orNotKnown(s.pushes(), null, 'pushed_by_author', source),
          orNotKnown(s.soleCodeOwner(), null, 'author_sole_code_owner', source),
        ]);
        return {
          values: {
            open: pr.open, merged: pr.merged, draft: pr.draft, wip_title: isWipTitle(pr.title),
            files: pr.files, changed_lines: pr.changedLines, base_is_default: pr.base === pr.defaultBranch,
            author_member: member,
            author_dependabot: pr.author === DEPENDABOT && pr.authorIsBot,
            fork: pr.fork,
            all_commits_verified: list ? allVerified(list, pr.author === DEPENDABOT && pr.authorIsBot) : null,
            pushed_by_author: pushedByAuthor(list, pushes, pr.author),
            author_sole_code_owner: sole,
          },
          source,
        };
      }
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
