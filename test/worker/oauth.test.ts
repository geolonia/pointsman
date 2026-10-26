// GitHub login for /mcp (src/oauth.ts): the whole OAuth flow, with a fake GitHub.

import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ConfigError, createApp } from '../../src/app';
import { hashToken, newToken, tokenKey } from '../../src/auth';
import { depsFor } from '../../src/index';
import type { OAuthConfig } from '../../src/oauth';

const BASE = 'https://pointsman.test';
// Made at run time, so no secret-looking literal sits in the repository.
const CLIENT_SECRET = crypto.randomUUID();
const CLIENT_REDIRECT = 'https://client.test/cb';
const DB = (env as unknown as { DB: D1Database }).DB;
// Bound under another name, so the other tests run without OAuth settings.
const OAUTH_KV = (env as unknown as { TEST_OAUTH_KV: KVNamespace }).TEST_OAUTH_KV;
const oauthEnv = { ...(env as object), OAUTH_KV } as unknown as Env;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));

/** A fake GitHub: one valid code per login; `members` are active members of geolonia. Account ids: `ids`, else 1000. */
function fakeGithub(members: string[]) {
  const codes = new Map<string, { login: string; challenge: string; id: number }>();
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url);
    const auth = new Headers(init.headers).get('authorization') ?? '';
    if (url === 'https://github.com/login/oauth/access_token') {
      const form = new URLSearchParams(String(init.body));
      const entry = codes.get(form.get('code') ?? '');
      const ok = entry && form.get('client_id') === 'cid' && form.get('client_secret') === CLIENT_SECRET
        && form.get('redirect_uri') === `${BASE}/callback`
        && (await s256(form.get('code_verifier') ?? '')) === entry.challenge;
      return Response.json(ok ? { access_token: `gh-token-${entry.id}-${entry.login}` } : { error: 'bad_verification_code' });
    }
    const [, id, login = ''] = /^Bearer gh-token-(\d+)-(.*)$/.exec(auth) ?? [];
    if (url === 'https://api.github.com/user') return Response.json({ login, id: Number(id) });
    if (url === 'https://api.github.com/user/memberships/orgs/geolonia') {
      return members.includes(login) ? Response.json({ state: 'active' }) : new Response('{}', { status: 404 });
    }
    return new Response('unexpected', { status: 500 });
  };
  return { fetch, calls, issue: (code: string, login: string, challenge: string, id = 1000) => codes.set(code, { login, challenge, id }) };
}

function setup(members = ['octo']) {
  const github = fakeGithub(members);
  const oauth: OAuthConfig = { issuer: BASE, github: { clientId: 'cid', clientSecret: CLIENT_SECRET, orgs: ['geolonia'], fetch: github.fetch } };
  const deps = { ...depsFor(env as never), oauth };
  const app = createApp(() => deps);
  const jar = new Map<string, string>();
  const send = async (path: string, init: RequestInit = {}, cookies = true) => {
    const headers = new Headers(init.headers);
    if (cookies && jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await app.fetch(new Request(`${BASE}${path}`, { ...init, headers, redirect: 'manual' }), oauthEnv, createExecutionContext());
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  };
  return { github, send, jar };
}

type Setup = ReturnType<typeof setup>;

async function register(t: Setup, name = 'Test client') {
  const res = await t.send('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ client_id: string }>()).client_id;
}

/** Up to the consent page; returns the page and what the client keeps. */
async function startLogin(t: Setup, name?: string) {
  const clientId = await register(t, name);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: 'client-state',
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  });
  const res = await t.send(`/authorize?${q}`);
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  return { res, html, handle: handle!, clientId, verifier };
}

