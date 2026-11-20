// Checks openapi.yaml for mistakes that a lenient parser hides (#246): a
// value that is null (an unquoted comma in a flow mapping `{ ... }` ends the
// value, and the rest becomes a key without a value), and keywords JSON
// Schema does not know in components.schemas (strict Ajv).

import Ajv2020 from 'ajv/dist/2020.js';

/** OpenAPI 3.1 keywords that may stand next to JSON Schema ones. */
const OPENAPI_KEYWORDS = ['example', 'discriminator', 'externalDocs', 'xml'];

/** Problems in a parsed openapi.yaml, as messages; empty when it is fine. */
export function openapiProblems(api) {
  const problems = [];
  (function walk(value, path, key) {
    // A null that means null (a default, an example, an enum value) is fine.
    if (value === null && !['default', 'example', 'enum'].includes(key)) {
      problems.push(`${path}: no value (an unquoted comma in { ... } cuts a text there; quote it, or write null where null is meant)`);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, Array.isArray(value) ? key : k);
    }
  })(api, '', '');
  // Unknown keywords only (strictSchema); type rules are left to the contract tests.
  const ajv = new Ajv2020({ strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, allErrors: true, validateFormats: false });
  // `components` only holds the wrapper below, so the document's
  // "#/components/schemas/..." refs resolve; its schemas are compiled one by one.
  ajv.addVocabulary([...OPENAPI_KEYWORDS, 'components']);
  try {
    ajv.addSchema({ $id: 'https://pointsman.invalid/openapi', components: api.components }, undefined, undefined, true);
    for (const name of Object.keys(api.components?.schemas ?? {})) {
      try {
        ajv.compile({ $ref: `https://pointsman.invalid/openapi#/components/schemas/${name}` });
      } catch (err) {
        problems.push(`components.schemas.${name}: ${err.message}`);
      }
    }
    // The schemas written inline under paths too: parameters, request
    // bodies, responses and their headers.
    for (const [where, schema] of pathSchemas(api)) {
      try {
        ajv.compile({ $id: `https://pointsman.invalid/check/${encodeURIComponent(where)}`, ...rebase(schema) });
      } catch (err) {
        problems.push(`${where}: ${err.message}`);
      }
    }
  } catch (err) {
    problems.push(`components: ${err.message}`);
  }
  return problems;
}

/** [where, schema] for every schema written under paths. */
function pathSchemas(api) {
  const out = [];
  for (const [path, item] of Object.entries(api.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object') continue;
      for (const p of op.parameters ?? []) if (p.schema) out.push([`paths.${path}.${method}.parameters.${p.name}`, p.schema]);
      for (const [type, c] of Object.entries(op.requestBody?.content ?? {})) if (c.schema) out.push([`paths.${path}.${method}.requestBody.${type}`, c.schema]);
      for (const [status, r] of Object.entries(op.responses ?? {})) {
        for (const [type, c] of Object.entries(r.content ?? {})) if (c.schema) out.push([`paths.${path}.${method}.responses.${status}.${type}`, c.schema]);
        for (const [name, h] of Object.entries(r.headers ?? {})) if (h.schema) out.push([`paths.${path}.${method}.responses.${status}.headers.${name}`, h.schema]);
      }
    }
  }
  return out;
}

/** A schema with its "#/components/..." refs pointing at the document added above. */
function rebase(schema) {
  return JSON.parse(JSON.stringify(schema), (k, v) => (k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `https://pointsman.invalid/openapi${v}` : v));
}
