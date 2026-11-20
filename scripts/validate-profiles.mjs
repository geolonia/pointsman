#!/usr/bin/env node
// Validate decision profiles against schema/profile-v1.schema.json.
//
// Usage: node scripts/validate-profiles.mjs <file-or-directory>...
// Exits 1 when any profile is invalid, or when no profile is found.

import { loadProfileSet, validateProfile } from './lib/profile.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: validate-profiles <file-or-directory>...');
  process.exit(2);
}

let set;
try {
  set = loadProfileSet(args);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const files = set.entries.map((e) => e.path);
if (files.length === 0) {
  console.error(`No profiles found in: ${args.join(', ')}`);
  process.exit(1);
}

// All files are read first: a profile is validated together with the ones
// it requires (docs/decision-chains.md "Checked both ways").
const profiles = set.byId;

let failed = 0;
for (const { path: file, profile, error: parseError } of set.entries) {
  const errors = parseError ? [parseError] : validateProfile(profile, { fileName: file, profiles });
  if (errors.length === 0) {
    console.log(`ok    ${file}`);
    continue;
  }
  failed += 1;
  console.log(`FAIL  ${file}`);
  for (const e of errors) console.log(`      ${e}`);
}

// Ids must be unique across all files given (a config repository's profiles/).
const { duplicates } = set;
for (const d of duplicates) console.log(`FAIL  ${d}`);
if (duplicates.length > 0) failed += 1;

console.log(`\n${files.length - failed} valid, ${failed} invalid`);
process.exit(failed === 0 ? 0 : 1);
