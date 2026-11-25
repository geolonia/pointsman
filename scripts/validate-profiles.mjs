#!/usr/bin/env node
// Validate decision profiles against schema/profile-v1.schema.json.
//
// Usage: node scripts/validate-profiles.mjs <file-or-directory>...
// Exits 1 when any profile is invalid, or when no profile is found.

import { factModulesError, loadProfileSet, validateProfile } from './lib/profile.mjs';

// A broken engine.json stops the script with one line, not a stack trace.
if (factModulesError()) {
  console.error(factModulesError());
  process.exit(2);
}

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

// Ids must be unique across all files given (a config repository's profiles/).
// Each file with an id that another file also has fails, so the lines and
// the counts below agree.
const pathsById = new Map();
for (const { path, profile } of set.entries) {
  if (typeof profile?.id === 'string') pathsById.set(profile.id, [...(pathsById.get(profile.id) ?? []), path]);
}
const duplicateErrors = (profile) => {
  const paths = pathsById.get(profile?.id) ?? [];
  return paths.length > 1 ? [`duplicate profile id "${profile.id}": ${paths.join(', ')}`] : [];
};

let failed = 0;
for (const { path: file, profile, error: parseError } of set.entries) {
  const errors = parseError ? [parseError] : [...duplicateErrors(profile), ...validateProfile(profile, { fileName: file, profiles })];
  if (errors.length === 0) {
    console.log(`ok    ${file}`);
    continue;
  }
  failed += 1;
  console.log(`FAIL  ${file}`);
  for (const e of errors) console.log(`      ${e}`);
}

console.log(`\n${files.length - failed} valid, ${failed} invalid`);
// Exit once stdout has written everything (a queued pipe write would be lost).
process.stdout.write('', () => process.exit(failed === 0 ? 0 : 1));
