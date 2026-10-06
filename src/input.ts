// Build the model state from a raw client payload with the profile's `input`
// mapping. Paths are a small JSONPath subset: `$`, `.key`, `[index]` (the
// schema allows nothing else). A path that does not resolve is left out.

import type { Profile } from './types';

const STEP = /\.([A-Za-z0-9_-]+)|\[([0-9]+)\]/g;

export function resolvePath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const [, key, index] of path.slice(1).matchAll(STEP)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (key !== undefined) {
      if (Array.isArray(current) || !Object.hasOwn(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    } else {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    }
  }
  return current;
}

export function buildState(profile: Profile, payload: unknown): unknown {
  if (!profile.input) return payload;
  const state: Record<string, unknown> = {};
  for (const { name, path } of profile.input) {
    const value = resolvePath(payload, path);
    if (value !== undefined) state[name] = value;
  }
  return state;
}

/**
 * State that already has the profile's input fields: keep only those fields
 * (an object without them gives {}); without an input mapping, unchanged.
 */
export function pickInputFields(profile: Profile, state: unknown): unknown {
  if (!profile.input) return state;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return {};
  const picked: Record<string, unknown> = {};
  for (const { name } of profile.input) {
    if (Object.hasOwn(state, name)) picked[name] = (state as Record<string, unknown>)[name];
  }
  return picked;
}
