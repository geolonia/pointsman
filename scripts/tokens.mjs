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
//
// A token also never gets the client name of INTERNAL_CLIENT (#275): internal
// calls are logged under that name, so such a token would share the internal
// client's decisions and could close its reviews. `create` and `rotate` read
// INTERNAL_CLIENT from the Wrangler config (--config, else the one wrangler
// finds from this folder up, refusing when wrangler would redirect to a
// generated config; top-level vars and every environment's; a TOML config
// gets a warning; a secret or .dev.vars is not read) and refuse that name; `list` marks
// a token that has it, such as the connector's old token while a deployment
// moves to internal calls (docs/github-connector.md).
//
// Exits 2 on bad or missing options (what the command line alone shows), 1
// on any other failure: a name in use or the stored tokens not allowing it,
// a config that cannot be read, the name of INTERNAL_CLIENT, a record too
// large, or wrangler failing.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseJsonc } from 'jsonc-parser';
// Same token format and hashing as the Worker (Node.js strips the types).
import { hashToken, newToken, tokenKey } from '../src/auth.ts';
import { wrangler as runWrangler } from './lib/wrangler.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HASH = /^[0-9a-f]{64}$/;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/** A usage error: bad or missing options. */
const usage = (message) => fail(message, 2);

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
    return usage(err.message);
  }
})();

const [command] = positionals;
if (positionals.length !== 1 || !['create', 'rotate', 'revoke', 'list'].includes(command)) {
  usage('Usage: tokens.mjs create|rotate|revoke|list ... (see the comment at the top of this file)');
}
// No default target: writing to the wrong namespace should not be one typo away.
if (values.local === values.remote) usage('Give exactly one of --local or --remote.');

