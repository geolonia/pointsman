// Callbacks: when a review is resolved, the final answer is POSTed to the
// decision's callback_url.
//
// Each request is signed with HMAC-SHA256 over "<timestamp>.<body>" using the
// Worker secret CALLBACK_SECRET:
//
//   x-pointsman-timestamp: 1767225600
//   x-pointsman-signature: sha256=<hex>
//
// The client checks the signature with the same secret and rejects old
// timestamps (replay). The signed body names the client that made the
// decision and the callback_url it gave, so a receiver can refuse a callback
// that another client asked for (one secret signs for every client).
// Delivery is tried right after the resolve, then retried by the scheduled
// handler with growing delays; every attempt is recorded, so the status is
// visible in GET /v1/decisions/{id}.

import type { CallbackState, DecisionRecord } from './log';

/** Delay before attempt n+1 (index = attempts so far); after the last, give up. */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200];
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
const TIMEOUT_MS = 10_000;

export interface CallbackPayload {
  decision_id: string;
  /** The client that made the decision (the token's client name, or INTERNAL_CLIENT). */
  client: string;
  /** The URL this callback was sent to, as the client gave it. */
  callback_url: string;
  ref?: string;
  profile: string;
  profile_version: number;
  action: string;
  answers: Record<string, { value: unknown; source: 'model' | 'human' }>;
  resolved_by: string;
  resolved_at: string;
}

export function payloadFor(d: DecisionRecord): CallbackPayload {
  const review = d.review!;
  return {
    decision_id: d.decision_id,
    client: d.client,
    callback_url: d.callback_url!,
    ...(d.ref !== undefined && { ref: d.ref }),
    profile: d.profile,
    profile_version: d.profile_version,
    action: review.final_action!,
    answers: review.final_answers!,
    resolved_by: review.resolved_by!,
    resolved_at: review.resolved_at!,
  };
}

export async function sign(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One delivery attempt; returns the new callback state to record. */
export async function attempt(
  d: DecisionRecord,
  { secret, fetch, clock }: { secret: string | undefined; fetch: Fetch; clock: () => Date },
): Promise<CallbackState> {
  let error: string;
  if (!secret) {
    // Never send unsigned callbacks; the state shows why nothing was sent.
    error = 'CALLBACK_SECRET is not set';
  } else {
    const body = JSON.stringify(payloadFor(d));
    // Signed just before the send, so a slow batch never sends old signatures.
    const timestamp = Math.floor(clock().getTime() / 1000);
    try {
      const res = await fetch(d.callback_url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'pointsman-callback',
          'x-pointsman-timestamp': String(timestamp),
          'x-pointsman-signature': `sha256=${await sign(secret, timestamp, body)}`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return { status: 'delivered', attempts: (d.callback?.attempts ?? 0) + 1 };
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return failedAttempt(d, error, clock);
}

/** The state after an attempt that failed with `error`: retry later, or give up after the last. */
export function failedAttempt(d: DecisionRecord, error: string, clock: () => Date): CallbackState {
  const attempts = (d.callback?.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) return { status: 'failed', attempts, last_error: error };
  // Counted from the end of this attempt.
  const next = new Date(clock().getTime() + RETRY_DELAYS_S[attempts - 1]! * 1000).toISOString();
  return { status: 'pending', attempts, last_error: error, next_at: next };
}
