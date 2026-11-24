// rebase_only (the CodeRabbit module): whether two commits make the same
// change, also after a rebase moved its lines. The pure parts; the
// snapshot's sameChange (snapshot.ts) reads the compares and uses them.

import { FactError } from '@pointsman/module-api';
import { isObject } from './github-http';

/**
 * A change as text that two changes can be compared by, like `git
 * patch-id`: per file its path, status, earlier name, and every line of its
 * patch (context, removed and added lines, in order, with a mark where each
 * hunk starts). The hunks' line numbers are kept, except in the files of
 * `loose`, which the base changed between the two changes (a rebase moves
 * the lines there): sameChange has checked the places there itself. Null when a file has no patch (binary, too large, or a rename
 * without changes).
 */
export function changeSignature(files: unknown[], loose: ReadonlySet<string> = new Set()): string | null {
  const out: { path: string; status: string | null; from: string | null; lines: string[] }[] = [];
  for (const f of files) {
    if (!isObject(f) || typeof f.filename !== 'string') throw new FactError('GitHub compare: unexpected answer');
    if (typeof f.patch !== 'string') return null;
    // "@@ -12,3 +14,4 @@ function name": in a loose file the numbers go, the mark (and the text after it) stays.
    const lines = loose.has(f.filename)
      ? f.patch.split('\n').map((line) => (line.startsWith('@@') ? line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, '@@') : line))
      : f.patch.split('\n');
    out.push({ path: f.filename, status: typeof f.status === 'string' ? f.status : null, from: typeof f.previous_filename === 'string' ? f.previous_filename : null, lines });
  }
  return JSON.stringify(out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** Each hunk's start and length on the old side of a patch ("@@ -start,length ..."), in order. */
export function hunkRanges(patch: string): { start: number; length: number }[] {
  const out: { start: number; length: number }[] = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) out.push({ start: Number(m[1]), length: m[2] === undefined ? 1 : Number(m[2]) });
  return out;
}

/**
 * Where lines `start`..`start + length - 1` of a file are after the base's
 * own change of that file (its patch from one merge base to the other); null
 * when the base changed any of them, so the place cannot be followed.
 */
export function movedStart(start: number, length: number, basePatch: string): number | null {
  const end = start + Math.max(length, 1) - 1;
  let offset = 0;
  for (const m of basePatch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) {
    const a = Number(m[1]);
    const removed = m[2] === undefined ? 1 : Number(m[2]);
    const added = m[3] === undefined ? 1 : Number(m[3]);
    if (removed === 0) {
      // Lines inserted after line a.
      if (a < start) offset += added;
      else if (a >= end) break;
      else return null;
    } else if (a + removed - 1 < start) offset += added - removed;
    else if (a > end) break;
    else return null;
  }
  return start + offset;
}
