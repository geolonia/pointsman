// The FIWARE bridge's configuration, messages and results, and the decision
// Pointsman answers with (bridge.ts). Types only.

import type { Route } from './routes.ts';
import type { Entity } from './shared.ts';

export interface BridgeConfig {
  routes: Route[];
  /**
   * Work orders from other apps (#85): a completed `Task` that refers to an
   * entity resolves the entity's pending decision. Maps the Task's
   * `statusLabel` (for example a Redmine status name) to the final action.
   */
  workOrders?: Record<string, string>;
  /** Shared secret the subscription sends in `x-bridge-secret`. */
  notifySecret: string;
  pointsman: {
    url: string;
    token: string;
    /** Sends the requests to Pointsman; defaults to `fetch` below. Inside the engine Worker, a call in process (docs/connectors.md). */
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    /** How long a decision may take; POINTSMAN_TIMEOUT_MS when left out. */
    timeoutMs?: number;
  };
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
  /**
   * Optional queue (#88): notifications are put on it, one message per
   * entity, and answered at once; the Worker's queue consumer runs the
   * bridge (handleQueueBatch). Without it, each notification is handled
   * within the broker's request.
   */
  queue?: BridgeQueue;
  /**
   * Optional: the dead-letter queue as a producer. A message that cannot
   * pass on any retry (409 idempotency_conflict) goes there at once;
   * without it, it is retried until the consumer's max_retries move it there.
   */
  deadLetter?: BridgeQueue;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** For tests: one time limit for every call, instead of BROKER_TIMEOUT_MS and POINTSMAN_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** What the bridge needs of a Cloudflare Queue producer binding. */
export interface BridgeQueue {
  sendBatch(messages: { body: BridgeMessage }[]): Promise<unknown>;
}

/** One queued entity from a notification. */
export interface BridgeMessage {
  path: '/notify' | '/reviews';
  /** The named route (`?route=`), for `/notify`. */
  route?: string;
  /**
   * On the queue, only the entity's id and type, plus `deletedAt` for a
   * deletion (see queuedRef; the consumer reads the rest from the broker);
   * handled without a queue, the notified entity.
   */
  entity: Entity;
}

/** What happened to one entity of a notification. */
export type EntityResult =
  | { id: string; skipped: 'inputs unchanged' | 'deleted' | 'not resolved' | 'no route' | 'waiting for decisions' | 'resolved by person' | 'superseded' | WorkOrderSkip }
  | { id: string; resolves: string; finalAction: string }
  | { id: string; review: ReviewOutcome; written: boolean }
  | { id: string; action: string; decision: string; write: number }
  /**
   * retry: whether the broker should send the notification again. redirect:
   * the broker or Pointsman answered with a redirect (#97); the broker is
   * not asked to retry, but a queued message is, so it ends in the
   * dead-letter queue and can be replayed once the URL is fixed.
   */
  | { id: string; error: string; retry: boolean; decision?: string; redirect?: true; deadLetter?: true };

export interface Decision {
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
  /** For a profile with requires: what it read from each earlier decision ({decision: null} when hidden). */
  requires?: Record<string, { decision: string | null }>;
  /** The earlier decision of the same profile and entity that this one replaces. */
  replaces?: string;
  /**
   * Present when a person checks the decision (the profile's people_check).
   * Pending for a new decision; a repeated request (the same idempotency
   * key, a retry) gets it as it is now: resolved, with the person's action,
   * or superseded.
   */
  review?: { status: string; final_action?: string; resolved_at?: string };
}

/** What happened in Pointsman for a review resolved in the broker. */
export type ReviewOutcome = 'resolved' | 'already resolved' | 'feedback sent' | 'feedback already sent' | 'nothing to send';

export type WorkOrderSkip = 'not completed' | 'status not mapped' | 'nothing to resolve' | 'own task' | 'already resolved';
