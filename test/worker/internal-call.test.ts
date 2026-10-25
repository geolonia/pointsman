// Internal calls (docs/adapters.md#internal-calls): the engine's InternalEngine
// entrypoint and src/internal.ts, and the GitHub connector's binding adapter
// (connectors/github/src/engine-binding.ts) and settings.

import { env, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { fakeLog, noCallbacks } from './helpers';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { decideInternal, internalClient } from '../../src/internal';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { DecisionLog, DecisionRecord } from '../../src/log';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import { InternalEngine } from '../../src/index';
import { bindingEngine, type EngineBinding } from '../../connectors/github/src/engine-binding';
import { actionOf, checkDecision, connectorSettings, type Decision, engineSetting, pullRequestWork, RetryError, type CheckRunOutput, type ObjectStorage } from '@pointsman/github';
import { ConfigError } from '@pointsman/module-api';

const CLIENT = JSON.stringify({ client: 'github-connector', profiles: ['deploy-progress'] });
const body = { state: 'Deploy has had no event for 40 minutes.' };

/** The entrypoint with these settings (the class itself; the last test of the block calls it over RPC). */
type Answer = Promise<{ status: number; body: any }>;
type Engine = {
  decide(profile: unknown, request: unknown, options?: unknown): Answer;
  get(id: unknown): Answer;
  resolve(id: unknown, request: unknown): Answer;
  close(id: unknown): Answer;
};
const engineWith = (settings: Record<string, unknown>): Engine => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  return new InternalEngine(ctx, { ...env, ...settings } as Env) as unknown as Engine;
};

describe('INTERNAL_CLIENT', () => {
  it('names a client and its listed profiles; never a test token, never expiring', () => {
    expect(internalClient(CLIENT)).toEqual({ client: 'github-connector', profiles: ['deploy-progress'], created_at: '1970-01-01T00:00:00.000Z' });
  });

  it('refuses a missing or wrong setting', () => {
    expect(() => internalClient(undefined)).toThrow(/not set/);
    expect(() => internalClient('')).toThrow(/not set/);
    expect(() => internalClient('{')).toThrow(/not valid JSON/);
    expect(() => internalClient('[]')).toThrow(/must be an object/);
    expect(() => internalClient(JSON.stringify({ client: 'Bad Name', profiles: ['a'] }))).toThrow(/"client"/);
    expect(() => internalClient(JSON.stringify({ client: 'c', profiles: ['*'] }))).toThrow(/"\*" is not allowed/);
    expect(() => internalClient(JSON.stringify({ client: 'c', profiles: [] }))).toThrow(/"profiles"/);
    expect(() => internalClient(JSON.stringify({ client: 'c', profiles: ['a'], test: true }))).toThrow(/unknown key test/);
    expect(() => internalClient(JSON.stringify({ client: 'c', profiles: ['a'], expires_at: '2099-01-01' }))).toThrow(/unknown key expires_at/);
  });
});

