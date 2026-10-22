// GSI data for Japan (国土地理院): the definition of the module
// @pointsman/facts-gsi. It answers the capabilities inside and nearest for
// its own layers. The provider is in src/facts-gsi.ts. Node-safe, like
// src/modules/api.ts.

import type { FactModule } from '../api.ts';
import { ENGINE_VERSION } from '../../version.ts';

/** The layers and the capability each answers. */
export const GSI_LAYERS = { 'gsi-flood-max': 'inside', 'gsi-shelters-flood': 'nearest' } as const;

export const definition: FactModule = {
  name: '@pointsman/facts-gsi',
  version: ENGINE_VERSION,
  roles: ['facts'],
  capabilities: [
    { type: 'inside', layers: ['gsi-flood-max'] },
    { type: 'nearest', layers: ['gsi-shelters-flood'] },
  ],
  settings: ['FACTS_MODE'],
};
