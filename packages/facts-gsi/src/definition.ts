// GSI data for Japan (国土地理院): the definition of the module
// @pointsman/facts-gsi. It answers the capabilities inside and nearest for
// its own layers. The provider is in provider.ts. Node-safe, like
// packages/module-api/src/api.ts.

import type { FactModule } from '@pointsman/module-api';

/** The layers and the capability each answers. */
export const GSI_LAYERS = { 'gsi-flood-max': 'inside', 'gsi-shelters-flood': 'nearest' } as const;

export const definition: FactModule = {
  name: '@pointsman/facts-gsi',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.11.0',
  roles: ['facts'],
  capabilities: (['inside', 'nearest'] as const).map((type) => ({
    type,
    layers: Object.entries(GSI_LAYERS).filter(([, t]) => t === type).map(([layer]) => layer),
  })),
  settings: ['FACTS_MODE'],
};
