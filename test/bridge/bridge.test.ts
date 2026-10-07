// The FIWARE bridge (bridge/src) against a fake broker and a fake Pointsman.

import { describe, expect, it } from 'vitest';
import { type BridgeConfig, type Route, handleRequest, inputHash, parseRoutes } from '../../bridge/src/bridge';
import { configFrom, type Env } from '../../bridge/src/index';

// Made at run time, so no secret-looking literal sits in the code.
const SECRET = crypto.randomUUID();
const PM_TOKEN = `pm_${crypto.randomUUID()}`;
const BROKER_TOKEN = crypto.randomUUID();
const route: Route = { type: 'RoadRestriction', profile: 'road-restriction-check', inputs: ['roadName', 'description'], attribute: 'check' };
const P = (value: unknown) => ({ type: 'Property', value });

function entity(extra: Record<string, unknown> = {}) {
  return { id: 'urn:ngsi-ld:RoadRestriction:1', type: 'RoadRestriction', roadName: P('県道12号'), description: P('冠水のため通行止め'), ...extra };
}

const decision = {
  decision_id: 'd-1',
  action: 'publish',
  profile: 'road-restriction-check',
  profile_version: 1,
  model: 'clef-flash',
  answers: { category: { value: 'closedWeather', p: 0.96 }, danger: { value: false, p: 0.53 } },
};

type Call = { method: string; url: string; headers: Headers; body: unknown };

/** A fake broker and Pointsman. `broker` answers writes: a status per method, or a function. */
function setup(opts: {
  pointsman?: (body: unknown) => Response;
  broker?: { PATCH?: number; POST?: number };
  fail?: 'pointsman';
} = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: new Headers(init?.headers), body });
    if (url.startsWith('https://pm.test/')) {
      if (opts.fail === 'pointsman') throw new Error('connection refused');
      return opts.pointsman ? opts.pointsman(body) : Response.json(decision);
    }
    const status = opts.broker?.[method as 'PATCH' | 'POST'] ?? (method === 'PATCH' ? 404 : 204);
    return new Response(status === 204 ? null : 'broker says no', { status });
  }) as typeof fetch;
  const config: BridgeConfig = {
    routes: [route],
    notifySecret: SECRET,
    pointsman: { url: 'https://pm.test', token: PM_TOKEN },
    broker: { url: 'https://broker.test', token: BROKER_TOKEN, tenant: 'demo', context: 'https://ctx.test/v1.jsonld' },
    fetch: fakeFetch,
  };
  const notify = (data: unknown, secret = SECRET) =>
    handleRequest(
      new Request('https://bridge.test/notify', {
        method: 'POST',
        headers: { 'x-bridge-secret': secret, 'content-type': 'application/json' },
        body: typeof data === 'string' ? data : JSON.stringify({ type: 'Notification', data }),
      }),
      config,
    );
  return { calls, notify, config };
}

