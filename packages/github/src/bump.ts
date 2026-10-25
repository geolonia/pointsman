// github_bump (docs/profile-format.md#github-pull-requests): whether a pull
// request only bumps npm dependency versions, the way a Dependabot pull
// request does. Every changed file must be a package.json, a pnpm-lock.yaml,
// a package-lock.json or an .npmrc, edited in place; anything else (another
// ecosystem, code, docs) gives applies false. A package.json is read whole
// at the head commit, and its earlier text is the head text with the patch
// taken back, so both sides are the pull request's own (the merge base, not
// a newer base branch). Lockfiles are only read through their patch, for
// changed sources and the versions they add (lockfileChanges), and for the
// version steps they make and their dev marks (lockfile.ts). Whatever is not
// understood gives the stricter answer;
// what cannot be read (no patch, a patch that does not fit the file) fails
// the fact, so it is missing rather than wrong.

import { FactError } from '@pointsman/module-api';
import { lockfileSteps } from './lockfile';

/** A changed file as the pull-request files API lists it. */
export interface BumpFile {
  names: string[];
  status: string;
  /** The unified patch; null when GitHub gives none (binary, too large). */
  patch: string | null;
}

export interface BumpFacts {
  applies: boolean;
  only_manifests: boolean;
  version_only: boolean;
  /** "major", "minor", "patch" or "none". */
  semver: string;
  dev_only: boolean;
  registry_changed: boolean;
  manifest_lines: number;
  release_age_days: number;
}

/** Not a bump this fact understands: every field has its strictest value. */
export const NO_BUMP: BumpFacts = {
  applies: false, only_manifests: false, version_only: false, semver: 'none', dev_only: false,
  registry_changed: true, manifest_lines: 0, release_age_days: 0,
};

/** A package bumped to a version: one registry read. */
export interface BumpedVersion { name: string; version: string }

/** A dependency whose version spec changed in one package.json. */
export interface Bump {
  manifest: string;
  section: string;
  name: string;
  from: string;
  to: string;
}

