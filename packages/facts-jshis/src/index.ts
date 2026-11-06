// The module @pointsman/facts-jshis: its definition and its provider.
// Setting: FACTS_MODE, as for GSI: "gsi" (real public data), "mock" (fixed
// answers), "off" or unset.

import { ConfigError, inside, mockProvider, type FactModuleEntry, type FactProvider } from '@pointsman/module-api';
import { JshisFactProvider } from './provider';
import { definition } from './definition';

const mock = mockProvider([inside]);
// One per isolate, so its memory cache of meshes is shared between requests.
let jshis: JshisFactProvider | undefined;

export const jshisModule: FactModuleEntry = {
  ...definition,
  create(env, runtime): FactProvider | undefined {
    switch (env.FACTS_MODE ?? 'off') {
      case 'off':
      case '':
        return undefined;
      case 'mock':
        return mock;
      case 'gsi':
        return (jshis ??= new JshisFactProvider({ cache: runtime.cache }));
      default:
        throw new ConfigError('FACTS_MODE must be "off", "mock" or "gsi"');
    }
  },
};

// The provider's parts, for tests and other modules.
export * from './provider';
export * from './definition';

export default jshisModule;
