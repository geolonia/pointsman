// CodeRabbit facts that also read the client's decision log
// (packages/coderabbit/src/budget.ts): the author's budget, the queue, and
// the spend on paid reviews. A fake GitHub and a fake log.

import { describe, expect, it } from 'vitest';
import { lookupFacts, resultError } from '../../src/facts';
import { CodeRabbitFactProvider, queueWait, statedBudget, waitFrom } from '@pointsman/coderabbit';
import { TokenAuth } from '@pointsman/github';
import { MAX_LOG_READ, type DecisionContext, type LoggedDecision } from '@pointsman/module-api';
import type { FactSpec } from '../../src/types';

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const BASE = 'e'.repeat(40);
const REPO = '/repos/octo-org/demo';
const PR = `${REPO}/pulls/7`;
const COMMENTS = `${REPO}/issues/7/comments`;
const STATUSES = `${REPO}/commits/${HEAD}/statuses`;
const ME = 'octo-org/demo#7';
const state = { pull_request: { repo: 'octo-org/demo', number: 7, head: HEAD } };
const TOKEN = `test-${crypto.randomUUID()}`;
const NOW = Date.parse('2026-10-22T03:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

type Handler = (url: URL, init: RequestInit) => unknown;

const crBot = { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' };
const alice = { login: 'alice', id: 3, type: 'User' };
const actions = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
const idOf = (x: unknown) => [...JSON.stringify(x)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_007, 7) + 1;
const comment = (body: string, minutesAgo: number, user: unknown = crBot, app: unknown = user === crBot ? { id: 347564 } : null, association = 'NONE') => {
  const c = { user, performed_via_github_app: app, author_association: association, body, created_at: at(minutesAgo), updated_at: at(minutesAgo) };
  return { id: idOf(c), ...c };
};
const REPLY = '<!-- This is an auto-generated reply by CodeRabbit -->\n';
const reply = (text: string, minutesAgo: number) => comment(`${REPLY}${text}`, minutesAgo);
const ask = (minutesAgo: number, user: unknown = alice) => comment('@coderabbitai rate limit', minutesAgo, user);
const status = (description: string, minutesAgo: number) => ({ context: 'CodeRabbit', state: 'success', description, creator: crBot, created_at: at(minutesAgo) });

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const table: Record<string, Handler> = {
    [PR]: () => ({
      state: 'open', merged: false, draft: false, title: 'Docs', body: '',
      head: { sha: HEAD, ref: 'docs', repo: { id: 1, full_name: 'octo-org/demo' } },
      base: { ref: 'main', sha: BASE, repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
      user: { login: 'alice', type: 'User' }, additions: 3, deletions: 1, changed_files: 3, commits: 1,
    }),
    [`${PR}/commits`]: () => [{ sha: HEAD, commit: { verification: { verified: true } } }],
    [`${PR}/files`]: () => [{ filename: 'docs/a.md' }, { filename: 'docs/b.md' }, { filename: 'pnpm-lock.yaml' }],
    [`${PR}/reviews`]: () => [],
    [COMMENTS]: () => [],
    [STATUSES]: () => [],
    [`${REPO}/activity`]: () => [{ activity_type: 'push', before: '0'.repeat(40), after: HEAD, actor: { login: 'alice' }, timestamp: at(30) }],
    ...over,
  };
  table['/graphql'] ??= async (url, init) => {
    const list = async (path: string) => (await table[path]!(url, init)) as { id: number }[];
    return {
      data: {
        repository: {
          pullRequest: {
            headRefOid: HEAD,
            comments: { totalCount: (await list(COMMENTS)).length, nodes: (await list(COMMENTS)).map((c) => ({ databaseId: c.id, editor: null })) },
            reviews: { totalCount: (await list(`${PR}/reviews`)).length, nodes: (await list(`${PR}/reviews`)).map((r) => ({ databaseId: r.id, editor: null })) },
          },
        },
      },
    };
  };
  return table;
}

function fakeGitHub(table: Record<string, Handler>) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const handler = table[url.pathname];
    if (!handler) return new Response('{"message":"Not Found"}', { status: 404 });
    const body = await handler(url, init);
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
}

/** A logged decision of the profile, with facts by name. */
const decision = (minutesAgo: number, action: string, facts: Record<string, Record<string, unknown>>): LoggedDecision => ({
  id: crypto.randomUUID(), created_at: at(minutesAgo), profile: 'next-step', action,
  facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, { missing: false, values: v as never }])),
});
const budgetFact = (over: Record<string, unknown> = {}) => ({
  known: true, asked_minutes_ago: null, available: 0, wait_stated: true, wait_minutes: 30, allowance_per_hour: 2,
  observed_minutes_ago: 0, taken_by_other_pr: false, author: 'alice', pull_request: 'octo-org/demo#5', ...over,
});