describe('requests', () => {
  it('answers 404 to anything but POST /notify', async () => {
    const { config } = setup();
    expect((await handleRequest(new Request('https://bridge.test/notify'), config)).status).toBe(404);
    expect((await handleRequest(new Request('https://bridge.test/', { method: 'POST' }), config)).status).toBe(404);
  });

  it('refuses a missing or wrong secret, before reading the body', async () => {
    const { notify, calls } = setup();
    expect((await notify([entity()], 'wrong')).status).toBe(403);
    expect((await notify([entity()], '')).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('answers 400 to a body that is not a notification', async () => {
    const { notify } = setup();
    expect((await notify('not json')).status).toBe(400);
    expect((await notify('{"type":"Notification"}')).status).toBe(400);
  });

  it('ignores entity types without a route', async () => {
    const { notify, calls } = setup();
    const res = await notify([{ ...entity(), type: 'Other' }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: [] });
    expect(calls).toHaveLength(0);
  });
});

describe('a decision', () => {
  it('asks Pointsman with the entity and appends the result the first time', async () => {
    const { notify, calls } = setup();
    const res = await notify([entity()]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: [{ id: 'urn:ngsi-ld:RoadRestriction:1', action: 'publish', decision: 'd-1', write: 204 }] });

    const [ask, patch, post] = calls;
    expect(ask).toMatchObject({ method: 'POST', url: 'https://pm.test/v1/decide/road-restriction-check' });
    expect(ask!.headers.get('authorization')).toBe(`Bearer ${PM_TOKEN}`);
    expect(ask!.body).toEqual({ state: entity(), ref: 'urn:ngsi-ld:RoadRestriction:1' });

    // Single-attribute update first (404: not there yet), then append.
    expect(patch).toMatchObject({ method: 'PATCH', url: 'https://broker.test/ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs/check' });
    expect(post).toMatchObject({ method: 'POST', url: 'https://broker.test/ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs' });
    for (const write of [patch!, post!]) {
      expect(write.headers.get('authorization')).toBe(`Bearer ${BROKER_TOKEN}`);
      expect(write.headers.get('ngsild-tenant')).toBe('demo');
      expect(write.headers.get('link')).toBe('<https://ctx.test/v1.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"');
    }
    const check = (post!.body as { check: Record<string, unknown> }).check;
    expect(check).toMatchObject({
      type: 'Property',
      value: 'publish',
      decisionId: P('d-1'),
      profile: P('road-restriction-check'),
      profileVersion: P(1),
      model: P('clef-flash'),
      category: P('closedWeather'),
      categoryProbability: P(0.96),
      danger: P(false),
      dangerProbability: P(0.53),
      inputHash: P(await inputHash(entity(), route.inputs)),
    });
    expect(Date.parse(check.observedAt as string)).not.toBeNaN();
    expect(patch!.body).toEqual(check);
  });

  it('updates the attribute in place when it exists', async () => {
    const { notify, calls } = setup({ broker: { PATCH: 204 } });
    expect((await notify([entity()])).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
  });

  it('skips an entity whose inputs already have a decision (loop guard)', async () => {
    const { notify, calls } = setup();
    const hash = await inputHash(entity(), route.inputs);
    const res = await notify([entity({ check: { ...P('publish'), inputHash: P(hash) } })]);
    expect(await res.json()).toEqual({ handled: [{ id: 'urn:ngsi-ld:RoadRestriction:1', skipped: 'inputs unchanged' }] });
    expect(calls).toHaveLength(0);
  });

  it('skips the notification about a deleted entity', async () => {
    const { notify, calls } = setup();
    const res = await notify([entity({ deletedAt: '2026-10-07T03:00:00Z' })]);
    expect(await res.json()).toEqual({ handled: [{ id: 'urn:ngsi-ld:RoadRestriction:1', skipped: 'deleted' }] });
    expect(calls).toHaveLength(0);
  });

  it('decides again when an input changed', async () => {
    const { notify, calls } = setup({ broker: { PATCH: 204 } });
    const hash = await inputHash(entity(), route.inputs);
    await notify([entity({ description: P('片側交互通行'), check: { ...P('publish'), inputHash: P(hash) } })]);
    expect(calls).toHaveLength(2);
  });

  it('hashes only the inputs, not other attributes', async () => {
    expect(await inputHash(entity({ other: P(1) }), route.inputs)).toBe(await inputHash(entity(), route.inputs));
    expect(await inputHash(entity({ roadName: P('別の道') }), route.inputs)).not.toBe(await inputHash(entity(), route.inputs));
  });
});

describe('failures', () => {
  it('answers 502 when Pointsman fails, without its body', async () => {
    const { notify, calls } = setup({ pointsman: () => new Response('state echo: secret text', { status: 503 }) });
    const res = await notify([entity()]);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain('pointsman answered 503');
    expect(body).not.toContain('secret text');
    expect(calls).toHaveLength(1);
  });

  it('does not ask for a retry when Pointsman refuses the input', async () => {
    const { notify } = setup({ pointsman: () => Response.json({ error: 'bad input' }, { status: 400 }) });
    const res = await notify([entity()]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: [{ id: 'urn:ngsi-ld:RoadRestriction:1', error: 'pointsman answered 400', retry: false }] });
  });

  it('answers 502 when Pointsman cannot be reached or answers something else', async () => {
    expect((await setup({ fail: 'pointsman' }).notify([entity()])).status).toBe(502);
    expect((await setup({ pointsman: () => Response.json({ action: 'publish' }) }).notify([entity()])).status).toBe(502);
  });

  it('reports a failed write, retrying only server errors', async () => {
    const server = setup({ broker: { PATCH: 500 } });
    const res = await server.notify([entity()]);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ handled: [{ id: 'urn:ngsi-ld:RoadRestriction:1', decision: 'd-1', error: 'broker write failed: 500', retry: true }] });

    const refused = setup({ broker: { POST: 400 } });
    expect((await refused.notify([entity()])).status).toBe(200);
  });

  it('handles the other entities when one fails', async () => {
    let n = 0;
    const { notify } = setup({ pointsman: () => (++n === 1 ? new Response(null, { status: 500 }) : Response.json(decision)) });
    const second = { ...entity(), id: 'urn:ngsi-ld:RoadRestriction:2' };
    const res = await notify([entity(), second]);
    expect(res.status).toBe(502);
    const { handled } = (await res.json()) as { handled: { id: string }[] };
    expect(handled.map((h) => h.id)).toEqual(['urn:ngsi-ld:RoadRestriction:1', 'urn:ngsi-ld:RoadRestriction:2']);
    expect(handled[1]).toMatchObject({ action: 'publish' });
  });
});

describe('configuration', () => {
  it('parses routes and refuses unsafe or unclear ones', () => {
    expect(parseRoutes(JSON.stringify([route]))).toEqual([route]);
    expect(() => parseRoutes('nope')).toThrow(/not valid JSON/);
    expect(() => parseRoutes('[]')).toThrow(/non-empty list/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, inputs: [] }]))).toThrow(/inputs/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, profile: '' }]))).toThrow(/profile/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, attribute: 'description' }]))).toThrow(/must not be one of the inputs/);
    expect(() => parseRoutes(JSON.stringify([route, route]))).toThrow(/listed twice/);
  });

  const env: Env = {
    BRIDGE_ROUTES: JSON.stringify([route]),
    POINTSMAN_URL: 'https://pm.test/',
    BROKER_URL: 'https://broker.test',
    NOTIFY_SECRET: SECRET,
    POINTSMAN_TOKEN: PM_TOKEN,
  };

  it('reads the Worker settings', () => {
    const config = configFrom(env);
    expect(config.pointsman.url).toBe('https://pm.test');
    expect(config.broker).toEqual({ url: 'https://broker.test' });
    expect(configFrom({ ...env, BROKER_TENANT: 't', BROKER_TOKEN }).broker).toEqual({ url: 'https://broker.test', tenant: 't', token: BROKER_TOKEN });
  });

  it('names a missing setting, and refuses plain http except for localhost', () => {
    expect(() => configFrom({ ...env, NOTIFY_SECRET: '' })).toThrow(/NOTIFY_SECRET is not set/);
    expect(() => configFrom({ ...env, BROKER_URL: 'http://broker.test' })).toThrow(/BROKER_URL must be an https URL/);
    expect(configFrom({ ...env, BROKER_URL: 'http://localhost:1026' }).broker.url).toBe('http://localhost:1026');
  });
});
