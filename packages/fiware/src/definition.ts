// The FIWARE bridge as a module: @pointsman/fiware, with the role
// "connector" (docs/connectors.md). It turns NGSI-LD notifications into
// decisions and writes the results back to the entity (bridge.ts). Node-safe,
// like packages/module-api/src/api.ts.

import type { FactModule } from '@pointsman/module-api';
import { SETTINGS } from './settings.ts';

export const definition: FactModule = {
  name: '@pointsman/fiware',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.12.0',
  roles: ['connector'],
  settings: [],
  connector: {
    id: 'fiware',
    placements: ['engine', 'own'],
    settings: SETTINGS,
    // Writes to the context broker, nothing else: the result attribute, and
    // the Decision and Task entities a route asks for.
    actions: ['write-result', 'create-decision-entity', 'create-task', 'cancel-task', 'resolve-review', 'send-feedback'],
  },
};
