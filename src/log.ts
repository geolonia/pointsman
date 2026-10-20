// Decision log: every decision with its profile version and model, and the
// feedback (corrections) people send for it. Stored in D1; the schema is in
// migrations/. See docs/decision-log.md.

import type { Answer, Fact } from './types';

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

interface DecisionRow {
  id: string;
  created_at: string;
  client: string;
  ref: string | null;
  profile_id: string;
  profile_version: number;
  model: string;
  action: string;
  rule: number | null;
  answers: string;
  facts: string | null;
  state_hash: string;
  state: string | null;
  callback_url: string | null;
  review_status: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  final_action: string | null;
  final_answers: string | null;
  callback_status: string | null;
  callback_attempts: number;
  callback_last_error: string | null;
  callback_next_at: string | null;
  requires: string | null;
  idempotency_key: string | null;
  request_digest: string | null;
  replaces: string | null;
  discarded_at: string | null;
}

function fromRow(row: DecisionRow): DecisionRecord {
  return {
    decision_id: row.id,
    created_at: row.created_at,
    client: row.client,
    ...(row.ref !== null && { ref: row.ref }),
    profile: row.profile_id,
    profile_version: row.profile_version,
    model: row.model,
    action: row.action,
    rule: row.rule,
    answers: JSON.parse(row.answers) as Record<string, Answer>,
    ...(row.facts !== null && { facts: JSON.parse(row.facts) as Record<string, Fact> }),
    state_hash: row.state_hash,
    ...(row.state !== null && { state: JSON.parse(row.state) as unknown }),
    ...(row.callback_url !== null && { callback_url: row.callback_url }),
    ...(row.review_status !== null && {
      review: {
        status: row.review_status as Review['status'],
        ...(row.resolved_at !== null && { resolved_at: row.resolved_at }),
        ...(row.resolved_by !== null && { resolved_by: row.resolved_by }),
        ...(row.final_action !== null && { final_action: row.final_action }),
        ...(row.final_answers !== null && { final_answers: JSON.parse(row.final_answers) as Record<string, FinalAnswer> }),
      },
    }),
    ...(row.requires !== null && { requires: JSON.parse(row.requires) as Record<string, RequiredSnapshot> }),
    ...(row.idempotency_key !== null && { idempotency_key: row.idempotency_key }),
    ...(row.request_digest !== null && { request_digest: row.request_digest }),
    ...(row.replaces !== null && { replaces: row.replaces }),
    ...(row.discarded_at !== null && { discarded_at: row.discarded_at }),
    ...(row.callback_status !== null && {
      callback: {
        status: row.callback_status as CallbackState['status'],
        attempts: row.callback_attempts,
        ...(row.callback_last_error !== null && { last_error: row.callback_last_error }),
        ...(row.callback_next_at !== null && { next_at: row.callback_next_at }),
      },
    }),
  };
}

interface FeedbackRow {
  created_at: string;
  client: string;
  by: string;
  correct: string;
  note: string | null;
}

/** A decision that counts: not replaced by a newer one. */
const COUNTS = "(review_status IS NULL OR review_status != 'superseded') AND discarded_at IS NULL";
// Decisions of one millisecond are ordered by when they were inserted (rowid).

