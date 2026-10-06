// MCP endpoint (/mcp): JSON-RPC over Streamable HTTP, with API tokens.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken, newToken, tokenKey } from '../../src/auth';

const ALL = newToken();
const DEPLOY_ONLY = newToken();
const DB = (env as unknown as { DB: D1Database }).DB;

beforeEach(async () => {
  for (const [token, client, profiles] of [[ALL, 'agent', ['*']], [DEPLOY_ONLY, 'deploy-bot', ['deploy-progress']]] as const) {
    await env.TOKENS.put(tokenKey(await hashToken(token)), JSON.stringify({ client, profiles, created_at: '' }));
  }
});

let nextId = 1;

/** One JSON-RPC request; returns the result (or error) from the event stream. */
async function rpc(method: string, params: unknown = {}, token: string | null = ALL) {
  const res = await exports.default.fetch('http://pointsman.test/mcp', {
    method: 'POST',
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, headers: res.headers, text };
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return { status: 200, message: data.at(-1) };
}

async function call(name: string, args: Record<string, unknown>, token: string | null = ALL) {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  const result = r.message.result;
  return { isError: result.isError === true, text: result.content[0].text as string };
}

describe('/mcp', () => {
  it('needs a valid token', async () => {
    const r = await rpc('tools/list', {}, null);
    expect(r.status).toBe(401);
    expect(r.headers?.get('www-authenticate')).toBe('Bearer');
    expect((await rpc('tools/list', {}, newToken())).status).toBe(401);
  });

  it('initializes and offers list_profiles, decide and get_decision (no feedback for tokens)', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.message.result.serverInfo.name).toBe('pointsman');
    const tools = (await rpc('tools/list')).message.result.tools.map((t: any) => t.name).sort();
    expect(tools).toEqual(['decide', 'get_decision', 'list_profiles']);
  });

  it('lists only profiles that are MCP-visible and in scope', async () => {
    const all = JSON.parse((await call('list_profiles', {})).text);
    // deploy-progress does not set mcp.visible.
    expect(all.profiles.map((p: any) => p.id)).toEqual(['issue-triage']);
    expect(all.profiles[0]).toMatchObject({
      version: 1,
      state: { fields: ['title', 'body'] },
      actions: ['auto', 'review'],
    });
    expect(all.profiles[0].questions[0]).toMatchObject({ name: 'team', type: 'choice', options: ['backend', 'frontend', 'docs'] });
    expect(JSON.parse((await call('list_profiles', {}, DEPLOY_ONLY)).text).profiles).toEqual([]);
  });

  it('decides and logs the decision with the token client', async () => {
    const r = await call('decide', { profile: 'issue-triage', state: { title: 'Login page is blank', body: 'Since this morning.' }, ref: 'mcp:1' });
    expect(r.isError).toBe(false);
    const d = JSON.parse(r.text);
    expect(d).toMatchObject({ profile: 'issue-triage', profile_version: 1, action: 'auto', ref: 'mcp:1' });
    expect(d.answers.team.value).toBe('backend');
    const row = await DB.prepare('SELECT client, ref FROM decisions WHERE id = ?').bind(d.decision_id).first();
    expect(row).toEqual({ client: 'agent', ref: 'mcp:1' });
  });

  it.each([
    ['a profile that is not MCP-visible', ALL, { profile: 'deploy-progress', state: 'x' }, 'unknown profile "deploy-progress"'],
    ['a profile out of scope', DEPLOY_ONLY, { profile: 'issue-triage', state: { title: 't' } }, 'unknown profile "issue-triage"'],
    ['an unknown profile', ALL, { profile: 'nope', state: 'x' }, 'unknown profile "nope"'],
    ['a state without the input fields', ALL, { profile: 'issue-triage', state: { other: 1 } }, 'at least one of: title, body'],
    ['a raw payload instead of the input fields', ALL, { profile: 'issue-triage', state: { issue: { title: 't' } } }, 'at least one of: title, body'],
    ['a text state for a profile with input fields', ALL, { profile: 'issue-triage', state: 'just text' }, 'at least one of: title, body'],
    ['an empty text state', ALL, { profile: 'issue-triage', state: ' ' }, 'invalid_request'],
  ])('decide refuses %s', async (_, token, args, message) => {
    const r = await call('decide', args, token);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(message);
  });

  it('gets a decision in scope, without state or callback_url', async () => {
    const d = JSON.parse((await call('decide', { profile: 'issue-triage', state: { title: 'T' } })).text);
    const got = await call('get_decision', { decision_id: d.decision_id });
    expect(got.isError).toBe(false);
    const record = JSON.parse(got.text);
    expect(record).toMatchObject({ decision_id: d.decision_id, client: 'agent', feedback: [] });
    expect(record.state).toBeUndefined();
    expect(record.callback_url).toBeUndefined();

    expect((await call('get_decision', { decision_id: d.decision_id }, DEPLOY_ONLY)).isError).toBe(true);

    // A decision of a profile that is not MCP-visible (made through REST) looks unknown.
    const rest = await exports.default.fetch('http://pointsman.test/v1/decide/deploy-progress', {
      method: 'POST',
      headers: { authorization: `Bearer ${ALL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'No stack event for 40 minutes.' }),
    });
    const hidden = (await rest.json<any>()).decision_id;
    const got2 = await call('get_decision', { decision_id: hidden });
    expect(got2.isError).toBe(true);
    expect(got2.text).toContain('unknown decision');
    expect((await call('get_decision', { decision_id: 'not-a-uuid' })).text).toContain('unknown decision');
  });
});
