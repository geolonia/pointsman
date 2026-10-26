// CodeRabbit facts (packages/coderabbit) against a fake GitHub API: every
// field, that only CodeRabbit's own account counts, that text counts for
// the head only when written after the head was pushed, each way the fact
// can be missing, the shared snapshot, and the module's settings.

import { describe, expect, it } from 'vitest';
import { lookupFacts, resultError } from '../../src/facts';
import { coderabbitModule, CodeRabbitFactProvider, ignoredBy, billableIn } from '@pointsman/coderabbit';
import { ConfigError } from '@pointsman/module-api';
import { GitHubFactProvider, hunksBefore, occurrences, TokenAuth } from '@pointsman/github';
import { ModuleRouter, type FactProvider } from '../../src/facts';
import type { FactSpec } from '../../src/types';

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const BASE = 'e'.repeat(40);
const REPO = '/repos/octo-org/demo';
const PR = `${REPO}/pulls/7`;
const COMMENTS = `${REPO}/issues/7/comments`;
const STATUSES = `${REPO}/commits/${HEAD}/statuses`;
const state = { pull_request: { repo: 'octo-org/demo', number: 7, head: HEAD } };
const TOKEN = `test-${crypto.randomUUID()}`;
const crSpec: FactSpec[] = [{ name: 'cr', type: 'coderabbit', at: '$.pull_request', not_reviewed: ['**/pnpm-lock.yaml'] }];

type Handler = (url: URL, init: RequestInit, table?: Record<string, Handler>) => unknown;

const PUSHED = '2026-10-22T01:00:00Z';
const BEFORE = '2026-10-22T00:00:00Z';
const AFTER = '2026-10-22T02:00:00Z';

const crBot = { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' };
const crApp = { id: 347564 };
const pullRequest = (body = 'Fixes the guide.') => ({
  state: 'open', merged: false, draft: false, title: 'Docs', body,
  head: { sha: HEAD, ref: 'docs', repo: { id: 1, full_name: 'octo-org/demo' } },
  base: { ref: 'main', sha: BASE, repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
  user: { login: 'alice', type: 'User' },
  additions: 3, deletions: 1, changed_files: 3, commits: 1,
});
/** The same id for the same item, however often a handler makes it (REST and GraphQL must agree). */
const idOf = (x: unknown) => [...JSON.stringify(x)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_007, 7) + 1;
const withId = <T extends object>(x: T) => ({ id: idOf(x), ...x });
const review = (state: string, commit = HEAD, body = '', user: unknown = crBot) => withId({ user, state, commit_id: commit, body, submitted_at: AFTER });
const status = (description: string, at = AFTER, creator: unknown = crBot, state = 'success') => ({ context: 'CodeRabbit', state, description, creator, created_at: at });
const comment = (body: string, updated = AFTER, user: unknown = crBot, app: unknown = crApp) => withId({ user, performed_via_github_app: app, author_association: 'NONE', body, created_at: updated, updated_at: updated });
/** A summary with a limit notice, about the range ending at `head`. */
const notice = (files: number, head = HEAD) =>
  `> ## Review limit reached\n> <sub>This review includes ${files} billable file${files === 1 ? '' : 's'} and costs up to $${(files * 0.25).toFixed(2)}.</sub>\n> Reviewing files that changed from the base of the PR and between ${OLD} and ${head}.`;
const NOTICE = notice(2);
const thread = (resolved: boolean, author: unknown = { __typename: 'Bot', login: 'coderabbitai', databaseId: 136622811 }) => ({ isResolved: resolved, comments: { nodes: [{ author }] } });
const graph = (threads: unknown[] = [], more = false) => ({
  data: { repository: { pullRequest: { headRefOid: HEAD, reviewRequests: { totalCount: 0, nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: more }, nodes: threads } } } },
});
type Item = { id: number; body?: string };
/** Who last edited each comment and review, with the same text: nobody, unless `editedBy` names an editor by id. */
const editorsOf = (comments: Item[], reviews: Item[], editedBy: Record<number, unknown> = {}) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid: HEAD,
        comments: { totalCount: comments.length, nodes: comments.map((c) => ({ databaseId: c.id, body: c.body ?? '', editor: editedBy[c.id] ?? null })) },
        reviews: { totalCount: reviews.length, nodes: reviews.map((r) => ({ databaseId: r.id, body: r.body ?? '', editor: editedBy[r.id] ?? null })) },
      },
    },
  },
});
/** GraphQL: the review state (threads), or the editors of the table's comments and reviews. */
const gql = (threads: unknown[] = [], more = false, editedBy: Record<number, unknown> = {}): Handler => async (_url, init, table) => {
  if (!String(init.body).includes('editor')) return graph(threads, more);
  const list = async (path: string) => (await table![path]!(new URL(`https://api.github.com${path}`), {})) as Item[];
  return editorsOf(await list(COMMENTS), await list(`${PR}/reviews`), editedBy);
};
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
    '/graphql': gql(),
    ...over,
  };
}

