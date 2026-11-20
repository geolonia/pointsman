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
// action. A probability map must name every option (or level) and add up to
// 1 within a margin (src/probability.ts): rules read probabilities.<option>, and a map such as
// {low: 1} or {low: 1, high: 1} is not an answer.

import type { Answer, Profile } from '../types';
import { ModelError, type ModelAnswer, type ModelResponse } from './adapter';
import { addsUpToOne } from '../probability';


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

/** A plain object with exactly the allowed keys, each a probability, adding up to 1. */
function checkProbabilities(name: string, probabilities: unknown, allowed: string[]): Record<string, number> {
  if (typeof probabilities !== 'object' || probabilities === null || Array.isArray(probabilities)) {
    throw new ModelError(`question "${name}": probabilities must be a map of options`);
  }
  const map = probabilities as Record<string, unknown>;
  for (const k of Object.keys(map)) {
    if (!allowed.includes(k)) throw new ModelError(`question "${name}": unknown option in the answer`);
  }
  if (!allowed.every((k) => Object.hasOwn(map, k))) throw new ModelError(`question "${name}": an option is missing from the answer`);
  for (const v of Object.values(map)) {
    if (!isProbability(v)) throw new ModelError(`question "${name}": invalid probability`);
  }
  if (!addsUpToOne(Object.values(map) as number[], allowed.length)) throw new ModelError(`question "${name}": probabilities do not add up to 1`);
  return map as Record<string, number>;
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
        const probabilities = checkProbabilities(q.name, a.probabilities, q.criteria.map((c) => c.value));
        const [value, p] = top(probabilities);
        answers[q.name] = { type: 'choice', value, p, probabilities };
        break;
      }
      case 'score': {
        if (q.type !== 'score') break;
        const probabilities = checkProbabilities(q.name, a.probabilities, q.criteria.map((_, i) => String(i)));
        const [level, p] = top(probabilities);
        const maxLevel = q.criteria.length - 1;
        if (!Number.isFinite(a.score) || a.score < 0 || a.score > maxLevel) {
          throw new ModelError(`question "${q.name}": score outside 0..${maxLevel}`);
        }
        answers[q.name] = {
          type: 'score',
          value: Number(level),
          p,
          score: a.score,
          probabilities,
        };
        break;
      }
    }
  }
  return answers;
}
