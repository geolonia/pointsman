// Every page written for the site exists in English and in Japanese, with
// the same structure: the same heading levels in the same order, and the
// same code blocks. The text itself is written natively in each language,
// so it is not compared. The older files in pages.mjs (LEGACY) are English
// only for now and are not checked.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS } from '../pages.mjs';

// The repository; POINTSMAN_DOCS_REPO points the check at another one (for its tests).
const repo = process.env.POINTSMAN_DOCS_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir) {
  if (!existsSync(join(repo, dir))) return [];
  return readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((e) => {
    const path = posix.join(dir, e.name);
    return e.isDirectory() ? walk(path) : /\.mdx?$/.test(e.name) ? [path] : [];
  });
}

/** Heading levels and code blocks of a page, outside front matter. */
function shape(file) {
  const text = readFileSync(join(repo, file), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  const headings = [];
  const blocks = [];
  let block = null;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (block === null) block = [line.trim()];
      else { block.push(line.trim()); blocks.push(block.join('\n')); block = null; }
      continue;
    }
    if (block !== null) block.push(line);
    else if (/^#{1,6}\s/.test(line)) headings.push(/^#+/.exec(line)[0].length);
  }
  return { headings: headings.join(','), blocks };
}

const english = [...['docs/index.md', 'docs/index.mdx'].filter((f) => existsSync(join(repo, f))), ...GROUPS.flatMap((g) => walk(`docs/${g.dir}`))];
const japanese = new Set([...['docs/ja/index.md', 'docs/ja/index.mdx'].filter((f) => existsSync(join(repo, f))), ...GROUPS.flatMap((g) => walk(`docs/ja/${g.dir}`))]);
const errors = [];
for (const en of english) {
  const ja = en.replace(/^docs\//, 'docs/ja/');
  japanese.delete(ja);
  if (!existsSync(join(repo, ja))) { errors.push(`${en}: no Japanese version at ${ja}`); continue; }
  const a = shape(en);
  const b = shape(ja);
  if (a.headings !== b.headings) errors.push(`${ja}: headings differ from ${en} (levels ${b.headings || 'none'} vs ${a.headings || 'none'})`);
  if (a.blocks.length !== b.blocks.length) errors.push(`${ja}: ${b.blocks.length} code blocks, ${en} has ${a.blocks.length}`);
  else a.blocks.forEach((block, i) => { if (block !== b.blocks[i]) errors.push(`${ja}: code block ${i + 1} differs from ${en}`); });
}
for (const ja of japanese) errors.push(`${ja}: no English version`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`languages: ${english.length} pages in English and Japanese, same structure`);