describe('decideInternal: the same path as POST /v1/decide after the token check', () => {
  const store = new MemoryProfileStore(bundled as Profile[]);
  const inserted: DecisionRecord[] = [];
  const log: DecisionLog = fakeLog({ insert: async (r) => void inserted.push(r) });
  const TOKEN = newToken();
  const tokens = new MemoryTokenStore();
  const deps: Deps = { callbacks: noCallbacks, store, tokens, log, adapterFor: () => new MockAdapter() };
  const client = internalClient(CLIENT);

  it('decides and logs under the internal client', async () => {
    const answer = await decideInternal(deps, client, 'deploy-progress', body, { idempotencyKey: 'k-1' });
    expect(answer.status).toBe(200);
    expect((answer.body as { test?: boolean }).test).toBeUndefined();
    expect(inserted.at(-1)).toMatchObject({ client: 'github-connector', profile: 'deploy-progress', idempotency_key: 'k-1' });
  });

  it('refuses a profile outside its scope exactly as the HTTP route refuses a token', async () => {
    tokens.records.set(await hashToken(TOKEN), { ...client, created_at: '2026-10-23T00:00:00Z' });
    const app = createApp(() => deps);
    const http = await app.request('/v1/decide/issue-triage', { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${TOKEN}` } }, env);
    const internal = await decideInternal(deps, client, 'issue-triage', body, {});
    expect(internal.status).toBe(403);
    expect(http.status).toBe(403);
    expect(internal.body).toEqual(await http.json());
  });

  it('passes only JSON values on, and checks the arguments', async () => {
    expect((await decideInternal(deps, client, 'deploy-progress', { state: 1n }, {})).status).toBe(400);
    expect((await decideInternal(deps, client, 'deploy-progress', undefined, {})).status).toBe(400);
    expect((await decideInternal(deps, client, 42, body, {})).status).toBe(400);
    expect((await decideInternal(deps, client, 'deploy-progress', body, { idempotencyKey: 7 })).status).toBe(400);
    expect((await decideInternal(deps, client, 'deploy-progress', body, { client: 'someone-else' })).status).toBe(400);
    expect((await decideInternal(deps, client, 'deploy-progress', body, { version: 0 })).status).toBe(400);
    expect((await decideInternal(deps, client, 'deploy-progress', body, [])).status).toBe(400);
    // The idempotency key is checked as over HTTP.
    expect((await decideInternal(deps, client, 'deploy-progress', body, { idempotencyKey: '' })).status).toBe(400);
  });
});

describe('InternalEngine (the Cloudflare entrypoint)', () => {
  it('decides as INTERNAL_CLIENT and logs the decision in D1 under that client', async () => {
    const engine = engineWith({ INTERNAL_CLIENT: CLIENT });
    const answer = await engine.decide('deploy-progress', body, { idempotencyKey: crypto.randomUUID() });
    expect(answer.status).toBe(200);
    const row = await env.DB.prepare('SELECT client FROM decisions WHERE id = ?').bind(answer.body.decision_id).first<{ client: string }>();
    expect(row?.client).toBe('github-connector');
  });

  it('refuses a profile outside INTERNAL_CLIENT', async () => {
    const answer = await engineWith({ INTERNAL_CLIENT: CLIENT }).decide('issue-triage', body, {});
    expect(answer).toEqual({ status: 403, body: { error: { code: 'forbidden', message: 'this token may not use this profile' } } });
  });

  it('refuses every call without INTERNAL_CLIENT, without its value in the log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = await engineWith({ INTERNAL_CLIENT: undefined }).decide('deploy-progress', body, {});
    expect(answer).toEqual({ status: 500, body: { error: { code: 'not_configured', message: 'internal calls are not configured' } } });
    expect(errors.mock.calls.join(' ')).toContain('INTERNAL_CLIENT is not set');
    errors.mockRestore();
  });

  it('is a named entrypoint of the engine Worker, reached over RPC', async () => {
    // The Worker's own settings (wrangler.jsonc) have no INTERNAL_CLIENT: refused, over a real RPC call.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rpc = (exports as unknown as { InternalEngine: Engine }).InternalEngine;
    expect(await rpc.decide('deploy-progress', body, {})).toEqual({ status: 500, body: { error: { code: 'not_configured', message: 'internal calls are not configured' } } });
    errors.mockRestore();
  });
});

describe('InternalEngine: get, resolve and close, as the routes after the token check', () => {
  const engine = engineWith({ INTERNAL_CLIENT: CLIENT });
  /** A decision of the internal client whose review is pending (deploy-progress decides without a person here). */
  async function pending(client = 'github-connector'): Promise<string> {
    const answer = await engine.decide('deploy-progress', body, { idempotencyKey: crypto.randomUUID() });
    expect(answer.status).toBe(200);
    const id = answer.body.decision_id as string;
    await env.DB.prepare("UPDATE decisions SET review_status = 'pending', client = ? WHERE id = ?").bind(client, id).run();
    return id;
  }

  it('get reads a decision in scope as GET /v1/decisions/{id} does', async () => {
    const id = await pending();
    const answer = await engine.get(id);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ decision_id: id, client: 'github-connector', profile: 'deploy-progress', review: { status: 'pending' }, feedback: [] });
    expect(answer.body.request_digest).toBeUndefined();
    // Out of scope (another profile) or unknown: not found. Not a string: refused.
    await env.DB.prepare("UPDATE decisions SET profile_id = 'issue-triage' WHERE id = ?").bind(await pending()).run();
    const other = (await env.DB.prepare("SELECT id FROM decisions WHERE profile_id = 'issue-triage' AND client = 'github-connector' LIMIT 1").first<{ id: string }>())!.id;
    expect((await engine.get(other)).status).toBe(404);
    expect((await engine.get('00000000-0000-4000-8000-000000000000')).body.error.code).toBe('decision_not_found');
    expect((await engine.get(42)).status).toBe(400);
  });

  it('close closes its own pending review; a later resolve gets 409', async () => {
    const id = await pending();
    expect(await engine.close(id)).toEqual({ status: 200, body: { decision_id: id, review: { status: 'superseded' } } });
    expect((await engine.resolve(id, { action: 'reject', by: 'github:octocat (1)' })).body.error.code).toBe('not_pending');
    expect((await engine.close(id)).status).toBe(409);
    expect((await engine.get(id)).body.review).toEqual({ status: 'superseded' });
  });

  it('close refuses a decision another client made (404), and resolve stays open to it', async () => {
    const id = await pending('another-client');
    expect((await engine.close(id)).body.error.code).toBe('decision_not_found');
    expect((await engine.close(undefined)).status).toBe(400);
    const answer = await engine.resolve(id, { action: 'reject', by: 'github:octocat (1)' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ decision_id: id, action: 'reject', resolved_by: 'github:octocat (1)', callback: 'none' });
    const row = await env.DB.prepare('SELECT review_status, resolved_client FROM decisions WHERE id = ?').bind(id).first();
    expect(row).toEqual({ review_status: 'resolved', resolved_client: 'github-connector' });
  });

  it('resolve checks the body as the route does: only JSON, only the profile\'s people_answers', async () => {
    const id = await pending();
    expect((await engine.resolve(id, { action: 'review', by: 'x' })).status).toBe(400);
    expect((await engine.resolve(id, { action: 'not-an-answer', by: 'x' })).body.error.message).toMatch(/must be one of/);
    expect((await engine.resolve(id, undefined)).status).toBe(400);
    expect((await engine.resolve(id, { action: 'reject', by: 'x', extra: 1 })).status).toBe(400);
    expect((await engine.resolve(7, { action: 'reject', by: 'x' })).status).toBe(400);
    expect((await engine.get(id)).body.review.status).toBe('pending');
  });

  it('a decision read back in its real shape passes the connector\'s check: pending, then the person\'s answer as the action', async () => {
    const ref = `github:example/repo#1@${'c'.repeat(40)}`;
    const made = await engine.decide('deploy-progress', { ...body, ref }, { idempotencyKey: crypto.randomUUID() });
    const id = made.body.decision_id as string;
    await env.DB.prepare("UPDATE decisions SET review_status = 'pending' WHERE id = ?").bind(id).run();
    const pendingRecord = (await engine.get(id)).body;
    expect(checkDecision(pendingRecord, { profile: 'deploy-progress', ref })).toEqual({ kind: 'decision', decision: pendingRecord });
    expect((await engine.resolve(id, { action: 'reject', by: 'github:octocat (1)' })).status).toBe(200);
    const record = (await engine.get(id)).body;
    // As GET /v1/decisions/{id} gives it: client, state_hash, feedback, the review with who and when.
    expect(record).toMatchObject({ client: 'github-connector', state_hash: expect.any(String), feedback: [], review: { status: 'resolved', final_action: 'reject', resolved_by: 'github:octocat (1)' } });
    const checked = checkDecision(record, { profile: 'deploy-progress', ref });
    expect(checked.kind).toBe('decision');
    expect(actionOf((checked as { decision: Decision }).decision)).toBe('reject');
    // Closed: not a decision the connector acts on.
    const other = await pending();
    await engine.close(other);
    expect(checkDecision((await engine.get(other)).body, { profile: 'deploy-progress', ref: 'x' }).kind).toBe('invalid');
  });

  it('refuses get, resolve and close without INTERNAL_CLIENT, also over RPC', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = engineWith({ INTERNAL_CLIENT: undefined });
    const refused = { status: 500, body: { error: { code: 'not_configured', message: 'internal calls are not configured' } } };
    const id = crypto.randomUUID();
    expect(await off.get(id)).toEqual(refused);
    expect(await off.resolve(id, { action: 'reject', by: 'x' })).toEqual(refused);
    expect(await off.close(id)).toEqual(refused);
    const rpc = (exports as unknown as { InternalEngine: Engine }).InternalEngine;
    expect(await rpc.get(id)).toEqual(refused);
    expect(await rpc.resolve(id, { action: 'reject', by: 'x' })).toEqual(refused);
    expect(await rpc.close(id)).toEqual(refused);
    errors.mockRestore();
  });
});

// The connector side.

const APP_ID = '4242';
async function pemKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}
const KEY = await pemKey();
// Made at run time, so no secret-looking literal sits in the code.
const base = {
  GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: `whsec-${crypto.randomUUID()}`,
  GITHUB_CONNECTOR: JSON.stringify({ repos: ['example/repo'], profiles: ['pr-docs-check'] }),
};
const binding = (decide: EngineBinding['decide'] = async () => ({ status: 200, body: {} }), more: Partial<EngineBinding> = {}): EngineBinding => ({
  decide, get: async () => ({ status: 404, body: { error: { code: 'decision_not_found' } } }), close: async () => ({ status: 200, body: {} }), ...more,
});

