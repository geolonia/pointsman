// MCP endpoint (/mcp): JSON-RPC over Streamable HTTP, with API tokens.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, newToken, tokenKey } from '../../src/auth';
import { D1DecisionLog } from '../../src/log-d1';
import { TOOLS } from '../../src/mcp-tools';

const ALL = newToken();
const DEPLOY_ONLY = newToken();
const TEST_ONLY = newToken();
const DB = (env as unknown as { DB: D1Database }).DB;

beforeEach(async () => {
  for (const [token, client, profiles] of [[ALL, 'agent', ['*']], [DEPLOY_ONLY, 'deploy-bot', ['deploy-progress']]] as const) {
    await env.TOKENS.put(tokenKey(await hashToken(token)), JSON.stringify({ client, profiles, created_at: '' }));
  }
  await env.TOKENS.put(tokenKey(await hashToken(TEST_ONLY)), JSON.stringify({ client: 'examples-check', profiles: ['*'], created_at: '', test: true }));
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
  return { isError: result.isError === true, text: result.content[0].text as string, structured: result.structuredContent };
}

describe('/mcp', () => {
  it('needs a valid token', async () => {
    const r = await rpc('tools/list', {}, null);
    expect(r.status).toBe(401);
    expect(r.headers?.get('www-authenticate')).toBe('Bearer');
    expect((await rpc('tools/list', {}, newToken())).status).toBe(401);
  });

  it('initializes and offers list_profiles, explain_profile, decide and get_decision (no feedback for tokens)', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.message.result.serverInfo.name).toBe('pointsman');
    const tools = (await rpc('tools/list')).message.result.tools.map((t: any) => t.name).sort();
    expect(tools).toEqual(['decide', 'explain_profile', 'get_decision', 'list_profiles', 'replay_profile']);
  });

  it('marks the reading tools read-only and decide as a destructive write that asks a model', async () => {
    const tools = (await rpc('tools/list')).message.result.tools as any[];
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of ['list_profiles', 'explain_profile', 'replay_profile', 'get_decision']) {
      expect(hints[name]).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    expect(hints.decide).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    // Only people logged in through OAuth get submit_feedback, so it is checked on its definition.
    expect(TOOLS.submit_feedback.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    for (const [name, tool] of Object.entries(TOOLS)) {
      if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint, name).toBe(false);
    }
  });

  it('returns results as structured content, with the same JSON as text', async () => {
    const list = await call('list_profiles', {});
    expect(list.structured).toEqual(JSON.parse(list.text));
    const d = await call('decide', { profile: 'issue-triage', state: { title: 'T' } });
    expect(d.structured).toEqual(JSON.parse(d.text));
    const got = await call('get_decision', { decision_id: JSON.parse(d.text).decision_id });
    expect(got.isError).toBe(false);
    expect(got.structured).toEqual(JSON.parse(got.text));
    expect(got.structured).not.toHaveProperty('state');
    const explained = await call('explain_profile', { profile: 'issue-triage' });
    expect(explained.structured).toEqual(JSON.parse(explained.text));
    expect((await call('explain_profile', { profile: 'nope' })).structured).toBeUndefined();
  });

  it('explains an MCP-visible profile in scope, and hides the others', async () => {
    const en = await call('explain_profile', { profile: 'issue-triage' });
    expect(en.isError).toBe(false);
    const e = JSON.parse(en.text);
    expect(e.rules[0].text).toBe('If the AI\'s certainty about "team" is at least 85 %, the action is auto.');
    expect(e.text).toContain('# Issue triage (issue-triage, v');
    const ja = JSON.parse((await call('explain_profile', { profile: 'issue-triage', lang: 'ja' })).text);
    expect(ja.rules[0].text).toBe('「team」についての AI の確信度が 85 % 以上なら、アクションは auto です。');
    // Not MCP-visible, out of scope, unknown, or an unknown version: all look the same.
    for (const [args, token] of [[{ profile: 'deploy-progress' }, ALL], [{ profile: 'issue-triage' }, DEPLOY_ONLY], [{ profile: 'nope' }, ALL]] as const) {
      const r = await call('explain_profile', args, token);
      expect(r).toEqual({ isError: true, text: `unknown profile "${args.profile}"` });
    }
    expect((await call('explain_profile', { profile: 'issue-triage', version: 99 })).isError).toBe(true);
  });

  it('replays a changed policy of an MCP-visible profile, and hides the others', async () => {
    // Two logged decisions of issue-triage through the real log.
    for (const ref of ['mcp-replay:1', 'mcp-replay:2']) {
      const d = await call('decide', { profile: 'issue-triage', state: { title: 'Blank page', body: 'Since today.' }, ref });
      expect(d.isError).toBe(false);
    }
    const r = await call('replay_profile', { profile: 'issue-triage', policy: { default: 'review' }, limit: 2 });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body).toMatchObject({ profile: 'issue-triage', replayed: 2 });
    expect(body.actions.after).toEqual({ review: 2 });
    // Not MCP-visible, out of scope, unknown: all look the same.
    for (const [args, token] of [[{ profile: 'deploy-progress' }, ALL], [{ profile: 'issue-triage' }, DEPLOY_ONLY], [{ profile: 'nope' }, ALL]] as const) {
      expect(await call('replay_profile', { ...args, policy: { default: 'review' } }, token)).toEqual({ isError: true, text: `unknown profile "${args.profile}"` });
    }
    const bad = await call('replay_profile', { profile: 'issue-triage', policy: { default: 'review', rules: [{ when: 'colour.p > 0', action: 'auto' }] } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^invalid_policy: rule 0: /);
  });

  it('lists only profiles that are MCP-visible and in scope', async () => {
    const all = JSON.parse((await call('list_profiles', {})).text);
    // deploy-progress does not set mcp.visible.
    expect(all.profiles.map((p: any) => p.id)).toEqual(['issue-triage']);
    expect(all.profiles[0]).toMatchObject({
      version: 1,
      state: { fields: ['title', 'body'] },
      actions: ['auto', 'review'],
      // A person checks review, and answers one of these (the default: the actions without review, plus reject).
      people_answers: ['auto', 'reject'],
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

  it('answers a repeated idempotency_key with the logged decision', async () => {
    const args = { profile: 'issue-triage', state: { title: 'T' }, ref: 'mcp:2', idempotency_key: `mcp-${crypto.randomUUID()}` };
    const a = JSON.parse((await call('decide', args)).text);
    const b = JSON.parse((await call('decide', args)).text);
    expect(b.decision_id).toBe(a.decision_id);
    const conflict = await call('decide', { ...args, state: { title: 'Other' } });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain('idempotency_conflict');
    const unchained = await call('decide', { profile: 'issue-triage', state: { title: 'T' }, ref: 'mcp:3', decisions: { x: crypto.randomUUID() } });
    expect(unchained.isError).toBe(true);
    expect(unchained.text).toContain('requires no decisions');
  });

  it('hides required decisions of profiles that are not MCP-visible, and the request digest', async () => {
    const visible = JSON.parse((await call('decide', { profile: 'issue-triage', state: { title: 'T' }, ref: 'mcp:4' })).text);
    const snap = (decision: string, profile: string) => ({ decision, profile, profile_version: 1, action: 'auto', outcome: 'auto', reviewed: false, read: {} });
    const id = crypto.randomUUID();
    // Written directly: no bundled MCP-visible profile has requires.
    await new D1DecisionLog(DB).insert({
      decision_id: id, ref: 'mcp:4', answers: visible.answers, action: 'auto', profile: 'issue-triage', profile_version: 1,
      model: 'mock', created_at: new Date().toISOString(), rule: null, client: 'agent', state_hash: '0'.repeat(64),
      requires: { seen: snap(visible.decision_id, 'issue-triage'), unseen: snap(crypto.randomUUID(), 'deploy-progress') },
      idempotency_key: 'k', request_digest: '1'.repeat(64),
    });
    const record = JSON.parse((await call('get_decision', { decision_id: id })).text);
    expect(record.requires.seen.decision).toBe(visible.decision_id);
    expect(record.requires.unseen).toEqual({ decision: null });
    expect(record.request_digest).toBeUndefined();
  });
});

describe('tool errors (#247)', () => {
  it('are logged, and the caller gets "internal error" without the details', async () => {
    const down = vi.spyOn(D1DecisionLog.prototype, 'get').mockRejectedValue(new Error('D1_ERROR: no such table: decisions_secret'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await call('get_decision', { decision_id: crypto.randomUUID() });
      expect(r).toMatchObject({ isError: true, text: 'internal error' });
      expect(logged.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('decisions_secret');
      expect(logged.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('get_decision');
    } finally {
      down.mockRestore();
      logged.mockRestore();
    }
  });
});

describe('test tokens', () => {
  it('are refused: over MCP they could read logged decisions', async () => {
    const r = await rpc('tools/list', {}, TEST_ONLY);
    expect(r.status).toBe(403);
    expect(r.text).toContain('a test token may only decide, list profiles and explain a profile over the REST API');
  });
});

describe('list_profiles KV reads (#263)', () => {
  it('reads the index once and each profile in scope once, with the same answer', async () => {
    const { serveMcp } = await import('../../src/mcp');
    const { KvProfileStore } = await import('../../src/profiles/store-kv');
    const { MemoryProfileStore } = await import('../../src/profiles/store');
    const { MockAdapter } = await import('../../src/models/mock');
    const bundled = (await import('../../generated/profiles.json')).default as unknown as import('../../src/types').Profile[];
    const base = bundled.find((p) => p.id === 'issue-triage')!;
    const visible = { ...base, mcp: { visible: true } };
    const { mcp: _, ...hidden } = base;
    // a (two versions), b requires a and a hidden profile, c is not MCP-visible.
    const all: import('../../src/types').Profile[] = [
      { ...visible, id: 'a', version: 1, title: { ...base.title, en: 'A old' } },
      { ...visible, id: 'a', version: 2 },
      { ...visible, id: 'b', version: 1, requires: [{ name: 'first', profile: 'a' }, { name: 'hidden', profile: 'c', optional: true }] },
      { ...hidden, id: 'c', version: 1 },
    ];
    const memory = new MemoryProfileStore(all);
    const data = new Map<string, unknown>([['index', await memory.list()], ...all.map((p) => [`profile:${p.id}:${p.version}`, p] as [string, unknown])]);
    const reads: string[] = [];
    const kv = { get: async (key: string) => { reads.push(key); return data.get(key) ?? null; } } as unknown as KVNamespace;
    const list = async (store: import('../../src/profiles/store').ProfileStore, profiles = ['*']) => {
      const res = await serveMcp(new Request('http://pointsman.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_profiles', arguments: {} } }),
      }), { store, adapterFor: () => new MockAdapter(), log: {} as never }, { kind: 'token', record: { client: 'agent', profiles, created_at: '' } });
      const text = await res.text();
      return JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).at(-1).result.content[0].text);
    };
    const fromKv = await list(new KvProfileStore(kv));
    expect(fromKv).toEqual(await list(memory));
    expect(fromKv.profiles.map((p: any) => [p.id, p.version])).toEqual([['a', 2], ['b', 1]]);
    expect(fromKv.profiles[1].requires).toEqual([{ name: 'first', profile: 'a' }, { name: 'hidden', optional: true }]);
    // The index once, then each profile in scope once (3 profiles): N + 1.
    expect(reads.filter((k) => k === 'index')).toHaveLength(1);
    expect(reads).toHaveLength(4);

    // A token for some profiles: only those are read and listed; a required
    // profile outside its scope is shown by name only, as from memory.
    reads.length = 0;
    const scoped = await list(new KvProfileStore(kv), ['b']);
    expect(scoped).toEqual(await list(memory, ['b']));
    expect(scoped.profiles.map((p: any) => p.id)).toEqual(['b']);
    expect(reads).toEqual(['index', 'profile:b:1']);

    // Right after a deploy, the index can name a version KV does not serve
    // yet: the newest readable version is listed instead, as before.
    data.delete('profile:a:2');
    const early = await list(new KvProfileStore(kv));
    expect(early.profiles.map((p: any) => [p.id, p.version, p.title.en])).toEqual([['a', 1, 'A old'], ['b', 1, expect.anything()]]);
  });
});

