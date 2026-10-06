// Model adapters speak the request/response format shared by the decision
// model APIs (Clef, Jev; see docs/profile-format.md). The engine builds the
// request from a profile and normalizes the response, so an adapter only has
// to move the request to its backend and back.

import type { Profile } from '../types';

export type ModelQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface ModelRequest {
  model: string;
  state: unknown;
  questions: Record<string, ModelQuestion>;
}

export type ModelAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score';
      score: number;
      legend: Record<string, unknown>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface ModelResponse {
  /** The model that answered, as reported by the backend. */
  model: string;
  answers: Record<string, ModelAnswer>;
}

export interface ModelAdapter {
  decide(request: ModelRequest): Promise<ModelResponse>;
}

/** Thrown by adapters; the API answers 502. */
export class ModelError extends Error {
  override name = 'ModelError';
}

/** Convert a profile's question list to the map the model APIs expect. */
export function toModelRequest(profile: Profile, state: unknown, model = profile.model): ModelRequest {
  const questions: Record<string, ModelQuestion> = {};
  for (const q of profile.questions) {
    switch (q.type) {
      case 'noul':
        questions[q.name] = q.criteria
          ? { type: 'noul', instructions: q.instructions, criteria: q.criteria }
          : { type: 'noul', instructions: q.instructions };
        break;
      case 'choice':
        questions[q.name] = {
          type: 'choice',
          instructions: q.instructions,
          criteria: Object.fromEntries(q.criteria.map((c) => [c.value, c.description ?? null])),
        };
        break;
      case 'score':
        questions[q.name] = { type: 'score', instructions: q.instructions, criteria: q.criteria };
        break;
    }
  }
  return { model, state, questions };
}
