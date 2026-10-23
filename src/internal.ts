// POST /v1/decide/{profile} after the caller is known, and internal calls
// (docs/adapters.md#internal-calls).
//
// `decideAnswer` is the route's work once the token is checked: the HTTP
// route (src/app.ts) and internal calls both use it, so both pass the same
// checks (profile scope, body, idempotency key) and log the same way.
//
// An internal call comes from a connector in the same deployment through a
// channel of the runtime that is not reachable from outside (on Cloudflare
// the InternalEngine entrypoint, src/index.ts). It has no token: the
// deployment names its client and profiles in INTERNAL_CLIENT, and the call
// is made as that client. It is never a test token and never expires.

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { canUse, type TokenRecord } from './auth';
import { visibleRequires } from './chains';
import { ConfigError, makeDecision, type Deps } from './decide';

/** A route's answer, as status and JSON body. */
export interface ApiAnswer {
  status: ContentfulStatusCode;
  body: unknown;
}

const error = (status: ContentfulStatusCode, code: string, message: string): ApiAnswer => ({ status, body: { error: { code, message } } });

/**
 * POST /v1/decide/{profile} for a known client. `version` as in the query
 * string; `readBody` throws when the body is not JSON.
 */
export async function decideAnswer(
  deps: Deps,
  client: TokenRecord,
  profile: string,
  readBody: () => Promise<unknown>,
  version: string | undefined,
  idempotencyKey: string | undefined,
): Promise<ApiAnswer> {
  if (version !== undefined && !/^[1-9][0-9]{0,8}$/.test(version)) {
    return error(400, 'invalid_request', '"version" must be a positive integer');
  }
  let raw: unknown;
  try {
    raw = await readBody();
  } catch {
    return error(400, 'invalid_request', 'body must be valid JSON');
  }
  const result = await makeDecision(deps, client, profile, raw, version === undefined ? undefined : Number(version),
    idempotencyKey === undefined ? {} : { idempotencyKey });
  if (!result.ok) return error(result.status, result.code, result.message);
  // A repeated request returns the logged decision: hide what the client may no longer see.
  const requires = visibleRequires(result.decision.requires, (p) => canUse(client, p));
  return { status: 200, body: requires ? { ...result.decision, requires } : result.decision };
}

/** The setting that names the client of internal calls. */
export const INTERNAL_CLIENT = 'INTERNAL_CLIENT';

// As scripts/tokens.mjs: client names and profile ids.
const CLIENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The client of internal calls, from INTERNAL_CLIENT
 * (`{"client":"github-connector","profiles":["pr-docs-check"]}`). Throws
 * ConfigError when it is not set (internal calls are off) or wrong. The
 * profiles are listed: "*" is refused, so the scope is always written down.
 */
export function internalClient(value: unknown): TokenRecord {
  if (value === undefined || value === '') throw new ConfigError(`${INTERNAL_CLIENT} is not set, so internal calls are off`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new ConfigError(`${INTERNAL_CLIENT} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError(`${INTERNAL_CLIENT} must be an object`);
  const { client, profiles, ...rest } = parsed as { client?: unknown; profiles?: unknown };
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new ConfigError(`${INTERNAL_CLIENT}: unknown key ${extra}`);
  if (typeof client !== 'string' || !CLIENT.test(client)) {
    throw new ConfigError(`${INTERNAL_CLIENT}: "client" must be lower case letters, digits and "-" (max 63)`);
  }
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 100 || !profiles.every((p) => typeof p === 'string' && PROFILE.test(p))) {
    throw new ConfigError(`${INTERNAL_CLIENT}: "profiles" must be a list of 1 to 100 profile ids ("*" is not allowed)`);
  }
  // Not a test token, no expiry: its decisions are logged like any other client's.
  return { client, profiles: [...new Set(profiles as string[])], created_at: '1970-01-01T00:00:00.000Z' };
}

/**
 * An internal decide call, as the runtime's channel hands it over. The
 * arguments come from another Worker or module, so they are checked like a
 * request: the body goes through JSON, as over HTTP, so only JSON values
 * reach the engine.
 */
export async function decideInternal(deps: Deps, client: TokenRecord, profile: unknown, request: unknown, options: unknown): Promise<ApiAnswer> {
  if (typeof profile !== 'string') return error(400, 'invalid_request', 'the profile must be a string');
  const o = options ?? {};
  if (typeof o !== 'object' || Array.isArray(o)) return error(400, 'invalid_request', 'the options must be an object');
  const { idempotencyKey, version, ...rest } = o as { idempotencyKey?: unknown; version?: unknown };
  if (Object.keys(rest).length > 0) return error(400, 'invalid_request', `unknown option ${Object.keys(rest)[0]}`);
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') return error(400, 'invalid_request', 'the idempotency key must be a string');
  if (version !== undefined && !(typeof version === 'number' && Number.isInteger(version))) {
    return error(400, 'invalid_request', '"version" must be a positive integer');
  }
  return decideAnswer(deps, client, profile, async () => JSON.parse(JSON.stringify(request)) as unknown,
    version === undefined ? undefined : String(version), idempotencyKey);
}
