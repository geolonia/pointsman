// FIWARE bridge: NGSI-LD notification -> Pointsman -> result back on the
// entity. See bridge/README.md for the setup, and docs/spikes/fiware-bridge.md
// (#14, #41) for why it works this way.

/** One entity type the bridge handles. */
export interface Route {
  /** Entity type as it appears in the notification. */
  type: string;
  /** Pointsman profile to call. */
  profile: string;
  /** The attributes the profile reads; the loop guard hashes their values. */
  inputs: string[];
  /** The attribute the result is written to. */
  attribute: string;
  /** Also create a Decision entity (docs/data-model/) for each decision. */
  decisionEntity?: boolean;
  /** Actions a person checks before anything happens (default: review). */
  reviewActions?: string[];
}

export interface BridgeConfig {
  routes: Route[];
  /** Shared secret the subscription sends in `x-bridge-secret`. */
  notifySecret: string;
  pointsman: { url: string; token: string };
  broker: {
    url: string;
    /** Sent as `Authorization: Bearer …` when set. */
    token?: string;
    /** Sent as `X-Api-Key` when set (for example a GeonicDB API key). */
    apiKey?: string;
    /** Sent as `NGSILD-Tenant` when set. */
    tenant?: string;
    /** JSON-LD context for the writes, when attribute names are not core terms. */
    context?: string;
  };
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** What happened to one entity of a notification. */
export type EntityResult =
  | { id: string; skipped: 'inputs unchanged' | 'deleted' }
  | { id: string; action: string; decision: string; write: number }
  | { id: string; error: string; retry: boolean; decision?: string };

type Entity = { id: string; type: string; [attribute: string]: unknown };

/** Checks a configuration from JSON (for example a Worker variable). */
export function parseRoutes(json: string): Route[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('bridge routes: not valid JSON');
  }
  if (!Array.isArray(data) || data.length === 0) throw new Error('bridge routes: expected a non-empty list');
  const seen = new Set<string>();
  return data.map((r, i) => {
    const where = `bridge routes[${i}]`;
    if (!r || typeof r !== 'object') throw new Error(`${where}: expected an object`);
    const { type, profile, inputs, attribute, decisionEntity, reviewActions } = r as Record<string, unknown>;
    for (const [name, v] of Object.entries({ type, profile, attribute })) {
      if (typeof v !== 'string' || v === '') throw new Error(`${where}.${name}: expected a non-empty string`);
    }
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((x) => typeof x === 'string' && x !== '')) {
      throw new Error(`${where}.inputs: expected a non-empty list of attribute names`);
    }
    // Writing to an input would change the inputs and start a new decision.
    if ((inputs as string[]).includes(attribute as string)) throw new Error(`${where}: attribute must not be one of the inputs`);
    if (decisionEntity !== undefined && typeof decisionEntity !== 'boolean') throw new Error(`${where}.decisionEntity: expected true or false`);
    if (reviewActions !== undefined && (!Array.isArray(reviewActions) || !reviewActions.every((x) => typeof x === 'string' && x !== ''))) {
      throw new Error(`${where}.reviewActions: expected a list of action names`);
    }
    if (seen.has(type as string)) throw new Error(`${where}: type ${String(type)} is listed twice`);
    seen.add(type as string);
    return {
      type, profile, inputs, attribute,
      ...(decisionEntity !== undefined && { decisionEntity }),
      ...(reviewActions !== undefined && { reviewActions }),
    } as Route;
  });
}

/**
 * Hash of the input attributes' values. Stored with the result; a
 * notification whose inputs have this hash already has its decision. This is
 * the loop guard: some brokers notify on the bridge's own write even when the
 * subscription watches other attributes (#41).
 */
