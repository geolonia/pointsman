// The profile schema with the `fact` definition built from fact modules
// (src/modules/schema.ts).

import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { FactRegistry } from '../../src/modules/registry.ts';
import { factSchema } from '../../src/modules/schema.ts';

/** The fact schema for these module definitions. */
export function factSchemaOf(definitions) {
  return factSchema([...new FactRegistry(definitions).types.values()]);
}

/** The schema (parsed) with its fact definition built for these modules. */
export function profileSchemaFor(schema, definitions) {
  return { ...schema, $defs: { ...schema.$defs, fact: factSchemaOf(definitions) } };
}

/**
 * The schema file's text with its fact definition replaced, the rest kept as
 * it is written.
 */
export function schemaWithFacts(text, definitions) {
  const node = findNodeAtLocation(parseTree(text), ['$defs', 'fact']);
  if (!node) throw new Error('schema has no $defs.fact');
  const json = compact(factSchemaOf(definitions), '    ');
  return text.slice(0, node.offset) + json + text.slice(node.offset + node.length);
}

/** JSON with values that fit on one line (up to 100 characters with the indent) kept on one line. */
function compact(value, indent) {
  const flat = oneLine(value);
  const scalars = Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object');
  if (value === null || typeof value !== 'object' || scalars || indent.length + flat.length <= 120) return flat;
  const inner = indent + '  ';
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + compact(v, inner)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compact(v, inner)}`).join(',\n')}\n${indent}}`;
}

/** A value on one line, spaced like the rest of the schema file: { "a": 1, "b": [1, 2] }. */
function oneLine(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(oneLine).join(', ')}]`;
  const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`);
  return entries.length ? `{ ${entries.join(', ')} }` : '{}';
}
