#!/usr/bin/env node
// Create, revoke and list API tokens in the TOKENS KV namespace (via wrangler).
//
//   node scripts/tokens.mjs create --client <name> --profiles <id,id|*> (--local|--remote) [--config <file>]
//   node scripts/tokens.mjs revoke --hash <sha256> (--local|--remote) [--config <file>]
//   node scripts/tokens.mjs list (--local|--remote) [--config <file>]
//
// `create` prints the token once; only its SHA-256 hash is stored. Keep the
// token in the client's secret store. Only the hash is passed to wrangler, so
// the token does not show up in the process list or shell history.
// --dry-run prints what would be written instead of calling wrangler.

import { parseArgs } from 'node:util';
// Same token format and hashing as the Worker (Node.js strips the types).
import { hashToken, newToken, tokenKey } from '../src/auth.ts';
import { wrangler as runWrangler } from './lib/wrangler.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HASH = /^[0-9a-f]{64}$/;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        client: { type: 'string' },
        profiles: { type: 'string' },
        hash: { type: 'string' },
        config: { type: 'string' },
        local: { type: 'boolean', default: false },
        remote: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    return fail(err.message);
  }
})();

const [command] = positionals;
if (positionals.length !== 1 || !['create', 'revoke', 'list'].includes(command)) {
  fail('Usage: tokens.mjs create|revoke|list ... (see the comment at the top of this file)');
}
// No default target: writing to the wrong namespace should not be one typo away.
if (values.local === values.remote) fail('Give exactly one of --local or --remote.');

function wrangler(args) {
  const full = ['kv', 'key', ...args, '--binding', 'TOKENS', values.local ? '--local' : '--remote'];
  if (values.config) full.push('--config', values.config);
  if (values['dry-run']) {
    console.log(`[dry-run] wrangler ${full.join(' ')}`);
    return '';
  }
  try {
    return runWrangler(full);
  } catch (err) {
    return fail(err.message);
  }
}

switch (command) {
  case 'create': {
    if (!values.client || !NAME.test(values.client)) {
      fail('--client must be lower case letters, digits and "-" (max 63)');
    }
    const profiles = (values.profiles ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (profiles.length === 0 || !profiles.every((p) => p === '*' || NAME.test(p))) {
      fail('--profiles must be a comma-separated list of profile ids, or *');
    }
    if (profiles.includes('*') && profiles.length > 1) fail('--profiles: * cannot be combined with ids');

    const token = newToken();
    const hash = await hashToken(token);
    const record = { client: values.client, profiles, created_at: new Date().toISOString() };
    const json = JSON.stringify(record);
    // Metadata makes `list` show the client without reading every value.
    wrangler(['put', tokenKey(hash), json, '--metadata', json]);
    console.log(`client:  ${record.client}\nprofiles: ${profiles.join(',')}\nhash:    ${hash}`);
    console.log(`\ntoken (shown once, store it as a secret):\n${token}`);
    break;
  }
  case 'revoke': {
    if (!values.hash || !HASH.test(values.hash)) fail('--hash must be a SHA-256 hex hash (see `list`)');
    wrangler(['delete', tokenKey(values.hash)]);
    console.log(`revoked ${values.hash}`);
    break;
  }
  case 'list': {
    const out = wrangler(['list', '--prefix', 'token:']);
    if (values['dry-run']) break;
    for (const key of JSON.parse(out)) {
      const m = key.metadata ?? {};
      console.log(`${key.name.slice('token:'.length)}  ${m.client ?? '?'}  ${(m.profiles ?? []).join(',')}  ${m.created_at ?? ''}`);
    }
    break;
  }
}
