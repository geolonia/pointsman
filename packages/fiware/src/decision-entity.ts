// The Decision entity (datamodels.jp Decision model) the FIWARE bridge
// writes for a decision (bridge.ts), whether a person checks it, and its
// updates when a review is resolved or the decision is replaced.

import { brokerRequest, updatedAll } from './broker.ts';
import type { Route } from './routes.ts';
import { CORE_CONTEXT, type Entity, P, valueOf } from './shared.ts';
import type { BridgeConfig, Decision } from './types.ts';

/** "0", "1", ... for the rule that matched, "default" for the default action. */
export function policyRule(d: Decision): string | undefined {
  if (d.rule === undefined) return undefined;
  return d.rule === null ? 'default' : String(d.rule);
}

/** The published context of the Decision model (datamodels.jp). */
export const DECISION_CONTEXT = 'https://datamodels.jp/context/decision/v1.jsonld';

/**
 * The terms of the Decision model, for callers that need them inline (for
 * example a Worker that serves them). A test keeps them equal to the
 * published context (pinned copy in test/fixtures/datamodels/decision/).
 */
export const DECISION_TERMS: Record<string, string | { '@id': string; '@type': '@id' }> = {
  decision: 'https://datamodels.jp/ns/decision/',
  Decision: 'decision:Decision',
  prov: 'http://www.w3.org/ns/prov#',
  dpv: 'https://w3id.org/dpv#',
  refersTo: { '@id': 'prov:used', '@type': '@id' },
  externalReference: 'decision:externalReference',
  action: 'decision:action',
  answers: 'decision:answers',
  facts: 'decision:facts',
  profile: 'decision:profile',
  profileVersion: 'decision:profileVersion',
  policyRule: 'decision:policyRule',
  model: 'decision:model',
  decidedAt: 'prov:endedAtTime',
  humanInvolvement: 'dpv:hasHumanInvolvement',
  reviewStatus: 'decision:reviewStatus',
  finalAction: 'decision:finalAction',
  reviewedBy: 'decision:reviewedBy',
  reviewedAt: 'decision:reviewedAt',
  corrections: 'decision:corrections',
  wasInformedBy: { '@id': 'prov:wasInformedBy', '@type': '@id' },
  requiredDecisions: 'decision:requiredDecisions',
  replaces: { '@id': 'http://purl.org/dc/terms/replaces', '@type': '@id' },
};

export const decisionEntityId = (decisionId: string) => `urn:ngsi-ld:Decision:${decisionId}`;

/** The earlier decision this one follows: the `decision` relationship of the route's informedBy attribute. */
export function informedByOf(entity: Entity, route: Route): string | undefined {
  if (!route.informedBy) return undefined;
  const object = (entity[route.informedBy] as { decision?: { object?: unknown } } | undefined)?.decision?.object;
  return typeof object === 'string' && object !== '' ? object : undefined;
}

/**
 * Whether a person checks the decision before anything happens: always when
 * Pointsman says so (`review`, from the profile's people_check), and for the
 * route's reviewActions, which add actions but never take one away. Older
 * Pointsman versions without `review`: the reviewActions, or else action review.
 */
export function isChecked(d: Pick<Decision, 'action' | 'review' | 'requires'>, route: Route): boolean {
  // A pending review is never treated as already decided (threat-model.md `R-PEOPLE-CHECK-PENDING`),
  // and a resolved one (a retry) stays a checked decision, with the person's action.
  if (isPending(d) || resolvedOf(d)) return true;
  if (route.reviewActions) return route.reviewActions.includes(d.action);
  // For engines from before decision chains (#107), which send no review: a
  // profile whose people_check leaves out review is then marked checked for
  // action review. Set reviewActions for such a profile.
  return d.requires === undefined && d.action === 'review';
}

/** Whether Pointsman opened a review for the decision (`review: {status: pending}`); anything else is not. */
export function isPending(d: Pick<Decision, 'review'>): boolean {
  return d.review?.status === 'pending';
}

/**
 * The person's answer when the review is resolved (a repeated request after
 * a person answered); undefined otherwise. Only with the person's action, as
 * Pointsman sends it: anything else is not a review (as for isPending).
 */
export function resolvedOf(d: Pick<Decision, 'review'>): { action: string; at?: string } | undefined {
  if (d.review?.status !== 'resolved' || typeof d.review.final_action !== 'string' || d.review.final_action === '') return undefined;
  return { action: d.review.final_action, ...(typeof d.review.resolved_at === 'string' && { at: d.review.resolved_at }) };
}

/**
 * The review fields for a checked decision: pending, or resolved with the
 * person's action and when, as a resolution writes them: on the result
 * (handleReview) the time as text, on the Decision entity (handleWorkOrder)
 * as a DateTime.
 */
