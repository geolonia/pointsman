// github_bump (packages/github/src/bump.ts, npm.ts): whether a pull request
// only bumps npm dependency versions, as Dependabot does, against a fake
// GitHub API and a fake npm registry. Also all_commits_verified for a pull
// request by Dependabot.

import { describe, expect, it } from 'vitest';
import { lookupFacts } from '../../src/facts';
import {
  changesSource, GitHubFactProvider, lockfileChanges, lockfileSteps, NO_BUMP, stepOf, stripPeers, textBefore, TimeScanner, TokenAuth,
} from '@pointsman/github';
import type { FactSpec } from '../../src/types';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = '/repos/octo-org/demo';
const PR = `${REPO}/pulls/7`;
const state = { pull_request: { repo: 'octo-org/demo', number: 7, head: HEAD } };
const NOW = Date.parse('2026-10-23T00:00:00Z');
const DAY = 86_400_000;
// Made at run time: no token-looking literal or lockfile hash in the repository (secret scanning).
const TOKEN = `test-${crypto.randomUUID()}`;
const integrity = () => `sha512-${btoa(crypto.randomUUID() + crypto.randomUUID())}`;

const BUMP: FactSpec[] = [{ name: 'bump', type: 'github_bump', at: '$.pull_request' }];
const BOTH: FactSpec[] = [...BUMP, { name: 'pr', type: 'github_pr', at: '$.pull_request' }];

/** A package.json as Dependabot finds it, with its devDependencies and dependencies. */
const manifest = (dev: Record<string, string>, deps: Record<string, string> = { hono: '^4.13.13' }, extra: Record<string, unknown> = {}) => `${JSON.stringify({
  name: 'demo', version: '1.0.0', private: true, type: 'module',
  scripts: { build: 'tsc', test: 'vitest run' },
  devDependencies: { typescript: '^7.0.2', ...dev },
  packageManager: 'pnpm@12.9.1',
  dependencies: deps,
  ...extra,
}, null, 2)}\n`;

/** A unified patch from one text to another, as GitHub gives it: one hunk around the changed lines, three lines of context. */
function patchOf(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const from = Math.max(0, pre - 3);
  const ctxAfter = Math.min(3, post);
  const removed = a.slice(pre, a.length - post);
  const added = b.slice(pre, b.length - post);
  const lead = a.slice(from, pre);
  const tail = a.slice(a.length - post, a.length - post + ctxAfter);
  const oldCount = lead.length + removed.length + tail.length;
  const newCount = lead.length + added.length + tail.length;
  return [
    `@@ -${from + 1},${oldCount} +${from + 1},${newCount} @@`,
    ...lead.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), ...tail.map((l) => ` ${l}`),
  ].join('\n');
}

/** The pnpm-lock.yaml hunks of a bump from one version to another. */
const lockPatch = (name: string, from: string, to: string, resolution = `{integrity: ${integrity()}}`) => {
  const q = (k: string) => (name.startsWith('@') ? `'${k}'` : k);
  return [
  '@@ -192,8 +192,8 @@ importers:',
  '   .:',
  '     devDependencies:',
  `       ${q(name)}:`,
  `-        specifier: ^${from}`,
  `-        version: ${from}`,
  `+        specifier: ^${to}`,
  `+        version: ${to}`,
  '@@ -278,4 +278,4 @@ packages:',
  '',
  `-  ${q(`${name}@${from}`)}:`,
  `-    resolution: {integrity: ${integrity()}}`,
  `+  ${q(`${name}@${to}`)}:`,
  `+    resolution: ${resolution}`,
  '',
  ].join('\n');
};

interface Change { filename: string; status?: string; patch?: string | null }

/** A pull request: its changed files, the head text of each package.json, its author and commits. */
interface Scenario {
  files: Change[];
  heads?: Record<string, string>;
  author?: { login: string; type: string };
  commits?: unknown[];
  /** The registry: package name to its answer. */
  registry?: Record<string, () => Response>;
  /** The other files of the repository at the head (unchanged package.json files and others), by path. */
  repository?: Record<string, string>;
  /** The answer for the repository tree, instead of one made from `heads` and `repository`. */
  tree?: () => Response;
}

/** A package document as the registry sends it: the versions first, then "time" (as for large packages), in small pieces. */
function document(name: string, times: Record<string, string>): Response {
  const text = JSON.stringify({
    _id: name, name, 'dist-tags': { latest: Object.keys(times).pop() },
    versions: Object.fromEntries(Object.keys(times).map((v) => [v, { name, version: v, description: 'a "quoted" {brace} text', dependencies: { [v]: '1.0.0' } }])),
    time: { created: '2020-01-01T00:00:00.000Z', modified: '2026-10-22T00:00:00.000Z', ...times },
    readme: 'x'.repeat(5000),
  });
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  }), { headers: { 'content-type': 'application/json' } });
}

