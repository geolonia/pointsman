import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
  const r = runWith(stored([hash, { client: 'demo', profiles: ['*'] }]), 'revoke', '--hash', hash, '--remote', '--config', 'other.jsonc', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`kv key delete token:${hash} --binding TOKENS --remote --config other.jsonc`));
});

test('revoke refuses a hash that no token has (#259)', () => {
  const r = runWith(stored(['a'.repeat(64), { client: 'demo', profiles: ['*'] }]), 'revoke', '--hash', 'b'.repeat(64), '--local', '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no token with the hash b{64}/);
  assert.deepEqual(writes(r.stdout), []);
});

test('create refuses a token record larger than KV metadata takes (#259)', () => {
  const profiles = Array.from({ length: 40 }, (_, i) => `a-rather-long-profile-id-${i}`).join(',');
  const r = run('create', '--client', 'demo', '--profiles', profiles, '--local', '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /KV metadata takes at most 1024/);
  assert.deepEqual(writes(r.stdout), []);
  assert.doesNotMatch(r.stdout, /pm_/);
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

test('rotate --keep-old prints the revoke command with the same --config', () => {
  const list = stored(['a'.repeat(64), { client: 'demo', profiles: ['x'] }]);
  // rotate reads the config for INTERNAL_CLIENT (#275), so the files exist, in a folder of their own.
  const dir = mkdtempSync(join(tmpdir(), 'tokens-config-'));
  mkdirSync(join(dir, 'deploy'));
  for (const config of ['deploy/wrangler.jsonc', "my config's.jsonc", '-x.jsonc']) writeFileSync(join(dir, config), '{}');
  for (const [config, shown] of [
    ['deploy/wrangler.jsonc', 'deploy/wrangler.jsonc'],
    ["my config's.jsonc", `'my config'\\''s.jsonc'`],
    ['-x.jsonc', '-x.jsonc'],
  ]) {
    const r = spawnSync(process.execPath, [script, 'rotate', '--client', 'demo', '--keep-old', '--remote', `--config=${config}`, '--dry-run'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, TOKENS_DRY_RUN_LIST: list } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`revoke --hash ${'a'.repeat(64)} --remote --config=${shown}\n`), r.stdout);
    // The script's path as started, so the command also works from a configuration repository (engine/scripts/...).
    assert.match(r.stdout, /\n {2}node \S*scripts\/tokens\.mjs revoke /);
  }
  // --local stays --local, and no --config is added when none was given.
  const local = runWith(list, 'rotate', '--client', 'demo', '--keep-old', '--local', '--dry-run');
  assert.equal(local.status, 0, local.stderr);
  assert.ok(local.stdout.includes(`revoke --hash ${'a'.repeat(64)} --local\n`), local.stdout);
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

test('create --expires stores the expiry and lets KV delete the key then', () => {
  const r = run('create', '--client', 'demo', '--profiles', '*', '--expires', '90d', '--local', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const [command] = writes(r.stdout);
  const at = Date.parse(command.match(/"expires_at":"([^"]+)"/)[1]);
  assert.ok(Math.abs(at - (Date.now() + 90 * 86400_000)) < 60_000, command);
  assert.match(command, new RegExp(`--expiration ${Math.floor(at / 1000)}(\\s|$)`));
  assert.match(r.stdout, /^expires: /m);
  const day = run('create', '--client', 'demo', '--profiles', '*', '--expires', '2099-01-31', '--local', '--dry-run');
  assert.match(writes(day.stdout)[0], /"expires_at":"2099-01-31T23:59:59.000Z"/);
  // Without --expires, no expiry at all.
  assert.doesNotMatch(writes(run('create', '--client', 'demo', '--profiles', '*', '--local', '--dry-run').stdout)[0], /expir/);
});

for (const [name, value] of [['a word', 'soon'], ['a past date', '2020-01-01'], ['a day that does not exist', '2099-02-30'], ['less than an hour', '0h'], ['a unit it does not know', '3m']]) {
  test(`create --expires refuses ${name}`, () => {
    const r = run('create', '--client', 'demo', '--profiles', '*', '--expires', value, '--local', '--dry-run');
    assert.equal(r.status, 2);
    assert.equal(writes(r.stdout).length, 0);
  });
}

test('rotate asks for --expires or --no-expiry when the old token had an expiry', () => {
  const old = stored(['a'.repeat(64), { client: 'demo', profiles: ['*'], created_at: '2026-10-01T00:00:00Z', expires_at: '2026-12-01T00:00:00.000Z' }]);
  const refused = runWith(old, 'rotate', '--client', 'demo', '--local', '--dry-run');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--expires <when> for the new one, or --no-expiry/);
  assert.equal(writes(refused.stdout).length, 0);
  const renewed = runWith(old, 'rotate', '--client', 'demo', '--expires', '30d', '--local', '--dry-run');
  assert.equal(renewed.status, 0, renewed.stderr);
  assert.match(writes(renewed.stdout)[0], /"expires_at"/);
  const open = runWith(old, 'rotate', '--client', 'demo', '--no-expiry', '--local', '--dry-run');
  assert.equal(open.status, 0, open.stderr);
  assert.doesNotMatch(writes(open.stdout)[0], /expir/);
  assert.equal(runWith(old, 'rotate', '--client', 'demo', '--expires', '30d', '--no-expiry', '--local', '--dry-run').status, 2);
});

test('list shows the expiry, and marks an expired token', () => {
  const r = runWith(stored(
    ['a'.repeat(64), { client: 'later', profiles: ['*'], created_at: '', expires_at: '2099-01-01T00:00:00.000Z' }],
    ['b'.repeat(64), { client: 'gone', profiles: ['*'], created_at: '', expires_at: '2020-01-01T00:00:00.000Z' }],
    ['c'.repeat(64), { client: 'odd', profiles: ['*'], created_at: '', expires_at: 'soon' }],
  ), 'list', '--local', '--dry-run');
  assert.match(r.stdout, /odd .*expires soon \(unreadable: refused\)$/m);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /later .*expires 2099-01-01T00:00:00.000Z$/m);
  assert.match(r.stdout, /gone .*expires 2020-01-01T00:00:00.000Z \(expired\)$/m);
});

// #275: a token must not share its client name with INTERNAL_CLIENT, at the
// top level or in an environment of the Wrangler config.
const internalConfig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-internal-'));
  const file = join(dir, 'wrangler.jsonc');
  const client = (name) => JSON.stringify({ client: name, profiles: ['pr-docs-check'] });
  writeFileSync(file, `{
  // a comment, as in a real config
  "name": "engine",
  "vars": { "INTERNAL_CLIENT": ${JSON.stringify(client('github-connector'))} },
  "env": { "staging": { "vars": { "INTERNAL_CLIENT": ${JSON.stringify(client('staging-connector'))} } } },
}`);
  return file;
};

test('create refuses the client name of INTERNAL_CLIENT (#275)', () => {
  const config = internalConfig();
  for (const name of ['github-connector', 'staging-connector']) {
    const r = run('create', '--client', name, '--profiles', '*', '--local', '--config', config, '--dry-run');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`"${name}" is the client of INTERNAL_CLIENT`));
    assert.deepEqual(writes(r.stdout), []);
  }
  const other = run('create', '--client', 'demo', '--profiles', '*', '--local', '--config', config, '--dry-run');
  assert.equal(other.status, 0, other.stderr);
});

test('rotate refuses the client name of INTERNAL_CLIENT (#275)', () => {
  const r = runWith(stored(['a'.repeat(64), { client: 'github-connector', profiles: ['*'] }]),
    'rotate', '--client', 'github-connector', '--local', '--config', internalConfig(), '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /is the client of INTERNAL_CLIENT/);
  assert.deepEqual(writes(r.stdout), []);
});

test('list marks a token with the client name of INTERNAL_CLIENT (#275)', () => {
  const r = runWith(stored(['a'.repeat(64), { client: 'github-connector', profiles: ['*'] }], ['b'.repeat(64), { client: 'demo', profiles: ['*'] }]),
    'list', '--local', '--config', internalConfig(), '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /a{64} {2}github-connector .*same name as INTERNAL_CLIENT/);
  assert.doesNotMatch(r.stdout.split('\n').find((l) => l.startsWith('b'.repeat(64))), /INTERNAL_CLIENT/);
});

test('a config that cannot be read is an error, not an unchecked name (#275)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-internal-'));
  const broken = join(dir, 'wrangler.jsonc');
  writeFileSync(broken, '{ "vars": ');
  const r = run('create', '--client', 'demo', '--profiles', '*', '--local', '--config', broken, '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot check INTERNAL_CLIENT/);
  const missing = run('create', '--client', 'demo', '--profiles', '*', '--local', '--config', join(dir, 'none.jsonc'), '--dry-run');
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /cannot check INTERNAL_CLIENT/);
});

