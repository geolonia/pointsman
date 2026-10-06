// Worker entry point: picks the profile store and model adapters from the
// environment (see wrangler.jsonc) and serves the API.

import { ConfigError, createApp, retryDueCallbacks, type Deps } from './app';
import { KvTokenStore } from './auth';
import { D1DecisionLog } from './log';
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
  };
}

const app = createApp((env) => depsFor(env as PointsmanEnv));

export default {
  fetch: app.fetch,
  // Cron trigger (wrangler.jsonc "triggers"): retry review callbacks that are due.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(retryDueCallbacks(depsFor(env as PointsmanEnv)).then((n) => {
      if (n > 0) console.log(`retried ${n} callbacks`);
    }));
  },
} satisfies ExportedHandler<Env>;
