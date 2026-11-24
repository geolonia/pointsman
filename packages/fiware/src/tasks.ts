// The Task entities (datamodels.jp Task model) the FIWARE bridge writes for
// a person's work (bridge.ts): their id, content, and creating, completing
// or cancelling one.

import { brokerRequest, createEntity, updatedAll } from './broker.ts';
import type { TaskOptions } from './routes.ts';
import { CORE_CONTEXT, type Entity, P, sha256Hex, TASK_CONTEXT, valueOf } from './shared.ts';
import type { BridgeConfig, Decision } from './types.ts';

/** The id form of the bridge's own Tasks (taskEntityId). */
export const OWN_TASK = /^urn:ngsi-ld:Task:[0-9a-f]{32}$/;

/**
 * The Task's id: one per entity, route attribute and input values (the
 * `inputHash` of the result), so a retried notification finds the Task it
 * created. To find it from the entity: the result attribute's `inputHash`.
 * The Task points to the entity (refersTo), the result to its Decision.
 */
export async function taskEntityId(entityId: string, attribute: string, hash: string): Promise<string> {
  // OWN_TASK recognises this form; other apps' Tasks must not use it.
  // The first 16 bytes (32 hex digits).
  return `urn:ngsi-ld:Task:${(await sha256Hex(JSON.stringify([entityId, attribute, hash]))).slice(0, 32)}`;
}

/**
 * A Task entity (datamodels.jp Task model) in normalized form: work for a
 * person about the entity, waiting to be done. The action is its status
 * label, the profile its kind. Whoever resolves the review sets `progress`
 * to completed; the bridge only cancels an open Task (cancelOpenTask).
 */
export function toTaskEntity(d: Decision, entity: Entity, options: TaskOptions, id: string, now = new Date()): Record<string, unknown> {
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

/** A Task for a decision a person has resolved already: completed, with their action, as handleReview completes one. */
export function completedTask(task: Record<string, unknown>, done: { action: string; at?: string }, now: Date): Record<string, unknown> {
  return {
    ...task,
    progress: P('completed'),
    statusLabel: P(done.action),
    completedAt: P({ '@type': 'DateTime', '@value': done.at ?? now.toISOString() }),
  };
}

/**
 * Creates the Task, or updates one with the same id in place: from a retry,
 * or from earlier input values that came back (A, B, A), where the old Task
 * may be done already and the work is new. In place, so a failure leaves the
 * old Task as it was; a retry finishes the update. Returns the failed
 * response, if any.
 */
export async function putTask(task: Record<string, unknown>, config: BridgeConfig): Promise<Response | null> {
  const created = await createEntity(task, config);
  if (created.status !== 409) return created.ok ? null : created;
  const { id, type: _, ...attributes } = task;
  const updated = await brokerRequest('POST', id as string, config, attributes);
  if (!updatedAll(updated)) return updated;
  // What the new state does not have: the old completion, an old priority.
  for (const name of [...(task.completedAt ? [] : ['completedAt']), ...(task.priority ? [] : ['priority'])]) {
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
export async function cancelOpenTask(id: string, action: string, config: BridgeConfig): Promise<Response | null> {
  const found = await brokerRequest('GET', id, config);
  if (found.status === 404) return null;
  if (!found.ok) return found;
  const progress = (await found.json() as { progress?: { value?: unknown } }).progress?.value;
  if (progress === 'completed' || progress === 'cancelled' || progress === 'failed') return null;
  const updated = await brokerRequest('POST', id, config, {
    '@context': [TASK_CONTEXT, CORE_CONTEXT],
    progress: P('cancelled'),
    statusLabel: P(action),
  });
  return updatedAll(updated) ? null : updated;
}
