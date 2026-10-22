// The github_workflows fact (packages/github/src/provider.ts, packages/github/src/workflows.ts) against a
// fake GitHub API: which files it reads, at head and at the base tip, the
// limits, each way the fact can be missing, and that only GET requests are
// sent. The counts themselves are tested in workflows.test.ts.

import { describe, expect, it } from 'vitest';
import { lookupFacts, MockFactProvider, resultError } from '../../src/facts';
import { GitHubFactProvider, TokenAuth } from '@pointsman/github';
import type { FactSpec } from '../../src/types';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = '/repos/example-org/demo';
const PR = `${REPO}/pulls/7`;
const state = { pull_request: { repo: 'example-org/demo', number: 7, head: HEAD } };
const TOKEN = `test-${crypto.randomUUID()}`;
const wfSpec: FactSpec = { name: 'wf', type: 'github_workflows', at: '$.pull_request' };

type Handler = (url: URL) => unknown;

const pullRequest = (over: Record<string, unknown> = {}) => ({
  state: 'open', merged: false, draft: false, title: 'Update CI',
  head: { sha: HEAD, ref: 'ci', repo: { id: 1, full_name: 'example-org/demo' } },
  base: { ref: 'main', sha: BASE, repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
  user: { login: 'alice', type: 'User' },
  additions: 10, deletions: 2, changed_files: 1, commits: 1,
  ...over,
});

const PWN = `on: pull_request_target
permissions:
  contents: read
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm install
`;
const CLEAN = PWN.replace('on: pull_request_target', 'on: pull_request').replace(/\n\s+ref: .*/, '');

/** A repository: path -> text, at head and at base. Blob ids are made from the text. */
function repo(head: Record<string, string>, base: Record<string, string>) {
  const blobs = new Map<string, string>();
  const id = (text: string) => {
    const sha = Array.from(new TextEncoder().encode(text)).reduce((h, c) => (h * 31 + c) >>> 0, 7).toString(16).padStart(40, '0');
    blobs.set(sha, text);
    return sha;
  };
  const tree = (files: Record<string, string>) => ({
    sha: 'tree', truncated: false,
    tree: [
      { path: '.github', type: 'tree', sha: 't1' },
      ...Object.entries(files).map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: id(text), size: new TextEncoder().encode(text).length })),
    ],
  });
  const trees = { [HEAD]: tree(head), [BASE]: tree(base) };
  return {
    [`${REPO}/git/trees/${HEAD}`]: () => trees[HEAD],
    [`${REPO}/git/trees/${BASE}`]: () => trees[BASE],
    [`${REPO}/git/blobs/:sha`]: (url: URL) => {
      const text = blobs.get(url.pathname.split('/').pop()!);
      return text === undefined ? new Response('{}', { status: 404 }) : { encoding: 'base64', content: btoa(String.fromCharCode(...new TextEncoder().encode(text))), size: text.length };
    },
  } as Record<string, Handler>;
}

const changed = (...files: { filename: string; status?: string; previous_filename?: string }[]) => files.map((f) => ({ status: 'modified', ...f }));

function routes(files: unknown[], head: Record<string, string>, base: Record<string, string>, over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [PR]: () => pullRequest({ changed_files: files.length }),
    [`${PR}/commits`]: () => [{ sha: HEAD, commit: { verification: { verified: true } } }],
    [`${PR}/files`]: () => files,
    ...repo(head, base),
    ...over,
  };
}

