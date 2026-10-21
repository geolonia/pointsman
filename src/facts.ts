// Facts (docs/profile-format.md#facts): looked up for a decision by a fact
// provider, checked here, used by policy rules and recorded with the
// decision. A failed lookup is recorded as missing, never guessed. Spatial
// facts read a place from the request state, GitHub facts a pull request.

import { resolvePath } from './input';
import { FACT_FIELDS } from './policy';
import type { DetourMode, Fact, FactSpec, FactType, GitHubFactType, SpatialFactType } from './types';

export type Position = [number, number];
export type Geometry = { type: 'Point'; coordinates: Position } | { type: 'LineString'; coordinates: Position[] };

export interface SpatialFactQuery {
  type: SpatialFactType;
  layer?: string;
  /** For `detour`; always set for detours (default drive). */
  mode?: DetourMode;
  /** For `detour`: also return the way around; always set for detours (default false). */
  route?: boolean;
  geometry: Geometry;
}

/** A pull request at a commit, as the request state names it. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  /** The head commit the caller saw (40 hex characters, lower case). */
  head: string;
}

export interface GitHubFactQuery {
  type: GitHubFactType;
  pr: PullRequestRef;
  /** For `github_paths`. */
  paths?: string[];
  except?: string[];
  /** For `github_property`. */
  property?: string;
}

export type FactQuery = SpatialFactQuery | GitHubFactQuery;

/**
 * Shared by every lookup of one decision, so that facts can share one read
 * (all GitHub facts of a decision come from one snapshot of the PR).
 */
export type FactScope = Map<string, unknown>;

export interface FactResult {
  values: Record<string, string | number | boolean | null>;
  /** Where the value came from, for example a layer's source and date. */
  source: string;
}

/** Answers fact queries. Throws FactError (or anything) on failure. */
export interface FactProvider<Q extends FactQuery = FactQuery> {
  lookup(query: Q, signal: AbortSignal, scope?: FactScope): Promise<FactResult>;
}

export class FactError extends Error {
  override name = 'FactError';
}

/** The provider cannot answer this kind of fact or layer: recorded as "unavailable". */
export class FactUnavailableError extends FactError {
  override name = 'FactUnavailableError';
}

/** The pull request moved on: its head is not the commit the request names. Recorded as "stale". */
export class FactStaleError extends FactError {
  override name = 'FactStaleError';
}

export const isGitHubFact = (type: FactType): type is GitHubFactType => type.startsWith('github_');

/**
 * Sends GitHub facts to one provider and spatial facts to the other. A
 * kind without a provider is unavailable.
 */
export class FactRouter implements FactProvider {
  /** For tests and checks: the providers it sends to. */
  readonly providers: { spatial: FactProvider<SpatialFactQuery> | undefined; github: FactProvider<GitHubFactQuery> | undefined };
  private readonly spatial: FactProvider<SpatialFactQuery> | undefined;
  private readonly github: FactProvider<GitHubFactQuery> | undefined;

  constructor({ spatial, github }: { spatial?: FactProvider<SpatialFactQuery> | undefined; github?: FactProvider<GitHubFactQuery> | undefined }) {
    this.spatial = spatial;
    this.github = github;
    this.providers = { spatial, github };
  }

  lookup(query: FactQuery, signal: AbortSignal, scope?: FactScope): Promise<FactResult> {
    if ('pr' in query) {
      if (!this.github) return Promise.reject(new FactUnavailableError('no GitHub fact provider'));
      return this.github.lookup(query, signal, scope);
    }
    if (!this.spatial) return Promise.reject(new FactUnavailableError('no spatial fact provider'));
    return this.spatial.lookup(query, signal, scope);
  }
}

export const FACT_TIMEOUT_MS = 3000;
/**
 * A detour asks a routing server (two calls at once, one retry): a server
 * that starts cold needs a few seconds for the first answer.
 */
export const DETOUR_TIMEOUT_MS = 8000;
/** GitHub facts share one snapshot of the pull request: several API calls, some after others. */
export const GITHUB_TIMEOUT_MS = 5000;
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

const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const SHA = /^[0-9a-fA-F]{40}$/;

/** A pull request as { repo: "owner/name", number, head }, or null. */
export function toPullRequest(value: unknown): PullRequestRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { repo, number, head } = value as { repo?: unknown; number?: unknown; head?: unknown };
  const m = typeof repo === 'string' ? REPO.exec(repo) : null;
  // "." and ".." are not repository names (they would change the API path).
  if (!m || m[2] === '.' || m[2] === '..') return null;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
  if (typeof head !== 'string' || !SHA.test(head)) return null;
  return { owner: m[1]!, repo: m[2]!, number, head: head.toLowerCase() };
}

