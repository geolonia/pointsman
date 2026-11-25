#!/usr/bin/env node
// Validate profiles and write them as one JSON array, for the "bundled"
// profile store and the tests.
//
// Usage: node scripts/build-profiles.mjs [out-file] [dir...]
// Defaults: generated/profiles.json from examples/profiles.
//
// The profiles are validated with every fact module of this repository (the
// examples cover them all), and only those the chosen modules can answer
// are bundled (engine.json "modules", docs/modules.md), with the profiles
// they require.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { allModules, loadDefinitions } from './lib/modules.mjs';
import { loadProfileSet, useModules, validateProfile } from './lib/profile.mjs';
import { FactRegistry } from '../src/modules/registry.ts';
import { exit } from './lib/exit.mjs';

// A broken engine.json stops the script with one line, not a stack trace.
let chosen;
try {
  chosen = new FactRegistry(await loadDefinitions());
  await useModules(allModules());
} catch (err) {
  console.error(`fact modules: ${err.message}`);
  await exit(2);
}

const [out = 'generated/profiles.json', ...dirs] = process.argv.slice(2);
const sources = dirs.length > 0 ? dirs : ['examples/profiles'];

// Read everything first: a profile is validated with the ones it requires.
// Folders are read with their subfolders, and ids must be distinct, as
// validate-profiles and publish-profiles read them (#249).
let read;
let byId;
let duplicates;
try {
  ({ entries: read, byId, duplicates } = loadProfileSet(sources));
} catch (err) {
  console.error(err.message);
  await exit(2);
}
const profiles = [];
let failed = false;
for (const d of duplicates) {
  failed = true;
  console.error(`FAIL  ${d}`);
}
for (const { path, profile, error } of read) {
  const errors = error ? [error] : validateProfile(profile, { fileName: path, profiles: byId });
  if (errors.length > 0) {
    failed = true;
    console.error(`FAIL  ${path}\n      ${errors.join('\n      ')}`);
    continue;
  }
  profiles.push(profile);
}
if (failed) await exit(1);
// Leave out profiles whose facts no chosen module answers, and the ones that require them.
const skipped = new Set(profiles.filter((p) => (p.facts ?? []).some((f) => !chosen.type(f.type))).map((p) => p.id));
for (let more = true; more;) {
  more = false;
  for (const p of profiles) {
    if (!skipped.has(p.id) && (p.requires ?? []).some((r) => skipped.has(r.profile))) {
      skipped.add(p.id);
      more = true;
    }
  }
}
for (const id of skipped) console.log(`Left out ${id}: no chosen fact module answers its facts (or those of a profile it requires)`);
profiles.splice(0, profiles.length, ...profiles.filter((p) => !skipped.has(p.id)));
if (profiles.length === 0) {
  console.error(`No profiles found in: ${sources.join(', ')}`);
  await exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(profiles, null, 2)}\n`);
console.log(`Wrote ${profiles.length} profiles to ${out}`);
