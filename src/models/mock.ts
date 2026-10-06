// Deterministic adapter for development and tests. It ignores the state:
// choice picks the first option (p 0.9), noul answers no (P(yes) 0.2), and
// score picks the lowest level (p 0.7).

import type { ModelAdapter, ModelAnswer, ModelRequest, ModelResponse } from './adapter';

// Rounded so that responses show plain numbers (0.05, not 0.04999999999999999).
const round = (x: number) => Math.round(x * 1e4) / 1e4;

function spread(keys: string[], first: number): Record<string, number> {
  const rest = keys.length > 1 ? round((1 - first) / (keys.length - 1)) : 0;
  return Object.fromEntries(keys.map((k, i) => [k, i === 0 ? first : rest]));
}

export class MockAdapter implements ModelAdapter {
  async decide(request: ModelRequest): Promise<ModelResponse> {
    const answers: Record<string, ModelAnswer> = {};
    for (const [name, q] of Object.entries(request.questions)) {
      switch (q.type) {
        case 'noul':
          answers[name] = { type: 'noul', noul: 0.2 };
          break;
        case 'choice': {
          const options = Object.keys(q.criteria);
          answers[name] = {
            type: 'choice',
            choice: options[0]!,
            probabilities: spread(options, 0.9),
            confidence: 0.8,
          };
          break;
        }
        case 'score': {
          const levels = q.criteria.map((_, i) => String(i));
          const probabilities = spread(levels, 0.7);
          answers[name] = {
            type: 'score',
            score: round(levels.reduce((sum, l) => sum + Number(l) * probabilities[l]!, 0)),
            legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
            probabilities,
            confidence: 0.6,
          };
          break;
        }
      }
    }
    return { model: 'mock', answers };
  }
}