test('a TOML config gets a warning, not a refusal (#275)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-internal-'));
  const toml = join(dir, 'wrangler.toml');
  writeFileSync(toml, 'name = "engine"\n');
  const r = run('create', '--client', 'demo', '--profiles', '*', '--local', '--config', toml, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /cannot check that no token gets the client name of INTERNAL_CLIENT/);
});

test('without --config, the config is found as wrangler finds it: this folder, then parent folders (#275)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-internal-'));
  const client = JSON.stringify({ client: 'github-connector', profiles: ['p'] });
  // wrangler.json comes before wrangler.jsonc, as in wrangler.
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify({ vars: { INTERNAL_CLIENT: client } }));
  writeFileSync(join(dir, 'wrangler.jsonc'), '{}');
  mkdirSync(join(dir, 'sub'));
  for (const cwd of [dir, join(dir, 'sub')]) {
    const r = spawnSync(process.execPath, [script, 'create', '--client', 'github-connector', '--profiles', '*', '--local', '--dry-run'], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /is the client of INTERNAL_CLIENT in .*wrangler\.json:/);
  }
});

test('an INTERNAL_CLIENT that is not JSON, or has no client, names no client (#275)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-internal-'));
  const file = join(dir, 'wrangler.jsonc');
  writeFileSync(file, JSON.stringify({ vars: { INTERNAL_CLIENT: 'not json' }, env: { a: { vars: { INTERNAL_CLIENT: '{"profiles":["p"]}' } }, b: null } }));
  const r = run('create', '--client', 'demo', '--profiles', '*', '--local', '--config', file, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
});

