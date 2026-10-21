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
//
// Reading it is bounded, so a crafted file cannot burn CPU: at most
// MAX_CODEOWNERS_BYTES, patterns of at most MAX_PATTERN_LENGTH characters, and
// at most MAX_MATCH_STEPS steps of matching for one decision. Past any limit
// the file cannot be read safely: an error, never a guessed owner.

import { FactError } from './facts';
import { globParts, matchParts, MatchBudget } from './glob';

/** The largest CODEOWNERS file read, in bytes (GitHub itself ignores one over 3 MB). */
export const MAX_CODEOWNERS_BYTES = 128 * 1024;
/** The longest pattern read, in characters. */
export const MAX_PATTERN_LENGTH = 1024;
/** The most steps of matching all changed files against all patterns (see glob.ts). */
export const MAX_MATCH_STEPS = 50_000_000;

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

/** A line without its comment: "#" starts one, unless escaped ("\#" in a path). One pass, left to right. */
function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '#' && (i === 0 || line[i - 1] !== '\\')) return line.slice(0, i);
  }
  return line;
}

/** The rules of a CODEOWNERS file, in order. Throws FactError for a file it cannot read safely. */
export function parseCodeowners(text: string): OwnerRule[] {
  // More characters than the byte limit means more bytes too; the byte check itself is on the decoded file.
  if (text.length > MAX_CODEOWNERS_BYTES) throw new FactError(`CODEOWNERS: more than ${MAX_CODEOWNERS_BYTES} characters`);
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line === '') continue;
    if (line.includes('\\ ')) throw new FactError('CODEOWNERS: escaped spaces are not supported');
    const [pattern, ...owners] = line.split(/\s+/) as [string, ...string[]];
    if (pattern.length > MAX_PATTERN_LENGTH) throw new FactError(`CODEOWNERS: a pattern longer than ${MAX_PATTERN_LENGTH} characters`);
    if (pattern.startsWith('!') || /[[\]]/.test(pattern)) throw new FactError('CODEOWNERS: unsupported pattern');
    rules.push({ pattern: pattern.replace(/\\#/g, '#'), owners });
  }
  return rules;
}

/** A pattern as split globs: the path itself, or everything below it (null: not this way). */
interface Compiled {
  exact: string[] | null;
  below: string[] | null;
}

function compile(pattern: string): Compiled | true {
  let p = pattern;
  const folder = p.endsWith('/');
  if (folder) p = p.slice(0, -1);
  // A "/" at the start or in the middle ties the pattern to the top of the repository.
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  if (p === '') return true;
  const glob = anchored ? p : `**/${p}`;
  // A folder matches everything below it; "docs/*" matches only the files directly in docs/.
  const last = p.slice(p.lastIndexOf('/') + 1);
  return {
    exact: folder ? null : globParts(glob),
    below: folder || !last.includes('*') || last === '**' ? globParts(`${glob}/**`) : null,
  };
}

function matches(c: Compiled | true, parts: string[], budget?: MatchBudget): boolean {
  if (c === true) return true;
  return (c.exact !== null && matchParts(c.exact, parts, budget)) || (c.below !== null && matchParts(c.below, parts, budget));
}

/** Whether a CODEOWNERS pattern matches a file's path. */
export function codeownersMatch(pattern: string, path: string): boolean {
  return matches(compile(pattern), path.split('/'));
}

/**
 * The owners of a path, for many paths: those of the last rule that matches;
 * null when no rule matches. Throws FactError once matching took more than
 * `maxSteps` steps in all.
 */
export function ownerLookup(rules: OwnerRule[], maxSteps = MAX_MATCH_STEPS): (path: string) => string[] | null {
  const compiled = rules.map((r) => ({ c: compile(r.pattern), owners: r.owners }));
  const budget = new MatchBudget(maxSteps, () => new FactError('CODEOWNERS: too much work to match the changed files'));
  return (path) => {
    const parts = path.split('/');
    for (let i = compiled.length - 1; i >= 0; i--) {
      if (matches(compiled[i]!.c, parts, budget)) return compiled[i]!.owners;
    }
    return null;
  };
}
