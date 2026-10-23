// github_bump, lockfiles (docs/profile-format.md#github-pull-requests): the
// version steps a lockfile's patch makes, and whether it shows a changed
// package outside development. Only the patch is read, never the whole
// lockfile, so a line is placed by the lines the patch shows around it (the
// keys above it, and the section GitHub names in each hunk header).
//
// Each changed version is put in a bucket: one package at one place (a
// pnpm-lock.yaml package key by name, a dependency of an importer or of a
// package, a package-lock.json entry by path). In a bucket, the removed
// version and the added one make a pair, and the pair's step counts for
// semver. Anything else is the strictest step, "none": a package added or
// removed (a key or an entry on one side only), more than one version on a
// side (not paired without doubt), a downgrade or another step stepOf does
// not name, a version that is not a pinned one, or a version line whose
// place the patch does not show. A dependency of an importer or a package
// added or removed is no step (the package itself is a key or an entry).

import { larger as largerStep, stepOf } from './bump';

export interface LockfileSteps {
  /** The largest step: "major", "minor", "patch" or "none"; null when no version changes. */
  semver: string | null;
  /** The names of the packages whose versions the patch changes, adds or removes. */
  names: string[];
  /**
   * Whether the patch may change a package used outside development: a
   * changed package-lock.json entry or pnpm-lock.yaml v6 package without
   * its dev mark on the new side, a changed dependency of an importer
   * outside devDependencies, or a change whose place is not shown.
   * pnpm-lock.yaml v9 has no dev marks: its packages count as not shown
   * outside development (docs: the limit of dev_only).
   */
  runtime: boolean;
}

/** A version as a lockfile pins it: no range, no alias. */
const PINNED = /^\d{1,10}\.\d{1,10}\.\d{1,10}(?:-[0-9A-Za-z.-]{1,60})?$/;
/** A pnpm-lock.yaml package key: name@version, peers in parentheses; a leading "/" in v6. */
const PNPM_KEY = /^'?(\/?)((?:@[^@/'\s]+\/)?[^@/'\s]+)@([^'(:\s]+)(?:\(.*\))?'?$/;
/** Sections of a pnpm-lock.yaml whose changes say nothing about versions. */
const PNPM_QUIET = new Set(['time']);
/** Sections of a pnpm-lock.yaml v5/v6 single project, as importers. */
const PNPM_DEPENDENCY_SECTIONS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);

const base = (name: string) => name.slice(name.lastIndexOf('/') + 1);

class Buckets {
  private readonly all = new Map<string, { name: string; package: boolean; sides: [Set<string>, Set<string>] }>();
  /** A version line whose place or version is not understood. */
  unknown = false;

  /** A version on one side (0 before, 1 after); `pkg` for a package key or entry, not a dependency of something. */
  add(key: string, name: string, pkg: boolean, side: 0 | 1, version: string): void {
    if (!PINNED.test(version)) {
      this.unknown = true;
      return;
    }
    let b = this.all.get(key);
    if (!b) this.all.set(key, b = { name, package: pkg, sides: [new Set(), new Set()] });
    b.sides[side].add(version);
  }

  /** The largest step over every bucket; `pool` pairs packages that moved place (package-lock.json). */
  result(pool: boolean): { semver: string | null; names: string[] } {
    let semver: string | null = this.unknown ? 'none' : null;
    const names = new Set<string>();
    const step = (from: Set<string>, to: Set<string>, pkg: boolean): void => {
      if (from.size === 0 && to.size === 0) return;
      // A dependency added or removed: no step. A package added or removed: none.
      if (from.size === 0 || to.size === 0) {
        if (pkg) semver = 'none';
        return;
      }
      if (from.size > 1 || to.size > 1) {
        semver = 'none';
        return;
      }
      const [a] = from;
      const [b] = to;
      if (a === b) return;
      semver = larger(semver, stepOf(a!, b!));
    };
    const moved = new Map<string, [Set<string>, Set<string>]>();
    for (const b of this.all.values()) {
      names.add(b.name);
      const [from, to] = b.sides;
      if (pool && b.package && (from.size === 0) !== (to.size === 0)) {
        // An entry at one place only: paired by name with the others, below.
        let m = moved.get(b.name);
        if (!m) moved.set(b.name, m = [new Set(), new Set()]);
        for (const v of from) m[0].add(v);
        for (const v of to) m[1].add(v);
        continue;
      }
      step(from, to, b.package);
    }
    for (const [from, to] of moved.values()) step(from, to, true);
    return { semver, names: [...names] };
  }
}

