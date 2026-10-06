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

export interface ResolutionInput extends Feedback {
  action: string;
}

const ACTION = /^[a-z][a-z0-9_-]{0,62}$/;

/** Returns the feedback, or an error message. */
export function parseFeedback(body: unknown, profile: Profile): Feedback | string {
  return parse(body, profile, { resolution: false }) as Feedback | string;
}

/**
 * A review resolution: the final `action`, who resolved it, and optionally
 * corrected answers (`correct` may be empty: the model's answers are kept).
 */
export function parseResolution(body: unknown, profile: Profile): ResolutionInput | string {
  return parse(body, profile, { resolution: true }) as ResolutionInput | string;
}

function parse(body: unknown, profile: Profile, { resolution }: { resolution: boolean }): Feedback | ResolutionInput | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  const fields = resolution ? ['action', 'correct', 'by', 'note'] : ['correct', 'by', 'note'];
  for (const key of Object.keys(b)) {
    if (!fields.includes(key)) return `unknown field "${key}"`;
  }
  if (resolution && (typeof b.action !== 'string' || !ACTION.test(b.action) || b.action === 'review')) {
    return '"action" must be the final action, e.g. "auto" (lower case; not "review")';
  }
  if (typeof b.by !== 'string' || b.by.trim() === '' || b.by.length > MAX_BY) {
    return `"by" must be a string of 1 to ${MAX_BY} characters`;
  }
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > MAX_NOTE)) {
    return `"note" must be a string of at most ${MAX_NOTE} characters`;
  }
  const correct = resolution && b.correct === undefined ? {} : b.correct;
  if (correct === null || typeof correct !== 'object' || Array.isArray(correct)
    || (!resolution && Object.keys(correct).length === 0)) {
    return resolution ? '"correct" must be an object' : '"correct" must be an object with at least one question';
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
    ...(resolution && { action: b.action as string }),
    correct: correct as Feedback['correct'],
    by: b.by,
    ...(b.note !== undefined && { note: b.note as string }),
  };
}
