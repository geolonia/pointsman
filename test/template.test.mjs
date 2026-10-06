// A config repository made from template/config-repo, with the engine linked
// in as engine/ (as the workflows check it out), must pass the same steps as
// its validate workflow: config check, profile validation, deploy dry run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'template', 'config-repo'), dir, { recursive: true });
  symlinkSync(root, join(dir, 'engine'), 'dir');
  return dir;
}

function fill(dir) {
  const wrangler = join(dir, 'wrangler.jsonc');
  writeFileSync(wrangler, readFileSync(wrangler, 'utf8')
    .replace('"<worker name, e.g. pointsman>"', '"pointsman-test"')
    .replace('"<PROFILES namespace id>"', '"test-profiles"')
    .replace('"<TOKENS namespace id>"', '"test-tokens"')
    .replace('"<D1 database name, e.g. pointsman>"', '"pointsman-test"')
    .replace('"<D1 database id>"', '"test-db"'));
  writeFileSync(join(dir, 'engine.json'), JSON.stringify({ repository: 'geolonia/pointsman', ref: 'a'.repeat(40) }));
}

const run = (dir, cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });

test('the template is refused until every placeholder is replaced', (t) => {
  const dir = makeRepo(t);
  const r = run(dir, process.execPath, ['engine/scripts/check-config.mjs']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /replace "<PROFILES namespace id>"/);
  assert.match(r.stderr, /engine.json: "ref" must be a 40-character commit SHA/);
});

test('a malformed engine.json or wrangler.jsonc is refused', (t) => {
  const dir = makeRepo(t);
  fill(dir);
  writeFileSync(join(dir, 'engine.json'), '{ invalid json');
  let r = run(dir, process.execPath, ['engine/scripts/check-config.mjs']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /engine.json: .*JSON/);

  fill(dir);
  writeFileSync(join(dir, 'wrangler.jsonc'), '{ "name": "x", "main": }');
  r = run(dir, process.execPath, ['engine/scripts/check-config.mjs']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /wrangler.jsonc: ValueExpected/);
});

test('a filled-in config repository validates and builds', (t) => {
  const dir = makeRepo(t);
  fill(dir);
  let r = run(dir, process.execPath, ['engine/scripts/check-config.mjs']);
  assert.equal(r.status, 0, r.stderr);
  r = run(dir, process.execPath, ['engine/scripts/validate-profiles.mjs', 'profiles']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run(dir, process.execPath, ['engine/scripts/build-profiles.mjs', 'engine/generated/profiles.json', 'engine/examples/profiles']);
  assert.equal(r.status, 0, r.stderr);
  r = run(dir, join(root, 'node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--config', 'wrangler.jsonc', '--outdir', '.wrangler/dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /env\.PROFILES[\s\S]*env\.TOKENS[\s\S]*env\.DB[\s\S]*env\.AI/);
  assert.match(r.stdout, /PROFILE_SOURCE[^\n]*"kv"/);
});

test('the template profiles are valid', () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate-profiles.mjs'), join(root, 'template', 'config-repo', 'profiles')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
