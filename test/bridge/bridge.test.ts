// The FIWARE bridge (bridge/src) against a fake broker and a fake Pointsman.

import { describe, expect, it } from 'vitest';
import { type BridgeConfig, type BridgeMessage, type Route, DECISION_CONTEXT, DECISION_TERMS, TASK_CONTEXT, handleQueueBatch, handleRequest, inputHash, parseRoutes, parseWorkOrders, queueBatches, retryDelay, taskEntityId, toDecisionEntity } from '../../bridge/src/bridge';
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
  pointsman?: (body: unknown, url: string, method: string) => Response;
  broker?: { PATCH?: number; POST?: number; ENTITIES?: number };
  fail?: 'pointsman';
  route?: Partial<Route>;
  /** Answers broker requests first, when it returns a response. */
  handler?: (c: Call) => Response | undefined;
} = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: new Headers(init?.headers), body });
    if (url.startsWith('https://pm.test/')) {
      if (opts.fail === 'pointsman') throw new Error('connection refused');
      return opts.pointsman ? opts.pointsman(body, url, method) : Response.json(decision);
    }
    const custom = opts.handler?.(calls.at(-1)!);
    if (custom) return custom;
    if (url === 'https://broker.test/ngsi-ld/v1/entities') return new Response(null, { status: opts.broker?.ENTITIES ?? 201 });
    const status = opts.broker?.[method as 'PATCH' | 'POST'] ?? (method === 'PATCH' || method === 'GET' ? 404 : 204);
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
    expect(config).not.toHaveProperty('workOrders');
    expect(configFrom({ ...env, BRIDGE_WORK_ORDERS: '{"Published":"publish"}' }).workOrders).toEqual({ Published: 'publish' });
    expect(() => configFrom({ ...env, BRIDGE_WORK_ORDERS: '{"Open":"review"}' })).toThrow(/not "review"/);
    expect(() => configFrom({ ...env, BRIDGE_WORK_ORDERS: '{}' })).toThrow(/work orders/);
    expect(() => configFrom({ ...env, BRIDGE_WORK_ORDERS: '["publish"]' })).toThrow(/work orders/);
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


