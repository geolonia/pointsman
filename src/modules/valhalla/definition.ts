// Detours from a Valhalla routing server (OpenStreetMap data): the
// definition of the module @pointsman/facts-valhalla. It answers the
// capability detour. The provider is in src/facts-routing.ts. Node-safe,
// like src/modules/api.ts.

import type { FactModule } from '../api.ts';
import { ENGINE_VERSION } from '../../version.ts';

export const definition: FactModule = {
  name: '@pointsman/facts-valhalla',
  version: ENGINE_VERSION,
  roles: ['facts'],
  capabilities: [{ type: 'detour' }],
  settings: ['FACTS_MODE', 'FACTS_ROUTING_URL', 'FACTS_ROUTING_API_KEY'],
};