export class D1DecisionLog implements DecisionLog {
  db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async insert(r: DecisionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO decisions (id, created_at, client, ref, profile_id, profile_version, model, action,
           rule, answers, facts, state_hash, state, callback_url, review_status, requires, idempotency_key, request_digest, replaces)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.decision_id, r.created_at, r.client, r.ref ?? null, r.profile, r.profile_version, r.model,
        r.action, r.rule, JSON.stringify(r.answers), r.facts === undefined ? null : JSON.stringify(r.facts), r.state_hash,
        r.state === undefined ? null : JSON.stringify(r.state), r.callback_url ?? null,
        // The caller decides whether a person checks it (the profile's people_check).
        r.review?.status === 'pending' ? 'pending' : null,
        r.requires === undefined ? null : JSON.stringify(r.requires), r.idempotency_key ?? null, r.request_digest ?? null,
        r.replaces ?? null,
      )
      .run();
  }

  async byIdempotencyKey(client: string, key: string): Promise<DecisionRecord | null> {
    const row = await this.db.prepare('SELECT * FROM decisions WHERE client = ? AND idempotency_key = ?').bind(client, key).first<DecisionRow>();
    return row ? fromRow(row) : null;
  }

  async latestFor(profile: string, ref: string, client: string): Promise<DecisionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM decisions WHERE profile_id = ? AND ref = ? AND client = ? AND ${COUNTS}
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(profile, ref, client)
      .first<DecisionRow>();
    return row ? fromRow(row) : null;
  }

  async supersede(d: Pick<DecisionRecord, 'decision_id' | 'profile' | 'ref' | 'client' | 'created_at'>): Promise<string[]> {
    if (d.ref === undefined) return [];
    const { results } = await this.db
      .prepare(
        `UPDATE decisions SET review_status = 'superseded'
         WHERE profile_id = ? AND ref = ? AND client = ? AND review_status = 'pending' AND id != ?
           AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM decisions WHERE id = ?)))
         RETURNING id`,
      )
      .bind(d.profile, d.ref, d.client, d.decision_id, d.created_at, d.created_at, d.decision_id)
      .run<{ id: string }>();
    return results.map((r) => r.id);
  }

  async discard(decisionId: string, at: string): Promise<void> {
    // An open review of it leaves the queue; a resolved one stays as it was.
    await this.db
      .prepare(
        `UPDATE decisions SET discarded_at = COALESCE(discarded_at, ?),
           review_status = CASE WHEN review_status = 'pending' THEN 'superseded' ELSE review_status END,
           callback_status = NULL, callback_next_at = NULL
         WHERE id = ?`,
      )
      .bind(at, decisionId)
      .run();
  }

  async get(id: string) {
    const [decisions, feedback] = await this.db.batch([
      this.db.prepare('SELECT * FROM decisions WHERE id = ?').bind(id),
      this.db.prepare('SELECT created_at, client, by, correct, note FROM feedback WHERE decision_id = ? ORDER BY id').bind(id),
    ]);
    const row = (decisions!.results as unknown as DecisionRow[])[0];
    if (!row) return null;
    return {
      ...fromRow(row),
      feedback: (feedback!.results as unknown as FeedbackRow[]).map((f) => ({
        created_at: f.created_at,
        client: f.client,
        by: f.by,
        correct: JSON.parse(f.correct) as Record<string, unknown>,
        ...(f.note !== null && { note: f.note }),
      })),
    };
  }

  async addFeedback(decisionId: string, f: FeedbackRecord): Promise<void> {
    await this.db
      .prepare('INSERT INTO feedback (decision_id, created_at, client, by, correct, note) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(decisionId, f.created_at, f.client, f.by, JSON.stringify(f.correct), f.note ?? null)
      .run();
  }

  async stats(profile: string, since: string): Promise<ProfileStats> {
    const [actions, reviews, corrected] = await this.db.batch<{ k: string | null; k2?: string | null; n: number }>([
      // Discarded decisions never count (the client got 409 for them).
      this.db.prepare('SELECT action AS k, COUNT(*) AS n FROM decisions WHERE profile_id = ? AND created_at >= ? AND discarded_at IS NULL GROUP BY action').bind(profile, since),
      this.db.prepare(
        `SELECT review_status AS k, final_action AS k2, COUNT(*) AS n FROM decisions
         WHERE profile_id = ? AND created_at >= ? AND review_status IS NOT NULL AND discarded_at IS NULL GROUP BY review_status, final_action`,
      ).bind(profile, since),
      // As in docs/accuracy.sql: a correction that changes at least one answer.
      this.db.prepare(
        `SELECT NULL AS k, COUNT(DISTINCT d.id) AS n FROM decisions d JOIN feedback f ON f.decision_id = d.id
         WHERE d.profile_id = ? AND d.created_at >= ? AND d.discarded_at IS NULL AND EXISTS (
           SELECT 1 FROM json_each(f.correct) c
           WHERE c.value IS NOT json_extract(d.answers, '$."' || c.key || '".value'))`,
      ).bind(profile, since),
    ]);
    const stats: ProfileStats = { decisions: 0, actions: {}, reviews: { pending: 0, resolved: 0, superseded: 0, final_actions: {} }, corrected: corrected!.results[0]?.n ?? 0 };
    for (const r of actions!.results) {
      stats.actions[String(r.k)] = r.n;
      stats.decisions += r.n;
    }
    for (const r of reviews!.results) {
      if (r.k === 'pending') stats.reviews.pending += r.n;
      if (r.k === 'superseded') stats.reviews.superseded += r.n;
      if (r.k === 'resolved') {
        stats.reviews.resolved += r.n;
        // One row per final action (GROUP BY): assigned, never read back.
        if (r.k2) stats.reviews.final_actions[r.k2] = r.n;
      }
    }
    return stats;
  }

  async pendingReviews(profiles: string[], limit: number): Promise<DecisionRecord[]> {
    const all = profiles.includes('*');
    if (!all && profiles.length === 0) return [];
    const where = all ? '' : ` AND profile_id IN (${profiles.map(() => '?').join(', ')})`;
    const { results } = await this.db
      .prepare(`SELECT * FROM decisions WHERE review_status = 'pending'${where} ORDER BY created_at, id LIMIT ?`)
      .bind(...(all ? [] : profiles), limit)
      .all<DecisionRow>();
    return results.map(fromRow);
  }

  async resolve(decisionId: string, r: Resolution): Promise<boolean> {
    // The UPDATE only matches a pending review, so two people resolving at
    // the same time cannot both succeed; the feedback row is written in the
    // same batch (one transaction) and only when the UPDATE matched.
    const statements = [
      this.db.prepare(
        `UPDATE decisions SET review_status = 'resolved', resolved_at = ?, resolved_by = ?, resolved_client = ?,
           final_action = ?, final_answers = ?,
           callback_status = CASE WHEN callback_url IS NULL THEN NULL ELSE 'pending' END,
           callback_next_at = CASE WHEN callback_url IS NULL THEN NULL ELSE ? END
         WHERE id = ? AND review_status = 'pending' AND discarded_at IS NULL
           -- A decision that a newer one replaced cannot be resolved, also
           -- when the newer one was logged a moment ago (it names it in replaces).
           AND NOT EXISTS (SELECT 1 FROM decisions AS n WHERE n.replaces = decisions.id AND n.discarded_at IS NULL)`,
      ).bind(r.resolved_at, r.resolved_by, r.client, r.final_action, JSON.stringify(r.final_answers),
        r.callback_next_at ?? r.resolved_at, decisionId),
    ];
    if (Object.keys(r.correct).length > 0) {
      statements.push(this.db.prepare(
        `INSERT INTO feedback (decision_id, created_at, client, by, correct, note)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ).bind(decisionId, r.resolved_at, r.client, r.resolved_by, JSON.stringify(r.correct), r.note ?? null));
    }
    const [update] = await this.db.batch(statements);
    return (update!.meta.changes ?? 0) === 1;
  }

  async dueCallbacks(now: string, limit: number): Promise<DecisionRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM decisions WHERE callback_status = 'pending' AND callback_next_at <= ? ORDER BY callback_next_at LIMIT ?`)
      .bind(now, limit)
      .all<DecisionRow>();
    return results.map(fromRow);
  }

  async claimCallback(decisionId: string, c: { id: string; now: string; leaseUntil: string; attempts: number }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE decisions SET callback_claim = ?, callback_next_at = ?
         WHERE id = ? AND callback_status = 'pending' AND callback_next_at <= ? AND callback_attempts = ?`,
      )
      .bind(c.id, c.leaseUntil, decisionId, c.now, c.attempts)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async recordCallback(decisionId: string, c: CallbackState, claimId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE decisions SET callback_status = ?, callback_attempts = ?, callback_last_error = ?, callback_next_at = ?,
           callback_claim = NULL
         WHERE id = ? AND callback_claim = ?`,
      )
      .bind(c.status, c.attempts, c.last_error ?? null, c.next_at ?? null, decisionId, claimId)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }
}
