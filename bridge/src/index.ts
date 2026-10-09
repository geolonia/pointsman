// The bridge as its own Worker. Another Worker (for example the demo, #48) can
// import handleRequest from ./bridge.ts and mount it instead.

import { type BridgeConfig, handleRequest, parseRoutes, parseWorkOrders } from './bridge';

export interface Env {
  /** JSON list of routes, see bridge/README.md. */
  BRIDGE_ROUTES: string;
  /** Optional JSON object: work-order status label to final action, see bridge/README.md. */
  BRIDGE_WORK_ORDERS?: string;
  POINTSMAN_URL: string;
  BROKER_URL: string;
  BROKER_TENANT?: string;
  BROKER_CONTEXT?: string;
  /** Secrets */
  NOTIFY_SECRET: string;
  POINTSMAN_TOKEN: string;
  BROKER_TOKEN?: string;
  BROKER_API_KEY?: string;
}

/** Reads the configuration; throws naming the first missing or invalid setting. */
export function configFrom(env: Env): BridgeConfig {
  for (const name of ['BRIDGE_ROUTES', 'POINTSMAN_URL', 'BROKER_URL', 'NOTIFY_SECRET', 'POINTSMAN_TOKEN'] as const) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  for (const name of ['POINTSMAN_URL', 'BROKER_URL'] as const) {
    const u = URL.parse(env[name]);
    if (!u || (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
      throw new Error(`${name} must be an https URL (http only for localhost)`);
    }
  }
  // GeonicDB prefers the Bearer token when both are sent; refuse instead of guessing.
  if (env.BROKER_TOKEN && env.BROKER_API_KEY) throw new Error('set BROKER_TOKEN or BROKER_API_KEY, not both');
  const trim = (u: string) => u.replace(/\/+$/, '');
  return {
    routes: parseRoutes(env.BRIDGE_ROUTES),
    ...(env.BRIDGE_WORK_ORDERS && { workOrders: parseWorkOrders(env.BRIDGE_WORK_ORDERS) }),
    notifySecret: env.NOTIFY_SECRET,
    pointsman: { url: trim(env.POINTSMAN_URL), token: env.POINTSMAN_TOKEN },
    broker: {
      url: trim(env.BROKER_URL),
      ...(env.BROKER_TOKEN && { token: env.BROKER_TOKEN }),
      ...(env.BROKER_API_KEY && { apiKey: env.BROKER_API_KEY }),
      ...(env.BROKER_TENANT && { tenant: env.BROKER_TENANT }),
      ...(env.BROKER_CONTEXT && { context: env.BROKER_CONTEXT }),
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let config: BridgeConfig;
    try {
      config = configFrom(env);
    } catch (err) {
      // A configuration error is the operator's to fix; the broker sees a 500.
      console.error(`bridge configuration: ${err instanceof Error ? err.message : String(err)}`);
      return Response.json({ error: 'bridge is not configured' }, { status: 500 });
    }
    return handleRequest(request, config);
  },
} satisfies ExportedHandler<Env>;