test('rotate refuses a name INTERNAL_CLIENT gives in an environment (#275)', () => {
  const r = runWith(stored(['a'.repeat(64), { client: 'staging-connector', profiles: ['*'] }]),
    'rotate', '--client', 'staging-connector', '--local', '--config', internalConfig(), '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /"staging-connector" is the client of INTERNAL_CLIENT/);
});

test('revoke does not read the config (#275)', () => {
  const hash = 'a'.repeat(64);
  const r = runWith(stored([hash, { client: 'demo', profiles: ['*'] }]), 'revoke', '--hash', hash, '--local', '--config', join(tmpdir(), 'no-such-config.jsonc'), '--dry-run');
  assert.equal(r.status, 0, r.stderr);
});

test('a wrangler.json in a parent folder wins over a wrangler.jsonc here, as in wrangler (#275)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-internal-'));
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify({ vars: { INTERNAL_CLIENT: JSON.stringify({ client: 'github-connector', profiles: ['p'] }) } }));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'wrangler.jsonc'), '{}');
  const r = spawnSync(process.execPath, [script, 'create', '--client', 'github-connector', '--profiles', '*', '--local', '--dry-run'], { cwd: join(dir, 'sub'), encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /is the client of INTERNAL_CLIENT in \.\.\/wrangler\.json:/);
});