/** A value as a shell word, quoted when needed. */
const shellWord = (v) => (/^[\w./@:-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`);

/**
 * This script's path as started (engine/scripts/tokens.mjs in a configuration
 * repository), for a command to copy: relative to the current folder when it
 * is inside it, else absolute; never starting with "-", which node would read
 * as an option.
 */
function self() {
  const rel = relative(process.cwd(), process.argv[1]);
  const path = rel.startsWith('..') ? process.argv[1] : rel.startsWith('-') ? `./${rel}` : rel;
  return shellWord(path);
}

/** The target options as typed, for a command to copy: --local or --remote, and --config when given. */
function target() {
  // --config=<file> as one word, so a file name starting with "-" is not read as an option.
  return [values.local ? '--local' : '--remote', ...(values.config ? [`--config=${shellWord(values.config)}`] : [])].join(' ');
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
  return JSON.parse(out).map((key) => ({ hash: key.name.slice('token:'.length), ...key.metadata }));
}

/**
 * The config wrangler takes without --config, in wrangler's order
 * (findWranglerConfig): wrangler.json in this folder or the nearest parent
 * folder, else wrangler.jsonc the same way, else wrangler.toml.
 * wrangler.jsonc when there is none, so the error names it. Wrangler can
 * redirect to a generated config (.wrangler/deploy/config.json, in this
 * folder or a parent, written by build tools); this script does not follow
 * it and refuses, so the name is never checked against another config than
 * the one wrangler writes to.
 */
function findConfig() {
  for (let dir = resolve('.'); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.wrangler', 'deploy', 'config.json'))) {
      fail(`${join(dir, '.wrangler', 'deploy', 'config.json')}: wrangler may use a generated config instead of yours, which tokens.mjs does not follow; give the config with --config`);
    }
    if (dirname(dir) === dir) break;
  }
  for (const name of ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']) {
    for (let dir = resolve('.'); ; dir = dirname(dir)) {
      const f = join(dir, name);
      if (existsSync(f)) return relative(process.cwd(), f) || f;
      if (dirname(dir) === dir) break;
    }
  }
  return 'wrangler.jsonc';
}

/**
 * The Wrangler config's file and the client names INTERNAL_CLIENT gives, at
 * the top level and in every environment. A config that cannot be read is an
 * error, so a name is never left unchecked; a value that is not valid JSON is
 * skipped (the Worker refuses it).
 */
function internalClients() {
  const file = values.config ?? findConfig();
  if (file.endsWith('.toml')) {
    console.error(`${file}: tokens.mjs reads only JSON or JSONC configs, so it cannot check that no token gets the client name of INTERNAL_CLIENT; make sure yourself`);
    return { file, names: new Set() };
  }
  let config;
  try {
    const errors = [];
    config = parseJsonc(readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length > 0 || config === null || typeof config !== 'object') throw new Error('not valid JSONC');
  } catch (err) {
    return fail(`${file}: ${err.code === 'ENOENT' ? 'not found' : err.message}, so tokens.mjs cannot check INTERNAL_CLIENT; give the config with --config`);
  }
  const names = new Set();
  for (const vars of [config.vars, ...Object.values(config.env ?? {}).map((e) => e?.vars)]) {
    const raw = vars?.INTERNAL_CLIENT;
    if (typeof raw !== 'string') continue;
    try {
      const { client } = JSON.parse(raw);
      if (typeof client === 'string') names.add(client);
    } catch {
      // Not JSON: the Worker refuses it, and it names no client.
    }
  }
  return { file, names };
}

/** Refuses a client name that INTERNAL_CLIENT has. */
function notInternal(client) {
  const { file, names } = internalClients();
  if (names.has(client)) {
    fail(`"${client}" is the client of INTERNAL_CLIENT in ${file}: a token with that name would share its decisions and could close its reviews. Choose another name.`);
  }
}

function clientArg() {
  if (!values.client || !NAME.test(values.client)) {
    usage('--client must be lower case letters, digits and "-" (max 63)');
  }
  return values.client;
}

function profilesArg() {
  const profiles = (values.profiles ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (profiles.length === 0 || !profiles.every((p) => p === '*' || NAME.test(p))) {
    usage('--profiles must be a comma-separated list of profile ids, or *');
  }
  if (profiles.includes('*') && profiles.length > 1) usage('--profiles: * cannot be combined with ids');
  return profiles;
}

/** When the token expires (ISO string), from --expires, or undefined without it. */
function expiresArg(now = Date.now()) {
  if (values.expires === undefined) return undefined;
  if (values['no-expiry']) usage('give --expires or --no-expiry, not both');
  const v = values.expires.trim();
  const d = /^(\d{1,4})([hdw])$/.exec(v);
  let at;
  if (d) {
    const hours = { h: 1, d: 24, w: 24 * 7 }[d[2]] * Number(d[1]);
    at = now + hours * 3600_000;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    at = Date.parse(`${v}T23:59:59Z`);
    // Date.parse moves 2027-02-30 to March: refuse a day that does not exist.
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== v) usage(`--expires: ${v} is not a date`);
  } else {
    usage('--expires must be a duration (12h, 90d, 2w) or a date (YYYY-MM-DD)');
  }
  // KV refuses an expiration less than 60 seconds ahead; an hour is the shortest useful token anyway.
  if (!Number.isFinite(at) || at < now + 3600_000) usage('--expires must be at least an hour from now');
  return new Date(at).toISOString();
}

async function putToken(client, profiles, test, expiresAt) {
  const token = newToken();
  const hash = await hashToken(token);
  const record = { client, profiles, created_at: new Date().toISOString(), ...(test && { test: true }), ...(expiresAt && { expires_at: expiresAt }) };
  const json = JSON.stringify(record);
  // KV keeps at most 1024 bytes of metadata (#259): refused here, before any
  // write, instead of failing inside wrangler.
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > 1024) {
    fail(`this token record is ${bytes} bytes; KV metadata takes at most 1024. Give fewer or shorter profile ids, or "*" for every profile.`);
  }
  // Metadata makes `list` show the client without reading every value. With
  // an expiry, KV also deletes the key then (the Worker checks it anyway).
  const expiration = expiresAt ? ['--expiration', String(Math.floor(Date.parse(expiresAt) / 1000))] : [];
  wrangler(['put', tokenKey(hash), json, '--metadata', json, ...expiration]);
  console.log(`client:  ${record.client}${record.test ? ' (test token: not logged, decide only)' : ''}\nprofiles: ${profiles.join(',')}\nhash:    ${hash}${expiresAt ? `\nexpires: ${expiresAt}` : ''}`);
  console.log(`\ntoken (shown once, store it as a secret):\n${token}`);
}

switch (command) {
  case 'create': {
    // The options first (exit 2), before anything is read.
    const client = clientArg();
    const profiles = profilesArg();
    if (values['no-expiry']) usage('--no-expiry is for rotate; a new token has no expiry without --expires');
    const expiresAt = expiresArg();
    notInternal(client);
    if (listTokens().some((t) => t.client === client)) {
      fail(`client "${client}" already has a token: use \`rotate --client ${client}\` for a new one, or another name`);
    }
    await putToken(client, profiles, values.test, expiresAt);
    break;
  }
  case 'rotate': {
    // The options first (exit 2), before anything is read.
    const client = clientArg();
    if (values.test) usage('rotate keeps the old token\'s --test setting; leave out --test');
    const givenProfiles = values.profiles !== undefined ? profilesArg() : undefined;
    const expiresAt = expiresArg();
    notInternal(client);
    const old = listTokens().filter((t) => t.client === client);
    if (old.length === 0) fail(`client "${client}" has no token; use create`);
    if (old.some((t) => !!t.test !== !!old[0].test)) fail(`client "${client}" has both test and normal tokens; revoke one kind first`);
    if (values.profiles === undefined && old.some((t) => (t.profiles ?? []).join(',') !== (old[0].profiles ?? []).join(','))) {
      fail(`client "${client}" has tokens with different profiles; give --profiles`);
    }
    const profiles = givenProfiles ?? old[0]?.profiles ?? [];
    if (profiles.length === 0) fail('--profiles is needed (the old token\'s profiles are unknown)');
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
    if (!values.hash || !HASH.test(values.hash)) usage('--hash must be a SHA-256 hex hash (see `list`)');
    // Deleting a key that does not exist succeeds: a mistyped hash would print
    // "revoked" while the real token stays valid (#259).
    // KV lists a new key up to about a minute late: right after create or
    // rotate, try again then.
    if (!listTokens().some((t) => t.hash === values.hash)) {
      fail(`no token with the hash ${values.hash}; see \`list\` (a token created in the last minute may not be listed yet: try again in a minute)`);
    }
    wrangler(['delete', tokenKey(values.hash)]);
    console.log(`revoked ${values.hash}`);
    break;
  }
  case 'list': {
    const tokens = listTokens();
    const { names: internal } = internalClients();
    const count = new Map();
    for (const t of tokens) count.set(t.client, (count.get(t.client) ?? 0) + 1);
    for (const t of tokens) {
      const shared = count.get(t.client) > 1 ? '  (name used by several tokens: rotate or rename)' : '';
      const sameAsInternal = internal.has(t.client) ? '  (same name as INTERNAL_CLIENT: revoke this token once internal calls work)' : '';
      // The same rule as the Worker (isExpired): an expiry it cannot read is refused.
      const at = typeof t.expires_at === 'string' ? Date.parse(t.expires_at) : NaN;
      const expiry = t.expires_at === undefined ? '' : `  expires ${t.expires_at}${!Number.isFinite(at) ? ' (unreadable: refused)' : at <= Date.now() ? ' (expired)' : ''}`;
      console.log(`${t.hash}  ${t.client ?? '?'}${t.test ? ' (test)' : ''}  ${(t.profiles ?? []).join(',')}  ${t.created_at ?? ''}${expiry}${shared}${sameAsInternal}`);
    }
    break;
  }
}
