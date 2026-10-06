#!/usr/bin/env node
// Validate decision profiles against schema/profile-v1.schema.json.
//
// Usage: node scripts/validate-profiles.mjs <file-or-directory>...
// Exits 1 when any profile is invalid, or when no profile is found.

import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { PROFILE_EXTENSIONS, validateProfileFile } from './lib/profile.mjs';

function collect(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .map((entry) => join(path, entry))
    .filter((p) => statSync(p).isDirectory() || PROFILE_EXTENSIONS.includes(extname(p)))
    .flatMap(collect);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: validate-profiles <file-or-directory>...');
  process.exit(2);
}

let files;
try {
  files = args.flatMap(collect);
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

console.log(`\n${files.length - failed} valid, ${failed} invalid`);
process.exit(failed === 0 ? 0 : 1);
