// scripts/check-core.mjs: the core compiles without Cloudflare's types and
// reaches no adapter file. Run in a small project of its own (a temporary
// folder with this repository's node_modules).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'scripts', 'check-core.mjs');

/** Runs the check on a project with these files in src/, src/adapter.ts left out as an adapter. */
function check(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
  writeFileSync(join(dir, 'tsconfig.core.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2024', 'webworker'], types: [] },
    include: ['src/**/*.ts'],
    exclude: ['src/adapter.ts'],
  }));
  mkdirSync(join(dir, 'src'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'src', name), text);
  const r = spawnSync(process.execPath, [cli], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('passes a core that uses no Cloudflare API', (t) => {
  const r = check(t, { 'core.ts': 'export const answer = (s: string): number => s.length;\n', 'adapter.ts': 'export const kv = 1;\n' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Core: no Cloudflare-specific API/);
});

test('fails a core file that uses a Cloudflare type', (t) => {
  const r = check(t, { 'core.ts': 'export async function read(kv: KVNamespace): Promise<string | null> { return kv.get("x"); }\n' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /KVNamespace/);
  assert.match(r.out, /does not compile without Cloudflare's types/);
});

test('fails a core file that imports an adapter', (t) => {
  const r = check(t, { 'core.ts': 'import { kv } from "./adapter";\nexport const n = kv + 1;\n', 'adapter.ts': 'export const kv = 1;\n' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /The core reaches Cloudflare adapters or packages:\s+src\/adapter\.ts/);
});
