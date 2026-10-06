#!/usr/bin/env node
// Validate profiles and upload them to the PROFILES KV namespace (via wrangler).
//
//   node scripts/publish-profiles.mjs --dir <profiles> (--local|--remote) [--config <file>] [--env <name>] [--dry-run]
//
// KV keys (read by KvProfileStore, src/profiles/store.ts):
//   profile:<id>:<version>  the profile JSON
//   index                   one summary per profile id, with all versions
//
// A published id + version never changes. The record of published versions is
// the D1 table profile_versions (migrations/0002), not KV: D1 is strongly
// consistent, KV listings are not. All versions are checked against it first;
// if one is registered with different content, nothing is registered or
// written and the script fails ("increase the version"). Then the new versions
// are registered in one transaction, and only then written to KV. Old versions stay in KV, so feedback on old decisions can
// still be checked against them. The index is written last; readers tolerate
// a new index that arrives before the new profile (see KvProfileStore).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/log.ts';
import { collectProfileFiles, duplicateIdErrors, parseProfile, validateProfile } from './lib/profile.mjs';
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

const where = [
  values.local ? '--local' : '--remote',
  ...(values.config ? ['--config', values.config] : []),
  ...(values.env ? ['--env', values.env] : []),
];
const kv = (args) => wrangler(['kv', ...args, '--binding', 'PROFILES', ...where]);
/** Run SQL on the DB binding; returns the rows of the last statement. */
function d1(sql) {
  const out = JSON.parse(wrangler(['d1', 'execute', 'DB', '--command', sql, '--json', ...where]));
  return out[out.length - 1]?.results ?? [];
}

// 1. Read and validate every profile.
const profiles = [];
const paths = [];
const errors = [];
let files;
try {
  files = collectProfileFiles(values.dir);
} catch (err) {
  fail(err.message, 2);
}
for (const path of files) {
  try {
    const profile = parseProfile(readFileSync(path, 'utf8'), path);
    const problems = validateProfile(profile, { fileName: path });
    if (problems.length > 0) errors.push(`${path}\n  ${problems.join('\n  ')}`);
    else {
      profiles.push(profile);
      paths.push(path);
    }
  } catch (err) {
    errors.push(`${path}\n  (parse): ${err.message.split('\n')[0]}`);
  }
}
errors.push(...duplicateIdErrors(paths.map((p, i) => [p, profiles[i]])));
if (errors.length > 0) fail(`Invalid profiles; nothing was published.\n${errors.join('\n')}`);
if (profiles.length === 0) fail(`No profiles in ${values.dir}; nothing was published.`);

// 2. Check every version against the record in D1, then register the new
// ones. Ids match [a-z0-9-], versions are integers and hashes hex (validated
// above), so they can be put into the SQL text directly.
const hash = (p) => createHash('sha256').update(canonicalJson(p)).digest('hex');
const key = (p) => `profile:${p.id}:${p.version}`;
const now = new Date().toISOString();
const readRegistered = () => d1('SELECT profile_id, version, content_hash FROM profile_versions;');

let registered;
try {
  registered = readRegistered();
} catch (err) {
  fail(err.message);
}
let byKey = new Map(registered.map((r) => [`${r.profile_id}:${r.version}`, r]));
const conflicts = profiles.filter((p) => byKey.has(`${p.id}:${p.version}`) && byKey.get(`${p.id}:${p.version}`).content_hash !== hash(p));
if (conflicts.length > 0) {
  fail(`Already published with different content (increase "version"; nothing was published):\n  ${conflicts.map((p) => `${p.id} version ${p.version}`).join('\n  ')}`);
}
// Versions only go up; checked before anything is registered.
for (const p of profiles) {
  const published = registered.filter((r) => r.profile_id === p.id).map((r) => Number(r.version));
  const latest = Math.max(0, ...published);
  if (p.version < latest) {
    fail(`${p.id}: the repository has version ${p.version}, but version ${latest} is already published; versions only go up. Nothing was published.`);
  }
}
const toWrite = profiles.filter((p) => !byKey.has(`${p.id}:${p.version}`));

// Register all new versions in one batch, which D1 runs as one transaction.
// Plain INSERT (no OR IGNORE): if another deploy registered one of them in
// the meantime, the whole batch fails and nothing is registered.
if (toWrite.length > 0 && !values['dry-run']) {
  try {
    d1(toWrite.map((p) => `INSERT INTO profile_versions VALUES ('${p.id}', ${p.version}, '${hash(p)}', '${now}');`).join('\n'));
    registered = readRegistered();
  } catch (err) {
    fail(`Registering the new versions failed; nothing was published (another deploy may have run at the same time):\n${err.message}`);
  }
}

// 3. The index: all registered versions, latest title and description from
// the repository.
const versions = new Map();
for (const r of registered) {
  if (!versions.has(r.profile_id)) versions.set(r.profile_id, new Set());
  versions.get(r.profile_id).add(Number(r.version));
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
  // was removed from the repository keeps its old versions but leaves the
  // index, so it can no longer be called without a version.
  const p = latestFromRepo.get(id);
  if (!p) continue;
  index.push({ id, version: latest, versions: sorted, title: p.title, description: p.description });
}

console.log(`New: ${toWrite.map((p) => `${p.id}@${p.version}`).join(', ') || '(none)'}`);
console.log(`Index: ${index.map((s) => `${s.id}@${s.version}`).join(', ')}`);
if (values['dry-run']) process.exit(0);

// 4. Write profiles first, then the index.
const dir = mkdtempSync(join(tmpdir(), 'pointsman-publish-'));
try {
  // All versions in the repository, not only new ones: a previous run may
  // have registered a version and failed before writing it to KV. The content
  // is the registered content, so rewriting it changes nothing.
  const file = join(dir, 'profiles.json');
  writeFileSync(file, JSON.stringify(profiles.map((p) => ({ key: key(p), value: JSON.stringify(p) }))));
  kv(['bulk', 'put', file]);
  kv(['key', 'put', 'index', JSON.stringify(index)]);
} catch (err) {
  fail(err.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('Published.');
