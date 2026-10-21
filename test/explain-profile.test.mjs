// scripts/explain-profile.mjs: explain a profile file, also a draft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const examples = join(root, 'examples', 'profiles');
const cli = join(root, 'scripts', 'explain-profile.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('explains a profile as Markdown, in English and Japanese', () => {
  const en = run(join(examples, 'issue-triage.yaml'));
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /^# Issue triage \(issue-triage, v\d+\)\n/);
  assert.match(en.stdout, /\n1\. If the AI's certainty about "team" is at least 85 %, the action is auto\.\n/);
  const ja = run(join(examples, 'issue-triage.yaml'), '--lang', 'ja');
  assert.equal(ja.status, 0, ja.stderr);
  assert.match(ja.stdout, /\n1\. 「team」についての AI の確信度が 85 % 以上なら、アクションは auto です。\n/);
});

test('reads required profiles from the same directory, and from --with', () => {
  const json = run(join(examples, 'road-closure-final.yaml'), '--json');
  assert.equal(json.status, 0, json.stderr);
  const e = JSON.parse(json.stdout);
  assert.equal(e.rules[1].text, 'If the outcome of the earlier decision "evacuation" is alert, the action is urgent.');

  const dir = mkdtempSync(join(tmpdir(), 'explain-'));
  try {
    copyFileSync(join(examples, 'road-closure-final.yaml'), join(dir, 'road-closure-final.yaml'));
    // Alone, the profiles it requires are unknown: not valid, so not explained.
    const alone = run(join(dir, 'road-closure-final.yaml'));
    assert.equal(alone.status, 1);
    assert.match(alone.stderr, /is not valid, so it is not explained/);
    const withExamples = run(join(dir, 'road-closure-final.yaml'), '--with', examples);
    assert.equal(withExamples.status, 0, withExamples.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not explain an invalid draft, and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'explain-'));
  try {
    const file = join(dir, 'draft.yaml');
    writeFileSync(file, [
      'id: draft',
      'version: 1',
      'title: { en: Draft, ja: 下書き }',
      'description: { en: A draft., ja: 下書きです。 }',
      'model: clef-flash',
      'questions:',
      '  - { name: urgent, type: noul, instructions: Is it urgent? }',
      'policy:',
      '  rules:',
      '    - { when: "team.p >= 0.85", action: auto }',
      '  default: review',
      '',
    ].join('\n'));
    const r = run(file);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"team\.p" does not refer to a question of this profile/);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses bad arguments', () => {
  assert.equal(run().status, 2);
  assert.equal(run(join(examples, 'issue-triage.yaml'), '--lang', 'fr').status, 2);
  assert.equal(run(join(examples, 'issue-triage.yaml'), '--nope').status, 2);
});