describe('Task entities', () => {
  const task = { actions: ['review', 'urgent'], name: 'roadName', priority: { urgent: 1, review: 5 } };
  const urgent = () => Response.json({ ...decision, action: 'urgent' });
  const path = (c: Call) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '')}`;

  it('checks the task option', () => {
    expect(parseRoutes(JSON.stringify([{ ...route, task }]))).toEqual([{ ...route, task }]);
    expect(() => parseRoutes(JSON.stringify([{ ...route, task: { actions: [] } }]))).toThrow(/task.actions/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, task: ['review'] }]))).toThrow(/task: expected an object/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, task: { actions: ['review'], name: '' } }]))).toThrow(/task.name/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, task: { actions: ['review'], priority: { review: 0 } } }]))).toThrow(/priority.review: expected 1 to 9/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, task: { actions: ['review'], priority: { review: 1.5 } } }]))).toThrow(/priority.review/);
    expect(() => parseRoutes(JSON.stringify([{ ...route, task: { actions: ['review'], assignee: 'x' } }]))).toThrow(/unknown option assignee/);
  });

  it('creates a Task after the Decision entity and before the property, for a listed action', async () => {
    const { notify, calls } = setup({ pointsman: urgent, route: { decisionEntity: true, task } });
    expect((await notify([entity()])).status).toBe(200);
    expect(calls.map(path)).toEqual([
      'POST /v1/decide/road-restriction-check',
      'POST /ngsi-ld/v1/entities',
      'POST /ngsi-ld/v1/entities',
      'PATCH /ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs/check',
      'POST /ngsi-ld/v1/entities/urn%3Angsi-ld%3ARoadRestriction%3A1/attrs',
    ]);
    expect(calls[2]!.headers.get('content-type')).toBe('application/ld+json');
    const hash = await inputHash(entity(), route.inputs);
    expect(calls[2]!.body).toEqual({
      '@context': [TASK_CONTEXT, 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld'],
      id: await taskEntityId('urn:ngsi-ld:RoadRestriction:1', 'check', hash),
      type: 'Task',
      name: P('[urgent] 県道12号'),
      refersTo: { type: 'Relationship', object: 'urn:ngsi-ld:RoadRestriction:1' },
      progress: P('needs-action'),
      statusLabel: P('urgent'),
      subtype: P('road-restriction-check'),
      priority: P(1),
      dateCreated: P({ '@type': 'DateTime', '@value': '2026-07-08T01:46:12.000Z' }),
    });
    // Found from the entity: the result's inputHash.
    expect((calls[4]!.body as { check: { inputHash: unknown } }).check.inputHash).toEqual(P(hash));
  });

  it('gives the Task an id from the entity, the attribute and the inputs, not from the decision', async () => {
    const id = await taskEntityId('urn:ngsi-ld:RoadRestriction:1', 'check', 'h1');
    expect(id).toMatch(/^urn:ngsi-ld:Task:[0-9a-f]{32}$/);
    expect(await taskEntityId('urn:ngsi-ld:RoadRestriction:1', 'check', 'h1')).toBe(id);
    expect(await taskEntityId('urn:ngsi-ld:RoadRestriction:1', 'check', 'h2')).not.toBe(id);
    expect(await taskEntityId('urn:ngsi-ld:RoadRestriction:1', 'evacuation', 'h1')).not.toBe(id);
    expect(await taskEntityId('urn:ngsi-ld:RoadRestriction:2', 'check', 'h1')).not.toBe(id);
  });

  it('creates the same Task again on a retry, although Pointsman decides with a new id', async () => {
    let n = 0;
    let writes = 0;
    const store = taskStore();
    const t = setup({ pointsman: () => Response.json({ ...decision, action: 'urgent', decision_id: `d-${++n}` }), route: { decisionEntity: true, task }, handler: store.handler });
    const fetchFn = t.config.fetch!;
    // The first result write fails after the Task was created.
    t.config.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH' && ++writes === 1) return new Response(null, { status: 503 });
      return fetchFn(input, init);
    }) as typeof fetch;
    expect((await t.notify([entity()])).status).toBe(502);
    expect((await t.notify([entity()])).status).toBe(200);
    const tasks = t.calls.filter((c) => (c.body as { type?: string } | undefined)?.type === 'Task').map((c) => (c.body as { id: string }).id);
    const decisions = t.calls.filter((c) => (c.body as { type?: string } | undefined)?.type === 'Decision').map((c) => (c.body as { id: string }).id);
    expect(decisions).toEqual(['urn:ngsi-ld:Decision:d-1', 'urn:ngsi-ld:Decision:d-2']);
    expect(tasks).toHaveLength(2); // created, then 409 on the retry and updated in place
    expect(new Set(tasks).size).toBe(1);
    expect(store.tasks.size).toBe(1);
  });

  it('reads priorities only from the configured actions', async () => {
    const { notify, calls } = setup({ pointsman: () => Response.json({ ...decision, action: 'constructor' }), route: { task: { actions: ['constructor'], priority: {} } } });
    await notify([entity()]);
    const created = calls.find((c) => (c.body as { type?: string } | undefined)?.type === 'Task')!;
    expect(created.body).not.toHaveProperty('priority');
  });

  it('creates no Task for other actions', async () => {
    const { notify, calls } = setup({ route: { decisionEntity: true, task } });
    await notify([entity()]);
    expect(calls.filter((c) => c.url === 'https://broker.test/ngsi-ld/v1/entities')).toHaveLength(1);
  });

  it('works without a Decision entity, and names the Task by the entity id without a name attribute', async () => {
    const { notify, calls } = setup({ pointsman: urgent, route: { task: { actions: ['urgent'] } } });
    await notify([entity({ roadName: P('  ') })]);
    const created = calls.filter((c) => c.url === 'https://broker.test/ngsi-ld/v1/entities');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ name: P('[urgent] urn:ngsi-ld:RoadRestriction:1') });
    expect(created[0]!.body).not.toHaveProperty('priority');
  });

  /** A broker that keeps Tasks: 409 for an id it has, DELETE removes it or an attribute, GET reads, POST …/attrs updates. */
  function taskStore() {
    const tasks = new Map<string, Record<string, unknown>>();
    const idOf = (url: string) => decodeURIComponent(url.split('/entities/')[1]!.split('/attrs')[0]!);
    const handler = (c: Call): Response | undefined => {
      const body = c.body as Record<string, unknown> | undefined;
      if (c.url === 'https://broker.test/ngsi-ld/v1/entities' && body?.type === 'Task') {
        if (tasks.has(body.id as string)) return new Response(null, { status: 409 });
        tasks.set(body.id as string, body);
        return new Response(null, { status: 201 });
      }
      if (!c.url.includes('urn%3Angsi-ld%3ATask%3A')) return undefined;
      const task = tasks.get(idOf(c.url));
      if (!task) return new Response(null, { status: 404 });
      if (c.method === 'DELETE') {
        const attr = c.url.split('/attrs/')[1];
        if (!attr) tasks.delete(idOf(c.url));
        else if (!(attr in task)) return new Response(null, { status: 404 });
        else delete task[attr];
        return new Response(null, { status: 204 });
      }
      if (c.method === 'GET') return Response.json(task);
      if (c.method === 'POST') { Object.assign(task, body); return new Response(null, { status: 204 }); }
      return undefined;
    };
    return { tasks, handler };
  }

  it('replaces a Task that exists already, so earlier input values that come back give new work', async () => {
    const store = taskStore();
    const t = setup({ pointsman: urgent, route: { task }, handler: store.handler });
    await t.notify([entity()]);
    const [id] = [...store.tasks.keys()];
    // A person completed it; then the report changed and came back to the same text.
    Object.assign(store.tasks.get(id!)!, { progress: P('completed'), completedAt: P('2026-10-09T00:00:00Z'), assignee: { type: 'Relationship', object: 'urn:x:team' } });
    const res = await t.notify([entity()]);
    expect(res.status).toBe(200);
    const stored = store.tasks.get(id!)!;
    expect(stored.progress).toEqual(P('needs-action'));
    expect(stored).not.toHaveProperty('completedAt');
    // Updated in place: what an app added stays.
    expect(stored.assignee).toEqual({ type: 'Relationship', object: 'urn:x:team' });
    expect(t.calls.filter((c) => c.method === 'DELETE').map((c) => decodeURIComponent(c.url.split('/entities/')[1]!))).toEqual([`${id}/attrs/completedAt`]);
  });

  it('takes a partial update (207) of an existing Task as a failure', async () => {
    const t = setup({ pointsman: urgent, route: { task }, handler: (c) => {
      if ((c.body as { type?: string } | undefined)?.type === 'Task') return new Response(null, { status: 409 });
      if (c.method === 'POST' && c.url.includes('Task')) return Response.json({ updated: ['name'], notUpdated: [{ attributeName: 'progress', reason: 'x' }] }, { status: 207 });
      return undefined;
    } });
    const res = await t.notify([entity()]);
    expect(await res.json()).toMatchObject({ handled: [{ error: 'broker refused the Task entity: 207' }] });
    expect(t.calls.some((c) => c.method === 'PATCH')).toBe(false);
    // The same when cancelling.
    const c2 = setup({ route: { task }, handler: (c) => {
      if (c.method === 'GET' && c.url.includes('Task')) return Response.json({ progress: P('needs-action') });
      if (c.method === 'POST' && c.url.includes('Task')) return new Response('{}', { status: 207 });
      return undefined;
    } });
    expect(await (await c2.notify([entity()])).json()).toMatchObject({ handled: [{ error: 'broker refused the Task entity: 207' }] });
  });

  it('drops an old priority the new decision does not have', async () => {
    let action = 'urgent';
    const store = taskStore();
    const t = setup({ pointsman: () => Response.json({ ...decision, action }), route: { task: { actions: ['urgent', 'review'], priority: { urgent: 1 } } }, handler: store.handler });
    await t.notify([entity()]);
    const [id] = [...store.tasks.keys()];
    action = 'review';
    await t.notify([entity()]);
    expect(store.tasks.get(id!)).not.toHaveProperty('priority');
    expect(store.tasks.get(id!)!.statusLabel).toEqual(P('review'));
  });

  it('reports a Task it cannot update, and writes no result', async () => {
    const t = setup({ pointsman: urgent, route: { task }, handler: (c) => {
      if ((c.body as { type?: string } | undefined)?.type === 'Task') return new Response(null, { status: 409 });
      if (c.method === 'POST' && c.url.includes('Task')) return new Response(null, { status: 503 });
      return undefined;
    } });
    const res = await t.notify([entity()]);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ handled: [{ error: 'broker refused the Task entity: 503', retry: true }] });
    expect(t.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('cancels an open Task when a later decision for the same inputs needs no person, and leaves a done one', async () => {
    let action = 'urgent';
    const store = taskStore();
    const t = setup({ pointsman: () => Response.json({ ...decision, action }), route: { task }, handler: store.handler });
    await t.notify([entity()]);
    const [id] = [...store.tasks.keys()];
    action = 'publish';
    expect((await t.notify([entity()])).status).toBe(200);
    expect(store.tasks.get(id!)).toMatchObject({ progress: P('cancelled'), statusLabel: P('publish') });
    const update = t.calls.find((c) => c.method === 'POST' && c.url.endsWith('/attrs') && c.url.includes('Task'))!;
    expect(update.headers.get('content-type')).toBe('application/ld+json');
    expect((update.body as { '@context': unknown })['@context']).toEqual([TASK_CONTEXT, 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld']);
    // Done: stays as it is.
    store.tasks.get(id!)!.progress = P('completed');
    await t.notify([entity()]);
    expect(store.tasks.get(id!)!.progress).toEqual(P('completed'));
  });

  it('asks for a retry when it cannot read the Task to cancel it', async () => {
    const t = setup({ route: { task }, handler: (c) => (c.method === 'GET' ? new Response(null, { status: 500 }) : undefined) });
    const res = await t.notify([entity()]);
    expect(res.status).toBe(502);
    expect(t.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('writes no result when the broker refuses the Task, so the retry tries again', async () => {
    const { notify, calls } = setup({ pointsman: urgent, route: { task }, broker: { ENTITIES: 503 } });
    const res = await notify([entity()]);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ handled: [{ id: 'urn:ngsi-ld:RoadRestriction:1', decision: 'd-1', error: 'broker refused the Task entity: 503', retry: true }] });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('reports a Task the broker will never take without asking for a retry', async () => {
    const { notify } = setup({ pointsman: urgent, route: { task }, broker: { ENTITIES: 400 } });
    const res = await notify([entity()]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: [{ error: 'broker refused the Task entity: 400', retry: false }] });
  });
});

describe('reviews resolved in the broker', () => {
  const D = 'urn:ngsi-ld:Decision:d-1';
  const R = 'urn:ngsi-ld:RoadRestriction:1';
  const hash = 'h-1';
  const resolved = (extra: Record<string, unknown> = {}) => ({
    id: D, type: 'Decision',
    refersTo: { type: 'Relationship', object: R },
    action: P('review'), profile: P('road-restriction-check'),
    reviewStatus: P('resolved'), finalAction: P('publish'), reviewedBy: P('app:reviewer-1'),
    reviewedAt: P({ '@type': 'DateTime', '@value': '2026-10-09T03:00:00.000Z' }),
    ...extra,
  });
  const result = { type: 'Property', value: 'review', inputHash: P(hash), decision: { type: 'Relationship', object: D } };

  /** Pointsman with a decision record; the broker with the entity's result. */
  function reviews(opts: { record?: Record<string, unknown>; resolve?: number; feedback?: number; entity?: unknown; task?: number; get?: number } = {}) {
    const t = setup({
      route: { decisionEntity: true, task: { actions: ['review', 'urgent'] } },
      pointsman: (_body, url) => {
        if (url.endsWith('/resolve')) return new Response(opts.resolve === 200 || opts.resolve === undefined ? '{}' : null, { status: opts.resolve ?? 200 });
        if (url.endsWith('/feedback')) return new Response(null, { status: opts.feedback ?? 204 });
        return Response.json(opts.record ?? { decision_id: 'd-1', review: { status: 'pending' }, feedback: [] });
      },
      handler: (c) => {
        if (c.method === 'GET' && c.url.includes(encodeURIComponent(R))) {
          return opts.get ? new Response(null, { status: opts.get }) : Response.json(opts.entity ?? { id: R, type: 'RoadRestriction', check: result });
        }
        if (c.url.includes('urn%3Angsi-ld%3ATask%3A')) return new Response(null, { status: opts.task ?? 204 });
        return undefined;
      },
    });
    const send = (data: unknown[]) => handleRequest(new Request('https://bridge.test/reviews', {
      method: 'POST', headers: { 'x-bridge-secret': SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'Notification', data }),
    }), t.config);
    return { ...t, send };
  }
  const path = (c: Call) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '')}`;

  it('resolves a pending review in Pointsman, writes the final action and completes the Task', async () => {
    const t = reviews();
    const res = await t.send([resolved({ corrections: { type: 'JsonProperty', json: [{ name: 'danger', value: true, by: 'app:reviewer-1', at: '2026-10-09T02:59:00Z' }] } })]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: [{ id: D, review: 'resolved', written: true }] });
    const task = await taskEntityId(R, 'check', hash);
    expect(t.calls.map(path)).toEqual([
      'GET /v1/decisions/d-1',
      'POST /v1/reviews/d-1/resolve',
      `GET /ngsi-ld/v1/entities/${encodeURIComponent(R)}?attrs=check`,
      `PATCH /ngsi-ld/v1/entities/${encodeURIComponent(R)}/attrs/check`,
      `POST /ngsi-ld/v1/entities/${encodeURIComponent(R)}/attrs`, // the fake broker answers the PATCH with 404
      `POST /ngsi-ld/v1/entities/${encodeURIComponent(task)}/attrs`,
    ]);
    expect(t.calls[1]!.body).toEqual({ action: 'publish', correct: { danger: true }, by: 'app:reviewer-1' });
    expect(t.calls[1]!.headers.get('authorization')).toBe(`Bearer ${PM_TOKEN}`);
    expect(t.calls[3]!.body).toEqual({ ...result, finalAction: P('publish'), reviewedAt: P('2026-10-09T03:00:00.000Z') });
    expect(t.calls[5]!.body).toMatchObject({ progress: P('completed'), statusLabel: P('publish'), completedAt: P({ '@type': 'DateTime', '@value': '2026-10-09T03:00:00.000Z' }) });
  });

  it('reads full IRIs when the subscription has no context', async () => {
    const t = reviews();
    const full = {
      id: D, type: 'https://datamodels.jp/ns/decision/Decision',
      'http://www.w3.org/ns/prov#used': { type: 'Relationship', object: R },
      'https://datamodels.jp/ns/decision/profile': P('road-restriction-check'),
      'https://datamodels.jp/ns/decision/reviewStatus': P('resolved'),
      'https://datamodels.jp/ns/decision/finalAction': P('reject'),
      'https://datamodels.jp/ns/decision/reviewedBy': P('app:reviewer-1'),
      'https://datamodels.jp/ns/decision/reviewedAt': P({ '@type': 'DateTime', '@value': '2026-10-09T03:00:00Z' }),
    };
    expect(await (await t.send([full])).json()).toEqual({ handled: [{ id: D, review: 'resolved', written: true }] });
    expect(t.calls[1]!.body).toEqual({ action: 'reject', correct: {}, by: 'app:reviewer-1' });
  });

  it('sends nothing twice: a resolved review, or the same feedback', async () => {
    const done = reviews({ record: { review: { status: 'resolved' }, feedback: [] } });
    expect(await (await done.send([resolved()])).json()).toEqual({ handled: [{ id: D, review: 'already resolved', written: true }] });
    expect(done.calls.some((c) => c.url.endsWith('/resolve'))).toBe(false);
    // An action Pointsman did not queue (urgent): corrections go in as feedback, once.
    const corrections = { type: 'JsonProperty', json: [{ name: 'danger', value: false, by: 'x', at: 't' }, { name: 'category', value: 'other', by: 'x', at: 't' }] };
    const sent = reviews({ record: { feedback: [{ by: 'app:reviewer-1', correct: { category: 'other', danger: false } }] } });
    expect(await (await sent.send([resolved({ corrections })])).json()).toMatchObject({ handled: [{ review: 'feedback already sent' }] });
    // Sent one at a time earlier (for example from GitHub comments): nothing new.
    const apart = reviews({ record: { feedback: [{ by: 'app:reviewer-1', correct: { danger: false } }, { by: 'app:reviewer-1', correct: { category: 'other' } }] } });
    expect(await (await apart.send([resolved({ corrections })])).json()).toMatchObject({ handled: [{ review: 'feedback already sent' }] });
    // Only what is new, and only this person's earlier feedback counts.
    const fresh = reviews({ record: { feedback: [{ by: 'app:reviewer-1', correct: { danger: false } }, { by: 'someone-else', correct: { category: 'other' } }] } });
    expect(await (await fresh.send([resolved({ corrections })])).json()).toMatchObject({ handled: [{ review: 'feedback sent' }] });
    expect(fresh.calls.find((c) => c.url.endsWith('/feedback'))!.body).toEqual({ correct: { category: 'other' }, by: 'app:reviewer-1' });
    const none = reviews({ record: { feedback: [] } });
    expect(await (await none.send([resolved()])).json()).toMatchObject({ handled: [{ review: 'nothing to send' }] });
  });

  it('takes a review resolved in the meantime (409) as done', async () => {
    const t = reviews({ resolve: 409 });
    expect(await (await t.send([resolved()])).json()).toEqual({ handled: [{ id: D, review: 'already resolved', written: true }] });
  });

  it('leaves the entity alone when a newer decision replaced this one', async () => {
    const t = reviews({ entity: { id: R, type: 'RoadRestriction', check: { ...result, decision: { type: 'Relationship', object: 'urn:ngsi-ld:Decision:d-2' } } } });
    expect(await (await t.send([resolved()])).json()).toEqual({ handled: [{ id: D, review: 'resolved', written: false }] });
    expect(t.calls.some((c) => c.method === 'PATCH' || c.url.includes('Task'))).toBe(false);
  });

  it('skips decisions that are not resolved, and other types', async () => {
    const t = reviews();
    const res = await t.send([resolved({ reviewStatus: P('pending') }), { ...resolved(), type: 'RoadRestriction' }]);
    expect(await res.json()).toEqual({ handled: [{ id: D, skipped: 'not resolved' }] });
    expect(t.calls).toHaveLength(0);
  });

  it('refuses a resolved Decision without finalAction, reviewedBy or proper corrections, without a retry', async () => {
    const t = reviews();
    const res = await t.send([
      resolved({ finalAction: undefined }),
      resolved({ reviewedBy: P(' ') }),
      resolved({ corrections: { type: 'JsonProperty', json: [{ name: 'danger' }] } }),
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { handled: { retry: boolean }[] }).handled.map((h) => h.retry)).toEqual([false, false, false]);
    expect(t.calls).toHaveLength(0);
  });

  it('asks for a retry when Pointsman or the broker fails, and not when Pointsman refuses', async () => {
    expect((await reviews({ resolve: 503 }).send([resolved()])).status).toBe(502);
    expect((await reviews({ get: 500 }).send([resolved()])).status).toBe(502);
    expect((await reviews({ task: 503 }).send([resolved()])).status).toBe(502);
    const refused = await reviews({ resolve: 400 }).send([resolved()]);
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ handled: [{ error: 'pointsman answered 400', retry: false }] });
    // A partial update (207) of the Task is not done.
    expect(await (await reviews({ task: 207 }).send([resolved()])).json()).toMatchObject({ handled: [{ error: 'broker refused the Task update: 207' }] });
    // A partial update (207) of the result does not complete the Task.
    const partial = reviews({ entity: undefined });
    const fetchFn = partial.config.fetch!;
    partial.config.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method === 'PATCH' ? new Response('{}', { status: 207 }) : fetchFn(input, init))) as typeof fetch;
    expect(await (await partial.send([resolved()])).json()).toMatchObject({ handled: [{ error: 'broker write failed: 207' }] });
    expect(partial.calls.some((c) => c.url.includes('Task'))).toBe(false);
    // No Task (404) is fine.
    expect(await (await reviews({ task: 404 }).send([resolved()])).json()).toMatchObject({ handled: [{ written: true }] });
  });

  it('writes nothing when Pointsman has the review resolved with another action', async () => {
    const t = reviews({ record: { review: { status: 'resolved', final_action: 'reject' } } });
    expect(await (await t.send([resolved()])).json()).toEqual({ handled: [{ id: D, error: 'the review is resolved in Pointsman as reject, not publish', retry: false }] });
    expect(t.calls.some((c) => c.url.startsWith('https://broker.test/'))).toBe(false);
    // After a 409 the bridge reads Pointsman's resolution again.
    let reads = 0;
    const raced = setup({
      route: { decisionEntity: true },
      pointsman: (_b, url) => (url.endsWith('/resolve') ? new Response(null, { status: 409 })
        : Response.json(++reads === 1 ? { review: { status: 'pending' } } : { review: { status: 'resolved', final_action: 'reject' } })),
    });
    const res = await handleRequest(new Request('https://bridge.test/reviews', {
      method: 'POST', headers: { 'x-bridge-secret': SECRET }, body: JSON.stringify({ type: 'Notification', data: [resolved()] }),
    }), raced.config);
    expect(await res.json()).toMatchObject({ handled: [{ error: 'the review is resolved in Pointsman as reject, not publish' }] });
    expect(reads).toBe(2);
  });

  it('refuses a reviewedAt that is not a date and time, before sending anything', async () => {
    for (const bad of [undefined, P('yesterday'), P({ '@type': 'DateTime', '@value': '2026-10-09' }), P(42), P('2026-02-30T03:00:00Z'), P('2026-01-01T24:00:00Z'), P('2026-01-01T10:00:00+25:00')]) {
      const t = reviews();
      expect(await (await t.send([resolved({ reviewedAt: bad })])).json()).toEqual({ handled: [{ id: D, error: 'reviewedAt: expected a date and time (RFC 3339)', retry: false }] });
      expect(t.calls).toHaveLength(0);
    }
  });

  it('accepts RFC 3339 dates and times with fractions and zones', async () => {
    for (const ok of ['2026-10-09T03:00:00Z', '2026-10-09T12:00:00.123+09:00', '2028-02-29T23:59:59-05:30']) {
      expect(await (await reviews().send([resolved({ reviewedAt: P(ok) })])).json()).toMatchObject({ handled: [{ written: true }] });
    }
  });

  it('finds the route whose result links the decision when two routes use the profile', async () => {
    const t = reviews({ entity: { id: R, type: 'RoadRestriction', check: { ...result, decision: { type: 'Relationship', object: 'urn:ngsi-ld:Decision:other' } }, recheck: result } });
    t.config.routes = [
      { ...route, decisionEntity: true },
      { ...route, name: 'again', attribute: 'recheck', decisionEntity: true },
    ];
    expect(await (await t.send([resolved()])).json()).toEqual({ handled: [{ id: D, review: 'resolved', written: true }] });
    expect(t.calls.find((c) => c.method === 'GET' && c.url.includes('attrs='))!.url).toContain('?attrs=check,recheck');
    expect(t.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/attrs/recheck'))).toBe(true);
  });

  it('needs the secret on /reviews too', async () => {
    const t = reviews();
    const res = await handleRequest(new Request('https://bridge.test/reviews', { method: 'POST', headers: { 'x-bridge-secret': 'wrong' }, body: '{}' }), t.config);
    expect(res.status).toBe(403);
  });
});

