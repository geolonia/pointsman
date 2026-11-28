#!/usr/bin/env node
// For a config repository: fail while wrangler.jsonc or engine.json still has
// a <placeholder> from the template, engine.json does not pin a commit,
// wrangler.jsonc drops the global_fetch_strictly_public flag, or it sets
// DECISION_LOG_DAYS to a value the engine would not use.
//
// Usage (from the config repository root): node engine/scripts/check-config.mjs

import { readFileSync } from 'node:fs';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { chosenConnectors, chosenModules, loadDefinitions } from './lib/modules.mjs';
import { strictlyPublicProblems } from './lib/strictly-public.mjs';
// Node.js strips the types; the file has no imports.
import { retentionProblem } from '../src/retention-days.ts';
import { exit } from './lib/exit.mjs';

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
  // The modules it chooses (docs/modules.md): known names, pinned versions that match.
  try {
    await loadDefinitions(chosenModules('engine.json'));
    await loadDefinitions(chosenConnectors('engine.json'));
  } catch (err) {
    problems.push(err.message.replace(/^.*engine\.json: /, 'engine.json: '));
  }
} catch (err) {
  if (err.code !== 'ENOENT') problems.push(`engine.json: ${err.message}`);
}
try {
  const errors = [];
  const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'), errors, { allowTrailingComma: true });
  for (const e of errors) problems.push(`wrangler.jsonc: ${printParseErrorCode(e.error)} at offset ${e.offset}`);
  if (errors.length === 0) {
    problems.push(...strictlyPublicProblems(config, 'wrangler.jsonc'));
    // The engine only logs a bad value (the deletion stops): refuse it here, before a deploy.
    const vars = [['', config?.vars], ...Object.entries(config?.env ?? {}).map(([name, env]) => [`env.${name}: `, env?.vars])];
    for (const [where, v] of vars) {
      const value = v?.DECISION_LOG_DAYS;
      if (value === undefined) continue;
      const problem = retentionProblem(typeof value === 'string' ? value : JSON.stringify(value));
      if (problem) problems.push(`wrangler.jsonc: ${where}${problem} (a string, for example "365")`);
    }
  }
} catch (err) {
  if (err.code !== 'ENOENT') problems.push(`wrangler.jsonc: ${err.message}`);
}
if (problems.length > 0) {
  console.error(`Config not ready:\n  ${problems.join('\n  ')}`);
  await exit(1);
}
console.log('Config ready.');
