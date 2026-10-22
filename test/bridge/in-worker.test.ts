// The FIWARE bridge inside the engine Worker (docs/connectors.md): a broker
// notification to /connectors/fiware/notify becomes a decision through the
// engine's own routes, with the bridge's token, and the result is written to
// the entity as the bridge in its own Worker writes it.

import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fiwareModule from '@pointsman/fiware';
import { hashToken, newToken } from '../../src/auth';
import { connectorsFor, worker } from '../../src/index';
import { ConfigError, type ConnectorEntry, type EngineApi } from '@pointsman/module-api';

/** A connector that only keeps the engine it was given, or fails to start. */
function probe(id: string, fail = false): ConnectorEntry & { engine?: EngineApi } {
  const entry: ConnectorEntry & { engine?: EngineApi } = {
    name: `@test/${id}`, version: '0.0.0',
    connector: { id, placements: ['engine'], settings: [], actions: [] },
    connect(_env, runtime) {
      if (fail) throw new ConfigError(`${id}: broken`);
      entry.engine = runtime.engine;
      return { fetch: async () => new Response('probe') };
    },
  };
  return entry;
}

const SECRET = crypto.randomUUID();
const BROKER = 'https://broker.example.org';
const ROUTES = JSON.stringify([{ type: 'RoadRestriction', profile: 'road-restriction-check', inputs: ['roadName', 'description'], attribute: 'check' }]);
const P = (value: unknown) => ({ type: 'Property', value });
const entity = { id: 'urn:ngsi-ld:RoadRestriction:in-worker', type: 'RoadRestriction', roadName: P('県道12号'), description: P('冠水のため通行止め') };

async function clientToken(client: string): Promise<string> {
  const token = newToken();
  await env.TOKENS.put(`token:${await hashToken(token)}`, JSON.stringify({ client, profiles: ['*'], created_at: '2026-10-22T00:00:00Z' }));
  return token;
}

/** Broker writes go to a fake; the engine is never reached over the network. */
function fakeBroker() {
  const calls: { method: string; url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(BROKER)) throw new Error(`unexpected request to ${url}`);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    // A queued message is read again from the broker first.
    if (method === 'GET') return Response.json(entity);
    return new Response(null, { status: 204 });
  });
  return calls;
}

async function call(path: string, extraEnv: Record<string, unknown>, init: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker([fiwareModule]).fetch(new Request(`https://pointsman.example.org${path}`, init), { ...env, ...extraEnv } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const notify = (secret = SECRET) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bridge-secret': secret },
  body: JSON.stringify({ type: 'Notification', data: [entity] }),
});

afterEach(() => vi.unstubAllGlobals());

