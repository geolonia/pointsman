// The Markdown version of every page, for AI tools and the "Copy page" menu:
// /docs/how-to/deploy/ → /docs/how-to/deploy.md (markdownPath in pages.mjs).
// Written from the synced pages (src/content/docs, see sync.mjs) into the
// built docs (dist/), next to each page, after the Astro build.
//
// - The title, the description and the page's URL come first.
// - Links become absolute URLs, so they work wherever the text is pasted.
// - Diagrams (<svg>) become their description; <details> becomes a bold
//   line and its content; author comments, scripts and styles are left out.
// - Code blocks are never changed.
// - A Japanese page without a translation gets the English text with a note,
//   as the site shows it.
//
// The build fails if a page has no Markdown version, if its <head> does not
// link it (src/route-data.ts), or if a page uses HTML or an MDX component
// this converter does not know.
//
// Usage: node scripts/page-markdown.mjs   (after astro build)

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { BASE, SITE, markdownPath } from '../pages.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const TEXT = {
  en: { source: 'Source', diagram: 'Diagram' },
  ja: { source: '出典', diagram: '図' },
};
// Starlight's notice on a page without a translation (its i18n.untranslatedContent), and what follows.
const FALLBACK = 'このコンテンツはまだ日本語訳がありません。以下は英語の本文です。';

// The line that opens a code block (CommonMark): indent, fence and info
// string. A backtick fence's info string has no backtick; a tilde fence's may.
export function openFence(line) {
  const m = /^(\s*)(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(line);
  return m ? m[2] ?? m[4] : null;
}

// The line that closes it: the same character, at least as many, then only spaces.
export const closesFence = (line, fence) => new RegExp(`^\\s*\\${fence[0]}{${fence.length},}[ \\t]*$`).test(line);

// Remove what a pattern matches until nothing is left, so that removing one
// match cannot join the text around it into a new one (<scr<script>ipt>).
export function removeAll(text, re, fn = () => '') {
  for (let before; before !== text;) {
    before = text;
    text = text.replace(re, fn);
  }
  return text;
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A link target as an absolute URL; the page's own URL is the base. */
function absolute(target, base) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  return new URL(target, base).href;
}

// HTML elements a page could use. Another name in angle brackets in prose
// (<login>) is not an element here; a capitalised one (<Card>) is an MDX component.
const HTML = new Set(('a abbr address article aside audio b bdi bdo blockquote br button canvas caption cite code col colgroup data dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i iframe img input ins kbd label legend li link main mark meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time tr track u ul var video wbr').split(' '));

/**
 * A line split into prose and code spans, without author comments
 * (<!-- … -->). Whichever starts first wins, as in CommonMark: a backtick
 * inside a comment opens no code span, and a comment inside a code span is
 * code. `ticks` is the backtick run of a code span still open from the line
 * before; the result says whether one is still open, and whether a comment
 * goes on to the next line.
 */
export function splitLine(line, ticks = null) {
  const parts = [];      // [text, isCode]
  let prose = '';
  let i = 0;
  while (i < line.length) {
    if (ticks !== null) {
      // In a code span: it ends at the next backtick run of the same length.
      const re = /`+/g;
      re.lastIndex = i;
      let m;
      while ((m = re.exec(line)) && m[0].length !== ticks);
      if (!m) { parts.push([line.slice(i), true]); return { parts, ticks, comment: false }; }
      parts.push([line.slice(i, m.index + ticks), true]);
      i = m.index + ticks;
      ticks = null;
      continue;
    }
    const tick = line.indexOf('`', i);
    const open = line.indexOf('<!--', i);
    if (open >= 0 && (tick < 0 || open < tick)) {
      prose += line.slice(i, open);
      const end = line.indexOf('-->', open + 4);
      if (end < 0) { parts.push([prose, false]); return { parts, ticks: null, comment: true }; }
      // Removing a comment can join the text around it into a new one (<!<!-- x -->-- y -->): look again from the joint.
      const rest = line.slice(end + 3);
      const back = Math.min(prose.length, 3);
      line = prose.slice(prose.length - back) + rest;
      prose = prose.slice(0, prose.length - back);
      i = 0;
      continue;
    }
    if (tick < 0) { prose += line.slice(i); break; }
    prose += line.slice(i, tick);
    parts.push([prose, false]);
    prose = '';
    const run = /^`+/.exec(line.slice(tick))[0];
    ticks = run.length;
    parts.push([run, true]);
    i = tick + run.length;
  }
  parts.push([prose, false]);
  return { parts, ticks, comment: false };
}

/** Prose outside code spans: links absolute, inline HTML as Markdown. */
function inline(s, base) {
  s = removeAll(s, /<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi);
  s = removeAll(s, /<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi);
  return s
    .replace(/<code>([^<]*)<\/code>/g, (_, c) => `\`${decode(c)}\``)
    .replace(/<\/?(?:sub|sup|kbd|span)>/g, '')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, (_, href, text) => `[${text}](${absolute(decode(href), base)})`)
    .replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, t, title) => `](${absolute(t, base)}${title})`)
    .replace(/^(\s*\[[^\]]+\]:\s+)(\S+)/, (_, def, t) => def + absolute(t, base));
}