function fakeGitHub(table: Record<string, Handler>) {
  const calls: { method: string; path: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', path: url.pathname });
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe('manual');
    const key = url.pathname.startsWith(`${REPO}/git/blobs/`) ? `${REPO}/git/blobs/:sha` : url.pathname;
    const handler = table[key];
    if (!handler) return new Response('{"message":"Not Found"}', { status: 404 });
    const body = await handler(url);
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function lookup(table: Record<string, Handler>, specs: FactSpec[] = [wfSpec], timeout?: number) {
  const server = fakeGitHub(table);
  const facts = await lookupFacts(specs, state, new GitHubFactProvider({ auth: new TokenAuth(TOKEN), fetch: server.fetchFn }), timeout);
  return { facts, server };
}

async function values(table: Record<string, Handler>) {
  const f = (await lookup(table)).facts.wf!;
  if (f.missing) throw new Error(`missing: ${f.reason}`);
  return f.values;
}

describe('github_workflows', () => {
  it('reads a changed workflow at head and at the base tip, and counts', async () => {
    const path = '.github/workflows/lint.yml';
    const { facts, server } = await lookup(routes(changed({ filename: path }), { [path]: PWN }, { [path]: CLEAN }));
    const f = facts.wf!;
    expect(f).toMatchObject({ missing: false, source: `GitHub example-org/demo#7 at ${HEAD.slice(0, 7)}` });
    if (f.missing) return;
    expect(f.values).toMatchObject({ changed: 1, removed: 0, unparsed: 0, bytes: PWN.length, privileged: 1, privileged_new: 1, head_checkout: 1, pwn_request: 1 });
    expect(f.values.detail).toContain(`${path}:`);
    expect(resultError('github_workflows', f)).toBeNull();
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(server.calls.filter((c) => c.path.includes('/git/blobs/'))).toHaveLength(2);
  });

  it('files outside the scope count nothing', async () => {
    expect(await values(routes(changed({ filename: 'src/app.ts' }), { 'src/app.ts': 'x' }, { 'src/app.ts': 'y' }))).toMatchObject({ changed: 0, removed: 0, bytes: 0 });
  });

  it('a pull request that changes only a local action\'s code: the folder comes from the tree', async () => {
    const action = 'runs:\n  using: node24\n  main: dist/index.js\n';
    const head = { '.github/actions/setup/action.yml': action, '.github/actions/setup/dist/index.js': 'run()' };
    const v = await values(routes(changed({ filename: '.github/actions/setup/dist/index.js' }), head, { ...head, '.github/actions/setup/dist/index.js': 'old()' }));
    expect(v).toMatchObject({ changed: 1, local_unresolved: 1, bytes: 5 });
    // A folder whose action.yml is gone at head still counts (it was one at the base).
    const gone = await values(routes(changed({ filename: 'tools/x/action.yml', status: 'removed' }, { filename: 'tools/x/run.sh' }), { 'tools/x/run.sh': 'echo' }, { 'tools/x/action.yml': action, 'tools/x/run.sh': 'echo' }));
    expect(gone).toMatchObject({ changed: 1, removed: 1, local_unresolved: 1 });
  });

  it('a renamed workflow is compared with its earlier name; one moved out of the scope is removed', async () => {
    const v = await values(routes(changed({ filename: '.github/workflows/new.yml', status: 'renamed', previous_filename: '.github/workflows/old.yml' }),
      { '.github/workflows/new.yml': PWN }, { '.github/workflows/old.yml': PWN }));
    expect(v).toMatchObject({ changed: 1, privileged: 1, privileged_new: 0 });
    const out = await values(routes(changed({ filename: 'old/ci.yml', status: 'renamed', previous_filename: '.github/workflows/ci.yml' }), { 'old/ci.yml': PWN }, { '.github/workflows/ci.yml': PWN }));
    expect(out).toMatchObject({ changed: 0, removed: 1, privileged: 0 });
    // Moved into the scope: new there, not compared with the file it was before.
    const into = await values(routes(changed({ filename: '.github/workflows/ci.yml', status: 'renamed', previous_filename: 'old/ci.yml' }), { '.github/workflows/ci.yml': PWN }, { 'old/ci.yml': PWN }));
    expect(into).toMatchObject({ changed: 1, privileged: 1, privileged_new: 1 });
  });

  it('scanner settings count as changed exceptions', async () => {
    expect(await values(routes(changed({ filename: '.github/zizmor.yml', status: 'added' }), { '.github/zizmor.yml': 'rules: {}' }, {}))).toMatchObject({ changed: 1, suppressions_new: 1 });
  });

  it('a file over 256 KB, or not UTF-8 text, is unparsed and not read', async () => {
    const big = `# ${'x'.repeat(256 * 1024)}\n${CLEAN}`;
    const { facts, server } = await lookup(routes(changed({ filename: '.github/workflows/big.yml' }), { '.github/workflows/big.yml': big }, {}));
    expect(facts.wf).toMatchObject({ missing: false, values: { unparsed: 1, changed: 1 } });
    expect(server.calls.filter((c) => c.path.includes('/git/blobs/'))).toHaveLength(0);
    const table = routes(changed({ filename: '.github/workflows/bin.yml' }), { '.github/workflows/bin.yml': CLEAN }, {});
    table[`${REPO}/git/blobs/:sha`] = () => ({ encoding: 'base64', content: btoa('\xff\xfe\x00on') });
    expect(await values(table)).toMatchObject({ unparsed: 1 });
  });

  it('at most 50 files are read', async () => {
    const head = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`.github/workflows/w${i}.yml`, CLEAN.replace('npm install', `npm run t${i}`)]));
    const { facts, server } = await lookup(routes(changed(...Object.keys(head).map((filename) => ({ filename }))), head, {}));
    expect(facts.wf).toMatchObject({ missing: false, values: { changed: 55, unparsed: 5 } });
    expect(server.calls.filter((c) => c.path.includes('/git/blobs/'))).toHaveLength(50);
  });

  it('two facts with other settings share every read', async () => {
    const path = '.github/workflows/lint.yml';
    const specs: FactSpec[] = [wfSpec, { ...wfSpec, name: 'wf2', inert_actions: ['example-org/x'] }];
    const { facts, server } = await lookup(routes(changed({ filename: path }), { [path]: PWN }, {}), specs);
    expect(facts.wf).toMatchObject({ missing: false });
    expect(facts.wf2).toMatchObject({ missing: false });
    const paths = server.calls.map((c) => c.path);
    expect(paths.length).toBe(new Set(paths).size + 1); // the pull request is read twice (before and after its files)
  });
});