describe('work orders from other apps', () => {
  const R = 'urn:ngsi-ld:RoadRestriction:1';
  const D = 'urn:ngsi-ld:Decision:d-1';
  const W = 'urn:ngsi-ld:Issue:redmine:city-a:42';
  const workOrders = { Published: 'publish', Rejected: 'reject' };
  /** A Redmine GTT issue as GTT emits it in the Task vocabulary. */
  const order = (extra: Record<string, unknown> = {}) => ({
    id: W, type: 'Task',
    name: P('[review] 県道12号'), progress: P('completed'), statusLabel: P('Published'),
    refersTo: { type: 'Relationship', object: R },
    dateModified: P({ '@type': 'DateTime', '@value': '2026-10-09T05:00:00Z' }),
    ...extra,
  });
  const pending = { type: 'Property', value: 'review', inputHash: P('h-1'), decision: { type: 'Relationship', object: D } };

  function orders(opts: { entity?: unknown; get?: number; post?: number; workOrders?: Record<string, string> | null; decisionStatus?: string } = {}) {
    let status = opts.decisionStatus ?? 'pending';
    const t = setup({
      route: { decisionEntity: true, task: { actions: ['review', 'urgent'] }, reviewActions: ['review', 'urgent'] },
      handler: (c) => {
        if (c.method === 'GET' && c.url.includes(encodeURIComponent(R))) {
          return opts.get ? new Response(null, { status: opts.get }) : Response.json(opts.entity ?? { id: R, type: 'RoadRestriction', check: pending });
        }
        if (c.method === 'GET' && c.url.includes('urn%3Angsi-ld%3ADecision%3A')) {
          expect(c.headers.get('link')).toContain(DECISION_CONTEXT);
          return Response.json({ id: decodeURIComponent(c.url.split('/entities/')[1]!), type: 'Decision', reviewStatus: P(status) });
        }
        if (c.method === 'POST' && c.url.includes('urn%3Angsi-ld%3ADecision%3A')) {
          if ((opts.post ?? 204) < 300) status = 'resolved';
          return new Response(null, { status: opts.post ?? 204 });
        }
        return undefined;
      },
    });
    if (opts.workOrders !== null) t.config.workOrders = opts.workOrders ?? workOrders;
    const send = (data: unknown[]) => handleRequest(new Request('https://bridge.test/reviews', {
      method: 'POST', headers: { 'x-bridge-secret': SECRET }, body: JSON.stringify({ type: 'Notification', data }),
    }), t.config);
    return { ...t, send };
  }

  it('resolves the pending decision of the entity a completed work order refers to', async () => {
    const t = orders();
    const res = await t.send([order()]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: [{ id: W, resolves: D, finalAction: 'publish' }] });
    expect(t.calls.find((c) => c.method === 'GET')!.url).toBe(`https://broker.test/ngsi-ld/v1/entities/${encodeURIComponent(R)}?attrs=check`);
    const write = t.calls.find((c) => c.method === 'POST')!;
    expect(write.url).toBe(`https://broker.test/ngsi-ld/v1/entities/${encodeURIComponent(D)}/attrs`);
    expect(write.headers.get('content-type')).toBe('application/ld+json');
    expect(write.body).toEqual({
      '@context': [DECISION_CONTEXT, 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld'],
      reviewStatus: P('resolved'), finalAction: P('publish'), reviewedBy: P('redmine:city-a#42'),
      reviewedAt: P({ '@type': 'DateTime', '@value': '2026-10-09T05:00:00Z' }),
    });
    // Nothing goes to Pointsman here: /reviews does that when the broker notifies the Decision.
    expect(t.calls.some((c) => c.url.startsWith('https://pm.test/'))).toBe(false);
  });

  it('reads full IRIs, and other apps’ ids as reviewedBy', async () => {
    const t = orders();
    const full = {
      id: 'urn:ngsi-ld:Task:app-7', type: 'https://datamodels.jp/ns/task/Task',
      'https://datamodels.jp/ns/task/progress': P('completed'), 'https://datamodels.jp/ns/task/statusLabel': P('Rejected'),
      'https://datamodels.jp/ns/task/refersTo': { type: 'Relationship', object: R },
      'https://smart-data-models.github.io/data-models/terms.jsonld#/definitions/dateModified': P({ '@type': 'DateTime', '@value': '2026-10-09T06:00:00Z' }),
    };
    expect(await (await t.send([full])).json()).toMatchObject({ handled: [{ resolves: D, finalAction: 'reject' }] });
    const body = t.calls.find((c) => c.method === 'POST')!.body as Record<string, { value: unknown }>;
    expect(body.reviewedBy).toEqual(P('urn:ngsi-ld:Task:app-7'));
    expect(body.reviewedAt).toEqual(P({ '@type': 'DateTime', '@value': '2026-10-09T06:00:00Z' }));
  });

  it('skips open work orders, unmapped statuses, and entities without a pending decision', async () => {
    const skip = async (o: Record<string, unknown>, opts: Parameters<typeof orders>[0] = {}) => {
      const t = orders(opts);
      const out = (await (await t.send([o])).json()) as { handled: { skipped?: string }[] };
      expect(t.calls.some((c) => c.method === 'POST')).toBe(false);
      return out.handled[0]?.skipped;
    };
    expect(await skip(order({ progress: P('needs-action') }))).toBe('not completed');
    expect(await skip(order({ statusLabel: P('Closed') }))).toBe('status not mapped');
    expect(await skip(order({ statusLabel: P('constructor') }))).toBe('status not mapped');
    expect(await skip(order({ refersTo: undefined }))).toBe('nothing to resolve');
    expect(await skip(order(), { get: 404 })).toBe('nothing to resolve');
    // Resolved already (a repeat), or the result needs no person.
    expect(await skip(order(), { entity: { id: R, type: 'RoadRestriction', check: { ...pending, finalAction: P('publish') } } })).toBe('nothing to resolve');
    expect(await skip(order(), { entity: { id: R, type: 'RoadRestriction', check: { ...pending, value: 'publish' } } })).toBe('nothing to resolve');
  });

  it('ignores the bridge’s own Tasks, also ones made for older input values', async () => {
    for (const hash of ['h-1', 'h-older']) {
      const own = await taskEntityId(R, 'check', hash);
      const t = orders({ workOrders: { publish: 'publish' } });
      // As the bridge completes it: no dateModified.
      expect(await (await t.send([order({ id: own, statusLabel: P('publish'), dateModified: undefined })])).json()).toEqual({ handled: [{ id: own, skipped: 'own task' }] });
      expect(t.calls).toHaveLength(0);
    }
  });

  it('refuses a work order without dateModified', async () => {
    for (const bad of [undefined, P('later')]) {
      const t = orders();
      expect(await (await t.send([order({ dateModified: bad })])).json()).toEqual({ handled: [{ id: W, error: 'dateModified: expected a date and time (RFC 3339)', retry: false }] });
      expect(t.calls).toHaveLength(0);
    }
  });

  it('resolves the main route\u2019s decision, never a later step of a chain', async () => {
    const second = { type: 'Property', value: 'review', decision: { type: 'Relationship', object: 'urn:ngsi-ld:Decision:d-2' } };
    // Both steps wait for a person: the work order answers step 1.
    const t = orders({ entity: { id: R, type: 'RoadRestriction', check: pending, evacuation: second } });
    t.config.routes.push({ ...route, name: 'evacuation', attribute: 'evacuation', decisionEntity: true });
    expect(await (await t.send([order()])).json()).toEqual({ handled: [{ id: W, resolves: D, finalAction: 'publish' }] });
    expect(t.calls.find((c) => c.method === 'GET' && c.url.includes(encodeURIComponent(R)))!.url).toContain('?attrs=check');
    // Only step 2 waits: nothing to resolve for a work order.
    const later = orders({ entity: { id: R, type: 'RoadRestriction', check: { ...pending, finalAction: P('publish') }, evacuation: second } });
    later.config.routes.push({ ...route, name: 'evacuation', attribute: 'evacuation', decisionEntity: true });
    expect(await (await later.send([order()])).json()).toEqual({ handled: [{ id: W, skipped: 'nothing to resolve' }] });
    expect(later.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('lets the first work order win, also two in one notification', async () => {
    const t = orders();
    const res = await t.send([order(), order({ id: 'urn:ngsi-ld:Issue:redmine:city-a:43', statusLabel: P('Rejected') })]);
    expect(await res.json()).toEqual({ handled: [
      { id: W, resolves: D, finalAction: 'publish' },
      { id: 'urn:ngsi-ld:Issue:redmine:city-a:43', skipped: 'already resolved' },
    ] });
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // Resolved by another app before: left alone.
    const other = orders({ decisionStatus: 'resolved' });
    expect(await (await other.send([order()])).json()).toEqual({ handled: [{ id: W, skipped: 'already resolved' }] });
    expect(other.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a Task id too long to name who resolved it', async () => {
    const long = `urn:ngsi-ld:Task:${'x'.repeat(90)}`;
    const t = orders();
    expect(await (await t.send([order({ id: long })])).json()).toEqual({ handled: [{ id: long, error: 'the Task id is too long to name who resolved it (at most 100 characters)', retry: false }] });
    expect(t.calls).toHaveLength(0);
  });

  it('leaves Tasks alone without a work-order mapping', async () => {
    const t = orders({ workOrders: null });
    expect(await (await t.send([order()])).json()).toEqual({ handled: [] });
    expect(t.calls).toHaveLength(0);
  });

  it('asks for a retry when the broker fails, and not when it refuses', async () => {
    expect((await orders({ get: 503 }).send([order()])).status).toBe(502);
    expect((await orders({ post: 503 }).send([order()])).status).toBe(502);
    const refused = await orders({ post: 400 }).send([order()]);
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ handled: [{ error: 'broker refused the Decision update: 400', retry: false }] });
    expect(await (await orders({ post: 207 }).send([order()])).json()).toMatchObject({ handled: [{ error: 'broker refused the Decision update: 207' }] });
  });

  it('checks the mapping', () => {
    expect(parseWorkOrders('{"Published":"publish","Rejected":"reject"}')).toEqual(workOrders);
    expect(() => parseWorkOrders('not json')).toThrow(/not valid JSON/);
    expect(() => parseWorkOrders('{"Published":"Publish"}')).toThrow(/lower case/);
    expect(() => parseWorkOrders('{"Published":1}')).toThrow(/Published/);
    expect(parseWorkOrders(JSON.stringify({ Done: `a${'b'.repeat(62)}` }))).toEqual({ Done: `a${'b'.repeat(62)}` });
    expect(() => parseWorkOrders(JSON.stringify({ Done: `a${'b'.repeat(63)}` }))).toThrow(/at most 63/);
  });
});

describe('reliable delivery (queue)', () => {
  /** A fake queue producer: keeps what was sent. */
  function fakeQueue(fail = false) {
    const sent: BridgeMessage[][] = [];
    return { sent, sendBatch: async (messages: { body: BridgeMessage }[]) => { if (fail) throw new Error('queue down'); sent.push(messages.map((m) => m.body)); } };
  }
  /** A fake queue message: records ack and retry. */
  function message(body: unknown, attempts = 1) {
    const m = { body, attempts, acked: false, retried: undefined as number | undefined,
      ack() { m.acked = true; }, retry(o?: { delaySeconds?: number }) { m.retried = o?.delaySeconds ?? 0; } };
    return m;
  }
  const notify = (config: BridgeConfig, data: unknown[], path = '/notify', secret = SECRET) => handleRequest(new Request(`https://bridge.test${path}`, {
    method: 'POST', headers: { 'x-bridge-secret': secret }, body: JSON.stringify({ type: 'Notification', data }),
  }), config);

  it('queues one message per entity and answers 202 at once, after the secret check', async () => {
    const t = setup();
    const queue = fakeQueue();
    t.config.queue = queue;
    const res = await notify(t.config, [entity(), { ...entity(), id: 'urn:ngsi-ld:RoadRestriction:2' }, { ...entity(), type: 'Other' }]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 2 });
    expect(queue.sent.flat().map((m) => [m.path, m.route, m.entity.id])).toEqual([['/notify', undefined, 'urn:ngsi-ld:RoadRestriction:1'], ['/notify', undefined, 'urn:ngsi-ld:RoadRestriction:2']]);
    // Nothing is decided at the door.
    expect(t.calls).toHaveLength(0);
    expect((await notify(t.config, [entity()], '/notify', 'wrong')).status).toBe(403);
    expect(queue.sent).toHaveLength(1);
  });

  it('keeps the route name, queues reviews too, and sends at most 100 per batch', async () => {
    const t = setup();
    const queue = fakeQueue();
    t.config.queue = queue;
    t.config.routes.push({ ...route, name: 'evacuation', attribute: 'evacuation' });
    await notify(t.config, [entity()], '/notify?route=evacuation');
    expect(queue.sent[0]![0]).toMatchObject({ path: '/notify', route: 'evacuation' });
    await notify(t.config, [{ id: 'urn:ngsi-ld:Decision:d-1', type: 'Decision' }], '/reviews');
    expect(queue.sent[1]![0]).toMatchObject({ path: '/reviews' });
    const many = Array.from({ length: 150 }, (_, i) => ({ ...entity(), id: `urn:ngsi-ld:RoadRestriction:${i}` }));
    expect(await (await notify(t.config, many)).json()).toEqual({ queued: 150 });
    expect(queue.sent.slice(2).map((b) => b.length)).toEqual([100, 50]);
  });

  it('splits batches by size too (256 KB per sendBatch)', () => {
    const m = (bytes: number) => ({ bytes });
    expect(queueBatches([m(100_000), m(100_000), m(100_000)]).map((b) => b.length)).toEqual([2, 1]);
    expect(queueBatches(Array.from({ length: 101 }, () => m(10))).map((b) => b.length)).toEqual([100, 1]);
    expect(queueBatches([])).toEqual([]);
  });

  it('handles an entity too large for one queue message right away', async () => {
    const t = setup();
    const queue = fakeQueue();
    t.config.queue = queue;
    const big = entity({ description: P('x'.repeat(130_000)) });
    const res = await notify(t.config, [big, { ...entity(), id: 'urn:ngsi-ld:RoadRestriction:2' }]);
    // The small one is queued, the large one decided now.
    expect(queue.sent.flat().map((x) => x.entity.id)).toEqual(['urn:ngsi-ld:RoadRestriction:2']);
    expect(t.calls.filter((c) => c.url.startsWith('https://pm.test/'))).toHaveLength(1);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { handled: { id: string }[] }).handled.map((h) => h.id)).toEqual(['urn:ngsi-ld:RoadRestriction:1']);
  });

  it('answers 502 when the queue does not take the notification, so the broker sends it again', async () => {
    const t = setup();
    t.config.queue = fakeQueue(true);
    expect((await notify(t.config, [entity()])).status).toBe(502);
  });

  it('decides on the entity as it is now, and acknowledges', async () => {
    const now = entity({ description: P('今は通れる') });
    const t = setup({ handler: (c) => (c.method === 'GET' ? Response.json(now) : undefined) });
    const m = message({ path: '/notify', entity: entity() });
    await handleQueueBatch({ messages: [m] }, t.config);
    expect(m.acked).toBe(true);
    expect(t.calls[0]!.method).toBe('GET');
    expect(t.calls[0]!.url).toBe(`https://broker.test/ngsi-ld/v1/entities/${encodeURIComponent('urn:ngsi-ld:RoadRestriction:1')}`);
    expect(t.calls[0]!.headers.get('link')).toContain('https://ctx.test/v1.jsonld');
    const decide = t.calls.find((c) => c.url.startsWith('https://pm.test/'))!;
    expect((decide.body as { state: { description: unknown } }).state.description).toEqual(P('今は通れる'));
  });

  it('decides a message delivered twice only once', async () => {
    let stored: Record<string, unknown> | undefined;
    const t = setup({ handler: (c) => {
      if (c.method === 'GET') return Response.json(entity(stored ? { check: stored } : {}));
      if (c.method === 'PATCH' && c.url.endsWith('/attrs/check')) { stored = c.body as Record<string, unknown>; return new Response(null, { status: 204 }); }
      return undefined;
    } });
    const body = { path: '/notify', entity: entity() };
    await handleQueueBatch({ messages: [message(body), message(body)] }, t.config);
    expect(t.calls.filter((c) => c.url.startsWith('https://pm.test/'))).toHaveLength(1);
  });

  it('retries with a growing delay while Pointsman is down, and decides once it is back', async () => {
    let down = 3;
    const t = setup({
      pointsman: () => (down > 0 ? new Response(null, { status: 503 }) : Response.json(decision)),
      handler: (c) => (c.method === 'GET' ? Response.json(entity()) : undefined),
    });
    const delays: (number | undefined)[] = [];
    for (let attempts = 1; attempts <= 4; attempts++) {
      const m = message({ path: '/notify', entity: entity() }, attempts);
      await handleQueueBatch({ messages: [m] }, t.config);
      if (m.acked) break;
      delays.push(m.retried);
      down -= 1;
    }
    expect(delays).toEqual([30, 60, 120]);
    expect(t.calls.filter((c) => c.url.startsWith('https://pm.test/'))).toHaveLength(4);
    expect(t.calls.filter((c) => c.method === 'PATCH' && c.url.endsWith('/attrs/check'))).toHaveLength(1);
  });

  it('acknowledges what a retry cannot fix, a deleted entity, and a message without an entity', async () => {
    const refused = setup({ pointsman: () => new Response(null, { status: 400 }), handler: (c) => (c.method === 'GET' ? Response.json(entity()) : undefined) });
    const r = message({ path: '/notify', entity: entity() });
    await handleQueueBatch({ messages: [r] }, refused.config);
    expect(r.acked).toBe(true);
    const gone = setup();
    const g = message({ path: '/notify', entity: entity() });
    await handleQueueBatch({ messages: [g] }, gone.config);
    expect(g.acked).toBe(true);
    expect(gone.calls.some((c) => c.url.startsWith('https://pm.test/'))).toBe(false);
    const bad = message({ path: '/elsewhere' });
    await handleQueueBatch({ messages: [bad] }, setup().config);
    expect(bad.acked).toBe(true);
  });

  it('retries when the broker read fails, and handles reviews from the queue', async () => {
    const t = setup({ handler: (c) => (c.method === 'GET' ? new Response(null, { status: 503 }) : undefined) });
    const m = message({ path: '/notify', entity: entity() }, 2);
    await handleQueueBatch({ messages: [m] }, t.config);
    expect(m.retried).toBe(60);
    // A review: resolved Decision without the required fields is refused, so acknowledged.
    const r = message({ path: '/reviews', entity: { id: 'urn:ngsi-ld:Decision:d-1', type: 'Decision', reviewStatus: P('resolved') } });
    await handleQueueBatch({ messages: [r] }, setup().config);
    expect(r.acked).toBe(true);
  });

  it('handles a queued review with the Decision as it is now', async () => {
    const D = 'urn:ngsi-ld:Decision:d-1';
    const now = { id: D, type: 'Decision', refersTo: { type: 'Relationship', object: 'urn:ngsi-ld:RoadRestriction:1' }, profile: P('road-restriction-check'),
      reviewStatus: P('resolved'), finalAction: P('reject'), reviewedBy: P('app:reviewer'), reviewedAt: P('2026-10-10T01:00:00Z') };
    const t = setup({
      pointsman: (_b, url) => (url.endsWith('/resolve') ? Response.json({}) : Response.json({ review: { status: 'pending' } })),
      handler: (c) => (c.method === 'GET' && c.url.includes(encodeURIComponent(D)) ? Response.json(now) : undefined),
    });
    // Queued when it said publish; changed to reject before the consumer ran.
    const m = message({ path: '/reviews', entity: { ...now, finalAction: P('publish') } });
    await handleQueueBatch({ messages: [m] }, t.config);
    expect(m.acked).toBe(true);
    const read = t.calls.find((c) => c.method === 'GET' && c.url.includes(encodeURIComponent(D)))!;
    expect(read.headers.get('link')).toContain(DECISION_CONTEXT);
    expect(t.calls.find((c) => c.url.endsWith('/resolve'))!.body).toMatchObject({ action: 'reject' });
  });

  it('caps the delay at an hour', () => {
    expect([1, 2, 3, 7, 8, 20].map(retryDelay)).toEqual([30, 60, 120, 1920, 3600, 3600]);
  });

  it('never queues again from the consumer', async () => {
    const queue = fakeQueue();
    const t = setup({ handler: (c) => (c.method === 'GET' ? Response.json(entity()) : undefined) });
    t.config.queue = queue;
    const m = message({ path: '/notify', entity: entity() });
    await handleQueueBatch({ messages: [m] }, t.config);
    expect(m.acked).toBe(true);
    expect(queue.sent).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('https://pm.test/'))).toBe(true);
  });
});
