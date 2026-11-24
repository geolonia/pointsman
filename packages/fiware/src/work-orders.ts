// Work orders from other apps (#85): a completed Task that refers to an
// entity resolves the entity's pending decision through its Decision entity
// (BridgeConfig.workOrders; bridge.ts).

import { brokerRequest, readHeaders, updatedAll } from './broker.ts';
import { DECISION_CONTEXT } from './decision-entity.ts';
import { dateValue, handleReview, isDateTime } from './reviews.ts';
import { retryable, send } from './send.ts';
import { CORE_CONTEXT, type Entity, P, valueOf } from './shared.ts';
import { OWN_TASK } from './tasks.ts';
import type { BridgeConfig, EntityResult } from './types.ts';

const TASK_NS = 'https://datamodels.jp/ns/task/';

export function isTask(e: unknown): e is Entity {
  const x = e as Entity | undefined;
  return typeof x?.id === 'string' && (x.type === 'Task' || x.type === `${TASK_NS}Task`) && !('deletedAt' in x);
}

/** Task terms whose IRI is not in the Task namespace (published Task context). */
const TASK_IRIS: Record<string, string> = {
  name: 'https://uri.etsi.org/ngsi-ld/name',
  dateCreated: 'https://smart-data-models.github.io/data-models/terms.jsonld#/definitions/dateCreated',
  dateModified: 'https://smart-data-models.github.io/data-models/terms.jsonld#/definitions/dateModified',
};

/** An attribute of a Task entity, by its short name or its full IRI. */
function taskAttr(e: Entity, name: string): Record<string, unknown> | undefined {
  const iri = TASK_IRIS[name] ?? `${TASK_NS}${name}`;
  const a = e[name] ?? e[iri];
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : undefined;
}

/**
 * Checks the work-order mapping (status label to final action), for example
 * from a Worker variable.
 */
export function parseWorkOrders(json: string): Record<string, string> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('bridge work orders: not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
    throw new Error('bridge work orders: expected an object of status label to final action');
  }
  for (const [label, action] of Object.entries(data)) {
    // As Pointsman takes it (src/feedback.ts ACTION): at most 63 characters.
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(action) || action === 'review') {
      throw new Error(`bridge work orders.${label}: expected a final action in lower case, at most 63 characters (not "review")`);
    }
  }
  return data as Record<string, string>;
}

/**
 * Who resolved it, as an account and not a person: for a Redmine GTT work
 * order (`urn:ngsi-ld:Issue:redmine:<instance>:<issue>`) `redmine:<instance>#<issue>`,
 * otherwise the Task's id. Undefined when longer than Pointsman takes (100).
 */
function workOrderBy(id: string): string | undefined {
  const gtt = /^urn:ngsi-ld:Issue:redmine:([^:]+):(\d+)$/.exec(id);
  const by = gtt ? `redmine:${gtt[1]}#${gtt[2]}` : id;
  return by.length <= 100 ? by : undefined;
}

/**
 * A work order another app completed (for example a Redmine GTT issue,
 * published as a `Task` that refers to the report): the pending decision on
 * the entity it refers to is resolved, by writing the result to the Decision
 * entity. The broker then notifies `/reviews` (see handleReview), which does
 * the rest. Safe to repeat: a decision already resolved is left alone.
 */
