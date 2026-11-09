// Values from the request itself: the definition of the module
// @pointsman/facts-field. It answers the capabilities field_number,
// field_text and field_flag (packages/module-api/src/capabilities.ts). The
// provider is in provider.ts. Node-safe, like packages/module-api/src/api.ts.

import type { FactModule } from '@pointsman/module-api';

export const definition: FactModule = {
  name: '@pointsman/facts-field',
  // As in package.json (a test checks); released with the engine for now.
  version: '0.21.0',
  roles: ['facts'],
  capabilities: [{ type: 'field_number' }, { type: 'field_text' }, { type: 'field_flag' }],
  reasons: {
    wrong_kind: { en: 'the value in the request is not of the expected kind', ja: 'リクエストの値の種類が違う' },
  },
  // No settings and no outside service: it works in every FACTS_MODE.
  settings: [],
};
