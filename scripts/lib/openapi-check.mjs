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
  (function walk(value, path) {
    if (value === null) problems.push(`${path}: no value (an unquoted comma in { ... } cuts a text there; quote it)`);
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  })(api, '');
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
  } catch (err) {
    problems.push(`components: ${err.message}`);
  }
  return problems;
}
