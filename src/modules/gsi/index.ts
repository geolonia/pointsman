// The module @pointsman/facts-gsi: its definition and its provider.
// Setting: FACTS_MODE "gsi" (GSI data), "mock" (fixed answers), "off" or unset.

import { ConfigError, mockProvider, type FactModuleEntry, type FactProvider } from '../api';
import { inside, nearest } from '../capabilities';
import { GsiFactProvider } from '../../facts-gsi';
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

export default gsiModule;
