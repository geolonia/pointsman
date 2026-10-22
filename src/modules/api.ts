// Fact-provider modules (docs/modules.md): what a module tells the engine
// about the facts it looks up, and how the engine calls it.
//
// A module has two parts:
//
// - its definition (FactModule): data, and small pure functions. The
//   profile validator, the case runner and the explanation read it under
//   Node.js, so a definition uses only TypeScript syntax that Node can strip
//   and imports other files with their extension.
// - its entry (FactModuleEntry): the definition plus `create`, which builds
//   the provider from the deployment's settings. Only the Worker loads it.
//
// The engine core uses no runtime-specific API (docs/adapters.md); neither
// do modules.

import type { FactSpec } from '../types.ts';

export type Kind = 'number' | 'string' | 'boolean';
export type Scalar = string | number | boolean | null;

export interface FieldDef {
  kind: Kind;
  /** For people and maps, not for rules: a rule cannot refer to it. */
  display?: true;
  /** A number from 0 to 1 (a probability or a confidence), never outside. */
  probability?: true;
}

/** A sentence part for a field in an explanation. `%` is the fact's name. */
export type FieldWords =
  /** For yes-or-no fields: the sentence when true, and when false. */
  | [string, string]
  /** For the others: the subject, for example "the rank of %". */
  | string
  /** A number with a unit, for example { subject: 'the distance to %', unit: 'm' }. */
  | { subject: string; unit: string };

export interface TypeWords {
  /** One sentence about the fact, for the list of facts. `name` is quoted already. */
  describe(name: string, spec: FactSpec): string;
  fields: Record<string, FieldWords>;
}

export type Lang = 'en' | 'ja';
export type Bilingual = Record<Lang, string>;

/** How a fact reads its `at` value from the request state. */
export interface FactInput {
  /** The value for the query, or null when the state has none. */
  read(value: unknown, spec: FactSpec): unknown | null;
  /** The missing reason when read gives null, for example "no_location". */
  missing: string;
  /** What that reason means, for explanations. */
  gloss: Bilingual;
}

/** What case files (src/cases.ts) may give for a fact, so a case cannot pass on values the engine never produces. */
export type CaseRules =
  /**
   * The first field says whether something was found and decides the
   * others: when it is false they have the `absent` values; when true each
   * is needed except the `optional` ones.
   */
  | { key: string; absent: Record<string, Scalar>; optional: string[] }
  /** Every field is needed; null only for `nullable` ones; `defaults` may be left out. */
  | { nullable: string[]; defaults: Record<string, Scalar> };

/** A JSON Schema, as plain data. */
export type JsonSchema = Record<string, unknown>;

/** A kind of fact: its fields, its settings in a profile, and how it is asked. */
export interface FactTypeDef {
  type: string;
  /** One line for the profile schema. */
  description: string;
  fields: Record<string, FieldDef>;
  input: FactInput;
  /** Keys a fact of this type takes in a profile besides name, type and at, as JSON Schema. */
  settings?: Record<string, JsonSchema>;
  /** Settings a fact of this type must give. */
  required?: string[];
  /** The query sent to the provider. `input` is what input.read gave. */
  query(spec: FactSpec, input: unknown): FactQueryBase;
  /** Applied to a provider's values before they are checked (for example a default for a newer field). */
  normalize?(values: Record<string, Scalar>, spec: FactSpec): Record<string, Scalar>;
  /** How long a lookup may take. */
  timeoutMs: number;
  /** The values the mock provider gives (MODE "mock"). */
  mock: Record<string, Scalar>;
  words: Record<Lang, TypeWords>;
  cases: CaseRules;
}

/** Every query names its fact type; the rest is up to the type. */
export interface FactQueryBase {
  type: string;
}

/** A shared fact type (a capability) that a module answers, optionally only for some layers. */
export interface CapabilityClaim {
  type: string;
  /** For layer types (inside, nearest): the layers it serves. Leave out for all. */
  layers?: string[];
}

export interface FactModule {
  /** The package name, for example "@pointsman/facts-github". */
  name: string;
  version: string;
  /** What the module does. Only "facts" so far; connectors come later (#147). */
  roles: 'facts'[];
  /** Fact types of its own. A type that is not a capability is named after its source (github_pr) or `<publisher>/<type>`. */
  types?: FactTypeDef[];
  /** Capabilities (src/modules/capabilities.ts) it answers. */
  capabilities?: CapabilityClaim[];
  /** Missing reasons its provider can give (with FactMissingError), with what they mean. */
  reasons?: Record<string, Bilingual>;
  /** The deployment settings (environment variables) it reads, for docs and checks. */
  settings: string[];
}

export interface FactResult {
  values: Record<string, Scalar>;
  /** Where the value came from, for example a layer's source and date. */
  source: string;
}

/**
 * Shared by every lookup of one decision, so that facts can share one read
 * (all GitHub facts of a decision come from one snapshot of the PR).
 */
export type FactScope = Map<string, unknown>;

/** Answers fact queries. Throws FactError (or anything) on failure. */
export interface FactProvider<Q extends FactQueryBase = FactQueryBase> {
  lookup(query: Q, signal: AbortSignal, scope?: FactScope): Promise<FactResult>;
}

/** What the runtime gives a module besides its settings (docs/adapters.md, "Cache"). */
export interface ModuleRuntime {
  /** A shared HTTP cache, if the runtime has one. A failing cache is a miss. */
  cache?: Cache | undefined;
}

export interface FactModuleEntry extends FactModule {
  /**
   * The provider for these settings; undefined when the module is switched
   * off (its facts are then missing, "unavailable"). Throws ConfigError on
   * settings that do not fit together.
   */
  create(env: Record<string, unknown>, runtime: ModuleRuntime): FactProvider | undefined;
}

/** A broken deployment configuration: the Worker refuses to serve. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export class FactError extends Error {
  override name = 'FactError';
}

/** A lookup that failed for a known reason; the fact is recorded as missing with that reason. */
export class FactMissingError extends FactError {
  override name = 'FactMissingError';
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The provider cannot answer this kind of fact or layer: recorded as "unavailable". */
export class FactUnavailableError extends FactMissingError {
  override name = 'FactUnavailableError';
  constructor(message: string) {
    super('unavailable', message);
  }
}

/** The pull request moved on: its head is not the commit the request names. Recorded as "stale". */
export class FactStaleError extends FactMissingError {
  override name = 'FactStaleError';
  constructor(message: string) {
    super('stale', message);
  }
}

/** Fixed answers from the definitions (MODE "mock"), like the mock model. */
export function mockProvider(types: FactTypeDef[]): FactProvider {
  const byType = new Map(types.map((t) => [t.type, t]));
  return {
    async lookup(query) {
      const def = byType.get(query.type);
      if (!def) throw new FactUnavailableError(`no mock for ${query.type}`);
      return { values: { ...def.mock }, source: 'mock' };
    },
  };
}
