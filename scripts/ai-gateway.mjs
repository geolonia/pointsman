#!/usr/bin/env node
// Create or update the AI Gateway from a settings file, through the Cloudflare
// API (wrangler has no command for gateways).
//
//   node scripts/ai-gateway.mjs show  [--file ai-gateway.json]
//   node scripts/ai-gateway.mjs apply [--file ai-gateway.json] [--dry-run]
//
// Credentials: CLOUDFLARE_API_TOKEN (needs AI Gateway Read + Edit), or the
// wrangler login (`wrangler auth token`). Account: CLOUDFLARE_ACCOUNT_ID, or
// the only account of the wrangler login. The token is never printed.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { file: { type: 'string', default: 'ai-gateway.json' }, 'dry-run': { type: 'boolean', default: false } },
  });
} catch (err) {
  fail(err.message, 2);
}
const { values, positionals } = parsed;
const [command] = positionals;
if (positionals.length !== 1 || !['show', 'apply'].includes(command)) fail('Usage: ai-gateway.mjs show|apply [--file f] [--dry-run]', 2);

let settings;
try {
  settings = JSON.parse(readFileSync(values.file, 'utf8'));
} catch (err) {
  fail(`${values.file}: ${err.message}`, 2);
}
if (typeof settings.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(settings.id)) {
  fail(`${values.file}: "id" must be a gateway name (lower case, digits, "-", "_"; max 64)`, 2);
}

function wrangler(args) {
  return execFileSync('npx', ['--no-install', 'wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function credentials() {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  try {
    if (!token) {
      const out = JSON.parse(wrangler(['auth', 'token', '--json']));
      token = out.token ?? out.apiToken ?? out.value;
    }
    if (!account) {
      const who = JSON.parse(wrangler(['whoami', '--json']));
      const accounts = who.accounts ?? [];
      if (accounts.length !== 1) {
        fail(`The wrangler login has ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID to one of:\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n')}`);
      }
      account = accounts[0].id;
    }
  } catch (err) {
    fail(`No Cloudflare credentials: run \`wrangler login\` or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.\n(${String(err.message).split('\n')[0]})`);
  }
  if (!token) fail('No token from `wrangler auth token`; run `wrangler login`.');
  return { token, account };
}

async function api(method, path, body) {
  const { token, account } = credentials();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const fields = Object.keys(settings);
const pick = (g) => Object.fromEntries(fields.map((k) => [k, g?.[k]]));
const errors = (data) => (data.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || 'unknown error';

// A 404 from GET /gateways/<id> can also mean a wrong account or token, so
// existence comes from the list, which must succeed.
async function gatewayIds() {
  const ids = [];
  for (let page = 1; ; page++) {
    const list = await api('GET', `?per_page=50&page=${page}`);
    if (list.status !== 200 || !Array.isArray(list.data.result)) {
      fail(`Listing gateways: HTTP ${list.status} ${errors(list.data)}`);
    }
    ids.push(...list.data.result.map((g) => g.id));
    if (list.data.result.length < 50) return ids;
  }
}
const exists = (await gatewayIds()).includes(settings.id);
const current = exists ? await api('GET', `/${settings.id}`) : null;
if (current && current.status !== 200) fail(`GET ${settings.id}: HTTP ${current.status} ${errors(current.data)}`);

if (command === 'show') {
  console.log(exists ? JSON.stringify(pick(current.data.result), null, 2) : `Gateway "${settings.id}" does not exist.`);
  process.exit(0);
}

const changed = exists ? fields.filter((k) => JSON.stringify(current.data.result[k]) !== JSON.stringify(settings[k])) : fields;
if (exists && changed.length === 0) {
  console.log(`Gateway "${settings.id}" already matches ${values.file}.`);
  process.exit(0);
}
console.log(`${exists ? 'Update' : 'Create'} gateway "${settings.id}": ${changed.map((k) => `${k}=${JSON.stringify(settings[k])}`).join(', ')}`);
if (values['dry-run']) process.exit(0);

// PUT replaces the settings, so send the current ones with ours on top.
const result = exists
  ? await api('PUT', `/${settings.id}`, { ...current.data.result, ...settings })
  : await api('POST', '', settings);
if (result.status !== 200) fail(`${exists ? 'PUT' : 'POST'} ${settings.id}: HTTP ${result.status} ${errors(result.data)}`);

const after = pick(result.data.result);
const mismatch = fields.filter((k) => JSON.stringify(after[k]) !== JSON.stringify(settings[k]));
if (mismatch.length > 0) fail(`Gateway saved, but these settings differ: ${mismatch.join(', ')}`);
console.log('Done.');
