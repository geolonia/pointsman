// The module @pointsman/fiware: its definition and its connector, the FIWARE
// bridge (bridge.ts). Settings: bridge/README.md. Inside the engine Worker it
// serves /connectors/fiware/notify and /connectors/fiware/reviews.

import { ConfigError, type Connector, type ConnectorEntry, type ConnectorRuntime, type Placement } from '@pointsman/module-api';
import { type BridgeMessage, type QueuedMessage, handleQueueBatch, handleRequest } from './bridge.ts';
import { configFrom, type Env } from './config.ts';
import { definition } from './definition.ts';

export const fiwareModule: ConnectorEntry = {
  name: definition.name,
  version: definition.version,
  connector: definition.connector!,
  connect(env, runtime: ConnectorRuntime, placement: Placement): Connector | undefined {
    const e = env as Env;
    // Off when none of its settings is set.
    if (definition.connector!.settings.every((name) => env[name] === undefined || env[name] === '')) return undefined;
    let config;
    try {
      config = configFrom(e, placement === 'engine' ? runtime.engine : undefined);
    } catch (err) {
      throw new ConfigError(`FIWARE bridge: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      fetch: (request) => handleRequest(request, config),
      queue: (batch) => handleQueueBatch(batch as { messages: readonly QueuedMessage[] }, config),
    };
  },
};

export type { BridgeMessage };
export * from './bridge.ts';
export { configFrom, type Env } from './config.ts';
export { definition } from './definition.ts';

export default fiwareModule;
