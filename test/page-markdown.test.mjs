// The Markdown version of each docs page (docs-site/scripts/page-markdown.mjs):
// each rule, code blocks never changed, and the build check fails on a page without a Markdown version or a head link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { markdownPath } from '../docs-site/pages.mjs';
import { closesFence, openFence, pageMarkdown, splitLine, writePageMarkdown } from '../docs-site/scripts/page-markdown.mjs';

const URL_ = 'https://pointsman.net/docs/how-to/x/';
const md = (body, extra = {}) => pageMarkdown({ title: 'T', description: 'D.', body, url: URL_, ...extra });
/** The converted body, without the title, description and source lines. */
const body = (text, extra) => md(text, extra).split('\n').slice(6).join('\n');

test('markdownPath: the page path without its slash, plus .md; index.md for the start pages', () => {
  assert.equal(markdownPath('/docs/how-to/deploy/'), '/docs/how-to/deploy.md');
  assert.equal(markdownPath('/docs/about/'), '/docs/about.md');
  assert.equal(markdownPath('/docs/ja/about/ai/'), '/docs/ja/about/ai.md');
  assert.equal(markdownPath('/docs/'), '/docs/index.md');
  assert.equal(markdownPath('/docs/ja/'), '/docs/ja/index.md');
  assert.throws(() => markdownPath('/docs/x'));
  assert.throws(() => markdownPath('/other/'));
});

