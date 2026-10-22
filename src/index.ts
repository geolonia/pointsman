// Worker entry point: picks the profile store and model adapters from the
// environment (see wrangler.jsonc) and serves the API.

import { ConfigError, createApp, retryDueCallbacks, type Deps } from './app';
import { KvTokenStore } from './auth-kv';
import { ModuleRouter, type FactProvider } from './facts';
import type { Connector, ConnectorEntry, ConnectorMessage, FactModuleEntry } from '@pointsman/module-api';
import { useFactModules } from './modules/registry';
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
import factModules, { connectors as connectorModules } from '../generated/modules';

// Every binding may be missing in a misconfigured deployment.
interface PointsmanEnv {
  PROFILE_SOURCE?: string | undefined;
  MODEL_MODE?: string | undefined;
  // Settings of the fact modules, read by each module (packages/facts-*/src/index.ts).
  FACTS_MODE?: string | undefined;
  FACTS_ROUTING_URL?: string | undefined;
  /** Worker secret. */
  FACTS_ROUTING_API_KEY?: string | undefined;
  FACTS_GITHUB?: string | undefined;
  /** Worker secret. */
  FACTS_GITHUB_TOKEN?: string | undefined;
  FACTS_GITHUB_APP_ID?: string | undefined;
  /** Worker secret. */
  FACTS_GITHUB_APP_PRIVATE_KEY?: string | undefined;
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

// The fact modules this deployment chose (engine.json "modules"; written by
// scripts/build-modules.mjs). Their settings are in the env.
useFactModules(factModules);

/** One provider per chosen module (undefined when it is off); undefined when every module is off. */
function factsFor(env: PointsmanEnv): FactProvider | undefined {
  const runtime = { cache: typeof caches === 'undefined' ? undefined : caches.default };
  const all = env as unknown as Record<string, unknown>;
  // A fact setting no chosen module reads is a mistake (a module left out of engine.json).
  const read = new Set(factModules.flatMap((m) => m.settings));
  for (const [name, value] of Object.entries(all)) {
    if (name.startsWith('FACTS_') && !read.has(name) && value !== undefined && value !== '' && value !== 'off') {
      throw new ConfigError(`${name} is set, but no chosen fact module reads it (engine.json "modules")`);
    }
  }
  // Each module sees only its own settings, not the other bindings and secrets.
  const own = (m: FactModuleEntry) => Object.fromEntries(m.settings.map((s) => [s, all[s]]));
  const providers = new Map(factModules.map((m) => [m.name, m.create(own(m), runtime)]));
  if ([...providers.values()].every((p) => p === undefined)) return undefined;
  return new ModuleRouter(providers);
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

// Connectors inside this Worker (docs/connectors.md): each chosen connector
// that can run here serves /connectors/<id>/…. It reaches the engine through
// the same routes as any client, in process and with its own token, so its
// decisions pass the same authentication, policy and decision log.
const CONNECTORS = '/connectors/';
/** Never reached over the network: requests to it go to this Worker's routes in process. */
const IN_PROCESS = 'https://engine.invalid';

/**
 * The connectors switched on by their settings, by id (only `id` when given).
 * Throws ConfigError on broken settings.
 */
export function connectorsFor(env: Env, ctx: ExecutionContext, entries: readonly ConnectorEntry[] = connectorModules, id?: string): Map<string, Connector> {
  const all = env as unknown as Record<string, unknown>;
  const engine = {
    url: IN_PROCESS,
    // Only the API (/v1/), with the connector's token, like any client.
    fetch: async (url: string, init: RequestInit) => {
      if (!url.startsWith(`${IN_PROCESS}/v1/`)) throw new Error('the engine in process takes only its own /v1/ URLs');
      return app.fetch(new Request(url, init), env, ctx);
    },
  };
  const out = new Map<string, Connector>();
  for (const m of entries) {
    if (!m.connector.placements.includes('engine') || (id !== undefined && m.connector.id !== id)) continue;
    // Each connector gets only the settings it lists (reviewed with the module), not the engine's.
    const own = Object.fromEntries(m.connector.settings.map((s) => [s, all[s]]));
    const c = m.connect(own, { engine }, 'engine');
    if (c) out.set(m.connector.id, c);
  }
  return out;
}

/** A request to a connector, with the path it serves ("/notify"); null for other paths. */
async function toConnector(request: Request, env: Env, ctx: ExecutionContext, entries?: readonly ConnectorEntry[]): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CONNECTORS)) return null;
  const rest = url.pathname.slice(CONNECTORS.length);
  const slash = rest.indexOf('/');
  const id = slash < 0 ? rest : rest.slice(0, slash);
  let connectors: Map<string, Connector>;
  try {
    // Only this one: another connector's broken settings do not stop it.
    connectors = connectorsFor(env, ctx, entries, id);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // The operator's to fix; the message names the setting, never its value.
    console.error(`connector configuration: ${err.message}`);
    return Response.json({ error: { code: 'not_configured', message: 'the connector is not configured' } }, { status: 500 });
  }
  const connector = connectors.get(id);
  if (!connector) return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
  url.pathname = slash < 0 ? '/' : rest.slice(slash);
  return connector.fetch(new Request(url, request));
}

/** The Worker, with these connectors (tests choose their own). */
export function worker(entries?: readonly ConnectorEntry[]) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return (await toConnector(request, env, ctx, entries)) ?? app.fetch(request, env, ctx);
    },
    // The queue consumer: the Worker's queue belongs to its only connector with
    // a queue set up. A second one would need the queue's name to tell them apart.
    async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
      let consumers: Connector[];
      try {
        consumers = [...connectorsFor(env, ctx, entries).values()].filter((c) => c.queue);
        if (consumers.length !== 1) throw new ConfigError(`a queue needs exactly one connector with a queue, found ${consumers.length}`);
      } catch (err) {
        // Nothing can be handled: retry the whole batch once the configuration is fixed.
        console.error(`connector configuration: ${err instanceof Error ? err.message : String(err)}`);
        batch.retryAll({ delaySeconds: 300 });
        return;
      }
      await consumers[0]!.queue!(batch as { messages: readonly ConnectorMessage[] });
    },
  };
}

const served = worker();

export default {
  fetch: served.fetch,
  queue: served.queue,
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
} satisfies ExportedHandler<Env, unknown>;
