// scripts/replay-profile.mjs: send a draft's policy to a deployment for a replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const examples = join(root, 'examples', 'profiles');
const cli = join(root, 'scripts', 'replay-profile.mjs');
const triage = join(examples, 'issue-triage.yaml');

function runAsync(args, env = { POINTSMAN_TOKEN: 'pm_real' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const run = (args, env = { POINTSMAN_TOKEN: 'pm_real' }) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, POINTSMAN_TOKEN: '', ...env } });

async function fakeDeployment(t, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      const [status, json] = answer();
      res.writeHead(status, { 'content-type': 'application/json' }).end(typeof json === 'string' ? json : JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

const result = {
  profile: 'issue-triage', version: 1, replayed: 118, from: '2026-10-14T01:00:00.000Z', to: '2026-10-21T03:00:00.000Z',
  inexact: 0, skipped: 2, changed: 2,
  actions: { before: { auto: 80, review: 40 }, after: { auto: 82, review: 38 } },
  transitions: [{ from: 'review', to: 'auto', count: 2 }],
  people: { before: 40, after: 38, checked: 30, matched: 12 },
  changes: [
    { decision_id: '00000000-0000-4000-8000-000000000001', created_at: '2026-10-21T02:00:00.000Z', ref: 'gh#12', before: { action: 'review', rule: null }, after: { action: 'auto', rule: 0 }, person: 'auto' },
    { decision_id: '00000000-0000-4000-8000-000000000002', created_at: '2026-10-20T02:00:00.000Z', before: { action: 'review', rule: null }, after: { action: 'auto', rule: 0 } },
  ],
};

test('sends the policy, with questions, facts and requires to check, and prints what would change', async (t) => {
  const { url, seen } = await fakeDeployment(t, () => [200, result]);
  const r = await runAsync([triage, '--url', `${url}/base`, '--limit', '120']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen.length, 1);
  const [req] = seen;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/base/v1/profiles/issue-triage/replay');
  assert.equal(req.auth, 'Bearer pm_real');
  assert.deepEqual(Object.keys(req.body).sort(), ['facts', 'limit', 'policy', 'questions', 'requires']);
  assert.equal(req.body.limit, 120);
  assert.deepEqual(req.body.policy.rules, [{ when: 'team.p >= 0.85', action: 'auto' }]);
  assert.match(r.stdout, /^issue-triage: the draft's rules on 118 decisions of version 1 \(2026-10-14 01:00 to 2026-10-21 03:00 UTC\)\./);
  assert.match(r.stdout, /\n {2}Not replayed: 0 \(a value of an earlier decision was not kept\), 2 \(an answer is not in the log\)\.\n {2}2 would get another action\.\n {4}review → auto: 2\n/);
  assert.match(r.stdout, /\n {2}To a person: 40 now, 38 with the new rules\.\n {2}Of the 30 a person answered, the new rules give the person's answer for 12\./);
  assert.match(r.stdout, /\n {4}2026-10-21 02:00 review → auto \(gh#12, person: auto\)\n {6}If the AI's certainty about "team" is at least 85 %, the action is auto\.\n/);
  const ja = await runAsync([triage, '--url', url, '--lang', 'ja']);
  assert.match(ja.stdout, /人に回る判定：今は 40 件、新しいルールでは 38 件。/);
  const json = await runAsync([triage, '--url', url, '--json', '--version', '1']);
  assert.deepEqual(JSON.parse(json.stdout), result);
});

test('shows the deployment\'s error, and exits 1', async (t) => {
  const { url } = await fakeDeployment(t, () => [409, { error: { code: 'not_policy_only', message: "the draft's questions differ from version 1" } }]);
  const r = await runAsync([triage, '--url', url]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /The deployment answered 409: not_policy_only: the draft's questions differ from version 1/);
  const broken = await fakeDeployment(t, () => [200, 'not json']);
  assert.match((await runAsync([triage, '--url', broken.url])).stderr, /The deployment answered 200 \(not JSON\)/);
  const old = await fakeDeployment(t, () => [200, { profile: 'issue-triage' }]);
  const r2 = await runAsync([triage, '--url', old.url]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /not a replay \(an older Pointsman\?\)/);
});

test('does not send an invalid draft, or to an unsafe URL, or without a token', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const draft = join(dir, 'issue-triage.yaml');
  writeFileSync(draft, readFileSync(triage, 'utf8').replace('team.p >= 0.85', 'squad.p >= 0.85'));
  const invalid = run([draft, '--url', 'https://pointsman.example.com']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /is not valid, so it is not replayed:\n {2}.*"squad\.p" does not refer to a question/);
  assert.equal(run([triage, '--url', 'http://pointsman.example.com']).status, 2);
  assert.equal(run([triage, '--url', 'https://pointsman.example.com'], {}).status, 2);
  assert.equal(run([triage]).status, 2);
  assert.equal(run([triage, '--url', 'https://x.example', '--limit', '0']).status, 2);
  assert.equal(run([triage, '--url', 'https://x.example', '--limit', '501']).status, 2);
});
