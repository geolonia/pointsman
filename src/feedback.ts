// Validate feedback against the profile version the decision used, so that
// corrections can be compared with answers later (accuracy per version).

import type { Profile } from './types';

export interface Feedback {
  correct: Record<string, boolean | string | number>;
  by: string;
  note?: string;
}

const MAX_BY = 100;
const MAX_NOTE = 1000;

/** Returns the feedback, or an error message. */
export function parseFeedback(body: unknown, profile: Profile): Feedback | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!['correct', 'by', 'note'].includes(key)) return `unknown field "${key}"`;
  }
  if (typeof b.by !== 'string' || b.by.trim() === '' || b.by.length > MAX_BY) {
    return `"by" must be a string of 1 to ${MAX_BY} characters`;
  }
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > MAX_NOTE)) {
    return `"note" must be a string of at most ${MAX_NOTE} characters`;
  }
  const correct = b.correct;
  if (correct === null || typeof correct !== 'object' || Array.isArray(correct) || Object.keys(correct).length === 0) {
    return '"correct" must be an object with at least one question';
  }
  for (const [name, value] of Object.entries(correct)) {
    const q = profile.questions.find((x) => x.name === name);
    if (!q) return `"correct": "${name}" is not a question of profile ${profile.id} version ${profile.version}`;
    switch (q.type) {
      case 'noul':
        if (typeof value !== 'boolean') return `"correct.${name}" must be true or false`;
        break;
      case 'choice':
        if (!q.criteria.some((c) => c.value === value)) {
          return `"correct.${name}" must be one of: ${q.criteria.map((c) => c.value).join(', ')}`;
        }
        break;
      case 'score':
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= q.criteria.length) {
          return `"correct.${name}" must be a level from 0 to ${q.criteria.length - 1}`;
        }
        break;
    }
  }
  return {
    correct: correct as Feedback['correct'],
    by: b.by,
    ...(b.note !== undefined && { note: b.note as string }),
  };
}