/** The larger of two steps; "none" wins; null is no step yet. */
const larger = (a: string | null, b: string): string => (a === null ? b : largerStep(a, b));

/** A pnpm-lock.yaml line as key and value; null when it is not one (a list item, a flow line). */
function yamlKey(body: string): { key: string; value: string | null } | null {
  let key: string;
  let rest: string;
  if (body.startsWith("'")) {
    const end = body.indexOf("'", 1);
    if (end < 0 || body[end + 1] !== ':') return null;
    key = body.slice(0, end + 1);
    rest = body.slice(end + 2);
  } else {
    const m = /^([^\s'"#-][^:]*?|-[^\s:][^:]*?):(?=\s|$)(.*)$/.exec(body);
    if (!m) return null;
    key = m[1]!;
    rest = m[2]!;
  }
  const value = rest.trim();
  return { key, value: value === '' ? null : value };
}

const unquote = (s: string) => (s.length >= 2 && (s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0] ? s.slice(1, -1) : s);
/** A pnpm version without its peers in parentheses. */
function withoutPeers(v: string): string {
  let out = unquote(v);
  while (/\([^()]*\)/.test(out)) out = out.replace(/\([^()]*\)/g, '');
  return out;
}

/** The lines of each hunk, with the section its header names (git's function context). */
function hunks(patch: string): { section: string | undefined; lines: string[] }[] {
  const out: { section: string | undefined; lines: string[] }[] = [];
  for (const line of patch.split('\n')) {
    const h = /^@@ [^@]* @@ ?(.*)$/.exec(line);
    if (h) {
      const s = /^([A-Za-z][\w-]*):\s*$/.exec(h[1]!);
      out.push({ section: s ? s[1] : undefined, lines: [] });
    } else if (out.length > 0) {
      out[out.length - 1]!.lines.push(line);
    }
  }
  return out;
}

/** The sides a patch line is on: context on both, "-" before, "+" after; null for anything else. */
function sidesOf(mark: string | undefined): (0 | 1)[] | null {
  if (mark === ' ' || mark === undefined) return [0, 1];
  if (mark === '-') return [0];
  if (mark === '+') return [1];
  return null;
}

/** pnpm-lock.yaml (v9, v6; v5 package keys are not understood, see lockfileChanges). */
function pnpmSteps(patch: string): LockfileSteps {
  const buckets = new Buckets();
  let runtime = false;
  // v6 package keys start with "/"; v9 keys do not.
  let v6 = false;
  let v9 = false;
  /** Package blocks with a change; keys removed and added; blocks with "dev: true" after. */
  const changed = new Set<string>();
  const removed = new Set<string>();
  const added = new Set<string>();
  const dev = new Set<string>();
  /** Packages whose dependency lines change. */
  const consumers = new Set<string>();
  /** A changed line in a package block whose key the patch does not show. */
  let unplaced = false;
  for (const hunk of hunks(patch)) {
    // The keys above the current line, by depth, on each side.
    const paths: (string | undefined)[][] = [[hunk.section], [hunk.section]];
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;
      const mark = line[0];
      const sides = sidesOf(mark);
      const isChange = mark === '-' || mark === '+';
      if (!sides) {
        buckets.unknown = true;
        runtime = true;
        continue;
      }
      const text = line.slice(1);
      const body = text.trimStart();
      if (body === '' || body.startsWith('#')) continue;
      const indent = text.length - body.length;
      // A list item (transitivePeerDependencies, cpu, os): no key.
      if (body.startsWith('- ') || body === '-') continue;
      const kv = yamlKey(body);
      if (indent % 2 !== 0 || !kv) {
        // Not understood: its place is not known, nor that of the lines after it.
        for (const s of sides) paths[s] = [];
        if (isChange) {
          buckets.unknown = true;
          runtime = true;
        }
        continue;
      }
      const level = indent / 2;
      for (const s of sides) {
        const p = paths[s]!;
        p.length = level;
        p[level] = kv.key;
      }
      const after = paths[1]!;
      if (level === 1 && (after[0] === 'packages' || after[0] === 'snapshots' || paths[0]![0] === 'packages' || paths[0]![0] === 'snapshots')) {
        const style = PNPM_KEY.exec(kv.key);
        if (style && style[1] === '/') v6 = true;
        else if (style) v9 = true;
      }
      if (after[0] === 'snapshots') v9 = true;
      // v6: "dev: true" in a package block, on the new side.
      if (mark !== '-' && after[0] === 'packages' && level === 2 && kv.key === 'dev' && kv.value === 'true' && after[1] !== undefined) dev.add(after[1]);
      if (!isChange) continue;
      const side = sides[0]!;
      const p = paths[side]!;
      const section = p[0];
      if (section === undefined) {
        buckets.unknown = true;
        runtime = true;
        continue;
      }
      if (section === 'importers') {
        if (level === 4 && kv.key === 'version') {
          if (p[3] === undefined) {
            buckets.unknown = true;
            runtime = true;
          } else {
            // The importer and its section may be above the hunk: pooled by name ("?"), so two moves of one name are not paired.
            // A section not shown is left to the package.json check (an importer is its package.json's dependencies).
            const name = unquote(p[3]);
            buckets.add(`importer|${p[1] ?? '?'}|${p[2] ?? '?'}|${name}`, name, false, side, withoutPeers(kv.value ?? ''));
            if (p[2] !== undefined && p[2] !== 'devDependencies') runtime = true;
          }
        }
        continue;
      }
      if (PNPM_DEPENDENCY_SECTIONS.has(section) && level === 0) {
        // v5/v6 single project: a whole section changed.
        buckets.unknown = true;
        runtime = true;
        continue;
      }
      if (PNPM_DEPENDENCY_SECTIONS.has(section)) {
        // v6 single project: section > name > version; v5: section > name: version.
        const name = p[1] === undefined ? undefined : unquote(p[1]);
        const version = level === 2 && kv.key === 'version' ? kv.value : level === 1 ? kv.value : undefined;
        if (version === undefined || version === null) continue;
        if (name === undefined) {
          buckets.unknown = true;
          runtime = true;
          continue;
        }
        buckets.add(`importer|.|${section}|${name}`, name, false, side, withoutPeers(version));
        if (section !== 'devDependencies') runtime = true;
        continue;
      }
      if (section === 'catalogs') {
        if (level === 3 && kv.key === 'version') {
          if (p[1] === undefined || p[2] === undefined) buckets.unknown = true;
          else buckets.add(`catalog|${p[1]}|${unquote(p[2])}`, unquote(p[2]), false, side, withoutPeers(kv.value ?? ''));
        }
        continue;
      }
      if (section === 'packages' || section === 'snapshots') {
        if (level === 0) {
          buckets.unknown = true;
          continue;
        }
        const block = p[1];
        const key = block === undefined ? null : PNPM_KEY.exec(block);
        if (block === undefined) unplaced = true;
        else changed.add(block);
        if (level === 1) {
          if (!key) {
            buckets.unknown = true;
            continue;
          }
          (side === 0 ? removed : added).add(block!);
          buckets.add(`${section}|${key[2]}`, key[2]!, true, side, key[3]!);
          continue;
        }
        if (level === 2 && kv.key === 'version') {
          // A version field beside the key (a tarball or repository package): not a step this reads.
          buckets.unknown = true;
          runtime = true;
          continue;
        }
        if (level === 3 && kv.value !== null) {
          const list = p[2];
          const version = withoutPeers(kv.value);
          // A dependency of a package; peerDependencies are ranges, not versions.
          if (list === 'dependencies' || list === 'optionalDependencies' || (list === undefined && PINNED.test(version))) {
            const name = unquote(kv.key);
            buckets.add(`${section}|${key ? key[2] : '?'}|${name}`, name, false, side, version);
            // The package that now uses another version is changed too: the package.json check sees it when it is a direct dependency.
            if (key) consumers.add(key[2]!);
            else runtime = true;
          }
        }
        continue;
      }
      if (PNPM_QUIET.has(section)) continue;
      // Another section (lockfileVersion, settings, overrides, patchedDependencies): not understood.
      buckets.unknown = true;
      runtime = true;
    }
  }
  // Dev marks: lockfile v6 only. A changed package must show "dev: true" after, unless it is gone.
  // v9 has none, so its packages are not checked (only a v9 key, never a v6 one, seen).
  const onlyV9 = v9 && !v6;
  for (const block of changed) {
    if (removed.has(block) && !added.has(block)) continue;
    const key = PNPM_KEY.exec(block);
    if (key && key[1] === '' && onlyV9) continue;
    if (!dev.has(block)) runtime = true;
  }
  if (unplaced) runtime = true;
  const { semver, names } = buckets.result(false);
  return { semver, names: [...new Set([...names, ...consumers])], runtime };
}

/** A package-lock.json entry key ("node_modules/<name>", maybe nested), four spaces deep. */
const LOCK_ENTRY = /^ {4}"([^"]*)":\s*\{/;
/** The package an entry path installs; null for the root ("") and workspace folders. */
function entryName(path: string): string | null {
  const at = path.lastIndexOf('node_modules/');
  if (at < 0 || (at > 0 && path[at - 1] !== '/')) return null;
  const name = path.slice(at + 'node_modules/'.length);
  return /^(?:@[^/]+\/)?[^/@]+$/.test(name) ? name : null;
}

