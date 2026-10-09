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
  /** Also create a Decision entity (datamodels.jp Decision model) for each decision. */
  decisionEntity?: boolean;
  /** Actions a person checks before anything happens (default: review). */
  reviewActions?: string[];
  /**
   * Needed when a type has more than one route: the subscription for this
   * route notifies `/notify?route=<name>`. A route without a name serves
   * `/notify` for its type.
   */
  name?: string;
  /**
   * For a chain of decisions: an input attribute written by an earlier
   * route. Its `decision` relationship becomes this decision's
   * `wasInformedBy` in the Decision entity.
   */
  informedBy?: string;
  /**
   * Also create a Task entity (datamodels.jp Task model) for these actions,
   * so a person's work shows up in any app that lists tasks. See TaskOptions.
   */
  task?: TaskOptions;
}

export interface TaskOptions {
  /** The actions that create a Task, for example ["review", "urgent"]. */
  actions: string[];
  /** An attribute whose text goes into the Task's name (for example a road name). */
  name?: string;
  /** Priority per action, 1 (highest) to 9 (lowest), as in RFC 8984. Other actions get none. */
  priority?: Record<string, number>;
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
  | { id: string; skipped: 'inputs unchanged' | 'deleted' | 'not resolved' }
  | { id: string; review: ReviewOutcome; written: boolean }
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
    const { type, profile, inputs, attribute, decisionEntity, reviewActions, name, informedBy, task } = r as Record<string, unknown>;
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
    if (name !== undefined && (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name))) {
      throw new Error(`${where}.name: expected lower-case letters, digits and -`);
    }
    if (informedBy !== undefined && (typeof informedBy !== 'string' || !(inputs as string[]).includes(informedBy))) {
      throw new Error(`${where}.informedBy: expected one of the inputs`);
    }
    if (task !== undefined) parseTask(task, `${where}.task`);
    // One unnamed route per type, and every name once.
    const key = name === undefined ? `type:${String(type)}` : `name:${name}`;
    if (seen.has(key)) {
      throw new Error(name === undefined ? `${where}: type ${String(type)} has two routes without a name` : `${where}: name ${name} is listed twice`);
    }
    seen.add(key);
    return {
      type, profile, inputs, attribute,
      ...(decisionEntity !== undefined && { decisionEntity }),
      ...(reviewActions !== undefined && { reviewActions }),
      ...(name !== undefined && { name }),
      ...(informedBy !== undefined && { informedBy }),
      ...(task !== undefined && { task }),
    } as Route;
  });
}

