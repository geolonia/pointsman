// HTTP API. See openapi.yaml for the contract.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authenticate, canUse, type TokenRecord } from './auth';
import { connected, deliver, makeDecision, makeReplay, publicRecord, type Deps } from './decide';
import { parseFeedback, parseResolution } from './feedback';
import { serveMcp } from './mcp';
import { answerConsent, finishLogin, serveAuthorizationServer, serveProtectedMcp, showConsent, type Caller, type OAuthConfig, type OAuthEnv } from './oauth';
import { decisionGraph, toDmn, toSvg } from './graph';
import { explainProfile, explanationText } from './explain';
import type { DecisionLog, FinalAnswer } from './log';
import { visibleRequires } from './chains';
import { peopleAnswers } from './policy';
import type { Profile } from './types';

// The engine core, re-exported for the Worker entry and the tests.
export { ConfigError, deliver, makeDecision, makeReplay, NO_MODEL, retryDueCallbacks, type DecisionResult, type Deps } from './decide';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function error(status: ContentfulStatusCode, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
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
    // A test token only decides (and lists and explains its profiles); its
    // decisions are not logged, and it must not read or resolve the logged ones.
    if (record.test && !(c.req.method === 'POST' && /^\/v1\/decide\/[^/]+$/.test(c.req.path))
      && !(c.req.method === 'GET' && (c.req.path === '/v1/profiles' || /^\/v1\/profiles\/[^/]+\/explain$/.test(c.req.path)))) {
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

  // A profile in plain sentences, for the people who approve it
  // (docs/profile-format.md#explain): JSON, or Markdown with ?format=text.
  // Only profiles in scope; a rule on a required profile out of scope is
  // shown as written.
  app.get('/v1/profiles/:id/explain', async (c) => {
    const { store } = deps(c.env);
    const client = c.get('client');
    const id = c.req.param('id');
    const format = c.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'text') return error(400, 'invalid_request', '"format" must be json or text');
    const lang = c.req.query('lang') ?? 'en';
    if (lang !== 'en' && lang !== 'ja') return error(400, 'invalid_request', '"lang" must be en or ja');
    const v = c.req.query('version');
    if (v !== undefined && !/^[1-9][0-9]{0,8}$/.test(v)) return error(400, 'invalid_request', '"version" must be a positive integer');
    if (!canUse(client, id)) return error(403, 'forbidden', 'this token may not use this profile');
    const profile = await store.get(id, v === undefined ? undefined : Number(v));
    if (!profile) return error(404, 'profile_not_found', v === undefined ? 'unknown profile' : 'unknown profile or version');
    const required: Record<string, Profile> = {};
    for (const r of profile.requires ?? []) {
      if (Object.hasOwn(required, r.profile) || !canUse(client, r.profile)) continue;
      const p = await store.get(r.profile);
      if (p) required[r.profile] = p;
    }
    const explanation = explainProfile(profile, lang, required);
    if (format === 'text') return new Response(explanationText(explanation), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    return c.json(explanation);
  });

  // What a changed policy would have decided on the logged decisions of a
  // version (docs/profile-format.md#replay). Reads decisions, so not for
  // test tokens (the middleware refuses them).
  app.post('/v1/profiles/:id/replay', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return error(400, 'invalid_request', 'body must be valid JSON');
    }
    const result = await makeReplay(deps(c.env), c.req.param('id'), raw, (id) => canUse(c.get('client'), id));
    if (!result.ok) return error(result.status, result.code, result.message);
    return c.json(result.replay);
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
