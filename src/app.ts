// HTTP API. See openapi.yaml for the contract.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authenticate, canUse, type TokenRecord, type TokenStore } from './auth';
import { attempt, type Fetch } from './callbacks';
import { parseFeedback, parseResolution } from './feedback';
import { serveMcp } from './mcp';
import { answerConsent, finishLogin, serveAuthorizationServer, serveProtectedMcp, showConsent, type OAuthConfig, type OAuthEnv } from './oauth';
import { buildState, pickInputFields } from './input';
import { hashState, type DecisionLog, type DecisionRecord, type FinalAnswer } from './log';
import { ModelError, toModelRequest, type ModelAdapter } from './models/adapter';
import { normalizeAnswers } from './models/normalize';
import { compilePolicy } from './policy';
import type { ProfileStore } from './profiles/store';
import type { Decision } from './types';

export interface Deps {
  store: ProfileStore;
  tokens: TokenStore;
  log: DecisionLog;
  /** Signing secret and fetch for review callbacks (see src/callbacks.ts). */
  callbacks: { secret: string | undefined; fetch: Fetch };
  /** Adapter for a model id, or null when no adapter serves it. */
  adapterFor(model: string): ModelAdapter | null;
  /** GitHub login for /mcp (src/oauth.ts); without it /mcp takes API tokens only. */
  oauth?: OAuthConfig | undefined;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const MAX_REF_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function error(status: ContentfulStatusCode, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

type Body = { state: unknown; ref?: string; callback_url?: string };

/** Returns the parsed body, or an error message. */
function parseBody(body: unknown): Body | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!['state', 'ref', 'callback_url'].includes(key)) return `unknown field "${key}"`;
  }
  if (b.state === undefined || b.state === null) return '"state" is required';
  if (typeof b.state !== 'object' && typeof b.state !== 'string') {
    return '"state" must be an object, an array or a string';
  }
  if (typeof b.state === 'string' && b.state.trim() === '') return '"state" must not be empty';
  if (b.ref !== undefined && (typeof b.ref !== 'string' || b.ref.length === 0 || b.ref.length > MAX_REF_LENGTH)) {
    return `"ref" must be a string of 1 to ${MAX_REF_LENGTH} characters`;
  }
  if (b.callback_url !== undefined) {
    if (typeof b.callback_url !== 'string' || !URL.canParse(b.callback_url)
      || new URL(b.callback_url).protocol !== 'https:') {
      return '"callback_url" must be an https URL';
    }
  }
  return b as Body;
}

