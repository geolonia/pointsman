#!/usr/bin/env node
// Create, revoke and list API tokens in the TOKENS KV namespace (via wrangler).
//
//   node scripts/tokens.mjs create --client <name> --profiles <id,id|*> [--test] [--expires <when>] (--local|--remote) [--config <file>]
//   node scripts/tokens.mjs rotate --client <name> [--profiles <id,id|*>] [--keep-old] [--expires <when> | --no-expiry] (--local|--remote) [--config <file>]
//   node scripts/tokens.mjs revoke --hash <sha256> (--local|--remote) [--config <file>]
//   node scripts/tokens.mjs list (--local|--remote) [--config <file>]
//
// `create` prints the token once; only its SHA-256 hash is stored. Keep the
// token in the client's secret store. Only the hash is passed to wrangler, so
// the token does not show up in the process list or shell history.
// --test makes a test token: its decisions are not logged, and it may only
// decide (for checks of profiles and examples).
// --expires sets when the token stops working: a duration from now (90d,
// 12h, 2w) or a date (2027-01-31, end of that day UTC). The Worker refuses it
// afterwards like an unknown token, and KV deletes the key then too. Without
// it a token works until it is revoked. `rotate` asks for --expires or
// --no-expiry when the old token had an expiry, so a new token never loses
// one by accident.
// --dry-run prints what would be written instead of calling wrangler.
//
// Client names are unique: decisions are logged per client, and chained
// decisions (docs/decision-chains.md) must come from the same client, so two
// tokens with one name would share them. `create` refuses a name in use;
// `rotate` gives the client a new token (same profiles and --test unless
// --profiles is given) and revokes its old ones, or with --keep-old leaves
// them for you to revoke once the new token is in place.

import { relative } from 'node:path';
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
        test: { type: 'boolean', default: false },
        'keep-old': { type: 'boolean', default: false },
        expires: { type: 'string' },
        'no-expiry': { type: 'boolean', default: false },
        remote: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    return fail(err.message);
  }
})();

const [command] = positionals;
if (positionals.length !== 1 || !['create', 'rotate', 'revoke', 'list'].includes(command)) {
  fail('Usage: tokens.mjs create|rotate|revoke|list ... (see the comment at the top of this file)');
}
// No default target: writing to the wrong namespace should not be one typo away.
if (values.local === values.remote) fail('Give exactly one of --local or --remote.');

