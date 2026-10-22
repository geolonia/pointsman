// Looks up CodeRabbit facts (definition.ts) from the GitHub module's
// snapshot of the pull request: one read of GitHub per decision, shared
// with the GitHub facts.

import { FactError, type FactProvider, type FactResult, type FactScope } from '@pointsman/module-api';
import { matchesAny, snapshotOf, type GitHubAuth } from '@pointsman/github';
import type { CodeRabbitFactQuery } from './definition.ts';
import {
  byCodeRabbit, commentByCodeRabbit, editedByOthers, ignoredBy, installedFrom, isCodeRabbitThread, reviewValues, statedBillable, statusByCodeRabbit,
} from './coderabbit.ts';

/** Other pull requests whose head statuses tell whether CodeRabbit runs in a repository. */
export const RECENT_PULL_REQUESTS = 5;

export interface CodeRabbitOptions {
  auth: GitHubAuth;
  fetch?: typeof fetch;
}

export class CodeRabbitFactProvider implements FactProvider<CodeRabbitFactQuery> {
  private readonly auth: GitHubAuth;
  private readonly fetchFn: typeof fetch;

  constructor({ auth, fetch: fetchFn }: CodeRabbitOptions) {
    this.auth = auth;
    // A wrapper, not fetch itself: Workers refuse an unbound global fetch.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async lookup(query: CodeRabbitFactQuery, signal: AbortSignal, scope?: FactScope): Promise<FactResult> {
    // As for the GitHub facts: the snapshot is shared, so one fact's limit must not cancel it.
    void signal;
    if (query.type !== 'coderabbit') throw new FactError(`not a CodeRabbit fact: ${String(query.type)}`);
    const s = snapshotOf(query.pr, scope, this.fetchFn, this.auth);
    const { pr } = await s.base;
    const head = query.pr.head;
    const [reviews, comments, statuses, state, editors, files, pushedAt] = await Promise.all([
      s.reviews(), s.comments(), s.headStatuses(), s.reviewState(), s.editors(), s.files(), s.headPushedAt(),
    ]);
    if (editedByOthers(comments, reviews, editors)) throw new FactError("someone other than CodeRabbit edited one of CodeRabbit's comments or reviews");
    const r = reviewValues(reviews, statuses, head);
    const here = reviews.some(byCodeRabbit) || comments.some(commentByCodeRabbit) || statuses.some(statusByCodeRabbit);
    const installed = await installedFrom(here, () => s.recentHeadStatuses(RECENT_PULL_REQUESTS));
    // The head has the same change as the commit CodeRabbit approved: a rebase, nothing new to review.
    let rebaseOnly: boolean | null = false;
    if (r.approved !== null && r.approved !== head) {
      const [a, b] = await Promise.all([s.changeOf(r.approved), s.changeOf(head)]);
      rebaseOnly = a === null || b === null ? null : a === b;
    }
    const stated = statedBillable(comments, head, pushedAt);
    const notReviewed = query.not_reviewed ?? [];
    // A renamed file counts once, by its new name.
    const own = files.filter((names) => !matchesAny(names[0]!, notReviewed)).length;
    return {
      values: {
        installed,
        ignored: ignoredBy(pr.body),
        reviewed_any: r.reviewed_any,
        reviewed_head: r.reviewed_head,
        in_progress: r.in_progress,
        approved_head: r.approved_head,
        rebase_only: rebaseOnly,
        changes_requested: r.changes_requested,
        unresolved_threads: state.threads === null ? null : state.threads.filter((t) => !t.resolved && isCodeRabbitThread(t.by)).length,
        outside_diff_findings: r.outside_diff_findings,
        billable_files: stated ?? own,
        price_stated: stated !== null,
      },
      source: `GitHub ${query.pr.owner}/${query.pr.repo}#${query.pr.number} at ${head.slice(0, 7)} (CodeRabbit)`,
    };
  }
}
