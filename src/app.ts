// HTTP API. See openapi.yaml for the contract.

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authenticate, canUse, type TokenRecord, type TokenStore } from './auth';
import { parseFeedback } from './feedback';
import { buildState } from './input';
import { hashState, type DecisionLog } from './log';
import { ModelError, toModelRequest, type ModelAdapter } from './models/adapter';
import { normalizeAnswers } from './models/normalize';
import { compilePolicy } from './policy';
import type { ProfileStore } from './profiles/store';
import type { Decision } from './types';

export interface Deps {
  store: ProfileStore;
  tokens: TokenStore;
  log: DecisionLog;
  /** Adapter for a model id, or null when no adapter serves it. */
  adapterFor(model: string): ModelAdapter | null;
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
  const app = new Hono<{ Bindings: Env; Variables: { client: TokenRecord } }>();

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
    const { store, adapterFor, log } = deps(c.env);

    // Checked before the profile lookup, so a token cannot probe which
    // profiles exist outside its scope.
    if (!canUse(c.get('client'), c.req.param('profile'))) {
      return error(403, 'forbidden', 'this token may not use this profile');
    }

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
    const body = parseBody(raw);
    if (typeof body === 'string') return error(400, 'invalid_request', body);

    const profile = await store.get(c.req.param('profile'), version);
    if (!profile) return error(404, 'profile_not_found', 'unknown profile or version');

    const state = buildState(profile, body.state);
    if (profile.input && Object.keys(state as object).length === 0) {
      return error(400, 'invalid_request', 'no field of the profile input mapping was found in "state"');
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
    if (!answers || !model) return error(502, 'model_error', 'the model did not return a usable answer');

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
      client: c.get('client').client,
      rule,
      state_hash: await hashState(state),
      ...(profile.log?.store_state && { state }),
      ...(body.callback_url !== undefined && { callback_url: body.callback_url }),
    });
    return c.json(decision);
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

  app.notFound(() => error(404, 'not_found', 'not found'));

  app.onError((err) => {
    console.error(err);
    return error(500, 'internal_error', 'internal error');
  });

  return app;
}