describe('the connector: how it reaches the engine', () => {
  const token = `pm_${crypto.randomUUID()}`;
  const url = 'https://pointsman.example.org';

  it('HTTP with a token stays the default; the binding POINTSMAN chooses the internal call', () => {
    expect(engineSetting({ POINTSMAN_URL: `${url}/`, POINTSMAN_TOKEN: token })).toEqual({ kind: 'http', url, token });
    expect(engineSetting({ POINTSMAN: binding() })).toEqual({ kind: 'internal' });
    expect(connectorSettings({ ...base, POINTSMAN: binding() })!.engine).toEqual({ kind: 'internal' });
  });

  it('fails loudly on a half-configured or mixed setup', () => {
    expect(() => connectorSettings(base)).toThrow(/set the POINTSMAN binding, or POINTSMAN_URL and POINTSMAN_TOKEN/);
    expect(() => engineSetting({})).toThrow(ConfigError);
    expect(() => engineSetting({ POINTSMAN_URL: url })).toThrow(/POINTSMAN_TOKEN is not set/);
    expect(() => engineSetting({ POINTSMAN_TOKEN: token })).toThrow(/POINTSMAN_URL must be an https URL/);
    expect(() => engineSetting({ POINTSMAN_URL: 'http://pointsman.example.org', POINTSMAN_TOKEN: token })).toThrow(/https/);
    expect(() => engineSetting({ POINTSMAN: binding(), POINTSMAN_URL: url })).toThrow(/not both/);
    expect(() => engineSetting({ POINTSMAN: 'pointsman' })).toThrow(/must be a binding/);
  });

  it('warns about a leftover token next to the binding, without its value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(engineSetting({ POINTSMAN: binding(), POINTSMAN_TOKEN: token })).toEqual({ kind: 'internal' });
    expect(warn.mock.calls.join(' ')).toContain('POINTSMAN_TOKEN is set but not used');
    expect(warn.mock.calls.join(' ')).not.toContain(token);
    warn.mockRestore();
  });
});