export function createApp(deps: (env: Env) => Deps) {
  type AppEnv = { Bindings: Env; Variables: { client: TokenRecord } };
  const app = new Hono<AppEnv>();

  // Every API route needs a valid token. The token itself is never logged.
  app.use('/v1/*', async (c, next) => {
    const record = await authenticate(c.req.header('authorization'), deps(c.env).tokens);
    if (!record) {
      const res = error(401, 'unauthorized', 'a valid API token is required');
      res.headers.set('www-authenticate', 'Bearer');
      return res;
    }
    c.set('client', record);
    await next();
  });

  app.get('/v1/profiles', async (c) => {
    const { store } = deps(c.env);
    const client = c.get('client');
    const profiles = (await store.list()).filter((p) => canUse(client, p.id));
    return c.json({ profiles });
  });

  app.post('/v1/decide/:profile', async (c) => {
    const versionParam = c.req.query('version');
    let version: number | undefined;
    if (versionParam !== undefined) {
      if (!/^[1-9][0-9]{0,8}$/.test(versionParam)) {
        return error(400, 'invalid_request', '"version" must be a positive integer');
      }
      version = Number(versionParam);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return error(400, 'invalid_request', 'body must be valid JSON');
    }
    const result = await makeDecision(deps(c.env), c.get('client'), c.req.param('profile'), raw, version);
    return result.ok ? c.json(result.decision) : error(result.status, result.code, result.message);
  });

  // A decision is visible only to tokens that may use its profile; for others
  // it does not exist (404), as for unknown ids.
  async function findDecision(c: { get(key: 'client'): TokenRecord }, log: DecisionLog, id: string) {
    if (!UUID.test(id)) return null;
    const record = await log.get(id);
    return record && canUse(c.get('client'), record.profile) ? record : null;
  }

  app.get('/v1/decisions/:id', async (c) => {
    const record = await findDecision(c, deps(c.env).log, c.req.param('id'));
    if (!record) return error(404, 'decision_not_found', 'unknown decision');
    const { callback_url: _, ...visible } = record;
    return c.json(visible);
  });

  app.post('/v1/decisions/:id/feedback', async (c) => {
    const { store, log } = deps(c.env);
    const id = c.req.param('id');
    const record = await findDecision(c, log, id);
    if (!record) return error(404, 'decision_not_found', 'unknown decision');

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return error(400, 'invalid_request', 'body must be valid JSON');
    }
    // Feedback is checked against the profile version the decision used.
    const profile = await store.get(record.profile, record.profile_version);
    if (!profile) {
      return error(409, 'profile_version_gone', 'the profile version of this decision is no longer available');
    }
    const feedback = parseFeedback(raw, profile);
    if (typeof feedback === 'string') return error(400, 'invalid_request', feedback);

    await log.addFeedback(id, {
      ...feedback,
      created_at: new Date().toISOString(),
      client: c.get('client').client,
    });
    return c.body(null, 204);
  });

  app.get('/v1/reviews', async (c) => {
    const client = c.get('client');
    const profile = c.req.query('profile');
    let profiles = client.profiles;
    if (profile !== undefined) {
      if (!canUse(client, profile)) return error(403, 'forbidden', 'this token may not use this profile');
      profiles = [profile];
    }
    const pending = await deps(c.env).log.pendingReviews(profiles, 100);
    return c.json({
      reviews: pending.map(({ callback_url: _, callback: __, ...visible }) => visible),
    });
  });

  app.post('/v1/reviews/:id/resolve', async (c) => {
    const d = deps(c.env);
    const id = c.req.param('id');
    const record = await findDecision(c, d.log, id);
    if (!record) return error(404, 'decision_not_found', 'unknown decision');
    if (record.review?.status !== 'pending') {
      return error(409, 'not_pending', 'this decision has no pending review');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return error(400, 'invalid_request', 'body must be valid JSON');
    }
    const profile = await d.store.get(record.profile, record.profile_version);
    if (!profile) {
      return error(409, 'profile_version_gone', 'the profile version of this decision is no longer available');
    }
    const input = parseResolution(raw, profile);
    if (typeof input === 'string') return error(400, 'invalid_request', input);

    const finalAnswers: Record<string, FinalAnswer> = {};
    for (const q of profile.questions) {
      finalAnswers[q.name] = Object.hasOwn(input.correct, q.name)
        ? { value: input.correct[q.name], source: 'human' }
        : { value: record.answers[q.name]?.value, source: 'model' };
    }
    const now = new Date().toISOString();
    const resolved = await d.log.resolve(id, {
      resolved_at: now,
      resolved_by: input.by,
      client: c.get('client').client,
      final_action: input.action,
      final_answers: finalAnswers,
      correct: input.correct,
      ...(input.note !== undefined && { note: input.note }),
    });
    // Someone else resolved it between the check above and this update.
    if (!resolved) return error(409, 'not_pending', 'this decision has no pending review');

    // First delivery right away, after the response; retries are scheduled.
    const updated = await d.log.get(id);
    if (updated?.callback_url && updated.callback?.status === 'pending') {
      const delivery = deliver(updated, d);
      try {
        c.executionCtx.waitUntil(delivery);
      } catch {
        await delivery; // no execution context (tests): deliver inline
      }
    }
    return c.json({
      decision_id: id,
      action: input.action,
      answers: finalAnswers,
      resolved_by: input.by,
      resolved_at: now,
      callback: updated?.callback_url ? 'pending' : 'none',
    });
  });

  // Hono's ExecutionContext type lacks newer Workers fields; it is the same object.
  const ctxOf = (c: Context<AppEnv>) => c.executionCtx as unknown as ExecutionContext;

  // MCP (docs/mcp.md): API tokens as for /v1, and, when OAuth is configured,
  // access tokens of people logged in with GitHub. Checked here because /mcp
  // is outside the /v1 middleware.
  app.all('/mcp', async (c) => {
    const d = deps(c.env);
    if (d.oauth) {
      return serveProtectedMcp(c.req.raw, c.env as unknown as OAuthEnv, ctxOf(c), d.oauth, d.tokens, (req, caller) => serveMcp(req, d, caller));
    }
    const record = await authenticate(c.req.header('authorization'), d.tokens);
    if (!record) {
      const res = error(401, 'unauthorized', 'a valid API token is required');
      res.headers.set('www-authenticate', 'Bearer');
      return res;
    }
    return serveMcp(c.req.raw, d, { kind: 'token', record });
  });

  // OAuth (src/oauth.ts). Without an OAuth config these routes are not found.
  type OAuthRoute = (req: Request, env: OAuthEnv, ctx: ExecutionContext, config: OAuthConfig, d: Deps) => Promise<Response>;
  const withOAuth = (serve: OAuthRoute) => async (c: Context<AppEnv>) => {
    const d = deps(c.env);
    if (!d.oauth) return error(404, 'not_found', 'not found');
    return serve(c.req.raw, c.env as unknown as OAuthEnv, ctxOf(c), d.oauth, d);
  };
  const notFound = () => Promise.resolve(error(404, 'not_found', 'not found'));
  app.all('/.well-known/oauth-protected-resource/mcp', withOAuth((req, env, ctx, config, d) => serveProtectedMcp(req, env, ctx, config, d.tokens, notFound)));
  app.all('/.well-known/oauth-authorization-server', withOAuth(serveAuthorizationServer));
  app.all('/oauth/token', withOAuth(serveAuthorizationServer));
  app.all('/oauth/register', withOAuth(serveAuthorizationServer));
  app.get('/authorize', withOAuth((req, env, _ctx, config) => showConsent(req, env, config)));
  app.post('/authorize', withOAuth((req, env, _ctx, config) => answerConsent(req, env, config)));
  app.get('/callback', withOAuth((req, env, _ctx, config) => finishLogin(req, env, config)));

  app.notFound(() => error(404, 'not_found', 'not found'));

  app.onError((err) => {
    console.error(err);
    return error(500, 'internal_error', 'internal error');
  });

  return app;
}

