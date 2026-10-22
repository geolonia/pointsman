// The review side of the GitHub snapshot (packages/github/src/reviews.ts):
// reviews, comments, status history, review threads and requests, and the
// Copilot facts, against a fake GitHub API. Only Copilot's own bot account
// counts; every way the fact can be missing.

import { describe, expect, it } from 'vitest';
import { lookupFacts, resultError } from '../../src/facts';
import {
  COPILOT, GitHubFactProvider, isService, MAX_REVIEW_PAGES, reviewState, snapshotOf, TokenAuth,
} from '@pointsman/github';
import type { FactSpec } from '../../src/types';

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const REPO = '/repos/octo-org/demo';
const PR = `${REPO}/pulls/7`;
const state = { pull_request: { repo: 'octo-org/demo', number: 7, head: HEAD } };
const ref = { owner: 'octo-org', repo: 'demo', number: 7, head: HEAD };
const TOKEN = `test-${crypto.randomUUID()}`;
const copilotSpec: FactSpec[] = [{ name: 'copilot', type: 'github_copilot', at: '$.pull_request' }];

type Handler = (url: URL, init: RequestInit) => unknown;

const pullRequest = () => ({
  state: 'open', merged: false, draft: false, title: 'Docs',
  head: { sha: HEAD, ref: 'docs', repo: { id: 1, full_name: 'octo-org/demo' } },
  base: { ref: 'main', repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
  user: { login: 'alice', type: 'User' },
  additions: 1, deletions: 0, changed_files: 1, commits: 1,
});
const copilotUser = { login: 'copilot-pull-request-reviewer[bot]', id: 175728472, type: 'Bot' };
const review = (state: string, commit = HEAD, user: unknown = copilotUser, at = '2026-10-22T01:00:00Z') => ({ user, state, commit_id: commit, body: '', submitted_at: at });
const graph = (over: { requested?: unknown[]; threads?: unknown[]; more?: boolean; head?: string; total?: number } = {}) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid: over.head ?? HEAD,
        reviewRequests: { totalCount: over.total ?? (over.requested ?? []).length, nodes: (over.requested ?? []).map((r) => ({ requestedReviewer: r })) },
        reviewThreads: { pageInfo: { hasNextPage: over.more ?? false }, nodes: over.threads ?? [] },
      },
    },
  },
});
const copilotRequest = { __typename: 'Bot', login: 'copilot-pull-request-reviewer', databaseId: 175728472 };

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [PR]: () => pullRequest(),
    [`${PR}/commits`]: () => [{ sha: HEAD, commit: { verification: { verified: true } } }],
    [`${PR}/reviews`]: () => [],
    ['/repos/octo-org/demo/issues/7/comments']: () => [],
    [`${REPO}/commits/${HEAD}/statuses`]: () => [],
    [`${REPO}/activity`]: () => [{ activity_type: 'push', before: '0'.repeat(40), after: HEAD, actor: { login: 'alice' }, timestamp: '2026-10-22T00:30:00Z' }],
    '/graphql': () => graph(),
    ...over,
  };
}

