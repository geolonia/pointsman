// The FIWARE bridge (bridge/src) against a fake broker and a fake Pointsman.

import { describe, expect, it } from 'vitest';
import { type BridgeConfig, type Route, DECISION_CONTEXT, DECISION_TERMS, handleRequest, inputHash, parseRoutes, toDecisionEntity } from '../../bridge/src/bridge';
import decisionContext from '../fixtures/datamodels/decision/context.jsonld?raw';
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
  created_at: '2026-07-08T01:46:12.000Z',
  rule: 1 as number | null,
  decision_id: 'd-1',
  action: 'publish',
  profile: 'road-restriction-check',
  profile_version: 1,
  model: 'clef-flash',
  // As Pointsman answers (src/types.ts Answer).
  answers: {
    category: { type: 'choice', value: 'closedWeather', p: 0.96, probabilities: { closedWeather: 0.96, other: 0.04 } },
    danger: { type: 'noul', value: false, p: 0.53, yes: 0.47 },
  },
};

type Call = { method: string; url: string; headers: Headers; body: unknown };

/** A fake broker and Pointsman. `broker` answers writes: a status per method, or a function. */
function setup(opts: {
  pointsman?: (body: unknown) => Response;
  broker?: { PATCH?: number; POST?: number; ENTITIES?: number };
  fail?: 'pointsman';
  route?: Partial<Route>;
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
    if (url === 'https://broker.test/ngsi-ld/v1/entities') return new Response(null, { status: opts.broker?.ENTITIES ?? 201 });
    const status = opts.broker?.[method as 'PATCH' | 'POST'] ?? (method === 'PATCH' ? 404 : 204);
    return new Response(status === 204 ? null : 'broker says no', { status });
  }) as typeof fetch;
  const config: BridgeConfig = {
    routes: [{ ...route, ...opts.route }],
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
    expect(ask!.headers.get('user-agent')).toMatch(/^pointsman-bridge/);
    expect(ask!.body).toEqual({ state: entity(), ref: 'urn:ngsi-ld:RoadRestriction:1' });

    // Single-attribute update first (404: not there yet), then append.
    expect(patch).toMatchObject({ method: 'PATCH', url: 'https://broker.test/ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs/check' });
    expect(post).toMatchObject({ method: 'POST', url: 'https://broker.test/ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs' });
    for (const write of [patch!, post!]) {
      expect(write.headers.get('user-agent')).toMatch(/^pointsman-bridge/);
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
    expect(() => parseRoutes(JSON.stringify([route, route]))).toThrow(/two routes without a name/);
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

  it('sends an API key instead of a token, never both', async () => {
    const API_KEY = crypto.randomUUID();
    expect(configFrom({ ...env, BROKER_API_KEY: API_KEY }).broker).toEqual({ url: 'https://broker.test', apiKey: API_KEY });
    expect(() => configFrom({ ...env, BROKER_API_KEY: API_KEY, BROKER_TOKEN })).toThrow(/not both/);
    const { notify, calls, config } = setup();
    delete config.broker.token;
    config.broker.apiKey = API_KEY;
    await notify([entity()]);
    expect(calls[1]!.headers.get('x-api-key')).toBe(API_KEY);
    expect(calls[1]!.headers.get('authorization')).toBeNull();

    // A Worker that builds the config itself gets the same check.
    const both = setup();
    both.config.broker.apiKey = API_KEY;
    expect((await both.notify([entity()])).status).toBe(500);
    expect(both.calls).toHaveLength(0);
  });

  it('names a missing setting, and refuses plain http except for localhost', () => {
    expect(() => configFrom({ ...env, NOTIFY_SECRET: '' })).toThrow(/NOTIFY_SECRET is not set/);
    expect(() => configFrom({ ...env, BROKER_URL: 'http://broker.test' })).toThrow(/BROKER_URL must be an https URL/);
    expect(configFrom({ ...env, BROKER_URL: 'http://localhost:1026' }).broker.url).toBe('http://localhost:1026');
  });
});

