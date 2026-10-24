// Lists the English changes since each Japanese translation of an older page
// was last brought up to date (its front matter's translatedFrom commit),
// leaving out commits that changed the translation as well. That is a hint,
// not a proof: a commit that changes both counts as translated, even when its
// Japanese change was unrelated, so a pull request that touches both
// languages still needs a look at its English diff.
// It does not fail: a change to the English wording should reach the
// Japanese page soon, but need not block a pull request. A change to the
// structure (a section, a table row, a code block) fails check-languages.mjs.
//
// Usage: node docs-site/scripts/translation-status.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY } from '../pages.mjs';

// The repository; POINTSMAN_DOCS_REPO points the script at another one (for its tests).
const repo = process.env.POINTSMAN_DOCS_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let behind = 0;
for (const [en, { slug }] of Object.entries(LEGACY)) {
  const ja = ['.md', '.mdx'].map((ext) => `docs/ja/${slug}${ext}`).find((f) => existsSync(join(repo, f)));
  if (!ja) { console.log(`${en}: no Japanese translation`); continue; }
  const from = /^translatedFrom: ([0-9a-f]{7,40})$/m.exec(readFileSync(join(repo, ja), 'utf8'))?.[1];
  if (!from) { console.log(`${ja}: missing translatedFrom in the front matter`); continue; }
  let log;
  try {
    // A commit that changes the translation too brought it up to date with
    // that change, so only commits that change the English page alone count.
    // (A squash merge gives the pull request's commit a new id, so
    // translatedFrom cannot name it.) --full-history --simplify-merges, so
    // that a merge commit is listed for both files alike, and only when it
    // changes them.
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const both = new Set(git(['log', '--full-history', '--simplify-merges', '--format=%H', `${from}..HEAD`, '--', ja]).split('\n').filter(Boolean));
    log = git(['log', '--full-history', '--simplify-merges', '--format=%H %h %s', `${from}..HEAD`, '--', en]).split('\n').filter(Boolean)
      .filter((line) => !both.has(line.slice(0, line.indexOf(' '))))
      .map((line) => line.slice(line.indexOf(' ') + 1)).join('\n');
  } catch (error) {
    // For example an unknown commit, or a shallow clone without it.
    console.log(`${ja}: cannot read the history of ${en} since ${from}: ${error.stderr?.trim() || error.message}`);
    continue;
  }
  if (!log) { console.log(`${ja}: up to date with ${en}`); continue; }
  behind++;
  console.log(`${ja}: ${en} changed since ${from}:\n${log.replace(/^/gm, '  ')}`);
}
if (behind) console.log(`\n${behind} translation(s) behind: update them, then set translatedFrom to the newest commit above (or let a commit change both languages).`);