export async function inputHash(entity: Entity, inputs: string[]): Promise<string> {
  const values = inputs.map((name) => valueOf(entity[name]) ?? null);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function valueOf(attribute: unknown): unknown {
  if (!attribute || typeof attribute !== 'object') return undefined;
  const a = attribute as Record<string, unknown>;
  // Property, Relationship, GeoProperty, LanguageProperty, VocabProperty, JsonProperty
  return a.value ?? a.object ?? a.languageMap ?? a.vocab ?? a.json;
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  // Compare hashes, so the comparison takes the same time for any input length.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/** Handles `POST /notify`. Any other request gets 404. */
export async function handleRequest(request: Request, config: BridgeConfig): Promise<Response> {
  // Also for Workers that build the config themselves: GeonicDB would silently
  // prefer the token over the key.
  if (config.broker.token && config.broker.apiKey) {
    console.error('bridge configuration: broker token and API key are both set');
    return Response.json({ error: 'bridge is not configured' }, { status: 500 });
  }
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/notify') return Response.json({ error: 'not found' }, { status: 404 });
  // The subscription sends the secret in endpoint.receiverInfo.
  if (!(await sameSecret(request.headers.get('x-bridge-secret') ?? '', config.notifySecret))) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  let notification: unknown;
  try {
    notification = await request.json();
  } catch {
    return Response.json({ error: 'body is not JSON' }, { status: 400 });
  }
  const data = (notification as { data?: unknown })?.data;
  if (!Array.isArray(data)) return Response.json({ error: 'expected a notification with data' }, { status: 400 });

  const results: EntityResult[] = [];
  for (const entity of data as Entity[]) {
    const route = config.routes.find((r) => r.type === entity?.type);
    if (!route || typeof entity.id !== 'string') continue;
    // Deleting an entity also notifies (NGSI-LD 1.8: with deletedAt); there is
    // nothing left to decide about.
    if ('deletedAt' in entity) {
      results.push({ id: entity.id, skipped: 'deleted' });
      continue;
    }
    // One entity's failure must not stop the others in the notification.
    try {
      results.push(await handleEntity(entity, route, config));
    } catch (err) {
      results.push({ id: entity.id, error: err instanceof Error ? err.message : String(err), retry: true });
    }
  }
  // A failure that may pass on a second try: answer 502, so a broker that
  // retries notifications sends it again. Entities that succeeded are skipped
  // on the retry (input hash). Failures that will not pass (Pointsman refused
  // the input) are reported but do not ask for a retry.
  const retry = results.some((r) => 'retry' in r && r.retry);
  return Response.json({ handled: results }, { status: retry ? 502 : 200 });
}

async function handleEntity(entity: Entity, route: Route, config: BridgeConfig): Promise<EntityResult> {
  const fetchFn = config.fetch ?? fetch;
  const hash = await inputHash(entity, route.inputs);
  const previous = entity[route.attribute] as { inputHash?: { value?: unknown } } | undefined;
  if (previous?.inputHash?.value === hash) return { id: entity.id, skipped: 'inputs unchanged' };

  const res = await fetchFn(`${config.pointsman.url}/v1/decide/${encodeURIComponent(route.profile)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.pointsman.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state: entity, ref: entity.id }),
  });
  if (!res.ok) {
    // Only the status: the body may echo the input.
    return { id: entity.id, error: `pointsman answered ${res.status}`, retry: retryable(res.status) };
  }
  const d = (await res.json()) as Decision;
  if (!d || typeof d.action !== 'string' || typeof d.decision_id !== 'string' || !d.answers || typeof d.answers !== 'object') {
    return { id: entity.id, error: 'unexpected answer from pointsman', retry: true };
  }

  // One time for the entity and the property, when Pointsman gives none (older versions).
  const decidedAt = new Date();
  // The Decision entity first: the property on the entity points to it, and
  // without it a retry decides again (no input hash written yet).
  let decisionRef: string | undefined;
  if (route.decisionEntity) {
    const created = await createDecisionEntity(toDecisionEntity(d, entity.id, route, decidedAt), config);
    // 409: a retry of a notification whose entity was created, then the write failed.
    if (!created.ok && created.status !== 409) {
      return { id: entity.id, decision: d.decision_id, error: `broker refused the Decision entity: ${created.status}`, retry: retryable(created.status) };
    }
    decisionRef = decisionEntityId(d.decision_id);
  }

  const property = toProperty(d, hash, decidedAt, decisionRef);
  const write = await writeAttribute(entity.id, route.attribute, property, config);
  // Without a successful write the input hash is not stored either, so the
  // next notification decides again: report it as a failure.
  if (!write.ok) {
    return { id: entity.id, decision: d.decision_id, error: `broker write failed: ${write.status}`, retry: retryable(write.status) };
  }
  return { id: entity.id, action: d.action, decision: d.decision_id, write: write.status };
}

/** Rate limits and server errors may pass on a second try; other 4xx will not. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

interface Decision {
  decision_id: string;
  action: string;
  profile: string;
  profile_version: number;
  model: string;
  answers: Record<string, { type?: string; value: unknown; p: number; probabilities?: Record<string, number> }>;
  /** Pointsman returns both since #56; older versions do not. */
  created_at?: string;
  rule?: number | null;
}

/** "0", "1", ... for the rule that matched, "default" for the default action. */
function policyRule(d: Decision): string | undefined {
  if (d.rule === undefined) return undefined;
  return d.rule === null ? 'default' : String(d.rule);
}

/**
 * The result as one Property: the action as its value, the evidence as
 * sub-properties, so a consumer that only needs the action reads
 * `<attribute>.value` and can filter on it.
 */
export function toProperty(d: Decision, hash: string, now = new Date(), decisionRef?: string): Record<string, unknown> {
  const P = (value: unknown) => ({ type: 'Property', value });
  const rule = policyRule(d);
  const property: Record<string, unknown> = {
    type: 'Property',
    value: d.action,
    observedAt: d.created_at ?? now.toISOString(),
    decisionId: P(d.decision_id),
    ...(decisionRef && { decision: { type: 'Relationship', object: decisionRef } }),
    profile: P(d.profile),
    profileVersion: P(d.profile_version),
    ...(rule !== undefined && { policyRule: P(rule) }),
    model: P(d.model),
    inputHash: P(hash),
  };
  for (const [name, a] of Object.entries(d.answers)) {
    // One level of sub-properties: Orion-LD drops a third level (#14).
    property[name] = P(a.value);
    property[`${name}Probability`] = P(a.p);
  }
  return property;
}

/** Authentication, tenant and content type: the same for every request to the broker. */
function brokerHeaders(config: BridgeConfig, contentType: string): Record<string, string> {
  const { broker } = config;
  const headers: Record<string, string> = { 'content-type': contentType };
  if (broker.token) headers.authorization = `Bearer ${broker.token}`;
  if (broker.apiKey) headers['x-api-key'] = broker.apiKey;
  if (broker.tenant) headers['NGSILD-Tenant'] = broker.tenant;
  return headers;
}

/**
 * Writes one attribute with `PATCH …/attrs/{name}`; the first time, when the
 * attribute does not exist yet (404), appends it with `POST …/attrs`. Not
 * `PATCH …/attrs`: Orion-LD notifies on that even for unwatched attributes
 * (#41).
 */
async function writeAttribute(id: string, name: string, property: Record<string, unknown>, config: BridgeConfig): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  const { broker } = config;
  const headers = brokerHeaders(config, 'application/json');
  if (broker.context) headers.link = `<${broker.context}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;
  const attrs = `${broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(id)}/attrs`;
  const write = await fetchFn(`${attrs}/${encodeURIComponent(name)}`, { method: 'PATCH', headers, body: JSON.stringify(property) });
  if (write.status !== 404) return write;
  return fetchFn(attrs, { method: 'POST', headers, body: JSON.stringify({ [name]: property }) });
}

/**
 * Terms of the Decision data model (docs/data-model/decision/context.jsonld),
 * sent inline: the model's context URL is not published yet. A test keeps
 * them equal to the file.
 */
export const DECISION_TERMS: Record<string, string | { '@id': string; '@type': '@id' }> = {
  decision: 'https://datamodels.jp/ns/decision/',
  Decision: 'decision:Decision',
  prov: 'http://www.w3.org/ns/prov#',
  dpv: 'https://w3id.org/dpv#',
  refersTo: { '@id': 'prov:used', '@type': '@id' },
  externalReference: 'decision:externalReference',
  action: 'decision:action',
  answers: 'decision:answers',
  profile: 'decision:profile',
  profileVersion: 'decision:profileVersion',
  policyRule: 'decision:policyRule',
  model: 'decision:model',
  decidedAt: 'prov:endedAtTime',
  humanInvolvement: 'dpv:hasHumanInvolvement',
  reviewStatus: 'decision:reviewStatus',
  finalAction: 'decision:finalAction',
  reviewedBy: 'decision:reviewedBy',
  reviewedAt: 'decision:reviewedAt',
  corrections: 'decision:corrections',
  wasInformedBy: { '@id': 'prov:wasInformedBy', '@type': '@id' },
};

const CORE_CONTEXT = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld';

export const decisionEntityId = (decisionId: string) => `urn:ngsi-ld:Decision:${decisionId}`;

/**
 * A Decision entity (docs/data-model/) in normalized form. A person takes
 * part before anything happens for the route's review actions (default:
 * review); for the others the action is taken and a person can correct it
 * later through Pointsman's feedback.
 */
export function toDecisionEntity(d: Decision, entityId: string, route: Route, now = new Date()): Record<string, unknown> {
  const P = (value: unknown) => ({ type: 'Property', value });
  const checked = (route.reviewActions ?? ['review']).includes(d.action);
  const rule = policyRule(d);
  return {
    '@context': [DECISION_TERMS, CORE_CONTEXT],
    id: decisionEntityId(d.decision_id),
    type: 'Decision',
    refersTo: { type: 'Relationship', object: entityId },
    action: P(d.action),
    answers: {
      type: 'JsonProperty',
      json: Object.entries(d.answers).map(([name, a]) => ({
        name,
        ...(a.type !== undefined && { type: a.type }),
        value: a.value,
        probability: a.p,
        ...(a.probabilities && { probabilities: a.probabilities }),
      })),
    },
    profile: P(d.profile),
    profileVersion: P(d.profile_version),
    ...(rule !== undefined && { policyRule: P(rule) }),
    model: P(d.model),
    decidedAt: P({ '@type': 'DateTime', '@value': d.created_at ?? now.toISOString() }),
    humanInvolvement: { type: 'VocabProperty', vocab: checked ? 'dpv:HumanInvolvementForVerification' : 'dpv:HumanInvolvementForOversight' },
    ...(checked && { reviewStatus: P('pending') }),
  };
}

async function createDecisionEntity(entity: Record<string, unknown>, config: BridgeConfig): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  const { broker } = config;
  // The context is in the body, so no Link header.
  const headers = brokerHeaders(config, 'application/ld+json');
  return fetchFn(`${broker.url}/ngsi-ld/v1/entities`, { method: 'POST', headers, body: JSON.stringify(entity) });
}
