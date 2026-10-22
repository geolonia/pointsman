// The bridge's settings (bridge/README.md), the same inside the engine Worker
// and in its own: only POINTSMAN_URL differs. In its own Worker the bridge
// calls Pointsman at POINTSMAN_URL; inside the engine Worker it calls the
// engine in process and POINTSMAN_URL is not used.

import type { EngineApi } from '@pointsman/module-api';
import type { BridgeConfig, BridgeQueue } from './bridge.ts';
import { parseRoutes, parseWorkOrders } from './bridge.ts';
export { SETTINGS } from './settings.ts';

export interface Env {
  /** JSON list of routes, see bridge/README.md. */
  BRIDGE_ROUTES?: string | undefined;
  /** Optional JSON object: work-order status label to final action, see bridge/README.md. */
  BRIDGE_WORK_ORDERS?: string | undefined;
  /** In its own Worker only. */
  POINTSMAN_URL?: string | undefined;
  BROKER_URL?: string | undefined;
  BROKER_TENANT?: string | undefined;
  BROKER_CONTEXT?: string | undefined;
  /** Secrets */
  NOTIFY_SECRET?: string | undefined;
  POINTSMAN_TOKEN?: string | undefined;
  BROKER_TOKEN?: string | undefined;
  BROKER_API_KEY?: string | undefined;
  /** Optional queue (producer and consumer), see bridge/README.md "Reliable delivery". */
  BRIDGE_QUEUE?: BridgeQueue | undefined;
  /** Optional producer for the dead-letter queue, see bridge/README.md "Reliable delivery". */
  BRIDGE_DEAD_LETTER?: BridgeQueue | undefined;
}


const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Reads the configuration; throws naming the first missing or invalid
 * setting. `engine`: inside the engine Worker, the engine in process
 * (docs/connectors.md); without it, Pointsman is at POINTSMAN_URL.
 */
export function configFrom(env: Env, engine?: EngineApi): BridgeConfig {
  const inEngine = engine !== undefined;
  if (inEngine && env.POINTSMAN_URL) throw new Error('POINTSMAN_URL is not used inside the engine Worker: leave it out');
  const needed = ['BRIDGE_ROUTES', 'BROKER_URL', 'NOTIFY_SECRET', 'POINTSMAN_TOKEN'] as const;
  for (const name of inEngine ? needed : ['BRIDGE_ROUTES', 'POINTSMAN_URL', ...needed.slice(1)] as const) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  for (const name of inEngine ? ['BROKER_URL'] as const : ['POINTSMAN_URL', 'BROKER_URL'] as const) {
    const u = URL.parse(env[name]!);
    if (!u || (u.protocol !== 'https:' && !LOOPBACK.includes(u.hostname))) {
      throw new Error(`${name} must be an https URL (http only for localhost)`);
    }
  }
  // GeonicDB prefers the Bearer token when both are sent; refuse instead of guessing.
  if (env.BROKER_TOKEN && env.BROKER_API_KEY) throw new Error('set BROKER_TOKEN or BROKER_API_KEY, not both');
  const trim = (u: string) => u.replace(/\/+$/, '');
  const routes = parseRoutes(env.BRIDGE_ROUTES!);
  // Decision chains run one message at a time from the queue (docs/decision-chains.md).
  const chained = routes.find((r) => r.requires);
  if (chained && !env.BRIDGE_QUEUE) throw new Error(`route ${chained.name ?? chained.type} has requires: set up BRIDGE_QUEUE`);
  return {
    routes,
    ...(env.BRIDGE_QUEUE && { queue: env.BRIDGE_QUEUE }),
    ...(env.BRIDGE_DEAD_LETTER && { deadLetter: env.BRIDGE_DEAD_LETTER }),
    ...(env.BRIDGE_WORK_ORDERS && { workOrders: parseWorkOrders(env.BRIDGE_WORK_ORDERS) }),
    notifySecret: env.NOTIFY_SECRET!,
    pointsman: inEngine
      ? { url: trim(engine.url), token: env.POINTSMAN_TOKEN!, fetch: (url, init) => engine.fetch(url, init) }
      : { url: trim(env.POINTSMAN_URL!), token: env.POINTSMAN_TOKEN! },
    broker: {
      url: trim(env.BROKER_URL!),
      ...(env.BROKER_TOKEN && { token: env.BROKER_TOKEN }),
      ...(env.BROKER_API_KEY && { apiKey: env.BROKER_API_KEY }),
      ...(env.BROKER_TENANT && { tenant: env.BROKER_TENANT }),
      ...(env.BROKER_CONTEXT && { context: env.BROKER_CONTEXT }),
    },
  };
}
