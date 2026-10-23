// github_release (docs/profile-format.md#github-pull-requests): whether a
// pull request only moves a version, the way a release pull request does.
// Every changed file is a changelog that only gets lines added, or one of
// the listed version files, edited in place, where each changed line is the
// same line with one version replaced by a higher one, the same pair in
// every file. In version files that line must set a version (a key such as
// version, VERSION or ENGINE_VERSION), so a dependency, a URL or a minimum
// version that happens to move by the same pair does not count. Only in the
// listed text files (docs, comments) may any line carry the version.

import { matchesAny } from './glob';

/** A changed file as the pull-request files API lists it. */
export interface ReleaseFile {
  names: string[];
  status: string;
  /** The unified patch; null when GitHub gives none (binary, too large). */
  patch: string | null;
}

export interface ReleaseFacts {
  version_only: boolean;
  /** The version before and after; "" when version_only is false. */
  from: string;
  to: string;
  /** "major", "minor", "patch" or "none". */
  level: string;
}

const NOT: ReleaseFacts = { version_only: false, from: '', to: '', level: 'none' };
// Not inside a longer dotted number (an address such as 1.2.3.4) or a word.
const SEMVER = /(?<![0-9A-Za-z.-])(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4})?(?![0-9A-Za-z-]|\.[0-9A-Za-z])/g;
const MANIFEST_VERSION = /^\s*"version":\s*"[^"]*",?\s*$/;
/** A line that sets a version: the key version (any case), __version__, or a name ending in _VERSION, then : or =, then the version alone. */
const SETS_VERSION = /^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?["']?(?:version|VERSION|Version|__version__|[A-Za-z0-9_]*_VERSION)["']?\s*[:=]\s*["']?[0-9][0-9A-Za-z.-]*["']?\s*[,;]?\s*$/;

/** The changed lines of a patch: runs of removed lines and the added lines right after them, per hunk. */
function runs(patch: string): { removed: string[]; added: string[] }[] {
  const out: { removed: string[]; added: string[] }[] = [];
  let cur: { removed: string[]; added: string[] } | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('-')) {
      // A removed line after added ones starts a new run.
      if (!cur || cur.added.length > 0) out.push((cur = { removed: [], added: [] }));
      cur.removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      if (!cur) out.push((cur = { removed: [], added: [] }));
      cur.added.push(line.slice(1));
    } else {
      cur = null; // context or a hunk header
    }
  }
  return out;
}

/** The version pairs (from, to) that turn `before` into `after` when every `from` is replaced. */
function pairsOf(before: string, after: string): [string, string][] {
  if (before === after) return [];
  const olds = new Set([...before.matchAll(SEMVER)].map((m) => m[0]));
  const news = new Set([...after.matchAll(SEMVER)].map((m) => m[0]));
  const out: [string, string][] = [];
  for (const from of olds) {
    for (const to of news) {
      if (from !== to && before.split(from).join(to) === after) out.push([from, to]);
    }
  }
  return out;
}

const parse = (v: string) => v.match(/^(\d+)\.(\d+)\.(\d+)/)!.slice(1).map(Number) as [number, number, number];

/**
 * "major", "minor" or "patch" for a step up to a release; "none" when it is
 * not higher or goes to a pre-release (0.9.0-rc.1 → 0.9.0 is a patch step,
 * 0.9.0 → 0.9.0-rc.1 is none).
 */
export function levelOf(from: string, to: string): string {
  if (to.includes('-')) return 'none';
  const [a, b] = [parse(from), parse(to)];
  if (b[0] > a[0]) return 'major';
  if (b[0] < a[0]) return 'none';
  if (b[1] > a[1]) return 'minor';
  if (b[1] < a[1]) return 'none';
  if (b[2] > a[2]) return 'patch';
  if (b[2] < a[2]) return 'none';
  // Same numbers: from a pre-release to its release.
  return from.includes('-') ? 'patch' : 'none';
}

/**
 * versionFiles: where a line that sets the version may change; textFiles:
 * where any line may carry it (docs, comments); changelogs: files that may
 * only get lines added. All globs.
 */
export function releaseFacts(files: ReleaseFile[], changelogs: string[], versionFiles: string[], textFiles: string[] = []): ReleaseFacts {
  if (files.length === 0) return NOT;
  let pair: [string, string] | null = null;
  let versions = 0;
  let setters = 0;
  for (const f of files) {
    if (f.patch === null || f.names.length !== 1) return NOT;
    const name = f.names[0]!;
    const changelog = matchesAny(name, changelogs);
    const lines = runs(f.patch);
    if (changelog) {
      // A changelog may be new or edited, but only gets lines added.
      if ((f.status !== 'modified' && f.status !== 'added') || lines.some((r) => r.removed.length > 0)) return NOT;
      continue;
    }
    // A version file: edited in place, each line replaced by the same line with the new version.
    const text = matchesAny(name, textFiles);
    if (!(text || matchesAny(name, versionFiles)) || f.status !== 'modified' || lines.length === 0) return NOT;
    const manifest = name === 'package.json' || name.endsWith('/package.json');
    for (const r of lines) {
      if (r.removed.length === 0 || r.removed.length !== r.added.length) return NOT;
      for (let i = 0; i < r.removed.length; i++) {
        const sets = (line: string) => (manifest ? MANIFEST_VERSION : SETS_VERSION).test(line);
        const setter = sets(r.removed[i]!) && sets(r.added[i]!);
        if (!text && !setter) return NOT;
        if (setter) setters++;
        const found = pairsOf(r.removed[i]!, r.added[i]!);
        const fits = pair ? found.some(([a, b]) => a === pair![0] && b === pair![1]) : found.length === 1;
        if (!fits) return NOT;
        pair ??= found[0]!;
        versions++;
      }
    }
  }
  // At least one line that sets the version moved, not only text.
  if (!pair || versions === 0 || setters === 0) return NOT;
  const level = levelOf(pair[0], pair[1]);
  if (level === 'none') return NOT;
  return { version_only: true, from: pair[0], to: pair[1], level };
}
