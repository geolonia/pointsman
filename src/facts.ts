// Facts (docs/profile-format.md#facts): looked up for a decision by the
// fact modules a deployment chose (docs/modules.md), checked here, used by
// policy rules and recorded with the decision. A failed lookup is recorded
// as missing, never guessed. What a fact type reads, asks and returns comes
// from its definition (src/modules/registry.ts).

import { resolvePath } from './input';
import {
  FactError, FactMissingError, FactUnavailableError, mockProvider,
  type FactModule, type FactProvider, type FactQueryBase, type FactResult, type FactScope, type Scalar,
} from '@pointsman/module-api';
import { factRegistry, type FactRegistry } from './modules/registry';
import type { Fact, FactSpec } from './types';

export {
  FactError, FactMissingError, FactStaleError, FactUnavailableError,
  type FactProvider, type FactResult, type FactScope,
} from '@pointsman/module-api';
export { toGeometry, type Geometry, type Position, type SpatialFactQuery } from '@pointsman/module-api';

const MAX_SOURCE_LENGTH = 200;

/**
 * Sends each query to the module that answers its fact type (and layer).
 * A fact whose module is switched off is unavailable.
 */
export class ModuleRouter implements FactProvider {
  /** For tests and checks: each chosen module's provider, by module name; undefined when it is off. */
  readonly providers: ReadonlyMap<string, FactProvider | undefined>;
  readonly #registry: FactRegistry;

  constructor(providers: Map<string, FactProvider | undefined>, registry: FactRegistry = factRegistry()) {
    this.providers = providers;
    this.#registry = registry;
  }

  lookup(query: FactQueryBase, signal: AbortSignal, scope?: FactScope): Promise<FactResult> {
    const layer = (query as { layer?: unknown }).layer;
    const module = this.#registry.moduleFor(query.type, typeof layer === 'string' ? layer : undefined);
    const provider = module && this.providers.get(module.name);
    if (!provider) return Promise.reject(new FactUnavailableError(`no provider for ${query.type} facts`));
    return provider.lookup(query, signal, scope);
  }
}

/** Fixed answers for every chosen fact type (MODE "mock"), for development and tests. */
export class MockFactProvider implements FactProvider {
  lookup(query: FactQueryBase): Promise<FactResult> {
    return mockProvider([...factRegistry().types.values()]).lookup(query, new AbortController().signal);
  }
}

/** The chosen modules that answer a profile's fact types, with their versions, for the decision log. */
export function factModules(specs: FactSpec[]): Record<string, string> {
  const registry = factRegistry();
  const out: Record<string, string> = {};
  for (const s of specs) {
    const m: FactModule | undefined = registry.moduleFor(s.type, s.layer);
    if (m) out[m.name] = m.version;
  }
  return out;
}

/** Null when the result fits the fact type, otherwise what is wrong. */
export function resultError(type: string, result: unknown): string | null {
  if (result === null || typeof result !== 'object') return 'not an object';
  const { values, source } = result as Partial<FactResult>;
  if (typeof source !== 'string' || source === '' || source.length > MAX_SOURCE_LENGTH) return 'source must be a short string';
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return 'values must be an object';
  const def = factRegistry().type(type);
  if (!def) return `unknown fact type "${type}"`;
  for (const key of Object.keys(values)) if (!Object.hasOwn(def.fields, key)) return `unknown field "${key}"`;
  for (const [field, { kind, probability }] of Object.entries(def.fields)) {
    if (!Object.hasOwn(values, field)) return `missing field "${field}"`;
    const v = values[field];
    if (v !== null && typeof v !== kind) return `"${field}" must be a ${kind} or null`;
    if (typeof v === 'number' && !Number.isFinite(v)) return `"${field}" must be a finite number`;
    if (probability && typeof v === 'number' && (v < 0 || v > 1)) return `"${field}" must be from 0 to 1`;
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
  /** For tests: one limit for every fact. Default: the fact type's own. */
  timeoutMs?: number,
): Promise<Record<string, Fact>> {
  const registry = factRegistry();
  const scope: FactScope = new Map();
  const entries = await Promise.all(specs.map(async (spec): Promise<[string, Fact]> => {
    const def = registry.type(spec.type);
    // A profile is validated against the chosen modules, so this is a profile from elsewhere.
    if (!def) return [spec.name, { missing: true, reason: 'unavailable' }];
    let input: unknown;
    try {
      input = def.input.read(resolvePath(state, spec.at), spec);
    } catch {
      input = null; // a module's reader must not break the decision
    }
    if (input === null) return [spec.name, { missing: true, reason: def.input.missing }];
    if (!provider) return [spec.name, { missing: true, reason: 'unavailable' }];

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs ?? def.timeoutMs);
    });
    try {
      const result = await Promise.race([provider.lookup(def.query(spec, input), controller.signal, scope), timeout]);
      if (result === 'timeout') {
        controller.abort();
        return [spec.name, { missing: true, reason: 'timeout' }];
      }
      const values: unknown = (result as Partial<FactResult> | null)?.values;
      const checked = def.normalize && values !== null && typeof values === 'object' && !Array.isArray(values)
        ? { ...result, values: def.normalize(values as Record<string, Scalar>, spec) }
        : result;
      const problem = resultError(spec.type, checked);
      if (problem) throw new FactError(`invalid result: ${problem}`);
      return [spec.name, { missing: false, values: { ...checked.values }, source: checked.source }];
    } catch (err) {
      // The message only: errors must not carry the location (or a token) into the logs.
      console.error(`fact ${spec.name} (${spec.type}): ${err instanceof Error ? err.message : 'lookup failed'}`);
      // A call's own time limit (the routing server's) is a timeout too, like the lookup's.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      // Only reasons the chosen modules declare; anything else is an error.
      const reason = err instanceof FactMissingError && registry.reasons.has(err.reason) ? err.reason : timedOut ? 'timeout' : 'error';
      return [spec.name, { missing: true, reason }];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
  return Object.fromEntries(entries);
}
