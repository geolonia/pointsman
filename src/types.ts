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
  /** For `detour`: by car (`drive`, the default) or on foot (`walk`). */
  mode?: DetourMode;
  /**
   * For `detour`: also return the way around (`route`). Off by default: the
   * route starts and ends at the section, so it is stored with each decision.
   */
  route?: boolean;
}

export type DetourMode = 'drive' | 'walk';

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
  /** Empty only for a profile with `requires`: then rules only, no model call. */
  questions: Question[];
  facts?: FactSpec[];
  /** The decisions this one builds on (docs/decision-chains.md). */
  requires?: RequiredDecisionSpec[];
  mcp?: { visible?: boolean };
  log?: { store_state?: boolean };
  policy: {
    rules?: { when: string; action: string }[];
    default: string;
    /** Actions a person checks before they count (default [review]). */
    people_check?: string[];
    /** Answers a person may give (default: the actions without review, plus reject). */
    people_answers?: string[];
  };
}

/** A decision a profile builds on: a local name for rules, and the profile it comes from. */
export interface RequiredDecisionSpec {
  name: string;
  profile: string;
  /** The decision may not exist (rules see decisions.<name>.missing). */
  optional?: boolean;
}

/** What rules can read from a required decision (docs/decision-chains.md "What rules can read"). */
export interface RequiredDecisionInput {
  action: string;
  /** The person's answer when a review was resolved, otherwise the action. */
  outcome: string;
  reviewed: boolean;
  /** A person's corrected answers when the review corrected them, otherwise the model's. */
  answers: Record<string, Answer>;
  facts: Record<string, Fact>;
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
  /** Made with a test token: not logged, so the id is unknown to every other endpoint. */
  test?: true;
  /** For profiles with requires: what the rules read from each required decision. */
  requires?: Record<string, import('./log').RequiredSnapshot>;
  /** The earlier decision of the same profile, ref and client that this one replaces. */
  replaces?: string;
  /** A person checks it before it counts (the profile's people_check). */
  review?: { status: 'pending' };
}
