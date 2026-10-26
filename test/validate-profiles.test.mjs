import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseProfile, validateProfile, validateProfileFile } from '../scripts/lib/profile.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const examples = join(root, 'examples', 'profiles');
const invalid = join(root, 'test', 'fixtures', 'invalid');
const cli = join(root, 'scripts', 'validate-profiles.mjs');

// The examples are one set: road-closure-final requires two of the others.
const exampleSet = new Map(readdirSync(examples).map((f) => {
  const p = parseProfile(readFileSync(join(examples, f), 'utf8'), f);
  return [p.id, p];
}));
for (const file of readdirSync(examples)) {
  test(`example ${file} is valid`, () => {
    assert.deepEqual(validateProfileFile(join(examples, file), { profiles: exampleSet }), []);
  });
}

// Each invalid fixture names the error it must produce in a "# expect:" line,
// so a fixture that fails for the wrong reason also fails the test.
for (const file of readdirSync(invalid)) {
  test(`fixture ${file} is rejected for the expected reason`, () => {
    const path = join(invalid, file);
    const expected = readFileSync(path, 'utf8').match(/^# expect: (.+)$/m)?.[1];
    assert.ok(expected, `${file} has no "# expect:" line`);
    const errors = validateProfileFile(path);
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `expected an error containing:\n  ${expected}\ngot:\n  ${errors.join('\n  ') || '(no errors)'}`,
    );
  });
}

// JSON fixtures cannot carry a "# expect:" comment, so these are written here.
test('JSON profiles: valid file passes, duplicate keys and non-JSON syntax fail', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const profile = {
    id: 'json-profile',
    version: 1,
    title: { en: 'Test', ja: 'テスト' },
    description: { en: 'Test profile', ja: 'テスト用' },
    model: 'clef-flash',
    questions: [{ name: 'ok', type: 'noul', instructions: 'Is it ok?' }],
    policy: { default: 'review' },
  };
  const file = join(dir, 'json-profile.json');
  const valid = JSON.stringify(profile, null, 2);

  writeFileSync(file, valid);
  assert.deepEqual(validateProfileFile(file), []);

  // A duplicate "default" must not let the last value win silently.
  writeFileSync(file, valid.replace('"default": "review"', '"default": "review", "default": "auto"'));
  assert.match(validateProfileFile(file).join('\n'), /\(parse\): Map keys must be unique/);

  // YAML-only syntax (a comment) is not valid JSON.
  writeFileSync(file, `# comment\n${valid}`);
  assert.match(validateProfileFile(file).join('\n'), /\(parse\): Unexpected token/);
});

test('CLI exits 0 for the examples', () => {
  const r = spawnSync(process.execPath, [cli, examples], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('CLI exits 1 when any profile is invalid', () => {
  const r = spawnSync(process.execPath, [cli, examples, invalid], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL {2}.*missing-ja\.yaml/);
});

test('CLI exits 1 when no profile is found', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'pointsman-'));
  t.after(() => rmSync(empty, { recursive: true }));
  const r = spawnSync(process.execPath, [cli, empty], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No profiles found/);
});

test('CLI rejects two files with the same profile id', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const yaml = readFileSync(join(examples, 'issue-triage.yaml'), 'utf8');
  writeFileSync(join(dir, 'issue-triage.yaml'), yaml);
  writeFileSync(join(dir, 'issue-triage.json'), JSON.stringify(parseYaml(yaml)));
  const r = spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /duplicate profile id "issue-triage": .*issue-triage.json, .*issue-triage.yaml/);
});

test('CLI skips symbolic links inside a folder (no endless loop)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-'));
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'issue-triage.yaml'), readFileSync(join(examples, 'issue-triage.yaml'), 'utf8'));
  symlinkSync(dir, join(dir, 'loop'), 'dir');
  symlinkSync(join(examples, 'deploy-progress.yaml'), join(dir, 'deploy-progress.yaml'));
  const r = spawnSync(process.execPath, [cli, dir], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 valid, 0 invalid/);
});