describe('github_workflows missing', () => {
  const path = '.github/workflows/lint.yml';
  const ok = () => routes(changed({ filename: path }), { [path]: PWN }, {});
  const reason = async (table: Record<string, Handler>, timeout?: number) => (await lookup(table, [wfSpec], timeout)).facts.wf;

  it('more than 1,000 changed files: error', async () => {
    expect(await reason({ ...ok(), [PR]: () => pullRequest({ changed_files: 1001 }) })).toEqual({ missing: true, reason: 'error' });
  });
  it('a tree GitHub cut short, a tree or file of the wrong shape, no base commit: error', async () => {
    expect(await reason({ ...ok(), [`${REPO}/git/trees/${HEAD}`]: () => ({ truncated: true, tree: [] }) })).toEqual({ missing: true, reason: 'error' });
    expect(await reason({ ...ok(), [`${REPO}/git/trees/${BASE}`]: () => ({ tree: 'x' }) })).toEqual({ missing: true, reason: 'error' });
    expect(await reason({ ...ok(), [`${REPO}/git/blobs/:sha`]: () => ({ encoding: 'utf-8', content: 'x' }) })).toEqual({ missing: true, reason: 'error' });
    expect(await reason({ ...ok(), [PR]: () => pullRequest({ base: { ref: 'main', repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } } }) })).toEqual({ missing: true, reason: 'error' });
    expect(await reason({ ...ok(), [`${REPO}/git/blobs/:sha`]: () => new Response('{}', { status: 500 }) })).toEqual({ missing: true, reason: 'error' });
  });
  it('another head: stale; no access: unavailable; too slow: timeout', async () => {
    expect(await reason({ ...ok(), [PR]: () => pullRequest({ head: { sha: BASE, ref: 'ci', repo: { id: 1 } } }) })).toEqual({ missing: true, reason: 'stale' });
    expect(await reason({ ...ok(), [`${REPO}/git/trees/${HEAD}`]: () => new Response('{}', { status: 403 }) })).toEqual({ missing: true, reason: 'unavailable' });
    expect(await reason({ ...ok(), [`${REPO}/git/trees/${HEAD}`]: () => new Promise(() => undefined) }, 20)).toEqual({ missing: true, reason: 'timeout' });
  });
  it('no pull request in the request: no_pr', async () => {
    const server = fakeGitHub(ok());
    const f = await lookupFacts([wfSpec], {}, new GitHubFactProvider({ auth: new TokenAuth(TOKEN), fetch: server.fetchFn }));
    expect(f.wf).toEqual({ missing: true, reason: 'no_pr' });
    expect(server.calls).toHaveLength(0);
  });
});

describe('github_workflows mock', () => {
  it('fits the fact type', async () => {
    const f = (await lookupFacts([wfSpec], state, new MockFactProvider())).wf!;
    expect(f.missing).toBe(false);
    expect(resultError('github_workflows', f.missing ? null : { values: f.values, source: f.source })).toBeNull();
  });
});
