// Puts the website together in _site/ (at the repository root), as
// docs-site/wrangler.jsonc serves it on https://pointsman.net:
// the landing page (site/) at the root, the built docs (dist/) under /docs/,
// the docs' 404 page for every missing path, /sitemap.xml for the pages of
// site/ (landing-sitemap.mjs), and /llms.txt and /llms-full.txt for AI tools
// (llms.mjs). Run after the docs build.

import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landingSitemap } from './landing-sitemap.mjs';
import { writeLlms } from './llms.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(siteDir, '..');
const dist = join(siteDir, 'dist');
const out = join(repo, '_site');

if (!existsSync(join(dist, '404.html'))) throw new Error('docs-site/dist has no 404.html: run the docs build first');
if (existsSync(join(repo, 'site', 'docs')) || existsSync(join(repo, 'site', '404.html'))) {
  throw new Error('site/ must not have docs/ or 404.html: they come from the docs build');
}
rmSync(out, { recursive: true, force: true });
cpSync(join(repo, 'site'), out, { recursive: true });
cpSync(dist, join(out, 'docs'), { recursive: true });
cpSync(join(dist, '404.html'), join(out, '404.html'));
writeFileSync(join(out, 'sitemap.xml'), landingSitemap(join(repo, 'site')));
const pages = writeLlms(out);
console.log(`site: _site/ put together (landing page, /docs/, 404 page, sitemap.xml, llms.txt from ${pages} pages)`);