/** The sections of a package.json that name dependencies. */
export const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
/** A pull request with more bumped versions (package.json and lockfiles) fails the fact: each is one registry read. */
export const MAX_BUMPED_PACKAGES = 30;
/** The registry whose lockfile URLs are no change of source. */
export const NPM_REGISTRY = 'https://registry.npmjs.org';
/** A package name as npm allows it (lower case, optionally scoped). */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9][a-z0-9._~-]{0,100}$/;
/** A version spec this fact understands: an exact version, or one after ^ or ~. No pre-release, no range. */
const SPEC = /^([~^]?)(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/;

type Kind = 'manifest' | 'lockfile' | 'npmrc';

const base = (name: string) => name.slice(name.lastIndexOf('/') + 1);

/** What a changed file is to this fact; null for any other file. */
export function bumpKindOf(name: string): Kind | null {
  const file = base(name);
  if (file === 'package.json') return 'manifest';
  if (file === 'pnpm-lock.yaml' || file === 'package-lock.json') return 'lockfile';
  if (file === '.npmrc') return 'npmrc';
  return null;
}

/** The changed lines of a patch, without the marks. */
function changedLines(patch: string): string[] {
  return patch.split('\n').filter((l) => (l.startsWith('+') || l.startsWith('-'))).map((l) => l.slice(1));
}

/**
 * The text before a patch, from the text after it: context lines and added
 * lines must be where the hunks say, removed lines come back. Null when the
 * patch does not fit the text (another version of the file).
 */
export function textBefore(after: string, patch: string): string | null {
  const head = after.split('\n');
  const out: string[] = [];
  let at = 0; // the next line of `head`, 0-based
  const lines = patch.split('\n');
  let i = 0;
  // A patch may end with a newline: no line after it.
  if (lines[lines.length - 1] === '') lines.pop();
  while (i < lines.length) {
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (!m) return null;
    const oldCount = m[1] === undefined ? 1 : Number(m[1]);
    const newCount = m[3] === undefined ? 1 : Number(m[3]);
    // A hunk without new lines names the line after which it removes.
    const start = newCount === 0 ? Number(m[2]) : Number(m[2]) - 1;
    if (start < at || start > head.length) return null;
    out.push(...head.slice(at, start));
    at = start;
    let olds = 0;
    let news = 0;
    for (i++; i < lines.length && !lines[i]!.startsWith('@@'); i++) {
      const line = lines[i]!;
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      const mark = line[0] ?? ' ';
      const text = line.slice(1);
      if (mark === '-') {
        out.push(text);
        olds++;
      } else if (mark === '+' || mark === ' ') {
        if (head[at] !== text) return null;
        if (mark === ' ') {
          out.push(text);
          olds++;
        }
        at++;
        news++;
      } else {
        return null;
      }
    }
    if (olds !== oldCount || news !== newCount) return null;
  }
  out.push(...head.slice(at));
  return out.join('\n');
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep equality of JSON values; the order of keys does not count. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/**
 * The dependencies whose spec changed between two package.json texts, and
 * whether nothing else changed: no other key, no dependency added or removed,
 * every changed spec a text. Null when a side is not a JSON object.
 */
export function manifestBumps(manifest: string, before: string, after: string): { bumps: Bump[]; onlySpecs: boolean; sides: Record<string, unknown>[] } | null {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return null;
  }
  if (!isObject(a) || !isObject(b)) return null;
  let onlySpecs = true;
  const bumps: Bump[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!DEPENDENCY_SECTIONS.includes(key)) {
      if (!same(a[key], b[key])) onlySpecs = false;
      continue;
    }
    const x = a[key];
    const y = b[key];
    if (!isObject(x) || !isObject(y)) {
      if (!same(x, y)) onlySpecs = false;
      continue;
    }
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      // A dependency added or removed is not a bump.
      if (!Object.hasOwn(x, name) || !Object.hasOwn(y, name)) {
        onlySpecs = false;
        continue;
      }
      if (x[name] === y[name]) continue;
      if (typeof x[name] !== 'string' || typeof y[name] !== 'string') {
        onlySpecs = false;
        continue;
      }
      bumps.push({ manifest, section: key, name, from: x[name], to: y[name] });
    }
  }
  return { bumps, onlySpecs, sides: [a, b] };
}

const parse = (spec: string) => {
  const m = SPEC.exec(spec);
  return m ? { op: m[1]!, v: [Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number], version: `${m[2]}.${m[3]}.${m[4]}` } : null;
};

const STEPS = ['major', 'minor', 'patch'];

/**
 * The step between two version specs: "major", "minor" or "patch"; "none"
 * when a spec is not understood (a range, a pre-release, a tag, a URL),
 * the operator changes (^ to ~), or the version does not go up. As the
 * caret does in npm, leading zeros move the step one place up: from 0.y.z
 * a minor step counts as major and a patch step as minor, from 0.0.z any
 * step counts as major. So only a version from 1.0.0 on can make a patch.
 */
export function stepOf(from: string, to: string): string {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b || a.op !== b.op) return 'none';
  const i = a.v.findIndex((n, k) => n !== b.v[k]);
  if (i < 0 || b.v[i]! < a.v[i]!) return 'none';
  const lead = a.v[0] > 0 ? 0 : a.v[1] > 0 ? 1 : 2;
  return STEPS[Math.max(0, i - lead)]!;
}

/** The largest of two steps; "none" wins, since it is not understood. */
export const larger = (a: string, b: string): string => (a === 'none' || b === 'none' ? 'none' : STEPS[Math.min(STEPS.indexOf(a), STEPS.indexOf(b))]!);

/** A spec that names a source instead of a version: a URL, git, a file, a link, an alias, a workspace. */
const SOURCE_SPEC = /[:/]/;

