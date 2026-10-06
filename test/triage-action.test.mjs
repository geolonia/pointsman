// actions/triage against fake Pointsman and GitHub servers on localhost, run
// the way GitHub runs a JavaScript action (inputs as INPUT_* variables).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { labelsFor, parseBaseUrl, parseLabelMap } from '../actions/triage/triage.mjs';

const script = fileURLToPath(new URL('../actions/triage/triage.mjs', import.meta.url));
const LABELS = 'team=backend: team/backend\nteam=frontend: team/frontend\nurgent=true: urgent\n# comment\neffort=0: good first issue';

const decision = (action, answers) => ({
  decision_id: '00000000-0000-4000-8000-000000000001',
  action,
  answers,
  profile: 'issue-triage',
  profile_version: 1,
  model: 'clef-flash',
});
const AUTO = decision('auto', {
  team: { type: 'choice', value: 'frontend', p: 0.95 },
  urgent: { type: 'noul', value: true, p: 0.8, yes: 0.8 },
  effort: { type: 'score', value: 2, p: 0.5 },
  extra: { type: 'choice', value: 'anything', p: 1 },
});

/** Start fake Pointsman + GitHub; returns their URL, received requests, close(). */
async function servers(pointsman) {
  const seen = { decide: [], labels: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/v1/decide/')) {
        seen.decide.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        const [status, payload] = pointsman;
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      } else if (req.url.endsWith('/labels')) {
        seen.labels.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Run the action like GitHub does; resolves with exit code, stdout and the files it wrote. */
function runAction(t, { url, inputs = {}, event }) {
  const dir = mkdtempSync(join(tmpdir(), 'pointsman-action-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { event: join(dir, 'event.json'), output: join(dir, 'output'), summary: join(dir, 'summary') };
  writeFileSync(files.event, JSON.stringify(event));
  writeFileSync(files.output, '');
  writeFileSync(files.summary, '');
  const env = {
    PATH: process.env.PATH,
    GITHUB_EVENT_PATH: files.event,
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_API_URL: url,
    INPUT_URL: url,
    INPUT_TOKEN: 'pm_test',
    INPUT_PROFILE: 'issue-triage',
    INPUT_LABELS: LABELS,
    'INPUT_REVIEW-LABEL': 'needs-triage',
    'INPUT_GITHUB-TOKEN': 'gh_test',
    ...inputs,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', (code) => resolve({
      code,
      stdout,
      output: readFileSync(files.output, 'utf8'),
      summary: readFileSync(files.summary, 'utf8'),
    }));
  });
}

const issueEvent = (title = 'Login page is blank', body = 'White screen since this morning.') => ({
  action: 'opened',
  issue: { number: 42, title, body },
});

test('auto: applies only the mapped labels', async (t) => {
  const s = await servers([200, AUTO]);
  t.after(s.close);
  const r = await runAction(t, { url: s.url, event: issueEvent() });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(s.seen.labels.map((l) => l.body.labels), [['team/frontend', 'urgent']]);
  assert.equal(s.seen.labels[0].url, '/repos/example/repo/issues/42/labels');
  assert.equal(s.seen.labels[0].auth, 'Bearer gh_test');
  assert.match(r.output, /^action=auto$/m);
  assert.match(r.output, /^decision-id=00000000-0000-4000-8000-000000000001$/m);
});

test('the issue is sent as JSON data, with the token and a ref', async (t) => {
  const s = await servers([200, AUTO]);
  t.after(s.close);
  const title = '"; rm -rf / $(curl evil) `id` ${{ secrets.X }}';
  const r = await runAction(t, { url: s.url, event: issueEvent(title, 'body\n```\n$(whoami)') });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(s.seen.decide[0].url, '/v1/decide/issue-triage');
  assert.equal(s.seen.decide[0].auth, 'Bearer pm_test');
  assert.deepEqual(s.seen.decide[0].body, {
    state: { issue: { title, body: 'body\n```\n$(whoami)' } },
    ref: 'github:example/repo#42',
  });
  assert.ok(!r.summary.includes('rm -rf'), 'the issue text is not written to the summary');
});

test('review: adds only the review label, no team labels', async (t) => {
  const s = await servers([200, decision('review', AUTO.answers)]);
  t.after(s.close);
  const r = await runAction(t, { url: s.url, event: issueEvent() });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(s.seen.labels.map((l) => l.body.labels), [['needs-triage']]);
  assert.match(r.output, /^action=review$/m);
});

