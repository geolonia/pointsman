// The module @pointsman/facts-gsi: its definition and its provider.
// Setting: FACTS_MODE "gsi" (GSI data), "mock" (fixed answers), "off" or unset.

import { ConfigError, inside, mockProvider, nearest, type FactModuleEntry, type FactProvider } from '@pointsman/module-api';
import { GsiFactProvider } from './provider';
import { definition } from './definition';

const mock = mockProvider([inside, nearest]);
// One per isolate, so its memory cache of tiles is shared between requests.
let gsi: GsiFactProvider | undefined;

export const gsiModule: FactModuleEntry = {
  ...definition,
  create(env, runtime): FactProvider | undefined {
    switch (env.FACTS_MODE ?? 'off') {
      case 'off':
      case '':
        return undefined;
      case 'mock':
        return mock;
      case 'gsi':
        return (gsi ??= new GsiFactProvider({ cache: runtime.cache }));
      default:
        throw new ConfigError('FACTS_MODE must be "off", "mock" or "gsi"');
    }
  },
};

// The provider's parts, for tests and other modules.
export * from './provider';
export * from './definition';

export default gsiModule;
