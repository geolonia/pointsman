// The use-case topics (examples/<topic>/README.md): every example profile
// belongs to exactly one topic, and the topics' links point to files that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const topics = readdirSync(examples, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'profiles')
  .map((e) => join(examples, e.name, 'README.md'));
const readmes = [join(examples, 'README.md'), ...topics];

/** Relative link targets of a Markdown file, without #anchors. */
function links(file) {
  const targets = [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  return targets.filter((t) => !/^[a-z]+:/.test(t) && !t.startsWith('#')).map((t) => t.split('#')[0]);
}

test('every topic folder has a README', () => {
  assert.ok(topics.length > 0);
  for (const file of topics) assert.ok(existsSync(file), file);
});

test('every example profile belongs to exactly one topic', () => {
  for (const profile of readdirSync(join(examples, 'profiles'))) {
    const owners = topics.filter((file) => links(file).some((t) => t.endsWith(`profiles/${profile}`)));
    assert.equal(owners.length, 1, `${profile} is linked from ${owners.length} topics`);
  }
});

for (const file of readmes) {
  test(`links in ${file.slice(examples.length)} exist`, () => {
    for (const target of links(file)) {
      assert.ok(existsSync(resolve(dirname(file), target)), `${target} does not exist`);
    }
  });
}
