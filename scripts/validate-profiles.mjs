#!/usr/bin/env node
// Validate decision profiles against schema/profile-v1.schema.json.
//
// Usage: node scripts/validate-profiles.mjs <file-or-directory>...
// Exits 1 when any profile is invalid, or when no profile is found.

import { readFileSync } from 'node:fs';
import { collectProfileFiles, duplicateIdErrors, parseProfile, validateProfileFile } from './lib/profile.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: validate-profiles <file-or-directory>...');
  process.exit(2);
}

let files;
try {
  files = args.flatMap(collectProfileFiles);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`No profiles found in: ${args.join(', ')}`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const errors = validateProfileFile(file);
  if (errors.length === 0) {
    console.log(`ok    ${file}`);
    continue;
  }
  failed += 1;
  console.log(`FAIL  ${file}`);
  for (const e of errors) console.log(`      ${e}`);
}

// Ids must be unique across all files given (a config repository's profiles/).
const parsed = files.map((f) => {
  try {
    return [f, parseProfile(readFileSync(f, 'utf8'), f)];
  } catch {
    return [f, null];
  }
});
const duplicates = duplicateIdErrors(parsed);
for (const d of duplicates) console.log(`FAIL  ${d}`);
if (duplicates.length > 0) failed += 1;

console.log(`\n${files.length - failed} valid, ${failed} invalid`);
process.exit(failed === 0 ? 0 : 1);
