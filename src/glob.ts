// Path globs for GitHub path facts (docs/profile-format.md#github-pull-requests):
//
//   *    any characters except "/"
//   ?    one character except "/"
//   **   as a whole part of the path: any number of folders (also none);
//        at the end ("docs/**"): everything below, at least one more part
//
// A glob matches the whole path from the top of the repository: "*.md"
// matches README.md, not docs/a.md (use "**/*.md"). Files whose name
// starts with a dot match like any other file. Nothing else is special.
//
// No regular expressions: a pattern such as "a*a*a*b" would backtrack for
// a long time on a long name. Both matchers below take time in proportion
// to the pattern's length times the name's (or path's) length.

/** One part of a path (no "/") against one part of a glob with * and ?. */
function matchPart(glob: string, name: string): boolean {
  let g = 0;
  let n = 0;
  // Where the last * was, and the name position it covers up to.
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (g < glob.length && (glob[g] === '?' || (glob[g] !== '*' && glob[g] === name[n]))) {
      g++;
      n++;
    } else if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = n;
    } else if (star >= 0) {
      g = star + 1;
      n = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/** Splits a glob; a part of only stars ("**", "***") is "**", and "**" twice in a row is one. */
function globParts(glob: string): string[] {
  return glob.split('/').map((p) => (/^\*{2,}$/.test(p) ? '**' : p)).filter((p, i, all) => !(p === '**' && all[i - 1] === '**'));
}

export function matchGlob(glob: string, path: string): boolean {
  const gs = globParts(glob);
  const ps = path.split('/');
  // next[j]: the glob parts after the current one match the path parts from j. Filled from the end.
  let next: boolean[] = Array.from({ length: ps.length + 1 }, (_, j) => j === ps.length);
  for (let i = gs.length - 1; i >= 0; i--) {
    const cur: boolean[] = new Array<boolean>(ps.length + 1).fill(false);
    const g = gs[i]!;
    for (let j = ps.length; j >= 0; j--) {
      if (g === '**') {
        // At the end: at least one part. Otherwise: no part (next[j]) or one more (cur[j + 1]).
        cur[j] = i === gs.length - 1 ? j < ps.length : next[j]! || (j < ps.length && cur[j + 1]!);
      } else {
        cur[j] = j < ps.length && next[j + 1]! && matchPart(g, ps[j]!);
      }
    }
    next = cur;
  }
  return next[0]!;
}

export const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((g) => matchGlob(g, path));