/** A blob sha for a path in the fake tree: five 32-bit FNV-1a hashes of it, 40 hex characters. */
const shaOf = (path: string) => [1, 2, 3, 4, 5].map((seed) => {
  let h = 0x811c9dc5 ^ seed;
  for (const c of `${seed}:${path}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}).join('');

const daysAgo = (d: number) => new Date(NOW - d * DAY - 3600_000).toISOString();

function fake(s: Scenario) {
  const calls: { url: URL; auth: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.redirect).toBe('manual');
    if (url.origin === 'https://registry.npmjs.org') {
      const name = decodeURIComponent(url.pathname.slice(1));
      return s.registry?.[name]?.() ?? new Response('{"error":"Not found"}', { status: 404 });
    }
    expect(url.origin).toBe('https://api.github.com');
    const pr = {
      state: 'open', merged: false, draft: false, title: 'Bump vitest from 4.1.11 to 4.1.12',
      head: { sha: HEAD, ref: 'dependabot/npm_and_yarn/vitest-4.1.12', repo: { id: 1, full_name: 'octo-org/demo' } },
      base: { ref: 'main', sha: OTHER, repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
      user: s.author ?? { login: 'dependabot[bot]', type: 'Bot' },
      additions: 5, deletions: 5, changed_files: s.files.length, commits: (s.commits ?? [1]).length,
    };
    if (url.pathname === PR) return Response.json(pr);
    if (url.pathname === `${PR}/commits`) return Response.json(s.commits ?? [dependabotCommit(HEAD)]);
    if (url.pathname === `${PR}/files`) return Response.json(s.files.map((f) => ({ status: 'modified', ...f })));
    if (url.pathname.startsWith(`${REPO}/contents/`)) {
      const text = s.heads?.[decodeURIComponent(url.pathname.slice(`${REPO}/contents/`.length))];
      if (text === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
      expect(url.searchParams.get('ref')).toBe(HEAD);
      return Response.json({ type: 'file', encoding: 'base64', size: text.length, content: btoa(text) });
    }
    const all = { ...s.repository, ...s.heads };
    if (url.pathname === `${REPO}/git/trees/${HEAD}`) {
      expect(url.searchParams.get('recursive')).toBe('1');
      if (s.tree) return s.tree();
      const tree = [{ path: 'src', type: 'tree', sha: OTHER }, ...Object.entries(all).map(([path, text]) => ({ path, type: 'blob', sha: shaOf(path), size: text.length }))];
      return Response.json({ sha: HEAD, truncated: false, tree });
    }
    if (url.pathname.startsWith(`${REPO}/git/blobs/`)) {
      const path = Object.keys(all).find((p) => shaOf(p) === url.pathname.slice(`${REPO}/git/blobs/`.length));
      if (path === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
      return Response.json({ encoding: 'base64', content: btoa(all[path]!) });
    }
    if (url.pathname === `${REPO}/activity`) return Response.json([]);
    if (url.pathname === '/orgs/octo-org/members/dependabot[bot]') return new Response(null, { status: 404 });
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** A commit as Dependabot makes it: authored by dependabot[bot], committed and signed by GitHub (web-flow). */
const dependabotCommit = (sha: string) => ({
  sha, author: { login: 'dependabot[bot]', type: 'Bot' }, committer: { login: 'web-flow', type: 'User' },
  commit: { verification: { verified: true, reason: 'valid' } },
});

async function bumpOf(s: Scenario, specs: FactSpec[] = BUMP) {
  const server = fake(s);
  const facts = await lookupFacts(specs, state, new GitHubFactProvider({ auth: new TokenAuth(TOKEN), fetch: server.fetchFn, now: () => NOW }));
  return { facts, calls: server.calls };
}
const values = async (s: Scenario) => {
  const f = (await bumpOf(s)).facts.bump!;
  if (f.missing) throw new Error(`missing: ${f.reason}`);
  return f.values;
};

/** A Dependabot bump of one dev dependency, vitest, from 4.1.11 to `to`; overrides by field. */
function vitestBump(to = '4.1.12', over: Partial<Scenario> = {}): Scenario {
  const before = manifest({ vitest: '~4.1.11' });
  const after = manifest({ vitest: `~${to}` });
  return {
    files: [{ filename: 'package.json', patch: patchOf(before, after) }, { filename: 'pnpm-lock.yaml', patch: lockPatch('vitest', '4.1.11', to) }],
    heads: { 'package.json': after },
    registry: { vitest: () => document('vitest', { '4.1.11': daysAgo(30), [to]: daysAgo(5) }) },
    ...over,
  };
}

const APPROVABLE = {
  applies: true, only_manifests: true, version_only: true, semver: 'patch', dev_only: true,
  registry_changed: false, manifest_lines: 2, release_age_days: 5,
};

describe('github_bump', () => {
  it('a Dependabot patch bump of a dev dependency: every value a profile needs to approve', async () => {
    const { facts, calls } = await bumpOf(vitestBump(), BOTH);
    const bump = facts.bump!;
    if (bump.missing) throw new Error(`missing: ${bump.reason}`);
    expect(bump.values).toEqual(APPROVABLE);
    expect(bump.source).toBe('GitHub octo-org/demo#7 at aaaaaaa; npm registry');
    expect(facts.pr!.missing === false && facts.pr!.values).toMatchObject({ author_dependabot: true, all_commits_verified: true });
    // The registry gets no token; GitHub gets it on every call.
    const registry = calls.filter((c) => c.url.origin === 'https://registry.npmjs.org');
    expect(registry.map((c) => c.url.pathname)).toEqual(['/vitest']);
    expect(registry.every((c) => c.auth === null)).toBe(true);
    expect(calls.filter((c) => c.url.origin === 'https://api.github.com').every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('the files of a workspace: package.json in folders, a scoped package, two manifests', async () => {
    const rootBefore = manifest({ '@cloudflare/vitest-plugin': '^1.4.1' });
    const rootAfter = manifest({ '@cloudflare/vitest-plugin': '^1.4.2' });
    const pkgBefore = manifest({ '@cloudflare/vitest-plugin': '^1.4.1' }, {});
    const pkgAfter = manifest({ '@cloudflare/vitest-plugin': '^1.4.2' }, {});
    const v = await values({
      files: [
        { filename: 'package.json', patch: patchOf(rootBefore, rootAfter) },
        { filename: 'packages/a/package.json', patch: patchOf(pkgBefore, pkgAfter) },
        { filename: 'pnpm-lock.yaml', patch: lockPatch('@cloudflare/vitest-plugin', '1.4.1', '1.4.2') },
      ],
      heads: { 'package.json': rootAfter, 'packages/a/package.json': pkgAfter },
      registry: { '@cloudflare/vitest-plugin': () => document('@cloudflare/vitest-plugin', { '1.4.2': daysAgo(4) }) },
    });
    expect(v).toEqual({ ...APPROVABLE, manifest_lines: 4, release_age_days: 4 });
  });

  it('a production dependency is not dev only', async () => {
    const before = manifest({}, { hono: '^4.13.13' });
    const after = manifest({}, { hono: '^4.13.14' });
    const s: Scenario = {
      files: [{ filename: 'package.json', patch: patchOf(before, after) }],
      heads: { 'package.json': after },
      registry: { hono: () => document('hono', { '4.13.14': daysAgo(10) }) },
    };
    expect(await values(s)).toEqual({ ...APPROVABLE, dev_only: false, release_age_days: 10 });
    // A dev dependency that another changed package.json has as a dependency.
    const a1 = manifest({ vitest: '~4.1.11' });
    const a2 = manifest({ vitest: '~4.1.12' });
    const b1 = manifest({ x: '^1.0.0' }, { vitest: '^4.0.0' });
    const b2 = manifest({ x: '^1.0.1' }, { vitest: '^4.0.0' });
    const v = await values({
      files: [{ filename: 'package.json', patch: patchOf(a1, a2) }, { filename: 'app/package.json', patch: patchOf(b1, b2) }],
      heads: { 'package.json': a2, 'app/package.json': b2 },
      registry: { vitest: () => document('vitest', { '4.1.12': daysAgo(5) }), x: () => document('x', { '1.0.1': daysAgo(5) }) },
    });
    expect(v).toMatchObject({ semver: 'patch', dev_only: false });
  });

  it('minor and major steps', async () => {
    expect(await values(vitestBump('4.2.0'))).toMatchObject({ semver: 'minor', version_only: true });
    expect(await values(vitestBump('5.0.0'))).toMatchObject({ semver: 'major' });
  });

  it('0.x: as for the caret, a minor step counts as major and a patch step as minor', async () => {
    const before = manifest({ tool: '^0.9.2' });
    const at = (to: string): Scenario => {
      const after = manifest({ tool: to });
      return { files: [{ filename: 'package.json', patch: patchOf(before, after) }], heads: { 'package.json': after }, registry: { tool: () => document('tool', { [to.slice(1)]: daysAgo(9) }) } };
    };
    expect(await values(at('^0.10.0'))).toMatchObject({ semver: 'major' });
    expect(await values(at('^0.9.3'))).toMatchObject({ semver: 'minor' });
  });

  it('the step of two specs', () => {
    expect(stepOf('^1.2.3', '^1.2.4')).toBe('patch');
    expect(stepOf('1.2.3', '1.2.4')).toBe('patch');
    expect(stepOf('~1.2.3', '~1.3.0')).toBe('minor');
    expect(stepOf('^1.2.3', '^2.0.0')).toBe('major');
    expect(stepOf('^0.2.3', '^0.2.4')).toBe('minor');
    expect(stepOf('^0.2.3', '^0.3.0')).toBe('major');
    expect(stepOf('^0.2.3', '^1.0.0')).toBe('major');
    expect(stepOf('^0.0.3', '^0.0.4')).toBe('major');
    // Not understood, or not up: none.
    expect(stepOf('^1.2.3', '~1.2.4')).toBe('none');
    expect(stepOf('^1.2.4', '^1.2.3')).toBe('none');
    expect(stepOf('^1.2.3', '^1.2.4-rc.1')).toBe('none');
    expect(stepOf('>=1.2.3', '>=1.2.4')).toBe('none');
    expect(stepOf('^1.2', '^1.3')).toBe('none');
    expect(stepOf('latest', 'next')).toBe('none');
    expect(stepOf('v1.2.3', 'v1.2.4')).toBe('none');
  });

  it('a spec that is not understood: semver none, not version only', async () => {
    const before = manifest({ tool: '>=1.0.0 <2' });
    const after = manifest({ tool: '>=1.0.1 <2' });
    const v = await values({ files: [{ filename: 'package.json', patch: patchOf(before, after) }], heads: { 'package.json': after } });
    expect(v).toMatchObject({ applies: true, semver: 'none', version_only: false, registry_changed: false, release_age_days: 0 });
  });

  it('a package.json change beyond the version: not version only', async () => {
    const before = manifest({ vitest: '~4.1.11' });
    const after = manifest({ vitest: '~4.1.12' }, undefined, { scripts: { build: 'tsc', test: 'vitest run', postinstall: 'node x.js' } });
    const v = await values({ ...vitestBump(), files: [{ filename: 'package.json', patch: patchOf(before, after) }], heads: { 'package.json': after } });
    expect(v).toMatchObject({ applies: true, version_only: false, semver: 'patch', dev_only: true });
    expect(v.manifest_lines).toBeGreaterThan(2);
    // A dependency added beside the bump.
    const added = manifest({ vitest: '~4.1.12', evil: '^1.0.0' });
    expect(await values({ ...vitestBump(), files: [{ filename: 'package.json', patch: patchOf(before, added) }], heads: { 'package.json': added } }))
      .toMatchObject({ version_only: false });
    // Another file besides manifests and lockfiles: not a bump at all.
    expect(await values({ ...vitestBump(), files: [...vitestBump().files, { filename: 'src/index.ts', patch: '@@ -1 +1 @@\n-a\n+b' }] })).toEqual(NO_BUMP);
  });

  it('a change of source in the lockfile, in a spec, or in .npmrc', async () => {
    const tarball = lockPatch('vitest', '4.1.11', '4.1.12', `{integrity: ${integrity()}, tarball: https://npm.example.org/vitest/-/vitest-4.1.12.tgz}`);
    const base = vitestBump();
    expect(await values({ ...base, files: [base.files[0]!, { filename: 'pnpm-lock.yaml', patch: tarball }] }))
      .toEqual({ ...APPROVABLE, registry_changed: true });
    const git = lockPatch('vitest', '4.1.11', '4.1.12', '{commit: 0123abc, repo: https://github.com/someone/vitest, type: git}');
    expect(await values({ ...base, files: [base.files[0]!, { filename: 'pnpm-lock.yaml', patch: git }] })).toMatchObject({ registry_changed: true });
    // .npmrc: always a change of source, and not a manifest.
    expect(await values({ ...base, files: [...base.files, { filename: '.npmrc', patch: '@@ -0,0 +1 @@\n+registry=https://npm.example.org/' }] }))
      .toMatchObject({ applies: true, only_manifests: false, version_only: false, registry_changed: true });
    // A spec that names a source instead of a version.
    const before = manifest({ vitest: '~4.1.11' });
    const after = manifest({ vitest: 'github:someone/vitest#v4.1.12' });
    expect(await values({ ...base, files: [{ filename: 'package.json', patch: patchOf(before, after) }], heads: { 'package.json': after } }))
      .toMatchObject({ registry_changed: true, semver: 'none', version_only: false });
  });

  it('package-lock.json: the npm registry is no change, another host is', () => {
    expect(changesSource('      "resolved": "https://registry.npmjs.org/vitest/-/vitest-4.1.12.tgz",')).toBe(false);
    expect(changesSource(`      "integrity": "${integrity()}",`)).toBe(false);
    expect(changesSource('        specifier: ^4.1.12')).toBe(false);
    expect(changesSource('      "resolved": "https://npm.example.org/vitest/-/vitest-4.1.12.tgz",')).toBe(true);
    expect(changesSource('      "resolved": "git+ssh://git@github.com/someone/vitest.git#0123abc",')).toBe(true);
    expect(changesSource('        version: link:../vitest')).toBe(true);
    expect(changesSource('        version: file:vendor/vitest.tgz')).toBe(true);
    expect(changesSource('  vitest@npm:other@4.1.12:')).toBe(true);
    expect(changesSource('    resolution: {tarball: x.tgz}')).toBe(true);
  });

  it('lockfiles: another package behind a name, aliases, links, and what they add', () => {
    const entry = (key: string, resolved: string, version = '4.1.12') => [
      '@@ -10,6 +10,6 @@',
      `     "${key}": {`,
      `-      "version": "4.1.11",`,
      `-      "resolved": "${resolved.replace(/4\.1\.12/g, '4.1.11')}",`,
      `+      "version": "${version}",`,
      `+      "resolved": "${resolved}",`,
      `       "dev": true,`,
    ].join('\n');
    expect(lockfileChanges('package-lock.json', entry('node_modules/vitest', 'https://registry.npmjs.org/vitest/-/vitest-4.1.12.tgz')))
      .toEqual({ sourceChanged: false, versions: [{ name: 'vitest', version: '4.1.12' }, { name: 'vitest', version: '4.1.12' }] });
    // The registry, but the tarball of another package.
    expect(lockfileChanges('package-lock.json', entry('node_modules/vitest', 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz')).sourceChanged).toBe(true);
    // A nested entry, a scoped one, an entry whose key the patch does not show, a local path, a protocol-relative URL.
    expect(lockfileChanges('package-lock.json', entry('node_modules/a/node_modules/@scope/vitest', 'https://registry.npmjs.org/@scope/vitest/-/vitest-4.1.12.tgz')).sourceChanged).toBe(false);
    expect(lockfileChanges('package-lock.json', '@@ -10,2 +10,2 @@\n-      "resolved": "https://registry.npmjs.org/vitest/-/vitest-4.1.11.tgz",\n+      "resolved": "https://registry.npmjs.org/vitest/-/vitest-4.1.12.tgz",').sourceChanged).toBe(true);
    expect(lockfileChanges('package-lock.json', entry('node_modules/vitest', 'packages/vitest')).sourceChanged).toBe(true);
    expect(lockfileChanges('package-lock.json', entry('node_modules/vitest', '//npm.example.org/vitest/-/vitest-4.1.12.tgz')).sourceChanged).toBe(true);
    expect(lockfileChanges('package-lock.json', '@@ -10,2 +10,2 @@\n     "node_modules/vitest": {\n+      "link": true,').sourceChanged).toBe(true);
    // pnpm: peers in parentheses are fine, an alias is not; added package keys are versions to look up.
    expect(lockfileChanges('pnpm-lock.yaml', '@@ -1,2 +1,2 @@\n-        version: 1.4.0(vitest@4.1.11(vite@8.3.2))\n+        version: 1.4.1(vitest@4.1.11(vite@8.3.2))').sourceChanged).toBe(false);
    expect(lockfileChanges('pnpm-lock.yaml', '@@ -1,2 +1,2 @@\n-        version: 4.1.11\n+        version: evil@1.0.0').sourceChanged).toBe(true);
    expect(lockfileChanges('pnpm-lock.yaml', "@@ -1,1 +1,2 @@\n+  '@vitest/runner@4.1.12':\n+  vite@8.3.3(esbuild@0.28.2): {}").versions)
      .toEqual([{ name: '@vitest/runner', version: '4.1.12' }, { name: 'vite', version: '8.3.3' }]);
    // Lockfile v6 (pnpm 8): keys start with "/", scoped or not, with peers.
    expect(lockfileChanges('pnpm-lock.yaml', "@@ -1,1 +1,3 @@\n+  /vitest@4.1.12:\n+  /@vitest/runner@4.1.12:\n+  /vite@8.3.3(esbuild@0.28.2):"))
      .toEqual({ sourceChanged: false, versions: [{ name: 'vitest', version: '4.1.12' }, { name: '@vitest/runner', version: '4.1.12' }, { name: 'vite', version: '8.3.3' }] });
    // Lockfile v5 (/name/version) and other block keys are not understood: a change of source.
    expect(lockfileChanges('pnpm-lock.yaml', '@@ -1,1 +1,1 @@\n+  /vitest/4.1.12:').sourceChanged).toBe(true);
    expect(lockfileChanges('pnpm-lock.yaml', '@@ -1,1 +1,1 @@\n+  packages/new:').sourceChanged).toBe(true);
  });

  it('lockfiles: an escape in a changed line is a change of source', () => {
    const entry = (resolved: string) => `@@ -10,3 +10,3 @@\n     "node_modules/vitest": {\n-      "version": "4.1.11",\n+      "version": "4.1.12",\n+      ${resolved}`;
    expect(lockfileChanges('package-lock.json', entry('"resolved": "https://registry.npmjs.org/vitest/-/vitest-4.1.12.tgz",')).sourceChanged).toBe(false);
    // JSON escapes: the same field and URL to npm, not to the checks.
    expect(lockfileChanges('package-lock.json', entry('"resolv\\u0065d": "https:\\/\\/npm.example.org\\/x.tgz",')).sourceChanged).toBe(true);
    expect(lockfileChanges('package-lock.json', entry('"resolved": "https:\\/\\/npm.example.org/vitest/-/vitest-4.1.12.tgz",')).sourceChanged).toBe(true);
    // YAML double-quoted escapes in a pnpm-lock.yaml.
    expect(lockfileChanges('pnpm-lock.yaml', '@@ -1,2 +1,2 @@\n-    resolution: {integrity: x}\n+    resolution: {"tarb\\x61ll": "https:\\/\\/npm.example.org/x.tgz"}').sourceChanged).toBe(true);
    // An escape on an unchanged line changes nothing.
    expect(lockfileChanges('pnpm-lock.yaml', '@@ -1,3 +1,3 @@\n     note: "a\\tb"\n-        version: 4.1.11\n+        version: 4.1.12').sourceChanged).toBe(false);
  });

  it('pnpm peers: stripped in one pass, nested or not; unbalanced is not pinned', () => {
    expect(stripPeers('1.4.1(vitest@4.1.11(vite@8.3.2))(esbuild@0.28.2)')).toBe('1.4.1');
    expect(stripPeers('4.1.12')).toBe('4.1.12');
    for (const bad of ['1.0.0(a', '1.0.0)(a)', '1.0.0(a))']) expect(stripPeers(bad)).toBe(bad);
    expect(lockfileChanges('pnpm-lock.yaml', '@@ -1,2 +1,2 @@\n-        version: 1.0.0\n+        version: 1.0.1(a').sourceChanged).toBe(true);
    // Deep nesting: fast (the old loop took one pass per level, about 1 s here).
    const deep = `1.0.1${'('.repeat(20_000)}${')'.repeat(20_000)}`;
    const started = Date.now();
    expect(lockfileChanges('pnpm-lock.yaml', `@@ -1,2 +1,2 @@\n-        version: 1.0.0\n+        version: ${deep}`).sourceChanged).toBe(false);
    expect(lockfileSteps('pnpm-lock.yaml', `@@ -1,4 +1,4 @@ importers:\n   .:\n     devDependencies:\n       x:\n-        version: 1.0.0\n+        version: ${deep}`).semver).toBe('patch');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('a transitive version in the lockfile counts for the age; a bundled dependency is not dev only', async () => {
    const base = vitestBump();
    const lock = `${lockPatch('vitest', '4.1.11', '4.1.12')}\n@@ -400,1 +400,1 @@ packages:\n-  '@vitest/runner@4.1.11':\n+  '@vitest/runner@4.1.12':`;
    const young = { ...base, files: [base.files[0]!, { filename: 'pnpm-lock.yaml', patch: lock }],
      registry: { ...base.registry, '@vitest/runner': () => document('@vitest/runner', { '4.1.12': daysAgo(1) }) } };
    expect(await values(young)).toMatchObject({ semver: 'patch', release_age_days: 1 });
    const before = manifest({ vitest: '~4.1.11' }, undefined, { bundleDependencies: ['vitest'] });
    const after = manifest({ vitest: '~4.1.12' }, undefined, { bundleDependencies: ['vitest'] });
    expect(await values({ ...base, files: [{ filename: 'package.json', patch: patchOf(before, after) }], heads: { 'package.json': after } }))
      .toMatchObject({ dev_only: false });
  });

  it('a pull request of another ecosystem, or no bump: applies false, nothing else read', async () => {
    const other: Change[][] = [
      [{ filename: '.github/workflows/ci.yml', patch: '@@ -9 +9 @@\n-      - uses: actions/setup-node@0\n+      - uses: actions/setup-node@1' }],
      [{ filename: 'Dockerfile', patch: '@@ -1 +1 @@\n-FROM node:24.1\n+FROM node:24.2' }],
      [{ filename: 'requirements.txt', patch: '@@ -1 +1 @@\n-requests==2.32.0\n+requests==2.32.1' }],
      [{ filename: 'docs/guide.md', patch: '@@ -1 +1 @@\n-a\n+b' }],
      // A lockfile alone, a new package.json, a renamed one.
      [{ filename: 'pnpm-lock.yaml', patch: lockPatch('vitest', '4.1.11', '4.1.12') }],
      [{ filename: 'package.json', status: 'added', patch: '@@ -0,0 +1 @@\n+{}' }],
      [{ filename: 'package.json', status: 'renamed', patch: null }],
    ];
    for (const files of other) {
      const { facts, calls } = await bumpOf({ files });
      expect(facts.bump).toMatchObject({ missing: false, values: NO_BUMP });
      expect(calls.some((c) => c.url.pathname.includes('/contents/') || c.url.origin !== 'https://api.github.com')).toBe(false);
    }
    // package.json changed, but no dependency spec: not a bump.
    const before = manifest({ vitest: '~4.1.11' });
    const after = manifest({ vitest: '~4.1.11' }, undefined, { description: 'x' });
    expect(await values({ files: [{ filename: 'package.json', patch: patchOf(before, after) }], heads: { 'package.json': after } })).toEqual(NO_BUMP);
  });

  it('a young release', async () => {
    const s = vitestBump('4.1.12', { registry: { vitest: () => document('vitest', { '4.1.12': daysAgo(1) }) } });
    expect(await values(s)).toMatchObject({ release_age_days: 1 });
    // Published "in the future" (clocks differ): 0.
    const ahead = vitestBump('4.1.12', { registry: { vitest: () => document('vitest', { '4.1.12': new Date(NOW + DAY).toISOString() }) } });
    expect(await values(ahead)).toMatchObject({ release_age_days: 0 });
  });

  it('the registry cannot tell: the fact is missing, never a value', async () => {
    const cases: Record<string, () => Response>[] = [
      { vitest: () => new Response('{"error":"internal"}', { status: 500 }) },
      { vitest: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/vitest' } }) },
      // No time for the version, a time that is not one, not JSON.
      { vitest: () => document('vitest', { '4.1.11': daysAgo(30) }) },
      { vitest: () => document('vitest', { '4.1.12': 'yesterday' }) },
      { vitest: () => new Response('["vitest"]') },
    ];
    for (const registry of cases) {
      expect((await bumpOf(vitestBump('4.1.12', { registry }))).facts.bump).toEqual({ missing: true, reason: 'error' });
    }
    // Not found at all (the default answer of the fake).
    expect((await bumpOf(vitestBump('4.1.12', { registry: {} }))).facts.bump).toEqual({ missing: true, reason: 'error' });
  });

  it('GitHub cannot tell: the fact is missing', async () => {
    const s = vitestBump();
    // No patch (too large), a patch that does not fit the file, a package.json that cannot be read.
    expect((await bumpOf({ ...s, files: [{ filename: 'package.json', patch: null }] })).facts.bump).toEqual({ missing: true, reason: 'error' });
    expect((await bumpOf({ ...s, files: [s.files[0]!, { filename: 'pnpm-lock.yaml', patch: null }] })).facts.bump).toEqual({ missing: true, reason: 'error' });
    expect((await bumpOf({ ...s, heads: { 'package.json': manifest({ vitest: '~9.9.9' }) } })).facts.bump).toEqual({ missing: true, reason: 'error' });
    expect((await bumpOf({ ...s, heads: {} })).facts.bump).toMatchObject({ missing: true });
  });

  it('the text before a patch', () => {
    const before = manifest({ vitest: '~4.1.11' });
    const after = manifest({ vitest: '~4.1.12' });
    expect(textBefore(after, patchOf(before, after))).toBe(before);
    // Lines added and removed at the end, and a hunk that only removes.
    expect(textBefore('a\nb\nc', '@@ -1,2 +1,3 @@\n a\n b\n+c')).toBe('a\nb');
    expect(textBefore('a\nc', '@@ -2 +1,0 @@\n-b')).toBe('a\nb\nc');
    expect(textBefore('a\nX\nc', '@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n\\ No newline at end of file')).toBe('a\nb\nc');
    // Does not fit: other context, other counts, not a patch.
    expect(textBefore('a\nX\nc', '@@ -1,3 +1,3 @@\n z\n-b\n+X\n c')).toBeNull();
    expect(textBefore('a\nX\nc', '@@ -1,3 +1,3 @@\n a\n-b\n+X')).toBeNull();
    expect(textBefore('a', 'not a patch')).toBeNull();
  });

  it('the publish times: only the "time" object, across pieces, and nothing after it', () => {
    const text = JSON.stringify({
      name: 'p', versions: { '1.0.0': { time: { '1.0.0': 'not this' }, s: 'a \\" "1.0.0":"no" {' } },
      time: { '1.0.0': '2026-01-01T00:00:00.000Z', '1.0.1': '2026-02-01T00:00:00.000Z' },
      after: { time: { '1.0.0': 'never' } },
    });
    for (const size of [1, 3, 1000]) {
      const scanner = new TimeScanner(['1.0.0']);
      let done = false;
      for (let i = 0; i < text.length && !done; i += size) done = scanner.push(text.slice(i, i + size));
      expect(done).toBe(true);
      expect([...scanner.times]).toEqual([['1.0.0', '2026-01-01T00:00:00.000Z']]);
    }
    expect(() => new TimeScanner(['1.0.0']).push('["time"]')).toThrow();
  });
});

/** A pnpm-lock.yaml v9 hunk in `section` that moves one package key from one version to another (or adds or removes it, with null). */
const keyHunk = (section: string, name: string, from: string | null, to: string | null, at = 500) => {
  const q = (k: string) => (name.startsWith('@') ? `'${k}'` : k);
  return [
    `@@ -${at},3 +${at},3 @@ ${section}:`,
    ' ',
    ...(from ? [`-  ${q(`${name}@${from}`)}:`, `-    resolution: {integrity: ${integrity()}}`] : []),
    ...(to ? [`+  ${q(`${name}@${to}`)}:`, `+    resolution: {integrity: ${integrity()}}`] : []),
    ' ',
  ].join('\n');
};

/** The vitest bump with more lockfile hunks after its own. */
function withLock(extra: string[], registry: Record<string, () => Response> = {}, over: Partial<Scenario> = {}): Scenario {
  const base = vitestBump();
  return {
    ...base,
    files: [base.files[0]!, { filename: 'pnpm-lock.yaml', patch: [lockPatch('vitest', '4.1.11', '4.1.12'), ...extra].join('\n') }],
    registry: { ...base.registry, ...registry },
    ...over,
  };
}

const runner = (versions: Record<string, number>) => ({ '@vitest/runner': () => document('@vitest/runner', Object.fromEntries(Object.entries(versions).map(([v, d]) => [v, daysAgo(d)]))) });

describe('github_bump: every version a lockfile changes', () => {
  it('a transitive patch step, in packages, snapshots and a dependency line: patch', async () => {
    const snapshot = [
      '@@ -900,6 +900,6 @@ snapshots:',
      "-  '@vitest/runner@4.1.11':",
      "+  '@vitest/runner@4.1.12':",
      '     dependencies:',
      "-      '@vitest/utils': 4.1.11",
      "+      '@vitest/utils': 4.1.12",
      '       pathe: 2.0.3',
    ].join('\n');
    const v = await values(withLock([keyHunk('packages', '@vitest/runner', '4.1.11', '4.1.12'), snapshot], runner({ '4.1.12': 4 })));
    expect(v).toEqual({ ...APPROVABLE, release_age_days: 4 });
  });

  it('a transitive minor or major step: not patch', async () => {
    expect(await values(withLock([keyHunk('packages', '@vitest/runner', '4.1.11', '4.2.0')], runner({ '4.2.0': 9 })))).toMatchObject({ semver: 'minor', dev_only: true });
    expect(await values(withLock([keyHunk('packages', '@vitest/runner', '4.1.11', '5.0.0')], runner({ '5.0.0': 9 })))).toMatchObject({ semver: 'major' });
    // 0.x as for the caret: a patch step counts as minor.
    expect(await values(withLock([keyHunk('packages', 'pathe', '0.2.3', '0.2.4')], { pathe: () => document('pathe', { '0.2.4': daysAgo(9) }) })))
      .toMatchObject({ semver: 'minor' });
    // A dependency of a package moves to another version that was in the lockfile already: its step counts.
    const edge = ['@@ -900,4 +900,4 @@ snapshots:', "   '@vitest/runner@4.1.12':", '     dependencies:', '-      pathe: 1.1.2', '+      pathe: 2.0.3'].join('\n');
    expect(await values(withLock([edge]))).toMatchObject({ semver: 'major' });
  });

  it('a new transitive package, or one removed: none', async () => {
    expect(await values(withLock([keyHunk('packages', 'tinyexec', null, '1.0.1')], { tinyexec: () => document('tinyexec', { '1.0.1': daysAgo(9) }) })))
      .toMatchObject({ applies: true, semver: 'none', registry_changed: false, release_age_days: 5 });
    expect(await values(withLock([keyHunk('packages', 'tinyexec', '1.0.1', null)]))).toMatchObject({ semver: 'none' });
    // A dependency line added to a package is no step by itself (the package keys say what is installed).
    const edge = ['@@ -900,3 +900,4 @@ snapshots:', "   '@vitest/runner@4.1.12':", '     dependencies:', '+      pathe: 2.0.3', '       tinyrainbow: 3.0.3'].join('\n');
    expect(await values(withLock([edge]))).toMatchObject({ semver: 'patch' });
  });

  it('more than one version of a package on a side, or a downgrade: none', async () => {
    const two = [
      '@@ -500,8 +500,8 @@ packages:',
      '-  debug@3.2.7:', `-    resolution: {integrity: ${integrity()}}`, '-  debug@4.4.0:', `-    resolution: {integrity: ${integrity()}}`,
      '+  debug@3.2.8:', `+    resolution: {integrity: ${integrity()}}`, '+  debug@4.4.1:', `+    resolution: {integrity: ${integrity()}}`,
    ].join('\n');
    const debug = { debug: () => document('debug', { '3.2.8': daysAgo(9), '4.4.1': daysAgo(9) }) };
    expect(await values(withLock([two], debug))).toMatchObject({ semver: 'none' });
    expect(await values(withLock([keyHunk('packages', '@vitest/runner', '4.1.12', '4.1.11')], runner({ '4.1.11': 30 })))).toMatchObject({ semver: 'none' });
    // Peers only (the same version on both sides): no step.
    const peers = ['@@ -900,2 +900,2 @@ snapshots:', '-  vite-node@3.2.4(esbuild@0.28.1):', '+  vite-node@3.2.4(esbuild@0.28.2):'].join('\n');
    expect(await values(withLock([peers], { 'vite-node': () => document('vite-node', { '3.2.4': daysAgo(90) }) }))).toMatchObject({ semver: 'patch' });
  });

  it('lockfileSteps: places it cannot see, and what is strict', () => {
    // No section in the hunk header and none in the hunk: not placed.
    expect(lockfileSteps('pnpm-lock.yaml', '@@ -1,2 +1,2 @@\n-  debug@4.4.0:\n+  debug@4.4.1:')).toMatchObject({ semver: 'none', runtime: true });
    // A version line of an importer whose dependency the patch does not show.
    expect(lockfileSteps('pnpm-lock.yaml', '@@ -1,2 +1,2 @@ importers:\n-        version: 4.4.0\n+        version: 4.4.1').semver).toBe('none');
    // An importer outside devDependencies: may be used at run time.
    expect(lockfileSteps('pnpm-lock.yaml', '@@ -1,4 +1,4 @@ importers:\n   .:\n     dependencies:\n       hono:\n-        version: 4.13.13\n+        version: 4.13.14'))
      .toEqual({ semver: 'patch', names: ['hono'], runtime: true });
    // The importer and section above the hunk (as GitHub often shows it): the step by name, the section left to the package.json check.
    expect(lockfileSteps('pnpm-lock.yaml', '@@ -201,6 +201,6 @@ importers:\n         version: 4.13.13\n       zod:\n-        specifier: ^4.6.6\n-        version: 4.6.6\n+        specifier: ^4.6.7\n+        version: 4.6.7'))
      .toEqual({ semver: 'patch', names: ['zod'], runtime: false });
    // Another section (lockfileVersion, overrides): not understood.
    expect(lockfileSteps('pnpm-lock.yaml', "@@ -1 +1 @@\n-lockfileVersion: '6.0'\n+lockfileVersion: '9.0'").semver).toBe('none');
    // A version that is not a pinned one.
    expect(lockfileSteps('pnpm-lock.yaml', '@@ -1,4 +1,4 @@ importers:\n   .:\n     devDependencies:\n       x:\n-        version: 1.0.0\n+        version: link:../x').semver).toBe('none');
    // A version field beside an unchanged key (a tarball or repository package): not understood.
    expect(lockfileSteps('pnpm-lock.yaml', '@@ -1,3 +1,3 @@ packages:\n   foo@1.0.0:\n-    version: 1.0.0\n+    version: 2.0.0')).toMatchObject({ semver: 'none', runtime: true });
    // Nothing about versions: null.
    expect(lockfileSteps('pnpm-lock.yaml', `@@ -1,2 +1,2 @@ packages:\n   debug@4.4.1:\n-    resolution: {integrity: ${integrity()}}\n+    resolution: {integrity: ${integrity()}}`))
      .toEqual({ semver: null, names: [], runtime: false });
  });

  it('pnpm-lock.yaml v6: a changed package must show "dev: true"', () => {
    const v6 = (dev: string[]) => [
      '@@ -300,6 +300,6 @@ packages:',
      '-  /debug@4.4.0:',
      '+  /debug@4.4.1:',
      `-    resolution: {integrity: ${integrity()}}`,
      `+    resolution: {integrity: ${integrity()}}`,
      '     dependencies:',
      '       ms: 2.1.3',
      ...dev,
    ].join('\n');
    expect(lockfileSteps('pnpm-lock.yaml', v6(['     dev: true']))).toEqual({ semver: 'patch', names: ['debug'], runtime: false });
    expect(lockfileSteps('pnpm-lock.yaml', v6(['     dev: false'])).runtime).toBe(true);
    // The mark is not in the patch: not known, so not dev.
    expect(lockfileSteps('pnpm-lock.yaml', v6([])).runtime).toBe(true);
    // The mark taken away.
    expect(lockfileSteps('pnpm-lock.yaml', v6(['-    dev: true'])).runtime).toBe(true);
  });

  it('package-lock.json: entries by place, their dev marks', () => {
    const entry = (key: string, from: string | null, to: string | null, dev = ['       "dev": true,']) => [
      `@@ -10,6 +10,6 @@`,
      ...(from && to ? [`     "${key}": {`] : []),
      ...(from ? [...(to ? [] : [`-    "${key}": {`]), `-      "version": "${from}",`, `-      "resolved": "https://registry.npmjs.org/${key.split('node_modules/').pop()}/-/x-${from}.tgz",`] : []),
      ...(to ? [...(from ? [] : [`+    "${key}": {`]), `+      "version": "${to}",`, `+      "resolved": "https://registry.npmjs.org/${key.split('node_modules/').pop()}/-/x-${to}.tgz",`] : []),
      `       "integrity": "${integrity()}",`,
      ...dev,
    ].join('\n');
    expect(lockfileSteps('package-lock.json', entry('node_modules/debug', '4.4.0', '4.4.1'))).toEqual({ semver: 'patch', names: ['debug'], runtime: false });
    expect(lockfileSteps('package-lock.json', entry('node_modules/debug', '4.4.0', '5.0.0')).semver).toBe('major');
    expect(lockfileSteps('package-lock.json', entry('node_modules/debug', '4.4.1', '4.4.0')).semver).toBe('none');
    // No dev mark, or one not shown: may be used at run time.
    expect(lockfileSteps('package-lock.json', entry('node_modules/debug', '4.4.0', '4.4.1', ['       "devOptional": true,'])).runtime).toBe(true);
    expect(lockfileSteps('package-lock.json', entry('node_modules/debug', '4.4.0', '4.4.1', [])).runtime).toBe(true);
    // A new entry, a removed one: none. The same version moved to another place: no step.
    expect(lockfileSteps('package-lock.json', entry('node_modules/a/node_modules/debug', null, '3.2.7')).semver).toBe('none');
    expect(lockfileSteps('package-lock.json', entry('node_modules/debug', '4.4.0', null)).semver).toBe('none');
    const moved = `${entry('node_modules/debug', '4.4.0', null)}\n${entry('node_modules/a/node_modules/debug', null, '4.4.0').replace('@@ -10,6 +10,6 @@', '@@ -90,6 +90,6 @@')}`;
    expect(lockfileSteps('package-lock.json', moved).semver).toBeNull();
    // A version line whose entry the patch does not show, or the root's own: none.
    expect(lockfileSteps('package-lock.json', '@@ -10,2 +10,2 @@\n-      "version": "4.4.0",\n+      "version": "4.4.1",').semver).toBe('none');
    expect(lockfileSteps('package-lock.json', '@@ -5,3 +5,3 @@\n     "": {\n-      "version": "1.0.0",\n+      "version": "1.0.1",').semver).toBe('none');
  });
});

describe('github_bump: dev_only over every package.json of the repository', () => {
  it('a runtime dependency in a workspace the pull request does not change: not dev only', async () => {
    const app = manifest({}, { vitest: '^4.0.0' });
    expect(await values({ ...vitestBump(), repository: { 'app/package.json': app, 'README.md': '# demo' } })).toMatchObject({ semver: 'patch', dev_only: false });
    // A transitive package that a workspace has as a dependency, a peer, or bundles.
    const lock = withLock([keyHunk('packages', '@vitest/runner', '4.1.11', '4.1.12')], runner({ '4.1.12': 9 }));
    expect(await values({ ...lock, repository: { 'app/package.json': manifest({}, { '@vitest/runner': '^4.1.0' }) } })).toMatchObject({ dev_only: false });
    expect(await values({ ...lock, repository: { 'app/package.json': manifest({}, {}, { peerDependencies: { '@vitest/runner': '*' } }) } })).toMatchObject({ dev_only: false });
    expect(await values({ ...lock, repository: { 'app/package.json': manifest({}, {}, { bundleDependencies: ['@vitest/runner'] }) } })).toMatchObject({ dev_only: false });
    // pnpm v9 has no dev marks: a package whose dependency moves counts as changed, so a workspace that has it as a dependency says no.
    const edge = ['@@ -900,4 +900,4 @@ snapshots:', '   express@4.18.2:', '     dependencies:', '-      debug: 4.3.4', '+      debug: 4.3.5'].join('\n');
    const express = withLock([keyHunk('packages', 'debug', '4.3.4', '4.3.5'), edge], { debug: () => document('debug', { '4.3.5': daysAgo(9) }) });
    expect(await values(express)).toMatchObject({ semver: 'patch', dev_only: true });
    expect(await values({ ...express, repository: { 'app/package.json': manifest({}, { express: '^4.18.2' }) } })).toMatchObject({ semver: 'patch', dev_only: false });
    // The same line with its package key above the hunk: not known, so not dev only.
    const unplaced = withLock([keyHunk('packages', 'debug', '4.3.4', '4.3.5'), '@@ -900,2 +900,2 @@ snapshots:\n-      debug: 4.3.4\n+      debug: 4.3.5'], { debug: () => document('debug', { '4.3.5': daysAgo(9) }) });
    expect(await values(unplaced)).toMatchObject({ semver: 'patch', dev_only: false });
    // A package.json that is not JSON cannot tell: not dev only.
    expect(await values({ ...vitestBump(), repository: { 'fixtures/package.json': '{ not json' } })).toMatchObject({ dev_only: false });
  });

  it('other workspaces with the package as a dev dependency, or without it: dev only, one tree read and one blob read each', async () => {
    const { facts, calls } = await bumpOf({
      ...vitestBump(),
      repository: { 'packages/a/package.json': manifest({ vitest: '~4.1.11' }), 'packages/b/package.json': manifest({}, { other: '^1.0.0' }), 'src/index.ts': 'export {}' },
    });
    expect(facts.bump).toMatchObject({ missing: false, values: APPROVABLE });
    const paths = calls.map((c) => c.url.pathname);
    expect(paths.filter((p) => p.includes('/git/trees/'))).toHaveLength(1);
    // The changed package.json is not read again; src/index.ts is not read at all.
    expect(paths.filter((p) => p.includes('/git/blobs/')).sort()).toEqual([shaOf('packages/a/package.json'), shaOf('packages/b/package.json')].map((s) => `${REPO}/git/blobs/${s}`).sort());
  });

  it('not dev only already: the tree is not read', async () => {
    const before = manifest({}, { hono: '^4.13.13' });
    const after = manifest({}, { hono: '^4.13.14' });
    const { facts, calls } = await bumpOf({
      files: [{ filename: 'package.json', patch: patchOf(before, after) }],
      heads: { 'package.json': after },
      registry: { hono: () => document('hono', { '4.13.14': daysAgo(10) }) },
      tree: () => new Response('{"message":"Server Error"}', { status: 500 }),
    });
    expect(facts.bump).toMatchObject({ missing: false, values: { dev_only: false } });
    expect(calls.some((c) => c.url.pathname.includes('/git/'))).toBe(false);
  });

  it('a tree cut short, too many package.json files, one too large, one that cannot be read: missing', async () => {
    const cut = () => Response.json({ sha: HEAD, truncated: true, tree: [] });
    expect((await bumpOf({ ...vitestBump(), tree: cut })).facts.bump).toEqual({ missing: true, reason: 'error' });
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`packages/p${i}/package.json`, manifest({})]));
    expect((await bumpOf({ ...vitestBump(), repository: many })).facts.bump).toEqual({ missing: true, reason: 'error' });
    // 49 more (50 in all) is still within the limit.
    const fewer = Object.fromEntries(Object.entries(many).slice(1));
    expect((await bumpOf({ ...vitestBump(), repository: fewer })).facts.bump).toMatchObject({ missing: false, values: { dev_only: true } });
    const large = { 'big/package.json': `{"x":"${'x'.repeat(512 * 1024)}"}` };
    expect((await bumpOf({ ...vitestBump(), repository: large })).facts.bump).toEqual({ missing: true, reason: 'error' });
    const gone = () => Response.json({ sha: HEAD, truncated: false, tree: [{ path: 'app/package.json', type: 'blob', sha: 'f'.repeat(40), size: 10 }] });
    expect((await bumpOf({ ...vitestBump(), tree: gone })).facts.bump).toMatchObject({ missing: true });
  });
});

describe('all_commits_verified for a pull request by Dependabot', () => {
  const prValues = async (commits: unknown[]) => {
    const f = (await bumpOf({ ...vitestBump(), commits }, [{ name: 'pr', type: 'github_pr', at: '$.pull_request' }])).facts.pr!;
    if (f.missing) throw new Error(`missing: ${f.reason}`);
    return f.values;
  };

  it('every commit Dependabot\'s own, signed by GitHub', async () => {
    expect(await prValues([dependabotCommit(OTHER), dependabotCommit(HEAD)])).toMatchObject({ all_commits_verified: true });
  });

  it('a commit someone else added, even with a verified signature, is not', async () => {
    const human = { sha: OTHER, author: { login: 'mallory', type: 'User' }, committer: { login: 'mallory', type: 'User' }, commit: { verification: { verified: true } } };
    expect(await prValues([human, dependabotCommit(HEAD)])).toMatchObject({ all_commits_verified: false });
    // Authored as Dependabot but committed by a person, or by an account that only calls itself dependabot[bot].
    const committed = { ...dependabotCommit(OTHER), committer: { login: 'mallory', type: 'User' } };
    expect(await prValues([committed, dependabotCommit(HEAD)])).toMatchObject({ all_commits_verified: false });
    const lookalike = { ...dependabotCommit(OTHER), author: { login: 'dependabot[bot]', type: 'User' } };
    expect(await prValues([lookalike, dependabotCommit(HEAD)])).toMatchObject({ all_commits_verified: false });
    // GitHub's commit without a verified signature.
    expect(await prValues([{ ...dependabotCommit(HEAD), commit: { verification: { verified: false } } }])).toMatchObject({ all_commits_verified: false });
  });

  it('for other authors, only the signature counts (as before)', async () => {
    const f = (await bumpOf({ ...vitestBump(), author: { login: 'alice', type: 'User' }, commits: [{ sha: HEAD, commit: { verification: { verified: true } } }] },
      [{ name: 'pr', type: 'github_pr', at: '$.pull_request' }])).facts.pr!;
    expect(f.missing === false && f.values.all_commits_verified).toBe(true);
  });
});
