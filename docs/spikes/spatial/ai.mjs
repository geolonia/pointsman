// Calls Clef-flash or Clef on Workers AI with the request the engine builds
// (toModelRequest), with the wrangler login's token (`wrangler auth token`)
// and CF_ACCOUNT_ID. For the spike only.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { toModelRequest } from '../../../src/models/adapter.ts';

const ACCOUNT = process.env.CF_ACCOUNT_ID;
if (!/^[0-9a-f]{32}$/.test(ACCOUNT ?? '')) throw new Error('set CF_ACCOUNT_ID to the Cloudflare account that runs Workers AI');
let token;
const auth = () => (token ??= execFileSync('npx', ['wrangler', 'auth', 'token'], { encoding: 'utf8' }).trim().split('\n').pop().trim());

export const loadProfile = (path) => parse(readFileSync(path, 'utf8'));

export async function ask(profile, state, model = 'clef-flash') {
  const request = toModelRequest(profile, state, model);
  const name = { 'clef-flash': '@cf/cloudflare/clef-flash', clef: '@cf/cloudflare/clef' }[model];
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth()}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error(`${name}: ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.result.answers;
}