test('a page starts with its title, description and URL; a fallback page says it is English', () => {
  assert.equal(md('Text.'), '# T\n\nD.\n\nSource: https://pointsman.net/docs/how-to/x/\n\nText.\n');
  const ja = md('Text.', { lang: 'ja', fallback: true });
  assert.match(ja, /^# T\n\nD\.\n\n出典: https:\/\/pointsman\.net\/docs\/how-to\/x\/\n\n> このコンテンツはまだ日本語訳がありません。/);
});

test('code fences follow CommonMark: same character, at least as long, only spaces after', () => {
  assert.equal(openFence('```js'), '```');
  assert.equal(openFence('  ~~~~ info with `backticks`'), '~~~~');
  assert.equal(openFence('``` info with `backtick`'), null);
  assert.equal(openFence('``'), null);
  assert.ok(closesFence('```', '```'));
  assert.ok(closesFence('  `````  ', '```'));
  assert.ok(!closesFence('``', '```'));
  assert.ok(!closesFence('~~~', '```'));
  assert.ok(!closesFence('``` x', '```'));
});

test('code blocks are never changed', () => {
  // A fence indented 4 spaces more than the opening one is a line of the code, not its end.
  assert.equal(body('```\n    ```\nx\n```'), '```\n    ```\nx\n```\n');
  assert.ok(closesFence('     ```', '```', 2));
  assert.ok(!closesFence('    ```', '```'));
  const code = [
    '````markdown',
    '```',
    '<!-- a comment -->',
    '<details><summary>x</summary>',
    '<svg aria-label="d"></svg>',
    '<script>alert(1)</script>',
    '## Heading {#id}   ',
    '[link](/docs/a/) <login> <Card>',
    '```',
    '````',
    '~~~ text `x`',
    '```',
    '  trailing  ',
    '',
    '',
    '',
    '~~~',
  ].join('\n');
  assert.equal(body(code), `${code}\n`);
  // An unclosed block fails rather than turning the rest of the page into code.
  assert.throws(() => md('```\nx'), /not closed/);
});

test('author comments are left out, also across lines and when removing one makes another', () => {
  assert.equal(body('a\n<!-- note -->\nb'), 'a\nb\n');
  assert.equal(body('a <!-- one --> b <!-- two\nlines --> c'), 'a  b\n c\n');
  assert.equal(body('a <!<!-- x -->-- y --> b'), 'a  b\n');
  assert.equal(body('<!-- Generated. Run `pnpm x`. -->\n\nText.'), 'Text.\n');
  // In a code span, a comment is code.
  assert.equal(body('Write `<!-- x -->` here.'), 'Write `<!-- x -->` here.\n');
  assert.throws(() => md('a <!-- open'), /comment is not closed/);
});

test('code spans go on over lines, and stay as they are', () => {
  assert.deepEqual(splitLine('a `b` c').parts, [['a ', false], ['`', true], ['b`', true], [' c', false]]);
  assert.equal(splitLine('run `x --flag <id>', null, 'more` here').ticks, 1);
  assert.equal(splitLine('run `x --flag <id>', null, 'no closer').ticks, null);
  assert.equal(body('run `x --flag\n<details> y` and [l](/docs/a/)'), 'run `x --flag\n<details> y` and [l](https://pointsman.net/docs/a/)\n');
  // A blank line ends the paragraph, and the code span with it.
  assert.equal(body('a `open\n\n[l](/docs/a/)'), 'a `open\n\n[l](https://pointsman.net/docs/a/)\n');
  assert.equal(body('``a ` b`` [l](#x)'), '``a ` b`` [l](https://pointsman.net/docs/how-to/x/#x)\n');
});

test('a backtick with no closing one in its paragraph is a plain backtick', () => {
  // Without this the rest of the paragraph would be taken as code and left unconverted.
  assert.equal(body('- the ` key\n- see [a](/docs/y/) <!-- c -->'), '- the ` key\n- see [a](https://pointsman.net/docs/y/)\n');
  assert.throws(() => md('- the ` key\n- <Card>'), /<Card> is not known/);
  assert.equal(body('a ` b\n\n[l](/docs/a/) `c`'), 'a ` b\n\n[l](https://pointsman.net/docs/a/) `c`\n');
  // A run closes only with a run of the same length.
  assert.equal(body('``a ` [l](/x)'), '``a ` [l](https://pointsman.net/x)\n');
});

test('code the converter would not see as code fails the build', () => {
  assert.throws(() => md('Text.\n\n    [a](/docs/y/)'), /indented code block/);
  assert.throws(() => md('Text.\n\n\tcode'), /indented code block/);
  assert.throws(() => md('> ```sh\n> x\n> ```'), /blockquote/);
  // In a list, an indented line belongs to the item.
  assert.equal(body('1. Item\n\n    More of [it](/docs/a/).\n\n        ```sh\n        x\n        ```'),
    '1. Item\n\n    More of [it](https://pointsman.net/docs/a/).\n\n        ```sh\n        x\n        ```\n');
  // Windows line ends are read as plain ones.
  assert.equal(body('```\r\nx\r\n```\r\n'), '```\nx\n```\n');
});

test('links become absolute URLs; external links and code stay', () => {
  assert.equal(body('[a](/docs/b/) [c](#d) [e](../f/ "t") [g](https://x.org/) `[h](/docs/i/)`'),
    '[a](https://pointsman.net/docs/b/) [c](https://pointsman.net/docs/how-to/x/#d) [e](https://pointsman.net/docs/how-to/f/ "t") [g](https://x.org/) `[h](/docs/i/)`\n');
  assert.equal(body('[ref]: /docs/b/'), '[ref]: https://pointsman.net/docs/b/\n');
  assert.equal(body('<a href="/docs/b/">B</a>'), '[B](https://pointsman.net/docs/b/)\n');
  assert.equal(body('<https://x.org/>'), '<https://x.org/>\n');
  assert.equal(body('<a title="a>b" href="/docs/b/">B</a>'), '[B](https://pointsman.net/docs/b/)\n');
  assert.equal(body('[b](<../a b/>) and\n[c]: </y z/> "t"'), '[b](<https://pointsman.net/docs/how-to/a%20b/>) and\n[c]: <https://pointsman.net/y%20z/> "t"\n');
  // <code> becomes a code span, and its content stays as it is.
  assert.equal(body('<code>&lt;div&gt;</code> text'), '`<div>` text\n');
  assert.equal(body('<code>[a](/y)</code> [b](/y)'), '`[a](/y)` [b](https://pointsman.net/y)\n');
});

test('diagrams become their description; details a bold line; heading ids, scripts and styles go', () => {
  assert.equal(body('a\n<svg class="d" aria-label="A &amp; B" x="1">\n<rect/>\n</svg>\nb'), 'a\n\n_Diagram: A & B_\n\nb\n');
  assert.equal(body('<svg><title>T</title></svg>', { lang: 'ja' }), '_図: T_\n');
  assert.throws(() => md('<svg>\n</svg>'), /aria-label or a <title>/);
  assert.equal(body('<details><summary><code>x</code>: why</summary>\n\nText.\n\n</details>\n\nNext.'), '**`x`: why**\n\nText.\n\nNext.\n');
  assert.equal(body('## A title {#a-title}'), '## A title\n');
  assert.equal(body('<SCRIPT type="x">\nalert(1)\n</script\n>\na<style>x</STYLE>b<script>y</script >c'), 'abc\n');
  assert.equal(body('a<sub>small</sub><br>b'), 'asmall b\n');
});

test('unknown HTML and MDX components fail the build; other words in angle brackets are text', () => {
  assert.throws(() => md('<table>'), /<table> is not known/);
  assert.throws(() => md('Text <Card title="x" /> more'), /<Card> is not known/);
  assert.throws(() => md('<details open><summary>x</summary>'), /<details> is not known/);
  assert.throws(() => md('<details>'), /needs a <summary>/);
  assert.throws(() => md('import Card from "x";', { mdx: true }), /MDX import/);
  assert.throws(() => md('Answer: {1 + 1}', { mdx: true }), /MDX expression/);
  // Braces in code, in Markdown, and a heading id stay allowed.
  assert.equal(body('`{x}` and\n## H {#h}', { mdx: true }), '`{x}` and\n## H\n');
  assert.equal(body('Answer: {1 + 1}'), 'Answer: {1 + 1}\n');
  // A tag that removing another one makes is still found.
  assert.throws(() => md('<scr<script>x</script>ipt>alert(1)'), /<script> is not known/);
  assert.equal(body('answered by <login>, `<Card>`'), 'answered by <login>, `<Card>`\n');
  // Errors name the file and the line in it.
  assert.throws(() => md('a\n<table>', { file: 'p.md', firstLine: 5 }), /^Error: p\.md:6: /);
});

test('the build check writes a .md for every page and fails without one or without the head link', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'page-markdown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  const content = join(dir, 'content');
  const page = (slug, head = true) => {
    const path = `/docs/${slug}${slug ? '/' : ''}`;
    const file = join(dist, slug, 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, head ? `<head><link rel="alternate" type="text/markdown" href="https://pointsman.net${markdownPath(path)}"/></head>` : '<head></head>');
  };
  const source = (file, text) => { mkdirSync(dirname(join(content, file)), { recursive: true }); writeFileSync(join(content, file), text); };
  source('index.mdx', '---\ntitle: Start\ndescription: S.\n---\nHello [a](/docs/a/).\n');
  source('a.md', '---\ntitle: A\ndescription: A.\n---\nEnglish.\n');
  source('ja/index.mdx', '---\ntitle: スタート\ndescription: S.\n---\nこんにちは。\n');
  for (const slug of ['', 'a', 'ja', 'ja/a']) page(slug);
  writeFileSync(join(dist, '404.html'), '');
  assert.equal(writePageMarkdown(dist, content), 4);
  assert.match(readFileSync(join(dist, 'index.md'), 'utf8'), /^# Start\n[\s\S]*Hello \[a\]\(https:\/\/pointsman\.net\/docs\/a\/\)\.\n$/);
  assert.match(readFileSync(join(dist, 'ja/index.md'), 'utf8'), /^# スタート\n\nS\.\n\n出典: https:\/\/pointsman\.net\/docs\/ja\/\n\nこんにちは。\n$/);
  // A Japanese page without a translation: the English text, with a note.
  assert.match(readFileSync(join(dist, 'ja/a.md'), 'utf8'), /出典: https:\/\/pointsman\.net\/docs\/ja\/a\/\n\n> このコンテンツはまだ日本語訳がありません。[^\n]*\n\nEnglish\.\n$/);
  assert.ok(!existsSync(join(dist, '404.md')));

  page('a', false);
  assert.throws(() => writePageMarkdown(dist, content), /\/docs\/a\/: the head does not link https:\/\/pointsman\.net\/docs\/a\.md/);
  page('a');
  page('b');
  assert.throws(() => writePageMarkdown(dist, content), /\/docs\/b\/: no source page/);
});
