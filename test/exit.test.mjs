// scripts/lib/exit.mjs: exit once stdout and stderr have written everything (#352).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const slow = join(root, 'test', 'fixtures', 'slow-output.mjs');
const run = (args) => spawnSync(process.execPath, ['--import', slow, ...args], { encoding: 'utf8', env: { ...process.env, POINTSMAN_TOKEN: '' } });

test('exit() waits for both streams, uses the code, and stops the caller', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'script.mjs');
  writeFileSync(script, [
    `import { exit } from ${JSON.stringify(pathToFileURL(join(root, 'scripts', 'lib', 'exit.mjs')).href)};`,
    "for (let i = 0; i < 200; i++) { console.log(`out ${i}`); console.error(`err ${i}`); }",
    'await exit(3);',
    "console.log('after the exit');",
  ].join('\n'));
  const r = run([script]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /\nout 199\n$/);
  assert.match(r.stderr, /\nerr 199\n$/);
  assert.doesNotMatch(r.stdout, /after the exit/);
});

test('a script that prints an error and exits loses none of it when writes are queued', () => {
  const explain = run([join(root, 'scripts', 'explain-profile.mjs')]);
  assert.equal(explain.status, 2);
  assert.match(explain.stderr, /^Usage: explain-profile <file>.*\n$/);
  const replay = run([join(root, 'scripts', 'replay-profile.mjs'), join(root, 'examples', 'profiles', 'issue-triage.yaml'), '--url', 'https://pointsman.example.org']);
  assert.equal(replay.status, 2);
  assert.equal(replay.stderr, 'POINTSMAN_TOKEN is needed: a token that may use the profile (not a test token)\n');
});