test('CLI exits 2 for a missing path', () => {
  const r = spawnSync(process.execPath, [cli, join(root, 'no-such-dir')], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('a profile with facts and fact rules is valid', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-facts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'place-check.yaml');
  writeFileSync(path, `id: place-check
version: 1
title: { en: Test, ja: テスト }
description: { en: Test profile, ja: テスト用 }
model: clef-flash
questions:
  - { name: danger, type: noul, instructions: Are people in danger? }
facts:
  - { name: flood, type: inside, layer: gsi-flood-max, at: $.location.value }
  - { name: shelter, type: nearest, layer: gsi-shelters-flood, at: $.location.value }
  - { name: detour, type: detour, at: $.location.value }
  - { name: walk, type: detour, mode: walk, route: true, at: $.location.value }
policy:
  rules:
    - when: "facts.flood.rank >= 5 and danger.yes >= 0.4"
      action: urgent
    - when: "facts.detour.extra_m >= 300 or facts.shelter.distance_m > 1000"
      action: review
    - when: "facts.flood.missing == true"
      action: review
  default: auto
`);
  assert.deepEqual(validateProfileFile(path), []);
});

// Decision chains (docs/decision-chains.md): profiles are checked against the
// ones they require, in both directions, through the CLI on a folder.
function chainFolder(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-chain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
}
const head = (id) => `id: ${id}\nversion: 1\ntitle: { en: Test, ja: テスト }\ndescription: { en: Test profile, ja: テスト用 }\nmodel: clef-flash\n`;
const first = (questions = '  - { name: danger, type: noul, instructions: Danger? }\n') => `${head('first')}questions:\n${questions}policy:\n  rules:\n    - when: "danger.yes >= 0.7"\n      action: urgent\n  default: review\n`;
const final = `${head('final')}requires:\n  - { name: check, profile: first }\nquestions: []\npolicy:\n  rules:\n    - when: "decisions.check.answers.danger.yes >= 0.9 and decisions.check.outcome == 'urgent'"\n      action: urgent\n  default: review\n`;

test('a chained profile is valid with the profile it requires', (t) => {
  const r = chainFolder(t, { 'first.yaml': first(), 'final.yaml': final });
  assert.equal(r.status, 0, r.stdout);
});

test('a change to a required profile that breaks a rule reading it fails, naming the profile', (t) => {
  const r = chainFolder(t, { 'first.yaml': first('  - { name: risk, type: noul, instructions: Risk? }\n').replace('danger.yes', 'risk.yes'), 'final.yaml': final });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL .*final\.yaml[\s\S]*decisions\.check\.answers\.danger\.yes/);
});

test('a required profile that is not valid fails the profile built on it, without a crash', (t) => {
  const broken = first().replace(/policy:[\s\S]*$/, '');
  const r = chainFolder(t, { 'first.yaml': broken, 'final.yaml': final });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL .*final\.yaml[\s\S]*"first" is not a valid profile/);
  assert.doesNotMatch(r.stderr, /TypeError/);
});

// p0..p30 and q0..q30, each requiring the next p and the next q: the number
// of paths doubles per layer, so a walk of every path does not finish.
function ladder(layers, back = false) {
  const set = new Map();
  for (let i = 0; i <= layers; i += 1) {
    for (const x of ['p', 'q']) {
      const next = i < layers ? `requires:\n  - { name: p, profile: p${i + 1} }\n  - { name: q, profile: q${i + 1} }\n`
        : back && x === 'q' ? 'requires:\n  - { name: p, profile: p0 }\n' : '';
      const questions = next ? 'questions: []\n' : 'questions:\n  - { name: danger, type: noul, instructions: Danger? }\n';
      set.set(`${x}${i}`, parseProfile(`${head(`${x}${i}`)}${next}${questions}policy:\n  default: review\n`, `${x}${i}.yaml`));
    }
  }
  return set;
}

test('shared requires are checked for a circle in linear time', () => {
  const set = ladder(30);
  const started = Date.now();
  for (const p of set.values()) assert.deepEqual(validateProfile(p, { profiles: set }), []);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  const circle = ladder(30, true);
  const errors = validateProfile(circle.get('p0'), { profiles: circle });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /require each other in a circle: p0 → .* → q30 → p0$/);
});

test('profiles that require each other in a circle fail', (t) => {
  const a = `${head('a')}requires:\n  - { name: b, profile: b }\nquestions: []\npolicy:\n  default: review\n`;
  const b = `${head('b')}requires:\n  - { name: a, profile: a }\nquestions: []\npolicy:\n  default: review\n`;
  const r = chainFolder(t, { 'a.yaml': a, 'b.yaml': b });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /require each other in a circle: a → b → a/);
});
