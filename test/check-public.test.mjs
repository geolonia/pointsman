import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFile } from '../scripts/check-public.mjs';

// 32 hex, made up; built at runtime so this file passes the check itself.
const FAKE_ID = '0123456789abcdef'.repeat(2);
// Also built at runtime, so the check does not flag the examples below.
const ACCOUNT = ['account', 'id'].join('_');
const profile = 'id: x\nversion: 1\nquestions: []\npolicy: { default: review }\n';
const wrangler = (kv, extra = '') => `{\n  // comment\n  "name": "x",${extra}\n  "kv_namespaces": [{ "binding": "TOKENS", "id": "${kv}" }],\n}`;

for (const [name, path, text, expected] of [
  ['an account id in any file', 'docs/setup.md', `Account: ${FAKE_ID}`, /docs\/setup.md:1: looks like a Cloudflare account/],
  [`${ACCOUNT} in a config`, 'config.toml', `${ACCOUNT} = "abc"`, /sets account_id/],
  [`${ACCOUNT} next to an allowed secret reference`, 'deploy.yml', `token: \${{ secrets.TOKEN }}\n${ACCOUNT}: "abc"`, /deploy.yml:2: sets account_id/],
  [`${ACCOUNT} in JSON`, 'wrangler.json', `{ "${ACCOUNT}": "abc" }`, /sets account_id/],
  [`a real ${ACCOUNT} with a comment`, 'config.yml', `${ACCOUNT}: abc # the real one`, /sets account_id/],
  [`a real quoted ${ACCOUNT} with a placeholder-like comment`, 'config.yml', `${ACCOUNT}: "abc" # <placeholder>`, /sets account_id/],
  ['a real KV id in wrangler.jsonc', 'wrangler.jsonc', wrangler('my-namespace'), /kv_namespaces\[0\]\.id is "my-namespace"/],
  ['a D1 uuid', 'wrangler.jsonc', '{ "d1_databases": [{ "binding": "DB", "database_id": "6f0a3c1e-1111-4222-8333-444455556666" }] }', /database_id is "6f0a3c1e/],
  ['a wrangler.toml', 'wrangler.toml', 'name = "x"', /use wrangler.jsonc/],
  ['routes', 'wrangler.jsonc', wrangler('local-dev-only', '\n  "routes": ["x.example.com/*"],'), /routes is set/],
  ['a profile outside the example folders', 'profiles/team.yaml', profile, /a decision profile outside/],
]) {
  test(`flags ${name}`, () => {
    const problems = checkFile(path, text);
    assert.ok(problems.some((p) => expected.test(p)), problems.join('\n') || '(nothing found)');
  });
}

for (const [name, path, text] of [
  ['local-dev-only ids', 'wrangler.jsonc', wrangler('local-dev-only')],
  ['JSONC with inline and block comments', 'wrangler.jsonc', '{ /* block */ "name": "x", // inline\n "kv_namespaces": [{ "binding": "T", "id": "local-dev-only" }], }'],
  ['template placeholders', 'template/config-repo/wrangler.jsonc', wrangler('<PROFILES namespace id>')],
  ['a 64-hex SHA-256', 'docs/a.md', `hash ${'ab'.repeat(32)}`],
  ['a 40-hex commit SHA', 'docs/a.md', `commit ${'a1'.repeat(20)}`],
  ['hashes in the lockfile', 'pnpm-lock.yaml', `x ${FAKE_ID}`],
  ['example profiles', 'examples/profiles/x.yaml', profile],
  ['test fixtures', 'test/fixtures/invalid/x.yaml', profile],
  ['template profiles', 'template/config-repo/profiles/x.yaml', profile],
  ['a workflow using the account secret', '.github/workflows/d.yml', `${ACCOUNT}: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`],
  [`an ${ACCOUNT} placeholder`, 'docs/x.jsonc', `"${ACCOUNT}": "<account id>"`],
  [`an ${ACCOUNT} placeholder with # inside the quotes`, 'docs/x.yml', `${ACCOUNT}: "<tenant # id>" # note`],
  [`an ${ACCOUNT} placeholder with a JSONC comment`, 'docs/x.jsonc', `"${ACCOUNT}": "<account id>", // from the dashboard`],
  [`an ${ACCOUNT} secret with a YAML comment`, '.github/workflows/d.yml', `${ACCOUNT}: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }} # set in production`],
]) {
  test(`accepts ${name}`, () => {
    assert.deepEqual(checkFile(path, text), []);
  });
}
