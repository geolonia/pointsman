#!/usr/bin/env node
// Explain a decision profile in plain sentences, for the person who approves
// it (docs/profile-format.md#explain). Works on drafts: the file does not have
// to be published. The profile is validated first; an invalid profile is not
// explained, because the sentences would describe rules the engine refuses.
//
// Usage: node scripts/explain-profile.mjs <file> [--lang en|ja] [--json] [--with <file-or-directory>]...
//
// The profiles a profile requires are read from its own directory, and from
// every --with path.

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { collectProfileFiles, parseProfile, validateProfile } from './lib/profile.mjs';
import { explainProfile, explanationText } from '../src/explain.ts';

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { lang: { type: 'string', default: 'en' }, json: { type: 'boolean', default: false }, with: { type: 'string', multiple: true, default: [] } },
  });
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const { positionals, values } = args;
if (positionals.length !== 1 || !['en', 'ja'].includes(values.lang)) {
  console.error('Usage: explain-profile <file> [--lang en|ja] [--json] [--with <file-or-directory>]...');
  process.exit(2);
}
const [file] = positionals;

let profile;
let others;
try {
  profile = parseProfile(readFileSync(file, 'utf8'), file);
  others = new Map();
  for (const f of [dirname(file), ...values.with].flatMap(collectProfileFiles)) {
    try {
      const p = parseProfile(readFileSync(f, 'utf8'), f);
      if (p && typeof p.id === 'string' && p.id !== profile.id) others.set(p.id, p);
    } catch {
      // Another file that does not parse is not this profile's problem; a
      // profile that requires it is reported by the validation below.
    }
  }
} catch (err) {
  console.error(`${file}: ${err.message.split('\n')[0]}`);
  process.exit(1);
}

const errors = validateProfile(profile, { fileName: file, profiles: others });
if (errors.length) {
  console.error(`${file} is not valid, so it is not explained:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const explanation = explainProfile(profile, values.lang, Object.fromEntries(others));
process.stdout.write(values.json ? `${JSON.stringify(explanation, null, 2)}\n` : explanationText(explanation));