/** The query for a fact, or the reason it cannot be asked. */
function queryFor(spec: FactSpec, state: unknown): FactQuery | 'no_location' | 'no_pr' {
  const value = resolvePath(state, spec.at);
  if (isGitHubFact(spec.type)) {
    const pr = toPullRequest(value);
    if (!pr) return 'no_pr';
    return {
      type: spec.type,
      pr,
      ...(spec.paths !== undefined && { paths: spec.paths }),
      ...(spec.except !== undefined && { except: spec.except }),
      ...(spec.property !== undefined && { property: spec.property }),
    };
  }
  const geometry = toGeometry(value);
  // A detour needs a section of road, not a point.
  if (!geometry || (spec.type === 'detour' && geometry.type !== 'LineString')) return 'no_location';
  return {
    type: spec.type,
    ...(spec.layer !== undefined && { layer: spec.layer }),
    ...(spec.type === 'detour' && { mode: spec.mode ?? 'drive', route: spec.route === true }),
    geometry,
  };
}

function timeoutFor(type: FactType): number {
  if (isGitHubFact(type)) return GITHUB_TIMEOUT_MS;
  return type === 'detour' ? DETOUR_TIMEOUT_MS : FACT_TIMEOUT_MS;
}

/** A detour result without a route (from a provider written before the field) gets route null. */
function withRoute(result: FactResult): FactResult {
  const values: unknown = (result as Partial<FactResult> | null)?.values;
  if (values === null || typeof values !== 'object' || Array.isArray(values) || Object.hasOwn(values, 'route')) return result;
  return { ...result, values: { ...(values as FactResult['values']), route: null } };
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
  /** For tests: one limit for every fact. Default: 3 s, detours 8 s, GitHub facts 5 s. */
  timeoutMs?: number,
): Promise<Record<string, Fact>> {
  const scope: FactScope = new Map();
  const entries = await Promise.all(specs.map(async (spec): Promise<[string, Fact]> => {
    const query = queryFor(spec, state);
    if (typeof query === 'string') return [spec.name, { missing: true, reason: query }];
    if (!provider) return [spec.name, { missing: true, reason: 'unavailable' }];

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs ?? timeoutFor(spec.type));
    });
    try {
      const result = await Promise.race([provider.lookup(query, controller.signal, scope), timeout]);
      if (result === 'timeout') {
        controller.abort();
        return [spec.name, { missing: true, reason: 'timeout' }];
      }
      const checked = spec.type === 'detour' ? withRoute(result) : result;
      const problem = resultError(spec.type, checked);
      if (problem) throw new FactError(`invalid result: ${problem}`);
      const values = { ...checked.values };
      // The route shows the place: kept only when the profile asks for it, whatever the provider sent.
      if (spec.type === 'detour' && spec.route !== true) values.route = null;
      return [spec.name, { missing: false, values, source: checked.source }];
    } catch (err) {
      // The message only: errors must not carry the location (or a token) into the logs.
      console.error(`fact ${spec.name} (${spec.type}): ${err instanceof Error ? err.message : 'lookup failed'}`);
      // A call's own time limit (the routing server's) is a timeout too, like the lookup's.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      const reason = err instanceof FactUnavailableError ? 'unavailable' : err instanceof FactStaleError ? 'stale' : timedOut ? 'timeout' : 'error';
      return [spec.name, { missing: true, reason }];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * Fixed answers for development and tests (FACTS_MODE "mock", FACTS_GITHUB
 * "mock"), like the mock model: every place is inside (rank 1), the nearest
 * feature is 250 m away, and a detour adds nothing. Every pull request is
 * open, by a member who pushed every commit and is not the only code
 * owner, with one changed file (10 lines) that matches every path list,
 * signed commits and one required check that passed; every custom property
 * is unset.
 */
export class MockFactProvider implements FactProvider {
  async lookup(query: FactQuery): Promise<FactResult> {
    switch (query.type) {
      case 'inside':
        return { values: { inside: true, rank: 1, class: 'mock' }, source: 'mock' };
      case 'nearest':
        return { values: { found: true, distance_m: 250, name: 'Mock feature' }, source: 'mock' };
      case 'detour':
        return { values: { possible: true, extra_m: 0, route: null }, source: 'mock' };
      case 'github_pr':
        return {
          values: {
            open: true, merged: false, draft: false, wip_title: false, files: 1, changed_lines: 10, base_is_default: true,
            author_member: true, author_dependabot: false, fork: false, all_commits_verified: true,
            pushed_by_author: 'yes', author_sole_code_owner: false,
          },
          source: 'mock',
        };
      case 'github_paths':
        return { values: { any: true, all: true, count: 1 }, source: 'mock' };
      case 'github_checks':
        return { values: { required: 1, green: true, pending: false, failed: false }, source: 'mock' };
      case 'github_property':
        return { values: { value: 'unset' }, source: 'mock' };
    }
  }
}
