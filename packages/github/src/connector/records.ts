// What the object of a pull request keeps in its storage (pull-request.ts):
// the storage it needs, the records of its actions, approvals, check runs,
// kept decisions, questions to a person and decision comment, and the small
// form of a decision those records keep (slim). answers.ts reads some of
// them too.

import type { Decision } from './engine.ts';
import type { HeadReviews } from './comment.ts';
import type { CheckRunOutput, OwnApproval } from './github.ts';

/** What a run needs of the object's storage (a Durable Object's storage has it). */
export interface ObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  /** Writes these keys at once. */
  put(entries: Record<string, unknown>): Promise<void>;
  /** Run `run()` at this time (a Durable Object alarm). */
  setAlarm(at: number): Promise<void>;
}

/**
 * The actions done on one head, by profile and kind: written as `pending`
 * before the action, `done` after it. A new head starts with none.
 */
export interface Acts {
  head: string;
  /** `base`: the base branch it was done on (none in older records): an approval on another base is settled and dismissed (#settleOtherBase). */
  done: Record<string, { decision: string; state: 'pending' | 'done' | 'failed'; at: number; base?: string }>;
}

/** The approvals the connector gave and that may still stand: only these are ever dismissed. */
export interface Given extends OwnApproval {
  profile: string;
  /** The base branch it was given on (none in older records): on another base it is dismissed, as after a push. */
  base?: string;
}

/** The check runs of one head, by profile: `id` once created; without it, a create may have happened. */
export interface Checks {
  head: string;
  runs: Record<string, { decision: string; id?: number }>;
}

/** Decisions kept for once_per_head, by profile: for this head, and the title, body and base they were asked with. */
export interface Kept {
  head: string;
  byProfile: Record<string, { key: string; decision: Decision }>;
}

/**
 * The decision comment (docs/github-connector.md#the-decision-comment): the
 * latest decision shown for each profile on this head, and the comment's
 * state. `pending` is the hash of a body being written (recorded before the
 * write); `hash` the body last written; `failed` a body GitHub refused, not
 * tried again.
 */
export interface CommentRecord {
  head: string;
  entries: Record<string, Decision>;
  id?: number;
  hash?: string;
  pending?: string;
  failed?: string;
}

/**
 * The decisions a person is asked about (docs/github-connector.md#asking-a-person),
 * by profile: kept for this head, read back on every run until the person
 * answered, and never replaced by a new decision on the same head. `close`:
 * the pending ones of an older head (or of a closed pull request), still to
 * be closed in Pointsman.
 */
export interface Asked {
  head: string;
  /**
   * The decision, and the hash of what it rests on besides the head (#basisOf);
   * `offered`: the answers offered in the pull request (answers.ts), when answers are on for the profile;
   * `base`: the base branch it was asked on (answers.ts refuses an answer once it changed; none in older records).
   */
  byProfile: Record<string, { decision: Decision; basis: string; offered?: string[]; base?: string }>;
  /** `since`: when it was listed; `tries`: closes that failed so far; `lastTry`: when the last one failed. */
  close: { id: string; since: number; tries: number; lastTry: number }[];
}

/** The output last written to a profile's check run on a head (`shown:<profile>`): a note on it (answers.ts) or its buttons removed keep the rest. */
export interface Shown {
  head: string;
  output: CheckRunOutput;
}

/** A removal of an older head's buttons, still to be done (#clearButtons). */
export interface Clearing {
  id: number;
  profile: string;
  /** The head of the check run. */
  head: string;
  output: CheckRunOutput;
  tries: number;
}

/** What the reviews said about a head when they were last read: kept for a run that cannot read them. */
export interface ReviewsSeen {
  head: string;
  state: HeadReviews;
}

/** Rechecks scheduled for this head, by profile. */
export interface Rechecks {
  head: string;
  count: Record<string, number>;
}

/** An AI answer as the comment keeps it: its type and a small value of a known shape, or nothing. */
function slimAnswer(a: unknown): { type: string; value: boolean | string | number } | undefined {
  if (a === null || typeof a !== 'object') return undefined;
  const { type, value } = a as { type?: unknown; value?: unknown };
  if (type === 'noul' && typeof value === 'boolean') return { type, value };
  if (type === 'choice' && typeof value === 'string') return { type, value: value.slice(0, 65) };
  if (type === 'score' && typeof value === 'number' && Number.isSafeInteger(value)) return { type, value };
  return undefined;
}

/** What the comment keeps of a decision: what it shows, nothing more (no fact values), each part small. */
export function slim(d: Decision): Decision {
  const answers = d.answers !== null && typeof d.answers === 'object' && !Array.isArray(d.answers)
    ? Object.fromEntries(Object.entries(d.answers as Record<string, unknown>).filter(([k]) => k.length <= 64).slice(0, 20)
      .map(([k, a]) => [k, slimAnswer(a)]).filter(([, a]) => a !== undefined))
    : undefined;
  return {
    decision_id: d.decision_id, action: d.action, profile: d.profile, profile_version: d.profile_version, rule: d.rule,
    ...(typeof d.answered_by === 'string' && LOGIN.test(d.answered_by) && { answered_by: d.answered_by }),
    ...(d.facts && { facts: Object.fromEntries(Object.entries(d.facts).slice(0, 50).map(([k, f]) => [k, { ...(f.missing !== undefined && { missing: f.missing }), ...(f.reason !== undefined && { reason: f.reason.slice(0, 100) }) }])) }),
    ...(d.review && { review: { status: d.review.status, ...(typeof d.review.final_action === 'string' && { final_action: d.review.final_action }) } }),
    ...(answers && { answers }),
  };
}

export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
