// Decision models behind an HTTP server that speaks the shared request and
// answer format (POST /v1/systemone), for example a local Strands Decider
// (`strands-decider serve`). See docs/models.md.

import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse } from './adapter';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ModelServerConfig {
  /** Base URL; the adapter calls `${url}/v1/systemone`. */
  url: string;
  /** Model ids in profiles -> the model name sent to the server. */
  models: Record<string, string>;
  /** Sent as `Authorization: Bearer <key>` when set. Never logged. */
  apiKey?: string | undefined;
  timeoutMs: number;
  fetch: Fetch;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Checks a server base URL: https, or http for a loopback host (local
 * development). No credentials, query or fragment. The value has no trailing
 * slash.
 */
export function checkServerUrl(raw: string): Parsed<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'is not a URL' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return { ok: false, error: 'must use https (http only for localhost)' };
  }
  if (url.username || url.password) return { ok: false, error: 'must not contain credentials' };
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    return { ok: false, error: 'must not have a query or fragment' };
  }
  return { ok: true, value: url.toString().replace(/\/+$/, '') };
}

/** Parses comma-separated `id` or `id=server-name` entries. */
export function parseModelList(raw: string): Parsed<Record<string, string>> {
  const models: Record<string, string> = {};
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [id, name = id, extra] = entry.split('=').map((p) => p.trim());
    // Same rule as model ids in profiles (schema/profile-v1.schema.json).
    if (extra !== undefined || !id || !name || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      return { ok: false, error: `invalid entry "${entry}": use a model id, or id=server-name` };
    }
    if (Object.hasOwn(models, id)) return { ok: false, error: `model "${id}" is listed twice` };
    models[id] = name;
  }
  if (Object.keys(models).length === 0) return { ok: false, error: 'must list at least one model id' };
  return { ok: true, value: models };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export class ModelServerAdapter implements ModelAdapter {
  config: ModelServerConfig;

  constructor(config: ModelServerConfig) {
    this.config = config;
  }

  serves(model: string): boolean {
    return Object.hasOwn(this.config.models, model);
  }

  async decide(request: ModelRequest): Promise<ModelResponse> {
    const { url, models, apiKey, timeoutMs, fetch } = this.config;
    if (!this.serves(request.model)) throw new ModelError(`model "${request.model}" is not on the model server`);
    const name = models[request.model]!;

    let res: Response;
    try {
      res = await fetch(`${url}/v1/systemone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey && { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({ ...request, model: name }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // Only the reason: the error could repeat the request.
      throw new ModelError(`${name}: ${timedOut ? `no answer within ${timeoutMs} ms` : 'model server not reachable'}`);
    }
    if (!res.ok) {
      // The body is not included: it may echo the request.
      throw new ModelError(`${name}: model server answered HTTP ${res.status}`);
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new ModelError(`${name}: model server answered with invalid JSON`);
    }
    // Answers are checked in detail by normalizeAnswers(); here only the shape.
    if (!isObject(raw) || !isObject(raw.answers)) throw new ModelError(`${name}: response has no answers`);
    return {
      model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : request.model,
      answers: raw.answers as ModelResponse['answers'],
    };
  }
}
