// Worker entry point: picks the profile store and model adapters from the
// environment (see wrangler.jsonc) and serves the API.

import { ConfigError, createApp, retryDueCallbacks, type Deps } from './app';
import { KvTokenStore } from './auth-kv';
import { FactRouter, MockFactProvider, type FactProvider } from './facts';
import { GitHubAppAuth, GitHubFactProvider, privateKeyDer, TokenAuth } from './facts-github';
import { GsiFactProvider } from './facts-gsi';
import { ValhallaRouter } from './facts-routing';
import { D1DecisionLog } from './log-d1';
import { purgeExpired, type OAuthConfig } from './oauth';
import type { ModelAdapter } from './models/adapter';
import { checkServerUrl, DEFAULT_TIMEOUT_MS, ModelServerAdapter, parseModelList } from './models/http';
import { MockAdapter } from './models/mock';
import { WORKERS_AI_MODELS, WorkersAiAdapter, type AiRunner } from './models/workers-ai';
import { MemoryProfileStore, type ProfileStore } from './profiles/store';
import { KvProfileStore } from './profiles/store-kv';
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
  /** Worker secret: sent as `x-api-key` to the routing server. */
  FACTS_ROUTING_API_KEY?: string | undefined;
  /** GitHub pull-request facts: "token", "app", "mock"; "off" or unset: they are missing. */
  FACTS_GITHUB?: string | undefined;
  /** Worker secret, with FACTS_GITHUB "token": a token that can read the repositories. */
  FACTS_GITHUB_TOKEN?: string | undefined;
  /** With FACTS_GITHUB "app": the GitHub App's id. */
  FACTS_GITHUB_APP_ID?: string | undefined;
  /** Worker secret, with FACTS_GITHUB "app": the app's private key (PEM). */
  FACTS_GITHUB_APP_PRIVATE_KEY?: string | undefined;
  /** The name of Pointsman's own check run, never counted as a required check. */
  FACTS_GITHUB_IGNORE_CHECK?: string | undefined;
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
// One per isolate (and routing server), so its memory cache of tiles is shared between requests.
const gsiFacts = new Map<string, GsiFactProvider>();

// One per isolate and settings, so a GitHub App's installation tokens are reused between requests.
const githubFacts = new Map<string, GitHubFactProvider>();

function githubFor(env: PointsmanEnv): FactProvider | undefined {
  const mode = env.FACTS_GITHUB || 'off';
  const token = env.FACTS_GITHUB_TOKEN || undefined;
  const appId = env.FACTS_GITHUB_APP_ID || undefined;
  const key = env.FACTS_GITHUB_APP_PRIVATE_KEY || undefined;
  const ignoreCheck = env.FACTS_GITHUB_IGNORE_CHECK || undefined;
  if (token && mode !== 'token') throw new ConfigError('FACTS_GITHUB_TOKEN needs FACTS_GITHUB "token"');
  if ((appId || key) && mode !== 'app') throw new ConfigError('FACTS_GITHUB_APP_ID and FACTS_GITHUB_APP_PRIVATE_KEY need FACTS_GITHUB "app"');
  if (ignoreCheck && (mode === 'off' || mode === 'mock')) throw new ConfigError('FACTS_GITHUB_IGNORE_CHECK needs FACTS_GITHUB "token" or "app"');
  switch (mode) {
    case 'off':
      return undefined;
    case 'mock':
      return mockFacts;
    case 'token':
    case 'app': {
      if (mode === 'token' && !token) throw new ConfigError('FACTS_GITHUB "token" needs the secret FACTS_GITHUB_TOKEN');
      if (mode === 'app' && (!appId || !/^[0-9]+$/.test(appId))) throw new ConfigError('FACTS_GITHUB "app" needs FACTS_GITHUB_APP_ID (a number)');
      if (mode === 'app' && (!key || !privateKeyDer(key))) throw new ConfigError('FACTS_GITHUB "app" needs the secret FACTS_GITHUB_APP_PRIVATE_KEY (a PEM private key)');
      // Keyed by every setting, so a new token or key never reuses the old one.
      const id = JSON.stringify([mode, token ?? '', appId ?? '', key ?? '', ignoreCheck ?? '']);
      let p = githubFacts.get(id);
      if (!p) {
        p = new GitHubFactProvider({ auth: mode === 'token' ? new TokenAuth(token!) : new GitHubAppAuth(appId!, key!), ignoreCheck });
        githubFacts.set(id, p);
      }
      return p;
    }
    default:
      throw new ConfigError('FACTS_GITHUB must be "off", "mock", "token" or "app"');
  }
}

/** Spatial facts (FACTS_MODE) and GitHub facts (FACTS_GITHUB); undefined when there are none. */
function factsFor(env: PointsmanEnv): FactProvider | undefined {
  const spatial = spatialFor(env);
  const github = githubFor(env);
  if (!spatial && !github) return undefined;
  // Always routed: FACTS_MODE "mock" must not answer GitHub facts, nor FACTS_GITHUB "mock" spatial ones.
  return new FactRouter({ spatial, github });
}

function spatialFor(env: PointsmanEnv): FactProvider | undefined {
  const routingUrl = env.FACTS_ROUTING_URL || undefined;
  if (routingUrl && env.FACTS_MODE !== 'gsi') throw new ConfigError('FACTS_ROUTING_URL needs FACTS_MODE "gsi"');
  const routing = routingUrl ? checkServerUrl(routingUrl) : undefined;
  if (routing && !routing.ok) throw new ConfigError(`FACTS_ROUTING_URL ${routing.error}`);
  const routingKey = env.FACTS_ROUTING_API_KEY || undefined;
  if (routingKey && !routingUrl) throw new ConfigError('FACTS_ROUTING_API_KEY needs FACTS_ROUTING_URL');
  switch (env.FACTS_MODE ?? 'off') {
    case 'off':
    case '':
      return undefined;
    case 'mock':
      return mockFacts;
    case 'gsi':
    {
      // Keyed by URL and key, so a new key never reuses a router with the old one.
      const id = JSON.stringify([routingUrl ?? '', routingKey ?? '']);
      let p = gsiFacts.get(id);
      if (!p) {
        p = new GsiFactProvider({
          cache: typeof caches === 'undefined' ? undefined : caches.default,
          ...(routing?.ok && { routing: new ValhallaRouter(routing.value, undefined, routingKey) }),
        });
        gsiFacts.set(id, p);
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