/** An HTML element or MDX component in prose that no rule converts, or undefined. */
const unknownTag = (prose) => [...prose.matchAll(/<\/?([A-Za-z][\w.-]*)(?=[\s/>])/g)]
  .map((m) => m[1]).find((name) => /^[A-Z]/.test(name) || HTML.has(name.toLowerCase()));

/**
 * The Markdown version of a page.
 * page: { title, description, body (Markdown or MDX, after the front matter),
 * url (the page's absolute URL), lang ('en' or 'ja'), fallback (English text
 * on a Japanese page), mdx, and for errors the file and the line its body
 * starts on }.
 */
export function pageMarkdown({ title, description, body, url, lang = 'en', fallback = false, file = url, mdx = false, firstLine = 1 }) {
  const t = TEXT[lang];
  const out = [`# ${title}`, '', description, '', `${t.source}: ${url}`];
  if (fallback) out.push('', `> ${FALLBACK}`);
  out.push('');
  const fail = (n, why) => { throw new Error(`${file}:${n + firstLine}: ${why}`); };
  let blank = true;            // the last line written is blank
  const push = (line, code = false) => {
    const text = code ? line : line.replace(/\s+$/, '');
    if (!code && text === '') { if (!blank) out.push(''); blank = true; return; }
    out.push(text);
    blank = false;
  };

  let fence = null;            // the fence that opened the code block we are in
  let block = null;            // a multi-line HTML block we are in: { end, lines, start }
  let comment = false;         // inside an author comment (<!-- … -->)
  let ticks = null;            // the backticks of a code span that goes on to the next line
  const lines = body.split('\n');
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    if (!line.trim()) ticks = null;     // a code span ends with its paragraph
    if (fence) {
      push(line, true);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      comment = false;
      line = line.slice(end + 3);
      if (!line.trim()) continue;
    }
    if (block) {
      block.lines.push(line);
      const text = block.lines.join('\n');
      const end = block.end.exec(text);
      if (!end) continue;
      block.done(text.slice(0, end.index + end[0].length));
      block = null;
      // The rest of the line after the end tag is read again as a line of its own.
      const rest = text.slice(end.index + end[0].length);
      if (rest.trim()) { lines[n] = rest; n--; }
      continue;
    }
    if (ticks === null) {
      const f = openFence(line);
      if (f) { fence = f; push(line, true); continue; }
      const trimmed = line.trim();
      // A diagram becomes its description.
      if (/^<svg\b/i.test(trimmed)) {
        const at = n;
        const done = (svg) => {
          const label = attr(svg, 'aria-label') ?? /<title>([\s\S]*?)<\/title>/.exec(svg)?.[1];
          if (!label) fail(at, 'a diagram (<svg>) needs an aria-label or a <title>');
          push(''); push(`_${t.diagram}: ${decode(label.trim())}_`); push('');
        };
        block = { end: /<\/svg\s*>/i, lines: [], done };
        lines[n] = line;
        n--;
        continue;
      }
      // Scripts and styles are left out.
      const tag = /^<(script|style)\b/i.exec(trimmed)?.[1];
      if (tag) {
        block = { end: new RegExp(`</${tag}\\b[^>]*>`, 'i'), lines: [], done: () => {} };
        lines[n] = line;
        n--;
        continue;
      }
      // <details><summary>Title</summary> … </details>: the title in bold, then the content.
      const details = /^<details>\s*(?:<summary>(.*?)<\/summary>)?\s*$/.exec(trimmed);
      if (details) {
        if (details[1] === undefined) fail(n, '<details> needs a <summary> on the same line');
        push(''); push(`**${inline(details[1], url)}**`); push('');
        continue;
      }
      if (trimmed === '</details>') { push(''); continue; }
      if (mdx && /^(import|export)\s/.test(trimmed)) fail(n, 'an MDX import or export: say in scripts/page-markdown.mjs what its component becomes in Markdown');
      // A heading's fixed id ({#id}, plugins/heading-ids.mjs) is for the web page only.
      line = line.replace(/^(#{1,6}\s.*?)\s*\{#[^}\s]+\}\s*$/, '$1');
    }

    const split = splitLine(line, ticks);
    ticks = split.ticks;
    comment = split.comment;
    line = split.parts.map(([text, code]) => {
      if (code) return text;
      const prose = inline(text, url);
      // HTML or a component the rules above do not know: say what it becomes before it reaches a page.
      const unknown = unknownTag(prose);
      if (unknown) fail(n, `<${unknown}> is not known to scripts/page-markdown.mjs: add a rule for it`);
      return prose;
    }).join('');
    // A line that held only author comments is left out, not written as a blank line.
    if (!line.trim() && lines[n].trim()) continue;
    push(line);
  }
  if (fence) fail(lines.length - 1, `the code block opened with ${fence} is not closed`);
  if (comment) fail(lines.length - 1, 'an HTML comment is not closed');
  if (block) fail(lines.length - 1, `the HTML block ${block.lines[0].trim()} is not closed`);
  while (out.at(-1) === '') out.pop();
  return `${out.join('\n')}\n`;
}

/** A synced page: front matter and body, by slug ('how-to/deploy', 'ja/how-to/deploy', '' for the start page). */
function source(content, slug) {
  const base = join(content, slug);
  for (const file of [`${base}.md`, `${base}.mdx`, join(base, 'index.md'), join(base, 'index.mdx')]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!m) throw new Error(`${file}: no front matter`);
    return { file, data: parse(m[1]), body: text.slice(m[0].length), mdx: file.endsWith('.mdx'), firstLine: m[0].split('\n').length };
  }
  return undefined;
}