describe('the FIWARE bridge inside the engine Worker', () => {
  it('decides through the engine with its own client and writes the result to the entity', async () => {
    const settings = { BRIDGE_ROUTES: ROUTES, BROKER_URL: BROKER, NOTIFY_SECRET: SECRET, POINTSMAN_TOKEN: await clientToken('fiware-bridge') };
    const calls = fakeBroker();
    const res = await call('/connectors/fiware/notify', settings, notify());
    expect(res.status).toBe(200);
    const { handled } = await res.json<any>();
    expect(handled).toHaveLength(1);
    expect(handled[0].id).toBe(entity.id);
    expect(handled[0].decision).toBeTruthy();

    const row = await env.DB.prepare('SELECT client, profile_id FROM decisions WHERE id = ?').bind(handled[0].decision).first<any>();
    expect(row).toEqual({ client: 'fiware-bridge', profile_id: 'road-restriction-check' });

    const write = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/attrs/check'));
    expect(write?.url).toBe(`${BROKER}/ngsi-ld/v1/entities/${encodeURIComponent(entity.id)}/attrs/check`);
    expect(write?.body.decisionId.value).toBe(handled[0].decision);
    expect(write?.body.value).toBe(handled[0].action);
  });

  it('refuses a notification without the secret, before any decision', async () => {
    const settings = { BRIDGE_ROUTES: ROUTES, BROKER_URL: BROKER, NOTIFY_SECRET: SECRET, POINTSMAN_TOKEN: await clientToken('fiware-bridge') };
    const calls = fakeBroker();
    const res = await call('/connectors/fiware/notify', settings, notify('wrong'));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('goes through the engine authentication: an unknown token gets no decision', async () => {
    const settings = { BRIDGE_ROUTES: ROUTES, BROKER_URL: BROKER, NOTIFY_SECRET: SECRET, POINTSMAN_TOKEN: newToken() };
    const calls = fakeBroker();
    const res = await call('/connectors/fiware/notify', settings, notify());
    const { handled } = await res.json<any>();
    expect(handled[0].error).toMatch(/401/);
    expect(calls).toHaveLength(0);
  });

  it('is off without its settings, and fails loudly with half of them', async () => {
    expect((await call('/connectors/fiware/notify', {}, notify())).status).toBe(404);
    const half = await call('/connectors/fiware/notify', { NOTIFY_SECRET: SECRET }, notify());
    expect(half.status).toBe(500);
    expect((await half.json<any>()).error.code).toBe('not_configured');
  });

  it('refuses POINTSMAN_URL inside the engine Worker', async () => {
    const settings = { BRIDGE_ROUTES: ROUTES, BROKER_URL: BROKER, NOTIFY_SECRET: SECRET, POINTSMAN_TOKEN: 'x', POINTSMAN_URL: 'https://pointsman.example.org' };
    expect((await call('/connectors/fiware/notify', settings, notify())).status).toBe(500);
  });

  it('leaves the engine routes alone', async () => {
    expect((await call('/v1/profiles', {}, { method: 'GET' })).status).toBe(401);
    expect((await call('/connectors/other/x', {}, { method: 'POST' })).status).toBe(404);
  });

  it('hands the queue to the bridge, and retries the batch when no connector can take it', async () => {
    const settings = { BRIDGE_ROUTES: ROUTES, BROKER_URL: BROKER, NOTIFY_SECRET: SECRET, POINTSMAN_TOKEN: await clientToken('fiware-bridge'), BRIDGE_QUEUE: { sendBatch: async () => {} } };
    fakeBroker();
    const message = { body: { path: '/notify', entity }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const batch = { queue: 'q', messages: [message], retryAll: vi.fn(), ackAll: vi.fn() } as unknown as MessageBatch<unknown>;
    await worker([fiwareModule]).queue(batch, { ...env, ...settings } as Env, createExecutionContext());
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(batch.retryAll).not.toHaveBeenCalled();

    // Without BRIDGE_QUEUE the bridge is no consumer.
    const off = { queue: 'q', messages: [], retryAll: vi.fn(), ackAll: vi.fn() } as unknown as MessageBatch<unknown>;
    const { BRIDGE_QUEUE: _, ...noQueue } = settings;
    await worker([fiwareModule]).queue(off, { ...env, ...noQueue } as Env, createExecutionContext());
    expect(off.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
  });

  it('reaches only the engine API, also after the URL is normalized', async () => {
    const p = probe('probe');
    connectorsFor(env, createExecutionContext(), [p]);
    const engine = p.engine!;
    await expect(engine.fetch(`${engine.url}/v1/../mcp`, { method: 'POST' })).rejects.toThrow(/only its own \/v1\//);
    await expect(engine.fetch('https://example.org/v1/profiles', {})).rejects.toThrow(/only its own/);
    expect((await engine.fetch(`${engine.url}/v1/profiles`, {})).status).toBe(401);
  });

  it('keeps the queue working when another connector is broken', async () => {
    const settings = { BRIDGE_ROUTES: ROUTES, BROKER_URL: BROKER, NOTIFY_SECRET: SECRET, POINTSMAN_TOKEN: await clientToken('fiware-bridge'), BRIDGE_QUEUE: { sendBatch: async () => {} } };
    fakeBroker();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = { body: { path: '/notify', entity }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const batch = { queue: 'q', messages: [message], retryAll: vi.fn(), ackAll: vi.fn() } as unknown as MessageBatch<unknown>;
    await worker([probe('broken', true), fiwareModule]).queue(batch, { ...env, ...settings } as Env, createExecutionContext());
    expect(message.ack).toHaveBeenCalled();
    expect(batch.retryAll).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(' ')).toContain('broken: broken');
    errors.mockRestore();
  });
});
