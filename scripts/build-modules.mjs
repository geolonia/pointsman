#!/usr/bin/env node
// Write generated/modules.ts: the fact modules the Worker bundles, as
// engine.json "modules" chooses them (scripts/lib/modules.mjs). Also write
// the `fact` part of schema/profile-v1.schema.json from every module in
// this repository, so editors know every fact type (a test checks that the
// file is up to date).
//
// Usage: node scripts/build-modules.mjs   (part of `pnpm build`)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allModules, loadDefinitions, modulesSource } from './lib/modules.mjs';
import { schemaWithFacts } from './lib/schema.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  mkdirSync(join(root, 'generated'), { recursive: true });
  writeFileSync(join(root, 'generated/modules.ts'), await modulesSource());
  const file = join(root, 'schema/profile-v1.schema.json');
  writeFileSync(file, schemaWithFacts(readFileSync(file, 'utf8'), await loadDefinitions(allModules())));
} catch (err) {
  console.error(`build-modules: ${err.message}`);
  process.exit(1);
}
console.log('Wrote generated/modules.ts and the fact schema');
