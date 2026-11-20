// Checks openapi.yaml for mistakes that a lenient parser hides (#246): a
// value that is null (an unquoted comma in a flow mapping `{ ... }` ends the
// value, and the rest becomes a key without a value), and keywords JSON
// Schema does not know in components.schemas (strict Ajv).

import Ajv2020 from 'ajv/dist/2020.js';

/** OpenAPI 3.1 keywords that may stand next to JSON Schema ones. */
const OPENAPI_KEYWORDS = ['example', 'discriminator', 'externalDocs', 'xml'];

/** Keywords whose value is data, where null may mean null. */
const DATA_KEYWORDS = ['default', 'example', 'enum', 'const'];

/** Keywords whose value maps names (which may look like keywords) to objects. */
const NAME_MAPS = ['paths', 'webhooks', 'schemas', 'properties', 'patternProperties', '$defs', 'dependentSchemas',
  'responses', 'headers', 'content', 'encoding', 'examples', 'links', 'callbacks', 'parameters', 'requestBodies',
  'securitySchemes', 'pathItems', 'variables', 'mapping', 'scopes'];

/** Problems in a parsed openapi.yaml, as messages; empty when it is fine. */
export function openapiProblems(api) {
  const problems = [];
  (function walk(value, path, data, keysAreNames) {
    // A null that means null, anywhere inside a default, an example or an
    // enum (data, not schema), is fine.
    if (value === null && !data) {
      problems.push(`${path}: no value (an unquoted comma in { ... } cuts a text there; quote it, or write null where null is meant)`);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        // Under a map of names (properties, headers, ...) a key is a name,
        // so a header called "example" holds no data.
        const keyword = !keysAreNames && !Array.isArray(value);
        const isData = keyword && (DATA_KEYWORDS.includes(k) || (k === 'examples' && Array.isArray(v)));
        walk(v, path ? `${path}.${k}` : k, data || isData, keyword && !isData && NAME_MAPS.includes(k));
      }
    }
  })(api, '', false, false);
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
    // Parameters shared by every operation of the path.
    for (const p of item.parameters ?? []) if (p.schema) out.push([`paths.${path}.parameters.${p.name}`, p.schema]);
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      const op = item[method];
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
