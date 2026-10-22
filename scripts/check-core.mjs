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
import { relative, sep } from 'node:path';
import { parse } from 'jsonc-parser';

// TypeScript's own entry, run with this Node (works on every OS).
const tsc = 'node_modules/typescript/bin/tsc';
const run = (args) => execFileSync(process.execPath, [tsc, '-p', 'tsconfig.core.json', ...args], { encoding: 'utf8' });

try {
  run([]);
} catch (err) {
  if (err.stdout) {
    process.stdout.write(err.stdout);
    console.error('The core does not compile without Cloudflare\'s types (see the errors above and docs/adapters.md).');
  } else {
    console.error(`tsc failed: ${err.message}`);
  }
  process.exit(1);
}

const adapters = new Set(parse(readFileSync('tsconfig.core.json', 'utf8')).exclude);
// Cloudflare packages, and the Worker types wrangler generates (a core file
// could reach them with a triple-slash reference).
const CLOUDFLARE = /node_modules\/(?:\.pnpm\/)?(?:@cloudflare|wrangler|miniflare|workerd)|(?:^|\/)worker-configuration\.d\.ts$/;
const problems = run(['--listFilesOnly'])
  .split('\n')
  .filter(Boolean)
  .map((f) => relative(process.cwd(), f).split(sep).join('/'))
  .filter((f) => adapters.has(f) || CLOUDFLARE.test(f));
if (problems.length > 0) {
  console.error(`The core reaches Cloudflare adapters or packages:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Core: no Cloudflare-specific API.');
