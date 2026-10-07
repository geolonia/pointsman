// Spatial facts (docs/profile-format.md#facts): looked up for a decision by a
// fact provider, checked here, used by policy rules and recorded with the
// decision. A failed lookup is recorded as missing, never guessed.

import { resolvePath } from './input';
import { FACT_FIELDS } from './policy';
import type { DetourMode, Fact, FactSpec, FactType } from './types';

export type Position = [number, number];
export type Geometry = { type: 'Point'; coordinates: Position } | { type: 'LineString'; coordinates: Position[] };

export interface FactQuery {
  type: FactType;
  layer?: string;
  /** For `detour`; always set for detours (default drive). */
  mode?: DetourMode;
  geometry: Geometry;
}

export interface FactResult {
  values: Record<string, string | number | boolean | null>;
  /** Where the value came from, for example a layer's source and date. */
  source: string;
}

/** Answers fact queries. Throws FactError (or anything) on failure. */
export interface FactProvider {
  lookup(query: FactQuery, signal: AbortSignal): Promise<FactResult>;
}

export class FactError extends Error {
  override name = 'FactError';
}

/** The provider cannot answer this kind of fact or layer: recorded as "unavailable". */
export class FactUnavailableError extends FactError {
  override name = 'FactUnavailableError';
}

export const FACT_TIMEOUT_MS = 3000;
const MAX_POSITIONS = 1000;
const MAX_SOURCE_LENGTH = 200;

const isPosition = (p: unknown): p is Position =>
  Array.isArray(p) && p.length >= 2 && p.length <= 3 && p.every((n) => typeof n === 'number' && Number.isFinite(n))
  && (p[0] as number) >= -180 && (p[0] as number) <= 180 && (p[1] as number) >= -90 && (p[1] as number) <= 90;

/** A GeoJSON Point or LineString (WGS 84), or null. A third coordinate (height) is dropped. */
export function toGeometry(value: unknown): Geometry | null {
  if (value === null || typeof value !== 'object') return null;
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  if (type === 'Point' && isPosition(coordinates)) return { type, coordinates: [coordinates[0], coordinates[1]] };
  if (type === 'LineString' && Array.isArray(coordinates) && coordinates.length >= 2
    && coordinates.length <= MAX_POSITIONS && coordinates.every(isPosition)) {
    return { type, coordinates: coordinates.map((p: Position) => [p[0], p[1]] as Position) };
  }
  return null;
}

/** Null when the result fits the fact type, otherwise what is wrong. */
export function resultError(type: FactType, result: unknown): string | null {
  if (result === null || typeof result !== 'object') return 'not an object';
  const { values, source } = result as Partial<FactResult>;
  if (typeof source !== 'string' || source === '' || source.length > MAX_SOURCE_LENGTH) return 'source must be a short string';
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return 'values must be an object';
  const fields = FACT_FIELDS[type];
  for (const key of Object.keys(values)) if (!Object.hasOwn(fields, key)) return `unknown field "${key}"`;
  for (const [field, kind] of Object.entries(fields)) {
    if (!Object.hasOwn(values, field)) return `missing field "${field}"`;
    const v = values[field];
    if (v !== null && typeof v !== kind) return `"${field}" must be a ${kind} or null`;
    if (typeof v === 'number' && !Number.isFinite(v)) return `"${field}" must be a finite number`;
  }
  return null;
}

/**
 * Look up every fact of a profile, in parallel, each with its own time
 * limit. `state` is what the client sent (before the input mapping), so
 * `at` paths read the client's data. Never throws: a fact that cannot be
 * looked up is recorded as missing, with the reason.
 */
export async function lookupFacts(
  specs: FactSpec[],
  state: unknown,
  provider: FactProvider | undefined,
  timeoutMs = FACT_TIMEOUT_MS,
): Promise<Record<string, Fact>> {
  const entries = await Promise.all(specs.map(async (spec): Promise<[string, Fact]> => {
    const geometry = toGeometry(resolvePath(state, spec.at));
    // A detour needs a section of road, not a point.
    if (!geometry || (spec.type === 'detour' && geometry.type !== 'LineString')) {
      return [spec.name, { missing: true, reason: 'no_location' }];
    }
    if (!provider) return [spec.name, { missing: true, reason: 'unavailable' }];

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const result = await Promise.race([
        provider.lookup({
          type: spec.type,
          ...(spec.layer !== undefined && { layer: spec.layer }),
          ...(spec.type === 'detour' && { mode: spec.mode ?? 'drive' }),
          geometry,
        }, controller.signal),
        timeout,
      ]);
      if (result === 'timeout') {
        controller.abort();
        return [spec.name, { missing: true, reason: 'timeout' }];
      }
      const problem = resultError(spec.type, result);
      if (problem) throw new FactError(`invalid result: ${problem}`);
      return [spec.name, { missing: false, values: { ...result.values }, source: result.source }];
    } catch (err) {
      // The message only: errors must not carry the location into the logs.
      console.error(`fact ${spec.name} (${spec.type}): ${err instanceof Error ? err.message : 'lookup failed'}`);
      return [spec.name, { missing: true, reason: err instanceof FactUnavailableError ? 'unavailable' : 'error' }];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * Fixed answers for development and tests (FACTS_MODE "mock"), like the
 * mock model: every place is inside (rank 1), the nearest feature is 250 m
 * away, and a detour adds nothing.
 */
export class MockFactProvider implements FactProvider {
  async lookup(query: FactQuery): Promise<FactResult> {
    switch (query.type) {
      case 'inside':
        return { values: { inside: true, rank: 1, class: 'mock' }, source: 'mock' };
      case 'nearest':
        return { values: { found: true, distance_m: 250, name: 'Mock feature' }, source: 'mock' };
      case 'detour':
        return { values: { possible: true, extra_m: 0 }, source: 'mock' };
    }
  }
}
