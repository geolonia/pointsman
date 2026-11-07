// J-SHIS (地震ハザードステーション, NIED) for Japan: the definition of the
// module @pointsman/facts-jshis. It answers the capability inside for its own
// layers, one 250 m mesh per place. The provider is in provider.ts. Node-safe,
// like packages/module-api/src/api.ts.

import type { FactModule } from '@pointsman/module-api';

/** The layers; each answers inside. */
export const JSHIS_LAYERS = {
  'jshis-shaking-6lower-30y': 'inside',
  'jshis-shaking-6upper-30y': 'inside',
  'jshis-ground-amplification': 'inside',
  'jshis-landform': 'inside',
} as const;

export const definition: FactModule = {
  name: '@pointsman/facts-jshis',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.20.0',
  roles: ['facts'],
  capabilities: [{ type: 'inside', layers: Object.keys(JSHIS_LAYERS) }],
  settings: ['FACTS_MODE'],
};
