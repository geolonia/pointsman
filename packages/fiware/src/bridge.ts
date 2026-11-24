// FIWARE bridge: NGSI-LD notification -> Pointsman -> result back on the
// entity. See bridge/README.md for the setup, and docs/spikes/fiware-bridge.md
// (#14, #41) for why it works this way. The connector role of the module
// @pointsman/fiware (docs/connectors.md); it runs inside the engine Worker or
// in its own (bridge/).
//
// This file takes the requests and queue messages and exports the bridge's
// public surface; the rest is in the files beside it: routes.ts, types.ts,
// shared.ts, send.ts, broker.ts, decide.ts, decision-entity.ts, tasks.ts,
// reviews.ts and work-orders.ts.
//
// No package imports, only those files: other Workers (for example the demo)
// build this file from an engine checkout without installing its packages.
// Their tsconfig needs allowImportingTsExtensions for the `.ts` imports.

import { readEntity } from './broker.ts';
import { handleEntity } from './decide.ts';
import { DECISION_CONTEXT } from './decision-entity.ts';
import { handleReview, isDecision } from './reviews.ts';
import { failure, retryable } from './send.ts';
import { type Entity, TASK_CONTEXT } from './shared.ts';
import type { BridgeConfig, BridgeMessage, EntityResult } from './types.ts';
import { handleWorkOrder, isTask } from './work-orders.ts';

export type { Requirement, Route, TaskOptions } from './routes.ts';
export { parseRoutes } from './routes.ts';
export type { BridgeConfig, BridgeMessage, BridgeQueue, EntityResult, ReviewOutcome } from './types.ts';
export { BROKER_TIMEOUT_MS, POINTSMAN_TIMEOUT_MS, Redirected, Unsupported, USER_AGENT } from './send.ts';
export { clashingAnswer, decisionsOf, idempotencyKey, inputHash, toProperty } from './decide.ts';
export { DECISION_CONTEXT, DECISION_TERMS, decisionEntityId, informedByOf, isChecked, isPending, resolvedOf, toDecisionEntity } from './decision-entity.ts';
export { TASK_CONTEXT } from './shared.ts';
export { taskEntityId, toTaskEntity } from './tasks.ts';
export { correctionsOf } from './reviews.ts';
export { parseWorkOrders } from './work-orders.ts';

async function sameSecret(a: string, b: string): Promise<boolean> {
  // Compare hashes, so the comparison takes the same time for any input length.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  // Every byte is compared, without an early return. Not timingSafeEqual: it
  // is Cloudflare's, and the bridge also runs elsewhere (docs/adapters.md).
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
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

  const path = url.pathname as BridgeMessage['path'];
  // ?route=<name> selects a named route; without it, the type's unnamed route.
  const route = url.searchParams.get('route') ?? undefined;
  // A name no route has (a typo in a subscription) would handle nothing, silently.
  if (path === '/notify' && route !== undefined && !config.routes.some((r) => r.name === route)) {
    console.error(`bridge: /notify?route=${JSON.stringify(route).slice(1, -1).slice(0, 100)} names no configured route`);
    return Response.json({ error: 'unknown route: no configured route has this name' }, { status: 404 });
  }
  const messages = (data as Entity[]).filter((entity) => forBridge(path, route, entity, config))
    .map((entity): BridgeMessage => ({ path, ...(route !== undefined && { route }), entity: config.queue ? queuedRef(entity) : entity }));

  if (config.queue) {
    // Queued: answered at once, so the broker never sees a failure of
    // Pointsman or the bridge, and never pauses the subscription (#88).
    // A message holds only the entity's id and type: the consumer reads the
    // entity as it is now anyway, so no copy of its attributes waits in the
    // queue (or the dead-letter queue) after the entity changed or was
    // deleted, and every message fits the queue's size limit.
    const sized = messages.map((body) => ({ body, bytes: messageBytes(body) }));
    try {
      for (const batch of queueBatches(sized)) await config.queue.sendBatch(batch.map((m) => ({ body: m.body })));
    } catch (err) {
      // Not queued: the broker may send it again.
      console.error(`bridge queue: ${err instanceof Error ? err.message : String(err)}`);
      return Response.json({ error: 'could not queue the notification' }, { status: 502 });
    }
    return Response.json({ queued: sized.length }, { status: 202 });
  }

  const results: EntityResult[] = [];
  // One entity's failure must not stop the others in the notification.
  for (const message of messages) results.push(await handleMessage(message, config));
  // A failure that may pass on a second try: answer 502, so a broker that
  // retries notifications sends it again. Entities that succeeded are skipped
  // on the retry (input hash). Failures that will not pass (Pointsman refused
  // the input) are reported but do not ask for a retry.
  const retry = results.some((r) => 'retry' in r && r.retry);
  // A failure that will not pass is logged too, as the queue consumer does
  // (for example an input in keyValues form): the broker gets 200 for it.
  for (const r of results) if ('error' in r && !('retry' in r && r.retry)) console.error(`bridge: ${r.id}: ${r.error}`);
  return Response.json({ handled: results }, { status: retry ? 502 : 200 });
}

/**
 * Cloudflare Queues' limits: 100 messages and 256 KB per sendBatch. Kept a
 * little lower, for the queue's own envelope.
 */
const QUEUE_BATCH = 100;
const QUEUE_BATCH_BYTES = 250_000;