/**
 * Whether a changed lockfile line may change where a package comes from: a
 * URL other than the npm registry, a source key (tarball, repo, commit,
 * directory, registry), or a protocol such as git+, file:, link: or npm:.
 */
export function changesSource(line: string): boolean {
  const rest = line.split(`${NPM_REGISTRY}/`).join('');
  if (/[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rest) || /(?:^|["'\s])\/\//.test(rest)) return true;
  if (/(?:^|[\s{,"'])(?:tarball|repo|commit|directory|registry)["']?\s*:/.test(rest)) return true;
  // Also after "@", for an alias in a pnpm-lock.yaml key (name@npm:other@1.0.0).
  return /(?:^|[\s"'@])(?:git\+|git:|github:|gitlab:|bitbucket:|file:|link:|npm:|workspace:)/.test(rest);
}

/**
 * A pnpm version without its peers in parentheses, nested or not: the
 * characters outside every parenthesis, in one pass. Unbalanced
 * parentheses give the text back as it is, which is no pinned version.
 */
export function stripPeers(v: string): string {
  let out = '';
  let depth = 0;
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return v;
      depth--;
    } else if (depth === 0) out += ch;
  }
  return depth === 0 ? out : v;
}

/** A version as a lockfile pins it: no range, no alias. */
const PINNED = /^\d{1,10}\.\d{1,10}\.\d{1,10}(?:-[0-9A-Za-z.-]{1,60})?$/;
/**
 * A pnpm-lock.yaml package key (packages, snapshots): name@version, then
 * peers in parentheses; with a leading "/" in lockfile v6 (pnpm 8).
 */
const PNPM_KEY = /^ {2}'?\/?((?:@[^@/'\s]+\/)?[^@/'\s]+)@([^'(:\s]+)(?:\(.*\))?'?:(?:\s*\{\})?\s*$/;
/** Any key two spaces deep that opens a block, such as a lockfile v5 key (/name/1.0.0:). */
const PNPM_BLOCK_KEY = /^ {2}[^\s#][^:]*:(?:\s*\{\})?\s*$/;
/** A package-lock.json entry key: "node_modules/<name>", maybe nested. */
const LOCK_KEY = /^\s*"(?:[^"]*\/)?node_modules\/((?:@[^/"]+\/)?[^/"]+)":\s*\{/;

/**
 * A lockfile's patch: whether it may change where a package comes from, and
 * the versions it adds (each one's age counts, transitive ones too). In a
 * pnpm-lock.yaml, a changed `version:` must be a pinned version (peers in
 * parentheses aside), not an alias such as other@1.0.0, and a changed key
 * that is not name@version (lockfile v5, a new importer) counts as a change
 * of source, so no version escapes the age check. In a
 * package-lock.json, a changed "resolved" must be the npm registry's
 * tarball of the entry's own package, and a changed "link" is a change of
 * source; an entry whose key the patch does not show cannot be checked, so
 * it counts as a change.
 */
export function lockfileChanges(file: string, patch: string): { sourceChanged: boolean; versions: BumpedVersion[] } {
  let sourceChanged = false;
  const versions: BumpedVersion[] = [];
  const add = (name: string, version: string) => {
    if (NPM_NAME.test(name) && PINNED.test(version)) versions.push({ name, version });
    else sourceChanged = true;
  };
  if (base(file) === 'pnpm-lock.yaml') {
    for (const line of patch.split('\n')) {
      const mark = line[0];
      if (mark !== '+' && mark !== '-') continue;
      const text = line.slice(1);
      // An escape ("\u0065", "\/") can spell a field or URL the checks here
      // do not see; pnpm writes none in these lines.
      if (changesSource(text) || text.includes('\\')) sourceChanged = true;
      const v = /^\s+version:\s*'?([^']*)'?\s*$/.exec(text);
      if (v) {
        if (!PINNED.test(stripPeers(v[1]!))) sourceChanged = true;
      }
      const key = PNPM_KEY.exec(text);
      if (key && mark === '+') add(key[1]!, key[2]!);
      else if (!key && PNPM_BLOCK_KEY.test(text)) sourceChanged = true;
    }
    return { sourceChanged, versions };
  }
  // package-lock.json: the entry each line is in, on each side.
  let before: string | null = null;
  let after: string | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      before = after = null;
      continue;
    }
    const mark = line[0];
    const text = line.slice(1);
    const key = LOCK_KEY.exec(text);
    if (key) {
      if (mark !== '+') before = key[1]!;
      if (mark !== '-') after = key[1]!;
    }
    if (mark !== '+' && mark !== '-') continue;
    // An escape ("resolv\u0065d", "https:\/\/"), as in a pnpm-lock.yaml.
    if (changesSource(text) || /"link"\s*:/.test(text) || text.includes('\\')) sourceChanged = true;
    const entry = mark === '+' ? after : before;
    const resolved = /^\s*"resolved":\s*"([^"]*)"/.exec(text);
    if (resolved) {
      const tarball = entry === null ? null : `${NPM_REGISTRY}/${entry}/-/${base(entry)}-`;
      const version = tarball && resolved[1]!.startsWith(tarball) && resolved[1]!.endsWith('.tgz') ? resolved[1]!.slice(tarball.length, -4) : null;
      if (version === null || !PINNED.test(version)) sourceChanged = true;
      else if (mark === '+') add(entry!, version);
    }
    const version = /^\s*"version":\s*"([^"]*)"/.exec(text);
    if (version && mark === '+' && entry !== null) add(entry, version[1]!);
  }
  return { sourceChanged, versions };
}

