// scripts/check-profile-versions.mjs: changed profiles need a higher version.
// Each test builds a small git repository: a base commit, then a change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'scripts', 'check-profile-versions.mjs');
const example = readFileSync(join(root, 'examples', 'profiles', 'issue-triage.yaml'), 'utf8');

/** A repository with profiles/issue-triage.yaml committed as the base. */
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-versions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A throwaway repository: identity and signing are set only here.
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'profiles'));
  writeFileSync(join(dir, 'profiles', 'issue-triage.yaml'), example);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  const file = join(dir, 'profiles', 'issue-triage.yaml');
  return { dir, base, file, git };
}

function check(dir, ...args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const edit = (file, from, to) => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `fixture does not contain ${from}`);
  writeFileSync(file, text.replace(from, to));
};

test('unchanged profiles pass', (t) => {
  const { dir, base } = repo(t);
  const r = check(dir, '--base', base, 'profiles');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /same {2}profiles\/issue-triage\.yaml: issue-triage version 1/);
});

test('a change without a new version fails, naming the file and versions', (t) => {
  const { dir, base, file } = repo(t);
  edit(file, 'Which team should handle this issue?', 'Which team should take this issue?');
  const r = check(dir, '--base', base, 'profiles');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL {2}profiles\/issue-triage\.yaml: issue-triage changed but its version is 1 \(was 1\); increase the version/);
});

test('a change with a higher version passes', (t) => {
  const { dir, base, file } = repo(t);
  edit(file, 'Which team should handle this issue?', 'Which team should take this issue?');
  edit(file, 'version: 1', 'version: 2');
  const r = check(dir, '--base', base, 'profiles');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /issue-triage changed, version 1 -> 2/);
});

test('a change with a lower version fails, and so does lowering alone', (t) => {
  const { dir, file, git } = repo(t);
  edit(file, 'version: 1', 'version: 3');
  git('commit', '-qam', 'v3');
  const v3 = git('rev-parse', 'HEAD').trim();
  edit(file, 'version: 3', 'version: 2');
  assert.equal(check(dir, '--base', v3, 'profiles').code, 1);
  assert.match(check(dir, '--base', v3, 'profiles').out, /version of issue-triage lowered from 3 to 2/);
  edit(file, 'Which team should handle this issue?', 'Which team?');
  assert.match(check(dir, '--base', v3, 'profiles').out, /changed but its version is 2 \(was 3\)/);
});

test('comments, formatting and key order are not changes', (t) => {
  const { dir, base, file } = repo(t);
  edit(file, '# Example profile: route a new issue to a team.', '# A different comment.');
  edit(file, '  - { name: title, path: $.issue.title }', '  - path: $.issue.title\n    name: title');
  const r = check(dir, '--base', base, 'profiles');
  assert.equal(r.code, 0, r.out);
});

test('new and deleted profiles pass', (t) => {
  const { dir, base, file } = repo(t);
  writeFileSync(join(dir, 'profiles', 'other.yaml'), example.replace('id: issue-triage', 'id: other').replace('version: 1', 'version: 4'));
  unlinkSync(file);
  const r = check(dir, '--base', base, 'profiles');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /new {3}profiles\/other\.yaml: other version 4/);
  assert.match(r.out, /gone {2}profiles\/issue-triage\.yaml: issue-triage \(removed; its published versions are kept\)/);
});

test('profiles are matched by id: a renamed file is not a change, a renamed and edited one is', (t) => {
  const { dir, base, file } = repo(t);
  mkdirSync(join(dir, 'profiles', 'triage'));
  const moved = join(dir, 'profiles', 'triage', 'issue-triage.yaml');
  renameSync(file, moved);
  assert.equal(check(dir, '--base', base, 'profiles').code, 0);
  edit(moved, 'Which team should handle this issue?', 'Which team?');
  assert.equal(check(dir, '--base', base, 'profiles').code, 1);
});

test('a profile in the pull request that cannot be parsed fails', (t) => {
  const { dir, base, file } = repo(t);
  writeFileSync(file, 'id: [unclosed');
  const r = check(dir, '--base', base, 'profiles');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /issue-triage\.yaml cannot be parsed/);
});

test('a base that cannot be parsed is not compared', (t) => {
  const { dir, file, git } = repo(t);
  writeFileSync(file, 'id: [unclosed');
  git('commit', '-qam', 'broken');
  const broken = git('rev-parse', 'HEAD').trim();
  writeFileSync(file, example);
  const r = check(dir, '--base', broken, 'profiles');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /new {3}profiles\/issue-triage\.yaml/);
});

test('usage and git errors exit 2', (t) => {
  const { dir, base } = repo(t);
  assert.equal(check(dir, 'profiles').code, 2);
  assert.equal(check(dir, '--base', base).code, 2);
  assert.equal(check(dir, '--base', '--output=x', 'profiles').code, 2);
  assert.equal(check(dir, '--base', 'main..HEAD', 'profiles').code, 2);
  assert.equal(check(dir, '--base', 'no-such-branch', 'profiles').code, 2);
  assert.equal(check(dir, '--base', base, 'missing').code, 2);
});
