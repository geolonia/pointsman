// Reviews resolved in the broker (#83): a person resolves a Decision entity,
// the FIWARE bridge (bridge.ts) resolves the review in Pointsman, then writes
// the final action to the entity's result and completes its Task.

import { brokerRequest, readHeaders, updatedAll, writeAttribute } from './broker.ts';
import { DECISION_TERMS } from './decision-entity.ts';
import type { Route } from './routes.ts';
import { retryable, send, USER_AGENT } from './send.ts';
import { CORE_CONTEXT, type Entity, P, TASK_CONTEXT, valueOf } from './shared.ts';
import { taskEntityId } from './tasks.ts';
import type { BridgeConfig, EntityResult, ReviewOutcome } from './types.ts';

const DECISION_NS = 'https://datamodels.jp/ns/decision/';

export function isDecision(e: unknown): e is Entity {
  const x = e as Entity | undefined;
  return typeof x?.id === 'string' && x.id.startsWith('urn:ngsi-ld:Decision:') && (x.type === 'Decision' || x.type === `${DECISION_NS}Decision`)
    && !('deletedAt' in x);
}

/**
 * An attribute of a Decision entity: by its short name (a subscription with
 * the Decision context), or by its full IRI (without one).
 */
function decisionAttr(e: Entity, name: string): Record<string, unknown> | undefined {
  const term = DECISION_TERMS[name];
  const iri = (typeof term === 'string' ? term : term?.['@id'])?.replace(/^decision:/, DECISION_NS).replace(/^prov:/, 'http://www.w3.org/ns/prov#');
  const a = e[name] ?? (iri ? e[iri] : undefined);
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : undefined;
}

/** A date and time with a zone, as RFC 3339 writes it. */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

/** RFC 3339, with each part in range: no 30 February, no 24:00 (Date.parse accepts both). */
export function isDateTime(text: string): boolean {
  const m = RFC3339.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  const zoneOk = m[9] === undefined || (Number(m[9]) < 24 && Number(m[10]) < 60);
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && h < 24 && mi < 60 && sec < 60 && zoneOk;
}

/** A DateTime value as a string, from a string or {"@type": "DateTime", "@value": …}. */
export function dateValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const inner = (v as { '@value'?: unknown } | null)?.['@value'];
  return typeof inner === 'string' ? inner : undefined;
}

/**
 * The corrections of a Decision entity as Pointsman's `correct`: question
 * name to value, the latest entry winning. A wrong shape gives a message.
 */
export function correctionsOf(attr: Record<string, unknown> | undefined): Record<string, unknown> | string {
  if (!attr) return {};
  const list = attr.json ?? attr.value;
  if (!Array.isArray(list)) return 'corrections: expected a list';
  const correct: Record<string, unknown> = {};
  for (const c of list) {
    const { name, value } = (c ?? {}) as { name?: unknown; value?: unknown };
    if (typeof name !== 'string' || !['boolean', 'string', 'number'].includes(typeof value)) return 'corrections: each needs a name and a value';
    correct[name] = value;
  }
  return correct;
}

/** The corrections this person has not sent as feedback yet (each answer on its own: they may have come one at a time). */
function notSentYet(correct: Record<string, unknown>, by: string, feedback: { by?: unknown; correct?: unknown }[]): Record<string, unknown> {
  const sent = (name: string, value: unknown) => feedback.some((f) => f.by === by && !!f.correct && typeof f.correct === 'object'
    && Object.hasOwn(f.correct, name) && (f.correct as Record<string, unknown>)[name] === value);
  return Object.fromEntries(Object.entries(correct).filter(([name, value]) => !sent(name, value)));
}

/**
 * A Decision entity a person resolved in the broker (`reviewStatus`
 * "resolved", `finalAction`, `reviewedBy`, `reviewedAt`, optional `corrections`):
 * resolves the review in Pointsman (or sends the corrections as feedback for
 * an action Pointsman did not queue), then writes the final action to the
 * entity's result and completes its Task. Safe to repeat: a resolved review
 * and feedback already sent are not sent again.
 */
