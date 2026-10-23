// github_release (packages/github/src/release.ts): whether a pull request
// only moves a version and adds to the changelog, as a release does. The
// real file list of the 0.8.0 release pull request (#170) is a fixture.

import { describe, expect, it } from 'vitest';
import { lookupFacts } from '../../src/facts';
import { GitHubFactProvider, levelOf, releaseFacts, TokenAuth, type ReleaseFile } from '@pointsman/github';
import type { FactSpec } from '../../src/types';
import release080 from './fixtures/release-0.8.0-files.json';

const files080: ReleaseFile[] = (release080 as { filename: string; status: string; patch?: string }[])
  .map((f) => ({ names: [f.filename], status: f.status, patch: f.patch ?? null }));
const CL = ['CHANGELOG.md'];
// Where this repository keeps its version.
const VF = ['package.json', 'packages/*/package.json', 'packages/*/src/definition.ts', 'src/version.ts', 'openapi.yaml', 'docs/modules.md', 'scripts/lib/modules.mjs'];
const edit = (name: string, patch: string, status = 'modified'): ReleaseFile => ({ names: [name], status, patch });
const pkg = edit('package.json', '@@ -1,3 +1,3 @@\n {\n-  "version": "0.8.0",\n+  "version": "0.9.0",\n   "private": true');
const changelog = edit('CHANGELOG.md', '@@ -12,0 +13,3 @@\n+## 0.9.0\n+\n+Notes.');

