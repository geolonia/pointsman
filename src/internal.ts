// The routes that internal calls share, after the caller is known
// (docs/adapters.md#internal-calls): POST /v1/decide/{profile},
// GET /v1/decisions/{id}, POST /v1/reviews/{id}/resolve and
// POST /v1/reviews/{id}/close.
//
// `decideAnswer`, `getAnswer`, `resolveAnswer` and `closeAnswer` are the
// routes' work once the token is checked: the HTTP routes (src/app.ts) and
// internal calls both use them, so both pass the same checks (profile scope,
// body, idempotency key, who may close) and log the same way.
//
// An internal call comes from a connector in the same deployment through a
// channel of the runtime that is not reachable from outside (on Cloudflare
// the InternalEngine entrypoint, src/index.ts). It has no token: the
// deployment names its client and profiles in INTERNAL_CLIENT, and the call
// is made as that client. It is never a test token and never expires.

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { canUse, type TokenRecord } from './auth';
import { visibleRequires } from './chains';
import { ConfigError, deliver, makeDecision, publicRecord, type Deps } from './decide';
import { parseResolution } from './feedback';
import type { DecisionLog, FinalAnswer } from './log';
import { peopleAnswers } from './policy';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A decision as a client sees it: only with a profile it may use. For others
 * it does not exist (null, a 404), as for unknown ids.
 */
export async function findDecision(client: TokenRecord, log: DecisionLog, id: string) {
  if (!UUID.test(id)) return null;
  const record = await log.get(id);
  return record && canUse(client, record.profile) ? record : null;
}

const notFound = () => error(404, 'decision_not_found', 'unknown decision');
const notPending = () => error(409, 'not_pending', 'this decision has no pending review');

/** GET /v1/decisions/{id} for a known client. */
export async function getAnswer(deps: Deps, client: TokenRecord, id: string): Promise<ApiAnswer> {
  const record = await findDecision(client, deps.log, id);
  if (!record) return notFound();
  return { status: 200, body: publicRecord(record, client) };
}

/**
 * POST /v1/reviews/{id}/resolve for a known client. `defer` runs the first
 * callback delivery after the answer (the runtime's waitUntil).
 */
export async function resolveAnswer(
  deps: Deps,
  client: TokenRecord,
  id: string,
  readBody: () => Promise<unknown>,
  defer: (work: Promise<unknown>) => Promise<void>,
): Promise<ApiAnswer> {
  const record = await findDecision(client, deps.log, id);
  if (!record) return notFound();
  if (record.review?.status !== 'pending') return notPending();

  let raw: unknown;
  try {
    raw = await readBody();
  } catch {
    return error(400, 'invalid_request', 'body must be valid JSON');
  }
  const profile = await deps.store.get(record.profile, record.profile_version);
  if (!profile) {
    return error(409, 'profile_version_gone', 'the profile version of this decision is no longer available');
  }
  const input = parseResolution(raw, profile);
  if (typeof input === 'string') return error(400, 'invalid_request', input);
  // Only the answers the profile lists, so rules that read a person's answer
  // (decisions.<name>.outcome) know every value it can have.
  const answers = peopleAnswers(profile);
  if (!answers.includes(input.action)) {
    return error(400, 'invalid_request', `"action" must be one of: ${answers.join(', ')}`);
  }

  const finalAnswers: Record<string, FinalAnswer> = {};
  for (const q of profile.questions) {
    finalAnswers[q.name] = Object.hasOwn(input.correct, q.name)
      ? { value: input.correct[q.name], source: 'human' }
      : { value: record.answers[q.name]?.value, source: 'model' };
  }
  const now = new Date().toISOString();
  const resolved = await deps.log.resolve(id, {
    resolved_at: now,
    resolved_by: input.by,
    client: client.client,
    final_action: input.action,
    final_answers: finalAnswers,
    correct: input.correct,
    ...(input.note !== undefined && { note: input.note }),
  });
  // Someone else resolved or closed it between the check above and this update.
  if (!resolved) return notPending();

  // First delivery right away, after the answer; retries are scheduled.
  const updated = await deps.log.get(id);
  if (updated?.callback_url && updated.callback?.status === 'pending') await defer(deliver(updated, deps));
  return {
    status: 200,
    body: {
      decision_id: id,
      action: input.action,
      answers: finalAnswers,
      resolved_by: input.by,
      resolved_at: now,
      callback: updated?.callback_url ? 'pending' : 'none',
    },
  };
}

/**
 * POST /v1/reviews/{id}/close for a known client: its own pending review
 * leaves the queue as `superseded` (docs/reviews.md#closing-a-review). Only
 * the client that made the decision may close it; for any other client the
 * decision does not exist (404). No callback is sent, and a later resolve
 * gets 409 not_pending.
 */
export async function closeAnswer(deps: Deps, client: TokenRecord, id: string): Promise<ApiAnswer> {
  const record = await findDecision(client, deps.log, id);
  if (!record || record.client !== client.client) return notFound();
  if (record.review?.status !== 'pending') return notPending();
  // Resolved or closed by someone else in between: the same update only matches a pending review.
  if (!(await deps.log.closeReview(id, client.client))) return notPending();
  return { status: 200, body: { decision_id: id, review: { status: 'superseded' } } };
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

/** An internal get or close call: the id is checked like a path parameter. */
export async function byIdInternal(deps: Deps, client: TokenRecord, id: unknown, call: typeof getAnswer | typeof closeAnswer): Promise<ApiAnswer> {
  if (typeof id !== 'string') return error(400, 'invalid_request', 'the decision id must be a string');
  return call(deps, client, id);
}

/** An internal resolve call: the body goes through JSON, as over HTTP. */
export async function resolveInternal(deps: Deps, client: TokenRecord, id: unknown, request: unknown, defer: (work: Promise<unknown>) => Promise<void>): Promise<ApiAnswer> {
  if (typeof id !== 'string') return error(400, 'invalid_request', 'the decision id must be a string');
  return resolveAnswer(deps, client, id, async () => JSON.parse(JSON.stringify(request)) as unknown, defer);
}
