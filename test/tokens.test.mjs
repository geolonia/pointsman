import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'tokens.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
// The stored tokens a dry run sees, as wrangler's `kv key list` prints them.
const stored = (...tokens) => JSON.stringify(tokens.map(([hash, metadata]) => ({ name: `token:${hash}`, metadata })));
const runWith = (list, ...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, TOKENS_DRY_RUN_LIST: list } });
const writes = (stdout) => stdout.split('\n').filter((l) => l.startsWith('[dry-run] wrangler'));

test('create prints the token once and passes only its hash to wrangler', () => {
  const r = run('create', '--client', 'demo', '--profiles', 'issue-triage,deploy-progress', '--local', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const token = r.stdout.match(/^(pm_[A-Za-z0-9_-]{43})$/m)?.[1];
  assert.ok(token, r.stdout);
  const hash = createHash('sha256').update(token).digest('hex');

  const command = r.stdout.split('\n').find((l) => l.startsWith('[dry-run] wrangler'));
  assert.ok(command.includes(`kv key put token:${hash} `), command);
  assert.ok(command.includes('--binding TOKENS --local'), command);
  assert.ok(!command.includes(token), 'the token must not be passed to wrangler');
  assert.match(command, /"profiles":\["issue-triage","deploy-progress"\]/);
  assert.equal(r.stdout.split(token).length - 1, 1, 'the token is printed exactly once');
});

test('create --test marks the token as a test token', () => {
  const r = run('create', '--client', 'examples-check', '--profiles', 'road-restriction-check', '--test', '--local', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const command = r.stdout.split('\n').find((l) => l.startsWith('[dry-run] wrangler'));
  assert.match(command, /"test":true/);
  assert.match(r.stdout, /test token: not logged, decide only/);
  const normal = run('create', '--client', 'demo', '--profiles', '*', '--local', '--dry-run');
  assert.doesNotMatch(normal.stdout, /"test"/);
});

test('revoke deletes the key for a hash', () => {
  const hash = 'a'.repeat(64);
  const r = run('revoke', '--hash', hash, '--remote', '--config', 'other.jsonc', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`kv key delete token:${hash} --binding TOKENS --remote --config other.jsonc`));
});

test('create refuses a client name that already has a token', () => {
  const r = runWith(stored(['a'.repeat(64), { client: 'demo', profiles: ['*'] }]), 'create', '--client', 'demo', '--profiles', '*', '--local', '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /already has a token: use `rotate --client demo`/);
  assert.deepEqual(writes(r.stdout), []);
});

test('rotate creates a token with the same name, profiles and test flag, then revokes the old ones', () => {
  const old = [['a'.repeat(64), { client: 'demo', profiles: ['x', 'y'], test: true }], ['b'.repeat(64), { client: 'demo', profiles: ['x', 'y'], test: true }]];
  const r = runWith(stored(...old, ['c'.repeat(64), { client: 'other', profiles: ['*'] }]), 'rotate', '--client', 'demo', '--local', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const [put, ...deletes] = writes(r.stdout);
  assert.match(put, /kv key put token:[0-9a-f]{64} /);
  assert.match(put, /"client":"demo","profiles":\["x","y"\]/);
  assert.match(put, /"test":true/);
  assert.deepEqual(deletes.map((l) => l.match(/delete token:([0-9a-f]{64})/)[1]), ['a'.repeat(64), 'b'.repeat(64)]);
});

test('rotate --keep-old keeps the old token and --profiles changes the scope', () => {
  const r = runWith(stored(['a'.repeat(64), { client: 'demo', profiles: ['x'] }]), 'rotate', '--client', 'demo', '--profiles', 'y', '--keep-old', '--remote', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const lines = writes(r.stdout);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"profiles":\["y"\]/);
  assert.doesNotMatch(lines[0], /"test"/);
  assert.match(r.stdout, new RegExp(`revoke --hash ${'a'.repeat(64)} --remote`));
});

for (const [name, list, args, message] of [
  ['a client without a token', stored(), ['--client', 'demo'], /has no token; use create/],
  ['--test', stored(['a'.repeat(64), { client: 'demo', profiles: ['*'] }]), ['--client', 'demo', '--test'], /leave out --test/],
  ['mixed test and normal tokens', stored(['a'.repeat(64), { client: 'demo', profiles: ['*'] }], ['b'.repeat(64), { client: 'demo', profiles: ['*'], test: true }]), ['--client', 'demo'], /both test and normal/],
  ['tokens with different profiles', stored(['a'.repeat(64), { client: 'demo', profiles: ['x'] }], ['b'.repeat(64), { client: 'demo', profiles: ['y'] }]), ['--client', 'demo'], /give --profiles/],
]) {
  test(`rotate refuses ${name}`, () => {
    const r = runWith(list, 'rotate', ...args, '--local', '--dry-run');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, message);
    assert.deepEqual(writes(r.stdout), []);
  });
}

test('list marks names used by several tokens', () => {
  const r = runWith(stored(['a'.repeat(64), { client: 'demo', profiles: ['*'] }], ['b'.repeat(64), { client: 'demo', profiles: ['*'] }], ['c'.repeat(64), { client: 'solo', profiles: ['x'] }]), 'list', '--local', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.filter((l) => l.includes('rotate or rename')).length, 2);
  assert.doesNotMatch(lines.find((l) => l.includes('solo')), /rotate or rename/);
});

for (const [name, args, message] of [
  ['no target', ['create', '--client', 'demo', '--profiles', '*'], /exactly one of --local or --remote/],
  ['both targets', ['list', '--local', '--remote'], /exactly one of --local or --remote/],
  ['no command', ['--local'], /Usage/],
  ['an unknown command', ['renew', '--local'], /Usage/],
  ['an unknown option', ['list', '--local', '--force'], /Unknown option/],
  ['a bad client name', ['create', '--client', 'Demo App', '--profiles', '*', '--local'], /--client/],
  ['no profiles', ['create', '--client', 'demo', '--local'], /--profiles/],
  ['a bad profile id', ['create', '--client', 'demo', '--profiles', 'a,B!', '--local'], /--profiles/],
  ['* with ids', ['create', '--client', 'demo', '--profiles', '*,a', '--local'], /cannot be combined/],
  ['a bad hash', ['revoke', '--hash', 'pm_abc', '--local'], /--hash/],
]) {
  test(`rejects ${name}`, () => {
    const r = run(...args, '--dry-run');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stdout, /\[dry-run\]/, 'nothing is written');
  });
}