export async function handleWorkOrder(task: Entity, mapping: Record<string, string>, config: BridgeConfig): Promise<EntityResult> {
  const id = task.id;
  // The bridge's own Tasks (completed by the bridge itself, without
  // dateModified), whatever input values they were made for: by their id, first.
  if (OWN_TASK.test(id)) return { id, skipped: 'own task' };
  if (valueOf(taskAttr(task, 'progress')) !== 'completed') return { id, skipped: 'not completed' };
  const label = valueOf(taskAttr(task, 'statusLabel'));
  if (typeof label !== 'string' || !Object.hasOwn(mapping, label)) return { id, skipped: 'status not mapped' };
  const finalAction = mapping[label]!;
  const by = workOrderBy(id);
  if (by === undefined) return { id, error: 'the Task id is too long to name who resolved it (at most 100 characters)', retry: false };
  // The time the person closed it, from the app: never the bridge's clock.
  const modified = dateValue(valueOf(taskAttr(task, 'dateModified')));
  if (modified === undefined || !isDateTime(modified)) return { id, error: 'dateModified: expected a date and time (RFC 3339)', retry: false };
  const target = taskAttr(task, 'refersTo')?.object;
  if (typeof target !== 'string') return { id, skipped: 'nothing to resolve' };

  // The type's main route (the one without a name): a work order answers the
  // first decision on the entity. Later steps of a chain (named routes) are
  // follow-ups with their own review path, and a work order that names only
  // the entity could not tell them apart.
  const candidates = config.routes.filter((r) => r.decisionEntity && r.name === undefined);
  if (candidates.length === 0) return { id, skipped: 'nothing to resolve' };
  const headers = readHeaders(config, config.broker.context);
  const attrs = [...new Set(candidates.map((r) => r.attribute))].map(encodeURIComponent).join(',');
  const got = await send(config, 'broker', `${config.broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(target)}?attrs=${attrs}`, { headers });
  if (got.status === 404) return { id, skipped: 'nothing to resolve' };
  if (!got.ok) return { id, error: `broker read failed: ${got.status}`, retry: retryable(got.status) };
  const current = (await got.json()) as Entity;

  const waiting = candidates.filter((r) => {
    if (r.type !== current.type) return false;
    const result = current[r.attribute] as Record<string, unknown> | undefined;
    // reviewStatus on the result since decision chains; before, the route's
    // reviewActions or the action review.
    const checked = valueOf(result?.reviewStatus) === 'pending'
      || (r.reviewActions ? r.reviewActions.includes(valueOf(result) as string) : result?.reviewStatus === undefined && valueOf(result) === 'review');
    return typeof valueOf(result) === 'string' && checked
      && valueOf(result?.finalAction) === undefined
      && typeof (result?.decision as { object?: unknown } | undefined)?.object === 'string';
  });
  if (waiting.length === 0) return { id, skipped: 'nothing to resolve' };
  // The Task names only the entity: with two results waiting, it is not clear which one it answers.
  if (waiting.length > 1) {
    return { id, error: `more than one decision waits on ${target} (${waiting.map((r) => r.attribute).join(', ')}); a work order cannot tell which`, retry: false };
  }
  const pending = waiting[0]!;
  const decision = ((current[pending.attribute] as Record<string, unknown>).decision as { object: string }).object;

  // First writer wins: another work order (or app) may have resolved the
  // Decision since the entity's result was written. Read it, not the result.
  const seen = await brokerRequest('GET', decision, config, undefined, undefined, DECISION_CONTEXT);
  if (!seen.ok) return { id, error: `broker read failed: ${seen.status}`, retry: retryable(seen.status) };
  const known = await seen.json() as Entity;
  const resolved = valueOf(known.reviewStatus) === 'resolved';
  const ours = valueOf(known.finalAction) === finalAction && (known.reviewedBy === undefined || valueOf(known.reviewedBy) === by);
  if (resolved && known.finalAction !== undefined && !ours) return { id, skipped: 'already resolved' };

  const context = [DECISION_CONTEXT, CORE_CONTEXT];
  const review = { finalAction: P(finalAction), reviewedBy: P(by), reviewedAt: P({ '@type': 'DateTime', '@value': modified }) };
  if (resolved) {
    // Resolved by this work order (or left without finalAction by an earlier
    // bridge's write a 207 cut short), and the result still waits: the
    // /reviews step did not finish. reviewStatus does not change, so no
    // notification may come: fill in what is missing and run that step here.
    // It is safe to repeat, also on the next retry if it fails (#347).
    if (known.finalAction === undefined || known.reviewedBy === undefined || known.reviewedAt === undefined) {
      const res = await brokerRequest('POST', decision, config, { '@context': context, ...review });
      if (!updatedAll(res)) return { id, error: `broker refused the Decision update: ${res.status}`, retry: retryable(res.status) };
    }
    const done = await handleReview({ ...known, id: decision, type: 'Decision', reviewStatus: P('resolved'), ...review }, config);
    if ('error' in done) return { ...done, id };
    return { id, resolves: decision, finalAction };
  }

  // Two writes, reviewStatus last: the /reviews subscription watches it, and
  // a broker may not notify when a retry writes the same value again. So
  // "resolved" is stored only once the rest is, and its notification carries
  // a complete Decision (#347). A 207 on either leaves it pending for the retry.
  const res = await brokerRequest('POST', decision, config, { '@context': context, ...review });
  if (!updatedAll(res)) return { id, error: `broker refused the Decision update: ${res.status}`, retry: retryable(res.status) };
  const stored = await brokerRequest('POST', decision, config, { '@context': context, reviewStatus: P('resolved') });
  if (!updatedAll(stored)) return { id, error: `broker refused the Decision update: ${stored.status}`, retry: retryable(stored.status) };
  return { id, resolves: decision, finalAction };
}
