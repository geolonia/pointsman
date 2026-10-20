// HTTP API. See openapi.yaml for the contract.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authenticate, canUse, type TokenRecord, type TokenStore } from './auth';
import { attempt, type Fetch } from './callbacks';
import { parseFeedback, parseResolution } from './feedback';
import { serveMcp } from './mcp';
import { answerConsent, finishLogin, serveAuthorizationServer, serveProtectedMcp, showConsent, type Caller, type OAuthConfig, type OAuthEnv } from './oauth';
import { lookupFacts, type FactProvider } from './facts';
import { buildState, pickInputFields } from './input';
import { hashState, type DecisionLog, type DecisionRecord, type FinalAnswer } from './log';
import { ModelError, toModelRequest, type ModelAdapter } from './models/adapter';
import { normalizeAnswers } from './models/normalize';
import { decisionsError, loadRequired, snapshotOf, visibleRequires } from './chains';
import { decisionGraph, toDmn, toSvg } from './graph';
import { compilePolicy, peopleAnswers, peopleCheck } from './policy';
import type { ProfileStore } from './profiles/store';
import type { Decision, Profile } from './types';

export interface Deps {
  store: ProfileStore;
  tokens: TokenStore;
  log: DecisionLog;
  /** Signing secret and fetch for review callbacks (see src/callbacks.ts). */
  callbacks: { secret: string | undefined; fetch: Fetch };
  /** Adapter for a model id, or null when no adapter serves it. */
  adapterFor(model: string): ModelAdapter | null;
  /** Answers spatial facts (FACTS_MODE); without it, every fact is missing ("unavailable"). */
  facts?: FactProvider | undefined;
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

type Body = { state: unknown; ref?: string; callback_url?: string; decisions?: Record<string, string> };

/** Returns the parsed body, or an error message. */
function parseBody(body: unknown): Body | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!['state', 'ref', 'callback_url', 'decisions'].includes(key)) return `unknown field "${key}"`;
  }
  if (b.state === undefined || b.state === null) return '"state" is required';
  if (typeof b.state !== 'object' && typeof b.state !== 'string') {
    return '"state" must be an object, an array or a string';
  }
  if (typeof b.state === 'string' && b.state.trim() === '') return '"state" must not be empty';
  if (b.ref !== undefined && (typeof b.ref !== 'string' || b.ref.length === 0 || b.ref.length > MAX_REF_LENGTH)) {
    return `"ref" must be a string of 1 to ${MAX_REF_LENGTH} characters`;
  }
  if (b.decisions !== undefined) {
    const problem = decisionsError(b.decisions);
    if (problem) return problem;
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
    // A test token only decides (and lists its profiles); its decisions are
    // not logged, and it must not read or resolve the logged ones.
    if (record.test && !(c.req.method === 'POST' && /^\/v1\/decide\/[^/]+$/.test(c.req.path))
      && !(c.req.method === 'GET' && c.req.path === '/v1/profiles')) {
      return error(403, 'forbidden', 'a test token may only decide');
    }
    await next();
  });

  app.get('/v1/profiles', async (c) => {
    const { store } = deps(c.env);
    const client = c.get('client');
    // requires names only profiles this token may use, too (P-TOKEN-SCOPE).
    const profiles = (await store.list()).filter((p) => canUse(client, p.id))
      .map((p) => (p.requires ? { ...p, requires: p.requires.filter((r) => canUse(client, r)) } : p));
    return c.json({ profiles });
  });

  // The decision graph a profile belongs to, for DMN tools: JSON, DMN 1.3 XML
  // with ?format=dmn, or an SVG diagram with ?format=svg (docs/decision-chains.md).
  // Only profiles in scope.
  app.get('/v1/profiles/:id/graph', async (c) => {
    const { store } = deps(c.env);
    const client = c.get('client');
    const id = c.req.param('id');
    const format = c.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'dmn' && format !== 'svg') return error(400, 'invalid_request', '"format" must be json, dmn or svg');
    const lang = c.req.query('lang') ?? 'en';
    if (lang !== 'en' && lang !== 'ja') return error(400, 'invalid_request', '"lang" must be en or ja');
    // Checked before the lookup, as for decide: no probing outside the scope.
    if (!canUse(client, id)) return error(403, 'forbidden', 'this token may not use this profile');
    const profile = await store.get(id);
    if (!profile) return error(404, 'profile_not_found', 'unknown profile');
    // Only the profiles connected to this one through requires (both ways),
    // found in the index, are read: KV allows a limited number of reads per
    // request. An index without requires (written before the graph) gives
    // every profile in scope.
    const summaries = (await store.list()).filter((p) => canUse(client, p.id));
    const wanted = summaries.every((s) => Array.isArray(s.requires)) ? connected(id, summaries) : new Set(summaries.map((s) => s.id));
    const reads = summaries.filter((s) => s.id !== id && wanted.has(s.id));
    const others = (await Promise.all(reads.map((s) => store.get(s.id, s.version)))).filter((p): p is Profile => p !== null);
    const graph = decisionGraph(profile, others);
    if (format === 'svg') {
      return new Response(toSvg(graph, [profile, ...others], lang), { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } });
    }
    if (format === 'dmn') {
      return new Response(toDmn(graph), {
        headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `inline; filename="${profile.id}.dmn"` },
      });
    }
    return c.json(graph);
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
    const idempotencyKey = c.req.header('Idempotency-Key');
    const result = await makeDecision(deps(c.env), c.get('client'), c.req.param('profile'), raw, version,
      idempotencyKey === undefined ? {} : { idempotencyKey });
    if (!result.ok) return error(result.status, result.code, result.message);
    // A repeated request returns the logged decision: hide what the token may no longer see.
    const client = c.get('client');
    const requires = visibleRequires(result.decision.requires, (profile) => canUse(client, profile));
    return c.json(requires ? { ...result.decision, requires } : result.decision);
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
    return c.json(publicRecord(record, c.get('client')));
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

  // What happened to a profile's decisions in the last days: actions, the
  // review queue and corrections (no state, no single decisions).
  app.get('/v1/stats/:profile', async (c) => {
    const profile = c.req.param('profile');
    if (!canUse(c.get('client'), profile)) return error(403, 'forbidden', 'this token may not use this profile');
    const daysParam = c.req.query('days') ?? '7';
    if (!/^[1-9][0-9]?$/.test(daysParam) || Number(daysParam) > 90) {
      return error(400, 'invalid_request', '"days" must be a whole number from 1 to 90');
    }
    const days = Number(daysParam);
    // Zeros for a typo would look like a quiet week.
    if (!(await deps(c.env).store.get(profile))) return error(404, 'profile_not_found', 'unknown profile');
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const stats = await deps(c.env).log.stats(profile, since);
    return c.json({ profile, days, since, ...stats });
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
      reviews: pending.map((r) => {
        const { callback: _, ...visible } = publicRecord(r, client);
        return visible;
      }),
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
  // A test token only decides over the REST API: MCP would let it read
  // logged decisions (get_decision).
  const mcpFor = (d: Deps) => (req: Request, caller: Caller) => (caller.kind === 'token' && caller.record.test
    ? Promise.resolve(error(403, 'forbidden', 'a test token may only decide (POST /v1/decide)'))
    : serveMcp(req, d, caller));
  app.all('/mcp', async (c) => {
    const d = deps(c.env);
    if (d.oauth) {
      return serveProtectedMcp(c.req.raw, c.env as unknown as OAuthEnv, ctxOf(c), d.oauth, d.tokens, mcpFor(d));
    }
    const record = await authenticate(c.req.header('authorization'), d.tokens);
    if (!record) {
      const res = error(401, 'unauthorized', 'a valid API token is required');
      res.headers.set('www-authenticate', 'Bearer');
      return res;
    }
    return mcpFor(d)(c.req.raw, { kind: 'token', record });
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
 * fallback models) and spatial facts, policy, decision log. Used by the
 * REST API and by MCP.
 */
export async function makeDecision(
  { store, adapterFor, log, facts: factProvider }: Pick<Deps, 'store' | 'adapterFor' | 'log'> & Partial<Pick<Deps, 'facts'>>,
  client: TokenRecord,
  profileId: string,
  raw: unknown,
  version?: number,
  {
    stateIsMapped = false,
    idempotencyKey,
  }: {
    /**
     * The state already has the profile's input fields (MCP callers send
     * them directly) instead of a raw payload for the input mapping.
     */
    stateIsMapped?: boolean;
    /** A repeated request with this key from the same client gets the logged decision again. */
    idempotencyKey?: string;
  } = {},
): Promise<DecisionResult> {
  // Checked before the profile lookup, so a token cannot probe which
  // profiles exist outside its scope.
  if (!canUse(client, profileId)) return fail(403, 'forbidden', 'this token may not use this profile');

  const body = parseBody(raw);
  if (typeof body === 'string') return fail(400, 'invalid_request', body);
  if (client.test && body.callback_url !== undefined) {
    return fail(400, 'invalid_request', 'a test token gets no callbacks: its decisions are not logged');
  }
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return fail(400, 'invalid_request', 'the idempotency key must be 1 to 200 printable characters');
  }
  // A test token's decisions are not logged, so it has none to build on, and
  // it must not read logged ones (P-TEST-TOKEN-ISOLATED).
  if (client.test && body.decisions !== undefined) {
    return fail(400, 'invalid_request', 'a test token cannot send decisions: its decisions are not logged');
  }

  const profile = await store.get(profileId, version);
  if (!profile) return fail(404, 'profile_not_found', 'unknown profile or version');

  const chained = (profile.requires ?? []).length > 0;
  if (!chained && body.decisions !== undefined) return fail(400, 'invalid_request', '"decisions": this profile requires no decisions');
  if (chained && client.test) return fail(400, 'invalid_request', 'a test token cannot decide a profile that requires other decisions');
  if (chained && body.ref === undefined) return fail(400, 'invalid_request', '"ref" is required when the profile requires decisions');

  // The same key from the same client: the decision already logged, if the
  // request is the same; a different request with that key is a conflict.
  // The version as requested (not the latest one it resolved to), so a retry
  // after a new profile version is published is still the same request.
  const digest = idempotencyKey === undefined ? undefined
    : await hashState({
      profile: profile.id, version: version ?? null, state: body.state, ref: body.ref ?? null,
      decisions: body.decisions ?? null, callback_url: body.callback_url ?? null, mapped: stateIsMapped === true,
    });
  if (idempotencyKey !== undefined && !client.test) {
    const earlier = await log.byIdempotencyKey(client.client, idempotencyKey);
    if (earlier) return repeated(earlier, digest!, log);
  }

  // A final decision that a person resolved is never replaced (docs/decision-chains.md).
  const earlierFinal = chained ? await log.latestFor(profile.id, body.ref!, client.client) : null;
  if (earlierFinal?.review?.status === 'resolved') {
    return fail(409, 'resolved_by_person', 'a person has resolved the decision this one would replace');
  }

  const required = chained ? await loadRequired(profile, body.decisions, body.ref!, client, log, store) : undefined;
  if (required && !required.ok) return fail(400, 'invalid_request', required.message);

  const state = stateIsMapped ? pickInputFields(profile, body.state) : buildState(profile, body.state);
  if (profile.input && Object.keys(state as object).length === 0) {
    return fail(400, 'invalid_request', stateIsMapped
      ? `"state" must be an object with at least one of: ${profile.input.map((i) => i.name).join(', ')}`
      : 'no field of the profile input mapping was found in "state"');
  }

  // Facts read the client's data (the `at` paths), not the mapped state.
  // Looked up while the model answers; lookupFacts never throws.
  const factsLookup = profile.facts?.length ? lookupFacts(profile.facts, body.state, factProvider) : undefined;

  let answers: Decision['answers'] | undefined;
  let model: string | undefined;
  if (profile.questions.length === 0) {
    // Rules only (a profile with requires): no model call, no adapter needed.
    answers = {};
    model = NO_MODEL;
  } else {
    // The profile's model first, then its fallback models in order. A model
    // error (failed call, or an answer that does not fit the profile) moves
    // on to the next model; the decision records the model that answered.
    const models = [profile.model, ...(profile.fallback_models ?? [])];
    const served = models.filter((m) => adapterFor(m) !== null);
    if (served.length === 0) throw new ConfigError(`no adapter for any model of profile ${profile.id}`);
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
  }
  const facts = factsLookup ? await factsLookup : undefined;
  if (!answers || !model) return fail(502, 'model_error', 'the model did not return a usable answer');

  // Profiles are validated before they reach a store, so a PolicyError here
  // means a store holds an unvalidated profile: a 500, like other config errors.
  const policy = compilePolicy(profile, required?.ok ? required.profiles : {});
  const { action, rule } = policy.decide(answers, facts, required?.ok ? required.inputs : {});
  const opensReview = peopleCheck(profile).includes(action);

  const decision: Decision = {
    decision_id: crypto.randomUUID(),
    ...(body.ref !== undefined && { ref: body.ref }),
    answers,
    action,
    profile: profile.id,
    profile_version: profile.version,
    model,
    created_at: new Date().toISOString(),
    rule,
    ...(facts && { facts }),
    ...(required?.ok && { requires: snapshotOf(required, policy) }),
    ...(earlierFinal && { replaces: earlierFinal.decision_id }),
    ...(opensReview && !client.test && { review: { status: 'pending' as const } }),
  };
  // A test token's decisions are not logged (and marked as such): they
  // check profiles and examples, nobody acts on them.
  if (client.test) return { ok: true, decision: { ...decision, test: true } };
  // Every decision is logged before it is returned. If the log fails, the
  // client gets a 500 and must not act on an unlogged decision.
  try {
    await log.insert({
      ...decision,
      client: client.client,
      state_hash: await hashState(state),
      ...(profile.log?.store_state && { state }),
      ...(body.callback_url !== undefined && { callback_url: body.callback_url }),
      ...(idempotencyKey !== undefined && digest !== undefined && { idempotency_key: idempotencyKey, request_digest: digest }),
    });
  } catch (err) {
    // Two requests with the same key at once: the other one was logged first.
    const earlier = idempotencyKey === undefined ? null : await log.byIdempotencyKey(client.client, idempotencyKey);
    if (!earlier) throw err;
    return repeated(earlier, digest!, log);
  }
  if (chained) {
    // A person resolved the decision this one replaces while it was being
    // made: their answer stays, and this one never counts. (Once this one is
    // logged, resolving the earlier one is refused, see DecisionLog.resolve.)
    if (earlierFinal && (await log.get(earlierFinal.decision_id))?.review?.status === 'resolved') {
      await log.discard(decision.decision_id, new Date().toISOString());
      return fail(409, 'resolved_by_person', 'a person has resolved the decision this one would replace');
    }
    // The new decision replaces the older ones of the same step for this
    // report: their open reviews leave the queue.
    await log.supersede({ ...decision, client: client.client });
  }
  return { ok: true, decision };
}

/** A repeated request with a logged idempotency key: the logged decision, or a conflict. */
async function repeated(earlier: DecisionRecord, digest: string, log: DecisionLog): Promise<DecisionResult> {
  if (earlier.request_digest !== digest) return fail(409, 'idempotency_conflict', 'this idempotency key was used for a different request');
  if (earlier.requires !== undefined) {
    // A person resolved the decision it replaces before it was logged (the
    // first try was discarded, failed before it could check, or is still
    // running): it never counts, the same answer as for the first try.
    if (earlier.discarded_at !== undefined
      || (earlier.replaces !== undefined && (await log.get(earlier.replaces))?.review?.status === 'resolved')) {
      if (earlier.discarded_at === undefined) await log.discard(earlier.decision_id, new Date().toISOString());
      return fail(409, 'resolved_by_person', 'a person has resolved the decision this one would replace');
    }
    // The first try may have failed after it was logged: close the replaced
    // reviews now (safe to repeat).
    await log.supersede(earlier);
  }
  return { ok: true, decision: decisionOf(earlier) };
}

/**
 * A logged decision as a token may read it: without callback_url and the
 * request digest, and with required decisions of profiles outside the
 * token's scope hidden (P-TOKEN-SCOPE).
 */
function publicRecord<R extends DecisionRecord>(record: R, client: TokenRecord) {
  const { callback_url: _, request_digest: __, requires, ...visible } = record;
  const shown = visibleRequires(requires, (profile) => canUse(client, profile));
  return shown ? { ...visible, requires: shown } : visible;
}

/** The profile ids connected to `id` through requires, both ways, by the index. */
function connected(id: string, summaries: { id: string; requires?: string[] }[]): Set<string> {
  // Only through profiles in the list (the ones in scope): a profile out of
  // scope does not join two others, as in decisionGraph.
  const known = new Set(summaries.map((s) => s.id));
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const next = [
      ...(summaries.find((s) => s.id === at)?.requires ?? []),
      ...summaries.filter((s) => s.requires?.includes(at)).map((s) => s.id),
    ];
    for (const n of next) {
      if (known.has(n) && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** The model of a decision made by rules only. */
export const NO_MODEL = 'none';
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

/** A logged decision as the decide response (an idempotent repeat). */
function decisionOf(r: DecisionRecord): Decision {
  return {
    decision_id: r.decision_id,
    ...(r.ref !== undefined && { ref: r.ref }),
    answers: r.answers,
    action: r.action,
    profile: r.profile,
    profile_version: r.profile_version,
    model: r.model,
    created_at: r.created_at,
    rule: r.rule,
    ...(r.facts && { facts: r.facts }),
    ...(r.requires && { requires: r.requires }),
    ...(r.replaces !== undefined && { replaces: r.replaces }),
    ...(r.review?.status === 'pending' && { review: { status: 'pending' as const } }),
  };
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
