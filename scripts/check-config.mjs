#!/usr/bin/env node
// For a config repository: fail while wrangler.jsonc or engine.json still has
// a <placeholder> from the template, or engine.json does not pin a commit.
//
// Usage (from the config repository root): node engine/scripts/check-config.mjs

import { readFileSync } from 'node:fs';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

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
  if (typeof engine !== 'object' || engine === null) throw new Error('not an object');
  if (!/^[0-9a-f]{40}$/.test(engine.ref ?? '')) problems.push('engine.json: "ref" must be a 40-character commit SHA');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(engine.repository ?? '')) problems.push('engine.json: "repository" must be owner/name');
} catch (err) {
  if (err.code !== 'ENOENT') problems.push(`engine.json: ${err.message}`);
}
try {
  const errors = [];
  parseJsonc(readFileSync('wrangler.jsonc', 'utf8'), errors, { allowTrailingComma: true });
  for (const e of errors) problems.push(`wrangler.jsonc: ${printParseErrorCode(e.error)} at offset ${e.offset}`);
} catch (err) {
  if (err.code !== 'ENOENT') problems.push(`wrangler.jsonc: ${err.message}`);
}
if (problems.length > 0) {
  console.error(`Config not ready:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Config ready.');
