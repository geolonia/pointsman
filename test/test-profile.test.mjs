// Test cases for profiles: src/cases.ts and scripts/test-profile.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { answerOf, caseFileErrors, runCases } from '../src/cases.ts';
import { useChosenModules } from '../scripts/lib/modules.mjs';

// Every module in this repository, as for the examples.
await useChosenModules();

const root = fileURLToPath(new URL('..', import.meta.url));
const examples = join(root, 'examples');
const cli = join(root, 'scripts', 'test-profile.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, POINTSMAN_TOKEN: '', ...env } });
const profile = (id) => parseYaml(readFileSync(join(examples, 'profiles', `${id}.yaml`), 'utf8'));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cases-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('short answers become the engine format, as the normalizer makes them', () => {
  const q = (type, criteria) => ({ name: 'q', type, instructions: 'x', ...(criteria && { criteria }) });
  assert.deepEqual(answerOf(q('noul'), true, 'a'), { type: 'noul', value: true, p: 1, yes: 1 });
  assert.deepEqual(answerOf(q('noul'), 0.3, 'a'), { type: 'noul', value: false, p: 0.7, yes: 0.3 });
  const choice = q('choice', [{ value: 'a' }, { value: 'b' }]);
  assert.deepEqual(answerOf(choice, 'b', 'a'), { type: 'choice', value: 'b', p: 1, probabilities: { b: 1 } });
  assert.deepEqual(answerOf(choice, { a: 0.7, b: 0.3 }, 'a'), { type: 'choice', value: 'a', p: 0.7, probabilities: { a: 0.7, b: 0.3 } });
  const score = q('score', ['low', 'mid', 'high']);
  assert.deepEqual(answerOf(score, 2, 'a'), { type: 'score', value: 2, p: 1, score: 2, probabilities: { 2: 1 } });
  const weighted = answerOf(score, { 1: 0.25, 2: 0.75 }, 'a');
  assert.equal(weighted.value, 2);
  assert.equal(weighted.score, 1.75);
  for (const [question, bad, message] of [
    [q('noul'), 'yes', /true, false, or the probability of yes/],
    [q('noul'), 1.5, /true, false, or the probability of yes/],
    [choice, 'c', /"c" is not one of a, b/],
    [score, 3, /"3" is not one of 0, 1, 2/],
    [score, 1.5, /give a level/],
    [choice, { a: 2 }, /must be a number from 0 to 1/],
    [choice, {}, /at least one probability/],
  ]) {
    assert.throws(() => answerOf(question, bad, 'answers.q'), message);
  }
});

test('a case that does not fit its profile cannot run, and says where', () => {
  const p = profile('road-restriction-check');
  const base = { category: 'other', status_matches: true, danger: 0.1, clarity: 3 };
  const results = runCases({
    profile: p.id,
    cases: [
      { name: 'a question is left out', expect: 'review', answers: { category: 'other', status_matches: true, danger: 0.1 } },
      { name: 'an unknown question', expect: 'review', answers: { ...base, colour: 'red' } },
      { name: 'an unknown fact', expect: 'review', answers: base, facts: { river: { inside: true } } },
      { name: 'a fact field of the wrong type', expect: 'review', answers: base, facts: { flood: { rank: 'deep' } } },
      { name: 'a bad missing reason', expect: 'review', answers: base, facts: { flood: { missing: 'gone' } } },
    ],
  }, p);
  assert.deepEqual(results.map((r) => [r.status, r.message]), [
    ['error', 'answers: no answer for "clarity"'],
    ['error', 'answers: "colour" is not a question of this profile'],
    ['error', 'facts: "river" is not a fact of this profile'],
    ['error', 'facts.flood.rank: must be a number (or null for no value)'],
    ['error', 'facts.flood: missing must be true or a reason (no_location, no_pr, stale, unavailable, timeout, error), and alone'],
  ]);
});

test('a fact that is not given counts as missing; facts take the shape the engine gives', () => {
  const p = profile('road-restriction-check');
  const answers = { category: 'other', status_matches: true, danger: 0.45, clarity: 3 };
  const results = runCases({
    profile: p.id,
    cases: [
      { name: 'flood not given', expect: 'review', answers },
      // Not inside: the engine gives rank 0 and class "", so rank rules are known (and false).
      { name: 'not inside', expect: 'publish', answers, facts: { flood: { inside: false } } },
      { name: 'inside without rank', expect: 'review', answers, facts: { flood: { inside: true } } },
      { name: 'not inside, with a rank', expect: 'review', answers, facts: { flood: { inside: false, rank: 3 } } },
      { name: 'no inside', expect: 'review', answers, facts: { flood: { rank: 5, class: '3 to 5 m' } } },
    ],
  }, p);
  assert.deepEqual(results.map((r) => [r.status, r.rule ?? r.message]), [
    ['pass', 2], // facts.flood.missing == true and danger.yes >= 0.4
    ['pass', 5],
    ['error', 'facts.flood.rank: needed when inside is true'],
    ['error', 'facts.flood.rank: when inside is false, the engine gives 0; leave it out'],
    ['error', 'facts.flood.inside: give true or false'],
  ]);
  const evacuation = profile('evacuation-access-check');
  const [noName, notFound] = runCases({
    profile: evacuation.id,
    cases: [
      { name: 'a shelter without a name', expect: 'alert', answers: { foot_passable: 0.1 }, facts: { shelter: { found: true, distance_m: 300 }, walk: { possible: true, extra_m: 400 } } },
      { name: 'no shelter found', expect: 'none', answers: { foot_passable: 0.1 }, facts: { shelter: { found: false }, walk: { possible: true, extra_m: 400 } } },
    ],
  }, evacuation);
  assert.equal(noName.status, 'pass');
  assert.equal(notFound.status, 'pass');
});

test('GitHub facts: every field is needed, null only where the engine can give none', () => {
  const p = profile('pr-docs-check');
  const pr = { open: true, merged: false, draft: false, wip_title: false, files: 1, changed_lines: 5, base_is_default: true, author_member: true, author_dependabot: false, fork: false, all_commits_verified: true, pushed_by_author: 'yes', author_sole_code_owner: false };
  const docs = { any: true, all: true, count: 1 };
  const ci = { required: 1, green: true, pending: false, failed: false };
  const answers = { changes_behaviour: 0.1 };
  const results = runCases({
    profile: p.id,
    cases: [
      { name: 'all given', expect: 'light', answers, facts: { pr, docs, ci } },
      { name: 'author not known', expect: 'light', answers, facts: { pr: { ...pr, author_member: null }, docs, ci } },
      { name: 'stale', expect: 'retry', answers, facts: { pr: { missing: 'stale' }, docs, ci } },
      { name: 'a field left out', expect: 'light', answers, facts: { pr, docs: { any: true, all: true }, ci } },
      { name: 'null where the engine always gives a value', expect: 'light', answers, facts: { pr, docs, ci: { ...ci, green: null } } },
    ],
  }, p);
  assert.deepEqual(results.map((r) => [r.status, r.rule ?? r.message]), [
    ['pass', 3],
    ['pass', 3],
    ['pass', 1],
    ['error', 'facts.docs.count: needed'],
    ['error', 'facts.ci.green: needed'],
  ]);
});

test('earlier decisions are checked against the profile they come from', () => {
  const p = profile('road-closure-final');
  const required = { 'road-restriction-check': profile('road-restriction-check'), 'evacuation-access-check': profile('evacuation-access-check') };
  const one = (decisions) => runCases({ profile: p.id, cases: [{ name: 'x', expect: 'review', answers: {}, decisions }] }, p, required)[0];
  assert.equal(one({ check: { action: 'review', outcome: 'reject', reviewed: true } }).got, 'reject');
  assert.equal(one({ check: { outcome: 'urgent' } }).got, 'urgent');
  assert.equal(one({ check: { outcome: 'publish' }, evacuation: 'missing' }).got, 'publish');
  for (const [decisions, message] of [
    [{ check: { outcome: 'publsh' } }, 'decisions.check.action: "publsh" is not an action of road-restriction-check (urgent, review, publish)'],
    [{ check: { outcome: 'reject' } }, 'decisions.check.action: "reject" is not an action of road-restriction-check (urgent, review, publish)'],
    [{ check: { outcome: 'reject', reviewed: true } }, 'decisions.check: give its action (with reviewed: true, the action and the person\'s outcome are separate)'],
    [{ check: { action: 'review', outcome: 'publish' } }, 'decisions.check: without reviewed: true, the outcome is the action'],
    [{ check: { action: 'review', outcome: 'maybe', reviewed: true } }, 'decisions.check.outcome: "maybe" is not an outcome of road-restriction-check (urgent, review, publish, reject)'],
    [{ check: { outcome: 'publish', reviewed: 'yes' } }, 'decisions.check.reviewed: must be true or false'],
    [{ check: { outcome: 'publish', note: 'x' } }, 'decisions.check: unknown field "note"'],
    [{ check: {} }, 'decisions.check: give its action or outcome'],
    [{ other: { outcome: 'publish' } }, 'decisions: "other" is not in this profile\'s requires'],
    [{ check: { outcome: 'publish', answers: { colour: true } } }, 'decisions.check.answers: "colour" is not a question of that profile'],
  ]) {
    const r = one(decisions);
    assert.deepEqual([r.status, r.message], ['error', message], JSON.stringify(decisions));
  }
});

test('the noul boundary and score probabilities follow the normalizer', () => {
  const q = { name: 'q', type: 'noul', instructions: 'x' };
  assert.deepEqual(answerOf(q, 0.5, 'a'), { type: 'noul', value: true, p: 0.5, yes: 0.5 });
  const score = { name: 's', type: 'score', instructions: 'x', criteria: ['a', 'b'] };
  assert.throws(() => answerOf(score, { 1: 0 }, 'answers.s'), /the probabilities cannot all be 0/);
});

test('the file shape is checked before any case runs', () => {
  const p = profile('issue-triage');
  assert.deepEqual(caseFileErrors({ profile: 'other', cases: [] }, p), ['profile: "other" is not "issue-triage"', 'cases: give at least one case']);
  assert.deepEqual(caseFileErrors({
    profile: p.id,
    cases: [
      { name: 'a', expect: 'maybe', answers: {} },
      { name: 'a', expect: 'auto', answers: {}, state: {} },
      { expect: 'auto', state: {}, facts: {}, note: 'x' },
    ],
  }, p), [
    'cases[0].expect: must be one of auto, review',
    'cases[1].name: "a" is used twice',
    'cases[1]: give either answers or state',
    'cases[2]: unknown field "note"',
    'cases[2].name: required',
    'cases[2]: with state, the facts come from the deployment; give facts and decisions only with answers',
  ]);
});

test('the examples pass, with the matching rule as a sentence; a state case is skipped without --url', () => {
  const r = run([join(examples, 'cases'), '--profiles', join(examples, 'profiles')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS {2}a possible danger in a deep flood zone is urgent: urgent\n {9}If the rank of "flood" is at least 5 and /);
  assert.match(r.stdout, /SKIP {2}a real issue about the login page: needs a model: run with --url/);
  assert.match(r.stdout, /\n\d+ passed, 0 failed, 0 could not run, 1 skipped\n$/);
  const ja = run([join(examples, 'cases', 'deploy-progress.yaml'), '--profiles', join(examples, 'profiles'), '--lang', 'ja']);
  assert.match(ja.stdout, /「stuck」が「はい」である確率が 90 % 以上なら、アクションは cancel です。/);
});

test('a changed threshold in a draft makes a case fail, and the exit code says so', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'profiles'));
  const draft = readFileSync(join(examples, 'profiles', 'deploy-progress.yaml'), 'utf8').replace('stuck.yes >= 0.6', 'stuck.yes >= 0.7');
  assert.ok(draft.includes('stuck.yes >= 0.7'));
  writeFileSync(join(dir, 'profiles', 'deploy-progress.yaml'), draft);
  const r = run([join(examples, 'cases', 'deploy-progress.yaml'), '--profiles', join(dir, 'profiles'), '--json']);
  assert.equal(r.status, 1);
  const [file] = JSON.parse(r.stdout);
  const failed = file.results.find((x) => x.status === 'fail');
  assert.deepEqual({ name: failed.name, expect: failed.expect, got: failed.got, why: failed.why }, {
    name: 'maybe stuck goes to a person', expect: 'review', got: 'continue', why: 'If no rule matches, the action is continue.',
  });
});

