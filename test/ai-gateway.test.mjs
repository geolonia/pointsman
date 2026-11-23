// scripts/ai-gateway.mjs: talks to the Cloudflare API. fetch is replaced in
// the child process (node --import), so no request leaves this machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'scripts', 'ai-gateway.mjs');

/**
 * Run the script with this fetch (the source of a function). With `env`
 * unset, the token and account come from the environment; else wrangler is
 * replaced too, and each call of it is written to `calls`.
 */
function runWithFetch(t, fetchSource, args, env = { CLOUDFLARE_API_TOKEN: 'secret-token', CLOUDFLARE_ACCOUNT_ID: 'account' }) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-gateway-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'wrangler-calls');
  const preload = join(dir, 'fetch.mjs');
  writeFileSync(preload, `
    import childProcess from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    globalThis.fetch = ${fetchSource};
    childProcess.execFileSync = (bin, args) => {
      appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
      return args[0] === 'auth' ? '{"token":"secret-token"}' : '{"accounts":[{"id":"account","name":"Test"}]}';
    };
    syncBuiltinESMExports();
  `);
  const settings = join(dir, 'ai-gateway.json');
  writeFileSync(settings, JSON.stringify({ id: 'pointsman', cache_ttl: 0 }));
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ...rest } = process.env;
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args, '--file', settings], {
    encoding: 'utf8',
    env: { ...rest, ...env },
  });
  return { ...r, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

test('a fetch error ends with one clear line and exit 1, not an unhandled rejection (#268)', (t) => {
  const r = runWithFetch(t, "async () => { throw new TypeError('fetch failed'); }", ['show']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /The Cloudflare API could not be reached: fetch failed/);
  assert.doesNotMatch(r.stderr, /    at /, 'no stack trace');
  assert.doesNotMatch(r.stdout + r.stderr, /secret-token/);
});

test('show lists the gateways, then reads the one in the settings', (t) => {
  const r = runWithFetch(t, `async (url) => new Response(JSON.stringify(
    String(url).includes('?') ? { result: [{ id: 'pointsman' }] } : { result: { id: 'pointsman', cache_ttl: 0, other: 1 } }))`, ['show']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { id: 'pointsman', cache_ttl: 0 });
});

test('the wrangler login is read once per run, not for every API call (#268)', (t) => {
  const r = runWithFetch(t, `async (url) => new Response(JSON.stringify(
    String(url).includes('?') ? { result: [{ id: 'pointsman' }] } : { result: { id: 'pointsman', cache_ttl: 0 } }))`, ['show'], {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.calls, ['auth token --json', 'whoami --json']);
});
