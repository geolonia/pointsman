// scripts/build-openapi-validators.mjs: openapi.yaml's response schemas as
// standalone validators, refused when openapi.yaml has a mistake the lenient
// compile would hide (#246). Run on a copy of openapi.yaml in a temporary folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'scripts', 'build-openapi-validators.mjs');
const openapi = readFileSync(join(root, 'openapi.yaml'), 'utf8');

function build(t, yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-validators-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'openapi.yaml'), yaml);
  const out = join(dir, 'out', 'validators.mjs');
  const r = spawnSync(process.execPath, [cli, out], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr, file: out };
}

test('writes validators and their types for openapi.yaml', async (t) => {
  const r = build(t, openapi);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Wrote \d+ validators to /);
  const types = readFileSync(r.file.replace(/\.mjs$/, '.d.mts'), 'utf8');
  assert.match(types, /export declare const decision: Validator;/);
  const v = await import(pathToFileURL(r.file).href);
  assert.equal(v.error({ error: { code: 'not_found', message: 'not found' } }), true);
  assert.equal(v.error({ error: { code: 'not_found' } }), false);
});

test('refuses an openapi.yaml with an unknown keyword in a schema, and writes nothing', (t) => {
  // A keyword JSON Schema does not know, as strict Ajv would refuse it.
  const broken = openapi.replace(/^( {2}schemas:\n)/m, '$1    Broken:\n      type: object\n      requird: [x]\n');
  assert.notEqual(broken, openapi, 'the test must change openapi.yaml');
  const r = build(t, broken);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^openapi\.yaml:/m);
  assert.match(r.out, /requird/);
  assert.equal(existsSync(r.file), false);
});
