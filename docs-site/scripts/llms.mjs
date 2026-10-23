// /llms.txt and /llms-full.txt (https://llmstxt.org) for AI tools: an index
// of every English page with its one-line description, and the text of every
// English page in one file. Written from the synced pages (src/content/docs,
// see sync.mjs) when the site is put together, so they always match the site.
//
// Usage: node scripts/llms.mjs <output folder>   (after the docs build)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { BASE, GROUPS } from '../pages.mjs';

const SITE = 'https://pointsman.net';
const content = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'docs');

/** The English pages: slug, front matter and body, without the Japanese ones. */
export function englishPages(dir = content) {
  return readdirSync(dir, { recursive: true })
    .map((f) => String(f).split('\\').join('/'))
    .filter((f) => /\.mdx?$/.test(f) && !f.startsWith('ja/'))
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      if (!m) throw new Error(`${file}: no front matter`);
      const data = parse(m[1]);
      if (!data.title || !data.description) throw new Error(`${file}: title and description are needed for llms.txt`);
      const slug = file.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '');
      return { slug, url: `${SITE}${BASE}${slug}${slug ? '/' : ''}`, data, body: text.slice(m[0].length) };
    });
}

const order = (p) => p.data.sidebar?.order ?? 1000;
const planned = (p) => p.data.sidebar?.badge !== undefined;

/** Pages of a sidebar group, in sidebar order. */
const inGroup = (pages, dir) => pages
  .filter((p) => p.slug === dir || p.slug.startsWith(`${dir}/`))
  .sort((a, b) => order(a) - order(b) || a.data.title.localeCompare(b.data.title));

/** Markdown of a page for an AI tool: site links absolute, diagrams as their title, no comments. */
function plain(body) {
  return body
    .replace(/<!--[\s\S]*?-->\n?/g, '')
    .replace(/<svg[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/svg>/g, '(Diagram: $1)')
    .replace(/\]\(\//g, `](${SITE}/`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function llms(pages) {
  const start = pages.find((p) => p.slug === '');
  const lines = [
    '# Pointsman',
    '',
    `> ${start?.data.description ?? 'Documentation for Pointsman, the open-source decision service.'}`,
    '',
    'Pointsman is an open-source decision service (MIT License): systems send it a case, an AI model answers fixed questions, facts are looked up in data, and rules written by people turn both into an action, or a person checks the case. Every decision is logged. Source: https://github.com/geolonia/pointsman. This file lists the English documentation; Japanese pages are under /docs/ja/.',
  ];
  if (start) lines.push('', `- [${start.data.title}](${start.url}): the start page, with links to every topic`);
  for (const g of GROUPS) {
    const group = inGroup(pages, g.dir);
    if (!group.length) continue;
    lines.push('', `## ${g.dir === 'background' ? 'Optional' : g.en}`, '');
    for (const p of group) lines.push(`- [${p.data.title}](${p.url}): ${p.data.description}${planned(p) ? ' (planned; the page links what exists today)' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export function llmsFull(pages) {
  const parts = ['# Pointsman: every page of the documentation', '', `The text of every written English page of ${SITE}${BASE}, in sidebar order; planned pages, which only say what they will cover, are left out. Index: ${SITE}/llms.txt`];
  const start = pages.find((p) => p.slug === '');
  for (const p of [...(start ? [start] : []), ...GROUPS.flatMap((g) => inGroup(pages, g.dir))]) {
    if (planned(p)) continue;
    parts.push('', '---', '', `# ${p.data.title}`, '', `Source: ${p.url}`, '', plain(p.body));
  }
  return `${parts.join('\n')}\n`;
}

/** Writes both files into a folder. */
export function writeLlms(out, pages = englishPages()) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'llms.txt'), llms(pages));
  writeFileSync(join(out, 'llms-full.txt'), llmsFull(pages));
  return pages.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node scripts/llms.mjs <output folder>');
  console.log(`llms: llms.txt and llms-full.txt from ${writeLlms(out)} English pages`);
}

