// github_release (docs/profile-format.md#github-releases): whether a pull
// request only moves a version, the way a release pull request does. Every
// changed line is either added to a changelog, or the same line with one
// version string replaced by another, the same pair in every file.

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
const SEMVER = /\b(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,50})?\b/g;

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

/** "major", "minor" or "patch" for a higher version (a pre-release counts as its numbers); "none" when it is not higher. */
export function levelOf(from: string, to: string): string {
  const [a, b] = [parse(from), parse(to)];
  if (b[0] > a[0]) return 'major';
  if (b[0] < a[0]) return 'none';
  if (b[1] > a[1]) return 'minor';
  if (b[1] < a[1]) return 'none';
  if (b[2] > a[2]) return 'patch';
  if (b[2] < a[2]) return 'none';
  // Same numbers: only a pre-release changed (0.9.0-rc.1 → 0.9.0).
  return from !== to ? 'patch' : 'none';
}

export function releaseFacts(files: ReleaseFile[], changelogs: string[]): ReleaseFacts {
  if (files.length === 0) return NOT;
  let pair: [string, string] | null = null;
  let versions = 0;
  for (const f of files) {
    if (f.patch === null) return NOT;
    const changelog = f.names.length === 1 && matchesAny(f.names[0]!, changelogs);
    const lines = runs(f.patch);
    if (changelog) {
      // A changelog may be new or edited, but only gets lines added.
      if ((f.status !== 'modified' && f.status !== 'added') || lines.some((r) => r.removed.length > 0)) return NOT;
      continue;
    }
    // Any other file: edited in place, each line replaced by the same line with the new version.
    if (f.status !== 'modified' || lines.length === 0) return NOT;
    for (const r of lines) {
      if (r.removed.length === 0 || r.removed.length !== r.added.length) return NOT;
      for (let i = 0; i < r.removed.length; i++) {
        const found = pairsOf(r.removed[i]!, r.added[i]!);
        const fits = pair ? found.some(([a, b]) => a === pair![0] && b === pair![1]) : found.length === 1;
        if (!fits) return NOT;
        pair ??= found[0]!;
        versions++;
      }
    }
  }
  if (!pair || versions === 0) return NOT;
  const level = levelOf(pair[0], pair[1]);
  if (level === 'none') return NOT;
  return { version_only: true, from: pair[0], to: pair[1], level };
}
