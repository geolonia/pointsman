// /sitemap.xml for the pages written by hand in site/ (landing page, demos).
// The docs build writes its own sitemap under /docs/; robots.txt lists both.
// Every index.html in site/ is one page. A page under ja/ is the Japanese
// version of the page at the same path without ja/, and the two are linked
// with hreflang, as in the pages themselves.

import { readdirSync } from 'node:fs';

const SITE = 'https://pointsman.net';

/** The page paths of site/ ('/', '/ja/', '/demos/', ...), sorted. */
export function landingPaths(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => String(f).split('\\').join('/'))
    .filter((f) => f === 'index.html' || f.endsWith('/index.html'))
    .map((f) => `/${f.slice(0, -'index.html'.length)}`)
    .sort();
}

/** The sitemap XML for the pages of site/. */
export function landingSitemap(dir) {
  const paths = landingPaths(dir);
  const has = new Set(paths);
  const enOf = (p) => (p.startsWith('/ja/') ? p.slice(3) : p);
  const jaOf = (p) => (p.startsWith('/ja/') ? p : `/ja${p}`);
  const urls = paths.map((p) => {
    const en = enOf(p);
    const ja = jaOf(p);
    const alternates = has.has(en) && has.has(ja)
      ? [['en', en], ['ja', ja], ['x-default', en]]
        .map(([lang, href]) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${SITE}${href}"/>`).join('')
      : '';
    return `<url><loc>${SITE}${p}</loc>${alternates}</url>`;
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    + urls.join('\n') + '\n</urlset>\n';
}
