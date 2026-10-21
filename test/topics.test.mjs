// The use-case topics (examples/<topic>/README.md): every example profile
// belongs to exactly one topic, and the topics' links point to files that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const topicDirs = readdirSync(examples, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'profiles')
  .map((e) => e.name);
const topics = topicDirs.map((name) => join(examples, name, 'README.md')).filter((file) => existsSync(file));
const overview = join(examples, 'README.md');

/** Relative link targets of a Markdown file, resolved to paths, without #anchors. */
function links(file) {
  const targets = [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  return targets
    .filter((t) => !/^[a-z]+:/.test(t) && !t.startsWith('#'))
    .map((t) => resolve(dirname(file), t.split('#')[0]));
}

test('every topic folder has a README, listed in examples/README.md', () => {
  assert.ok(topicDirs.length > 0);
  const listed = links(overview);
  for (const name of topicDirs) {
    assert.ok(existsSync(join(examples, name, 'README.md')), `examples/${name}/ has no README.md`);
    assert.ok(listed.includes(join(examples, name)), `examples/README.md does not link examples/${name}/`);
  }
});

test('every example profile belongs to exactly one topic', () => {
  for (const profile of readdirSync(join(examples, 'profiles'))) {
    const path = join(examples, 'profiles', profile);
    const owners = topics.filter((file) => links(file).includes(path));
    assert.equal(owners.length, 1,
      `examples/profiles/${profile} is linked from ${owners.length} topic READMEs; link it from exactly one examples/<topic>/README.md`);
  }
});

for (const file of [overview, ...topics]) {
  test(`links in ${file.slice(examples.length)} exist`, () => {
    for (const target of links(file)) {
      assert.ok(existsSync(target), `${target} does not exist`);
    }
  });
}
