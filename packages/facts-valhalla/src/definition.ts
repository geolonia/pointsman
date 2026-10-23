// Detours from a Valhalla routing server (OpenStreetMap data): the
// definition of the module @pointsman/facts-valhalla. It answers the
// capability detour. The provider is in router.ts. Node-safe,
// like packages/module-api/src/api.ts.

import type { FactModule } from '@pointsman/module-api';

export const definition: FactModule = {
  name: '@pointsman/facts-valhalla',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.14.2',
  roles: ['facts'],
  capabilities: [{ type: 'detour' }],
  settings: ['FACTS_MODE', 'FACTS_ROUTING_URL', 'FACTS_ROUTING_API_KEY'],
};
