// GitHub pull-request facts (src/facts-github.ts) against a fake GitHub API:
// every field, the shared snapshot, each way a fact can be missing, the
// settings, and that only GET requests are sent.

import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noCallbacks } from './helpers';
import { ConfigError, createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { FactError, FactRouter, lookupFacts, MockFactProvider, resultError, toPullRequest, type FactProvider } from '../../src/facts';
import { GitHubAppAuth, GitHubFactProvider, isWipTitle, MAX_FILES, MAX_PUSH_PAGES, nextCursor, privateKeyDer, TokenAuth } from '../../src/facts-github';
import { codeownersMatch, MAX_CODEOWNERS_BYTES, MAX_PATTERN_LENGTH, ownerLookup, parseCodeowners } from '../../src/codeowners';
import { matchGlob } from '../../src/glob';
import { depsFor } from '../../src/index';
import { D1DecisionLog } from '../../src/log';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { FactSpec, Profile } from '../../src/types';
import * as contract from '../../generated/openapi-validators.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = '/repos/octo-org/demo';
const PR = `${REPO}/pulls/7`;
const state = { pull_request: { repo: 'octo-org/demo', number: 7, head: HEAD } };
// Made at run time: no token-looking literal in the repository (secret scanning).
const TOKEN = `test-${crypto.randomUUID()}`;

const specs: FactSpec[] = [
  { name: 'pr', type: 'github_pr', at: '$.pull_request' },
  { name: 'docs', type: 'github_paths', at: '$.pull_request', paths: ['docs/**', '**/*.md'], except: ['**/AGENTS.md'] },
  { name: 'ci', type: 'github_checks', at: '$.pull_request' },
  { name: 'level', type: 'github_property', at: '$.pull_request', property: 'security-level' },
];
const spec = (name: string) => [specs.find((s) => s.name === name)!];

type Json = unknown;
type Handler = (url: URL, init: RequestInit) => Json | Response | Promise<Json | Response>;

function pullRequest(over: Record<string, unknown> = {}) {
  return {
    state: 'open', merged: false, draft: false, title: 'Fix a typo in the guide',
    head: { sha: HEAD, ref: 'fix-typo', repo: { id: 1, full_name: 'octo-org/demo' } },
    base: { ref: 'main', repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
    user: { login: 'alice', type: 'User' },
    additions: 3, deletions: 1, changed_files: 2, commits: 1,
    ...over,
  };
}
const commit = (sha: string, verified = true) => ({ sha, commit: { verification: { verified } } });
const file = (filename: string, previous?: string) => ({ filename, ...(previous && { previous_filename: previous }) });
const run = (name: string, status = 'completed', conclusion: string | null = 'success', app = 15368) => ({ name, status, conclusion, app: { id: app }, started_at: '2026-10-21T00:00:00Z' });
const push = (after: string, actor = 'alice', before = '0'.repeat(40), timestamp = '2026-10-21T00:00:00Z') => ({ activity_type: 'push', before, after, actor: { login: actor }, timestamp });
const codeowners = (text: string) => ({ type: 'file', encoding: 'base64', content: btoa(text) });
const requiredRule = (...checks: { context: string; integration_id?: number }[]) => [{ type: 'required_status_checks', parameters: { required_status_checks: checks } }];

/** The answers of a small, docs-only pull request in an organization repo; override by path. */
function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [PR]: () => pullRequest(),
    [`${PR}/commits`]: () => [commit(HEAD)],
    [`${PR}/files`]: () => [file('docs/guide.md'), file('README.md')],
    '/orgs/octo-org/members/alice': () => new Response(null, { status: 204 }),
    [`${REPO}/rules/branches/main`]: () => requiredRule({ context: 'test' }),
    [`${REPO}/branches/main`]: () => ({ name: 'main', protected: false }),
    [`${REPO}/commits/${HEAD}/check-runs`]: () => ({ total_count: 1, check_runs: [run('test')] }),
    [`${REPO}/commits/${HEAD}/status`]: () => ({ total_count: 0, statuses: [] }),
    [`${REPO}/properties/values`]: () => [{ property_name: 'security-level', value: 'high' }],
    [`${REPO}/activity`]: (url) => (expect(url.searchParams.get('ref')).toBe('refs/heads/fix-typo'), [push(HEAD)]),
    ...over,
  };
}

function fakeGitHub(table: Record<string, Handler> = routes()) {
  const calls: { method: string; url: URL; auth: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url, auth: new Headers(init.headers).get('authorization') });
    expect(url.origin).toBe('https://api.github.com');
    expect(init.redirect).toBe('manual');
    const handler = table[url.pathname];
    if (!handler) return new Response('{"message":"Not Found"}', { status: 404 });
    const body = await handler(url, init);
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  const count = (path: string) => calls.filter((c) => c.url.pathname === path).length;
  return { fetchFn, calls, count };
}

const provider = (server: ReturnType<typeof fakeGitHub>, ignoreCheck?: string) =>
  new GitHubFactProvider({ auth: new TokenAuth(TOKEN), fetch: server.fetchFn, ignoreCheck });

async function facts(table: Record<string, Handler> = routes(), which: FactSpec[] = specs, s: unknown = state) {
  const server = fakeGitHub(table);
  return { facts: await lookupFacts(which, s, provider(server)), server };
}
const values = async (name: string, table?: Record<string, Handler>) => {
  const f = (await facts(table, spec(name))).facts[name]!;
  if (f.missing) throw new Error(`missing: ${f.reason}`);
  return f.values;
};
const reasonOf = async (name: string, table?: Record<string, Handler>) => (await facts(table, spec(name))).facts[name];

afterEach(() => vi.restoreAllMocks());