function context(rows: LoggedDecision[] | (() => Promise<LoggedDecision[]>) = []): DecisionContext & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    client: 'executor', profile: 'next-step', now: new Date(NOW).toISOString(), asked,
    log: { recent: async (q) => (asked.push(q), typeof rows === 'function' ? rows() : rows) },
  };
}

/** `null`: no context (a test token). */
async function fact(spec: FactSpec, table = routes(), ctx: DecisionContext | null = context()) {
  const provider = new CodeRabbitFactProvider({ auth: new TokenAuth(TOKEN), fetch: fakeGitHub(table) });
  const f = (await lookupFacts([spec], state, provider, undefined, ctx ?? undefined))[spec.name]!;
  if (!f.missing) expect(resultError(spec.type, f)).toBeNull();
  return f;
}
async function values(spec: FactSpec, table?: Record<string, Handler>, ctx?: DecisionContext) {
  const f = await fact(spec, table, ctx);
  if (f.missing) throw new Error(`missing: ${f.reason}`);
  return f.values;
}

const budget: FactSpec = { name: 'budget', type: 'coderabbit_budget', at: '$.pull_request' };
const queue: FactSpec = { name: 'queue', type: 'coderabbit_queue', at: '$.pull_request', waiting: ['wait', 'queue'] };
const spend: FactSpec = { name: 'spend', type: 'coderabbit_spend', at: '$.pull_request', pay_actions: ['pay'], usd_per_file: 0.25, not_reviewed: ['**/pnpm-lock.yaml'] };

