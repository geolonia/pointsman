// The FIWARE bridge's requests to the context broker (bridge.ts): headers,
// reading an entity, writing the result attribute, creating and updating
// the Decision and Task entities.

import { send, USER_AGENT } from './send.ts';
import { type Entity, TASK_CONTEXT } from './shared.ts';
import type { BridgeConfig } from './types.ts';

/** An entity as it is now (normalized, with the given context's names), 'gone', or the failed response. */
export async function readEntity(id: string, config: BridgeConfig, context = config.broker.context): Promise<Entity | 'gone' | Response> {
  const headers = readHeaders(config, context);
  const res = await send(config, 'broker', `${config.broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(id)}`, { headers });
  if (res.status === 404) return 'gone';
  if (!res.ok) return res;
  return (await res.json()) as Entity;
}

/** Authentication, tenant and content type: the same for every request to the broker. */
function brokerHeaders(config: BridgeConfig, contentType: string): Record<string, string> {
  const { broker } = config;
  const headers: Record<string, string> = { 'content-type': contentType, 'user-agent': USER_AGENT };
  if (broker.token) headers.authorization = `Bearer ${broker.token}`;
  if (broker.apiKey) headers['x-api-key'] = broker.apiKey;
  if (broker.tenant) headers['NGSILD-Tenant'] = broker.tenant;
  return headers;
}

/** For a GET or DELETE: the broker's headers without a body, JSON accepted, the context's Link when there is one. */
export function readHeaders(config: BridgeConfig, context: string | undefined): Record<string, string> {
  const headers = brokerHeaders(config, 'application/json');
  delete headers['content-type'];
  headers.accept = 'application/json';
  if (context) headers.link = contextLink(context);
  return headers;
}

/** The Link header that names a JSON-LD context. */
const contextLink = (context: string) => `<${context}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;

/**
 * Writes one attribute with `PATCH …/attrs/{name}`; the first time, when the
 * attribute does not exist yet (404), appends it with `POST …/attrs`. Not
 * `PATCH …/attrs`: Orion-LD notifies on that even for unwatched attributes
 * (#41).
 */
export async function writeAttribute(id: string, name: string, property: Record<string, unknown>, config: BridgeConfig): Promise<Response> {
  const { broker } = config;
  const headers = brokerHeaders(config, 'application/json');
  if (broker.context) headers.link = contextLink(broker.context);
  const attrs = `${broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(id)}/attrs`;
  const write = await send(config, 'broker', `${attrs}/${encodeURIComponent(name)}`, { method: 'PATCH', headers, body: JSON.stringify(property) });
  if (write.status !== 404) return write;
  return send(config, 'broker', attrs, { method: 'POST', headers, body: JSON.stringify({ [name]: property }) });
}

/** 2xx, but not 207: NGSI-LD answers an update with 207 when some attributes were not updated. */
export const updatedAll = (res: Response) => res.ok && res.status !== 207;

/** GET an entity, DELETE it or one attribute, or POST attributes to it; reads and deletes with the Task context unless another is given. */
export function brokerRequest(method: 'GET' | 'DELETE' | 'POST', id: string, config: BridgeConfig, body?: unknown, attribute?: string, context = TASK_CONTEXT): Promise<Response> {
  const path = method === 'POST' ? '/attrs' : attribute ? `/attrs/${encodeURIComponent(attribute)}` : '';
  const url = `${config.broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(id)}${path}`;
  const headers = method === 'POST' ? brokerHeaders(config, 'application/ld+json') : readHeaders(config, context);
  return send(config, 'broker', url, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

export async function createEntity(entity: Record<string, unknown>, config: BridgeConfig): Promise<Response> {
  const { broker } = config;
  // The context is in the body, so no Link header.
  const headers = brokerHeaders(config, 'application/ld+json');
  return send(config, 'broker', `${broker.url}/ngsi-ld/v1/entities`, { method: 'POST', headers, body: JSON.stringify(entity) });
}
