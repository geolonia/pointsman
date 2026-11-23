// A config repository made from template/config-repo, with the engine linked
// in as engine/ (as the workflows check it out), must pass the same steps as
// its validate workflow: config check, profile validation, deploy dry run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseJsonc } from 'jsonc-parser';
import { strictlyPublicProblems } from '../scripts/lib/strictly-public.mjs';
import { chosenConnectors, chosenModules, modulesSource } from '../scripts/lib/modules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'template', 'config-repo'), dir, { recursive: true });
  symlinkSync(root, join(dir, 'engine'), 'dir');
  return dir;
}

/**
 * Replace the repository's engine link with an engine of its own, so the
 * build writes engine/generated/ there and not into this checkout. Only
 * src/ and generated/ are real folders; everything else links to this
 * checkout. src/ is copied because the bundler follows links to their real
 * path, and from there it would read the checkout's generated/.
 */
async function ownEngine(dir) {
  const engine = join(dir, 'engine');
  rmSync(engine);
  mkdirSync(engine);
  for (const name of readdirSync(root)) {
    if (name === 'src' || name === 'generated') continue;
    symlinkSync(join(root, name), join(engine, name));
  }
  cpSync(join(root, 'src'), join(engine, 'src'), { recursive: true });
  mkdirSync(join(engine, 'generated'));
  // What `pnpm --dir engine build` writes first (scripts/build-modules.mjs).
  const config = join(dir, 'engine.json');
  writeFileSync(join(engine, 'generated', 'modules.ts'), await modulesSource(chosenModules(config), chosenConnectors(config)));
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

test('a config without global_fetch_strictly_public is refused (#276)', (t) => {
  const dir = makeRepo(t);
  fill(dir);
  const wrangler = join(dir, 'wrangler.jsonc');
  const filled = readFileSync(wrangler, 'utf8');
  writeFileSync(wrangler, filled.replace('"compatibility_flags": ["global_fetch_strictly_public"],', ''));
  let r = run(dir, process.execPath, ['engine/scripts/check-config.mjs']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /wrangler.jsonc: "compatibility_flags" must include "global_fetch_strictly_public"/);

  writeFileSync(wrangler, filled.replace('["global_fetch_strictly_public"]', '["global_fetch_strictly_public", "global_fetch_private_origin"]'));
  r = run(dir, process.execPath, ['engine/scripts/check-config.mjs']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /must not include "global_fetch_private_origin"/);
});

test('an environment that sets its own flags needs global_fetch_strictly_public too', () => {
  const config = { compatibility_flags: ['global_fetch_strictly_public'], env: { live: { compatibility_flags: ['nodejs_compat'] }, dev: { vars: {} } } };
  assert.deepEqual(strictlyPublicProblems(config, 'w.jsonc'), ['w.jsonc: env.live: "compatibility_flags" must include "global_fetch_strictly_public"']);
});

test('every Worker config in this repository sets global_fetch_strictly_public', () => {
  // docs-site is static assets with no code, so it never calls fetch().
  for (const file of ['wrangler.jsonc', 'connectors/github/wrangler.jsonc', 'bridge/wrangler.jsonc', 'template/config-repo/wrangler.jsonc']) {
    const config = parseJsonc(readFileSync(join(root, file), 'utf8'), [], { allowTrailingComma: true });
    assert.deepEqual(strictlyPublicProblems(config, file), []);
  }
});

test('a filled-in config repository validates and builds', async (t) => {
  const dir = makeRepo(t);
  fill(dir);
  await ownEngine(dir);
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
