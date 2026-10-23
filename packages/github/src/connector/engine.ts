// How the connector reaches Pointsman (docs/github-connector.md#how-it-reaches-pointsman):
// a port with the one call it makes, and the settings that choose the
// adapter behind it. The connector logic (pull-request.ts) only uses the port.
//
// Adapters:
// - HTTP with a token (here, any runtime): POINTSMAN_URL and POINTSMAN_TOKEN.
// - An internal call (a binding named POINTSMAN): on Cloudflare a service
//   binding to the engine's InternalEngine entrypoint
//   (connectors/github/src/engine-binding.ts). No token: the engine names the
//   client itself (INTERNAL_CLIENT).
// - In process (planned): a runtime that runs the connector and the engine in
//   one process passes the engine's own decideInternal (src/internal.ts)
//   behind the same port.

import { ConfigError, type EngineApi } from '@pointsman/module-api';

/** The body of POST /v1/decide/{profile}, as the connector sends it. */
export interface DecideBody {
  state: Record<string, unknown>;
  ref: string;
  decisions?: Record<string, string>;
}

/** The engine's answer: the HTTP status, and with a 2xx status the decision. */
export interface EngineAnswer {
  status: number;
  body?: unknown;
}

/** The engine, as the connector calls it. */
export interface EngineClient {
  /**
   * POST /v1/decide/{profile}. Throws when the engine cannot be reached or
   * does not answer in time; the run is then tried again.
   */
  decide(profile: string, body: DecideBody, options: { idempotencyKey: string }): Promise<EngineAnswer>;
}

/** Which adapter the settings choose. */
export type EngineSetting =
  | { kind: 'http'; url: string; token: string }
  | { kind: 'internal' };

/** The binding for internal calls. */
export const ENGINE_BINDING = 'POINTSMAN';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The adapter the settings choose: the binding POINTSMAN when it is there,
 * else POINTSMAN_URL with POINTSMAN_TOKEN. Throws ConfigError when neither is
 * complete, or when the binding and POINTSMAN_URL are both set.
 */
export function engineSetting(env: Record<string, unknown>): EngineSetting {
  const binding = env[ENGINE_BINDING];
  const url = text(env.POINTSMAN_URL);
  const token = text(env.POINTSMAN_TOKEN);
  if (binding !== undefined && binding !== null) {
    if (typeof binding !== 'object' && typeof binding !== 'function') throw new ConfigError(`${ENGINE_BINDING} must be a binding to the engine`);
    // Two ways to the engine would leave unclear which one is used.
    if (url) throw new ConfigError(`set either the ${ENGINE_BINDING} binding or POINTSMAN_URL, not both`);
    // A secret is removed in its own step after the deploy, so a leftover token is not an error.
    if (token) console.warn(`github connector: POINTSMAN_TOKEN is set but not used (the ${ENGINE_BINDING} binding is): revoke the token and delete the secret`);
    return { kind: 'internal' };
  }
  if (!url && !token) throw new ConfigError(`set the ${ENGINE_BINDING} binding, or POINTSMAN_URL and POINTSMAN_TOKEN`);
  if (!token) throw new ConfigError('POINTSMAN_TOKEN is not set');
  const u = URL.parse(url ?? '');
  // https only (the token is a bearer token), http only on loopback.
  if (!u || (u.protocol !== 'https:' && !LOOPBACK.includes(u.hostname)) || u.search || u.hash || u.username) {
    throw new ConfigError('POINTSMAN_URL must be an https URL (http only for localhost)');
  }
  return { kind: 'http', url: url!.replace(/\/+$/, ''), token };
}

/** The HTTP adapter: POST /v1/decide/{profile} with the connector's token. */
export function httpEngine(api: EngineApi, token: string): EngineClient {
  return {
    async decide(profile, body, { idempotencyKey }) {
      const res = await api.fetch(`${api.url}/v1/decide/${encodeURIComponent(profile)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return { status: res.status, body: await res.json() };
      await res.body?.cancel();
      return { status: res.status };
    },
  };
}