function messageBytes(message: BridgeMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

/** Splits messages into sendBatch calls within the count and size limits. */
export function queueBatches<T extends { bytes: number }>(messages: T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const m of messages) {
    if (batch.length > 0 && (batch.length === QUEUE_BATCH || bytes + m.bytes > QUEUE_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(m);
    bytes += m.bytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * What a queued message keeps of an entity: its id and type, and `deletedAt`
 * of a deletion notification (a time, so the consumer skips it without a
 * broker read). Never an attribute a person wrote.
 */
function queuedRef(entity: Entity): Entity {
  return { id: entity.id, type: entity.type, ...('deletedAt' in entity && { deletedAt: entity.deletedAt }) };
}

/** Whether the bridge handles this entity of a notification on this path. */
function forBridge(path: BridgeMessage['path'], routeName: string | undefined, entity: Entity, config: BridgeConfig): boolean {
  if (!entity || typeof entity !== 'object' || typeof entity.id !== 'string') return false;
  if (path === '/reviews') return isDecision(entity) || (Boolean(config.workOrders) && isTask(entity));
  return config.routes.some((r) => r.type === entity.type && r.name === routeName);
}

/**
 * Handles one entity of a notification. Never throws: a failure is a result
 * (retry true when a second try may pass).
 */
export async function handleMessage(message: BridgeMessage, config: BridgeConfig, { fresh = false } = {}): Promise<EntityResult> {
  const { entity } = message;
  try {
    if (message.path === '/reviews') {
      const decision = isDecision(entity);
      let current = entity;
      if (fresh) {
        // From the queue: the Decision or work order as it is now, read with
        // its own context so the names match what the handlers expect.
        const read = await readEntity(entity.id, config, decision ? DECISION_CONTEXT : TASK_CONTEXT);
        if (read === 'gone') return { id: entity.id, skipped: 'deleted' };
        if (read instanceof Response) return { id: entity.id, error: `broker read failed: ${read.status}`, retry: retryable(read.status) };
        current = read;
      }
      return decision ? await handleReview(current, config) : await handleWorkOrder(current, config.workOrders ?? {}, config);
    }
    const route = config.routes.find((r) => r.type === entity.type && r.name === message.route);
    if (!route) return { id: entity.id, skipped: 'no route' };
    // Deleting an entity also notifies (NGSI-LD 1.8: with deletedAt); there is
    // nothing left to decide about.
    if ('deletedAt' in entity) return { id: entity.id, skipped: 'deleted' };
    // One message at a time from the queue keeps two runs for one report
    // apart, so the newer decision is always written last (docs/decision-chains.md).
    if (route.requires && !fresh) return { id: entity.id, error: 'a route with requires runs only from the queue (BRIDGE_QUEUE)', retry: false };
    let current = entity;
    if (fresh) {
      // From the queue: the entity as it is now, not as it was notified. A
      // message delivered twice then finds the result it already wrote (input
      // hash), and a change made since is decided on its latest values.
      const read = await readEntity(entity.id, config);
      if (read === 'gone') return { id: entity.id, skipped: 'deleted' };
      if (read instanceof Response) return { id: entity.id, error: `broker read failed: ${read.status}`, retry: retryable(read.status) };
      current = read;
    }
    return await handleEntity(current, route, config);
  } catch (err) {
    return failure(entity.id, err);
  }
}

/** What the bridge needs of a Cloudflare Queues message. */
export interface QueuedMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/**
 * The queue consumer (#88): runs the bridge for each message. A failure
 * that may pass is retried with a growing delay (30 s, 1, 2, 4 ... minutes,
 * at most an hour); the consumer's max_retries decides when a message goes
 * to the dead-letter queue. Everything else is acknowledged.
 */
export async function handleQueueBatch(batch: { messages: readonly QueuedMessage[] }, config: BridgeConfig): Promise<void> {
  // The consumer handles messages itself: never queue them again.
  const direct: BridgeConfig = { ...config };
  delete direct.queue;
  for (const message of batch.messages) {
    const body = message.body as BridgeMessage;
    if (!body || (body.path !== '/notify' && body.path !== '/reviews') || !body.entity || typeof body.entity.id !== 'string') {
      console.error('bridge queue: a message without a notified entity; dropped');
      message.ack();
      continue;
    }
    const result = await handleMessage(body, direct, { fresh: true });
    const decision = 'decision' in result && result.decision ? ` (decision ${result.decision})` : '';
    if ('deadLetter' in result && result.deadLetter && config.deadLetter) {
      // No retry can pass: straight to the dead-letter queue, to be fixed and replayed.
      console.error(`bridge queue: ${result.id}${decision}: ${result.error}; sent to the dead-letter queue`);
      try {
        await config.deadLetter.sendBatch([{ body }]);
        message.ack();
      } catch (err) {
        console.error(`bridge dead-letter queue: ${err instanceof Error ? err.message : String(err)}`);
        message.retry({ delaySeconds: retryDelay(message.attempts) });
      }
      continue;
    }
    // A redirect too: a wrong URL, fixed in the configuration. Retried, the
    // message ends in the dead-letter queue and can be replayed then.
    if ('retry' in result && (result.retry || result.redirect || result.deadLetter)) {
      console.error(`bridge queue: ${result.id}${decision} (attempt ${message.attempts}): ${result.error}`);
      message.retry({ delaySeconds: retryDelay(message.attempts) });
    } else {
      if ('error' in result) console.error(`bridge queue: ${result.id}${decision}: ${result.error}`);
      message.ack();
    }
  }
}

/** Seconds before the next try: 30 s after the first, doubling, at most an hour. */
export function retryDelay(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);
}