function fakeGitHub(table: Record<string, Handler>) {
  const calls: { method: string; path: string; body: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', path: url.pathname, body: typeof init.body === 'string' ? init.body : '' });
    expect(init.redirect).toBe('manual');
    const handler = table[url.pathname];
    if (!handler) return new Response('{"message":"Not Found"}', { status: 404 });
    const body = await handler(url, init);
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function copilot(table: Record<string, Handler> = routes(), specs = copilotSpec) {
  const server = fakeGitHub(table);
  const facts = await lookupFacts(specs, state, new GitHubFactProvider({ auth: new TokenAuth(TOKEN), fetch: server.fetchFn }));
  return { facts, server };
}
const values = async (table?: Record<string, Handler>) => {
  const f = (await copilot(table)).facts.copilot!;
  if (f.missing) throw new Error(`missing: ${f.reason}`);
  expect(resultError('github_copilot', f)).toBeNull();
  return f.values;
};
const reason = async (table: Record<string, Handler>) => {
  const f = (await copilot(table)).facts.copilot!;
  return f.missing ? f.reason : 'not missing';
};

describe('Copilot (github_copilot)', () => {
  it('without Copilot: nothing requested, no reviews', async () => {
    expect(await values()).toEqual({ requested: false, reviewed_head: false, approved_head: false, reviews: 0 });
  });

  it('requested, through GraphQL (the REST list leaves Copilot out)', async () => {
    expect(await values(routes({ '/graphql': () => graph({ requested: [copilotRequest] }) }))).toMatchObject({ requested: true });
  });

  it('reviewed and approved the head', async () => {
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('COMMENTED', OLD), review('APPROVED')] })))
      .toEqual({ requested: false, reviewed_head: true, approved_head: true, reviews: 2 });
  });

  it('an approval of an older commit, or one followed by a change request, does not count', async () => {
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('APPROVED', OLD)] }))).toMatchObject({ reviewed_head: false, approved_head: false, reviews: 1 });
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('APPROVED'), review('CHANGES_REQUESTED')] }))).toMatchObject({ reviewed_head: true, approved_head: false });
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('APPROVED'), review('DISMISSED')] }))).toMatchObject({ approved_head: false });
    // A comment after the approval keeps it.
    expect(await values(routes({ [`${PR}/reviews`]: () => [review('APPROVED'), review('COMMENTED')] }))).toMatchObject({ approved_head: true, reviews: 2 });
  });

  it('only Copilot\'s own bot account counts: same login with another id, a user named Copilot, a pending review', async () => {
    const fakes = [
      review('APPROVED', HEAD, { ...copilotUser, id: 1 }),
      review('APPROVED', HEAD, { login: 'Copilot', id: 175728472, type: 'User' }),
      review('APPROVED', HEAD, { login: 'copilot-reviewer', id: 175728472, type: 'Bot' }),
      review('PENDING'),
    ];
    expect(await values(routes({ [`${PR}/reviews`]: () => fakes }))).toEqual({ requested: false, reviewed_head: false, approved_head: false, reviews: 0 });
    const fakeRequest = { __typename: 'Bot', login: 'copilot-pull-request-reviewer', databaseId: 2 };
    expect(await values(routes({ '/graphql': () => graph({ requested: [fakeRequest, { __typename: 'User', login: 'copilot', databaseId: 175728472 }] }) })))
      .toMatchObject({ requested: false });
  });

  it('missing when a read fails, the head moved, or there is more than is read', async () => {
    expect(await reason(routes({ [`${PR}/reviews`]: () => new Response('{}', { status: 500 }) }))).toBe('error');
    expect(await reason(routes({ [`${PR}/reviews`]: () => ({ not: 'a list' }) }))).toBe('error');
    expect(await reason(routes({ '/graphql': () => ({ data: null, errors: [{ message: 'no' }] }) }))).toBe('error');
    // Partial data with errors (GitHub's usual answer for NOT_FOUND or RATE_LIMITED) is no answer.
    expect(await reason(routes({ '/graphql': () => ({ ...graph({ requested: [copilotRequest] }), errors: [{ type: 'RATE_LIMITED' }] }) }))).toBe('error');
    // A push while the reviews were read: the pull request is read once more after them.
    let reads = 0;
    const moving = () => (++reads === 1 ? pullRequest() : { ...pullRequest(), head: { sha: OLD, ref: 'docs', repo: { id: 1, full_name: 'octo-org/demo' } } });
    expect(await reason(routes({ [PR]: moving }))).toBe('stale');
    expect(await reason(routes({ '/graphql': () => new Response('{}', { status: 403 }) }))).toBe('unavailable');
    expect(await reason(routes({ '/graphql': () => graph({ head: OLD }) }))).toBe('stale');
    expect(await reason(routes({ '/graphql': () => graph({ requested: [copilotRequest], total: 101 }) }))).toBe('error');
    const full = Array.from({ length: 100 }, () => review('COMMENTED', OLD, { login: 'bob', id: 5, type: 'User' }));
    expect(await reason(routes({ [`${PR}/reviews`]: () => full }))).toBe('error');
  });

  it('reads every page of reviews up to the limit', async () => {
    const full = Array.from({ length: 100 }, () => review('COMMENTED', OLD, { login: 'bob', id: 5, type: 'User' }));
    const server = fakeGitHub(routes({ [`${PR}/reviews`]: (url) => (url.searchParams.get('page') === '2' ? [review('APPROVED')] : full) }));
    const facts = await lookupFacts(copilotSpec, state, new GitHubFactProvider({ auth: new TokenAuth(TOKEN), fetch: server.fetchFn }));
    expect(facts.copilot).toMatchObject({ missing: false, values: { approved_head: true, reviews: 1 } });
    expect(server.calls.filter((c) => c.path === `${PR}/reviews`)).toHaveLength(2);
    expect(MAX_REVIEW_PAGES).toBe(5);
  });

  it('one snapshot: two facts read the reviews and GraphQL once; GraphQL gets a query, never a mutation', async () => {
    const { server } = await copilot(routes(), [...copilotSpec, { name: 'again', type: 'github_copilot', at: '$.pull_request' }]);
    expect(server.calls.filter((c) => c.path === '/graphql')).toHaveLength(1);
    expect(server.calls.filter((c) => c.path === `${PR}/reviews`)).toHaveLength(1);
    for (const c of server.calls) {
      if (c.path === '/graphql') {
        expect(c.method).toBe('POST');
        expect(JSON.parse(c.body).query).toMatch(/^query\b/);
        expect(JSON.parse(c.body).query).not.toMatch(/mutation/);
      } else {
        expect(c.method).toBe('GET');
      }
    }
  });
});

