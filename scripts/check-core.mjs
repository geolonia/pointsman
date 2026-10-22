#!/usr/bin/env node
// The engine core uses no Cloudflare-specific API (docs/adapters.md).
//
// 1. tsconfig.core.json compiles the core without Cloudflare's types, so a
//    core file that uses KVNamespace, D1Database, ExecutionContext,
//    caches.default and so on, or imports a file that does, fails.
// 2. No file the core compiles comes from a Cloudflare package or is one of
//    the adapter files that tsconfig.core.json leaves out.
//
// Usage: node scripts/check-core.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parse } from 'jsonc-parser';

const tsc = 'node_modules/.bin/tsc';
const run = (args) => execFileSync(tsc, ['-p', 'tsconfig.core.json', ...args], { encoding: 'utf8' });

try {
  run([]);
} catch (err) {
  process.stdout.write(err.stdout ?? '');
  console.error('The core uses a Cloudflare-specific API (see the errors above and docs/adapters.md).');
  process.exit(1);
}

const adapters = new Set(parse(readFileSync('tsconfig.core.json', 'utf8')).exclude);
const CLOUDFLARE = /node_modules\/(?:\.pnpm\/)?(?:@cloudflare|wrangler|miniflare|workerd)/;
const problems = run(['--listFilesOnly'])
  .split('\n')
  .filter(Boolean)
  .map((f) => relative(process.cwd(), f))
  .filter((f) => adapters.has(f) || CLOUDFLARE.test(f));
if (problems.length > 0) {
  console.error(`The core reaches Cloudflare adapters or packages:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Core: no Cloudflare-specific API.');
