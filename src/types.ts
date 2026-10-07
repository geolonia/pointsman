// Types for decision profiles and decisions.
// Profiles follow schema/profile-v1.schema.json; see docs/profile-format.md.

export interface BilingualText {
  en: string;
  ja: string;
}

export interface NoulQuestion {
  name: string;
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  name: string;
  type: 'choice';
  instructions: string;
  criteria: { value: string; description?: string }[];
}

export interface ScoreQuestion {
  name: string;
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Kinds of spatial fact; their fields are in FACT_FIELDS (src/policy.ts). */
export type FactType = 'inside' | 'nearest' | 'detour';

/** A spatial fact a profile asks for (docs/profile-format.md#facts). */
export interface FactSpec {
  name: string;
  type: FactType;
  /** JSONPath to a GeoJSON geometry in the request state. */
  at: string;
  /** Layer id for `inside` and `nearest`, configured per deployment. */
  layer?: string;
}

/** A fact as looked up for one decision. */
export type Fact =
  | {
      missing: false;
      /** Field values; null when the field has no value (for example no nearest feature). */
      values: Record<string, string | number | boolean | null>;
      /** Where the value came from, for example the layer's source and its date. */
      source: string;
    }
  | {
      missing: true;
      /** no_location, unavailable, timeout or error. */
      reason: FactMissingReason;
    };

export type FactMissingReason = 'no_location' | 'unavailable' | 'timeout' | 'error';

export interface Profile {
  id: string;
  version: number;
  title: BilingualText;
  description: BilingualText;
  model: string;
  fallback_models?: string[];
  input?: { name: string; path: string }[];
  questions: Question[];
  facts?: FactSpec[];
  mcp?: { visible?: boolean };
  log?: { store_state?: boolean };
  policy: {
    rules?: { when: string; action: string }[];
    default: string;
  };
}

/** Answer in the engine's own format. `p` is always the probability of `value`. */
export type Answer =
  | { type: 'noul'; value: boolean; p: number; yes: number }
  | { type: 'choice'; value: string; p: number; probabilities: Record<string, number> }
  | { type: 'score'; value: number; p: number; score: number; probabilities: Record<string, number> };

export interface Decision {
  decision_id: string;
  ref?: string;
  answers: Record<string, Answer>;
  action: string;
  profile: string;
  profile_version: number;
  model: string;
  /** When the decision was made (ISO 8601). */
  created_at: string;
  /** Index of the policy rule that matched; null when the default action applied. */
  rule: number | null;
  /** The facts the profile asked for, by name; only for profiles with facts. */
  facts?: Record<string, Fact>;
}