export function reviewFields(d: Pick<Decision, 'review'>, on: 'result' | 'decision'): Record<string, unknown> {
  const done = resolvedOf(d);
  if (!done) return { reviewStatus: P('pending') };
  return {
    reviewStatus: P('resolved'),
    finalAction: P(done.action),
    ...(done.at !== undefined && { reviewedAt: P(on === 'result' ? done.at : { '@type': 'DateTime', '@value': done.at }) }),
  };
}

/**
 * A Decision entity (datamodels.jp Decision model) in normalized form. A person takes
 * part before anything happens when it is checked (isChecked); for the others
 * the action is taken and a person can correct it later through Pointsman's feedback.
 */
export function toDecisionEntity(d: Decision, entityId: string, route: Route, now = new Date(), informedBy?: string): Record<string, unknown> {
  const checked = isChecked(d, route);
  // The earlier decisions, by name, as Pointsman read them (hidden ones left out).
  const required = Object.entries(d.requires ?? {}).flatMap(([name, r]) => (typeof r?.decision === 'string' ? [{ name, decision: decisionEntityId(r.decision) }] : []));
  const rule = policyRule(d);
  return {
    '@context': [DECISION_CONTEXT, CORE_CONTEXT],
    id: decisionEntityId(d.decision_id),
    type: 'Decision',
    refersTo: { type: 'Relationship', object: entityId },
    action: P(d.action),
    answers: {
      type: 'JsonProperty',
      json: Object.entries(d.answers).map(([name, a]) => ({
        name,
        ...(a.type !== undefined && { type: a.type }),
        value: a.value,
        probability: a.p,
        ...(a.probabilities && { probabilities: a.probabilities }),
      })),
    },
    ...(d.facts && Object.keys(d.facts).length > 0 && {
      facts: { type: 'JsonProperty', json: Object.entries(d.facts).map(([name, f]) => ({ name, ...f })) },
    }),
    profile: P(d.profile),
    profileVersion: P(d.profile_version),
    ...(rule !== undefined && { policyRule: P(rule) }),
    model: P(d.model),
    decidedAt: P({ '@type': 'DateTime', '@value': d.created_at ?? now.toISOString() }),
    humanInvolvement: { type: 'VocabProperty', vocab: checked ? 'dpv:HumanInvolvementForVerification' : 'dpv:HumanInvolvementForOversight' },
    ...(informedBy !== undefined && required.length === 0 && { wasInformedBy: { type: 'Relationship', object: informedBy } }),
    // One instance per earlier decision, told apart by datasetId (datamodels.jp Decision model).
    ...(required.length > 0 && {
      wasInformedBy: required.map((r) => ({ type: 'Relationship', object: r.decision, datasetId: `urn:ngsi-ld:dataset:wasInformedBy:${r.name}` })),
      requiredDecisions: { type: 'JsonProperty', json: required },
    }),
    ...(d.replaces && { replaces: { type: 'Relationship', object: decisionEntityId(d.replaces) } }),
    ...(checked && reviewFields(d, 'decision')),
  };
}

/**
 * Marks an existing Decision entity resolved with the person's answer, as
 * toDecisionEntity would have written it, only while it is still pending: a
 * resolution already there (another writer, a work order) is left alone.
 * Returns the failed response, or null.
 */
export async function resolveDecisionEntity(id: string, d: Decision, config: BridgeConfig): Promise<Response | null> {
  const seen = await brokerRequest('GET', id, config, undefined, undefined, DECISION_CONTEXT);
  if (!seen.ok) return seen;
  if (valueOf((await seen.json() as Entity).reviewStatus) !== 'pending') return null;
  const res = await brokerRequest('POST', id, config, { '@context': [DECISION_CONTEXT, CORE_CONTEXT], ...reviewFields(d, 'decision') });
  return updatedAll(res) ? null : res;
}

/**
 * A replaced decision's Decision entity: a pending check becomes superseded
 * (datamodels.jp Decision model); a resolved one stays as it is. Returns the
 * failed response, if any.
 */
export async function supersedeDecisionEntity(id: string, config: BridgeConfig): Promise<Response | null> {
  const found = await brokerRequest('GET', id, config, undefined, undefined, DECISION_CONTEXT);
  if (found.status === 404) return null;
  if (!found.ok) return found;
  if (valueOf((await found.json() as Entity).reviewStatus) !== 'pending') return null;
  const updated = await brokerRequest('POST', id, config, {
    '@context': [DECISION_CONTEXT, CORE_CONTEXT],
    reviewStatus: P('superseded'),
  });
  return updatedAll(updated) ? null : updated;
}
