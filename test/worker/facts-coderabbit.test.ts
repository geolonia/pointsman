// CodeRabbit facts (packages/coderabbit) against a fake GitHub API: every
// field, that only CodeRabbit's own account counts, that text counts for
// the head only when written after the head was pushed, each way the fact
// can be missing, the shared snapshot, and the module's settings.

import { describe, expect, it } from 'vitest';
import { lookupFacts, resultError } from '../../src/facts';
import { coderabbitModule, CodeRabbitFactProvider, ignoredBy, billableIn } from '@pointsman/coderabbit';
import { ConfigError } from '@pointsman/module-api';
import { GitHubFactProvider, TokenAuth } from '@pointsman/github';
import { ModuleRouter, type FactProvider } from '../../src/facts';
import type { FactSpec } from '../../src/types';

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const REPO = '/repos/octo-org/demo';
const PR = `${REPO}/pulls/7`;
const COMMENTS = `${REPO}/issues/7/comments`;
const STATUSES = `${REPO}/commits/${HEAD}/statuses`;
const state = { pull_request: { repo: 'octo-org/demo', number: 7, head: HEAD } };
const TOKEN = `test-${crypto.randomUUID()}`;
const crSpec: FactSpec[] = [{ name: 'cr', type: 'coderabbit', at: '$.pull_request', not_reviewed: ['**/pnpm-lock.yaml'] }];

type Handler = (url: URL, init: RequestInit) => unknown;

const PUSHED = '2026-10-22T01:00:00Z';
const BEFORE = '2026-10-22T00:00:00Z';
const AFTER = '2026-10-22T02:00:00Z';

const crBot = { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' };
const crApp = { id: 347564 };
const pullRequest = (body = 'Fixes the guide.') => ({
  state: 'open', merged: false, draft: false, title: 'Docs', body,
  head: { sha: HEAD, ref: 'docs', repo: { id: 1, full_name: 'octo-org/demo' } },
  base: { ref: 'main', repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
  user: { login: 'alice', type: 'User' },
  additions: 3, deletions: 1, changed_files: 3, commits: 1,
});
const review = (state: string, commit = HEAD, body = '', user: unknown = crBot) => ({ user, state, commit_id: commit, body, submitted_at: AFTER });
const status = (description: string, at = AFTER, creator: unknown = crBot, state = 'success') => ({ context: 'CodeRabbit', state, description, creator, created_at: at });
const comment = (body: string, updated = AFTER, user: unknown = crBot, app: unknown = crApp) => ({ user, performed_via_github_app: app, author_association: 'NONE', body, created_at: updated, updated_at: updated });
const NOTICE = '> ## Review limit reached\n> <sub>This review includes 2 billable files and costs up to $0.50.</sub>';
const thread = (resolved: boolean, author: unknown = { __typename: 'Bot', login: 'coderabbitai', databaseId: 136622811 }) => ({ isResolved: resolved, comments: { nodes: [{ author }] } });
const graph = (threads: unknown[] = [], more = false) => ({
  data: { repository: { pullRequest: { headRefOid: HEAD, reviewRequests: { totalCount: 0, nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: more }, nodes: threads } } } },
});
const patch = (lines: string) => ({ files: [{ filename: 'docs/guide.md', status: 'modified', patch: lines }] });

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [PR]: () => pullRequest(),
    [`${PR}/commits`]: () => [{ sha: HEAD, commit: { verification: { verified: true } } }],
    [`${PR}/files`]: () => [{ filename: 'docs/guide.md' }, { filename: 'README.md' }, { filename: 'pnpm-lock.yaml' }],
    [`${PR}/reviews`]: () => [],
    [COMMENTS]: () => [],
    [STATUSES]: () => [],
    [`${REPO}/activity`]: () => [{ activity_type: 'push', before: '0'.repeat(40), after: HEAD, actor: { login: 'alice' }, timestamp: PUSHED }],
    [`${REPO}/pulls`]: () => [{ number: 6, head: { sha: 'd'.repeat(40) } }],
    [`${REPO}/commits/${'d'.repeat(40)}/statuses`]: () => [status('Review completed')],
    '/graphql': () => graph(),
    ...over,
  };
}

