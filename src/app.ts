// HTTP API. See openapi.yaml for the contract.

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { buildState } from './input';
import { ModelError, toModelRequest, type ModelAdapter } from './models/adapter';
import { normalizeAnswers } from './models/normalize';
import { compilePolicy } from './policy';
import type { ProfileStore } from './profiles/store';
import type { Decision } from './types';

export interface Deps {
  store: ProfileStore;
  /** Adapter for a model id, or null when no adapter serves it. */
  adapterFor(model: string): ModelAdapter | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const MAX_REF_LENGTH = 200;

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
  const app = new Hono<{ Bindings: Env }>();

  app.get('/v1/profiles', async (c) => {
    const { store } = deps(c.env);
    return c.json({ profiles: await store.list() });
  });

  app.post('/v1/decide/:profile', async (c) => {
    const { store, adapterFor } = deps(c.env);

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

    const adapter = adapterFor(profile.model);
    if (!adapter) throw new ConfigError(`no adapter for model "${profile.model}"`);

    let answers;
    let model;
    try {
      const response = await adapter.decide(toModelRequest(profile, state));
      answers = normalizeAnswers(profile, response);
      model = response.model;
    } catch (err) {
      if (err instanceof ModelError) {
        console.error(`model error for profile ${profile.id}: ${err.message}`);
        return error(502, 'model_error', 'the model did not return a usable answer');
      }
      throw err;
    }

    // Profiles are validated before they reach a store, so a PolicyError here
    // means a store holds an unvalidated profile: a 500, like other config errors.
    const { action } = compilePolicy(profile).decide(answers);

    const decision: Decision = {
      decision_id: crypto.randomUUID(),
      ...(body.ref !== undefined && { ref: body.ref }),
      answers,
      action,
      profile: profile.id,
      profile_version: profile.version,
      model,
    };
    return c.json(decision);
  });

  app.notFound(() => error(404, 'not_found', 'not found'));

  app.onError((err) => {
    console.error(err);
    return error(500, 'internal_error', 'internal error');
  });

  return app;
}
