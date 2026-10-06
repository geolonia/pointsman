import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'tokens.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

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

test('revoke deletes the key for a hash', () => {
  const hash = 'a'.repeat(64);
  const r = run('revoke', '--hash', hash, '--remote', '--config', 'other.jsonc', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`kv key delete token:${hash} --binding TOKENS --remote --config other.jsonc`));
});

for (const [name, args, message] of [
  ['no target', ['create', '--client', 'demo', '--profiles', '*'], /exactly one of --local or --remote/],
  ['both targets', ['list', '--local', '--remote'], /exactly one of --local or --remote/],
  ['no command', ['--local'], /Usage/],
  ['an unknown command', ['rotate', '--local'], /Usage/],
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
