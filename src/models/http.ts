// Decision models behind an HTTP server that speaks the shared request and
// answer format (POST /v1/systemone), for example a local Strands Decider
// (`strands-decider serve`). See docs/models.md.

import { checkServerUrl } from '@pointsman/module-api';
import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse } from './adapter';

export { checkServerUrl };

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

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parses comma-separated `id` or `id=server-name` entries. */
export function parseModelList(raw: string): Parsed<Record<string, string>> {
  const models: Record<string, string> = Object.create(null);
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

const timedOut = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

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
        // A redirect would resend the state to a URL that was never checked
        // (possibly plain http); it is answered as an HTTP error instead.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Only the reason: the error could repeat the request.
      throw new ModelError(`${name}: ${timedOut(err) ? `no answer within ${timeoutMs} ms` : 'model server not reachable'}`);
    }
    if (!res.ok) {
      // The body is not included: it may echo the request.
      throw new ModelError(`${name}: model server answered HTTP ${res.status}`);
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      // The timeout also covers reading the body: a server that stalls after
      // the headers is a timeout, not invalid JSON.
      throw new ModelError(`${name}: ${timedOut(err) ? `no answer within ${timeoutMs} ms` : 'model server answered with invalid JSON'}`);
    }
    // Answers are checked in detail by normalizeAnswers(); here only the shape.
    if (!isObject(raw) || !isObject(raw.answers)) throw new ModelError(`${name}: response has no answers`);
    // The configured name, not the server's `model` field: that field is
    // server-controlled and would be stored in the decision log.
    return { model: name, answers: raw.answers as ModelResponse['answers'] };
  }
}