/** package-lock.json (lockfile v2 and v3, the "packages" object). */
function npmSteps(patch: string): LockfileSteps {
  const buckets = new Buckets();
  let runtime = false;
  const changed = new Set<string>();
  const removed = new Set<string>();
  const added = new Set<string>();
  const dev = new Set<string>();
  for (const hunk of hunks(patch)) {
    // The entry each side is in: undefined before the patch shows one, null outside an entry.
    const entry: (string | null | undefined)[] = [undefined, undefined];
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;
      const mark = line[0];
      const sides = sidesOf(mark);
      if (!sides) {
        buckets.unknown = true;
        runtime = true;
        continue;
      }
      const text = line.slice(1);
      const isChange = mark === '-' || mark === '+';
      const key = LOCK_ENTRY.exec(text);
      if (key) {
        for (const s of sides) entry[s] = key[1]!;
        if (mark === '-') removed.add(key[1]!);
        if (mark === '+') added.add(key[1]!);
      } else if (/^ {0,2}\S/.test(text)) {
        // A top-level key or the end of an object: outside an entry.
        for (const s of sides) entry[s] = null;
        if (isChange && /^ {2}"lockfileVersion"/.test(text)) buckets.unknown = true;
      }
      if (mark !== '-' && entry[1] && /^ {6}"dev":\s*true,?\s*$/.test(text)) dev.add(entry[1]);
      if (!isChange) continue;
      const side = sides[0]!;
      const at = entry[side];
      if (at === undefined) {
        runtime = true;
        if (/^ {6}"version":/.test(text)) buckets.unknown = true;
        continue;
      }
      if (at === null) continue;
      const name = entryName(at);
      if (name !== null) changed.add(at);
      const version = /^ {6}"version":\s*"([^"]*)"/.exec(text);
      if (!version) continue;
      // The root's or a workspace's own version: not a dependency bump.
      if (name === null) buckets.unknown = true;
      else buckets.add(`entry|${at}`, name, true, side, version[1]!);
    }
  }
  for (const at of changed) {
    if (removed.has(at) && !added.has(at)) continue;
    if (!dev.has(at)) runtime = true;
  }
  const { semver, names } = buckets.result(true);
  return { semver, names, runtime };
}

/** The steps of a lockfile's patch (pnpm-lock.yaml or package-lock.json). */
export function lockfileSteps(file: string, patch: string): LockfileSteps {
  return base(file) === 'pnpm-lock.yaml' ? pnpmSteps(patch) : npmSteps(patch);
}