describe('the snapshot\'s review reads (for other modules)', () => {
  const snapshot = (table: Record<string, Handler> = routes()) => snapshotOf(ref, new Map(), fakeGitHub(table).fetchFn, new TokenAuth(TOKEN));

  it('is shared through the decision\'s scope', () => {
    const scope = new Map<string, unknown>();
    const { fetchFn } = fakeGitHub(routes());
    expect(snapshotOf(ref, scope, fetchFn, new TokenAuth(TOKEN))).toBe(snapshotOf({ ...ref, owner: 'OCTO-ORG' }, scope, fetchFn, new TokenAuth(TOKEN)));
    // Something else under the key is not taken for a snapshot.
    const other = new Map<string, unknown>([[`github:octo-org/demo#7@${HEAD}`, {}]]);
    expect(snapshotOf(ref, other, fetchFn, new TokenAuth(TOKEN))).not.toEqual({});
  });

  it('comments with their author, app and association', async () => {
    const s = snapshot(routes({
      '/repos/octo-org/demo/issues/7/comments': () => [
        { user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' }, performed_via_github_app: { id: 347564 }, author_association: 'NONE', body: 'hi', created_at: '2026-10-22T01:00:00Z', updated_at: '2026-10-22T02:00:00Z' },
        { user: null, body: 'from a deleted account', created_at: '2026-10-22T01:00:00Z' },
      ],
    }));
    expect(await s.comments()).toEqual([
      { id: null, by: { login: 'coderabbitai[bot]', id: 136622811, bot: true }, app: 347564, association: 'NONE', body: 'hi', created: '2026-10-22T01:00:00Z', updated: '2026-10-22T02:00:00Z' },
      { id: null, by: { login: '', id: null, bot: false }, app: null, association: 'NONE', body: 'from a deleted account', created: '2026-10-22T01:00:00Z', updated: '2026-10-22T01:00:00Z' },
    ]);
  });

  it('the head\'s status history, with who set each status', async () => {
    const s = snapshot(routes({
      [`${REPO}/commits/${HEAD}/statuses`]: () => [
        { context: 'CodeRabbit', state: 'success', description: 'Review completed', creator: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' }, created_at: '2026-10-22T02:00:00Z' },
      ],
    }));
    expect(await s.headStatuses()).toEqual([
      { context: 'CodeRabbit', state: 'success', description: 'Review completed', by: { login: 'coderabbitai[bot]', id: 136622811, bot: true }, at: '2026-10-22T02:00:00Z' },
    ]);
  });

  it('when the head was pushed; null when the activity list does not show it', async () => {
    expect(await snapshot().headPushedAt()).toBe('2026-10-22T00:30:00Z');
    expect(await snapshot(routes({ [`${REPO}/activity`]: () => [] })).headPushedAt()).toBeNull();
    expect(await snapshot(routes({ [`${REPO}/activity`]: () => new Response('{}', { status: 404 }) })).headPushedAt()).toBeNull();
  });

  it('review threads: who started each; unknown over one page', () => {
    const thread = (resolved: boolean, author: unknown) => ({ isResolved: resolved, comments: { nodes: [{ author }] } });
    const crBot = { __typename: 'Bot', login: 'coderabbitai', databaseId: 136622811 };
    expect(reviewState(graph({ threads: [thread(false, crBot), thread(true, null)] }).data).threads).toEqual([
      { resolved: false, by: { login: 'coderabbitai', id: 136622811, bot: true } },
      { resolved: true, by: { login: '', id: null, bot: false } },
    ]);
    expect(reviewState(graph({ threads: [thread(false, crBot)], more: true }).data).threads).toBeNull();
  });

  it('a service account needs both its id and its login, with or without [bot]', () => {
    expect(isService({ login: 'copilot-pull-request-reviewer', id: COPILOT.id, bot: true }, COPILOT)).toBe(true);
    expect(isService({ login: 'Copilot-Pull-Request-Reviewer[bot]', id: COPILOT.id, bot: true }, COPILOT)).toBe(true);
    expect(isService({ login: 'copilot-pull-request-reviewer[bot]', id: 7, bot: true }, COPILOT)).toBe(false);
    expect(isService({ login: 'someone', id: COPILOT.id, bot: false }, COPILOT)).toBe(false);
  });
});

describe('the GitHub settings other modules use', () => {
  it('give an id that is not made of the secrets', async () => {
    const { githubAuthFrom } = await import('@pointsman/github');
    const found = githubAuthFrom({ FACTS_GITHUB: 'token', FACTS_GITHUB_TOKEN: TOKEN });
    if (typeof found === 'string') throw new Error('expected credentials');
    expect(found.id).not.toContain(TOKEN);
    // The same settings give the same credentials (an app's tokens are reused).
    const again = githubAuthFrom({ FACTS_GITHUB: 'token', FACTS_GITHUB_TOKEN: TOKEN });
    expect(again).toBe(found);
    expect(githubAuthFrom({})).toBe('off');
    expect(githubAuthFrom({ FACTS_GITHUB: 'mock' })).toBe('mock');
  });
});