function fakeGitHub(table: Record<string, Handler>) {
  const calls: { method: string; path: string; body: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', path: url.pathname, body: typeof init.body === 'string' ? init.body : '' });
    const handler = table[url.pathname];
    if (!handler) return new Response('{"message":"Not Found"}', { status: 404 });
    const body = await handler(url, init, table);
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
    // A start marker without its end hides nothing, before or after the command; whole blocks are left out, each one.
    const start = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';
    expect(ignoredBy(`Docs.\n${start}\n@coderabbitai ignore`)).toBe(true);
    expect(ignoredBy(`@coderabbitai ignore\n${start}`)).toBe(true);
    expect(ignoredBy(`${summary}\n${summary}`)).toBe(false);
    expect(ignoredBy(`${summary}\n${start}\n@coderabbitai ignore`)).toBe(true);
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
    // An approval without text does not take the findings back; a later review with text does.
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('COMMENTED', OLD, body), review('APPROVED')] }))).toMatchObject({ outside_diff_findings: true });
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('COMMENTED', OLD, body), review('COMMENTED', HEAD, 'No further comments.')] }))).toMatchObject({ outside_diff_findings: false });
  });

  it('unresolved threads CodeRabbit started; no value over one page', async () => {
    const person = { __typename: 'User', login: 'bob', databaseId: 5 };
    expect(await values(routes({ '/graphql': gql([thread(false), thread(true), thread(false, person)]) }))).toMatchObject({ unresolved_threads: 1 });
    expect(await values(routes({ '/graphql': gql([thread(false)], true) }))).toMatchObject({ unresolved_threads: null });
  });

  it('rebase only: the head has the same change as the approved commit', async () => {
    const MB1 = '1'.repeat(40);
    const MB2 = '2'.repeat(40);
    const files = (lines: string, mergeBase: string) => ({ ...patch(lines), merge_base_commit: { sha: mergeBase } });
    const content = (text: string) => () => ({ type: 'file', encoding: 'base64', size: text.length, content: btoa(text) });
    // Both from the same merge base: the line numbers count too.
    const same = (old: string, head: string) => routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/${BASE}...${OLD}`]: () => files(old, MB1),
      [`${REPO}/compare/${BASE}...${HEAD}`]: () => files(head, MB1),
    });
    expect(await values(same('@@ -1 +1 @@\n-a\n+b', '@@ -1 +1 @@\n-a\n+b'))).toMatchObject({ rebase_only: true, approved_head: false });
    expect(await values(same('@@ -1 +1 @@\n-a\n+b', '@@ -1 +1 @@\n-a\n+c'))).toMatchObject({ rebase_only: false });
    // The same edit with the same surrounding lines at another place (two identical blocks), without a rebase: another change.
    expect(await values(same('@@ -1,2 +1,1 @@\n helper()\n-check()', '@@ -9,2 +9,1 @@\n helper()\n-check()'))).toMatchObject({ rebase_only: false });

    // A rebase: the base moved from MB1 to MB2. Where the base did not change the file, the numbers still count.
    const rebased = (head: string, baseChanged: string[], atBase: string, atOld = 'helper()\ncheck()\nend\n') => routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/${BASE}...${OLD}`]: () => files('@@ -1,2 +1,1 @@\n helper()\n-check()', MB1),
      [`${REPO}/compare/${BASE}...${HEAD}`]: () => files(head, MB2),
      [`${REPO}/compare/${MB1}...${MB2}`]: () => ({ status: 'ahead', files: baseChanged.map((filename) => ({ filename })) }),
      [`${REPO}/contents/docs/guide.md`]: (url) => content(url.searchParams.get('ref') === MB2 ? atBase : atOld)(),
    });
    expect(await values(rebased('@@ -9,2 +9,1 @@\n helper()\n-check()', ['src/other.ts'], ''))).toMatchObject({ rebase_only: false });
    expect(await values(rebased('@@ -1,2 +1,1 @@\n helper()\n-check()', ['src/other.ts'], ''))).toMatchObject({ rebase_only: true });
    // The base changed the file (lines moved): the same lines once at the base, so the place is clear.
    expect(await values(rebased('@@ -9,2 +9,1 @@\n helper()\n-check()', ['docs/guide.md'], 'new\nlines\nhelper()\ncheck()\nend\n'))).toMatchObject({ rebase_only: true });
    // Two identical blocks at the old base: the new base changed the approved one, so the head's block is
    // unique at the new base, but the approved edit's place was not clear: it cannot be told.
    expect(await values(rebased('@@ -9,2 +9,1 @@\n helper()\n-check()', ['docs/guide.md'], 'new\nhelper()\ncheck()\n', 'helper()\ncheck()\nmid\nhelper()\ncheck()\n'))).toMatchObject({ rebase_only: null });
    // The same lines twice at the base: the approved edit may have moved to the other block, so it cannot be told.
    expect(await values(rebased('@@ -9,2 +9,1 @@\n helper()\n-check()', ['docs/guide.md'], 'helper()\ncheck()\nmid\nhelper()\ncheck()\n'))).toMatchObject({ rebase_only: null });
    // A file with CRLF line ends: the patch keeps the \r, and the place is still found.
    expect(occurrences('a\r\nhelper()\r\ncheck()\r\n', hunksBefore('@@ -2,2 +2,1 @@\n helper()\r\n-check()\r')[0]!)).toBe(1);
    // The file cannot be read at the base for another reason than 404: the fact fails, as for a comparison.
    const failing = routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/${BASE}...${OLD}`]: () => files('@@ -1,2 +1,1 @@\n helper()\n-check()', MB1),
      [`${REPO}/compare/${BASE}...${HEAD}`]: () => files('@@ -9,2 +9,1 @@\n helper()\n-check()', MB2),
      [`${REPO}/compare/${MB1}...${MB2}`]: () => ({ status: 'ahead', files: [{ filename: 'docs/guide.md' }] }),
      [`${REPO}/contents/docs/guide.md`]: () => new Response('{}', { status: 500 }),
    });
    expect(await reason(failing)).toBe('error');
    // More files the base moved than are read: cannot tell, and none is read.
    const many = Array.from({ length: 11 }, (_, i) => ({ filename: `docs/p${i}.md`, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }));
    const wide = routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/${BASE}...${OLD}`]: () => ({ files: many, merge_base_commit: { sha: MB1 } }),
      [`${REPO}/compare/${BASE}...${HEAD}`]: () => ({ files: many, merge_base_commit: { sha: MB2 } }),
      [`${REPO}/compare/${MB1}...${MB2}`]: () => ({ status: 'ahead', files: many.map((f) => ({ filename: f.filename })) }),
    });
    expect(await values(wide)).toMatchObject({ rebase_only: null });
    // The base comparison not listed (too large): cannot tell.
    const unlisted = routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/${BASE}...${OLD}`]: () => files('@@ -1 +1 @@\n-a\n+b', MB1),
      [`${REPO}/compare/${BASE}...${HEAD}`]: () => files('@@ -5 +5 @@\n-a\n+b', MB2),
      [`${REPO}/compare/${MB1}...${MB2}`]: () => ({ status: 'ahead', files: [] }),
    });
    expect(await values(unlisted)).toMatchObject({ rebase_only: null });
    // No files listed (a very large comparison): cannot tell.
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('APPROVED', OLD)], [`${REPO}/compare/${BASE}...${OLD}`]: () => ({ files: [] }), [`${REPO}/compare/${BASE}...${HEAD}`]: () => ({ files: [] }) })))
      .toMatchObject({ rebase_only: null });
    // A file without a patch (binary, too large): cannot tell.
    const noPatch = routes({
      [`${PR}/reviews`]: () => [review('APPROVED', OLD)],
      [`${REPO}/compare/${BASE}...${OLD}`]: () => ({ files: [{ filename: 'logo.png', status: 'modified' }], merge_base_commit: { sha: MB1 } }),
      [`${REPO}/compare/${BASE}...${HEAD}`]: () => ({ files: [{ filename: 'logo.png', status: 'modified' }], merge_base_commit: { sha: MB1 } }),
    });
    expect(await values(noPatch)).toMatchObject({ rebase_only: null });
  });

  it('billable files: CodeRabbit\'s count for this head, else Pointsman\'s', async () => {
    expect(await values(routes({ [COMMENTS]: () => [comment(NOTICE)] }))).toMatchObject({ billable_files: 2, price_stated: true });
    // About another head: CodeRabbit edits its summary in place, so the edit time does not tell; the commit it names does.
    expect(await values(routes({ [COMMENTS]: () => [comment(notice(5, OLD), AFTER)] }))).toMatchObject({ billable_files: 2, price_stated: false });
    expect(await values(routes({ [COMMENTS]: () => [comment(notice(5).replace(/Reviewing files[^\n]*/, ''), AFTER)] }))).toMatchObject({ price_stated: false });
    // Naming the head but edited before it was pushed: not about this push.
    expect(await values(routes({ [COMMENTS]: () => [comment(notice(5), BEFORE)] }))).toMatchObject({ billable_files: 2, price_stated: false });
    // The newest notice about the head wins.
    expect(await values(routes({ [COMMENTS]: () => [comment(notice(3), PUSHED), comment(notice(1), AFTER)] }))).toMatchObject({ billable_files: 1, price_stated: true });
    expect(await values(routes({ [COMMENTS]: () => [comment(notice(3))] }), [{ name: 'cr', type: 'coderabbit', at: '$.pull_request' }])).toMatchObject({ billable_files: 3 });
    // Without not_reviewed every changed file counts.
    expect(await values(routes(), [{ name: 'cr', type: 'coderabbit', at: '$.pull_request' }])).toMatchObject({ billable_files: 3, price_stated: false });
    expect(billableIn('This review includes **12** billable files')).toBe(12);
  });

  it('missing when someone other than CodeRabbit edited its comment or review', async () => {
    const editor = { __typename: 'User', login: 'alice', databaseId: 3 };
    const c = comment(notice(1));
    expect(await reason(routes({ [COMMENTS]: () => [c], '/graphql': gql([], false, { [c.id]: editor }) }))).toBe('error');
    const r = review('COMMENTED', HEAD, 'Outside diff range comments (1)');
    expect(await reason(routes({ [`${PR}/reviews`]: () => [r], '/graphql': gql([], false, { [r.id]: editor }) }))).toBe('error');
    // CodeRabbit editing its own comment is normal.
    const self = { __typename: 'Bot', login: 'coderabbitai', databaseId: 136622811 };
    expect(await values(routes({ [COMMENTS]: () => [c], '/graphql': gql([], false, { [c.id]: self }) }))).toMatchObject({ price_stated: true });
    // A comment the editors list does not have: not known, so missing.
    expect(await reason(routes({
      [COMMENTS]: () => [c],
      '/graphql': async (_u, init) => (String(init.body).includes('editor') ? editorsOf([], []) : graph()),
    }))).toBe('error');
    // GraphQL saw other text than REST (an edit between the two reads): the editor it names is not the text's.
    const later = (body: string) => async (_u: URL, init: RequestInit) => (String(init.body).includes('editor')
      ? editorsOf([{ id: c.id, body }], [], { [c.id]: self }) : graph());
    expect(await reason(routes({ [COMMENTS]: () => [c], '/graphql': later(notice(4)) }))).toBe('error');
    expect(await values(routes({ [COMMENTS]: () => [c], '/graphql': later(c.body) }))).toMatchObject({ price_stated: true });
    const rLater = async (_u: URL, init: RequestInit) => (String(init.body).includes('editor')
      ? editorsOf([], [{ id: r.id, body: 'Looks good' }], { [r.id]: self }) : graph());
    expect(await reason(routes({ [`${PR}/reviews`]: () => [r], '/graphql': rLater }))).toBe('error');
    // A node without an id (GraphQL's databaseId is nullable) is left out, not an error.
    const withNull = async (_u: URL, init: RequestInit) => {
      if (!String(init.body).includes('editor')) return graph();
      const e = editorsOf([c], []) as any;
      e.data.repository.pullRequest.comments.nodes.push({ databaseId: null, body: 'x', editor: null });
      e.data.repository.pullRequest.comments.totalCount = 2;
      return e;
    };
    expect(await values(routes({ [COMMENTS]: () => [c], '/graphql': withNull }))).toMatchObject({ price_stated: true });
    // Edits by others to someone else's comment do not matter.
    const own = comment('a note', AFTER, { login: 'bob', id: 5, type: 'User' }, null);
    expect(await values(routes({ [COMMENTS]: () => [own], '/graphql': gql([], false, { [own.id]: editor }) }))).toMatchObject({ price_stated: false });
  });

  it('only CodeRabbit\'s own account counts', async () => {
    const impostor = { login: 'coderabbitai[bot]', id: 99, type: 'Bot' };
    const person = { login: 'coderabbitai', id: 136622811, type: 'User' };
    expect(await values(routes({
      [`${PR}/reviews`]: () => [review('APPROVED', HEAD, '', impostor), review('APPROVED', HEAD, '', { login: 'mallory', id: 7, type: 'User' })],
      [STATUSES]: () => [status('Review completed', AFTER, impostor), { ...status('Review completed'), context: 'coderabbit-ish' }],
      // The real bot without its app, a look-alike with the app, a person who pastes the notice.
      [COMMENTS]: () => [comment(NOTICE, AFTER, crBot, null), comment(NOTICE, AFTER, impostor), comment(NOTICE, AFTER, person, null), comment(NOTICE, AFTER, { login: 'alice', id: 3, type: 'User' }, null)],
      '/graphql': gql([thread(false, { __typename: 'Bot', login: 'coderabbitai', databaseId: 1 })]),
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
      [`${REPO}/compare/${BASE}...${OLD}`]: () => new Response('{}', { status: 500 }),
      [`${REPO}/compare/${BASE}...${HEAD}`]: () => patch('@@ -1 +1 @@\n-a\n+b'),
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
    for (const path of [`${PR}/reviews`, `${PR}/files`, COMMENTS]) expect(server.calls.filter((c) => c.path === path).length, path).toBe(1);
    // Two GraphQL queries, each once: review state, and the editors of comments and reviews.
    expect(server.calls.filter((c) => c.path === '/graphql')).toHaveLength(2);
    // The editors are read after the comments and reviews, so an edit in between shows.
    const order = server.calls.map((c) => c.path);
    const editorsAt = server.calls.findIndex((c) => c.path === '/graphql' && c.body.includes('editor'));
    expect(editorsAt).toBeGreaterThan(order.lastIndexOf(COMMENTS));
    expect(editorsAt).toBeGreaterThan(order.lastIndexOf(`${PR}/reviews`));
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