// Pins the answers of get_decision and submit_feedback, and that tokens do
// not get the people-only tools, so the code they share with the REST API
// (src/internal.ts) keeps them as they are (#265).
describe('pinned answers (#265)', () => {
  const PERSON = { kind: 'person', login: 'octo', id: 1000 } as const;

  async function callAs(caller: import('../../src/auth').Caller, name: string, args: Record<string, unknown>) {
    const { serveMcp } = await import('../../src/mcp');
    const { depsFor } = await import('../../src/index');
    const res = await serveMcp(new Request('http://pointsman.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    }), depsFor(env as never), caller);
    const text = await res.text();
    return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).at(-1);
  }
  const asPerson = async (name: string, args: Record<string, unknown>) => {
    const { result } = await callAs(PERSON, name, args);
    return { isError: result.isError === true, text: result.content[0].text as string, structured: result.structuredContent };
  };
  const feedbackOf = async (id: string) => (await DB.prepare('SELECT client, by, correct, note FROM feedback WHERE decision_id = ?').bind(id).all()).results;

  /** A decision written directly, with every field get_decision may hide. */
  async function logged(profile = 'issue-triage', extra: Record<string, unknown> = {}) {
    const id = crypto.randomUUID();
    await new D1DecisionLog(DB).insert({
      decision_id: id, created_at: '2026-11-01T00:00:00.000Z', client: 'agent', ref: 'pin:1', profile, profile_version: 1,
      model: 'mock', action: 'review', rule: null, answers: { team: { value: 'docs', p: 0.5 } } as never, state_hash: '0'.repeat(64),
      state: { title: 'secret state' }, callback_url: 'https://callback.test/hook', review: { status: 'pending' },
      idempotency_key: `pin-${id}`, request_digest: '1'.repeat(64), versions: { engine: '1.0.0', modules: {} },
      ...extra,
    } as never);
    return id;
  }

  it('get_decision answers these fields, without state, callback_url and the request digest', async () => {
    const id = await logged();
    const got = await call('get_decision', { decision_id: id });
    expect(got.isError).toBe(false);
    const rest = await (await exports.default.fetch(`http://pointsman.test/v1/decisions/${id}`, { headers: { authorization: `Bearer ${ALL}` } })).json<any>();
    const { state: _, ...restWithoutState } = rest;
    // The same as GET /v1/decisions/{id} without state, in the same order.
    expect(got.text).toBe(JSON.stringify(restWithoutState, null, 2));
    expect(Object.keys(got.structured)).toEqual(Object.keys(JSON.parse(got.text)));
    expect(rest.state).toEqual({ title: 'secret state' });
    expect(Object.keys(JSON.parse(got.text)).sort()).toEqual([
      'action', 'answers', 'client', 'created_at', 'decision_id', 'feedback', 'idempotency_key', 'model', 'profile', 'profile_version',
      'ref', 'review', 'rule', 'state_hash', 'versions',
    ]);
  });

  it('get_decision refuses with the same text for every decision it does not show', async () => {
    const hidden = await logged('deploy-progress');
    const visible = await logged();
    for (const [id, token] of [['not-a-uuid', ALL], [crypto.randomUUID(), ALL], [hidden, ALL], [visible, DEPLOY_ONLY]] as const) {
      expect(await call('get_decision', { decision_id: id }, token)).toEqual({ isError: true, text: `unknown decision "${id}"`, structured: undefined });
    }
    expect(await asPerson('get_decision', { decision_id: hidden })).toEqual({ isError: true, text: `unknown decision "${hidden}"`, structured: undefined });
  });

  it('submit_feedback records feedback under the login and the account id', async () => {
    const id = await logged();
    const r = await asPerson('submit_feedback', { decision_id: id, correct: { team: 'frontend' }, note: 'UI' });
    expect(r).toEqual({ isError: false, text: JSON.stringify({ recorded: true }, null, 2), structured: { recorded: true } });
    expect(await feedbackOf(id)).toEqual([{ client: 'github:1000', by: 'octo', correct: '{"team":"frontend"}', note: 'UI' }]);
    await asPerson('submit_feedback', { decision_id: id, correct: { team: 'docs' } });
    expect((await feedbackOf(id))[1]).toEqual({ client: 'github:1000', by: 'octo', correct: '{"team":"docs"}', note: null });
  });

  it('submit_feedback refuses decisions it does not show, a gone profile version and invalid feedback', async () => {
    const hidden = await logged('deploy-progress');
    for (const id of ['not-a-uuid', crypto.randomUUID(), hidden]) {
      expect(await asPerson('submit_feedback', { decision_id: id, correct: { team: 'docs' } })).toEqual({ isError: true, text: `unknown decision "${id}"`, structured: undefined });
    }
    const gone = await logged('issue-triage', { profile_version: 99 });
    expect(await asPerson('submit_feedback', { decision_id: gone, correct: { team: 'docs' } }))
      .toEqual({ isError: true, text: 'the profile version of this decision is no longer available', structured: undefined });
    const id = await logged();
    for (const [args, text] of [
      [{ correct: { team: 'marketing' } }, '"correct.team" must be one of: backend, frontend, docs'],
      [{ correct: {} }, '"correct" must be an object with at least one question'],
      [{ correct: { teem: 'docs' } }, '"correct": "teem" is not a question of profile issue-triage version 1'],
      [{ correct: { team: 'docs' }, note: 'n'.repeat(1001) }, '"note" must be a string of at most 1000 characters'],
    ] as const) {
      expect(await asPerson('submit_feedback', { decision_id: id, ...args })).toEqual({ isError: true, text, structured: undefined });
    }
    for (const d of [hidden, gone, id]) expect(await feedbackOf(d)).toEqual([]);
  });

  it('registers every tool of TOOLS, under its name, and no other; people-only ones only for people', async () => {
    const { PEOPLE_ONLY } = await import('../../src/mcp-tools');
    const list = async (caller: import('../../src/auth').Caller) => {
      const { serveMcp } = await import('../../src/mcp');
      const { depsFor } = await import('../../src/index');
      const res = await serveMcp(new Request('http://pointsman.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} }),
      }), depsFor(env as never), caller);
      const text = await res.text();
      const tools = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).at(-1).result.tools as any[];
      for (const t of tools) expect(t.description, t.name).toBe(TOOLS[t.name as keyof typeof TOOLS].description);
      return tools.map((t) => t.name).sort();
    };
    expect(PEOPLE_ONLY.size).toBeGreaterThan(0);
    expect(await list(PERSON)).toEqual(Object.keys(TOOLS).sort());
    expect(await list({ kind: 'token', record: { client: 'agent', profiles: ['*'], created_at: '' } }))
      .toEqual(Object.keys(TOOLS).filter((n) => !PEOPLE_ONLY.has(n)).sort());
  });

  it('a token gets no people-only tool, and calling one changes nothing', async () => {
    const { PEOPLE_ONLY } = await import('../../src/mcp-tools');
    const tools = (await rpc('tools/list')).message.result.tools.map((t: any) => t.name);
    for (const name of PEOPLE_ONLY) expect(tools).not.toContain(name);
    const id = await logged();
    const r = await callAs({ kind: 'token', record: { client: 'agent', profiles: ['*'], created_at: '' } }, 'submit_feedback', { decision_id: id, correct: { team: 'docs' } });
    expect(r.error).toEqual({ code: -32602, message: 'Tool submit_feedback not found' });
    expect(await feedbackOf(id)).toEqual([]);
  });
});