/** The package.json files to read; null when the pull request is not a bump this fact understands, so nothing more is read. */
export function manifestsToRead(files: BumpFile[]): string[] | null {
  if (files.length === 0) return null;
  const out: string[] = [];
  for (const f of files) {
    const kind = f.names.length === 1 ? bumpKindOf(f.names[0]!) : null;
    // Another file, a rename, a new or removed manifest or lockfile: not a bump.
    if (kind === null || (kind !== 'npmrc' && f.status !== 'modified')) return null;
    if (kind === 'manifest') out.push(f.names[0]!);
  }
  return out.length > 0 ? out : null;
}

/**
 * The bump facts without the release age, and the versions whose age is
 * needed. `heads` has the text at the head commit of each package.json
 * that manifestsToRead named.
 */
export function bumpFacts(files: BumpFile[], heads: Map<string, string>): { facts: Omit<BumpFacts, 'release_age_days'>; versions: BumpedVersion[]; devNames: string[] } | null {
  if (manifestsToRead(files) === null) return null;
  let onlyManifests = true;
  let onlySpecs = true;
  let registryChanged = false;
  let manifestLines = 0;
  const bumps: Bump[] = [];
  const sides: Record<string, unknown>[] = [];
  const locked: BumpedVersion[] = [];
  let lockSemver: string | null = null;
  const lockNames = new Set<string>();
  let lockRuntime = false;
  for (const f of files) {
    const name = f.names[0]!;
    const kind = bumpKindOf(name)!;
    if (kind === 'npmrc') {
      // Registry settings: always a change of source, whatever it says.
      onlyManifests = false;
      registryChanged = true;
      continue;
    }
    if (f.patch === null) throw new FactError(`GitHub files: no patch for ${kind === 'manifest' ? 'a package.json' : 'a lockfile'}`);
    if (kind === 'lockfile') {
      const lock = lockfileChanges(name, f.patch);
      if (lock.sourceChanged) registryChanged = true;
      locked.push(...lock.versions);
      const steps = lockfileSteps(name, f.patch);
      if (steps.semver !== null) lockSemver = lockSemver === null ? steps.semver : larger(lockSemver, steps.semver);
      for (const n of steps.names) lockNames.add(n);
      if (steps.runtime) lockRuntime = true;
      continue;
    }
    manifestLines += changedLines(f.patch).length;
    const after = heads.get(name);
    if (after === undefined) throw new FactError('a package.json was not read');
    const before = textBefore(after, f.patch);
    if (before === null) throw new FactError('GitHub files: the patch of a package.json does not fit the file');
    const found = manifestBumps(name, before, after);
    // Not JSON on one side: not a package.json this fact understands.
    if (!found) return null;
    if (!found.onlySpecs) onlySpecs = false;
    bumps.push(...found.bumps);
    sides.push(...found.sides);
  }
  if (bumps.length === 0) return null;
  if (bumps.some((b) => !NPM_NAME.test(b.name))) return null;
  let semver = 'patch';
  const versions = new Map<string, BumpedVersion>();
  for (const b of bumps) {
    semver = larger(semver, stepOf(b.from, b.to));
    const to = parse(b.to);
    if (!to || !parse(b.from)) onlySpecs = false;
    if (SOURCE_SPEC.test(b.from) || SOURCE_SPEC.test(b.to)) registryChanged = true;
    if (to) versions.set(`${b.name}@${to.version}`, { name: b.name, version: to.version });
  }
  // Every version a lockfile changes counts too, transitive ones included.
  if (lockSemver !== null) semver = larger(semver, lockSemver);
  for (const v of locked) versions.set(`${v.name}@${v.version}`, v);
  if (versions.size > MAX_BUMPED_PACKAGES) throw new FactError(`more than ${MAX_BUMPED_PACKAGES} bumped packages`);
  // Dev only: bumped in devDependencies, and in no other section of any changed package.json, before or after,
  // and not bundled (a bundled package ships with the package); the same for every package a lockfile changes,
  // and no lockfile line showing one outside development. The other package.json files of the repository
  // are checked after this (listedOutsideDev), when this is still true.
  const names = new Set([...bumps.map((b) => b.name), ...lockNames]);
  const devOnly = bumps.every((b) => b.section === 'devDependencies') && !lockRuntime && sides.every((side) => !listedOutsideDev(side, names));
  return {
    facts: {
      applies: true,
      only_manifests: onlyManifests,
      // Version specs only, in manifests and lockfiles only.
      version_only: onlyManifests && onlySpecs,
      semver,
      dev_only: devOnly,
      registry_changed: registryChanged,
      manifest_lines: manifestLines,
    },
    // Only understood specs have a version to look up; any other makes semver "none" already.
    versions: [...versions.values()],
    devNames: [...names],
  };
}