describe('the connector: binding adapter', () => {
  it('calls decide on the binding with no token, and passes the answer on', async () => {
    const calls: unknown[][] = [];
    const engine = bindingEngine(binding(async (...args) => (calls.push(args), { status: 200, body: { decision_id: 'd' } })));
    const req = { state: { pull_request: { repo: 'example/repo' } }, ref: 'github:example/repo#1@abc' };
    expect(await engine.decide('pr-docs-check', req, { idempotencyKey: 'k' })).toEqual({ status: 200, body: { decision_id: 'd' } });
    expect(calls).toEqual([['pr-docs-check', req, { idempotencyKey: 'k' }]]);
    expect(JSON.stringify(calls)).not.toMatch(/pm_|Bearer/);
    // Of a refusal only the error code is passed on, for the log.
    expect(await bindingEngine(binding(async () => ({ status: 403, body: { error: { code: 'forbidden', message: 'x' } } }))).decide('p', req, { idempotencyKey: 'k' })).toEqual({ status: 403, code: 'forbidden' });
    expect(await bindingEngine(binding(async () => ({ status: 500, body: { error: { code: 'Not A Code' } } }))).decide('p', req, { idempotencyKey: 'k' })).toEqual({ status: 500 });
  });

  it('get and close go to the binding with the id only, no token, and are checked like decide', async () => {
    const calls: unknown[][] = [];
    const id = crypto.randomUUID();
    const engine = bindingEngine(binding(undefined, {
      get: async (...args) => (calls.push(['get', ...args]), { status: 200, body: { decision_id: id } }),
      close: async (...args) => (calls.push(['close', ...args]), { status: 409, body: { error: { code: 'not_pending', message: 'x' } } }),
    }));
    expect(await engine.get(id)).toEqual({ status: 200, body: { decision_id: id } });
    expect(await engine.close(id)).toEqual({ status: 409, code: 'not_pending' });
    expect(calls).toEqual([['get', id], ['close', id]]);
    // An engine older than the connector (no close yet): the error says what to update.
    await expect(bindingEngine(binding(undefined, { close: () => { throw new TypeError('The RPC receiver does not implement the method "close".'); } })).close(id))
      .rejects.toThrow(/as new as the connector \(close\)/);
    await expect(bindingEngine(binding(undefined, { get: async () => 'x' })).get(id)).rejects.toThrow(/no engine answer/);
  });

  it('the binding reaches InternalEngine\'s get and close: a pending question read back and closed as INTERNAL_CLIENT', async () => {
    const internal = engineWith({ INTERNAL_CLIENT: CLIENT });
    const engine = bindingEngine(internal as unknown as EngineBinding);
    const made = await internal.decide('deploy-progress', body, { idempotencyKey: crypto.randomUUID() });
    const id = made.body.decision_id as string;
    await env.DB.prepare("UPDATE decisions SET review_status = 'pending' WHERE id = ?").bind(id).run();
    expect((await engine.get(id)).body).toMatchObject({ decision_id: id, review: { status: 'pending' } });
    expect(await engine.close(id)).toEqual({ status: 200, body: { decision_id: id, review: { status: 'superseded' } } });
    expect(await engine.close(id)).toEqual({ status: 409, code: 'not_pending' });
  });

  it('throws (so the run is tried again) when the binding fails, answers nonsense or takes too long', async () => {
    const req = { state: {}, ref: 'r' };
    await expect(bindingEngine(binding(async () => { throw new Error('down'); })).decide('p', req, { idempotencyKey: 'k' })).rejects.toThrow('down');
    await expect(bindingEngine(binding(async () => new Response('x'))).decide('p', req, { idempotencyKey: 'k' })).rejects.toThrow(/no engine answer/);
    await expect(bindingEngine(binding(async () => ({ status: 'ok' }))).decide('p', req, { idempotencyKey: 'k' })).rejects.toThrow(/no engine answer/);
    // A 2xx without a decision is passed on as it came: the connector's check refuses it (not tried again), as over HTTP.
    expect(await bindingEngine(binding(async () => ({ status: 200 }))).decide('p', req, { idempotencyKey: 'k' })).toEqual({ status: 200, body: undefined });
    expect(await bindingEngine(binding(async () => ({ status: 200, body: 'light' }))).decide('p', req, { idempotencyKey: 'k' })).toEqual({ status: 200, body: 'light' });
    // A fetch binding without the entrypoint: the runtime refuses the method; the error says what to set.
    await expect(bindingEngine(binding(() => { throw new TypeError('The RPC receiver does not implement the method "decide".'); })).decide('p', req, { idempotencyKey: 'k' }))
      .rejects.toThrow(/"entrypoint": "InternalEngine"/);
    await expect(bindingEngine(binding(() => new Promise(() => {})), 20).decide('p', req, { idempotencyKey: 'k' })).rejects.toThrow(/did not answer/);
  });

  it('a pull request run through the binding: retried on 5xx, logged and skipped on 4xx', async () => {
    const data = new Map<string, unknown>();
    const storage: ObjectStorage = {
      get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
      put: async (entries) => { for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v)); },
      setAlarm: async () => {},
    };
    const settings = connectorSettings({ ...base, POINTSMAN: binding() })!;
    const github = {
      pullRequest: async () => ({ open: true, head: 'a'.repeat(40), draft: false, base: 'main', title: 'T', body: 'B', fork: false, labels: [], requestedReviewers: [] }),
      findCheckRun: async () => undefined, createCheckRun: async () => 1, updateCheckRun: async () => {},
    } as unknown as Parameters<typeof pullRequestWork>[3];
    const run = async (status: number, code?: string) => {
      const work = pullRequestWork(settings, storage, bindingEngine(binding(async () => ({ status, body: { error: { code } } }))), github);
      await work.accept({ target: { repo: 'example/repo', number: 1 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
      return work.run();
    };
    await expect(run(500, 'not_configured')).rejects.toThrow(/Pointsman pr-docs-check: 500 not_configured/);
    await expect(run(503)).rejects.toBeInstanceOf(RetryError);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(403, 'forbidden');
    expect(errors.mock.calls.join(' ')).toContain('Pointsman pr-docs-check for example/repo#1: 403 forbidden');
    errors.mockRestore();
  });
});

describe('the connector checks the answer the same way through both adapters', () => {
  const store = new MemoryProfileStore(bundled as Profile[]);
  const log: DecisionLog = fakeLog({ insert: async () => {} });
  const tokens = new MemoryTokenStore();
  const deps: Deps = { callbacks: noCallbacks, store, tokens, log, adapterFor: () => new MockAdapter() };
  const ref = 'github:example/repo#1@abc';

  it('the engine\'s own decision passes; a test token\'s decision is a test decision', async () => {
    const internal = await decideInternal(deps, internalClient(CLIENT), 'deploy-progress', { ...body, ref }, { idempotencyKey: crypto.randomUUID() });
    expect(checkDecision(internal.body, { profile: 'deploy-progress', ref })).toEqual({ kind: 'decision', decision: internal.body });
    const TEST_TOKEN = newToken();
    tokens.records.set(await hashToken(TEST_TOKEN), { client: 'examples-check', profiles: ['deploy-progress'], created_at: '2026-10-23T00:00:00Z', test: true });
    const http = await createApp(() => deps).request('/v1/decide/deploy-progress', { method: 'POST', body: JSON.stringify({ ...body, ref }), headers: { authorization: `Bearer ${TEST_TOKEN}` } }, env);
    const decided = await http.json();
    expect(checkDecision(decided, { profile: 'deploy-progress', ref })).toEqual({ kind: 'test', decision: decided });
  });

  it('a pull request run through the binding: an invalid answer and a test decision do nothing and say so', async () => {
    const data = new Map<string, unknown>();
    const storage: ObjectStorage = {
      get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
      put: async (entries) => { for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v)); },
      setAlarm: async () => {},
    };
    const settings = connectorSettings({ ...base, POINTSMAN: binding() })!;
    const outputs: CheckRunOutput[] = [];
    const github = {
      pullRequest: async () => ({ open: true, head: 'a'.repeat(40), draft: false, base: 'main', title: 'T', body: 'B', fork: false, labels: [], requestedReviewers: [] }),
      findCheckRun: async () => undefined,
      createCheckRun: async (_r: string, _h: string, _n: string, o: CheckRunOutput) => (outputs.push(o), 1),
      updateCheckRun: async (_r: string, _i: number, o: CheckRunOutput) => void outputs.push(o),
    } as unknown as Parameters<typeof pullRequestWork>[3];
    const decision = { decision_id: crypto.randomUUID(), ref: `github:example/repo#1@${'a'.repeat(40)}`, action: 'light', profile: 'pr-docs-check', profile_version: 1, rule: null };
    const run = async (answer: unknown) => {
      const work = pullRequestWork(settings, storage, bindingEngine(binding(async () => ({ status: 200, body: answer }))), github);
      await work.accept({ target: { repo: 'example/repo', number: 1 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
      await work.run();
      return outputs.at(-1)!;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await run(decision)).title).toBe('🟡 light (shadow)');
    expect((await run({ ...decision, action: '' })).title).toBe('invalid answer: nothing done');
    expect((await run([decision])).title).toBe('invalid answer: nothing done');
    expect((await run('light')).title).toBe('invalid answer: nothing done');
    expect((await run(undefined)).summary).toContain('not an object');
    expect((await run({ ...decision, profile: 'other' })).summary).toContain('"profile" is not the profile asked');
    expect((await run({ ...decision, test: true })).title).toBe('test decision: nothing done');
    errors.mockRestore();
  });
});
