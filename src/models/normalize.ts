// Normalize model answers to the engine's answer format, where `p` is always
// the probability of `value`:
//
// - noul:   value = yes (true) when P(yes) >= 0.5; p = P(value); yes = P(yes)
// - choice: value = the top option; p = its probability
// - score:  value = the most likely level (0 = lowest); p = its probability;
//           score = the probability-weighted level from the model
//
// Answers are checked against the profile, so a backend that returns an
// unknown option or misses a question fails loudly instead of driving an
// action.

import type { Answer, Profile } from '../types';
import { ModelError, type ModelAnswer, type ModelResponse } from './adapter';

function isProbability(x: unknown): x is number {
  return typeof x === 'number' && x >= 0 && x <= 1;
}

function top(probabilities: Record<string, number>): [string, number] {
  let best: [string, number] | undefined;
  for (const [k, v] of Object.entries(probabilities)) {
    // Keys come from the model's response: they are not put into messages,
    // which are logged, so a backend echoing its input cannot leak it there.
    if (!isProbability(v)) throw new ModelError('invalid probability');
    if (!best || v > best[1]) best = [k, v];
  }
  if (!best) throw new ModelError('empty probabilities');
  return best;
}

function checkKeys(name: string, probabilities: Record<string, number>, allowed: string[]): void {
  for (const k of Object.keys(probabilities)) {
    if (!allowed.includes(k)) throw new ModelError(`question "${name}": unknown option in the answer`);
  }
}

export function normalizeAnswers(profile: Profile, response: ModelResponse): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const q of profile.questions) {
    const a: ModelAnswer | undefined = response.answers?.[q.name];
    if (!a || a.type !== q.type) {
      throw new ModelError(`question "${q.name}": missing or wrong answer type`);
    }
    switch (a.type) {
      case 'noul': {
        if (!isProbability(a.noul)) throw new ModelError(`question "${q.name}": invalid noul`);
        const value = a.noul >= 0.5;
        answers[q.name] = { type: 'noul', value, p: value ? a.noul : 1 - a.noul, yes: a.noul };
        break;
      }
      case 'choice': {
        if (q.type !== 'choice') break;
        checkKeys(q.name, a.probabilities ?? {}, q.criteria.map((c) => c.value));
        const [value, p] = top(a.probabilities ?? {});
        answers[q.name] = { type: 'choice', value, p, probabilities: a.probabilities };
        break;
      }
      case 'score': {
        if (q.type !== 'score') break;
        checkKeys(q.name, a.probabilities ?? {}, q.criteria.map((_, i) => String(i)));
        const [level, p] = top(a.probabilities ?? {});
        const maxLevel = q.criteria.length - 1;
        if (!Number.isFinite(a.score) || a.score < 0 || a.score > maxLevel) {
          throw new ModelError(`question "${q.name}": score outside 0..${maxLevel}`);
        }
        answers[q.name] = {
          type: 'score',
          value: Number(level),
          p,
          score: a.score,
          probabilities: a.probabilities,
        };
        break;
      }
    }
  }
  return answers;
}