function fakeGitHub(table: Record<string, Handler>) {
  const calls: { method: string; path: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', path: url.pathname });
    const handler = table[url.pathname];
    if (!handler) return new Response('{"message":"Not Found"}', { status: 404 });
    const body = await handler(url, init);
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function lookup(table: Record<string, Handler> = routes(), specs: FactSpec[] = crSpec) {
  const server = fakeGitHub(table);
  const facts = await lookupFacts(specs, state, new CodeRabbitFactProvider({ auth: new TokenAuth(TOKEN), fetch: server.fetchFn }));
  return { facts, server };
}
const values = async (table?: Record<string, Handler>, specs?: FactSpec[]) => {
  const f = (await lookup(table, specs)).facts.cr!;
  if (f.missing) throw new Error(`missing: ${f.reason}`);
  expect(resultError('coderabbit', f)).toBeNull();
  return f.values;
};
const reason = async (table: Record<string, Handler>) => {
  const f = (await lookup(table)).facts.cr!;
  return f.missing ? f.reason : 'not missing';
};

describe('CodeRabbit (coderabbit)', () => {
  it('a pull request CodeRabbit has not touched yet, in a repository where it runs', async () => {
    expect(await values()).toEqual({
      installed: true, ignored: false, reviewed_any: false, reviewed_head: false, in_progress: false,
      approved_head: false, rebase_only: false, changes_requested: false, unresolved_threads: 0, outside_diff_findings: false,
      // Pointsman's own count: three files minus the lockfile.
      billable_files: 2, price_stated: false,
    });
  });

  it('installed: from this pull request, from other pull requests, or not known', async () => {
    expect(await values(routes({ [`${REPO}/commits/${'d'.repeat(40)}/statuses`]: () => [] }))).toMatchObject({ installed: false });
    expect(await values(routes({ [`${REPO}/pulls`]: () => [] }))).toMatchObject({ installed: null });
    // Something of CodeRabbit's here: no need to look elsewhere.
    const { server } = await lookup(routes({ [STATUSES]: () => [status(IN_PROGRESS_TEXT, AFTER, crBot, 'pending')] }));
    expect(server.calls.some((c) => c.path === `${REPO}/pulls`)).toBe(false);
  });

  it('ignored: the ignore line in the description, not inside CodeRabbit\'s own summary', async () => {
    expect(await values(routes({ [PR]: () => pullRequest('Docs.\n\n@coderabbitai ignore') }))).toMatchObject({ ignored: true });
    const summary = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->\nAdds `@coderabbitai ignore` docs\n<!-- end of auto-generated comment: release notes by coderabbit.ai -->';
    expect(await values(routes({ [PR]: () => pullRequest(`Docs.\n${summary}`) }))).toMatchObject({ ignored: false });
    expect(ignoredBy(`@coderabbitai${summary}ignore`)).toBe(false);
  });

  it('reviewed, approved, changes requested, in progress', async () => {
    expect(await values(routes({ [STATUSES]: () => [status('Review completed')] }))).toMatchObject({ reviewed_any: true, reviewed_head: true, approved_head: false });
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('APPROVED')] }))).toMatchObject({ reviewed_head: true, approved_head: true });
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('COMMENTED', OLD)] }))).toMatchObject({ reviewed_any: true, reviewed_head: false });
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('APPROVED'), review('CHANGES_REQUESTED')] }))).toMatchObject({ approved_head: false, changes_requested: true });
    expect(await values(routes({ [STATUSES]: () => [status(IN_PROGRESS_TEXT, AFTER, crBot, 'pending'), status('Review rate limited', BEFORE)] })))
      .toMatchObject({ in_progress: true, reviewed_head: false });
    // A newer status ends the review in progress.
    expect(await values(routes({ [STATUSES]: () => [status('Review completed', AFTER), status(IN_PROGRESS_TEXT, PUSHED, crBot, 'pending')] })))
      .toMatchObject({ in_progress: false, reviewed_head: true });
    // Green but not a review.
    expect(await values(routes({ [STATUSES]: () => [status('Review rate limited')] }))).toMatchObject({ reviewed_head: false });
  });

  it('outside-diff findings in the latest review', async () => {
    const body = '**Actionable comments posted: 1**\n<details><summary>⚠️ Outside diff range comments (1)</summary></details>';
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('COMMENTED', HEAD, body)] }))).toMatchObject({ outside_diff_findings: true });
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('COMMENTED', OLD, body), review('COMMENTED')] }))).toMatchObject({ outside_diff_findings: false });
  });

  it('unresolved threads CodeRabbit started; no value over one page', async () => {
    const person = { __typename: 'User', login: 'bob', databaseId: 5 };
    expect(await values(routes({ '/graphql': () => graph([thread(false), thread(true), thread(false, person)]) }))).toMatchObject({ unresolved_threads: 1 });
    expect(await values(routes({ '/graphql': () => graph([thread(false)], true) }))).toMatchObject({ unresolved_threads: null });
  });

  it('rebase only: the head has the same change as the approved commit', async () => {
    const compare = (head: string) => (url: URL) => (url.pathname.endsWith(`...${OLD}`) ? patch('@@ -1 +1 @@\n-a\n+b') : patch(head));
    const table = (head: string) => routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/main...${OLD}`]: compare(head),
      [`${REPO}/compare/main...${HEAD}`]: compare(head),
    });
    expect(await values(table('@@ -5 +5 @@\n-a\n+b'))).toMatchObject({ rebase_only: true, approved_head: false });
    expect(await values(table('@@ -1 +1 @@\n-a\n+c'))).toMatchObject({ rebase_only: false });
    // A file without a patch (binary, too large): cannot tell.
    const noPatch = routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/main...${OLD}`]: () => ({ files: [{ filename: 'logo.png', status: 'modified' }] }),
      [`${REPO}/compare/main...${HEAD}`]: () => ({ files: [{ filename: 'logo.png', status: 'modified' }] }),
    });
    expect(await values(noPatch)).toMatchObject({ rebase_only: null });
  });

  it('billable files: CodeRabbit\'s count for this head, else Pointsman\'s', async () => {
    expect(await values(routes({ [COMMENTS]: () => [comment(NOTICE)] }))).toMatchObject({ billable_files: 2, price_stated: true });
    // Edited before the head was pushed: about an older head.
    expect(await values(routes({ [COMMENTS]: () => [comment(NOTICE, BEFORE)] }))).toMatchObject({ billable_files: 2, price_stated: false });
    const three = NOTICE.replace('2 billable files', '3 billable files');
    expect(await values(routes({ [COMMENTS]: () => [comment(three, PUSHED), comment(NOTICE.replace('2 billable files', '1 billable file'), AFTER)] })))
      .toMatchObject({ billable_files: 1, price_stated: true });
    expect(await values(routes({ [COMMENTS]: () => [comment(three)] }), [{ name: 'cr', type: 'coderabbit', at: '$.pull_request' }])).toMatchObject({ billable_files: 3 });
    // Without not_reviewed every changed file counts.
    expect(await values(routes(), [{ name: 'cr', type: 'coderabbit', at: '$.pull_request' }])).toMatchObject({ billable_files: 3, price_stated: false });
    expect(billableIn('This review includes **12** billable files')).toBe(12);
  });

  it('when the push time is not known, text counts from CodeRabbit\'s first status on the head', async () => {
    const noPush = { [`${REPO}/activity`]: () => [] };
    expect(await values(routes({ ...noPush, [COMMENTS]: () => [comment(NOTICE, AFTER)], [STATUSES]: () => [status('Review rate limited', PUSHED)] })))
      .toMatchObject({ price_stated: true });
    expect(await values(routes({ ...noPush, [COMMENTS]: () => [comment(NOTICE, BEFORE)], [STATUSES]: () => [status('Review rate limited', PUSHED)] })))
      .toMatchObject({ price_stated: false });
    // Neither known: nothing counts for the head.
    expect(await values(routes({ ...noPush, [COMMENTS]: () => [comment(NOTICE, AFTER)] }))).toMatchObject({ price_stated: false });
  });

  it('only CodeRabbit\'s own account counts', async () => {
    const impostor = { login: 'coderabbitai[bot]', id: 99, type: 'Bot' };
    const person = { login: 'coderabbitai', id: 136622811, type: 'User' };
    expect(await values(routes({
      [`${PR}/reviews`]: () => [review('APPROVED', HEAD, '', impostor), review('APPROVED', HEAD, '', { login: 'mallory', id: 7, type: 'User' })],
      [STATUSES]: () => [status('Review completed', AFTER, impostor), { ...status('Review completed'), context: 'coderabbit-ish' }],
      // The real bot without its app, a look-alike with the app, a person who pastes the notice.
      [COMMENTS]: () => [comment(NOTICE, AFTER, crBot, null), comment(NOTICE, AFTER, impostor), comment(NOTICE, AFTER, person, null), comment(NOTICE, AFTER, { login: 'alice', id: 3, type: 'User' }, null)],
      '/graphql': () => graph([thread(false, { __typename: 'Bot', login: 'coderabbitai', databaseId: 1 })]),
      [`${REPO}/commits/${'d'.repeat(40)}/statuses`]: () => [status('Review completed', AFTER, impostor)],
    }))).toEqual({
      installed: false, ignored: false, reviewed_any: false, reviewed_head: false, in_progress: false,
      approved_head: false, rebase_only: false, changes_requested: false, unresolved_threads: 0, outside_diff_findings: false,
      billable_files: 2, price_stated: false,
    });
  });

  it('missing when a read fails or the head moved', async () => {
    expect(await reason(routes({ [`${PR}/reviews`]: () => new Response('{}', { status: 502 }) }))).toBe('error');
    expect(await reason(routes({ [COMMENTS]: () => new Response('{}', { status: 500 }) }))).toBe('error');
    expect(await reason(routes({ [STATUSES]: () => ({ wrong: 'shape' }) }))).toBe('error');
    expect(await reason(routes({ '/graphql': () => ({ errors: [{ message: 'x' }] }) }))).toBe('error');
    expect(await reason(routes({ [`${PR}/files`]: () => new Response('{}', { status: 500 }) }))).toBe('error');
    expect(await reason(routes({ [`${REPO}/pulls`]: () => new Response('{}', { status: 500 }) }))).toBe('error');
    expect(await reason(routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/main...${OLD}`]: () => new Response('{}', { status: 500 }),
      [`${REPO}/compare/main...${HEAD}`]: () => patch('@@ -1 +1 @@\n-a\n+b'),
    }))).toBe('error');
    expect(await reason(routes({ [PR]: () => ({ ...pullRequest(), head: { sha: OLD, ref: 'docs', repo: { id: 1, full_name: 'octo-org/demo' } } }) }))).toBe('stale');
    expect(await reason(routes({ [PR]: () => new Response('{}', { status: 404 }) }))).toBe('unavailable');
    const f = (await lookupFacts(crSpec, { pull_request: { repo: 'x', number: 7, head: HEAD } }, new CodeRabbitFactProvider({ auth: new TokenAuth(TOKEN) }))).cr!;
    expect(f).toEqual({ missing: true, reason: 'no_pr' });
  });

  it('shares one snapshot with the GitHub facts', async () => {
    const server = fakeGitHub(routes());
    const auth = new TokenAuth(TOKEN);
    const router = new ModuleRouter(new Map<string, FactProvider>([
      ['@pointsman/github', new GitHubFactProvider({ auth, fetch: server.fetchFn })],
      ['@pointsman/coderabbit', new CodeRabbitFactProvider({ auth, fetch: server.fetchFn })],
    ]));
    const facts = await lookupFacts([...crSpec, { name: 'copilot', type: 'github_copilot', at: '$.pull_request' }], state, router);
    expect(facts.cr?.missing).toBe(false);
    expect(facts.copilot?.missing).toBe(false);
    for (const path of [`${PR}/reviews`, `${PR}/files`, COMMENTS, '/graphql']) expect(server.calls.filter((c) => c.path === path).length, path).toBe(1);
    // The pull request: once at the start, and once more after each list that
    // describes it now (files, reviews, comments), so a push in between makes the facts stale.
    expect(server.calls.filter((c) => c.path === PR)).toHaveLength(4);
  });
});

const IN_PROGRESS_TEXT = 'Review in progress';

describe('the module', () => {
  const create = (env: Record<string, unknown>) => coderabbitModule.create(env, {});

  it('off by default, mock, or on with the GitHub settings', () => {
    expect(create({})).toBeUndefined();
    expect(create({ FACTS_CODERABBIT: 'off' })).toBeUndefined();
    expect(create({ FACTS_CODERABBIT: 'mock' })).toBeDefined();
    expect(create({ FACTS_CODERABBIT: 'on', FACTS_GITHUB: 'token', FACTS_GITHUB_TOKEN: TOKEN })).toBeInstanceOf(CodeRabbitFactProvider);
  });

  it('refuses settings that do not fit', () => {
    expect(() => create({ FACTS_CODERABBIT: 'on' })).toThrow(ConfigError);
    expect(() => create({ FACTS_CODERABBIT: 'on', FACTS_GITHUB: 'mock' })).toThrow(ConfigError);
    expect(() => create({ FACTS_CODERABBIT: 'yes' })).toThrow(ConfigError);
  });

  it('mock values fit the type', async () => {
    const f = await create({ FACTS_CODERABBIT: 'mock' })!.lookup({ type: 'coderabbit' }, new AbortController().signal);
    expect(resultError('coderabbit', f)).toBeNull();
  });
});
