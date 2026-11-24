// Small pieces the FIWARE bridge's files share (bridge.ts): the entity type,
// reading an attribute's value, building a Property, the JSON-LD contexts
// the bridge writes with, and SHA-256 as hex. No requests.

export type Entity = { id: string; type: string; [attribute: string]: unknown };

/** The SHA-256 of a text (UTF-8), as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function valueOf(attribute: unknown): unknown {
  if (!attribute || typeof attribute !== 'object') return undefined;
  const a = attribute as Record<string, unknown>;
  // Property, Relationship, GeoProperty, LanguageProperty, VocabProperty, JsonProperty, ListProperty, ListRelationship
  return a.value ?? a.object ?? a.languageMap ?? a.vocab ?? a.json ?? a.valueList ?? a.objectList;
}

/** An NGSI-LD Property with this value. */
export const P = (value: unknown) => ({ type: 'Property', value });

export const CORE_CONTEXT = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.8.jsonld';

/** The published context of the Task model (datamodels.jp). */
export const TASK_CONTEXT = 'https://datamodels.jp/context/task/v1.jsonld';
