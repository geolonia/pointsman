// FACTS_MODE, the setting the spatial fact modules share (facts-gsi,
// facts-valhalla): "gsi" for real data, "mock" for fixed answers, "off" or
// unset for none. Node-safe, like api.ts.

import { ConfigError } from './api.ts';

export type FactsMode = 'off' | 'mock' | 'gsi';

/** The deployment's FACTS_MODE; unset or empty is "off", anything not listed a ConfigError. */
export function factsMode(env: Record<string, unknown>): FactsMode {
  switch (env.FACTS_MODE ?? 'off') {
    case 'off':
    case '':
      return 'off';
    case 'mock':
      return 'mock';
    case 'gsi':
      return 'gsi';
    default:
      throw new ConfigError('FACTS_MODE must be "off", "mock" or "gsi"');
  }
}
