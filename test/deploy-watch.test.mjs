// actions/deploy-watch with a fake `aws` CLI (on PATH), a fake Pointsman server
// and `sleep` as the deploy command. Intervals are scaled down to run fast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const script = fileURLToPath(new URL('../actions/deploy-watch/watch.mjs', import.meta.url));

/** Fake aws: events are `ageSeconds` old (or fresh on every call), status from a file. */
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_AWS_CONFIG, 'utf8'));
const [, , , cmd, , stack] = process.argv;
fs.appendFileSync(process.env.FAKE_AWS_LOG, process.argv.slice(2).join(' ') + '\\n');
if (cfg.missing) { process.stderr.write('Stack with id ' + stack + ' does not exist'); process.exit(254); }
if (cmd === 'describe-stack-events') {
  const t = new Date(Date.now() - cfg.ageSeconds * 1000).toISOString();
  console.log(JSON.stringify({ StackEvents: [{ Timestamp: t, LogicalResourceId: 'Fn', ResourceType: 'AWS::Lambda::Function', ResourceStatus: 'UPDATE_IN_PROGRESS', ResourceStatusReason: 'Waiting' }] }));
} else if (cmd === 'describe-stacks') {
  console.log(JSON.stringify({ Stacks: [{ StackStatus: cfg.status }] }));
} else if (cmd === 'cancel-update-stack') {
  console.log('{}');
}
`;

async function pointsman(actions) {
  const asked = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      asked.push(JSON.parse(body));
      const action = actions[Math.min(asked.length - 1, actions.length - 1)];
      if (action === 500) return res.writeHead(500).end('{}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ decision_id: `d${asked.length}`, action }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((r) => server.close(r)) };
}

function runWatch(t, { url, command, aws = { ageSeconds: 3600, status: 'UPDATE_IN_PROGRESS' }, inputs = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'aws'), FAKE_AWS);
  chmodSync(join(dir, 'aws'), 0o755);
  writeFileSync(join(dir, 'aws.json'), JSON.stringify(aws));
  writeFileSync(join(dir, 'output'), '');
  const env = {
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_AWS_CONFIG: join(dir, 'aws.json'),
    FAKE_AWS_LOG: join(dir, 'aws.log'),
    GITHUB_OUTPUT: join(dir, 'output'),
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_RUN_ID: '1',
    INPUT_RUN: command,
    INPUT_STACKS: 'AppStack',
    INPUT_URL: url,
    INPUT_TOKEN: 'pm_test',
    'INPUT_QUIET-MINUTES': '0.001',
    'INPUT_INTERVAL-SECONDS': '0.1',
    ...inputs,
  };
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], { env });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', (code) => resolve({
      code,
      stdout,
      seconds: (Date.now() - started) / 1000,
      output: readFileSync(join(dir, 'output'), 'utf8'),
      aws: existsSync(join(dir, 'aws.log')) ? readFileSync(join(dir, 'aws.log'), 'utf8') : '',
    }));
  });
}

test('a stuck deploy is stopped after two consecutive cancel answers', async (t) => {
  const p = await pointsman(['cancel']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'sleep 30' });
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.seconds < 10, `stopped early (${r.seconds}s)`);
  assert.equal(p.asked.length, 2);
  assert.match(r.output, /^result=cancelled$/m);
  assert.match(r.stdout, /::error::Deploy stopped/);
  assert.match(r.aws, /cancel-update-stack --stack-name AppStack/);
  // Pointsman gets the recent events and how long the stack has been quiet.
  assert.equal(p.asked[0].state.stacks[0].stack, 'AppStack');
  assert.equal(p.asked[0].state.stacks[0].events[0].status, 'UPDATE_IN_PROGRESS');
  assert.equal(typeof p.asked[0].state.minutes_since_last_event, 'number');
});

test('a slow deploy with new events is not judged and finishes', async (t) => {
  const p = await pointsman(['cancel']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'sleep 1', aws: { ageSeconds: 0, status: 'UPDATE_IN_PROGRESS' }, inputs: { 'INPUT_QUIET-MINUTES': '1' } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(p.asked.length, 0);
  assert.match(r.output, /^result=finished$/m);
});

test('a quiet deploy that Pointsman calls slow, not stuck, is not stopped', async (t) => {
  const p = await pointsman(['continue']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'sleep 1' });
  assert.equal(r.code, 0, r.stdout);
  assert.ok(p.asked.length >= 2);
  assert.doesNotMatch(r.aws, /cancel-update-stack/);
});

test('cancel answers that are not consecutive do not stop the deploy', async (t) => {
  const p = await pointsman(['cancel', 'review', 'cancel', 'continue', 'cancel', 'continue', 'cancel', 'continue', 'cancel', 'continue', 'cancel', 'continue']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'sleep 1' });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.output, /^result=finished$/m);
});

test('a failing Pointsman never stops the deploy', async (t) => {
  const p = await pointsman([500]);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'sleep 1' });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Pointsman answered HTTP 500; the deploy keeps running/);
});

test('the command exit code is passed on', async (t) => {
  const p = await pointsman(['continue']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'exit 3' });
  assert.equal(r.code, 3);
});

test('a stack that does not exist yet counts as quiet since the start', async (t) => {
  const p = await pointsman(['continue']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'sleep 1', aws: { missing: true } });
  assert.equal(r.code, 0, r.stdout);
  assert.ok(p.asked.length >= 1);
  assert.deepEqual(p.asked[0].state.stacks, []);
});

test('cancel-update: false only stops the command', async (t) => {
  const p = await pointsman(['cancel']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: 'sleep 30', inputs: { 'INPUT_CANCEL-UPDATE': 'false' } });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.aws, /cancel-update-stack/);
});

test('a command that ignores SIGTERM is killed after the grace time', async (t) => {
  const p = await pointsman(['cancel']);
  t.after(p.close);
  const r = await runWatch(t, { url: p.url, command: "trap '' TERM; sleep 30 & wait; sleep 30", inputs: { 'INPUT_KILL-AFTER-SECONDS': '0.5' } });
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.seconds < 10, `ended after ${r.seconds}s`);
  assert.match(r.stdout, /sending SIGKILL/);
  assert.match(r.output, /^result=cancelled$/m);
});

for (const [name, inputs, message] of [
  ['a stack name with shell syntax', { INPUT_STACKS: 'App;rm -rf /' }, /must be CloudFormation stack names/],
  ['a plain http url', { INPUT_URL: 'http://pointsman.example.com' }, /must be an https URL/],
  ['a url with a query', { INPUT_URL: 'https://example.com?x=1' }, /must not contain a query/],
  ['a missing token', { INPUT_TOKEN: '' }, /input "token" is required/],
  ['a non-numeric interval', { 'INPUT_INTERVAL-SECONDS': 'soon' }, /must be a number/],
  ['zero consecutive', { INPUT_CONSECUTIVE: '0' }, /must be a number >= 1/],
]) {
  test(`stops on ${name} before running the command`, async (t) => {
    const p = await pointsman(['cancel']);
    t.after(p.close);
    const r = await runWatch(t, { url: p.url, command: 'echo SHOULD-NOT-RUN', inputs });
    assert.equal(r.code, 1);
    assert.match(r.stdout, message);
    assert.doesNotMatch(r.stdout, /SHOULD-NOT-RUN/);
  });
}
