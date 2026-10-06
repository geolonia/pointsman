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

export interface Profile {
  id: string;
  version: number;
  title: BilingualText;
  description: BilingualText;
  model: string;
  fallback_models?: string[];
  input?: { name: string; path: string }[];
  questions: Question[];
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
}
