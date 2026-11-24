// One decision for one entity (bridge.ts): the loop guard (input hash), the
// decide request to Pointsman, and writing the result, with its Decision and
// Task entities, back to the broker.

import { createEntity, updatedAll, writeAttribute } from './broker.ts';
import { decisionEntityId, informedByOf, isChecked, isPending, policyRule, resolveDecisionEntity, resolvedOf, reviewFields, supersedeDecisionEntity, toDecisionEntity } from './decision-entity.ts';
import type { Requirement, Route } from './routes.ts';
import { failure, retryable, send, Unsupported, USER_AGENT } from './send.ts';
import { type Entity, P, sha256Hex, valueOf } from './shared.ts';
import { cancelOpenTask, completedTask, putTask, taskEntityId, toTaskEntity } from './tasks.ts';
import type { BridgeConfig, Decision, EntityResult } from './types.ts';

/**
 * Hash of the input attributes' values. Stored with the result; a
 * notification whose inputs have this hash already has its decision. This is
 * the loop guard: some brokers notify on the bridge's own write even when the
 * subscription watches other attributes (#41).
 */
export async function inputHash(entity: Entity, inputs: string[], requires?: Record<string, Requirement>): Promise<string> {
  const values = inputs.map((name) => {
    const value = inputValue(entity[name], name);
    const req = Object.values(requires ?? {}).find((r) => r.attribute === name);
    if (!req) return value;
    // An earlier decision: its id, so that a new decision with the same
    // action runs the route again; with rerunOnReview also a person's answer.
    const sub = (key: string) => valueOf((entity[name] as Record<string, unknown> | undefined)?.[key]) ?? null;
    return [value, sub('decisionId'), ...(req.rerunOnReview ? [sub('finalAction'), sub('reviewedAt')] : [])];
  });
  return sha256Hex(JSON.stringify(values));
}

/**
 * An input's value for the hash: an attribute's value, or, for an attribute
 * with several instances (an array, NGSI-LD datasetId), every instance's
 * value sorted by datasetId, so a change in any of them changes the hash. A
 * value that is not a normalized attribute (a keyValues notification) is
 * refused: it would hash the same for every value.
 */
function inputValue(attribute: unknown, name: string): unknown {
  if (attribute === undefined || attribute === null) return null;
  // A normalized attribute is an object with a type (Property, GeoProperty,
  // Relationship, …); a keyValues value is not, also when it is an object
  // (a GeoJSON geometry).
  const normalized = (a: unknown): a is Record<string, unknown> =>
    Boolean(a) && typeof a === 'object' && !Array.isArray(a) && typeof (a as Record<string, unknown>).type === 'string'
    && ['Property', 'Relationship', 'GeoProperty', 'LanguageProperty', 'VocabProperty', 'JsonProperty', 'ListProperty', 'ListRelationship'].includes((a as Record<string, unknown>).type as string);
  const refused = new Unsupported(`input ${name}: not a normalized NGSI-LD attribute (the bridge needs normalized notifications, not keyValues)`);
  if (Array.isArray(attribute)) {
    // No instance left is no input, as when the attribute is not there.
    if (attribute.length === 0) return null;
    const instances = attribute.map((a) => {
      if (!normalized(a)) throw refused;
      return [typeof a.datasetId === 'string' ? a.datasetId : '', valueOf(a) ?? null] as const;
    });
    return instances.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (!normalized(attribute)) throw refused;
  return valueOf(attribute) ?? null;
}

/** The earlier decisions' ids from their result attributes; null when a required one is not there yet. */
export function decisionsOf(entity: Entity, requires: Record<string, Requirement>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, r] of Object.entries(requires)) {
    const id = valueOf((entity[r.attribute] as Record<string, unknown> | undefined)?.decisionId);
    if (typeof id === 'string' && id !== '') out[name] = id;
    else if (!r.optional) return null;
  }
  return out;
}

/**
 * The Idempotency-Key for a decide request: the route, the entity and the
 * exact request body. A retry of the same request (also after a failure once
 * Pointsman has logged the decision) gets the logged decision; when anything
 * in the entity changed since (inputs that came back, a review written on an
 * earlier result), it is another request with another key, and a new decision.
 */
export async function idempotencyKey(route: Route, entityId: string, body: unknown): Promise<string> {
  // Keys sorted, so the same entity read twice in another attribute order is the same request.
  return `bridge-${await sha256Hex(canonicalJson([route.name ?? route.type, route.profile, entityId, body]))}`;
}

