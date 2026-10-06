#!/usr/bin/env node
// Validate profiles and upload them to the PROFILES KV namespace (via wrangler).
//
//   node scripts/publish-profiles.mjs --dir <profiles> (--local|--remote) [--config <file>] [--env <name>] [--dry-run]
//
// KV keys (read by KvProfileStore, src/profiles/store.ts):
//   profile:<id>:<version>  the profile JSON
//   index                   one summary per profile id, with all versions
//
// A published id + version never changes: if KV already holds that version
// with different content, nothing is written and the script fails ("increase
// the version"). Old versions stay in KV, so feedback on old decisions can
// still be checked against them. The index is written last, so a new version
// becomes visible only after the profile itself is stored.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../src/log.ts';
import { PROFILE_EXTENSIONS, parseProfile, validateProfile } from './lib/profile.mjs';
import { wrangler } from './lib/wrangler.mjs';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      dir: { type: 'string' },
      config: { type: 'string' },
      env: { type: 'string' },
      local: { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  }));
} catch (err) {
  fail(err.message, 2);
}
if (!values.dir) fail('Usage: publish-profiles.mjs --dir <profiles> (--local|--remote) [--config f] [--env e] [--dry-run]', 2);
if (values.local === values.remote) fail('Give exactly one of --local or --remote.', 2);

const target = [
  '--binding', 'PROFILES',
  values.local ? '--local' : '--remote',
  ...(values.config ? ['--config', values.config] : []),
  ...(values.env ? ['--env', values.env] : []),
];
const kv = (args, opts) => wrangler(['kv', ...args, ...target], opts);

// 1. Read and validate every profile.
const profiles = [];
const errors = [];
let entries;
try {
  entries = readdirSync(values.dir).sort();
} catch (err) {
  fail(err.message, 2);
}
for (const entry of entries) {
  if (!PROFILE_EXTENSIONS.includes(extname(entry))) continue;
  const path = join(values.dir, entry);
  try {
    const profile = parseProfile(readFileSync(path, 'utf8'), path);
    const problems = validateProfile(profile, { fileName: path });
    if (problems.length > 0) errors.push(`${path}\n  ${problems.join('\n  ')}`);
    else profiles.push(profile);
  } catch (err) {
    errors.push(`${path}\n  (parse): ${err.message.split('\n')[0]}`);
  }
}
if (errors.length > 0) fail(`Invalid profiles; nothing was published.\n${errors.join('\n')}`);
if (profiles.length === 0) fail(`No profiles in ${values.dir}; nothing was published.`);

// 2. Compare with what KV already holds.
let existingKeys;
try {
  existingKeys = new Set(JSON.parse(kv(['key', 'list', '--prefix', 'profile:'])).map((k) => k.name));
} catch (err) {
  fail(err.message);
}
const key = (p) => `profile:${p.id}:${p.version}`;
const toWrite = [];
const conflicts = [];
for (const p of profiles) {
  if (!existingKeys.has(key(p))) {
    toWrite.push(p);
    continue;
  }
  const stored = JSON.parse(kv(['key', 'get', key(p), '--text']));
  if (canonicalJson(stored) !== canonicalJson(p)) conflicts.push(`${p.id} version ${p.version}`);
}
if (conflicts.length > 0) {
  fail(`Already published with different content (increase "version"; nothing was published):\n  ${conflicts.join('\n  ')}`);
}

// 3. The index: all versions in KV plus the new ones, latest title and description.
const versions = new Map();
for (const name of existingKeys) {
  const [, id, v] = name.split(':');
  if (!versions.has(id)) versions.set(id, new Set());
  versions.get(id).add(Number(v));
}
for (const p of profiles) {
  if (!versions.has(p.id)) versions.set(p.id, new Set());
  versions.get(p.id).add(p.version);
}
const latestFromRepo = new Map(profiles.map((p) => [p.id, p]));
const index = [];
for (const [id, set] of [...versions].sort(([a], [b]) => a.localeCompare(b))) {
  const sorted = [...set].sort((a, b) => a - b);
  const latest = sorted[sorted.length - 1];
  // The repository holds the current version of each profile; a profile that
  // was removed from the repository keeps its old versions in KV but leaves
  // the index, so it can no longer be called without a version.
  const p = latestFromRepo.get(id);
  if (!p) continue;
  if (p.version !== latest) {
    fail(`${id}: the repository has version ${p.version}, but KV already has version ${latest}; versions only go up.`);
  }
  index.push({ id, version: latest, versions: sorted, title: p.title, description: p.description });
}

console.log(`New: ${toWrite.map((p) => `${p.id}@${p.version}`).join(', ') || '(none)'}`);
console.log(`Index: ${index.map((s) => `${s.id}@${s.version}`).join(', ')}`);
if (values['dry-run']) process.exit(0);

// 4. Write profiles first, then the index.
const dir = mkdtempSync(join(tmpdir(), 'pointsman-publish-'));
try {
  if (toWrite.length > 0) {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify(toWrite.map((p) => ({ key: key(p), value: JSON.stringify(p) }))));
    kv(['bulk', 'put', file]);
  }
  kv(['key', 'put', 'index', JSON.stringify(index)]);
} catch (err) {
  fail(err.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('Published.');
