// publish-profiles.mjs against a local KV namespace (wrangler --local, in a
// temporary folder). Slower than the other script tests: each step runs
// wrangler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'publish-profiles.mjs');
const wranglerBin = join(root, 'node_modules', '.bin', 'wrangler');

test('publish-profiles: first publish, no-op, immutability, version bump', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-publish-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = join(dir, 'profiles');
  mkdirSync(profiles);
  cpSync(join(root, 'examples', 'profiles'), profiles, { recursive: true });
  const config = join(dir, 'wrangler.jsonc');
  writeFileSync(config, JSON.stringify({
    name: 'publish-test',
    main: join(root, 'src', 'index.ts'),
    compatibility_date: '2026-10-01',
    kv_namespaces: [{ binding: 'PROFILES', id: 'publish-test' }],
    d1_databases: [{ binding: 'DB', database_name: 'publish-test', database_id: 'publish-test', migrations_dir: join(root, 'migrations') }],
  }));
  const migrate = spawnSync(wranglerBin, ['d1', 'migrations', 'apply', 'DB', '--local', '--config', config], { encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  const publish = (...extra) =>
    spawnSync(process.execPath, [script, '--dir', profiles, '--config', config, '--local', ...extra], { encoding: 'utf8' });
  const index = () => JSON.parse(spawnSync(wranglerBin, ['kv', 'key', 'get', 'index', '--binding', 'PROFILES', '--local', '--config', config, '--text'], { encoding: 'utf8' }).stdout);
  const triage = join(profiles, 'issue-triage.yaml');
  const edit = (from, to) => writeFileSync(triage, readFileSync(triage, 'utf8').replace(from, to));

  let r = publish();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /New: deploy-progress@1, issue-triage@1/);

  r = publish();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /New: \(none\)/);

  edit('team.p >= 0.85', 'team.p >= 0.8');
  r = publish();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /Already published with different content[\s\S]*issue-triage version 1/);

  edit(/^version: 1$/m, 'version: 2');
  r = publish('--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /New: issue-triage@2/);
  assert.deepEqual(index().map((s) => s.version), [1, 1], 'a dry run writes nothing');

  r = publish();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(index().map((s) => [s.id, s.version, s.versions]), [
    ['deploy-progress', 1, [1]],
    ['issue-triage', 2, [1, 2]],
  ]);

  // KV is eventually consistent; at the extreme it shows nothing at all. The
  // record in D1 still refuses different content for a published version.
  const kvWrangler = (...args) => spawnSync(wranglerBin, ['kv', 'key', ...args, '--binding', 'PROFILES', '--local', '--config', config], { encoding: 'utf8' });
  for (const k of ['index', 'profile:issue-triage:1', 'profile:issue-triage:2', 'profile:deploy-progress:1']) kvWrangler('delete', k);
  edit('team.p >= 0.8', 'team.p >= 0.7');
  r = publish();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /Already published with different content[\s\S]*issue-triage version 2/);
  assert.equal(kvWrangler('get', 'index', '--text').stdout.trim(), 'Value not found', 'nothing was written');

  // A re-run with unchanged content rewrites the missing KV values.
  edit('team.p >= 0.7', 'team.p >= 0.8');
  r = publish();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(index().map((s) => [s.id, s.version]), [['deploy-progress', 1], ['issue-triage', 2]]);
  assert.match(kvWrangler('get', 'profile:issue-triage:2', '--text').stdout, /"version":2/);
});

for (let [name, args, message] of [
  ['no --dir', ['--local'], /Usage/],
  ['no target', ['--dir', 'examples/profiles'], /exactly one of --local or --remote/],
  ['a missing folder', ['--dir', 'no-such-dir', '--local'], /ENOENT/],
  ['an invalid profile', ['--dir', 'test/fixtures/invalid', '--local'], /Invalid profiles; nothing was published/],
  ['duplicate ids', ['--dir', '__DUP__', '--local'], /duplicate profile id "issue-triage"/],
]) {
  test(`publish-profiles rejects ${name}`, (t) => {
    if (args.includes('__DUP__')) {
      const dir = mkdtempSync(join(tmpdir(), 'pointsman-dup-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const yaml = readFileSync(join(root, 'examples', 'profiles', 'issue-triage.yaml'), 'utf8');
      writeFileSync(join(dir, 'issue-triage.yaml'), yaml);
      writeFileSync(join(dir, 'issue-triage.yml'), yaml);
      args = args.map((a) => (a === '__DUP__' ? dir : a));
    }
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, message);
  });
}