/** JSON with object keys sorted, at every level. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The error code of a Pointsman error answer (never the message: it may name input). */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const code = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

export async function handleEntity(entity: Entity, route: Route, config: BridgeConfig): Promise<EntityResult> {
  const hash = await inputHash(entity, route.inputs, route.requires);
  const previous = entity[route.attribute] as Record<string, { value?: unknown } | undefined> & { observedAt?: unknown } | undefined;
  if (previous?.inputHash?.value === hash) return { id: entity.id, skipped: 'inputs unchanged' };
  const decisions = route.requires ? decisionsOf(entity, route.requires) : undefined;
  if (decisions === null) return { id: entity.id, skipped: 'waiting for decisions' };

  const request = { state: entity, ref: entity.id, ...(decisions && Object.keys(decisions).length > 0 && { decisions }) };
  const body = JSON.stringify(request);
  const res = await send(config, 'pointsman', `${config.pointsman.url}/v1/decide/${encodeURIComponent(route.profile)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.pointsman.token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT,
      'idempotency-key': await idempotencyKey(route, entity.id, request),
    },
    body,
  });
  if (!res.ok) {
    const code = res.status === 409 ? await errorCode(res) : undefined;
    // A person resolved the final decision this one would replace: their answer
    // stays. Nothing is written, so a later change of an input asks again and
    // gets the same answer (one call per notification, no loop).
    if (code === 'resolved_by_person') return { id: entity.id, skipped: 'resolved by person' };
    if (code === 'idempotency_conflict') {
      return { id: entity.id, error: 'pointsman answered 409 idempotency_conflict: the same key was used for another request', retry: false, deadLetter: true };
    }
    // Only the status: the body may echo the input.
    return { id: entity.id, error: `pointsman answered ${res.status}`, retry: retryable(res.status) };
  }
  const d = (await res.json()) as Decision;
  if (!d || typeof d.action !== 'string' || typeof d.decision_id !== 'string' || !d.answers || typeof d.answers !== 'object') {
    return { id: entity.id, error: 'unexpected answer from pointsman', retry: true };
  }

  // An answer named like a field of the result would overwrite it (an
  // inputHash: decided again on each write). Nothing is written; a retry
  // cannot pass (the same request gets the same logged decision), the
  // profile needs another question name, and the entity's next change is
  // decided again.
  const clash = clashingAnswer(Object.keys(d.answers));
  if (clash !== undefined) return { id: entity.id, decision: d.decision_id, error: answerClash(clash), retry: false };
  // A retry of a decision that a newer one replaced while its first write failed: the newer one stands.
  if (d.review?.status === 'superseded') return { id: entity.id, skipped: 'superseded' };

  // From here on a decision exists: a failure keeps its id (a redirect
  // throws, see send).
  try {
    // A newer decision is already on the entity (NGSI-LD has no conditional
    // update; the queue runs one message at a time, this is the second
    // guard). Checked before anything is written for this one.
    if (route.requires && isOlder(d.created_at, previous?.observedAt)) {
      return { id: entity.id, action: d.action, decision: d.decision_id, write: 0 };
    }
    // One time for the entity and the property, when Pointsman gives none (older versions).
    const decidedAt = new Date();
    // The Decision entity first: the property on the entity points to it, and
    // without it a retry decides again (no input hash written yet).
    let decisionRef: string | undefined;
    if (route.decisionEntity) {
      const created = await createEntity(toDecisionEntity(d, entity.id, route, decidedAt, route.requires ? undefined : informedByOf(entity, route)), config);
      // 409: a retry of a notification whose entity was created, then the write failed.
      if (!created.ok && created.status !== 409) {
        return { id: entity.id, decision: d.decision_id, error: `broker refused the Decision entity: ${created.status}`, retry: retryable(created.status) };
      }
      // A person resolved it since that first try: the existing entity still says pending.
      if (created.status === 409 && resolvedOf(d)) {
        const failed = await resolveDecisionEntity(decisionEntityId(d.decision_id), d, config);
        if (failed) {
          return { id: entity.id, decision: d.decision_id, error: `broker refused the Decision update: ${failed.status}`, retry: retryable(failed.status) };
        }
      }
      decisionRef = decisionEntityId(d.decision_id);
      // The replaced decision's check is no longer needed (Pointsman closed its review).
      if (d.replaces) {
        const failed = await supersedeDecisionEntity(decisionEntityId(d.replaces), config);
        if (failed) {
          return { id: entity.id, decision: d.decision_id, error: `broker refused the Decision update: ${failed.status}`, retry: retryable(failed.status) };
        }
      }
    }
    // Also before the property, for the same reason. Its id comes from the
    // inputs, not the decision (a retry decides again, with a new decision id),
    // and the Task always follows the latest decision for these inputs.
    if (route.task) {
      const taskId = await taskEntityId(entity.id, route.attribute, hash);
      // A pending review always gets a Task, even for an action not in task.actions;
      // a resolved one (a retry after a person answered) gets it completed with their action.
      const done = resolvedOf(d);
      let failed = done
        ? await putTask(completedTask(toTaskEntity(d, entity, route.task, taskId, decidedAt), done, decidedAt), config)
        : route.task.actions.includes(d.action) || isPending(d)
          ? await putTask(toTaskEntity(d, entity, route.task, taskId, decidedAt), config)
          : await cancelOpenTask(taskId, d.action, config);
      // A replaced decision's open Task (made for the earlier inputs) is not needed any more.
      const earlier = valueOf(previous?.inputHash);
      if (!failed && route.requires && d.replaces && typeof earlier === 'string' && earlier !== hash) {
        failed = await cancelOpenTask(await taskEntityId(entity.id, route.attribute, earlier), 'superseded', config);
      }
      if (failed) {
        return { id: entity.id, decision: d.decision_id, error: `broker refused the Task entity: ${failed.status}`, retry: retryable(failed.status) };
      }
    }

    const property = toProperty(d, hash, decidedAt, decisionRef, isChecked(d, route));
    const write = await writeAttribute(entity.id, route.attribute, property, config);
    // Without a successful write the input hash is not stored either, so the
    // next notification decides again: report it as a failure. A 207 from the
    // first write (POST …/attrs) means the attribute was not appended.
    if (!updatedAll(write)) {
      return { id: entity.id, decision: d.decision_id, error: `broker write failed: ${write.status}`, retry: retryable(write.status) };
    }
    return { id: entity.id, action: d.action, decision: d.decision_id, write: write.status };
  } catch (err) {
    return failure(entity.id, err, d.decision_id);
  }
}

/** Whether `time` is before `than`, as points in time (any zone, any precision); false when either is unknown. */
function isOlder(time: unknown, than: unknown): boolean {
  const a = typeof time === 'string' ? Date.parse(time) : NaN;
  const b = typeof than === 'string' ? Date.parse(than) : NaN;
  return !Number.isNaN(a) && !Number.isNaN(b) && a < b;
}

const answerClash = (name: string) => `answer "${name}": its name or "${name}Probability" is taken by a field of the result or another answer; rename the question in the profile`;

/**
 * The names the result Property uses itself: the bridge's fields (also those
 * a review writes) and NGSI-LD's. An answer is a sub-property of the same
 * name, so it must not have one of these names.
 */
const RESULT_FIELDS = new Set([
  'type', 'value', 'observedAt', 'decisionId', 'decision', 'profile', 'profileVersion', 'policyRule', 'model', 'inputHash',
  'reviewStatus', 'finalAction', 'reviewedAt',
  'id', 'object', 'datasetId', 'unitCode', 'createdAt', 'modifiedAt', 'deletedAt', 'instanceId',
]);

/** The first answer whose name, or `<name>Probability`, is a field of the result or another answer's; undefined when none. */
export function clashingAnswer(names: string[]): string | undefined {
  const taken = new Set(RESULT_FIELDS);
  for (const name of names) {
    for (const key of [name, `${name}Probability`]) {
      if (taken.has(key)) return name;
      taken.add(key);
    }
  }
  return undefined;
}

/**
 * The result as one Property: the action as its value, the evidence as
 * sub-properties, so a consumer that only needs the action reads
 * `<attribute>.value` and can filter on it. An answer named like a field of
 * the result is an error (see clashingAnswer).
 */
export function toProperty(d: Decision, hash: string, now = new Date(), decisionRef?: string, checked = false): Record<string, unknown> {
  const clash = clashingAnswer(Object.keys(d.answers));
  if (clash !== undefined) throw new Error(answerClash(clash));
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
    // A person checks it first: work orders (#85) look for this. Resolved on a retry after they answered.
    ...(checked && reviewFields(d, 'result')),
  };
  for (const [name, a] of Object.entries(d.answers)) {
    // One level of sub-properties: Orion-LD drops a third level (#14).
    property[name] = P(a.value);
    property[`${name}Probability`] = P(a.p);
  }
  return property;
}
