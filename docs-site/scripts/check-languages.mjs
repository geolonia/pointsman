// Every page written for the site exists in English and in Japanese, with
// the same structure: the same heading levels in the same order, and the
// same code blocks. The text itself is written natively in each language,
// so it is not compared.
//
// The older English files in pages.mjs (LEGACY) can have a Japanese
// translation at docs/ja/<slug>.md. Such a pair must also keep every
// section's id (`## 見出し {#id}`, the English heading's id) and the number of
// table rows, so that links to `profile-format.md#facts` work in both
// languages and a section added in English cannot be missed. The commit the
// translation follows is in its front matter (`translatedFrom`);
// translation-status.mjs lists English changes since then.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, LEGACY } from '../pages.mjs';

// The repository; POINTSMAN_DOCS_REPO points the check at another one (for its tests).
const repo = process.env.POINTSMAN_DOCS_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir) {
  if (!existsSync(join(repo, dir))) return [];
  return readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((e) => {
    const path = posix.join(dir, e.name);
    return e.isDirectory() ? walk(path) : /\.mdx?$/.test(e.name) ? [path] : [];
  });
}

/** The id a heading gets: `{#id}` when given, else GitHub's slug of its text. */
function headingId(text, seen) {
  const fixed = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/.exec(text);
  if (fixed) return fixed[1];
  const base = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
  let id = base;
  for (let n = 1; seen.has(id); n++) id = `${base}-${n}`;
  seen.add(id);
  return id;
}

/** Heading levels and ids, code blocks and table rows of a page, outside front matter. */
function shape(text, { dropTitle = false } = {}) {
  let body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  if (dropTitle) body = body.replace(/^\s*# .+\n/, '');
  const headings = [];
  const ids = [];
  const blocks = [];
  const seen = new Set();
  let rows = 0;
  let block = null;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (block === null) block = [line.trim()];
      else { block.push(line.trim()); blocks.push(block.join('\n')); block = null; }
      continue;
    }
    if (block !== null) block.push(line);
    else if (/^#{1,6}\s/.test(line)) {
      const m = /^(#+)\s+(.*)$/.exec(line);
      headings.push(m[1].length);
      ids.push(headingId(m[2], seen));
    } else if (/^\s*\|/.test(line)) rows++;
  }
  return { headings: headings.join(','), ids, blocks, rows };
}
const read = (file) => readFileSync(join(repo, file), 'utf8');

const english = [...['docs/index.md', 'docs/index.mdx'].filter((f) => existsSync(join(repo, f))), ...GROUPS.flatMap((g) => walk(`docs/${g.dir}`))];
const japanese = new Set([...['docs/ja/index.md', 'docs/ja/index.mdx'].filter((f) => existsSync(join(repo, f))), ...GROUPS.flatMap((g) => walk(`docs/ja/${g.dir}`))]);
const errors = [];
function compare(en, ja, a, b, legacy) {
  if (a.headings !== b.headings) errors.push(`${ja}: headings differ from ${en} (levels ${b.headings || 'none'} vs ${a.headings || 'none'})`);
  else if (legacy) a.ids.forEach((id, i) => { if (b.ids[i] !== id) errors.push(`${ja}: heading ${i + 1} has the id "${b.ids[i]}", ${en} has "${id}"; add {#${id}}`); });
  if (legacy && a.rows !== b.rows) errors.push(`${ja}: ${b.rows} table rows, ${en} has ${a.rows}`);
  if (a.blocks.length !== b.blocks.length) errors.push(`${ja}: ${b.blocks.length} code blocks, ${en} has ${a.blocks.length}`);
  else a.blocks.forEach((block, i) => { if (block !== b.blocks[i]) errors.push(`${ja}: code block ${i + 1} differs from ${en}`); });
}
for (const en of english) {
  const ja = en.replace(/^docs\//, 'docs/ja/');
  japanese.delete(ja);
  if (!existsSync(join(repo, ja))) { errors.push(`${en}: no Japanese version at ${ja}`); continue; }
  compare(en, ja, shape(read(en)), shape(read(ja)), false);
}
let translated = 0;
for (const [en, { slug }] of Object.entries(LEGACY)) {
  const ja = ['.md', '.mdx'].map((ext) => `docs/ja/${slug}${ext}`).find((f) => existsSync(join(repo, f)));
  if (!ja) continue;
  japanese.delete(ja);
  translated++;
  if (!/^translatedFrom: [0-9a-f]{7,40}$/m.test(read(ja).split('\n---\n')[0])) errors.push(`${ja}: front matter needs translatedFrom: <commit of ${en} it follows>`);
  compare(en, ja, shape(read(en), { dropTitle: true }), shape(read(ja)), true);
}
for (const ja of japanese) errors.push(`${ja}: no English version`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`languages: ${english.length} pages and ${translated} translated older pages in English and Japanese, same structure`);
