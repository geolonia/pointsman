// CODEOWNERS (GitHub's format) for the github_pr field author_sole_code_owner:
// who owns a path. Each line is a pattern and its owners (@user, @org/team or
// an email address); the last line that matches a path wins, and a line
// without owners means the path has no owner. Patterns follow GitHub's rules:
//
//   *.js        a name anywhere (no "/" in the pattern)
//   /build/     a folder from the top, and everything below it
//   apps/       a folder anywhere, and everything below it
//   docs/*      the files directly in docs/, not deeper
//   **/logs     logs anywhere, and everything below it
//
// GitHub does not support "!" (negation) or "[ ]" in CODEOWNERS; a file that
// uses them, or escaped spaces, cannot be read safely, so it is an error.

import { FactError } from './facts';
import { matchGlob } from './glob';

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

/** The rules of a CODEOWNERS file, in order. Throws FactError for lines it cannot read safely. */
export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // "#" starts a comment, unless escaped ("\#" in a path).
    const line = raw.replace(/(^|[^\\])#.*$/, '$1').trim();
    if (line === '') continue;
    if (line.includes('\\ ')) throw new FactError('CODEOWNERS: escaped spaces are not supported');
    const [pattern, ...owners] = line.split(/\s+/) as [string, ...string[]];
    if (pattern.startsWith('!') || /[[\]]/.test(pattern)) throw new FactError('CODEOWNERS: unsupported pattern');
    rules.push({ pattern: pattern.replace(/\\#/g, '#'), owners });
  }
  return rules;
}

/** Whether a CODEOWNERS pattern matches a file's path. */
export function codeownersMatch(pattern: string, path: string): boolean {
  let p = pattern;
  const folder = p.endsWith('/');
  if (folder) p = p.slice(0, -1);
  // A "/" at the start or in the middle ties the pattern to the top of the repository.
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  if (p === '') return true;
  const glob = anchored ? p : `**/${p}`;
  if (matchGlob(glob, path) && !folder) return true;
  // A folder matches everything below it; "docs/*" matches only the files directly in docs/.
  const last = p.slice(p.lastIndexOf('/') + 1);
  return (folder || !last.includes('*') || last === '**') && matchGlob(`${glob}/**`, path);
}

/** The owners of a path: those of the last rule that matches; null when no rule matches. */
export function ownersOf(rules: OwnerRule[], path: string): string[] | null {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (codeownersMatch(rules[i]!.pattern, path)) return rules[i]!.owners;
  }
  return null;
}
