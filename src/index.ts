// Worker entry point: picks the profile store and model adapters from the
// environment (see wrangler.jsonc) and serves the API.

import { ConfigError, createApp, retryDueCallbacks, type Deps } from './app';
import { KvTokenStore } from './auth';
import { D1DecisionLog } from './log';
import { purgeExpired, type OAuthConfig } from './oauth';
import type { ModelAdapter } from './models/adapter';
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

function adaptersFor(env: PointsmanEnv): (model: string) => ModelAdapter | null {
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

export function depsFor(env: PointsmanEnv): Deps {
  if (!env.TOKENS) throw new ConfigError('no TOKENS binding');
  if (!env.DB) throw new ConfigError('no DB binding');
  return {
    store: storeFor(env),
    tokens: new KvTokenStore(env.TOKENS),
    log: new D1DecisionLog(env.DB),
    adapterFor: adaptersFor(env),
    callbacks: { secret: env.CALLBACK_SECRET || undefined, fetch: (url, init) => fetch(url, init) },
    oauth: oauthFor(env),
  };
}

const app = createApp((env) => depsFor(env as PointsmanEnv));

export default {
  fetch: app.fetch,
  // Cron trigger (wrangler.jsonc "triggers"): retry review callbacks that are
  // due, and remove expired OAuth records.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const deps = depsFor(env as PointsmanEnv);
    ctx.waitUntil(retryDueCallbacks(deps).then((n) => {
      if (n > 0) console.log(`retried ${n} callbacks`);
    }));
    if (deps.oauth) ctx.waitUntil(purgeExpired(env as unknown as { OAUTH_KV: KVNamespace }, deps.oauth));
  },
} satisfies ExportedHandler<Env>;
