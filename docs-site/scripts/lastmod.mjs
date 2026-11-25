// <lastmod> for the sitemaps: the date of the last commit that changed each
// page's source file, from git.
//
// A shallow clone (GitHub Actions checks out one commit by default) knows only
// its last commit, so every page would get that date. The full history is then
// fetched first; when that fails, or the folder is not a git repository, the
// sitemaps get no dates at all: no date is better than a wrong one. The fetch
// changes the clone (it is no longer shallow); a full clone is not touched.
//
// The date is the committer date, when the change landed. A moved file counts
// as changed (--no-renames), so it gets the date of the move.

import { execFileSync } from 'node:child_process';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
});

/** Repository path → ISO 8601 date of the last commit that changed it, for the files under `dirs`. Empty when git cannot tell. */
export function gitDates(repo, dirs) {
  const shallow = () => git(repo, 'rev-parse', '--is-shallow-repository').trim() === 'true';
  try {
    if (shallow()) git(repo, 'fetch', '--quiet', '--unshallow');
    // With no remote, the fetch succeeds and the clone stays shallow.
    if (shallow()) throw new Error('the clone is shallow and fetching its history did not work');
  } catch (e) {
    console.warn(`sitemaps: no <lastmod>, git has no full history here (${String(e.stderr || e.message).trim().split('\n')[0]})`);
    return new Map();
  }
  const dates = new Map();
  // -z: file names as they are (not quoted, also non-ASCII ones). A merge
  // lists the files it changed itself (a resolved conflict), not those it
  // only took from one side. Each date is marked "@@"; every file name
  // starts with one of `dirs`. Newest first: the first date seen for a
  // file is its last change.
  const log = git(repo, 'log', '-z', '--format=@@%cI', '--name-only', '--no-renames', '--diff-merges=dense-combined', 'HEAD', '--', ...dirs);
  let date;
  for (const token of log.split('\0')) {
    const t = token.replace(/^\n/, '');
    if (t.startsWith('@@')) date = t.slice(2);
    else if (t && date && !dates.has(t)) dates.set(t, date);
  }
  return dates;
}

/** The sitemap XML with a <lastmod> after each <loc> whose URL `dateOf` has a date for. */
export function addLastmod(xml, dateOf) {
  return xml.replace(/<loc>([^<]+)<\/loc>(?!<lastmod>)/g, (m, loc) => {
    // One pass, so "&amp;apos;" stays "&apos;".
    const date = dateOf(loc.replace(/&(amp|apos);/g, (_, e) => (e === 'amp' ? '&' : "'")));
    return date ? `${m}<lastmod>${date}</lastmod>` : m;
  });
}