/**
 * Whether a package.json lists one of `names` outside devDependencies (in
 * dependencies, optionalDependencies or peerDependencies, or bundled), or
 * cannot tell: a bundle list that is not a list of names.
 */
export function listedOutsideDev(manifest: Record<string, unknown>, names: Set<string>): boolean {
  for (const list of [manifest.bundleDependencies, manifest.bundledDependencies]) {
    if (list !== undefined && (!Array.isArray(list) || list.some((n) => typeof n !== 'string' || names.has(n)))) return true;
  }
  return DEPENDENCY_SECTIONS.filter((s) => s !== 'devDependencies').some((s) => {
    const section = manifest[s];
    if (section === undefined) return false;
    if (!isObject(section)) return true;
    return [...names].some((n) => Object.hasOwn(section, n));
  });
}

/**
 * Whether no package.json of the repository (their texts at the head) lists
 * one of `names` outside devDependencies. A text that is not a JSON object
 * cannot tell: false.
 */
export function devOnlyInRepository(texts: (string | null)[], names: Set<string>): boolean {
  return texts.every((text) => {
    if (text === null) return false;
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return false;
    }
    return isObject(v) && !listedOutsideDev(v, names);
  });
}

/** Whole days from a release to now; 0 for a release in the future (clocks differ). */
export function ageInDays(publishedMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - publishedMs) / 86_400_000));
}