describe('the budget (coderabbit_budget), by the pull request\'s author', () => {
  it('not known before CodeRabbit said anything', async () => {
    expect(await values(budget)).toEqual({
      known: false, asked_minutes_ago: null, available: 0, wait_stated: false, wait_minutes: null, allowance_per_hour: null,
      observed_minutes_ago: null, taken_by_other_pr: false, author: 'alice', pull_request: ME,
    });
  });

  it('a reply to the author\'s own command counts', async () => {
    const table = routes({ [COMMENTS]: () => [ask(10), reply('Your plan includes PR reviews subject to rate limits. Reviews are available now.', 9)] });
    expect(await values(budget, table)).toMatchObject({ known: true, available: 1, wait_stated: false, asked_minutes_ago: 10, observed_minutes_ago: 9 });
    const limited = routes({ [COMMENTS]: () => [ask(10), reply("You're currently rate limited under our Fair Usage Limits Policy. Your next review will be available in 59 minutes.", 10)] });
    expect(await values(budget, limited)).toMatchObject({ known: true, available: 0, wait_stated: true, wait_minutes: 49 });
  });

  it('a reply to anyone else\'s command does not count: an app, another person, or no command', async () => {
    const free = (who: unknown) => routes({ [COMMENTS]: () => [ask(10, who), reply('Reviews are available now.', 9)] });
    expect(await values(budget, free(actions))).toMatchObject({ known: false, asked_minutes_ago: null });
    expect(await values(budget, free({ login: 'bob', id: 5, type: 'User' }))).toMatchObject({ known: false });
    expect(await values(budget, routes({ [COMMENTS]: () => [reply('Reviews are available now.', 9)] }))).toMatchObject({ known: false });
    // The newest command before the reply decides, and it must be recent.
    expect(await values(budget, routes({ [COMMENTS]: () => [ask(12), ask(10, actions), reply('Reviews are available now.', 9)] }))).toMatchObject({ known: false });
    expect(await values(budget, routes({ [COMMENTS]: () => [ask(40), reply('Reviews are available now.', 9)] }))).toMatchObject({ known: false });
  });

  it('CodeRabbit\'s own limit notice counts (it is about the author)', async () => {
    const notice = comment('<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached\n> Wait 20 minutes for your next included review. Allowance at 3 reviews per hour.', 5);
    expect(await values(budget, routes({ [COMMENTS]: () => [notice] }))).toMatchObject({ known: true, available: 0, wait_stated: true, wait_minutes: 15, allowance_per_hour: 3 });
  });

  it('not known when the wait is over, or free reviews were stated over an hour ago', async () => {
    const waited = routes({ [COMMENTS]: () => [ask(70), reply('rate limited. Your next review will be available in 30 minutes.', 70)] });
    expect(await values(budget, waited)).toMatchObject({ known: false, wait_minutes: null, observed_minutes_ago: 70 });
    const stale = routes({ [COMMENTS]: () => [ask(61), reply('Reviews are available now.', 61)] });
    expect(await values(budget, stale)).toMatchObject({ known: false, available: 0 });
  });

  it('the author\'s reading on another pull request, from the log; not another author\'s', async () => {
    const rows = [decision(10, 'wait', { budget: budgetFact({ observed_minutes_ago: 5 }) })];
    expect(await values(budget, routes(), context(rows))).toMatchObject({ known: true, available: 0, wait_minutes: 20, observed_minutes_ago: 15, allowance_per_hour: 2 });
    const bob = [decision(10, 'wait', { budget: budgetFact({ author: 'bob' }) })];
    expect(await values(budget, routes(), context(bob))).toMatchObject({ known: false });
    // A newer reading here wins.
    const here = routes({ [COMMENTS]: () => [ask(3), reply('Reviews are available now.', 2)] });
    expect(await values(budget, here, context(rows))).toMatchObject({ available: 1, observed_minutes_ago: 2 });
  });

  it('taken by another pull request of the author after the reading', async () => {
    const here = routes({ [COMMENTS]: () => [ask(10), reply('Reviews are available now.', 9)] });
    const took = (minutesAgo: number, author = 'alice', action = 'review') => [decision(minutesAgo, action, { budget: budgetFact({ author, observed_minutes_ago: null, known: false }) })];
    expect(await values(budget, here, context(took(5)))).toMatchObject({ taken_by_other_pr: true });
    expect(await values(budget, here, context(took(20)))).toMatchObject({ taken_by_other_pr: false });
    expect(await values(budget, here, context(took(5, 'bob')))).toMatchObject({ taken_by_other_pr: false });
    expect(await values(budget, here, context(took(5, 'alice', 'wait')))).toMatchObject({ taken_by_other_pr: false });
    expect(await values({ ...budget, review_actions: ['request-review'] }, here, context(took(5, 'alice', 'request-review')))).toMatchObject({ taken_by_other_pr: true });
  });

  it('reads only this profile\'s decisions of the last 48 hours', async () => {
    const ctx = context();
    await values(budget, routes(), ctx);
    expect(ctx.asked).toEqual([{ profiles: ['next-step'], since: at(48 * 60), limit: MAX_LOG_READ }]);
  });

  it('missing without a log, when the log fails, or when it is full', async () => {
    expect(await fact(budget, routes(), null)).toEqual({ missing: true, reason: 'no_log' });
    expect(await fact(budget, routes(), context(async () => { throw new Error('D1 down'); }))).toEqual({ missing: true, reason: 'error' });
    const full = Array.from({ length: MAX_LOG_READ }, () => decision(1, 'wait', {}));
    expect(await fact(budget, routes(), context(full))).toEqual({ missing: true, reason: 'error' });
    expect(await fact(budget, routes({ [COMMENTS]: () => new Response('{}', { status: 500 }) }))).toEqual({ missing: true, reason: 'error' });
  });

  it('reads CodeRabbit\'s text', () => {
    expect(waitFrom('available in 1 hour and 5 minutes')).toBe(65);
    expect(waitFrom('available in 9 seconds')).toBe(1);
    expect(statedBudget('2 reviews are currently available')).toEqual({ available: 2, waitMinutes: null, allowancePerHour: null });
    expect(statedBudget('Nothing about it')).toBeNull();
  });
});

