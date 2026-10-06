// Decision log: every decision with its profile version and model, and the
// feedback (corrections) people send for it. Stored in D1; the schema is in
// migrations/. See docs/decision-log.md.

import type { Answer } from './types';

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
  state_hash: string;
  /** Only when the profile sets log.store_state. */
  state?: unknown;
  callback_url?: string;
}

export interface FeedbackRecord {
  created_at: string;
  client: string;
  by: string;
  correct: Record<string, unknown>;
  note?: string;
}

export interface DecisionLog {
  insert(record: DecisionRecord): Promise<void>;
  get(id: string): Promise<(DecisionRecord & { feedback: FeedbackRecord[] }) | null>;
  addFeedback(decisionId: string, feedback: FeedbackRecord): Promise<void>;
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
  state_hash: string;
  state: string | null;
  callback_url: string | null;
}

interface FeedbackRow {
  created_at: string;
  client: string;
  by: string;
  correct: string;
  note: string | null;
}

export class D1DecisionLog implements DecisionLog {
  db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async insert(r: DecisionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO decisions (id, created_at, client, ref, profile_id, profile_version, model, action,
           rule, answers, state_hash, state, callback_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.decision_id, r.created_at, r.client, r.ref ?? null, r.profile, r.profile_version, r.model,
        r.action, r.rule, JSON.stringify(r.answers), r.state_hash,
        r.state === undefined ? null : JSON.stringify(r.state), r.callback_url ?? null,
      )
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
      state_hash: row.state_hash,
      ...(row.state !== null && { state: JSON.parse(row.state) as unknown }),
      ...(row.callback_url !== null && { callback_url: row.callback_url }),
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
}