/** Allow on the consent page; returns the GitHub redirect. */
async function allow(t: Setup, handle: string) {
  const res = await t.send('/authorize', { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

/** The whole sign-in as `login`; returns an access token. */
async function signIn(t: Setup, who = 'octo', id?: number) {
  const { handle, clientId, verifier } = await startLogin(t);
  const github = await allow(t, handle);
  t.github.issue('gh-code', who, github.searchParams.get('code_challenge')!, id);
  const back = await t.send(`/callback?code=gh-code&state=${github.searchParams.get('state')}`);
  expect(back.status).toBe(302);
  const to = new URL(back.headers.get('location')!);
  const code = to.searchParams.get('code');
  if (!code) return { to, token: null, refresh: undefined, clientId };
  const res = await t.send('/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CLIENT_REDIRECT, client_id: clientId, code_verifier: verifier }),
  });
  expect(res.status).toBe(200);
  const tokens = await res.json<{ access_token: string; refresh_token?: string }>();
  return { to, token: tokens.access_token, refresh: tokens.refresh_token, clientId };
}

let nextId = 1;

async function rpc(t: Setup, token: string | null, method: string, params: unknown = {}) {
  const res = await t.send('/mcp', {
    method: 'POST',
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  }, false);
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, headers: res.headers, message: null };
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return { status: 200, headers: res.headers, message: data.at(-1) };
}

async function call(t: Setup, token: string, name: string, args: Record<string, unknown>) {
  const result = (await rpc(t, token, 'tools/call', { name, arguments: args })).message.result;
  return { isError: result.isError === true, text: result.content[0].text as string };
}

describe('GitHub login for /mcp', () => {
  it('answers unauthenticated requests with a challenge that points to the login', async () => {
    const t = setup();
    const r = await rpc(t, null, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect((await rpc(t, 'not-a-token', 'tools/list')).status).toBe(401);

    const meta = await (await t.send('/.well-known/oauth-protected-resource/mcp')).json<any>();
    expect(meta).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const as = await (await t.send('/.well-known/oauth-authorization-server')).json<any>();
    expect(as).toMatchObject({ issuer: BASE, authorization_endpoint: `${BASE}/authorize`, registration_endpoint: `${BASE}/oauth/register` });
  });

  it('logs in a member and gives them submit_feedback', async () => {
    const t = setup();
    const session = await signIn(t);
    const { to } = session;
    const token = session.token as string;
    expect(to.origin + to.pathname).toBe(CLIENT_REDIRECT);
    expect(to.searchParams.get('state')).toBe('client-state');
    // The GitHub token is used for the checks only.
    expect(t.github.calls).toEqual([
      'https://github.com/login/oauth/access_token',
      'https://api.github.com/user',
      'https://api.github.com/user/memberships/orgs/geolonia',
    ]);

    const tools = (await rpc(t, token, 'tools/list')).message.result.tools.map((x: any) => x.name).sort();
    expect(tools).toEqual(['decide', 'explain_profile', 'get_decision', 'list_profiles', 'replay_profile', 'submit_feedback']);

    const d = JSON.parse((await call(t, token, 'decide', { profile: 'issue-triage', state: { title: 'Login page is blank' } })).text);
    const row = await DB.prepare('SELECT client FROM decisions WHERE id = ?').bind(d.decision_id).first();
    // By the account id, which never changes; the login only names the person in feedback.
    expect(row).toEqual({ client: 'github:1000' });

    const fb = await call(t, token, 'submit_feedback', { decision_id: d.decision_id, correct: { team: 'frontend' }, note: 'UI bug' });
    expect(fb).toEqual({ isError: false, text: JSON.stringify({ recorded: true }, null, 2) });
    const stored = await DB.prepare('SELECT client, by, correct, note FROM feedback WHERE decision_id = ?').bind(d.decision_id).first();
    expect(stored).toEqual({ client: 'github:1000', by: 'octo', correct: '{"team":"frontend"}', note: 'UI bug' });
  });

  it('another account that takes over a login is not the earlier owner', async () => {
    const t = setup();
    const first = (await signIn(t, 'octo', 1000)).token as string;
    const d = JSON.parse((await call(t, first, 'decide', { profile: 'issue-triage', state: { title: 'Login page is blank' } })).text);
    const later = (await signIn(t, 'octo', 2000)).token as string;
    const e = JSON.parse((await call(t, later, 'decide', { profile: 'issue-triage', state: { title: 'Login page is blank' } })).text);
    const rows = await DB.prepare('SELECT id, client FROM decisions WHERE id IN (?, ?)').bind(d.decision_id, e.decision_id).all();
    expect(Object.fromEntries(rows.results.map((r) => [r.id, r.client]))).toEqual({ [d.decision_id]: 'github:1000', [e.decision_id]: 'github:2000' });
  });

  it('a grant with the account id can be refreshed', async () => {
    const t = setup();
    const { refresh, clientId } = await signIn(t);
    expect(typeof refresh).toBe('string');
    const res = await t.send('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh!, client_id: clientId }) });
    expect(res.status).toBe(200);
    const token = (await res.json<{ access_token: string }>()).access_token;
    expect((await rpc(t, token, 'tools/list')).status).toBe(200);
  });

  it('refuses a GitHub user without an account id', async () => {
    const t = setup();
    const { handle } = await startLogin(t);
    const github = await allow(t, handle);
    t.github.issue('gh-code', 'octo', github.searchParams.get('code_challenge')!, 0);
    const back = await t.send(`/callback?code=gh-code&state=${github.searchParams.get('state')}`);
    expect(back.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses invalid feedback and decisions that are not visible', async () => {
    const t = setup();
    const token = (await signIn(t)).token as string;
    const d = JSON.parse((await call(t, token, 'decide', { profile: 'issue-triage', state: { title: 'T' } })).text);
    const bad = await call(t, token, 'submit_feedback', { decision_id: d.decision_id, correct: { team: 'marketing' } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('correct.team');
    const unknown = await call(t, token, 'submit_feedback', { decision_id: crypto.randomUUID(), correct: { team: 'docs' } });
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining('unknown decision') });
  });

  it('turns away people outside the allowed organizations', async () => {
    const t = setup(['someone-else']);
    const session = await signIn(t, 'octo');
    const { to } = session;
    expect(session.token).toBeNull();
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('client-state');
  });

  it('sends a Deny back to the client without going to GitHub', async () => {
    const t = setup();
    const { handle } = await startLogin(t);
    const res = await t.send('/authorize', { method: 'POST', body: new URLSearchParams({ handle, decision: 'deny' }) });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(t.github.calls).toEqual([]);
  });

  it('shows the client and escapes what it registered', async () => {
    const t = setup();
    const { res, html } = await startLogin(t, '<script>x</script>');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(html).toContain('&#60;script&#62;x&#60;/script&#62;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('client.test');
    expect(html).toContain('<strong>geolonia</strong>');
  });

  it('refuses a consent or callback from another browser (no cookie)', async () => {
    const t = setup();
    const { handle } = await startLogin(t);
    t.jar.clear();
    const res = await t.send('/authorize', { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Login failed');

    const t2 = setup();
    const github = await allow(t2, (await startLogin(t2)).handle);
    t2.jar.clear();
    const back = await t2.send(`/callback?code=x&state=${github.searchParams.get('state')}`);
    expect(back.status).toBe(400);
    expect(t2.github.calls).toEqual([]);
  });

  it('denies when GitHub does not accept the code', async () => {
    const t = setup();
    const github = await allow(t, (await startLogin(t)).handle);
    // No code issued: the fake GitHub answers with an error.
    const back = await t.send(`/callback?code=wrong&state=${github.searchParams.get('state')}`);
    expect(new URL(back.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('still takes API tokens, without submit_feedback', async () => {
    const t = setup();
    const token = newToken();
    await env.TOKENS.put(tokenKey(await hashToken(token)), JSON.stringify({ client: 'agent', profiles: ['*'], created_at: '' }));
    const tools = (await rpc(t, token, 'tools/list')).message.result.tools.map((x: any) => x.name).sort();
    expect(tools).toEqual(['decide', 'explain_profile', 'get_decision', 'list_profiles', 'replay_profile']);
    // A revoked or unknown API token is not tried as an OAuth token.
    expect((await rpc(t, newToken(), 'tools/list')).status).toBe(401);
  });
});

describe('OAuth configuration', () => {
  const full = {
    ...(env as object),
    PUBLIC_URL: 'https://pointsman.example',
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    ALLOWED_GITHUB_ORGS: 'geolonia, other',
    OAUTH_KV,
  };

  it('is off without settings, so the OAuth routes are not found', async () => {
    expect(depsFor(env as never).oauth).toBeUndefined();
    expect((await exports.default.fetch(`${BASE}/authorize`)).status).toBe(404);
    expect((await exports.default.fetch(`${BASE}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });

  it('reads all settings', () => {
    expect(depsFor(full as never).oauth).toMatchObject({
      issuer: 'https://pointsman.example',
      github: { clientId: 'cid', clientSecret: CLIENT_SECRET, orgs: ['geolonia', 'other'] },
    });
  });

  it.each([
    ['a missing secret', { GITHUB_CLIENT_SECRET: undefined }, 'GITHUB_CLIENT_SECRET'],
    ['a missing KV namespace', { OAUTH_KV: undefined }, 'OAUTH_KV'],
    ['a URL with a path', { PUBLIC_URL: 'https://pointsman.example/x' }, 'PUBLIC_URL'],
    ['an http URL', { PUBLIC_URL: 'http://pointsman.example' }, 'PUBLIC_URL'],
    ['no organization', { ALLOWED_GITHUB_ORGS: ' , ' }, 'ALLOWED_GITHUB_ORGS'],
  ])('refuses %s', (_, change, message) => {
    expect(() => depsFor({ ...full, ...change } as never)).toThrow(ConfigError);
    expect(() => depsFor({ ...full, ...change } as never)).toThrow(message);
  });
});
