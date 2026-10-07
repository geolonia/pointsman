// Worker entry point: picks the profile store and model adapters from the
// environment (see wrangler.jsonc) and serves the API.

import { ConfigError, createApp, retryDueCallbacks, type Deps } from './app';
import { KvTokenStore } from './auth';
import { MockFactProvider, type FactProvider } from './facts';
import { GsiFactProvider } from './facts-gsi';
import { ValhallaRouter } from './facts-routing';
import { D1DecisionLog } from './log';
import { purgeExpired, type OAuthConfig } from './oauth';
import type { ModelAdapter } from './models/adapter';
import { checkServerUrl, DEFAULT_TIMEOUT_MS, ModelServerAdapter, parseModelList } from './models/http';
import { MockAdapter } from './models/mock';
import { WORKERS_AI_MODELS, WorkersAiAdapter, type AiRunner } from './models/workers-ai';
import { KvProfileStore, MemoryProfileStore, type ProfileStore } from './profiles/store';
import type { Profile } from './types';
// Built from examples/profiles by scripts/build-profiles.mjs.
import bundledProfiles from '../generated/profiles.json';

// Every binding may be missing in a misconfigured deployment.
interface PointsmanEnv {
  PROFILE_SOURCE?: string | undefined;
  MODEL_MODE?: string | undefined;
  /** "gsi" for GSI data (Japan), "mock" for fixed answers; "off" or unset: no provider, facts are missing. */
  FACTS_MODE?: string | undefined;
  /** With FACTS_MODE "gsi": a Valhalla server for detour facts (https). */
  FACTS_ROUTING_URL?: string | undefined;
  PROFILES?: KVNamespace | undefined;
  TOKENS?: KVNamespace | undefined;
  DB?: D1Database | undefined;
  AI?: AiRunner | undefined;
  AI_GATEWAY_ID?: string | undefined;
  /** Worker secret for signing review callbacks. */
  CALLBACK_SECRET?: string | undefined;
  // GitHub login for /mcp (src/oauth.ts): all of these, or none.
  PUBLIC_URL?: string | undefined;
  GITHUB_CLIENT_ID?: string | undefined;
  /** Worker secret. */
  GITHUB_CLIENT_SECRET?: string | undefined;
  /** Comma-separated GitHub organizations whose members may log in. */
  ALLOWED_GITHUB_ORGS?: string | undefined;
  OAUTH_KV?: KVNamespace | undefined;
  // A model server speaking the shared format (src/models/http.ts), for
  // example a local Strands Decider. Its models take precedence over
  // MODEL_MODE. URL and MODELS together, or neither.
  MODEL_SERVER_URL?: string | undefined;
  /** Comma-separated model ids, each optionally `id=server-name`. */
  MODEL_SERVER_MODELS?: string | undefined;
  /** Worker secret; sent as a bearer token. */
  MODEL_SERVER_API_KEY?: string | undefined;
  MODEL_SERVER_TIMEOUT_MS?: string | undefined;
}

const OAUTH_SETTINGS = ['PUBLIC_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ALLOWED_GITHUB_ORGS', 'OAUTH_KV'] as const;

