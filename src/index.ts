// Worker entry point: picks the profile store and model adapters from the
// environment (see wrangler.jsonc) and serves the API.

import { ConfigError, createApp, type Deps } from './app';
import { KvTokenStore } from './auth';
import { D1DecisionLog } from './log';
import { MockAdapter } from './models/mock';
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

export function depsFor(env: PointsmanEnv): Deps {
  if (!env.TOKENS) throw new ConfigError('no TOKENS binding');
  if (!env.DB) throw new ConfigError('no DB binding');
  return {
    store: storeFor(env),
    tokens: new KvTokenStore(env.TOKENS),
    log: new D1DecisionLog(env.DB),
    // Real adapters come with #3; outside mock mode no model is served yet.
    adapterFor: () => (env.MODEL_MODE === 'mock' ? mock : null),
  };
}

export default createApp((env) => depsFor(env as PointsmanEnv));
