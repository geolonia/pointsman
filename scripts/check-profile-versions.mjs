#!/usr/bin/env node
// Check that every profile changed since a base commit has a higher version.
//
// Usage: node scripts/check-profile-versions.mjs --base <commit> <directory>
//
// A published id + version never changes (publish-profiles refuses to
// overwrite it), so a changed profile needs a new version. Without this check
// a missing version bump is noticed only at deploy, after the merge.
//
// Profiles are matched by id, not by file name, so renaming a file is not a
// change. Content is compared after parsing, so comments and formatting are
// not changes either. New and deleted profiles pass: a deleted profile keeps
// its published versions, and a new id may start at any version (an id deleted earlier and
// added again must not reuse a published version; publish-profiles refuses
// that).
//
// Run from the repository root. Exits 1 when a changed profile keeps or lowers
// its version, 2 on usage or git errors.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import { collectProfileFiles, parseProfile, PROFILE_EXTENSIONS } from './lib/profile.mjs';

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: check-profile-versions --base <commit> <directory>');
  process.exit(2);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({ options: { base: { type: 'string' } }, allowPositionals: true }));
} catch (err) {
  usage(err.message);
}
const base = values.base;
const [dir] = positionals;
if (!base || !dir || positionals.length !== 1) usage();
// Passed to git as an argument: no option-like or odd values.
if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(base) || base.includes('..')) usage(`--base: not a commit or branch name: ${base}`);
if (dir.startsWith('-')) usage(`not a directory: ${dir}`);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** JSON with sorted keys, so key order does not count as a change. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The profile without its version, for comparing content. */
function content(profile) {
  const { version: _, ...rest } = profile;
  return canonical(rest);
}

/** id -> { version, content, path } for the profiles in a list of [path, text]. */
function byId(entries, { onError }) {
  const map = new Map();
  for (const [path, text] of entries) {
    let profile;
    try {
      profile = parseProfile(text, path);
    } catch (err) {
      onError(path, `cannot be parsed: ${err.message.split('\n')[0]}`);
      continue;
    }
    if (!profile || typeof profile.id !== 'string' || !Number.isInteger(profile.version)) {
      onError(path, 'has no id or no whole-number version');
      continue;
    }
    map.set(profile.id, { version: profile.version, content: content(profile), path });
  }
  return map;
}

let baseEntries;
try {
  git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  const paths = git(['ls-tree', '-r', '--full-name', '--name-only', base, '--', dir])
    .split('\n')
    .filter((p) => p && PROFILE_EXTENSIONS.includes(extname(p)));
  baseEntries = paths.map((p) => [p, git(['show', `${base}:${p}`])]);
} catch (err) {
  console.error(`git: cannot read ${dir} at ${base}: ${(err.stderr || err.message).trim().split('\n')[0]}`);
  process.exit(2);
}

let headFiles;
try {
  headFiles = collectProfileFiles(dir);
} catch (err) {
  usage(err.message);
}

let failed = 0;
const fail = (message) => {
  failed += 1;
  console.log(`FAIL  ${message}`);
};

// A base profile that cannot be read is not compared (it was never valid).
const before = byId(baseEntries, { onError: () => {} });
// A profile in the pull request that cannot be read fails here too;
// validate-profiles explains why.
const after = byId(headFiles.map((f) => [f, readFileSync(f, 'utf8')]), { onError: (path, why) => fail(`${path} ${why}`) });

for (const [id, now] of after) {
  const was = before.get(id);
  if (!was) {
    console.log(`new   ${now.path}: ${id} version ${now.version}`);
    continue;
  }
  if (now.content === was.content) {
    if (now.version < was.version) fail(`${now.path}: version of ${id} lowered from ${was.version} to ${now.version}`);
    else console.log(`same  ${now.path}: ${id} version ${now.version}`);
    continue;
  }
  if (now.version > was.version) {
    console.log(`ok    ${now.path}: ${id} changed, version ${was.version} -> ${now.version}`);
  } else {
    fail(`${now.path}: ${id} changed but its version is ${now.version} (was ${was.version}); increase the version`);
  }
}
for (const [id, was] of before) {
  if (!after.has(id)) console.log(`gone  ${was.path}: ${id} (removed; its published versions are kept)`);
}

console.log(failed === 0 ? '\nVersions ok.' : `\n${failed} problem(s).`);
process.exit(failed === 0 ? 0 : 1);
