// The fact modules a deployment chose (engine.json "modules", docs/modules.md),
// and what follows from them: the fact types a profile may use, their
// fields, the missing reasons, and which module answers which fact.
//
// Every entry point chooses once, before anything reads facts: the Worker
// (src/index.ts, from generated/modules.ts), the scripts (scripts/lib/modules.mjs)
// and the tests. Node-safe, like src/modules/api.ts.

import type { Bilingual, FactModule, FactTypeDef } from './api.ts';
import { CAPABILITIES, LAYER_CAPABILITIES } from './capabilities.ts';

/** Reasons any fact can be missing, whatever its module. */
export const CORE_REASONS: Record<string, Bilingual> = {
  unavailable: { en: 'the data is not available', ja: 'データが使えない' },
  timeout: { en: 'the lookup took too long', ja: '調べるのに時間がかかりすぎた' },
  error: { en: 'an error', ja: 'エラー' },
};

/** Keys every fact has in a profile; no setting may use them. */
const FACT_KEYS = ['name', 'type', 'at'];
/** Fields every fact has in a rule; no fact type may define them. */
const RESERVED_FIELDS = ['missing', 'reason'];
/** Own types: named after their source (github_pr), or <publisher>/<type>. */
const OWN_TYPE = /^(?:[a-z0-9][a-z0-9-]{0,38}\/)?[a-z][a-z0-9_]{0,62}$/;

export class ModuleError extends Error {
  override name = 'ModuleError';
}

interface Answerer {
  module: FactModule;
  /** Only these layers; undefined for all. */
  layers: string[] | undefined;
}

export class FactRegistry {
  readonly modules: readonly FactModule[];
  /** The fact types a profile may use: the modules' own, and the capabilities they answer. */
  readonly types: ReadonlyMap<string, FactTypeDef>;
  /** Every reason a fact can be missing, with what it means. */
  readonly reasons: ReadonlyMap<string, Bilingual>;
  readonly #answerers = new Map<string, Answerer[]>();

  constructor(modules: readonly FactModule[]) {
    this.modules = modules;
    const types = new Map<string, FactTypeDef>();
    const names = new Set<string>();
    for (const m of modules) {
      if (names.has(m.name)) throw new ModuleError(`module ${m.name} is chosen twice`);
      names.add(m.name);
      if (!m.roles.includes('facts')) continue;
      for (const t of m.types ?? []) {
        if (Object.hasOwn(CAPABILITIES, t.type)) throw new ModuleError(`${m.name}: "${t.type}" is a capability; claim it, do not define it`);
        if (!OWN_TYPE.test(t.type)) throw new ModuleError(`${m.name}: fact type "${t.type}" must be a name or <publisher>/<name>`);
        if (types.has(t.type)) throw new ModuleError(`fact type ${t.type} comes from two modules (${this.#answerers.get(t.type)![0]!.module.name} and ${m.name})`);
        checkType(m.name, t);
        types.set(t.type, t);
        this.#answerers.set(t.type, [{ module: m, layers: undefined }]);
      }
      for (const c of m.capabilities ?? []) {
        const def = Object.hasOwn(CAPABILITIES, c.type) ? CAPABILITIES[c.type]! : undefined;
        if (!def) throw new ModuleError(`${m.name}: "${c.type}" is not a capability (${Object.keys(CAPABILITIES).join(', ')})`);
        if (c.layers !== undefined && !LAYER_CAPABILITIES.includes(c.type)) throw new ModuleError(`${m.name}: ${c.type} has no layers`);
        const others = this.#answerers.get(c.type) ?? [];
        for (const o of others) {
          // Two modules can share a capability only by layers, each layer answered by one.
          const overlap = !o.layers || !c.layers ? ['(all layers)'] : o.layers.filter((l) => c.layers!.includes(l));
          if (overlap.length > 0) throw new ModuleError(`${c.type} ${overlap.join(', ')}: answered by both ${o.module.name} and ${m.name}`);
        }
        types.set(c.type, def);
        this.#answerers.set(c.type, [...others, { module: m, layers: c.layers }]);
      }
    }
    this.types = types;

    // The modules' reasons first, as in the docs: no_location, no_pr, stale, then unavailable, timeout, error.
    const reasons = new Map<string, Bilingual>();
    for (const t of types.values()) reasons.set(t.input.missing, t.input.gloss);
    for (const m of modules) for (const [r, gloss] of Object.entries(m.reasons ?? {})) reasons.set(r, gloss);
    for (const [r, gloss] of Object.entries(CORE_REASONS)) reasons.set(r, gloss);
    this.reasons = reasons;
    settingsSchemas(types.values()); // throws on a setting two types define differently
  }

  /** The definition of a fact type; undefined when no chosen module answers it. */
  type(type: string): FactTypeDef | undefined {
    return this.types.get(type);
  }

  /**
   * The module that answers a fact (by type, and layer for layer types). A
   * layer no module names goes to the type's only module, if there is just
   * one: it answers for its layers, mock answers for any, and an unknown
   * layer is its to refuse (as before modules). With several, nobody.
   */
  moduleFor(type: string, layer?: string): FactModule | undefined {
    const answerers = this.#answerers.get(type) ?? [];
    const named = answerers.find((a) => !a.layers || (layer !== undefined && a.layers.includes(layer)));
    return named?.module ?? (answerers.length === 1 ? answerers[0]!.module : undefined);
  }
}

function checkType(module: string, t: FactTypeDef): void {
  for (const f of Object.keys(t.fields)) {
    if (RESERVED_FIELDS.includes(f)) throw new ModuleError(`${module}: ${t.type} must not have a field "${f}"`);
    const def = t.fields[f]!;
    if (def.probability && def.kind !== 'number') throw new ModuleError(`${module}: ${t.type}.${f} is a probability, so a number`);
  }
  for (const s of Object.keys(t.settings ?? {})) {
    if (FACT_KEYS.includes(s)) throw new ModuleError(`${module}: ${t.type} must not have a setting "${s}"`);
  }
  for (const r of t.required ?? []) {
    if (!Object.hasOwn(t.settings ?? {}, r)) throw new ModuleError(`${module}: ${t.type} requires "${r}", which is not one of its settings`);
  }
  for (const f of Object.keys(t.mock)) {
    if (!Object.hasOwn(t.fields, f)) throw new ModuleError(`${module}: ${t.type} mock has an unknown field "${f}"`);
  }
}

/** Every setting of the given types, by name. A name two types share must have the same schema. */
export function settingsSchemas(types: Iterable<FactTypeDef>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const from = new Map<string, string>();
  for (const t of types) {
    for (const [name, schema] of Object.entries(t.settings ?? {})) {
      const known = out.get(name);
      if (known && JSON.stringify(known) !== JSON.stringify(schema)) {
        throw new ModuleError(`setting "${name}" differs between ${from.get(name)} and ${t.type}`);
      }
      out.set(name, schema);
      from.set(name, t.type);
    }
  }
  return out;
}

let current: FactRegistry | undefined;

/** Choose the fact modules (once per entry point; tests may choose again). */
export function useFactModules(modules: readonly FactModule[]): FactRegistry {
  current = new FactRegistry(modules);
  return current;
}

/** The chosen modules. Throws when none were chosen: that is a bug in the entry point. */
export function factRegistry(): FactRegistry {
  if (!current) throw new ModuleError('no fact modules chosen (useFactModules)');
  return current;
}