/**
 * Writes the Markdown version of every built page (dist/**\/index.html,
 * except the 404 page) next to it, and checks that the page's head links it.
 * Returns the number of pages.
 */
export function writePageMarkdown(dist = join(siteDir, 'dist'), content = join(siteDir, 'src', 'content', 'docs')) {
  const pages = readdirSync(dist, { recursive: true })
    .map((f) => String(f).split('\\').join('/'))
    .filter((f) => f === 'index.html' || f.endsWith('/index.html'));
  if (!pages.length) throw new Error(`${dist}: no pages; run the docs build first`);
  const errors = [];
  for (const page of pages) {
    const slug = page.slice(0, -'index.html'.length).replace(/\/$/, '');
    const path = `${BASE}${slug}${slug ? '/' : ''}`;
    const ja = slug === 'ja' || slug.startsWith('ja/');
    let src = source(content, slug);
    let fallback = false;
    if (!src && ja) {
      // A Japanese page without a translation shows the English page (Starlight's fallback).
      src = source(content, slug.replace(/^ja\/?/, ''));
      fallback = true;
    }
    if (!src) { errors.push(`${path}: no source page in src/content/docs`); continue; }
    const md = markdownPath(path);
    const href = new URL(md, SITE).href;
    const html = readFileSync(join(dist, page), 'utf8');
    if (!html.includes(`<link rel="alternate" type="text/markdown" href="${href}"/>`)) errors.push(`${path}: the head does not link ${href} (src/route-data.ts)`);
    if (!src.data.title || !src.data.description) { errors.push(`${src.file}: a title and a description are needed`); continue; }
    try {
      const text = pageMarkdown({
        title: src.data.title, description: src.data.description, body: src.body,
        url: `${SITE}${path}`, lang: ja ? 'ja' : 'en', fallback, file: src.file, mdx: src.mdx, firstLine: src.firstLine,
      });
      writeFileSync(join(dist, md.slice(BASE.length)), text);
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) throw new Error(`Markdown versions of the pages:\n${errors.join('\n')}`);
  return pages.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`markdown: a .md file for each of ${writePageMarkdown()} pages`);
}
