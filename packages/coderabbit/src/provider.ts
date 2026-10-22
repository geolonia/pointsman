// Looks up CodeRabbit facts (definition.ts) from the GitHub module's
// snapshot of the pull request (one read of GitHub per decision, shared
// with the GitHub facts) and, for the budget, the queue and the spend, from
// the client's earlier decisions (DecisionContext.log).

import {
  FactError, FactMissingError, MAX_LOG_READ,
  type DecisionContext, type FactProvider, type FactResult, type FactScope, type LoggedDecision,
} from '@pointsman/module-api';
import { matchesAny, snapshotOf, type GitHubAuth, type Snapshot } from '@pointsman/github';
import type { CodeRabbitFactQuery } from './definition.ts';
import {
  byCodeRabbit, commentByCodeRabbit, editedByOthers, headSince, ignoredBy, installedFrom, isCodeRabbitThread, reviewValues, statedBillable, statusByCodeRabbit,
} from './coderabbit.ts';
import {
  budgetAt, lastAsked, observationsHere, observationsLogged, paidCommands, paidForHead, payments, queueAhead, queueWait, spendAfter, statedPriceForHead, takenByOther,
} from './budget.ts';

/** Other pull requests whose head statuses tell whether CodeRabbit runs in a repository. */
export const RECENT_PULL_REQUESTS = 5;
/** How far back the budget, queue and spend read the client's decisions. */
export const LOG_HOURS = 48;

export interface CodeRabbitOptions {
  auth: GitHubAuth;
  fetch?: typeof fetch;
}

const pullRequestId = (q: CodeRabbitFactQuery) => `${q.pr.owner}/${q.pr.repo}#${q.pr.number}`.toLowerCase();

export class CodeRabbitFactProvider implements FactProvider<CodeRabbitFactQuery> {
  private readonly auth: GitHubAuth;
  private readonly fetchFn: typeof fetch;

  constructor({ auth, fetch: fetchFn }: CodeRabbitOptions) {
    this.auth = auth;
    // A wrapper, not fetch itself: Workers refuse an unbound global fetch.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async lookup(query: CodeRabbitFactQuery, signal: AbortSignal, scope?: FactScope, context?: DecisionContext): Promise<FactResult> {
    // As for the GitHub facts: the snapshot is shared, so one fact's limit must not cancel it.
    void signal;
    const s = snapshotOf(query.pr, scope, this.fetchFn, this.auth);
    const source = `GitHub ${query.pr.owner}/${query.pr.repo}#${query.pr.number} at ${query.pr.head.slice(0, 7)} (CodeRabbit)`;
    switch (query.type) {
      case 'coderabbit':
        return { values: await this.state(s, query), source };
      case 'coderabbit_budget':
      case 'coderabbit_queue':
      case 'coderabbit_spend': {
        const ctx = needLog(context);
        const values = query.type === 'coderabbit_budget' ? await this.budget(s, query, ctx, scope)
          : query.type === 'coderabbit_queue' ? await this.queue(s, query, ctx, scope)
            : await this.spend(s, query, ctx, scope);
        return { values, source: `${source} and this client's decisions` };
      }
      default:
        throw new FactError(`not a CodeRabbit fact: ${String((query as { type: unknown }).type)}`);
    }
  }

  /** Comments and reviews whose CodeRabbit text nobody else edited (else the fact is missing). */
  private async text(s: Snapshot) {
    const [reviews, comments, editors] = await Promise.all([s.reviews(), s.comments(), s.editors()]);
    if (editedByOthers(comments, reviews, editors)) throw new FactError("someone other than CodeRabbit edited one of CodeRabbit's comments or reviews");
    return { reviews, comments };
  }

  private async state(s: Snapshot, query: CodeRabbitFactQuery) {
    const { pr } = await s.base;
    const head = query.pr.head;
    const [{ reviews, comments }, statuses, state, files, pushedAt] = await Promise.all([this.text(s), s.headStatuses(), s.reviewState(), s.files(), s.headPushedAt()]);
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
    return {
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
      billable_files: stated ?? ownBillable(files, query.not_reviewed ?? []),
      price_stated: stated !== null,
    };
  }