function oauthFor(env: PointsmanEnv): OAuthConfig | undefined {
  const missing = OAUTH_SETTINGS.filter((name) => !env[name]);
  if (missing.length === OAUTH_SETTINGS.length) return undefined;
  // Half a configuration would silently leave people without login.
  if (missing.length > 0) throw new ConfigError(`GitHub login needs ${missing.join(', ')} as well`);
  if (!/^https:\/\/[^/?#]+$/.test(env.PUBLIC_URL!)) throw new ConfigError('PUBLIC_URL must be an https origin without a path');
  const orgs = env.ALLOWED_GITHUB_ORGS!.split(',').map((o) => o.trim()).filter(Boolean);
  if (orgs.length === 0) throw new ConfigError('ALLOWED_GITHUB_ORGS must name at least one organization');
  return {
    issuer: env.PUBLIC_URL!,
    github: {
      clientId: env.GITHUB_CLIENT_ID!,
      clientSecret: env.GITHUB_CLIENT_SECRET!,
      orgs,
      fetch: (url, init) => fetch(url, init),
    },
  };
}

let bundled: MemoryProfileStore | undefined;

function storeFor(env: PointsmanEnv): ProfileStore {
  switch (env.PROFILE_SOURCE) {
    case 'bundled':
      return (bundled ??= new MemoryProfileStore(bundledProfiles as Profile[]));
    case 'kv':
      if (!env.PROFILES) throw new ConfigError('PROFILE_SOURCE is "kv" but no PROFILES binding');
      return new KvProfileStore(env.PROFILES);
    default:
      throw new ConfigError('PROFILE_SOURCE must be "bundled" or "kv"');
  }
}

const mock = new MockAdapter();

function modelServerFor(env: PointsmanEnv): ModelServerAdapter | undefined {
  if (!env.MODEL_SERVER_URL && !env.MODEL_SERVER_MODELS) {
    // A key or timeout alone means a forgotten URL; say so instead of ignoring it.
    if (env.MODEL_SERVER_API_KEY || env.MODEL_SERVER_TIMEOUT_MS) {
      throw new ConfigError('MODEL_SERVER_API_KEY and MODEL_SERVER_TIMEOUT_MS need MODEL_SERVER_URL and MODEL_SERVER_MODELS');
    }
    return undefined;
  }
  if (!env.MODEL_SERVER_URL || !env.MODEL_SERVER_MODELS) {
    throw new ConfigError('MODEL_SERVER_URL and MODEL_SERVER_MODELS go together');
  }
  const url = checkServerUrl(env.MODEL_SERVER_URL);
  if (!url.ok) throw new ConfigError(`MODEL_SERVER_URL ${url.error}`);
  const models = parseModelList(env.MODEL_SERVER_MODELS);
  if (!models.ok) throw new ConfigError(`MODEL_SERVER_MODELS: ${models.error}`);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (env.MODEL_SERVER_TIMEOUT_MS !== undefined && env.MODEL_SERVER_TIMEOUT_MS !== '') {
    timeoutMs = Number(env.MODEL_SERVER_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new ConfigError('MODEL_SERVER_TIMEOUT_MS must be a whole number of milliseconds from 100 to 60000');
    }
  }
  return new ModelServerAdapter({
    url: url.value,
    models: models.value,
    apiKey: env.MODEL_SERVER_API_KEY || undefined,
    timeoutMs,
    fetch: (u, init) => fetch(u, init),
  });
}

function adaptersFor(env: PointsmanEnv): (model: string) => ModelAdapter | null {
  const byMode = adaptersByMode(env);
  const server = modelServerFor(env);
  if (!server) return byMode;
  return (model) => (server.serves(model) ? server : byMode(model));
}

function adaptersByMode(env: PointsmanEnv): (model: string) => ModelAdapter | null {
  switch (env.MODEL_MODE) {
    case 'mock':
      return () => mock;
    case 'workers-ai': {
      if (!env.AI) throw new ConfigError('MODEL_MODE is "workers-ai" but no AI binding');
      const workersAi = new WorkersAiAdapter(env.AI, env.AI_GATEWAY_ID);
      return (model) => (Object.hasOwn(WORKERS_AI_MODELS, model) ? workersAi : null);
    }
    default:
      throw new ConfigError('MODEL_MODE must be "mock" or "workers-ai"');
  }
}

const mockFacts = new MockFactProvider();
// One per isolate (and routing URL), so its memory cache of tiles is shared between requests.
const gsiFacts = new Map<string, GsiFactProvider>();

function factsFor(env: PointsmanEnv): FactProvider | undefined {
  const routingUrl = env.FACTS_ROUTING_URL || undefined;
  if (routingUrl && env.FACTS_MODE !== 'gsi') throw new ConfigError('FACTS_ROUTING_URL needs FACTS_MODE "gsi"');
  const routing = routingUrl ? checkServerUrl(routingUrl) : undefined;
  if (routing && !routing.ok) throw new ConfigError(`FACTS_ROUTING_URL ${routing.error}`);
  switch (env.FACTS_MODE ?? 'off') {
    case 'off':
    case '':
      return undefined;
    case 'mock':
      return mockFacts;
    case 'gsi':
    {
      let p = gsiFacts.get(routingUrl ?? '');
      if (!p) {
        p = new GsiFactProvider({
          cache: typeof caches === 'undefined' ? undefined : caches.default,
          ...(routing?.ok && { routing: new ValhallaRouter(routing.value) }),
        });
        gsiFacts.set(routingUrl ?? '', p);
      }
      return p;
    }
    default:
      throw new ConfigError('FACTS_MODE must be "off", "mock" or "gsi"');
  }
}

export function depsFor(env: PointsmanEnv): Deps {
  if (!env.TOKENS) throw new ConfigError('no TOKENS binding');
  if (!env.DB) throw new ConfigError('no DB binding');
  return {
    store: storeFor(env),
    tokens: new KvTokenStore(env.TOKENS),
    log: new D1DecisionLog(env.DB),
    adapterFor: adaptersFor(env),
    facts: factsFor(env),
    callbacks: { secret: env.CALLBACK_SECRET || undefined, fetch: (url, init) => fetch(url, init) },
    oauth: oauthFor(env),
  };
}

const app = createApp((env) => depsFor(env as PointsmanEnv));

export default {
  fetch: app.fetch,
  // Cron trigger (wrangler.jsonc "triggers"): retry review callbacks that are
  // due, and remove expired OAuth records. A broken config (for example half
  // of the OAuth settings) fails here as it does for requests.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const deps = depsFor(env as PointsmanEnv);
    ctx.waitUntil(retryDueCallbacks(deps).then((n) => {
      if (n > 0) console.log(`retried ${n} callbacks`);
    }));
    if (deps.oauth) ctx.waitUntil(purgeExpired(env as unknown as { OAUTH_KV: KVNamespace }, deps.oauth));
  },
} satisfies ExportedHandler<Env>;