describe('the queue (coderabbit_queue)', () => {
  const q = (pr: string, author = 'alice') => ({ queue: { ahead: 0, wait_minutes: null, author, pull_request: pr } });

  it('counts the author\'s other waiting pull requests that started waiting earlier', async () => {
    const rows = [
      decision(50, 'wait', q('octo-org/demo#1')),
      decision(40, 'wait', q('octo-org/demo#2')),
      decision(30, 'review', q('octo-org/demo#3')), // not waiting any more
      decision(60, 'wait', q('octo-org/demo#3')),
      decision(20, 'wait', q('octo-org/other#9', 'bob')), // another author
      decision(200, 'wait', q('octo-org/demo#4')), // too old
    ];
    expect(await values(queue, routes(), context(rows))).toEqual({ ahead: 2, wait_minutes: null, author: 'alice', pull_request: ME });
    // This one waits since 45 minutes: only #1 came first.
    expect(await values(queue, routes(), context([...rows, decision(45, 'wait', q(ME))]))).toMatchObject({ ahead: 1 });
    expect(await values({ ...queue, max_age_minutes: 45 }, routes(), context(rows))).toMatchObject({ ahead: 1 });
  });

  it('the wait: CodeRabbit\'s wait plus one slot per pull request ahead', () => {
    const b = { known: true, available: 0, wait_minutes: 10, allowance_per_hour: 2 };
    expect(queueWait(b, 0)).toBe(10);
    expect(queueWait(b, 2)).toBe(70);
    expect(queueWait({ ...b, available: 3 }, 2)).toBe(0);
    expect(queueWait({ ...b, available: 1 }, 2)).toBe(60);
    expect(queueWait({ ...b, allowance_per_hour: null }, 1)).toBeNull();
    expect(queueWait({ ...b, known: false }, 0)).toBeNull();
    expect(queueWait({ ...b, wait_minutes: null }, 0)).toBeNull();
  });

  it('with a known budget', async () => {
    const here = routes({ [COMMENTS]: () => [ask(10), reply('rate limited. Your next review will be available in 20 minutes. Allowance at 2 reviews per hour.', 10)] });
    expect(await values(queue, here, context([decision(50, 'wait', q('octo-org/demo#1'))]))).toMatchObject({ ahead: 1, wait_minutes: 40 });
  });

  it('missing without a log', async () => {
    expect(await fact(queue, routes(), null)).toEqual({ missing: true, reason: 'no_log' });
  });
});