test('an invalid profile or case file is not run', (t) => {
  const dir = tempDir(t);
  copyFileSync(join(examples, 'cases', 'issue-triage.yaml'), join(dir, 'issue-triage.yaml'));
  writeFileSync(join(dir, 'bad.yaml'), 'profile: issue-triage\ncases: []\n');
  const r = run([dir, '--profiles', join(examples, 'profiles')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.yaml: not run, because:\n {2}cases: give at least one case/);
  // A case file in --profiles is not a profile: refused, not skipped.
  const notProfiles = run([join(dir, 'issue-triage.yaml'), '--profiles', dir]);
  assert.equal(notProfiles.status, 2);
  assert.match(notProfiles.stderr, /bad\.yaml: not a profile \(no id\)|issue-triage\.yaml: not a profile \(no id\)/);
  // Two files with the same id.
  const twice = tempDir(t);
  for (const name of ['a.yaml', 'b.yaml']) copyFileSync(join(examples, 'profiles', 'issue-triage.yaml'), join(twice, name));
  assert.match(run([join(dir, 'issue-triage.yaml'), '--profiles', twice]).stderr, /the id "issue-triage" is also used by/);
  assert.equal(run([dir]).status, 2);
  assert.equal(run([dir, '--profiles', examples, '--url', 'http://localhost:1']).status, 2); // no token
});

/** A fake deployment: answers decide requests like a Worker with a test token. */
async function fakeDeployment(t, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      const [status, json] = answer(req);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** The CLI, without blocking the event loop the fake server needs. */
function runAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const triageAnswers = (team) => ({
  team: { type: 'choice', value: 'backend', p: team, probabilities: { backend: team, frontend: 1 - team } },
  urgent: { type: 'noul', value: false, p: 0.9, yes: 0.1 },
  effort: { type: 'score', value: 0, p: 0.8, score: 0.2, probabilities: { 0: 0.8, 1: 0.2 } },
});

test('with --url, a state case is answered by the deployment and judged by the rules of the file', async (t) => {
  const { url, seen } = await fakeDeployment(t, () => [200, { decision_id: 'x', test: true, profile_version: 1, action: 'auto', rule: 0, answers: triageAnswers(0.9) }]);
  const r = await runAsync([join(examples, 'cases', 'issue-triage.yaml'), '--profiles', join(examples, 'profiles'), '--url', `${url}/`], { POINTSMAN_TOKEN: 'pm_test' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS {2}a real issue about the login page: auto/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/decide/issue-triage');
  assert.equal(seen[0].auth, 'Bearer pm_test');
  assert.equal(seen[0].body.state.issue.title, 'Login page is blank');
});

test('with --url, answers from another deployed version are judged by the file, and it says so', async (t) => {
  const { url } = await fakeDeployment(t, () => [200, { test: true, profile_version: 7, action: 'auto', rule: 0, answers: triageAnswers(0.8) }]);
  const r = await runAsync([join(examples, 'cases', 'issue-triage.yaml'), '--profiles', join(examples, 'profiles'), '--url', url], { POINTSMAN_TOKEN: 'pm_test' });
  // The deployment said auto; the file's rule (team.p >= 0.85) says review.
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}a real issue about the login page: expected auto, got review\n.*\n {9}\(answers from the deployed version 7, rules from the file \(version 1\)\)/);
});

test('with --url, a token that logs decisions is refused after its first answer, and the results so far are shown', async (t) => {
  const { url, seen } = await fakeDeployment(t, () => [200, { profile_version: 1, action: 'auto', rule: 0, answers: triageAnswers(0.9) }]);
  const r = await runAsync([join(examples, 'cases'), '--profiles', join(examples, 'profiles'), '--url', url], { POINTSMAN_TOKEN: 'pm_real' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a test token: that decision was logged \(and may wait for a person\)\. Stopped\./);
  assert.match(r.stdout, /ERROR a real issue about the login page: not a test token: stopped/);
  assert.match(r.stdout, /PASS {2}a sure team is routed automatically/);
  assert.equal(seen.length, 1);
});

test('with --url, a deployed fact that does not fit is not judged', async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'cases'));
  writeFileSync(join(dir, 'cases', 'deploy-progress.yaml'), 'profile: deploy-progress\ncases:\n  - name: a real deploy\n    expect: continue\n    state: { log: still creating }\n');
  // A draft of deploy-progress with a fact the deployment does not have.
  mkdirSync(join(dir, 'profiles'));
  const draft = readFileSync(join(examples, 'profiles', 'deploy-progress.yaml'), 'utf8')
    .replace(/\nquestions:/, '\nfacts:\n  - { name: zone, type: inside, layer: gsi-flood-max, at: $.place }\nquestions:');
  assert.ok(draft.includes('name: zone'));
  writeFileSync(join(dir, 'profiles', 'deploy-progress.yaml'), draft);
  const { url } = await fakeDeployment(t, () => [200, { test: true, profile_version: 1, answers: {
    stuck: { type: 'noul', value: false, p: 0.9, yes: 0.1 },
    phase: { type: 'choice', value: 'creating', p: 1, probabilities: { creating: 1 } },
  } }]);
  const r = await runAsync([join(dir, 'cases'), '--profiles', join(dir, 'profiles'), '--url', url], { POINTSMAN_TOKEN: 'pm_test' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ERROR a real deploy: the deployed profile has no fact "zone"; publish the facts first, or give answers and facts/);
});

test('with --url, the token goes only over https or to localhost, and a non-JSON answer is an error', async (t) => {
  const args = [join(examples, 'cases', 'issue-triage.yaml'), '--profiles', join(examples, 'profiles')];
  assert.equal(run([...args, '--url', 'http://pointsman.example.com'], { POINTSMAN_TOKEN: 'pm_test' }).status, 2);
  assert.equal(run([...args, '--url', 'not a url'], { POINTSMAN_TOKEN: 'pm_test' }).status, 2);
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'text/plain' }).end('hello'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const r = await runAsync([...args, '--url', `http://127.0.0.1:${server.address().port}/prefix`], { POINTSMAN_TOKEN: 'pm_test' });
  assert.match(r.stdout, /ERROR a real issue about the login page: the deployment did not answer with JSON/);
  assert.deepEqual(seen, ['/prefix/v1/decide/issue-triage']);
});

test('with --url, answers that do not fit the questions, or an error, cannot be judged', async (t) => {
  const misfit = await fakeDeployment(t, () => [200, { test: true, profile_version: 1, answers: { team: triageAnswers(0.9).team } }]);
  const a = await runAsync([join(examples, 'cases', 'issue-triage.yaml'), '--profiles', join(examples, 'profiles'), '--url', misfit.url], { POINTSMAN_TOKEN: 'pm_test' });
  assert.equal(a.status, 1);
  assert.match(a.stdout, /ERROR a real issue about the login page: the deployed profile has no noul answer for "urgent"; publish the questions first, or give answers/);
  const down = await fakeDeployment(t, () => [403, { error: { code: 'forbidden', message: 'this token may not use this profile' } }]);
  const b = await runAsync([join(examples, 'cases', 'issue-triage.yaml'), '--profiles', join(examples, 'profiles'), '--url', down.url], { POINTSMAN_TOKEN: 'pm_test' });
  assert.match(b.stdout, /ERROR a real issue about the login page: the deployment answered 403: this token may not use this profile/);
});