describe('the pull request (github_pr)', () => {
  it('reads every field from one snapshot', async () => {
    const { facts: f } = await facts(routes(), spec('pr'));
    expect(f.pr).toEqual({
      missing: false,
      values: {
        open: true, merged: false, draft: false, wip_title: false, files: 2, changed_lines: 4, base_is_default: true,
        author_member: true, author_dependabot: false, fork: false, all_commits_verified: true,
        pushed_by_author: 'yes', author_sole_code_owner: false,
      },
      source: `GitHub octo-org/demo#7 at ${HEAD.slice(0, 7)}`,
    });
    expect(resultError('github_pr', f.pr!.missing ? null : f.pr)).toBeNull();
  });

  it('closed, merged and draft', async () => {
    expect(await values('pr', routes({ [PR]: () => pullRequest({ state: 'closed', merged: true }) }))).toMatchObject({ open: false, merged: true });
    expect(await values('pr', routes({ [PR]: () => pullRequest({ draft: true }) }))).toMatchObject({ open: true, draft: true });
  });

  it('finds WIP as a word in the title', () => {
    for (const t of ['WIP: docs', '[WIP] docs', 'docs (wip)', 'wip', 'Docs - WIP']) expect(isWipTitle(t), t).toBe(true);
    for (const t of ['Wipe the cache', 'swipe', 'Fix docs']) expect(isWipTitle(t), t).toBe(false);
  });

  it('base branch, fork and a deleted fork', async () => {
    expect(await values('pr', routes({ [PR]: () => pullRequest({ base: { ref: 'release', repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } } }) })))
      .toMatchObject({ base_is_default: false });
    expect(await values('pr', routes({ [PR]: () => pullRequest({ head: { sha: HEAD, ref: 'fix-typo', repo: { id: 2 } } }) }))).toMatchObject({ fork: true });
    expect(await values('pr', routes({ [PR]: () => pullRequest({ head: { sha: HEAD, ref: 'fix-typo', repo: null } }) }))).toMatchObject({ fork: true });
  });

  it('author: member, not a member, not known, and owner of a user repo', async () => {
    expect(await values('pr', routes({ '/orgs/octo-org/members/alice': () => new Response(null, { status: 404 }) }))).toMatchObject({ author_member: false });
    expect(await values('pr', routes({ '/orgs/octo-org/members/alice': () => new Response('{}', { status: 403 }) }))).toMatchObject({ author_member: null });
    // 302: the token's user is not a member, so GitHub shows only public members.
    expect(await values('pr', routes({ '/orgs/octo-org/members/alice': () => new Response(null, { status: 302, headers: { location: 'https://api.github.com/orgs/octo-org/public_members/alice' } }) })))
      .toMatchObject({ author_member: null });
    const userRepo = (login: string) => routes({ [PR]: () => pullRequest({ user: { login, type: 'User' }, base: { ref: 'main', repo: { id: 1, default_branch: 'main', owner: { type: 'User' } } } }) });
    expect(await values('pr', userRepo('Octo-Org'))).toMatchObject({ author_member: true });
    expect(await values('pr', userRepo('bob'))).toMatchObject({ author_member: false });
  });

  it('Dependabot needs its login and the Bot type; a bot is not a member', async () => {
    const server = fakeGitHub(routes({ [PR]: () => pullRequest({ user: { login: 'dependabot[bot]', type: 'Bot' } }) }));
    const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
    expect(f.missing === false && f.values).toMatchObject({ author_dependabot: true, author_member: false });
    expect(server.calls.some((c) => c.url.pathname.startsWith('/orgs/'))).toBe(false);
    expect(await values('pr', routes({ [PR]: () => pullRequest({ user: { login: 'dependabot[bot]', type: 'User' } }) }))).toMatchObject({ author_dependabot: false });
  });

  it('signatures: every commit verified, one not, and too many commits to tell', async () => {
    const two = routes({ [PR]: () => pullRequest({ commits: 2 }), [`${PR}/commits`]: () => [commit(OTHER, false), commit(HEAD)] });
    expect(await values('pr', two)).toMatchObject({ all_commits_verified: false });
    const many = routes({ [PR]: () => pullRequest({ commits: 251 }), [`${PR}/commits`]: () => Array.from({ length: 100 }, () => commit(OTHER)) });
    expect(await values('pr', many)).toMatchObject({ all_commits_verified: null });
  });

  it('reads commits over several pages, ending with the head', async () => {
    const list = [...Array.from({ length: 149 }, (_, i) => commit(i.toString(16).padStart(40, '0'))), commit(HEAD)];
    const server = fakeGitHub(routes({
      [PR]: () => pullRequest({ commits: 150 }),
      [`${PR}/commits`]: (url) => list.slice((Number(url.searchParams.get('page')) - 1) * 100, Number(url.searchParams.get('page')) * 100),
    }));
    const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
    expect(f.missing === false && f.values.all_commits_verified).toBe(true);
    expect(server.count(`${PR}/commits`)).toBe(2);
  });
});