describe('github_release', () => {
  it('the 0.8.0 release pull request only moves the version', () => {
    expect(files080).toHaveLength(17);
    expect(releaseFacts(files080, CL, VF)).toEqual({ version_only: true, from: '0.7.0', to: '0.8.0', level: 'minor' });
  });

  it('a version in package.json and a changelog entry', () => {
    expect(releaseFacts([pkg, changelog], CL, VF)).toEqual({ version_only: true, from: '0.8.0', to: '0.9.0', level: 'minor' });
    expect(releaseFacts([pkg], CL, VF)).toMatchObject({ version_only: true });
  });

  it('anything else is not a release', () => {
    const not = { version_only: false, from: '', to: '', level: 'none' };
    expect(releaseFacts([], CL, VF)).toEqual(not);
    // Only a changelog: no version moved.
    expect(releaseFacts([changelog], CL, VF)).toEqual(not);
    // One more changed line.
    expect(releaseFacts([edit('package.json', '@@ -1,3 +1,3 @@\n-  "version": "0.8.0",\n+  "version": "0.9.0",\n-  "main": "a.js"\n+  "main": "b.js"')], CL, VF)).toEqual(not);
    // A line added beside the version.
    expect(releaseFacts([edit('package.json', '@@ -1,2 +1,3 @@\n-  "version": "0.8.0",\n+  "version": "0.9.0",\n+  "postinstall": "curl x | sh",')], CL, VF)).toEqual(not);
    // A removed line only.
    expect(releaseFacts([pkg, edit('src/a.ts', '@@ -1,2 +1,1 @@\n-check();')], CL, VF)).toEqual(not);
    // Two different version pairs.
    expect(releaseFacts([pkg, edit('src/version.ts', "@@ -1 +1 @@\n-export const VERSION = '0.8.0';\n+export const VERSION = '0.8.1';")], CL, VF)).toEqual(not);
    // A file that is not a version file, even with the same pair (an action the author controls).
    expect(releaseFacts([pkg, edit('.github/workflows/ci.yml', '@@ -9 +9 @@\n-      - uses: someone/act@0.8.0\n+      - uses: someone/act@0.9.0')], CL, VF)).toEqual(not);
    // A dependency in a package.json that moves by the same pair: only the "version" line may change there.
    expect(releaseFacts([pkg, edit('packages/a/package.json', '@@ -5 +5 @@\n-    "left-pad": "0.8.0"\n+    "left-pad": "0.9.0"')], CL, VF)).toEqual(not);
    expect(releaseFacts([edit('package.json', '@@ -5 +5 @@\n-    "left-pad": "0.8.0"\n+    "left-pad": "0.9.0"')], CL, VF)).toEqual(not);
    // An address is not a version.
    expect(releaseFacts([edit('src/version.ts', "@@ -1 +1 @@\n-const HOST = '10.0.8.0';\n+const HOST = '10.0.9.0';")], CL, VF)).toEqual(not);
    // Down to a pre-release.
    expect(releaseFacts([edit('package.json', '@@ -1 +1 @@\n-  "version": "0.9.0",\n+  "version": "0.9.0-x",')], CL, VF)).toEqual(not);
    // No version files at all.
    expect(releaseFacts([pkg, changelog], CL, ['src/version.ts'])).toEqual(not);
    // Another dependency moved too (another pair).
    expect(releaseFacts([pkg, edit('packages/a/package.json', '@@ -5 +5 @@\n-    "left-pad": "1.2.0"\n+    "left-pad": "1.3.0"')], CL, VF)).toEqual(not);
    // A line where the version is not all that changed.
    expect(releaseFacts([edit('src/version.ts', "@@ -1 +1 @@\n-export const VERSION = '0.8.0';\n+export const VERSION = '0.9.0'; run();")], CL, VF)).toEqual(not);
    // A file without a patch (binary, too large), a new or removed file, a rename.
    expect(releaseFacts([pkg, { names: ['logo.png'], status: 'modified', patch: null }], CL, VF)).toEqual(not);
    expect(releaseFacts([pkg, edit('src/new.ts', '@@ -0,0 +1 @@\n+export const VERSION = "0.9.0";', 'added')], CL, VF)).toEqual(not);
    expect(releaseFacts([pkg, { names: ['CHANGELOG.md', 'HISTORY.md'], status: 'renamed', patch: '@@ -1 +1,2 @@\n+## 0.9.0' }], CL, VF)).toEqual(not);
    // The changelog loses a line.
    expect(releaseFacts([pkg, edit('CHANGELOG.md', '@@ -3,2 +3,2 @@\n-old\n+new')], CL, VF)).toEqual(not);
    // A changelog the fact does not name is any other file.
    expect(releaseFacts([pkg, changelog], ['docs/CHANGES.md'], VF)).toEqual(not);
    // Down, or the same.
    expect(releaseFacts([edit('package.json', '@@ -1 +1 @@\n-  "version": "0.9.0",\n+  "version": "0.8.0",')], CL, VF)).toEqual(not);
  });

  it('the level of the step', () => {
    expect(levelOf('0.8.0', '1.0.0')).toBe('major');
    expect(levelOf('0.8.0', '0.9.0')).toBe('minor');
    expect(levelOf('0.8.0', '0.8.1')).toBe('patch');
    expect(levelOf('0.9.0-rc.1', '0.9.0')).toBe('patch');
    expect(levelOf('0.9.0', '0.9.0-rc.1')).toBe('none');
    expect(levelOf('0.9.0-rc.1', '0.9.0-rc.2')).toBe('none');
    expect(levelOf('0.8.0', '0.9.0-rc.1')).toBe('none');
    expect(levelOf('0.9.0', '0.8.9')).toBe('none');
    expect(levelOf('1.2.3', '1.2.3')).toBe('none');
  });

  it('is read from the pull request files, through the snapshot', async () => {
    const HEAD = 'a'.repeat(40);
    const PR = '/repos/octo-org/demo/pulls/7';
    const pr = {
      state: 'open', merged: false, draft: false, title: 'Release 0.9.0',
      head: { sha: HEAD, ref: 'release', repo: { id: 1, full_name: 'octo-org/demo' } },
      base: { ref: 'main', repo: { id: 1, default_branch: 'main', owner: { type: 'Organization' } } },
      user: { login: 'alice', type: 'User' }, additions: 4, deletions: 1, changed_files: 2, commits: 1,
    };
    const listed = [
      { filename: 'package.json', status: 'modified', patch: pkg.patch },
      { filename: 'CHANGELOG.md', status: 'modified', patch: changelog.patch },
    ];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === PR) return Response.json(pr);
      if (url.pathname === `${PR}/files`) return Response.json(listed);
      if (url.pathname === `${PR}/commits`) return Response.json([{ sha: HEAD, commit: { verification: { verified: true } } }]);
      return new Response('{"message":"Not Found"}', { status: 404 });
    }) as typeof fetch;
    const specs: FactSpec[] = [{ name: 'rel', type: 'github_release', at: '$.pull_request', version_files: ['package.json'] } as FactSpec];
    const state = { pull_request: { repo: 'octo-org/demo', number: 7, head: HEAD } };
    const facts = await lookupFacts(specs, state, new GitHubFactProvider({ auth: new TokenAuth(`test-${crypto.randomUUID()}`), fetch: fetchFn }));
    const rel = facts.rel!;
    if (rel.missing) throw new Error(`missing: ${rel.reason}`);
    expect(rel.values).toEqual({ version_only: true, from: '0.8.0', to: '0.9.0', level: 'minor' });
  });
});
