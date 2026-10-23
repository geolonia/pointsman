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
  /** With an error status: the engine's error code, when the adapter has it (for the log). */
  code?: string;
}

/** The engine, as the connector calls it. */
export interface EngineClient {
  /**
   * POST /v1/decide/{profile}. Throws when the engine cannot be reached or
   * does not answer in time; the run is then tried again. A 2xx body is
   * passed on as it came: the connector checks it (checkDecision), the same
   * way for every adapter.
   */
  decide(profile: string, body: DecideBody, options: { idempotencyKey: string }): Promise<EngineAnswer>;
}

/**
 * The decision, as far as the connector reads it (openapi.yaml `Decision`).
 * checkDecision checks these fields before anything is done with an answer.
 */
export interface Decision {
  decision_id: string;
  action: string;
  profile: string;
  profile_version: number;
  rule: number | null;
  facts?: Record<string, { missing?: boolean; reason?: string }>;
  review?: { status: string };
  /** Only on a test token's decision, which is not logged: never acted on. */
  test?: true;
}

/** What the connector makes of a 2xx answer: a decision, a test decision (not acted on), or an answer that is not a decision. */
export type CheckedAnswer =
  | { kind: 'decision'; decision: Decision }
  | { kind: 'test'; decision: Decision }
  | { kind: 'invalid'; reason: string };

/** An action name, as settings.ts maps it; every action a profile can give (schema/profile-v1.schema.json) fits it. */
export const ACTION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A fact's name in a profile (schema/profile-v1.schema.json). */
const FACT_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown, min: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

/**
 * Checks the body of a 2xx answer for one profile and ref, for both adapters
 * (docs/github-connector.md#safety). Every field the connector reads must be
 * there with its type; other fields are not looked at. `reason` names the
 * field, never its value, so it can be logged and shown.
 */
export function checkDecision(body: unknown, asked: { profile: string; ref: string }): CheckedAnswer {
  const invalid = (reason: string): CheckedAnswer => ({ kind: 'invalid', reason });
  if (!plain(body)) return invalid('not an object');
  const d = body;
  if (typeof d.decision_id !== 'string' || !UUID.test(d.decision_id)) return invalid('"decision_id" is not a decision id');
  if (typeof d.action !== 'string' || !ACTION.test(d.action)) return invalid('"action" is not an action name');
  if (d.profile !== asked.profile) return invalid('"profile" is not the profile asked');
  // The engine echoes the ref it was sent (also on an idempotent repeat); the connector always sends one.
  if (d.ref !== asked.ref) return invalid('"ref" is not the ref asked');
  if (!count(d.profile_version, 1)) return invalid('"profile_version" is not a positive integer');
  if (d.rule !== null && !count(d.rule, 0)) return invalid('"rule" is neither null nor a rule index');
  // The engine gives review only while a person checks the decision; another status is not known here, so not acted on.
  if (d.review !== undefined && !(plain(d.review) && d.review.status === 'pending')) return invalid('"review" is not a pending review');
  if (d.facts !== undefined) {
    if (!plain(d.facts)) return invalid('"facts" is not an object');
    for (const [name, f] of Object.entries(d.facts)) {
      if (!FACT_NAME.test(name) || !plain(f) || (f.missing !== undefined && typeof f.missing !== 'boolean') || (f.reason !== undefined && typeof f.reason !== 'string')) {
        return invalid('a fact in "facts" is not a fact');
      }
    }
  }
  if (d.test !== undefined && typeof d.test !== 'boolean') return invalid('"test" is not a boolean');
  const decision = d as unknown as Decision;
  return d.test === true ? { kind: 'test', decision } : { kind: 'decision', decision };
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
      // A body that is not JSON is passed on as none: the connector's check refuses it like any other non-decision.
      if (res.ok) return { status: res.status, body: await res.json().catch(() => undefined) };
      await res.body?.cancel();
      return { status: res.status };
    },
  };
}