describe('who pushed (github_pr.pushed_by_author)', () => {
  const C1 = '1'.repeat(40);
  const C2 = '2'.repeat(40);
  const three = (activity: Handler) => routes({
    [PR]: () => pullRequest({ commits: 3 }),
    [`${PR}/commits`]: () => [commit(C1), commit(C2), commit(HEAD)],
    [`${REPO}/activity`]: activity,
  });
  const pushed = async (table: Record<string, Handler>) => (await values('pr', table)).pushed_by_author;

  it('yes when the author pushed every commit, in one push or several', async () => {
    expect(await pushed(three(() => [push(HEAD)]))).toBe('yes');
    expect(await pushed(three(() => [push(HEAD, 'alice', C2, '2026-10-21T02:00:00Z'), push(C2, 'Alice', C1, '2026-10-21T01:00:00Z'), push(C1)]))).toBe('yes');
  });

  it('no when someone else pushed a commit, for example "Update branch"', async () => {
    expect(await pushed(three(() => [push(HEAD, 'bob', C2, '2026-10-21T02:00:00Z'), push(C2)]))).toBe('no');
    // Known to be someone else, even when other commits are not known.
    expect(await pushed(three(() => [push(HEAD, 'bob', C2)]))).toBe('no');
    // A deleted account is not the author.
    expect(await pushed(three(() => [{ ...push(HEAD), actor: null }]))).toBe('no');
  });

  it('unavailable when not every commit is known', async () => {
    // A push brings only the commits after its "before": C1 and C2 came in an older push, not in the list.
    expect(await pushed(three(() => [push(HEAD, 'alice', C2)]))).toBe('unavailable');
    // A new branch or a force push ("before" not in the pull request) brings every commit up to its head.
    expect(await pushed(three(() => [push(HEAD, 'alice', OTHER)]))).toBe('yes');
    // The head commit is in no listed push (for example older than the list): not known.
    expect(await pushed(three(() => [push(C2)]))).toBe('unavailable');
    expect(await pushed(routes({ [`${REPO}/activity`]: () => [] }))).toBe('unavailable');
    expect(await pushed(routes({ [`${REPO}/activity`]: () => new Response('{}', { status: 403 }) }))).toBe('unavailable');
    expect(await pushed(routes({ [PR]: () => pullRequest({ head: { sha: HEAD, ref: 'x', repo: null } }) }))).toBe('unavailable');
    expect(await pushed(routes({ [PR]: () => pullRequest({ commits: 251 }), [`${PR}/commits`]: () => Array.from({ length: 100 }, () => commit(OTHER)) }))).toBe('unavailable');
  });

  it('reads a fork\'s pushes from the fork', async () => {
    const server = fakeGitHub(routes({
      [PR]: () => pullRequest({ head: { sha: HEAD, ref: 'fix-typo', repo: { id: 2, full_name: 'carol/demo' } } }),
      '/repos/carol/demo/activity': () => [push(HEAD)],
    }));
    const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
    expect(f.missing === false && f.values).toMatchObject({ fork: true, pushed_by_author: 'yes' });
  });

  it('a failing activity list fails the fact', async () => {
    expect(await reasonOf('pr', routes({ [`${REPO}/activity`]: () => new Response('{}', { status: 500 }) }))).toEqual({ missing: true, reason: 'error' });
  });

  /** Pages of the activity list, chained by an "after" cursor in the Link header. */
  const paged = (pages: unknown[][], over: Record<number, () => Response> = {}): Handler => (url) => {
    const after = url.searchParams.get('after');
    const i = after === null ? 0 : Number(after.slice(1));
    expect(url.searchParams.get('ref')).toBe('refs/heads/fix-typo');
    if (over[i]) return over[i]!();
    // The Link header points elsewhere on purpose: only its cursor is used.
    const link = i + 1 < pages.length ? { link: `<https://example.com/repositories/1/activity?ref=x&after=c${i + 1}>; rel="next"` } : undefined;
    return Response.json(pages[i] ?? [], link ? { headers: link } : {});
  };

  it('reads older pages until it finds the pushes', async () => {
    const server = fakeGitHub(three(paged([[push(HEAD, 'alice', C2, '2026-10-21T02:00:00Z')], [push(C2, 'alice', C1, '2026-10-21T01:00:00Z'), push(C1)]])));
    const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
    expect(f.missing === false && f.values.pushed_by_author).toBe('yes');
    expect(server.calls.filter((c) => c.url.pathname === `${REPO}/activity`).map((c) => c.url.searchParams.get('after'))).toEqual([null, 'c1']);
    // Someone else's push found only on the second page.
    expect(await pushed(three(paged([[push(HEAD, 'alice', C2, '2026-10-21T02:00:00Z')], [push(C2, 'bob', '0'.repeat(40), '2026-10-21T01:00:00Z')]])))).toBe('no');
  });

  it('stops at the push that created the branch, and ignores older pushes of an earlier branch', async () => {
    const created = { ...push(HEAD, 'alice', '0'.repeat(40), '2026-10-21T01:00:00Z'), activity_type: 'branch_creation' };
    const older = push(C2, 'bob', C1, '2026-10-20T01:00:00Z');
    const server = fakeGitHub(three(paged([[created, older], [push(C1, 'bob')]])));
    const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
    expect(f.missing === false && f.values.pushed_by_author).toBe('yes');
    expect(server.count(`${REPO}/activity`)).toBe(1);
  });

  it('stops at a creation push on a later page, and ignores pushes older than it there', async () => {
    const created = { ...push(C2, 'alice', '0'.repeat(40), '2026-10-21T01:00:00Z'), activity_type: 'branch_creation' };
    const pages = [[push(HEAD, 'alice', C2, '2026-10-21T02:00:00Z')], [created, push(C1, 'bob', '0'.repeat(40), '2026-10-20T00:00:00Z')], [push(C1, 'bob')]];
    const server = fakeGitHub(three(paged(pages)));
    const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
    expect(f.missing === false && f.values.pushed_by_author).toBe('yes');
    expect(server.count(`${REPO}/activity`)).toBe(2);
  });

  it('pushes in the same second keep their order', async () => {
    // Newest first, same second: bob pushed C1 and C2, then alice force-pushed HEAD
    // (its before is not in the pull request). Read newest first, alice would claim every commit.
    const same = '2026-10-21T01:00:00Z';
    expect(await pushed(three(() => [push(HEAD, 'alice', OTHER, same), push(C2, 'bob', '0'.repeat(40), same)]))).toBe('no');
    expect(await pushed(three(() => [push(HEAD, 'alice', OTHER, same), push(C2, 'alice', '0'.repeat(40), same)]))).toBe('yes');
  });

  it(`reads at most ${MAX_PUSH_PAGES} pages; older pushes stay unknown`, async () => {
    const unrelated = Array.from({ length: MAX_PUSH_PAGES + 2 }, (_, i) => [push(OTHER, 'alice', OTHER, `2026-10-2${i}T00:00:00Z`)]);
    const pages = [[push(HEAD, 'alice', C2, '2026-10-30T00:00:00Z')], ...unrelated, [push(C2, 'alice', '0'.repeat(40), '2026-10-01T00:00:00Z')]];
    const server = fakeGitHub(three(paged(pages)));
    const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
    expect(f.missing === false && f.values.pushed_by_author).toBe('unavailable');
    expect(server.count(`${REPO}/activity`)).toBe(MAX_PUSH_PAGES);
  });

  it('a later page that fails fails the fact; one that is not shown leaves older pushes unknown', async () => {
    const pages = [[push(HEAD, 'alice', C2, '2026-10-21T02:00:00Z')], [push(C2, 'alice', '0'.repeat(40), '2026-10-21T01:00:00Z')]];
    expect(await reasonOf('pr', three(paged(pages, { 1: () => new Response('{}', { status: 502 }) })))).toEqual({ missing: true, reason: 'error' });
    expect(await pushed(three(paged(pages, { 1: () => new Response('{}', { status: 403 }) })))).toBe('unavailable');
    // Someone else's push on the first page is still known.
    const bob = [[push(HEAD, 'bob', C2, '2026-10-21T02:00:00Z')], pages[1]!];
    expect(await pushed(three(paged(bob, { 1: () => new Response('{}', { status: 403 }) })))).toBe('no');
  });

  it('takes only the cursor from the Link header', () => {
    expect(nextCursor('<https://api.github.com/repositories/1/activity?per_page=100&after=Y3Vy>; rel="next"')).toBe('Y3Vy');
    expect(nextCursor('<https://api.github.com/x?before=a>; rel="prev"')).toBeNull();
    expect(nextCursor(null)).toBeNull();
    expect(nextCursor('<not a url>; rel="next"')).toBeNull();
  });
});

