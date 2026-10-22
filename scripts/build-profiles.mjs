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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { allModules, loadDefinitions } from './lib/modules.mjs';
import { PROFILE_EXTENSIONS, parseProfile, useModules, validateProfile } from './lib/profile.mjs';
import { FactRegistry } from '../src/modules/registry.ts';

const chosen = new FactRegistry(await loadDefinitions());
await useModules(allModules());

const [out = 'generated/profiles.json', ...dirs] = process.argv.slice(2);
const sources = dirs.length > 0 ? dirs : ['examples/profiles'];

// Read everything first: a profile is validated with the ones it requires.
const read = [];
for (const dir of sources) {
  for (const entry of readdirSync(dir).sort()) {
    if (!PROFILE_EXTENSIONS.includes(extname(entry))) continue;
    const path = join(dir, entry);
    try {
      read.push({ path, profile: parseProfile(readFileSync(path, 'utf8'), path) });
    } catch (err) {
      read.push({ path, error: `(parse): ${err.message.split('\n')[0]}` });
    }
  }
}
const byId = new Map(read.filter((r) => r.profile && typeof r.profile.id === 'string').map((r) => [r.profile.id, r.profile]));
const profiles = [];
let failed = false;
for (const { path, profile, error } of read) {
  const errors = error ? [error] : validateProfile(profile, { fileName: path, profiles: byId });
  if (errors.length > 0) {
    failed = true;
    console.error(`FAIL  ${path}\n      ${errors.join('\n      ')}`);
    continue;
  }
  profiles.push(profile);
}
if (failed) process.exit(1);
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
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(profiles, null, 2)}\n`);
console.log(`Wrote ${profiles.length} profiles to ${out}`);
