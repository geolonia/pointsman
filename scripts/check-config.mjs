#!/usr/bin/env node
// For a config repository: fail while wrangler.jsonc or engine.json still has
// a <placeholder> from the template, or engine.json does not pin a commit.
//
// Usage (from the config repository root): node engine/scripts/check-config.mjs

import { readFileSync } from 'node:fs';

const problems = [];
for (const file of ['wrangler.jsonc', 'engine.json']) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    problems.push(`${file}: ${err.code === 'ENOENT' ? 'missing' : err.message}`);
    continue;
  }
  for (const m of text.matchAll(/"<([^"]*)>"/g)) problems.push(`${file}: replace "<${m[1]}>"`);
}
try {
  const engine = JSON.parse(readFileSync('engine.json', 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(engine.ref ?? '')) problems.push('engine.json: "ref" must be a 40-character commit SHA');
} catch {
  // reported above
}
if (problems.length > 0) {
  console.error(`Config not ready:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Config ready.');
