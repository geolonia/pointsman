// Decision log: every decision with its profile version and model, and the
// feedback (corrections) people send for it. See docs/decision-log.md. The
// interface is here; the D1 store is in src/log-d1.ts.

import type { Answer, DecisionVersions, Fact } from './types';

export interface DecisionRecord {
  decision_id: string;
  created_at: string;
  client: string;
  ref?: string;
  profile: string;
  profile_version: number;
  model: string;
  action: string;
  /** Index of the matching policy rule; null when the default action applied. */
  rule: number | null;
  answers: Record<string, Answer>;
  /** Only for profiles with facts: what was looked up, or why it is missing. */
  facts?: Record<string, Fact>;
  state_hash: string;
  /** Only when the profile sets log.store_state. */
  state?: unknown;
  callback_url?: string;
  /** Set for decisions whose action a person checks (the profile's people_check). */
  review?: Review;
  /** For profiles with requires: what the rules read from each required decision, at decide time. */
  requires?: Record<string, RequiredSnapshot>;
  /** A repeated request with this key from the same client gets this decision again. */
  idempotency_key?: string;
  /** Digest of the request: profile and version, state, ref, decisions. */
  request_digest?: string;
  /** The earlier decision of the same profile, ref and client that this one replaced. */
  replaces?: string;
  /** Made while a person resolved the decision it would replace: it never counts (409 resolved_by_person). */
  discarded_at?: string;
  /** Set when the decision has a callback_url and a callback was due. */
  callback?: CallbackState;
  /** The engine and fact modules that made it; missing for decisions made before fact modules. */
  versions?: DecisionVersions;
}

export interface FinalAnswer {
  value: unknown;
  /** "human" when the reviewer changed or confirmed it explicitly. */
  source: 'model' | 'human';
}

/** One required decision as it was used (docs/decision-chains.md "What is logged"). */
export interface RequiredSnapshot {
  decision: string;
  profile: string;
  profile_version: number;
  action: string;
  outcome: string;
  reviewed: boolean;
  /** Every value the rules read from it, by path; null = unknown. */
  read: Record<string, string | number | boolean | null>;
}

export interface Review {
  /** superseded: a newer decision replaced it while the review was open. */
  status: 'pending' | 'resolved' | 'superseded';
  resolved_at?: string;
  resolved_by?: string;
  final_action?: string;
  final_answers?: Record<string, FinalAnswer>;
}

export interface CallbackState {
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error?: string;
  next_at?: string;
}

export interface Resolution {
  resolved_at: string;
  resolved_by: string;
  client: string;
  final_action: string;
  final_answers: Record<string, FinalAnswer>;
  /** Stored as feedback when not empty. */
  correct: Record<string, unknown>;
  note?: string;
  /** Set when the decision has a callback_url: the first attempt is due now. */
  callback_next_at?: string;
}

export interface FeedbackRecord {
  created_at: string;
  client: string;
  by: string;
  correct: Record<string, unknown>;
  note?: string;
}

/** What happened to a profile's decisions since a time (GET /v1/stats). */
export interface ProfileStats {
  decisions: number;
  /** Decisions per action. */
  actions: Record<string, number>;
  /** Decisions that went to the review queue: still pending, resolved, and the final actions people chose. */
  reviews: { pending: number; resolved: number; superseded: number; final_actions: Record<string, number> };
  /** Decisions where a person corrected at least one answer (feedback or review). */
  corrected: number;
}

export interface DecisionLog {
  insert(record: DecisionRecord): Promise<void>;
  /** Counts for one profile, decisions made at or after `since` (ISO 8601). */
  stats(profile: string, since: string): Promise<ProfileStats>;
  get(id: string): Promise<(DecisionRecord & { feedback: FeedbackRecord[] }) | null>;
  addFeedback(decisionId: string, feedback: FeedbackRecord): Promise<void>;
  /** Pending reviews, oldest first, for the given profile ids ("*" = all). */
  pendingReviews(profiles: string[], limit: number): Promise<DecisionRecord[]>;
  /**
   * The newest decisions of one profile version, newest first, for a replay
   * (src/replay.ts). Superseded decisions are included (they were made);
   * discarded ones are not (they never counted).
   */
  recent(profile: string, version: number, limit: number): Promise<DecisionRecord[]>;
  /** Resolve a pending review. False when it is not pending (any more). */
  resolve(decisionId: string, resolution: Resolution): Promise<boolean>;
  /** The decision a client made with this idempotency key, if any. */
  byIdempotencyKey(client: string, key: string): Promise<DecisionRecord | null>;
  /** The newest decision of a profile for a ref and client that counts (not superseded), if any. */
  latestFor(profile: string, ref: string, client: string): Promise<DecisionRecord | null>;
  /**
   * Mark the open reviews of the decisions that `decision` replaces (same
   * profile, ref and client, made at or before it) as superseded. Returns their ids.
   */
  supersede(decision: Pick<DecisionRecord, 'decision_id' | 'profile' | 'ref' | 'client' | 'created_at'>): Promise<string[]>;
  /** Mark one decision as discarded: it never counts (a person resolved the one it would replace). */
  discard(decisionId: string, at: string): Promise<void>;
  /** Decisions whose callback is pending and due at or before `now`. */
  dueCallbacks(now: string, limit: number): Promise<DecisionRecord[]>;
  /**
   * Claim a due callback before sending it: true only for one caller, and
   * only while the callback is still pending, due at `now`, and at the
   * attempt count the caller read. The claim holds it until `leaseUntil`.
   */
  claimCallback(decisionId: string, claim: { id: string; now: string; leaseUntil: string; attempts: number }): Promise<boolean>;
  /** Record the result of an attempt; ignored unless `claimId` still holds the claim. */
  recordCallback(decisionId: string, state: CallbackState, claimId: string): Promise<boolean>;
}

/** JSON with sorted object keys, so equal states hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // JSON.stringify gives undefined for undefined, functions and symbols; JSON
  // writes those as null inside arrays, so do the same everywhere.
  return JSON.stringify(value) ?? 'null';
}

export async function hashState(state: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(state)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