test('a custom action is treated like review', async (t) => {
  const s = await servers([200, decision('escalate', AUTO.answers)]);
  t.after(s.close);
  await runAction(t, { url: s.url, event: issueEvent() });
  assert.deepEqual(s.seen.labels.map((l) => l.body.labels), [['needs-triage']]);
});

test('Pointsman failing: review label, and the step fails', async (t) => {
  const s = await servers([502, { error: { code: 'model_error', message: 'x' } }]);
  t.after(s.close);
  const r = await runAction(t, { url: s.url, event: issueEvent() });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error::Pointsman answered HTTP 502 \(model_error\)/);
  assert.deepEqual(s.seen.labels.map((l) => l.body.labels), [['needs-triage']]);
  assert.match(r.output, /^action=error$/m);
});

test('Pointsman unreachable: review label, and the step fails', async (t) => {
  const s = await servers([200, AUTO]);
  t.after(s.close);
  const r = await runAction(t, { url: s.url, inputs: { INPUT_URL: 'http://127.0.0.1:1' }, event: issueEvent() });
  assert.equal(r.code, 1);
  assert.deepEqual(s.seen.labels.map((l) => l.body.labels), [['needs-triage']]);
});

for (const [name, inputs, event, message] of [
  ['a malformed label mapping', { INPUT_LABELS: 'team frontend' }, issueEvent(), /labels line 1/],
  ['an empty label mapping', { INPUT_LABELS: '# nothing' }, issueEvent(), /no mappings/],
  ['a missing token', { INPUT_TOKEN: '' }, issueEvent(), /input "token" is required/],
  ['a non-http url', { INPUT_URL: 'file:///etc/passwd' }, issueEvent(), /must be an https URL/],
  ['a plain http url', { INPUT_URL: 'http://pointsman.example.com' }, issueEvent(), /must be an https URL/],
  ['a url without host', { INPUT_URL: 'https://' }, issueEvent(), /not a valid URL/],
  ['a url with a query', { INPUT_URL: 'https://example.com?tenant=a' }, issueEvent(), /must not contain a query/],
  ['a url with credentials', { INPUT_URL: 'https://user:pw@example.com' }, issueEvent(), /must not contain/],
  ['a too long review label', { 'INPUT_REVIEW-LABEL': 'x'.repeat(51) }, issueEvent(), /review-label/],
  ['a non-issue event', {}, { action: 'opened', pull_request: { number: 1 } }, /issues events/],
  ['an issue_comment event', { GITHUB_EVENT_NAME: 'issue_comment' }, { action: 'created', issue: { number: 42, title: 't', body: 'b' }, comment: { body: 'c' } }, /issues events/],
  ['a closed issue', {}, { action: 'closed', issue: { number: 42, title: 't', body: 'b' } }, /issues events/],
  ['a pull request in an issues event', {}, { action: 'opened', issue: { number: 42, title: 't', body: 'b', pull_request: {} } }, /issues events/],
]) {
  test(`stops on ${name} before calling anything`, async (t) => {
    const s = await servers([200, AUTO]);
    t.after(s.close);
    const r = await runAction(t, { url: s.url, inputs, event });
    assert.equal(r.code, 1);
    assert.match(r.stdout, message);
    assert.equal(s.seen.decide.length + s.seen.labels.length, 0);
  });
}

test('a reopened issue is triaged too', async (t) => {
  const s = await servers([200, AUTO]);
  t.after(s.close);
  const r = await runAction(t, { url: s.url, event: { ...issueEvent(), action: 'reopened' } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(s.seen.decide.length, 1);
});

test('parseLabelMap and labelsFor', () => {
  const map = parseLabelMap(LABELS);
  assert.equal(map.get('team=frontend'), 'team/frontend');
  assert.equal(map.get('effort=0'), 'good first issue');
  assert.deepEqual(labelsFor(decision('auto', { effort: { value: 0 }, urgent: { value: false } }), map, 'x'), ['good first issue']);
  assert.deepEqual(labelsFor(decision('auto', {}), map, 'x'), []);
  assert.deepEqual(labelsFor(decision('review', AUTO.answers), map, 'x'), ['x']);
});

test('parseBaseUrl keeps a path and drops a trailing slash', () => {
  assert.equal(parseBaseUrl('https://pointsman.example.workers.dev/'), 'https://pointsman.example.workers.dev');
  assert.equal(parseBaseUrl('https://example.com/pointsman/'), 'https://example.com/pointsman');
});
