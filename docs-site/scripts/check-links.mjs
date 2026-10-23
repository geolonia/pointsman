// Checks every internal link of the built site (dist/): the page exists and,
// for a link with #anchor, the page has an element with that id. Links to
// the landing page (outside /docs/) are checked against site/.
// External links are not fetched.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from '../pages.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(siteDir, 'dist');
const landing = join(siteDir, '..', 'site');

const html = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.html'))
  .map((e) => join(e.parentPath, e.name));

const ids = new Map();
function idsOf(file) {
  if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(file);
}

/** The file a site path is served from, or undefined. */
function fileFor(path) {
  const [root, rest] = path.startsWith(BASE) ? [dist, path.slice(BASE.length)] : [landing, path.slice(1)];
  const file = join(root, decodeURIComponent(rest));
  for (const candidate of [file, join(file, 'index.html')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const errors = [];
let checked = 0;
for (const page of html(dist)) {
  const text = readFileSync(page, 'utf8');
  const here = BASE + page.slice(dist.length + 1).split('\\').join('/');
  for (const [, , url] of text.matchAll(/\s(?:href|src)=(["'])(.+?)\1/g)) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
    const resolved = new URL(url.replaceAll('&amp;', '&'), `https://x${here}`);
    checked++;
    const file = fileFor(resolved.pathname);
    if (!file) {
      errors.push(`${here}: ${url} does not exist`);
      continue;
    }
    const anchor = decodeURIComponent(resolved.hash.slice(1));
    if (anchor && file.startsWith(dist) && file.endsWith('.html') && !idsOf(file).has(anchor)) {
      errors.push(`${here}: ${url} has no #${anchor}`);
    }
  }
}

if (errors.length) {
  console.error([...new Set(errors)].join('\n'));
  console.error(`\n${errors.length} broken link(s)`);
  process.exit(1);
}
console.log(`links: ${checked} internal links on ${html(dist).length} pages, none broken`);