describe('Decision entities', () => {
  it('creates a Decision entity first, then links it from the property', async () => {
    const { notify, calls } = setup({ route: { decisionEntity: true } });
    const res = await notify([entity()]);
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '')}`)).toEqual([
      'POST /v1/decide/road-restriction-check',
      'POST /ngsi-ld/v1/entities',
      'PATCH /ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs/check',
      'POST /ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs',
    ]);
    const create = calls[1]!;
    expect(create.headers.get('content-type')).toBe('application/ld+json');
    expect(create.headers.get('link')).toBeNull();
    expect(create.headers.get('ngsild-tenant')).toBe('demo');
    expect(create.body).toEqual({
      '@context': [DECISION_CONTEXT, 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld'],
      id: 'urn:ngsi-ld:Decision:d-1',
      type: 'Decision',
      refersTo: { type: 'Relationship', object: 'urn:ngsi-ld:RoadRestriction:1' },
      action: P('publish'),
      answers: { type: 'JsonProperty', json: [
        { name: 'category', type: 'choice', value: 'closedWeather', probability: 0.96, probabilities: { closedWeather: 0.96, other: 0.04 } },
        { name: 'danger', type: 'noul', value: false, probability: 0.53 },
      ] },
      profile: P('road-restriction-check'),
      profileVersion: P(1),
      policyRule: P('1'),
      model: P('clef-flash'),
      decidedAt: P({ '@type': 'DateTime', '@value': '2026-07-08T01:46:12.000Z' }),
      humanInvolvement: { type: 'VocabProperty', vocab: 'dpv:HumanInvolvementForOversight' },
    });
    const check = (calls[3]!.body as { check: Record<string, unknown> }).check;
    expect(check).toMatchObject({
      decision: { type: 'Relationship', object: 'urn:ngsi-ld:Decision:d-1' },
      policyRule: P('1'),
      observedAt: '2026-07-08T01:46:12.000Z',
    });
  });

  it('marks review actions as checked by a person first, with a pending review', async () => {
    const review = { ...decision, action: 'review', rule: null };
    const out = toDecisionEntity(review, 'urn:x:1', { ...route, decisionEntity: true });
    expect(out).toMatchObject({ policyRule: P('default'), humanInvolvement: { vocab: 'dpv:HumanInvolvementForVerification' }, reviewStatus: P('pending') });
    const urgent = toDecisionEntity({ ...decision, action: 'urgent' }, 'urn:x:1', { ...route, reviewActions: ['review', 'urgent'] });
    expect(urgent).toMatchObject({ humanInvolvement: { vocab: 'dpv:HumanInvolvementForVerification' }, reviewStatus: P('pending') });
    expect(toDecisionEntity(decision, 'urn:x:1', route)).not.toHaveProperty('reviewStatus');
  });

  it('records every fact the profile asks for, missing ones with the reason', async () => {
    const facts = {
      flood: { missing: false as const, values: { inside: true, rank: 4, class: '1 to 3 m' }, source: 'gsi-flood-max' },
      detour: { missing: true as const, reason: 'timeout' },
    };
    expect(toDecisionEntity({ ...decision, facts }, 'urn:x:1', route).facts).toEqual({
      type: 'JsonProperty',
      json: [
        { name: 'flood', missing: false, values: { inside: true, rank: 4, class: '1 to 3 m' }, source: 'gsi-flood-max' },
        { name: 'detour', missing: true, reason: 'timeout' },
      ],
    });
    // A profile without facts: no attribute (an empty JsonProperty would say nothing).
    expect(toDecisionEntity(decision, 'urn:x:1', route)).not.toHaveProperty('facts');
    expect(toDecisionEntity({ ...decision, facts: {} }, 'urn:x:1', route)).not.toHaveProperty('facts');
  });

  it('works with a Pointsman that does not return created_at and rule yet', async () => {
    const { created_at: _, rule: __, ...older } = decision;
    const out = toDecisionEntity(older, 'urn:x:1', route);
    expect(out).not.toHaveProperty('policyRule');
    expect(Date.parse((out.decidedAt as { value: { '@value': string } }).value['@value'])).not.toBeNaN();
  });

  it('accepts an existing Decision entity (a retry) and fails without one', async () => {
    const retry = setup({ route: { decisionEntity: true }, broker: { ENTITIES: 409 } });
    expect((await retry.notify([entity()])).status).toBe(200);

    const down = setup({ route: { decisionEntity: true }, broker: { ENTITIES: 503 } });
    const res = await down.notify([entity()]);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ handled: [{ id: 'urn:ngsi-ld:RoadRestriction:1', decision: 'd-1', error: 'broker refused the Decision entity: 503', retry: true }] });
    // Nothing written to the entity, so the next notification decides again.
    expect(down.calls).toHaveLength(2);

    const refused = setup({ route: { decisionEntity: true }, broker: { ENTITIES: 400 } });
    expect((await refused.notify([entity()])).status).toBe(200);
  });

  it('uses the terms of the data model', () => {
    const file = JSON.parse(decisionContext) as { '@context': unknown[] };
    const inline = file['@context'].find((c) => typeof c === 'object');
    expect(DECISION_TERMS).toEqual(inline);
  });

  it('authenticates the Decision create like every other broker request', async () => {
    const API_KEY = crypto.randomUUID();
    const { notify, calls, config } = setup({ route: { decisionEntity: true } });
    delete config.broker.token;
    config.broker.apiKey = API_KEY;
    await notify([entity()]);
    const create = calls.find((c) => c.url === 'https://broker.test/ngsi-ld/v1/entities')!;
    expect(create.headers.get('x-api-key')).toBe(API_KEY);
    expect(create.headers.get('ngsild-tenant')).toBe('demo');
  });

  it('uses one time for the entity and the property when Pointsman gives none', async () => {
    const { created_at: _, ...older } = decision;
    const { notify, calls } = setup({ route: { decisionEntity: true }, pointsman: () => Response.json(older) });
    await notify([entity()]);
    const created = calls.find((c) => c.url === 'https://broker.test/ngsi-ld/v1/entities')!.body as { decidedAt: { value: { '@value': string } } };
    const check = (calls.at(-1)!.body as { check: { observedAt: string } }).check;
    expect(check.observedAt).toBe(created.decidedAt.value['@value']);
  });

  it('checks the route options', () => {
    expect(parseRoutes(JSON.stringify([{ ...route, decisionEntity: true, reviewActions: ['review', 'urgent'] }]))[0]).toMatchObject({ decisionEntity: true, reviewActions: ['review', 'urgent'] });
    expect(() => parseRoutes(JSON.stringify([{ ...route, decisionEntity: 'yes' }]))).toThrow(/decisionEntity/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, reviewActions: 'review' }]))).toThrow(/reviewActions/);
  });
});

describe('chains of decisions', () => {
  // Step 2 reads the step 1 result (check) and writes its own attribute.
  const step2: Route = { type: 'RoadRestriction', profile: 'evacuation-access-check', inputs: ['description', 'check'], attribute: 'evacuation', name: 'evacuation', informedBy: 'check', decisionEntity: true };
  const check = { type: 'Property', value: 'urgent', decision: { type: 'Relationship', object: 'urn:ngsi-ld:Decision:d-0' } };

  it('allows more than one route per type, each named, and checks informedBy', () => {
    expect(parseRoutes(JSON.stringify([route, step2]))).toEqual([route, step2]);
    expect(() => parseRoutes(JSON.stringify([step2, step2]))).toThrow(/name evacuation is listed twice/);
    expect(() => parseRoutes(JSON.stringify([{ ...step2, name: 'Evac Route' }]))).toThrow(/name/);
    expect(() => parseRoutes(JSON.stringify([{ ...step2, informedBy: 'status' }]))).toThrow(/informedBy/);
  });

  it('picks the route named in the notification URL, and links the earlier decision', async () => {
    const t = setup();
    t.config.routes = [route, step2];
    const res = await handleRequest(new Request('https://bridge.test/notify?route=evacuation', {
      method: 'POST',
      headers: { 'x-bridge-secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'Notification', data: [entity({ check })] }),
    }), t.config);
    expect(res.status).toBe(200);
    expect(t.calls[0]!.url).toBe('https://pm.test/v1/decide/evacuation-access-check');
    const created = t.calls.find((c) => c.url === 'https://broker.test/ngsi-ld/v1/entities')!.body as Record<string, unknown>;
    expect(created.wasInformedBy).toEqual({ type: 'Relationship', object: 'urn:ngsi-ld:Decision:d-0' });
    // Written to the route's own attribute.
    expect(t.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/attrs/evacuation'))).toBe(true);
  });

  it('keeps /notify for the unnamed route, and ignores names it does not know', async () => {
    const t = setup();
    t.config.routes = [route, step2];
    await t.notify([entity({ check })]);
    expect(t.calls[0]!.url).toBe('https://pm.test/v1/decide/road-restriction-check');
    const none = setup();
    none.config.routes = [route, step2];
    const res = await handleRequest(new Request('https://bridge.test/notify?route=other', {
      method: 'POST', headers: { 'x-bridge-secret': SECRET }, body: JSON.stringify({ type: 'Notification', data: [entity({ check })] }),
    }), none.config);
    expect(await res.json()).toEqual({ handled: [] });
    expect(none.calls).toHaveLength(0);
  });

  it('leaves wasInformedBy out when the earlier result has no decision link', () => {
    expect(toDecisionEntity(decision, 'urn:x:1', step2, new Date(), undefined)).not.toHaveProperty('wasInformedBy');
  });
});