export async function handleReview(decision: Entity, config: BridgeConfig): Promise<EntityResult> {
  const id = decision.id;
  if (valueOf(decisionAttr(decision, 'reviewStatus')) !== 'resolved') return { id, skipped: 'not resolved' };
  const finalAction = valueOf(decisionAttr(decision, 'finalAction'));
  const by = valueOf(decisionAttr(decision, 'reviewedBy'));
  if (typeof finalAction !== 'string' || finalAction === '' || typeof by !== 'string' || by.trim() === '') {
    return { id, error: 'a resolved Decision needs finalAction and reviewedBy', retry: false };
  }
  const correct = correctionsOf(decisionAttr(decision, 'corrections'));
  if (typeof correct === 'string') return { id, error: correct, retry: false };
  // Checked before anything is sent: after the resolve in Pointsman, a value
  // the broker refuses could not be fixed by a retry.
  const reviewedAtAttr = decisionAttr(decision, 'reviewedAt');
  const reviewedAt = dateValue(valueOf(reviewedAtAttr));
  // Required with "resolved" (Decision model), and the same on every repeat.
  if (!reviewedAtAttr || reviewedAt === undefined || !isDateTime(reviewedAt)) {
    return { id, error: 'reviewedAt: expected a date and time (RFC 3339)', retry: false };
  }

  const decisionId = id.slice('urn:ngsi-ld:Decision:'.length);
  // encodeURIComponent keeps dots: "." or ".." would change the URL's path.
  if (/^\.*$/.test(decisionId)) return { id, error: 'not a Pointsman decision id', retry: false };
  const pointsman = (path: string, body?: unknown) => send(config, 'pointsman', `${config.pointsman.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${config.pointsman.token}`, 'user-agent': USER_AGENT, ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const found = await pointsman(`/v1/decisions/${encodeURIComponent(decisionId)}`);
  if (!found.ok) return { id, error: `pointsman answered ${found.status}`, retry: retryable(found.status) };
  type Record_ = { review?: { status?: string; final_action?: string }; feedback?: { by?: unknown; correct?: unknown }[] };
  let record = (await found.json()) as Record_;

  let review: ReviewOutcome;
  if (record.review?.status === 'pending') {
    const res = await pointsman(`/v1/reviews/${encodeURIComponent(decisionId)}/resolve`, { action: finalAction, correct, by });
    // 409: resolved in the meantime, for example from another app.
    if (!res.ok && res.status !== 409) return { id, error: `pointsman answered ${res.status}`, retry: retryable(res.status) };
    review = res.ok ? 'resolved' : 'already resolved';
    if (!res.ok) {
      // A 409 also comes for a review that stays open (profile_version_gone)
      // or was closed: only a review resolved with this action goes on.
      const code = ((await res.json().catch(() => null)) as { error?: { code?: unknown } } | null)?.error?.code;
      const again = await pointsman(`/v1/decisions/${encodeURIComponent(decisionId)}`);
      if (!again.ok) return { id, error: `pointsman answered ${again.status}`, retry: retryable(again.status) };
      record = (await again.json()) as Record_;
      if (record.review?.status === 'superseded') {
        return { id, error: 'a newer decision replaced this one before the review reached Pointsman; answer the newer one', retry: false };
      }
      if (record.review?.status !== 'resolved') {
        return { id, error: `pointsman answered 409${typeof code === 'string' ? ` ${code}` : ''} and the review is not resolved`, retry: code !== 'profile_version_gone' };
      }
      if (record.review.final_action !== finalAction) {
        return { id, error: `the review is resolved in Pointsman as ${record.review.final_action ?? 'no action'}, not ${finalAction}`, retry: false };
      }
    }
  } else if (record.review?.status === 'superseded') {
    // A newer decision replaced this one before the answer reached Pointsman:
    // the answer cannot count. Shown, not dropped (a person's answer stays elsewhere).
    return { id, error: 'a newer decision replaced this one before the review reached Pointsman; answer the newer one', retry: false };
  } else if (record.review) {
    review = 'already resolved';
  } else if (Object.keys(correct).length === 0) {
    review = 'nothing to send';
  } else if (Object.keys(notSentYet(correct, by, record.feedback ?? [])).length === 0) {
    review = 'feedback already sent';
  } else {
    const res = await pointsman(`/v1/decisions/${encodeURIComponent(decisionId)}/feedback`, { correct: notSentYet(correct, by, record.feedback ?? []), by });
    if (!res.ok) return { id, error: `pointsman answered ${res.status}`, retry: retryable(res.status) };
    review = 'feedback sent';
  }
  // Pointsman's resolution counts: a Decision that says otherwise (a stale or
  // competing write) must not put another action on the entity.
  const recorded = record.review?.final_action;
  if (review === 'already resolved' && typeof recorded === 'string' && recorded !== finalAction) {
    return { id, error: `the review is resolved in Pointsman as ${recorded}, not ${finalAction}`, retry: false };
  }

  // The entity's result and its Task, when the entity still has this decision.
  // More than one route may use the profile: the one whose result links this decision.
  const target = decisionAttr(decision, 'refersTo')?.object;
  const profile = valueOf(decisionAttr(decision, 'profile'));
  const candidates = config.routes.filter((r) => r.profile === profile && r.decisionEntity);
  if (candidates.length === 0 || typeof target !== 'string') return { id, review, written: false };
  const headers = readHeaders(config, config.broker.context);
  const attrs = [...new Set(candidates.map((r) => r.attribute))].map(encodeURIComponent).join(',');
  const got = await send(config, 'broker', `${config.broker.url}/ngsi-ld/v1/entities/${encodeURIComponent(target)}?attrs=${attrs}`, { headers });
  if (got.status === 404) return { id, review, written: false };
  if (!got.ok) return { id, error: `broker read failed: ${got.status}`, retry: retryable(got.status) };
  const current = (await got.json()) as Entity;
  const linked = (r: Route) => ((current[r.attribute] as { decision?: { object?: unknown } } | undefined)?.decision?.object === id);
  // None: a newer decision replaced this one; its result and Task are not this review's.
  const route = candidates.find((r) => r.type === current.type && linked(r)) ?? candidates.find(linked);
  if (!route) return { id, review, written: false };
  const result = current[route.attribute] as Record<string, unknown>;
  const when = reviewedAt;
  const write = await writeAttribute(target, route.attribute, {
    ...result,
    finalAction: P(finalAction),
    reviewedAt: P(when),
    // The marker for open checks (toProperty) follows the review.
    ...(result?.reviewStatus !== undefined && { reviewStatus: P('resolved') }),
  }, config);
  if (!updatedAll(write)) return { id, error: `broker write failed: ${write.status}`, retry: retryable(write.status) };
  const hash = valueOf(result?.inputHash);
  if (route.task && typeof hash === 'string') {
    const done = await brokerRequest('POST', await taskEntityId(target, route.attribute, hash), config, {
      '@context': [TASK_CONTEXT, CORE_CONTEXT],
      progress: P('completed'),
      statusLabel: P(finalAction),
      completedAt: P({ '@type': 'DateTime', '@value': when }),
    });
    // 404: no Task (an action without one, or made before Tasks).
    if (!updatedAll(done) && done.status !== 404) return { id, error: `broker refused the Task update: ${done.status}`, retry: retryable(done.status) };
  }
  return { id, review, written: true };
}