describe('the spend (coderabbit_spend)', () => {
  const notice = (files: number, usd: string, head = HEAD) =>
    comment(`> ## Review limit reached\n> <sub>This review includes ${files} billable files and costs up to $${usd}.</sub>\n> Reviewing files that changed from the base of the PR and between ${OLD} and ${head}.`, 5);
  const paid = (pr: string, head: string, usd: number) => ({ spend: { price_usd: usd, per_pr_usd_after: 0, per_window_usd_after: 0, paid_for_head: false, author: 'alice', pull_request: pr, head } });

  it('the price: CodeRabbit\'s for this head, else billable files at the set price', async () => {
    expect(await values(spend)).toEqual({
      price_usd: 0.5, per_pr_usd_after: 0.5, per_window_usd_after: 0.5, paid_for_head: false, author: 'alice', pull_request: ME, head: HEAD,
    });
    expect(await values(spend, routes({ [COMMENTS]: () => [notice(3, '0.75')] }))).toMatchObject({ price_usd: 0.75 });
    // A price for another head does not count.
    expect(await values(spend, routes({ [COMMENTS]: () => [notice(3, '0.75', OLD)] }))).toMatchObject({ price_usd: 0.5 });
  });

  it('counts logged pay decisions: once per head, per pull request and in the window', async () => {
    const rows = [
      decision(30, 'pay', paid(ME, OLD, 0.5)),
      decision(25, 'pay', paid(ME, OLD, 0.75)), // the same head again: once, at its highest price
      decision(20, 'pay', paid(ME, HEAD, 0.25)), // this head: the same review as now
      decision(10, 'pay', paid('octo-org/demo#1', OLD, 1)),
      decision(6 * 60, 'pay', paid('octo-org/demo#2', OLD, 2)), // outside the 5-hour window
      decision(5, 'wait', paid('octo-org/demo#3', OLD, 9)), // not a payment
    ];
    expect(await values(spend, routes(), context(rows))).toMatchObject({ price_usd: 0.5, per_pr_usd_after: 1.25, per_window_usd_after: 2.25 });
    expect(await values({ ...spend, window_hours: 12 }, routes(), context(rows))).toMatchObject({ per_window_usd_after: 4.25 });
  });

  it('a reservation stops counting for the pull request after 24 hours, unless a paid comment came after it', async () => {
    const rows = [decision(30 * 60, 'pay', paid(ME, OLD, 1))];
    expect(await values(spend, routes(), context(rows))).toMatchObject({ per_pr_usd_after: 0.5 });
    const posted = routes({ [COMMENTS]: () => [comment('@coderabbitai review --use-credits', 29 * 60, alice)] });
    expect(await values(spend, posted, context(rows))).toMatchObject({ per_pr_usd_after: 1.5 });
  });

  it('paid for the head: a paid command after the push that CodeRabbit acted on, by someone who may pay', async () => {
    const acted = { [STATUSES]: () => [status('Review in progress', 8)] };
    const by = (user: unknown, app: unknown = null, association = 'NONE', minutesAgo = 10) =>
      routes({ ...acted, [COMMENTS]: () => [comment('@coderabbitai review --use-credits', minutesAgo, user, app, association)] });
    expect(await values(spend, by(alice))).toMatchObject({ paid_for_head: true });
    expect(await values(spend, by({ login: 'carol', id: 9, type: 'User' }, null, 'MEMBER'))).toMatchObject({ paid_for_head: true });
    expect(await values(spend, by({ login: 'mallory', id: 8, type: 'User' }))).toMatchObject({ paid_for_head: false });
    const executor = { login: 'pointsman-test[bot]', id: 77, type: 'Bot' };
    expect(await values(spend, by(executor, { id: 1234 }))).toMatchObject({ paid_for_head: false });
    expect(await values({ ...spend, payer_apps: [1234] }, by(executor, { id: 1234 }))).toMatchObject({ paid_for_head: true });
    // Before the head was pushed, or CodeRabbit never acted.
    expect(await values(spend, by(alice, null, 'NONE', 40))).toMatchObject({ paid_for_head: false });
    expect(await values(spend, routes({ [COMMENTS]: () => [comment('@coderabbitai review --use-credits', 10, alice)] }))).toMatchObject({ paid_for_head: false });
    expect(await values(spend, routes({ [STATUSES]: () => [status('Review in progress', 1)], [COMMENTS]: () => [comment('@coderabbitai review --use-credits', 30.5, alice)] })))
      .toMatchObject({ paid_for_head: false });
  });

  it('missing without a log or its settings', async () => {
    expect(await fact(spend, routes(), null)).toEqual({ missing: true, reason: 'no_log' });
    expect(await fact({ name: 'spend', type: 'coderabbit_spend', at: '$.pull_request' }, routes())).toEqual({ missing: true, reason: 'error' });
  });
});