  /** The author's budget now; also used by the queue. */
  private async budgetOf(s: Snapshot, query: CodeRabbitFactQuery, ctx: DecisionContext, scope: FactScope | undefined) {
    const { pr } = await s.base;
    const [{ comments }, rows] = await Promise.all([this.text(s), readLog(ctx, scope)]);
    const now = Date.parse(ctx.now);
    const id = pullRequestId(query);
    const obs = [...observationsHere(comments, pr.author), ...observationsLogged(rows, pr.author, id)];
    return { pr, rows, now, id, budget: budgetAt(obs, now, lastAsked(comments, pr.author)) };
  }

  private async budget(s: Snapshot, query: CodeRabbitFactQuery, ctx: DecisionContext, scope: FactScope | undefined) {
    const { pr, rows, id, budget } = await this.budgetOf(s, query, ctx, scope);
    const { observedAt, ...values } = budget;
    return {
      ...values,
      taken_by_other_pr: values.known && takenByOther(rows, query.name, pr.author, id, observedAt, query.review_actions ?? ['review']),
      author: pr.author,
      pull_request: id,
    };
  }

  private async queue(s: Snapshot, query: CodeRabbitFactQuery, ctx: DecisionContext, scope: FactScope | undefined) {
    const { pr, rows, now, id, budget } = await this.budgetOf(s, query, ctx, scope);
    const maxAge = (query.max_age_minutes ?? 120) * 60_000;
    const recent = rows.filter((r) => now - Date.parse(r.created_at) <= maxAge);
    const ahead = queueAhead(recent, query.name, pr.author, id, query.waiting ?? [], now);
    return { ahead, wait_minutes: queueWait(budget, ahead), author: pr.author, pull_request: id };
  }

  private async spend(s: Snapshot, query: CodeRabbitFactQuery, ctx: DecisionContext, scope: FactScope | undefined) {
    if (query.usd_per_file === undefined || !query.pay_actions?.length) throw new FactError('coderabbit_spend needs pay_actions and usd_per_file');
    const { pr } = await s.base;
    const head = query.pr.head;
    const [{ reviews, comments }, statuses, pushedAt, rows] = await Promise.all([this.text(s), s.headStatuses(), s.headPushedAt(), readLog(ctx, scope)]);
    const apps = query.payer_apps ?? [];
    const billable = statedBillable(comments, head, pushedAt) ?? ownBillable(await s.files(), query.not_reviewed ?? []);
    const price = Math.round((statedPriceForHead(comments, head) ?? billable * query.usd_per_file) * 100) / 100;
    const id = pullRequestId(query);
    const after = spendAfter(payments(rows, query.name, query.pay_actions), id, head, price, paidCommands(comments, pr.author, apps), Date.parse(ctx.now), query.window_hours ?? 5);
    return {
      price_usd: price,
      ...after,
      paid_for_head: paidForHead(comments, reviews, statuses, head, headSince(pushedAt, statuses), pr.author, apps),
      author: pr.author,
      pull_request: id,
      head,
    };
  }
}

/** The changed files CodeRabbit would review: all but `notReviewed` (a renamed file counts once, by its new name). */
function ownBillable(files: string[][], notReviewed: string[]): number {
  return files.filter((names) => !matchesAny(names[0]!, notReviewed)).length;
}

function needLog(context: DecisionContext | undefined): DecisionContext {
  if (!context) throw new FactMissingError('no_log', 'no decision log to read');
  if (!Number.isFinite(Date.parse(context.now))) throw new FactError('the decision has no time');
  return context;
}

/** The client's decisions of this profile in the last LOG_HOURS, read once per decision. A full page: there may be more, so the facts are missing. */
function readLog(ctx: DecisionContext, scope: FactScope | undefined): Promise<LoggedDecision[]> {
  const key = `coderabbit-log:${ctx.client}:${ctx.profile}`;
  let p = scope?.get(key) as Promise<LoggedDecision[]> | undefined;
  if (!p) {
    const since = new Date(Date.parse(ctx.now) - LOG_HOURS * 3_600_000).toISOString();
    p = ctx.log.recent({ profiles: [ctx.profile], since, limit: MAX_LOG_READ }).then((rows) => {
      if (rows.length >= MAX_LOG_READ) throw new FactError(`more than ${MAX_LOG_READ - 1} decisions in ${LOG_HOURS} hours: cannot count them all`);
      return rows;
    });
    p.catch(() => undefined);
    scope?.set(key, p);
  }
  return p;
}
