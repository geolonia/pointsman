// Profiles (src/profiles/store.ts) in a Cloudflare KV namespace. A
// Cloudflare adapter (docs/adapters.md).

import type { Profile } from '../types';
import type { ProfileStore, ProfileSummary } from './store';

/**
 * Profiles in a KV namespace. Keys, written by the deploy step of the config
 * repository:
 *
 * - `profile:<id>:<version>`: the profile JSON
 * - `index`: JSON array of ProfileSummary, one per profile id
 *
 * The latest version comes from the index. KV is eventually consistent, so
 * right after a deploy a location can see the new index before the new
 * profile key; then the newest version that is readable is served instead of
 * failing (an explicitly requested version is never replaced).
 */
export class KvProfileStore implements ProfileStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(id: string, version?: number): Promise<Profile | null> {
    if (version !== undefined) return this.kv.get<Profile>(`profile:${id}:${version}`, 'json');
    const summary = (await this.list()).find((s) => s.id === id);
    if (!summary) return null;
    const newestFirst = [...summary.versions].filter((v) => v <= summary.version).sort((a, b) => b - a);
    for (const v of newestFirst) {
      const profile = await this.kv.get<Profile>(`profile:${id}:${v}`, 'json');
      if (profile) return profile;
    }
    return null;
  }

  async list(): Promise<ProfileSummary[]> {
    return (await this.kv.get<ProfileSummary[]>('index', 'json')) ?? [];
  }
}