function parseTask(task: unknown, where: string): void {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`${where}: expected an object`);
  const { actions, name, priority, ...rest } = task as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${where}: unknown option ${unknown[0]}`);
  if (!Array.isArray(actions) || actions.length === 0 || !actions.every((x) => typeof x === 'string' && x !== '')) {
    throw new Error(`${where}.actions: expected a non-empty list of action names`);
  }
  if (name !== undefined && (typeof name !== 'string' || name === '')) throw new Error(`${where}.name: expected an attribute name`);
  if (priority !== undefined) {
    if (!priority || typeof priority !== 'object' || Array.isArray(priority)) throw new Error(`${where}.priority: expected an object`);
    for (const [action, p] of Object.entries(priority)) {
      if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > 9) throw new Error(`${where}.priority.${action}: expected 1 to 9`);
    }
  }
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

/** Handles `POST /notify` (decisions) and `POST /reviews` (reviews resolved in the broker). Any other request gets 404. */
export async function handleRequest(request: Request, config: BridgeConfig): Promise<Response> {
  // Also for Workers that build the config themselves: GeonicDB would silently
  // prefer the token over the key.
  if (config.broker.token && config.broker.apiKey) {
    console.error('bridge configuration: broker token and API key are both set');
    return Response.json({ error: 'bridge is not configured' }, { status: 500 });
  }
  const url = new URL(request.url);
  if (request.method !== 'POST' || (url.pathname !== '/notify' && url.pathname !== '/reviews')) return Response.json({ error: 'not found' }, { status: 404 });
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
  if (url.pathname === '/reviews') {
    for (const entity of data as Entity[]) {
      if (!isDecision(entity)) continue;
      try {
        results.push(await handleReview(entity, config));
      } catch (err) {
        results.push({ id: entity.id, error: err instanceof Error ? err.message : String(err), retry: true });
      }
    }
    return Response.json({ handled: results }, { status: results.some((r) => 'retry' in r && r.retry) ? 502 : 200 });
  }

  // ?route=<name> selects a named route; without it, the type's unnamed route.
  const routeName = url.searchParams.get('route') ?? undefined;
  for (const entity of data as Entity[]) {
    const route = config.routes.find((r) => r.type === entity?.type && r.name === routeName);
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
    headers: { authorization: `Bearer ${config.pointsman.token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
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
    const created = await createEntity(toDecisionEntity(d, entity.id, route, decidedAt, informedByOf(entity, route)), config);
    // 409: a retry of a notification whose entity was created, then the write failed.
    if (!created.ok && created.status !== 409) {
      return { id: entity.id, decision: d.decision_id, error: `broker refused the Decision entity: ${created.status}`, retry: retryable(created.status) };
    }
    decisionRef = decisionEntityId(d.decision_id);
  }
  // Also before the property, for the same reason. Its id comes from the
  // inputs, not the decision (a retry decides again, with a new decision id),
  // and the Task always follows the latest decision for these inputs.
  if (route.task) {
    const taskId = await taskEntityId(entity.id, route.attribute, hash);
    const failed = route.task.actions.includes(d.action)
      ? await putTask(toTaskEntity(d, entity, route.task, taskId, decidedAt), config)
      : await cancelOpenTask(taskId, d.action, config);
    if (failed) {
      return { id: entity.id, decision: d.decision_id, error: `broker refused the Task entity: ${failed.status}`, retry: retryable(failed.status) };
    }
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
  /** Spatial facts, for profiles that ask for them (#64). */
  facts?: Record<string, { missing: false; values: Record<string, unknown>; source: string } | { missing: true; reason: string }>;
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

/**
 * Sent on every request. Some brokers sit behind firewalls that refuse
 * requests without one (GeonicDB's AWS WAF answers 403), and Workers send none
 * by default.
 */
export const USER_AGENT = 'pointsman-bridge (+https://github.com/geolonia/pointsman)';

/** Authentication, tenant and content type: the same for every request to the broker. */
function brokerHeaders(config: BridgeConfig, contentType: string): Record<string, string> {
  const { broker } = config;
  const headers: Record<string, string> = { 'content-type': contentType, 'user-agent': USER_AGENT };
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

/** The published context of the Decision model (datamodels.jp). */
export const DECISION_CONTEXT = 'https://datamodels.jp/context/decision/v1.jsonld';

/**
 * The terms of the Decision model, for callers that need them inline (for
 * example a Worker that serves them). A test keeps them equal to the
 * published context (pinned copy in test/fixtures/datamodels/decision/).
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
  facts: 'decision:facts',
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
 * A Decision entity (datamodels.jp Decision model) in normalized form. A person takes
 * part before anything happens for the route's review actions (default:
 * review); for the others the action is taken and a person can correct it
 * later through Pointsman's feedback.
 */
/** The earlier decision this one follows: the `decision` relationship of the route's informedBy attribute. */
export function informedByOf(entity: Entity, route: Route): string | undefined {
  if (!route.informedBy) return undefined;
  const object = (entity[route.informedBy] as { decision?: { object?: unknown } } | undefined)?.decision?.object;
  return typeof object === 'string' && object !== '' ? object : undefined;
}

export function toDecisionEntity(d: Decision, entityId: string, route: Route, now = new Date(), informedBy?: string): Record<string, unknown> {
  const P = (value: unknown) => ({ type: 'Property', value });
  const checked = (route.reviewActions ?? ['review']).includes(d.action);
  const rule = policyRule(d);
  return {
    '@context': [DECISION_CONTEXT, CORE_CONTEXT],
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
    ...(d.facts && Object.keys(d.facts).length > 0 && {
      facts: { type: 'JsonProperty', json: Object.entries(d.facts).map(([name, f]) => ({ name, ...f })) },
    }),
    profile: P(d.profile),
    profileVersion: P(d.profile_version),
    ...(rule !== undefined && { policyRule: P(rule) }),
    model: P(d.model),
    decidedAt: P({ '@type': 'DateTime', '@value': d.created_at ?? now.toISOString() }),
    humanInvolvement: { type: 'VocabProperty', vocab: checked ? 'dpv:HumanInvolvementForVerification' : 'dpv:HumanInvolvementForOversight' },
    ...(informedBy !== undefined && { wasInformedBy: { type: 'Relationship', object: informedBy } }),
    ...(checked && { reviewStatus: P('pending') }),
  };
}

// --- Reviews resolved in the broker (#83) -----------------------------------

/** What happened in Pointsman for a review resolved in the broker. */
export type ReviewOutcome = 'resolved' | 'already resolved' | 'feedback sent' | 'feedback already sent' | 'nothing to send';

const DECISION_NS = 'https://datamodels.jp/ns/decision/';

function isDecision(e: unknown): e is Entity {
  const x = e as Entity | undefined;
  return typeof x?.id === 'string' && x.id.startsWith('urn:ngsi-ld:Decision:') && (x.type === 'Decision' || x.type === `${DECISION_NS}Decision`)
    && !('deletedAt' in x);
}

/**
 * An attribute of a Decision entity: by its short name (a subscription with
 * the Decision context), or by its full IRI (without one).
 */
function decisionAttr(e: Entity, name: string): Record<string, unknown> | undefined {
  const term = DECISION_TERMS[name];
  const iri = (typeof term === 'string' ? term : term?.['@id'])?.replace(/^decision:/, DECISION_NS).replace(/^prov:/, 'http://www.w3.org/ns/prov#');
  const a = e[name] ?? (iri ? e[iri] : undefined);
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : undefined;
}

/** A DateTime value as a string, from a string or {"@type": "DateTime", "@value": …}. */
function dateValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const inner = (v as { '@value'?: unknown } | null)?.['@value'];
  return typeof inner === 'string' ? inner : undefined;
}

/**
 * The corrections of a Decision entity as Pointsman's `correct`: question
 * name to value, the latest entry winning. A wrong shape gives a message.
 */
export function correctionsOf(attr: Record<string, unknown> | undefined): Record<string, unknown> | string {
  if (!attr) return {};
  const list = attr.json ?? attr.value;
  if (!Array.isArray(list)) return 'corrections: expected a list';
  const correct: Record<string, unknown> = {};
  for (const c of list) {
    const { name, value } = (c ?? {}) as { name?: unknown; value?: unknown };
    if (typeof name !== 'string' || !['boolean', 'string', 'number'].includes(typeof value)) return 'corrections: each needs a name and a value';
    correct[name] = value;
  }
  return correct;
}

/** The corrections this person has not sent as feedback yet (each answer on its own: they may have come one at a time). */
function notSentYet(correct: Record<string, unknown>, by: string, feedback: { by?: unknown; correct?: unknown }[]): Record<string, unknown> {
  const sent = (name: string, value: unknown) => feedback.some((f) => f.by === by && !!f.correct && typeof f.correct === 'object'
    && Object.hasOwn(f.correct, name) && (f.correct as Record<string, unknown>)[name] === value);
  return Object.fromEntries(Object.entries(correct).filter(([name, value]) => !sent(name, value)));
}

/**
 * A Decision entity a person resolved in the broker (`reviewStatus`
 * "resolved", `finalAction`, `reviewedBy`, optional `corrections`):
 * resolves the review in Pointsman (or sends the corrections as feedback for
 * an action Pointsman did not queue), then writes the final action to the
 * entity's result and completes its Task. Safe to repeat: a resolved review
 * and feedback already sent are not sent again.
 */
async function handleReview(decision: Entity, config: BridgeConfig): Promise<EntityResult> {
  const id = decision.id;
  if (valueOf(decisionAttr(decision, 'reviewStatus')) !== 'resolved') return { id, skipped: 'not resolved' };
  const finalAction = valueOf(decisionAttr(decision, 'finalAction'));
  const by = valueOf(decisionAttr(decision, 'reviewedBy'));
  if (typeof finalAction !== 'string' || finalAction === '' || typeof by !== 'string' || by.trim() === '') {
    return { id, error: 'a resolved Decision needs finalAction and reviewedBy', retry: false };
  }
  const correct = correctionsOf(decisionAttr(decision, 'corrections'));
  if (typeof correct === 'string') return { id, error: correct, retry: false };
  const reviewedAt = dateValue(valueOf(decisionAttr(decision, 'reviewedAt')));

  const fetchFn = config.fetch ?? fetch;
  const decisionId = id.slice('urn:ngsi-ld:Decision:'.length);
  const pointsman = (path: string, body?: unknown) => fetchFn(`${config.pointsman.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${config.pointsman.token}`, 'user-agent': USER_AGENT, ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const found = await pointsman(`/v1/decisions/${encodeURIComponent(decisionId)}`);
  if (!found.ok) return { id, error: `pointsman answered ${found.status}`, retry: retryable(found.status) };
  const record = (await found.json()) as { review?: { status?: string }; feedback?: { by?: unknown; correct?: unknown }[] };

  let review: ReviewOutcome;
  if (record.review?.status === 'pending') {
    const res = await pointsman(`/v1/reviews/${encodeURIComponent(decisionId)}/resolve`, { action: finalAction, correct, by });
    // 409: resolved in the meantime, for example from another app.
    if (!res.ok && res.status !== 409) return { id, error: `pointsman answered ${res.status}`, retry: retryable(res.status) };
    review = res.ok ? 'resolved' : 'already resolved';
  } else if (record.review) {
    review = 'already resolved';
  } else if (Object.keys(correct).length === 0) {
    review = 'nothing to send';
  } else if (Object.keys(notSentYet(correct, by, record.feedback ?? [])).length === 0) {
    review = 'feedback already sent';
  } else {
    const res = await pointsman(`/v1/decisions/${encodeURIComponent(decisionId)}/feedback`, { correct: notSentYet(correct, by, record.feedback ?? []), by });
    if (!res.ok) return { id, error: `pointsman answered ${res.status}`, retry: retryable(res.status) };
    review = 'feedback sent';
  }

  // The entity's result and its Task, when the entity still has this decision.
  const target = decisionAttr(decision, 'refersTo')?.object;
  const profile = valueOf(decisionAttr(decision, 'profile'));
  const route = config.routes.find((r) => r.profile === profile && r.decisionEntity);
  if (!route || typeof target !== 'string') return { id, review, written: false };
  const headers = brokerHeaders(config, 'application/json');
  delete headers['content-type'];
  headers.accept = 'application/json';
  if (config.broker.context) headers.link = `<${config.broker.context}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;
  const got = await fetchFn(`${config.broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(target)}?attrs=${encodeURIComponent(route.attribute)}`, { headers });
  if (got.status === 404) return { id, review, written: false };
  if (!got.ok) return { id, error: `broker read failed: ${got.status}`, retry: retryable(got.status) };
  const result = ((await got.json()) as Entity)[route.attribute] as Record<string, unknown> | undefined;
  // A newer decision replaced this one: its result and Task are not this review's.
  if ((result?.decision as { object?: unknown } | undefined)?.object !== id) return { id, review, written: false };
  const when = reviewedAt ?? new Date().toISOString();
  const write = await writeAttribute(target, route.attribute, {
    ...result,
    finalAction: { type: 'Property', value: finalAction },
    reviewedAt: { type: 'Property', value: when },
  }, config);
  if (!write.ok) return { id, error: `broker write failed: ${write.status}`, retry: retryable(write.status) };
  const hash = valueOf(result?.inputHash);
  if (route.task && typeof hash === 'string') {
    const done = await brokerRequest('POST', await taskEntityId(target, route.attribute, hash), config, {
      '@context': [TASK_CONTEXT, CORE_CONTEXT],
      progress: { type: 'Property', value: 'completed' },
      statusLabel: { type: 'Property', value: finalAction },
      completedAt: { type: 'Property', value: { '@type': 'DateTime', '@value': when } },
    });
    // 404: no Task (an action without one, or made before Tasks).
    if (!updatedAll(done) && done.status !== 404) return { id, error: `broker refused the Task update: ${done.status}`, retry: retryable(done.status) };
  }
  return { id, review, written: true };
}

/** The published context of the Task model (datamodels.jp). */
export const TASK_CONTEXT = 'https://datamodels.jp/context/task/v1.jsonld';

/**
 * The Task's id: one per entity, route attribute and input values (the
 * `inputHash` of the result), so a retried notification finds the Task it
 * created. To find it from the entity: the result attribute's `inputHash`.
 * The Task points to the entity (refersTo), the result to its Decision.
 */
export async function taskEntityId(entityId: string, attribute: string, hash: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([entityId, attribute, hash])));
  return `urn:ngsi-ld:Task:${[...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A Task entity (datamodels.jp Task model) in normalized form: work for a
 * person about the entity, waiting to be done. The action is its status
 * label, the profile its kind. Whoever resolves the review sets `progress`
 * to completed; the bridge only cancels an open Task (cancelOpenTask).
 */
export function toTaskEntity(d: Decision, entity: Entity, options: TaskOptions, id: string, now = new Date()): Record<string, unknown> {
  const P = (value: unknown) => ({ type: 'Property', value });
  const label = options.name ? valueOf(entity[options.name]) : undefined;
  // Own keys only: an action named like an Object method is not a priority.
  const priority = options.priority && Object.hasOwn(options.priority, d.action) ? options.priority[d.action] : undefined;
  return {
    '@context': [TASK_CONTEXT, CORE_CONTEXT],
    id,
    type: 'Task',
    name: P(`[${d.action}] ${typeof label === 'string' && label.trim() !== '' ? label.trim() : entity.id}`),
    refersTo: { type: 'Relationship', object: entity.id },
    progress: P('needs-action'),
    statusLabel: P(d.action),
    subtype: P(d.profile),
    ...(priority !== undefined && { priority: P(priority) }),
    dateCreated: P({ '@type': 'DateTime', '@value': d.created_at ?? now.toISOString() }),
  };
}

/**
 * Creates the Task, or updates one with the same id in place: from a retry,
 * or from earlier input values that came back (A, B, A), where the old Task
 * may be done already and the work is new. In place, so a failure leaves the
 * old Task as it was; a retry finishes the update. Returns the failed
 * response, if any.
 */
async function putTask(task: Record<string, unknown>, config: BridgeConfig): Promise<Response | null> {
  const created = await createEntity(task, config);
  if (created.status !== 409) return created.ok ? null : created;
  const { id, type: _, ...attributes } = task;
  const updated = await brokerRequest('POST', id as string, config, attributes);
  if (!updatedAll(updated)) return updated;
  // What the new state does not have: the old completion, an old priority.
  for (const name of ['completedAt', ...(task.priority ? [] : ['priority'])]) {
    const removed = await brokerRequest('DELETE', id as string, config, undefined, name);
    if (!removed.ok && removed.status !== 404) return removed;
  }
  return null;
}

/**
 * When the decision needs no person, an open Task for the same input values
 * (from a retry or an earlier decision) is cancelled; a done one stays as it
 * is. Returns the failed response, if any.
 */
async function cancelOpenTask(id: string, action: string, config: BridgeConfig): Promise<Response | null> {
  const found = await brokerRequest('GET', id, config);
  if (found.status === 404) return null;
  if (!found.ok) return found;
  const progress = (await found.json() as { progress?: { value?: unknown } }).progress?.value;
  if (progress === 'completed' || progress === 'cancelled' || progress === 'failed') return null;
  const updated = await brokerRequest('POST', id, config, {
    '@context': [TASK_CONTEXT, CORE_CONTEXT],
    progress: { type: 'Property', value: 'cancelled' },
    statusLabel: { type: 'Property', value: action },
  });
  return updatedAll(updated) ? null : updated;
}

/** 2xx, but not 207: NGSI-LD answers an update with 207 when some attributes were not updated. */
const updatedAll = (res: Response) => res.ok && res.status !== 207;

/** GET an entity, DELETE it or one attribute, or POST attributes to it, with the Task context. */
function brokerRequest(method: 'GET' | 'DELETE' | 'POST', id: string, config: BridgeConfig, body?: unknown, attribute?: string): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  const path = method === 'POST' ? '/attrs' : attribute ? `/attrs/${encodeURIComponent(attribute)}` : '';
  const url = `${config.broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(id)}${path}`;
  const headers = brokerHeaders(config, 'application/ld+json');
  if (method !== 'POST') {
    delete headers['content-type'];
    headers.accept = 'application/json';
    headers.link = `<${TASK_CONTEXT}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;
  }
  return fetchFn(url, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

async function createEntity(entity: Record<string, unknown>, config: BridgeConfig): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  const { broker } = config;
  // The context is in the body, so no Link header.
  const headers = brokerHeaders(config, 'application/ld+json');
  return fetchFn(`${broker.url}/ngsi-ld/v1/entities`, { method: 'POST', headers, body: JSON.stringify(entity) });
}