/** A value as a shell word, quoted when needed. */
const shellWord = (v) => (/^[\w./@:-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`);

/** This script's path as started (engine/scripts/tokens.mjs in a configuration repository), for a command to copy. */
const self = () => shellWord(relative(process.cwd(), process.argv[1]) || process.argv[1]);

/** The target options as typed, for a command to copy: --local or --remote, and --config when given. */
function target() {
  return [values.local ? '--local' : '--remote', ...(values.config ? ['--config', shellWord(values.config)] : [])].join(' ');
}

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

/** The stored tokens: hash and metadata (client, profiles, test, created_at). */
function listTokens() {
  // A dry run reads nothing; tests give the stored tokens in TOKENS_DRY_RUN_LIST
  // (wrangler's `kv key list` output).
  const out = values['dry-run'] ? process.env.TOKENS_DRY_RUN_LIST ?? '[]' : wrangler(['list', '--prefix', 'token:']);
  return JSON.parse(out).map((key) => ({ hash: key.name.slice('token:'.length), ...(key.metadata ?? {}) }));
}

function clientArg() {
  if (!values.client || !NAME.test(values.client)) {
    fail('--client must be lower case letters, digits and "-" (max 63)');
  }
  return values.client;
}

function profilesArg() {
  const profiles = (values.profiles ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (profiles.length === 0 || !profiles.every((p) => p === '*' || NAME.test(p))) {
    fail('--profiles must be a comma-separated list of profile ids, or *');
  }
  if (profiles.includes('*') && profiles.length > 1) fail('--profiles: * cannot be combined with ids');
  return profiles;
}

/** When the token expires (ISO string), from --expires, or undefined without it. */
function expiresArg(now = Date.now()) {
  if (values.expires === undefined) return undefined;
  if (values['no-expiry']) fail('give --expires or --no-expiry, not both');
  const v = values.expires.trim();
  const d = /^(\d{1,4})([hdw])$/.exec(v);
  let at;
  if (d) {
    const hours = { h: 1, d: 24, w: 24 * 7 }[d[2]] * Number(d[1]);
    at = now + hours * 3600_000;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    at = Date.parse(`${v}T23:59:59Z`);
    // Date.parse moves 2027-02-30 to March: refuse a day that does not exist.
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== v) fail(`--expires: ${v} is not a date`);
  } else {
    fail('--expires must be a duration (12h, 90d, 2w) or a date (YYYY-MM-DD)');
  }
  // KV refuses an expiration less than 60 seconds ahead; an hour is the shortest useful token anyway.
  if (!Number.isFinite(at) || at < now + 3600_000) fail('--expires must be at least an hour from now');
  return new Date(at).toISOString();
}

async function putToken(client, profiles, test, expiresAt) {
  const token = newToken();
  const hash = await hashToken(token);
  const record = { client, profiles, created_at: new Date().toISOString(), ...(test && { test: true }), ...(expiresAt && { expires_at: expiresAt }) };
  const json = JSON.stringify(record);
  // Metadata makes `list` show the client without reading every value. With
  // an expiry, KV also deletes the key then (the Worker checks it anyway).
  const expiration = expiresAt ? ['--expiration', String(Math.floor(Date.parse(expiresAt) / 1000))] : [];
  wrangler(['put', tokenKey(hash), json, '--metadata', json, ...expiration]);
  console.log(`client:  ${record.client}${record.test ? ' (test token: not logged, decide only)' : ''}\nprofiles: ${profiles.join(',')}\nhash:    ${hash}${expiresAt ? `\nexpires: ${expiresAt}` : ''}`);
  console.log(`\ntoken (shown once, store it as a secret):\n${token}`);
}

switch (command) {
  case 'create': {
    const client = clientArg();
    const profiles = profilesArg();
    if (listTokens().some((t) => t.client === client)) {
      fail(`client "${client}" already has a token: use \`rotate --client ${client}\` for a new one, or another name`);
    }
    if (values['no-expiry']) fail('--no-expiry is for rotate; a new token has no expiry without --expires');
    await putToken(client, profiles, values.test, expiresArg());
    break;
  }
  case 'rotate': {
    const client = clientArg();
    if (values.test) fail('rotate keeps the old token\'s --test setting; leave out --test');
    const old = listTokens().filter((t) => t.client === client);
    if (old.length === 0) fail(`client "${client}" has no token; use create`);
    if (old.some((t) => !!t.test !== !!old[0].test)) fail(`client "${client}" has both test and normal tokens; revoke one kind first`);
    if (values.profiles === undefined && old.some((t) => (t.profiles ?? []).join(',') !== (old[0].profiles ?? []).join(','))) {
      fail(`client "${client}" has tokens with different profiles; give --profiles`);
    }
    const profiles = values.profiles !== undefined ? profilesArg() : old[0]?.profiles ?? [];
    if (profiles.length === 0) fail('--profiles is needed (the old token\'s profiles are unknown)');
    const expiresAt = expiresArg();
    if (expiresAt === undefined && !values['no-expiry'] && old.some((t) => t.expires_at)) {
      fail(`the old token of "${client}" has an expiry: give --expires <when> for the new one, or --no-expiry`);
    }
    await putToken(client, profiles, !!old[0]?.test, expiresAt);
    for (const t of old) {
      if (values['keep-old']) {
        console.log(`\nold token kept; revoke it once the new one is in place:\n  node ${self()} revoke --hash ${t.hash} ${target()}`);
      } else {
        wrangler(['delete', tokenKey(t.hash)]);
        console.log(`\nrevoked old token ${t.hash}`);
      }
    }
    break;
  }
  case 'revoke': {
    if (!values.hash || !HASH.test(values.hash)) fail('--hash must be a SHA-256 hex hash (see `list`)');
    wrangler(['delete', tokenKey(values.hash)]);
    console.log(`revoked ${values.hash}`);
    break;
  }
  case 'list': {
    const tokens = listTokens();
    const count = new Map();
    for (const t of tokens) count.set(t.client, (count.get(t.client) ?? 0) + 1);
    for (const t of tokens) {
      const shared = count.get(t.client) > 1 ? '  (name used by several tokens: rotate or rename)' : '';
      // The same rule as the Worker (isExpired): an expiry it cannot read is refused.
      const at = typeof t.expires_at === 'string' ? Date.parse(t.expires_at) : NaN;
      const expiry = t.expires_at === undefined ? '' : `  expires ${t.expires_at}${!Number.isFinite(at) ? ' (unreadable: refused)' : at <= Date.now() ? ' (expired)' : ''}`;
      console.log(`${t.hash}  ${t.client ?? '?'}${t.test ? ' (test)' : ''}  ${(t.profiles ?? []).join(',')}  ${t.created_at ?? ''}${expiry}${shared}`);
    }
    break;
  }
}
