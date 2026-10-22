// The `fact` part of the profile schema (schema/profile-v1.schema.json),
// built from the fact types of the chosen modules: each type allows its own
// settings and requires the ones it needs. `pnpm build` writes it for every
// module in this repository; the profile validator builds it for the
// modules a deployment chose. Node-safe, like packages/module-api/src/api.ts.

import type { FactTypeDef, JsonSchema } from '@pointsman/module-api';
import { settingsSchemas } from './registry.ts';

export function factSchema(types: FactTypeDef[]): JsonSchema {
  // No module chosen: no fact is valid (JSON Schema has no empty enum).
  if (types.length === 0) return { description: 'No fact module is chosen, so a profile cannot have facts.', not: {} };
  const settings = settingsSchemas(types);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'type', 'at'],
    properties: {
      name: { $ref: '#/$defs/name' },
      type: {
        description: types.map((t) => t.description).join(' '),
        enum: types.map((t) => t.type),
      },
      at: {
        description: 'JSONPath into the request state: a GeoJSON Point or LineString (WGS 84) for spatial facts, for example $.location.value; a pull request { repo, number, head } for GitHub facts.',
        type: 'string',
        pattern: '^\\$(\\.[A-Za-z0-9_-]+|\\[[0-9]+\\])*$',
      },
      ...Object.fromEntries(settings),
    },
    // Each type takes its own settings only, and the ones it needs.
    allOf: types.map((t) => ({
      if: { properties: { type: { const: t.type } }, required: ['type'] },
      then: {
        // (properties too: Ajv's strict mode wants required keys declared where they are required.)
        ...(t.required?.length && { properties: Object.fromEntries(t.required.map((r) => [r, true])), required: t.required }),
        propertyNames: { enum: ['name', 'type', 'at', ...Object.keys(t.settings ?? {})] },
      },
    })),
  };
}
