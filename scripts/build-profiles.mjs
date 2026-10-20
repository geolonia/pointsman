#!/usr/bin/env node
// Validate profiles and write them as one JSON array, for the "bundled"
// profile store and the tests.
//
// Usage: node scripts/build-profiles.mjs [out-file] [dir...]
// Defaults: generated/profiles.json from examples/profiles.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { PROFILE_EXTENSIONS, parseProfile, validateProfile } from './lib/profile.mjs';

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
if (profiles.length === 0) {
  console.error(`No profiles found in: ${sources.join(', ')}`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(profiles, null, 2)}\n`);
console.log(`Wrote ${profiles.length} profiles to ${out}`);