export type DecisionResult =
  | { ok: true; decision: Decision }
  | { ok: false; status: ContentfulStatusCode; code: string; message: string };

const fail = (status: ContentfulStatusCode, code: string, message: string): DecisionResult => ({ ok: false, status, code, message });

/**
 * Decide for one client: scope check, request check, model call (with
 * fallback models), policy, decision log. Used by the REST API and by MCP.
 */
export async function makeDecision(
  { store, adapterFor, log }: Pick<Deps, 'store' | 'adapterFor' | 'log'>,
  client: TokenRecord,
  profileId: string,
  raw: unknown,
  version?: number,
  /**
   * The state already has the profile's input fields (MCP callers send
   * them directly) instead of a raw payload for the input mapping.
   */
  { stateIsMapped = false }: { stateIsMapped?: boolean } = {},
): Promise<DecisionResult> {
  // Checked before the profile lookup, so a token cannot probe which
  // profiles exist outside its scope.
  if (!canUse(client, profileId)) return fail(403, 'forbidden', 'this token may not use this profile');

  const body = parseBody(raw);
  if (typeof body === 'string') return fail(400, 'invalid_request', body);

  const profile = await store.get(profileId, version);
  if (!profile) return fail(404, 'profile_not_found', 'unknown profile or version');

  const state = stateIsMapped ? pickInputFields(profile, body.state) : buildState(profile, body.state);
  if (profile.input && Object.keys(state as object).length === 0) {
    return fail(400, 'invalid_request', stateIsMapped
      ? `"state" must be an object with at least one of: ${profile.input.map((i) => i.name).join(', ')}`
      : 'no field of the profile input mapping was found in "state"');
  }

  // The profile's model first, then its fallback models in order. A model
  // error (failed call, or an answer that does not fit the profile) moves
  // on to the next model; the decision records the model that answered.
  const models = [profile.model, ...(profile.fallback_models ?? [])];
  const served = models.filter((m) => adapterFor(m) !== null);
  if (served.length === 0) throw new ConfigError(`no adapter for any model of profile ${profile.id}`);

  let answers;
  let model;
  for (const m of served) {
    try {
      const response = await adapterFor(m)!.decide(toModelRequest(profile, state, m));
      answers = normalizeAnswers(profile, response);
      model = response.model;
      break;
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      console.error(`model error for profile ${profile.id}, model ${m}: ${err.message}`);
    }
  }
  if (!answers || !model) return fail(502, 'model_error', 'the model did not return a usable answer');

  // Profiles are validated before they reach a store, so a PolicyError here
  // means a store holds an unvalidated profile: a 500, like other config errors.
  const { action, rule } = compilePolicy(profile).decide(answers);

  const decision: Decision = {
    decision_id: crypto.randomUUID(),
    ...(body.ref !== undefined && { ref: body.ref }),
    answers,
    action,
    profile: profile.id,
    profile_version: profile.version,
    model,
  };
  // Every decision is logged before it is returned. If the log fails, the
  // client gets a 500 and must not act on an unlogged decision.
  await log.insert({
    ...decision,
    created_at: new Date().toISOString(),
    client: client.client,
    rule,
    state_hash: await hashState(state),
    ...(profile.log?.store_state && { state }),
    ...(body.callback_url !== undefined && { callback_url: body.callback_url }),
  });
  return { ok: true, decision };
}

/** Longer than one attempt (10 s timeout), so a claim never expires mid-send. */
const CLAIM_LEASE_MS = 60_000;

/**
 * One callback attempt for a resolved decision. The callback is claimed
 * first, so the first delivery and the cron retry can never send the same
 * attempt twice; only the claimant sends and records the outcome.
 */
export async function deliver(d: DecisionRecord, deps: Pick<Deps, 'log' | 'callbacks'>, now = new Date()): Promise<void> {
  const claim = {
    id: crypto.randomUUID(),
    now: now.toISOString(),
    leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
    attempts: d.callback?.attempts ?? 0,
  };
  if (!(await deps.log.claimCallback(d.decision_id, claim))) return; // someone else has it
  const state = await attempt(d, { ...deps.callbacks, now });
  await deps.log.recordCallback(d.decision_id, state, claim.id);
  if (state.status !== 'delivered') console.error(`callback for ${d.decision_id}: ${state.last_error} (${state.status})`);
}

/** Retry every callback that is due (run by the scheduled handler). */
export async function retryDueCallbacks(deps: Pick<Deps, 'log' | 'callbacks'>, now = new Date()): Promise<number> {
  const due = await deps.log.dueCallbacks(now.toISOString(), 50);
  for (const d of due) await deliver(d, deps, now);
  return due.length;
}
