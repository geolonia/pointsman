import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateProfileFile } from '../scripts/lib/profile.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const examples = join(root, 'examples', 'profiles');
const invalid = join(root, 'test', 'fixtures', 'invalid');
const cli = join(root, 'scripts', 'validate-profiles.mjs');

for (const file of readdirSync(examples)) {
  test(`example ${file} is valid`, () => {
    assert.deepEqual(validateProfileFile(join(examples, file)), []);
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

test('CLI exits 2 for a missing path', () => {
  const r = spawnSync(process.execPath, [cli, join(root, 'no-such-dir')], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});
