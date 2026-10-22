// The bridge as its own Worker: the connector of the module @pointsman/fiware
// (packages/fiware), placed next to Pointsman, which it calls at
// POINTSMAN_URL. It can also run inside the Pointsman Worker
// (docs/connectors.md). Another Worker (for example the demo, #48) can import
// handleRequest from ../../packages/fiware/src/bridge.ts and mount it instead.

import { type BridgeConfig, type BridgeMessage, handleQueueBatch, handleRequest } from '../../packages/fiware/src/bridge.ts';
import { configFrom as fiwareConfig, type Env as FiwareEnv } from '../../packages/fiware/src/config.ts';

export interface Env extends Omit<FiwareEnv, 'BRIDGE_QUEUE' | 'BRIDGE_DEAD_LETTER'> {
  /** Optional queue (producer and consumer), see bridge/README.md "Reliable delivery". */
  BRIDGE_QUEUE?: Queue<BridgeMessage>;
  /** Optional producer for the dead-letter queue, see bridge/README.md "Reliable delivery". */
  BRIDGE_DEAD_LETTER?: Queue<BridgeMessage>;
}

/** Reads the configuration; throws naming the first missing or invalid setting. */
export function configFrom(env: Env): BridgeConfig {
  return fiwareConfig(env);
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

  // The queue consumer: runs the bridge for what /notify and /reviews queued.
  async queue(batch: MessageBatch<BridgeMessage>, env: Env): Promise<void> {
    let config: BridgeConfig;
    try {
      config = configFrom(env);
    } catch (err) {
      // Nothing can be handled: retry the whole batch once the configuration is fixed.
      console.error(`bridge configuration: ${err instanceof Error ? err.message : String(err)}`);
      batch.retryAll({ delaySeconds: 300 });
      return;
    }
    await handleQueueBatch(batch, config);
  },
} satisfies ExportedHandler<Env, BridgeMessage>;