describe('code owners (github_pr.author_sole_code_owner)', () => {
  const owners = (text: string, extra: Record<string, Handler> = {}) => routes({ [`${REPO}/contents/.github/CODEOWNERS`]: (url) => (expect(url.searchParams.get('ref')).toBe('main'), codeowners(text)), ...extra });
  const sole = async (table: Record<string, Handler>) => (await values('pr', table)).author_sole_code_owner;

  it('true when the author owns every changed file alone', async () => {
    expect(await sole(owners('* @alice\n'))).toBe(true);
    expect(await sole(owners('# owners\n*.md @bob\ndocs/ @alice\nREADME.md @Alice  # me\n'))).toBe(true);
    // A team owns as its members.
    expect(await sole(owners('* @octo-org/writers', { '/orgs/octo-org/teams/writers/members': () => [{ login: 'alice' }] }))).toBe(true);
  });

  it('false when someone else owns a file, a file has no owner, or there is no CODEOWNERS', async () => {
    expect(await sole(owners('* @alice @bob'))).toBe(false);
    expect(await sole(owners('* @alice\ndocs/ @bob'))).toBe(false);
    expect(await sole(owners('docs/ @alice'))).toBe(false); // README.md has no owner
    expect(await sole(owners('* @alice\nREADME.md'))).toBe(false); // a line without owners
    expect(await sole(owners('* alice@example.com'))).toBe(false);
    expect(await sole(owners('* @octo-org/writers', { '/orgs/octo-org/teams/writers/members': () => [{ login: 'alice' }, { login: 'bob' }] }))).toBe(false);
    expect(await sole(routes())).toBe(false);
    expect(await sole(routes({ [PR]: () => pullRequest({ changed_files: 0 }), [`${PR}/files`]: () => [] }))).toBe(false);
  });

  it('"@org/." and "@org/.." are not teams: false, and the organization\'s members are never read', async () => {
    for (const owner of ['@octo-org/..', '@octo-org/.']) {
      const server = fakeGitHub(owners(`* ${owner}`, { '/orgs/octo-org/members': () => [{ login: 'alice' }] }));
      const f = (await lookupFacts(spec('pr'), state, provider(server))).pr!;
      expect(f.missing === false && f.values.author_sole_code_owner, owner).toBe(false);
      expect(server.calls.some((c) => c.url.pathname === '/orgs/octo-org/members' || c.url.pathname.includes('/teams/')), owner).toBe(false);
    }
  });

  it('a renamed file counts with both names', async () => {
    const renamed = owners('* @alice\nsecret/ @bob', { [PR]: () => pullRequest({ changed_files: 1 }), [`${PR}/files`]: () => [file('docs/a.md', 'secret/a.md')] });
    expect(await sole(renamed)).toBe(false);
  });

  it('reads CODEOWNERS where GitHub does, in its order', async () => {
    expect(await sole(routes({ '/repos/octo-org/demo/contents/docs/CODEOWNERS': () => codeowners('* @alice') }))).toBe(true);
    expect(await sole(routes({
      [`${REPO}/contents/CODEOWNERS`]: () => codeowners('* @bob'),
      [`${REPO}/contents/docs/CODEOWNERS`]: () => codeowners('* @alice'),
    }))).toBe(false);
  });

  it('CODEOWNERS or a team that cannot be read, or a pattern it cannot read safely: the fact is missing', async () => {
    expect(await reasonOf('pr', routes({ [`${REPO}/contents/CODEOWNERS`]: () => new Response('{}', { status: 403 }) }))).toEqual({ missing: true, reason: 'unavailable' });
    expect(await reasonOf('pr', owners('* @octo-org/writers'))).toEqual({ missing: true, reason: 'unavailable' });
    expect(await reasonOf('pr', owners('* @alice\n!docs/ @bob'))).toEqual({ missing: true, reason: 'error' });
    expect(await reasonOf('pr', owners('* @alice\n[ab].md @bob'))).toEqual({ missing: true, reason: 'error' });
  });

  it('matches patterns like GitHub', () => {
    const cases: [string, string, boolean][] = [
      ['*', 'a/b/c.js', true], ['*.js', 'a/b/c.js', true], ['*.js', 'c.ts', false],
      ['/build/logs/', 'build/logs/x/y.log', true], ['/build/logs/', 'src/build/logs/y.log', false],
      ['apps/', 'apps/a.js', true], ['apps/', 'src/apps/a.js', true],
      ['docs/*', 'docs/a.md', true], ['docs/*', 'docs/b/a.md', false],
      ['**/logs', 'build/logs/a.log', true], ['**/logs', 'logs', true],
      ['/scripts', 'scripts/a.sh', true], ['src/app.ts', 'src/app.ts', true], ['src/app.ts', 'lib/src/app.ts', false],
      ['README.md', 'docs/README.md', true],
    ];
    for (const [pattern, path, match] of cases) expect(codeownersMatch(pattern, path), `${pattern} ${path}`).toBe(match);
    expect(parseCodeowners('a\\#b.md @x # comment\n\n# only a comment')).toEqual([{ pattern: 'a#b.md', owners: ['@x'] }]);
    expect(parseCodeowners('#x @a\n\\#x @b#c\n docs/ @c\t# tab')).toEqual([{ pattern: '#x', owners: ['@b'] }, { pattern: 'docs/', owners: ['@c'] }]);
  });

  it('a file over the size limit makes the fact missing, never a guessed owner', async () => {
    // Exactly at the limit is read; one byte more is not.
    const sized = (bytes: number) => `* @alice\n${'#'.repeat(bytes - 9)}`;
    expect(sized(MAX_CODEOWNERS_BYTES)).toHaveLength(MAX_CODEOWNERS_BYTES);
    expect(await sole(owners(sized(MAX_CODEOWNERS_BYTES)))).toBe(true);
    expect(await reasonOf('pr', owners(sized(MAX_CODEOWNERS_BYTES + 1)))).toEqual({ missing: true, reason: 'error' });
    // GitHub's own size is checked before the content is decoded.
    const bySize = routes({ [`${REPO}/contents/.github/CODEOWNERS`]: () => ({ ...codeowners('* @alice'), size: MAX_CODEOWNERS_BYTES + 1 }) });
    expect(await reasonOf('pr', bySize)).toEqual({ missing: true, reason: 'error' });
    expect(() => parseCodeowners(`${'a'.repeat(MAX_PATTERN_LENGTH + 1)} @x`)).toThrow(FactError);
  });

  it('long crafted lines parse fast', () => {
    const start = Date.now();
    // No "#": the comment scan runs once over the line; the pattern is then too long.
    expect(() => parseCodeowners('a'.repeat(100_000))).toThrow(FactError);
    expect(() => parseCodeowners(`x${'\\'.repeat(100_000)}#`)).toThrow(FactError);
    expect(parseCodeowners(`* @a ${'\\'.repeat(100_000)}# done`)[0]!.pattern).toBe('*');
    expect(parseCodeowners(`${'#'.repeat(100_000)}\n* @a`)).toEqual([{ pattern: '*', owners: ['@a'] }]);
    // Many "#" and a lone "\r" at the end: a regular expression "#.*$" retries from every "#" (quadratic).
    expect(parseCodeowners(`${'a#'.repeat(60_000)}\r`)).toEqual([{ pattern: 'a', owners: [] }]);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('matching many paths against many patterns is bounded: past the limit the fact is missing', async () => {
    const rules = parseCodeowners('a @x\n*a*a*a*a*b @x\n'.repeat(5_000));
    const paths = Array.from({ length: 2_000 }, (_, i) => `src/${'d/'.repeat(10)}${'a'.repeat(50)}${i}`);
    const start = Date.now();
    expect(() => paths.forEach(ownerLookup(rules))).toThrow(FactError);
    expect(Date.now() - start).toBeLessThan(3000);
    // A large usual file stays within the budget: 1,000 folder patterns, anchored or not, against 2,000 deep paths.
    for (const prefix of ['', '/']) {
      const look = ownerLookup(parseCodeowners(Array.from({ length: 1_000 }, (_, i) => `${prefix}build${i}/ @a`).join('\n')));
      expect(Array.from({ length: 2_000 }, (_, i) => look(`zz/${'d/'.repeat(8)}build${i % 1_200}/f.ts`)).filter((o) => o !== null)).toHaveLength(prefix ? 0 : 1_800); // build0 to build999 exist; anchored ones are not at the top
    }
    // A usual file: last match wins, and nothing runs out.
    const owner = ownerLookup(parseCodeowners('* @a\n/docs/ @b\n*.md @c'));
    expect([owner('docs/x.ts'), owner('docs/x.md'), owner('src/x.ts')]).toEqual([['@b'], ['@c'], ['@a']]);
    // A budget too small for the paths fails.
    expect(() => ['docs/a.md', 'README.md'].forEach(ownerLookup(parseCodeowners('/x/ @a\n/y/ @b'), 2))).toThrow(FactError);
  });
});

describe('changed paths (github_paths)', () => {
  const withFiles = (...files: ReturnType<typeof file>[]) => routes({ [PR]: () => pullRequest({ changed_files: files.length }), [`${PR}/files`]: () => files });

  it('any, all and count', async () => {
    expect(await values('docs')).toEqual({ any: true, all: true, count: 2 });
    expect(await values('docs', withFiles(file('docs/a.md'), file('src/app.ts')))).toEqual({ any: true, all: false, count: 1 });
    expect(await values('docs', withFiles(file('src/app.ts')))).toEqual({ any: false, all: false, count: 0 });
  });

  it('the except list wins', async () => {
    expect(await values('docs', withFiles(file('docs/AGENTS.md')))).toEqual({ any: false, all: false, count: 0 });
    expect(await values('docs', withFiles(file('docs/a.md'), file('AGENTS.md')))).toEqual({ any: true, all: false, count: 1 });
  });

  it('all is false for an empty diff', async () => {
    const server = fakeGitHub(withFiles());
    expect((await lookupFacts(spec('docs'), state, provider(server))).docs).toMatchObject({ values: { any: false, all: false, count: 0 } });
    // No file to read: no files request.
    expect(server.count(`${PR}/files`)).toBe(0);
  });

  it('a renamed file counts with both names', async () => {
    // Moved out of an excepted name: still not all.
    expect(await values('docs', withFiles(file('docs/notes.md', 'AGENTS.md')))).toEqual({ any: true, all: false, count: 1 });
    // Moved from code into docs: any, but not all.
    expect(await values('docs', withFiles(file('docs/a.md', 'src/a.txt')))).toEqual({ any: true, all: false, count: 1 });
  });

  it('reads large pull requests page by page, up to the limit', async () => {
    const names = Array.from({ length: 250 }, (_, i) => file(`docs/${i}.md`));
    const server = fakeGitHub(routes({
      [PR]: () => pullRequest({ changed_files: 250 }),
      [`${PR}/files`]: (url) => names.slice((Number(url.searchParams.get('page')) - 1) * 100, Number(url.searchParams.get('page')) * 100),
    }));
    expect((await lookupFacts(spec('docs'), state, provider(server))).docs).toMatchObject({ values: { all: true, count: 250 } });
    expect(server.count(`${PR}/files`)).toBe(3);
  });

  it('more files than the limit: the path facts are missing, the pull request is not', async () => {
    const { facts: f, server } = await facts(routes({ [PR]: () => pullRequest({ changed_files: MAX_FILES + 1 }) }), [...spec('pr'), ...spec('docs')]);
    expect(f.docs).toEqual({ missing: true, reason: 'error' });
    expect(f.pr).toMatchObject({ missing: false, values: { files: MAX_FILES + 1 } });
    expect(server.count(`${PR}/files`)).toBe(0);
  });

  it('a push while the files were read: stale', async () => {
    let reads = 0;
    const moved = routes({ [PR]: () => (++reads === 1 ? pullRequest() : pullRequest({ head: { sha: OTHER, ref: 'fix-typo', repo: { id: 1 } } })) });
    expect(await reasonOf('docs', moved)).toEqual({ missing: true, reason: 'stale' });
  });

  it('a file list that does not match the pull request is an error', async () => {
    expect(await reasonOf('docs', routes({ [PR]: () => pullRequest({ changed_files: 3 }) }))).toEqual({ missing: true, reason: 'error' });
  });
});

describe('globs', () => {
  const cases: [string, string, boolean][] = [
    ['docs/**', 'docs/a.md', true], ['docs/**', 'docs/a/b/c.txt', true], ['docs/**', 'docs', false], ['docs/**', 'src/docs/a', false],
    ['**/*.md', 'README.md', true], ['**/*.md', 'a/b/README.md', true], ['**/*.md', 'a/b/README.mdx', false],
    ['*.md', 'README.md', true], ['*.md', 'docs/a.md', false],
    ['**/AGENTS.md', 'AGENTS.md', true], ['**/AGENTS.md', 'x/AGENTS.md', true], ['**/AGENTS.md', 'xAGENTS.md', false],
    ['a/**/b', 'a/b', true], ['a/**/b', 'a/x/y/b', true],
    ['.github/**', '.github/workflows/ci.yml', true], ['**/*.yml', '.github/workflows/ci.yml', true],
    ['file?.txt', 'file1.txt', true], ['file?.txt', 'file/.txt', false],
    ['a+b(c).md', 'a+b(c).md', true], ['a.md', 'aXmd', false],
  ];
  it.each(cases)('%s matches %s: %s', (glob, path, match) => {
    expect(matchGlob(glob, path)).toBe(match);
  });
  it('runs of stars match like one, and stay fast', () => {
    expect(matchGlob('a***b', 'aXb')).toBe(true);
    expect(matchGlob('***/x', 'a/b/x')).toBe(true);
    expect(matchGlob('**/**/**/x', 'a/b/x')).toBe(true);
    const start = Date.now();
    expect(matchGlob('a*a*a*a*a*a*a*a*b', 'a'.repeat(200))).toBe(false);
    expect(matchGlob('**/**/**/**/x', 'a/'.repeat(100))).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('required checks (github_checks)', () => {
  const runs = (...r: ReturnType<typeof run>[]) => ({ [`${REPO}/commits/${HEAD}/check-runs`]: () => ({ total_count: r.length, check_runs: r }) });

  it('green when every required check passed', async () => {
    expect(await values('ci')).toEqual({ required: 1, green: true, pending: false, failed: false });
    expect(await values('ci', routes(runs(run('test', 'completed', 'skipped'))))).toMatchObject({ green: true });
  });

  it('pending while a check runs or has not reported', async () => {
    expect(await values('ci', routes(runs(run('test', 'in_progress', null))))).toEqual({ required: 1, green: false, pending: true, failed: false });
    expect(await values('ci', routes(runs()))).toEqual({ required: 1, green: false, pending: true, failed: false });
  });

  it('failed wins over pending', async () => {
    const r = routes({ ...runs(run('test', 'completed', 'failure')), [`${REPO}/rules/branches/main`]: () => requiredRule({ context: 'test' }, { context: 'lint' }) });
    expect(await values('ci', r)).toEqual({ required: 2, green: false, pending: false, failed: true });
  });

  it('green is false without required checks', async () => {
    expect(await values('ci', routes({ [`${REPO}/rules/branches/main`]: () => [] }))).toEqual({ required: 0, green: false, pending: false, failed: false });
  });

  it('never waits for its own check', async () => {
    const r = routes({ ...runs(run('test')), [`${REPO}/rules/branches/main`]: () => requiredRule({ context: 'test' }, { context: 'pointsman' }) });
    expect(await values('ci', r)).toMatchObject({ required: 2, pending: true });
    const server = fakeGitHub(r);
    const f = await lookupFacts(spec('ci'), state, provider(server, 'pointsman'));
    expect(f.ci).toMatchObject({ values: { required: 1, green: true } });
  });

  it('a check that must come from one app ignores other apps', async () => {
    const r = routes({ ...runs(run('test', 'completed', 'success', 999)), [`${REPO}/rules/branches/main`]: () => requiredRule({ context: 'test', integration_id: 15368 }) });
    expect(await values('ci', r)).toMatchObject({ green: false, pending: true });
  });

  it('workflows that a ruleset requires count, matched with runs of the required workflow', async () => {
    const wfRule = [...requiredRule({ context: 'test' }), { type: 'workflows', parameters: { workflows: [{ path: '.github/workflows/security.yml', ref: 'refs/tags/v1', repository_id: 42 }] } }];
    const wfRun = (status: string, conclusion: string | null, required = true) => ({
      path: '.github/workflows/security.yml', status, conclusion, created_at: '2026-10-21T00:00:00Z',
      workflow_url: `https://api.github.com${REPO}/actions/${required ? 'required_workflows' : 'workflows'}/5`,
    });
    const withRuns = (...runs: unknown[]) => routes({
      [`${REPO}/rules/branches/main`]: () => wfRule,
      [`${REPO}/actions/runs`]: (url) => (expect(url.searchParams.get('head_sha')).toBe(HEAD), { total_count: runs.length, workflow_runs: runs }),
    });
    expect(await values('ci', withRuns(wfRun('completed', 'success')))).toEqual({ required: 2, green: true, pending: false, failed: false });
    // The path of a workflow from another repository can come with that repository and a ref.
    const prefixed = { ...wfRun('completed', 'failure'), path: 'octo-org/policies/.github/workflows/security.yml@refs/tags/v1' };
    expect(await values('ci', withRuns(prefixed))).toMatchObject({ required: 2, failed: true });
    expect(await values('ci', withRuns(wfRun('completed', 'failure')))).toMatchObject({ required: 2, green: false, failed: true });
    expect(await values('ci', withRuns(wfRun('in_progress', null)))).toMatchObject({ green: false, pending: true });
    expect(await values('ci', withRuns())).toMatchObject({ green: false, pending: true });
    // A workflow of the repository at the same path does not stand in for the required one.
    expect(await values('ci', withRuns(wfRun('completed', 'success', false)))).toMatchObject({ green: false, pending: true });
    // Without a workflows rule, workflow runs are not read.
    const { server } = await facts(routes(), spec('ci'));
    expect(server.count(`${REPO}/actions/runs`)).toBe(0);
  });

  it('protection that cannot be seen: unavailable; any app (-1) counts', async () => {
    expect(await reasonOf('ci', routes({ [`${REPO}/branches/main`]: () => ({ protected: true }) }))).toEqual({ missing: true, reason: 'unavailable' });
    const anyApp = routes({
      [`${REPO}/rules/branches/main`]: () => [],
      [`${REPO}/branches/main`]: () => ({ protected: true, protection: { required_status_checks: { checks: [{ context: 'test', app_id: -1 }] } } }),
    });
    expect(await values('ci', anyApp)).toMatchObject({ required: 1, green: true });
  });

  it('a check run and a status of the same name that disagree: the stricter one', async () => {
    const r = routes({ [`${REPO}/commits/${HEAD}/status`]: () => ({ total_count: 1, statuses: [{ context: 'test', state: 'failure' }] }) });
    expect(await values('ci', r)).toMatchObject({ green: false, failed: true });
  });

  it('commit statuses and classic branch protection count too', async () => {
    const r = routes({
      ...runs(run('test')),
      [`${REPO}/branches/main`]: () => ({ protected: true, protection: { required_status_checks: { contexts: ['ci/legacy'], checks: [{ context: 'ci/legacy', app_id: null }] } } }),
      [`${REPO}/commits/${HEAD}/status`]: () => ({ total_count: 1, statuses: [{ context: 'ci/legacy', state: 'pending' }] }),
    });
    expect(await values('ci', r)).toEqual({ required: 2, green: false, pending: true, failed: false });
    const passed = { ...r, [`${REPO}/commits/${HEAD}/status`]: () => ({ total_count: 1, statuses: [{ context: 'ci/legacy', state: 'success' }] }) };
    expect(await values('ci', passed)).toMatchObject({ required: 2, green: true });
  });
});

describe('custom properties (github_property)', () => {
  const props = (v: unknown) => routes({ [`${REPO}/properties/values`]: () => v });

  it('a value, unset, and a multi-select list', async () => {
    expect(await values('level')).toEqual({ value: 'high' });
    expect(await values('level', props([]))).toEqual({ value: 'unset' });
    expect(await values('level', props([{ property_name: 'security-level', value: null }]))).toEqual({ value: 'unset' });
    expect(await values('level', props([{ property_name: 'security-level', value: ['b', 'a'] }]))).toEqual({ value: 'a,b' });
  });
});

describe('one snapshot per decision', () => {
  it('reads each part once for all facts', async () => {
    const { facts: f, server } = await facts();
    expect(Object.values(f).every((x) => !x.missing)).toBe(true);
    for (const path of [`${PR}/commits`, `${PR}/files`, `${REPO}/rules/branches/main`, `${REPO}/properties/values`]) expect(server.count(path), path).toBe(1);
    // The pull request once more after its files, against a push in between.
    expect(server.count(PR)).toBe(2);
  });

  it('reads only the parts the facts need', async () => {
    const { server } = await facts(routes(), spec('level'));
    expect(server.count(`${PR}/files`)).toBe(0);
    expect(server.count(`${REPO}/rules/branches/main`)).toBe(0);
  });

  it('only GET requests, each with the token', async () => {
    const { server } = await facts();
    expect(server.calls.length).toBeGreaterThan(0);
    for (const c of server.calls) {
      expect(c.method).toBe('GET');
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
    }
  });
});

describe('missing facts', () => {
  const all = async (table: Record<string, Handler>, s: unknown = state) =>
    Object.values((await facts(table, specs, s)).facts);

  it('another head commit: every GitHub fact is stale', async () => {
    expect(await all(routes({ [PR]: () => pullRequest({ head: { sha: OTHER, ref: 'fix-typo', repo: { id: 1 } } }) }))).toEqual(specs.map(() => ({ missing: true, reason: 'stale' })));
    // A push while the snapshot was read: the commits end with another commit.
    expect(await all(routes({ [`${PR}/commits`]: () => [commit(OTHER)] }))).toEqual(specs.map(() => ({ missing: true, reason: 'stale' })));
  });

  it('no pull request in the request: no_pr, and no request to GitHub', async () => {
    for (const bad of [
      {}, { pull_request: 'octo-org/demo#7' },
      { pull_request: { repo: 'octo-org', number: 7, head: HEAD } },
      { pull_request: { repo: 'octo-org/..', number: 7, head: HEAD } },
      { pull_request: { repo: 'octo-org/demo/x', number: 7, head: HEAD } },
      { pull_request: { repo: 'octo-org/demo', number: 0, head: HEAD } },
      { pull_request: { repo: 'octo-org/demo', number: 1.5, head: HEAD } },
      { pull_request: { repo: 'octo-org/demo', number: 7, head: 'abc123' } },
    ]) {
      const { facts: f, server } = await facts(routes(), specs, bad);
      expect(Object.values(f), JSON.stringify(bad)).toEqual(specs.map(() => ({ missing: true, reason: 'no_pr' })));
      expect(server.calls).toHaveLength(0);
    }
    expect(toPullRequest({ repo: 'Octo-Org/demo.js', number: 7, head: HEAD.toUpperCase() })).toEqual({ owner: 'Octo-Org', repo: 'demo.js', number: 7, head: HEAD });
  });

  it('not found or no access: unavailable', async () => {
    expect(await all(routes({ [PR]: () => new Response('{}', { status: 404 }) }))).toEqual(specs.map(() => ({ missing: true, reason: 'unavailable' })));
    expect(await reasonOf('level', routes({ [`${REPO}/properties/values`]: () => new Response('{}', { status: 403 }) }))).toEqual({ missing: true, reason: 'unavailable' });
  });

  it('server errors, rate limits, redirects and bad answers: error', async () => {
    for (const res of [
      () => new Response('{}', { status: 500 }),
      () => new Response('{}', { status: 429 }),
      () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      () => new Response('{}', { status: 403, headers: { 'retry-after': '60' } }),
      () => new Response(null, { status: 301, headers: { location: 'https://example.com/' } }),
      () => new Response('not json', { status: 200 }),
      () => ({ state: 'open' }),
    ]) {
      expect(await all(routes({ [PR]: res }))).toEqual(specs.map(() => ({ missing: true, reason: 'error' })));
    }
  });

  it('too slow: timeout', async () => {
    const slow = routes({ [PR]: () => new Promise<Json>(() => undefined) });
    const server = fakeGitHub(slow);
    const f = await lookupFacts(specs, state, provider(server), 20);
    expect(Object.values(f)).toEqual(specs.map(() => ({ missing: true, reason: 'timeout' })));
  });

  it('no provider, or only a spatial one: unavailable', async () => {
    expect(Object.values(await lookupFacts(specs, state, undefined))).toEqual(specs.map(() => ({ missing: true, reason: 'unavailable' })));
    const spatialOnly = new FactRouter({ spatial: new MockFactProvider() });
    expect(Object.values(await lookupFacts(specs, state, spatialOnly))).toEqual(specs.map(() => ({ missing: true, reason: 'unavailable' })));
  });

  it('never logs the token', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await all(routes({ [PR]: () => new Response('{}', { status: 500 }) }));
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });
});

describe('mock answers', () => {
  it('fit the fact types', async () => {
    const f = await lookupFacts(specs, state, new MockFactProvider());
    for (const s of specs) {
      const fact = f[s.name]!;
      expect(fact.missing, s.name).toBe(false);
      expect(resultError(s.type, fact.missing ? null : { values: fact.values, source: fact.source })).toBeNull();
    }
  });
});

// ---- GitHub App ----

function pem(der: Uint8Array, label: string): string {
  const b64 = btoa(String.fromCharCode(...der)).replace(/.{64}/g, '$&\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** The PKCS#1 key inside a PKCS#8 RSA key (what GitHub hands out as "RSA PRIVATE KEY"). */
function innerPkcs1(pkcs8: Uint8Array): Uint8Array {
  let i = 0;
  const len = () => {
    const first = pkcs8[i++]!;
    if (first < 0x80) return first;
    let n = 0;
    for (let k = 0; k < (first & 0x7f); k++) n = (n << 8) | pkcs8[i++]!;
    return n;
  };
  const skip = () => { i++; const n = len(); i += n; };
  i++; len(); // SEQUENCE
  skip(); // version
  skip(); // algorithm
  i++; const n = len(); // OCTET STRING
  return pkcs8.slice(i, i + n);
}

async function appKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  return { publicKey: pair.publicKey, pkcs8: pem(pkcs8, 'PRIVATE KEY'), pkcs1: pem(innerPkcs1(pkcs8), 'RSA PRIVATE KEY') };
}

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

describe('GitHub App', () => {
  it('reads both key formats, and refuses others', async () => {
    const { pkcs8, pkcs1 } = await appKeys();
    expect(privateKeyDer(pkcs8)).toEqual(privateKeyDer(pkcs1));
    expect(privateKeyDer('not a key')).toBeNull();
    expect(privateKeyDer('-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----')).toBeNull();
  });

  it('signs a JWT, makes an installation token, and keeps it until it expires', async () => {
    const { publicKey, pkcs1 } = await appKeys();
    const installationToken = `inst-${crypto.randomUUID()}`;
    let posts = 0;
    let now = Date.parse('2026-10-21T00:00:00Z');
    const verifyJwt = async (init: RequestInit) => {
      const jwt = new Headers(init.headers).get('authorization')!.replace('Bearer ', '');
      const [h, p, sig] = jwt.split('.') as [string, string, string];
      expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(b64urlDecode(p)))).toMatchObject({ iss: '123' });
    };
    const server = fakeGitHub(routes({
      [`${REPO}/installation`]: async (_url, init) => (await verifyJwt(init), { id: 9 }),
      '/app/installations/9/access_tokens': async (_url, init) => {
        expect(init.method).toBe('POST');
        await verifyJwt(init);
        posts++;
        return Response.json({ token: installationToken, expires_at: new Date(now + 3600_000).toISOString() }, { status: 201 });
      },
    }));
    const auth = new GitHubAppAuth('123', pkcs1);
    auth.now = () => now;
    const p = new GitHubFactProvider({ auth, fetch: server.fetchFn });
    expect(Object.values(await lookupFacts(specs, state, p)).every((f) => !f.missing)).toBe(true);
    expect(await lookupFacts(specs, state, p)).toBeTruthy();
    expect(posts).toBe(1);
    // Every request but the token's is a GET with the installation token.
    for (const c of server.calls.filter((x) => !x.url.pathname.startsWith('/app/') && !x.url.pathname.endsWith('/installation'))) {
      expect(c).toMatchObject({ method: 'GET', auth: `Bearer ${installationToken}` });
    }
    expect(server.calls.filter((c) => c.method !== 'GET').map((c) => c.url.pathname)).toEqual(['/app/installations/9/access_tokens']);
    // Five minutes before it expires, a new one.
    now += 56 * 60_000;
    await lookupFacts(spec('pr'), state, p);
    expect(posts).toBe(2);
  });

  it('not installed: unavailable, and asked again next time', async () => {
    const { pkcs8 } = await appKeys();
    const server = fakeGitHub(routes());
    const p = new GitHubFactProvider({ auth: new GitHubAppAuth('123', pkcs8), fetch: server.fetchFn });
    expect((await lookupFacts(spec('pr'), state, p)).pr).toEqual({ missing: true, reason: 'unavailable' });
    await lookupFacts(spec('pr'), state, p);
    expect(server.count(`${REPO}/installation`)).toBe(2);
  });
});

// ---- settings ----

describe('FACTS_GITHUB', () => {
  const base = { PROFILE_SOURCE: 'bundled', MODEL_MODE: 'mock', TOKENS: env.TOKENS, DB: env.DB };
  const githubOf = (deps: Deps) => (deps.facts as FactRouter | undefined)?.providers.github;

  it('is off unless set: GitHub facts are unavailable, also with FACTS_MODE mock', async () => {
    expect(depsFor(base).facts).toBeUndefined();
    const deps = depsFor({ ...base, FACTS_MODE: 'mock' });
    expect(githubOf(deps)).toBeUndefined();
    expect((await lookupFacts(spec('pr'), state, deps.facts)).pr).toEqual({ missing: true, reason: 'unavailable' });
  });

  it('mock, token and app', async () => {
    expect(githubOf(depsFor({ ...base, FACTS_GITHUB: 'mock' }))).toBeInstanceOf(MockFactProvider);
    expect(githubOf(depsFor({ ...base, FACTS_GITHUB: 'token', FACTS_GITHUB_TOKEN: TOKEN, FACTS_GITHUB_IGNORE_CHECK: 'pointsman' }))).toBeInstanceOf(GitHubFactProvider);
    const { pkcs1 } = await appKeys();
    expect(githubOf(depsFor({ ...base, FACTS_GITHUB: 'app', FACTS_GITHUB_APP_ID: '123', FACTS_GITHUB_APP_PRIVATE_KEY: pkcs1 }))).toBeInstanceOf(GitHubFactProvider);
    // Spatial facts stay off: FACTS_GITHUB "mock" does not answer them.
    const deps = depsFor({ ...base, FACTS_GITHUB: 'mock' });
    expect((await lookupFacts([{ name: 'f', type: 'inside', layer: 'x', at: '$.g' }], { g: { type: 'Point', coordinates: [139, 35] } }, deps.facts)).f)
      .toEqual({ missing: true, reason: 'unavailable' });
  });

  it('refuses settings that do not fit', () => {
    for (const bad of [
      { FACTS_GITHUB: 'pat' },
      { FACTS_GITHUB: 'token' },
      { FACTS_GITHUB_TOKEN: TOKEN },
      { FACTS_GITHUB: 'mock', FACTS_GITHUB_TOKEN: TOKEN },
      { FACTS_GITHUB: 'app', FACTS_GITHUB_APP_ID: '123' },
      { FACTS_GITHUB: 'app', FACTS_GITHUB_APP_ID: 'abc', FACTS_GITHUB_APP_PRIVATE_KEY: 'x' },
      { FACTS_GITHUB: 'app', FACTS_GITHUB_APP_ID: '123', FACTS_GITHUB_APP_PRIVATE_KEY: 'not a key' },
      { FACTS_GITHUB: 'token', FACTS_GITHUB_TOKEN: TOKEN, FACTS_GITHUB_APP_ID: '123' },
      { FACTS_GITHUB: 'mock', FACTS_GITHUB_IGNORE_CHECK: 'pointsman' },
    ]) {
      expect(() => depsFor({ ...base, ...bad }), JSON.stringify(Object.keys(bad))).toThrow(ConfigError);
    }
  });
});

// ---- a decision ----

describe('a decision with GitHub facts', () => {
  const profile: Profile = {
    id: 'pr-check', version: 1, title: { en: 'PR', ja: 'PR' }, description: { en: 'PR', ja: 'PR' }, model: 'mock',
    questions: [{ name: 'risky', type: 'noul', instructions: 'Is it risky?' }],
    facts: specs,
    policy: {
      rules: [
        { when: 'facts.pr.missing == true or facts.docs.missing == true', action: 'retry' },
        { when: "facts.docs.all == true and facts.ci.green == true and facts.level.value == 'high'", action: 'light' },
      ],
      default: 'review',
    },
  };
  const TOKEN_ = newToken();
  const tokens = new MemoryTokenStore();

  async function decide(facts: FactProvider) {
    tokens.records.set(await hashToken(TOKEN_), { client: 'test', profiles: ['*'], created_at: '' });
    const deps: Deps = { callbacks: noCallbacks, store: new MemoryProfileStore([profile]), tokens, log: new D1DecisionLog(env.DB), adapterFor: () => new MockAdapter(), facts };
    const res = await createApp(() => deps).request('/v1/decide/pr-check', { method: 'POST', headers: { authorization: `Bearer ${TOKEN_}` }, body: JSON.stringify({ state }) }, env);
    expect(res.status).toBe(200);
    const d = await res.json<any>();
    expect(contract.decision(d), JSON.stringify(contract.decision.errors)).toBe(true);
    return d;
  }

  it('uses the facts in rules and returns them', async () => {
    const d = await decide(new FactRouter({ github: provider(fakeGitHub()) }));
    expect(d).toMatchObject({ action: 'light', rule: 1 });
    expect(d.facts.level).toEqual({ missing: false, values: { value: 'high' }, source: `GitHub octo-org/demo#7 at ${HEAD.slice(0, 7)}` });
  });

  it('a stale snapshot goes to the retry rule', async () => {
    const d = await decide(new FactRouter({ github: provider(fakeGitHub(routes({ [`${PR}/commits`]: () => [commit(OTHER)] }))) }));
    expect(d).toMatchObject({ action: 'retry', rule: 0, facts: { pr: { missing: true, reason: 'stale' } } });
  });
});
