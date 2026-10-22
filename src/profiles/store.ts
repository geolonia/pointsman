// The engine reads profiles only through ProfileStore, so it does not depend
// on where profiles are kept. Profiles are validated before they reach a
// store (CI in the profiles repository, and the build for bundled profiles).

import type { BilingualText, Profile } from '../types';

export interface ProfileSummary {
  id: string;
  /** Latest version. */
  version: number;
  versions: number[];
  title: BilingualText;
  description: BilingualText;
  /**
   * The profile ids the latest version requires (decision chains). Missing in
   * an index written before the decision graph; the next deploy adds it.
   */
  requires?: string[];
}

export interface ProfileStore {
  /** A profile by id; the latest version when `version` is not given. */
  get(id: string, version?: number): Promise<Profile | null>;
  list(): Promise<ProfileSummary[]>;
}

function summarize(versions: Profile[]): ProfileSummary {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const latest = sorted[sorted.length - 1]!;
  return {
    id: latest.id,
    version: latest.version,
    versions: sorted.map((p) => p.version),
    title: latest.title,
    description: latest.description,
    requires: (latest.requires ?? []).map((r) => r.profile),
  };
}

/** Profiles held in memory, for example bundled into the Worker at build time. */
export class MemoryProfileStore implements ProfileStore {
  readonly #byId = new Map<string, Profile[]>();

  constructor(profiles: Profile[]) {
    for (const p of profiles) {
      const list = this.#byId.get(p.id) ?? [];
      if (list.some((q) => q.version === p.version)) {
        throw new Error(`duplicate profile ${p.id} version ${p.version}`);
      }
      list.push(p);
      this.#byId.set(p.id, list);
    }
  }

  async get(id: string, version?: number): Promise<Profile | null> {
    const list = this.#byId.get(id);
    if (!list) return null;
    if (version !== undefined) return list.find((p) => p.version === version) ?? null;
    return list.reduce((a, b) => (b.version > a.version ? b : a));
  }

  async list(): Promise<ProfileSummary[]> {
    return [...this.#byId.values()].map(summarize).sort((a, b) => a.id.localeCompare(b.id));
  }
}
