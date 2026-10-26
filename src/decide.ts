// Making decisions and replays, and delivering review callbacks: the
// engine core behind the HTTP API (src/app.ts) and MCP (src/mcp.ts). It uses
// no runtime-specific API (docs/adapters.md).

import { factContext } from './log-facts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { canUse, type TokenRecord, type TokenStore } from './auth';
import { attempt, type Fetch } from './callbacks';
import { factModules, lookupFacts, type FactProvider } from './facts';
import { buildState, pickInputFields } from './input';
import { hashState, type DecisionLog, type DecisionRecord } from './log';
import { ModelError, toModelRequest, type ModelAdapter } from './models/adapter';
import { normalizeAnswers } from './models/normalize';
import { decisionsError, loadRequired, snapshotOf, visibleRequires } from './chains';
import { compilePolicy, peopleCheck, PolicyError, type RequiredProfiles } from './policy';
import { compileDraft, policyShapeError, replay, REPLAY_LIMIT, unchangedPartError, type ReplayResult } from './replay';
import type { OAuthConfig } from './auth';
import { ConfigError } from '@pointsman/module-api';
import { factRegistry } from './modules/registry';
import type { ProfileStore } from './profiles/store';
import type { Decision, Profile } from './types';
import { ENGINE_VERSION } from './version';

const MAX_REF_LENGTH = 200;
// Control characters, and the line separators and direction marks that can reorder or split a printed line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

type Body = { state: unknown; ref?: string; callback_url?: string; decisions?: Record<string, string> };

/** Returns the parsed body, or an error message. */
function parseBody(body: unknown): Body | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!['state', 'ref', 'callback_url', 'decisions'].includes(key)) return `unknown field "${key}"`;
  }
  if (b.state === undefined || b.state === null) return '"state" is required';
  if (typeof b.state !== 'object' && typeof b.state !== 'string') {
    return '"state" must be an object, an array or a string';
  }
  if (typeof b.state === 'string' && b.state.trim() === '') return '"state" must not be empty';
  if (b.ref !== undefined && (typeof b.ref !== 'string' || b.ref.length === 0 || b.ref.length > MAX_REF_LENGTH)) {
    return `"ref" must be a string of 1 to ${MAX_REF_LENGTH} characters`;
  }
  // A ref is an id: no line breaks or terminal escape codes in reports that print it.
  if (typeof b.ref === 'string' && CONTROL.test(b.ref)) return '"ref" must not contain control characters';
  if (b.decisions !== undefined) {
    const problem = decisionsError(b.decisions);
    if (problem) return problem;
  }
  if (b.callback_url !== undefined) {
    if (typeof b.callback_url !== 'string' || !URL.canParse(b.callback_url)
      || new URL(b.callback_url).protocol !== 'https:') {
      return '"callback_url" must be an https URL';
    }
  }
  return b as Body;
}

export interface Deps {
  store: ProfileStore;
  tokens: TokenStore;
  log: DecisionLog;
  /** Signing secret and fetch for review callbacks (see src/callbacks.ts). */
  callbacks: { secret: string | undefined; fetch: Fetch };
  /** Adapter for a model id, or null when no adapter serves it. */
  adapterFor(model: string): ModelAdapter | null;
  /** Answers facts (the chosen fact modules, src/facts.ts ModuleRouter); without it, every fact is missing ("unavailable"). */
  facts?: FactProvider | undefined;
  /** GitHub login for /mcp (src/oauth.ts); without it /mcp takes API tokens only. */
  oauth?: OAuthConfig | undefined;
}

/** A broken deployment configuration (shared with the fact modules). */
export { ConfigError };

export type DecisionResult =
  | { ok: true; decision: Decision }
  | { ok: false; status: ContentfulStatusCode; code: string; message: string };

const fail = (status: ContentfulStatusCode, code: string, message: string): DecisionResult => ({ ok: false, status, code, message });

/**
 * A replay for a caller. `allowed` says which profiles the caller may use
 * (API scope, or MCP visibility); the profile and every profile it requires
 * must be allowed, since the replay reads their logged decisions.
 */
export async function makeReplay(
  deps: Pick<Deps, 'store' | 'log'>,
  id: string,
  raw: unknown,
  allowed: (id: string) => boolean | Promise<boolean>,
): Promise<{ ok: true; replay: ReplayResult } | { ok: false; status: ContentfulStatusCode; code: string; message: string }> {
  const fail = (status: ContentfulStatusCode, code: string, message: string) => ({ ok: false as const, status, code, message });
  if (!(await allowed(id))) return fail(403, 'forbidden', 'not allowed to use this profile');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail(400, 'invalid_request', 'body must be an object');
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!['policy', 'version', 'limit', 'questions', 'facts', 'requires'].includes(k)) return fail(400, 'invalid_request', `"${k}" is not a replay field`);
  }
  const { version, limit = REPLAY_LIMIT.default } = body;
  if (version !== undefined && !(Number.isInteger(version) && (version as number) >= 1)) return fail(400, 'invalid_request', '"version" must be a positive integer');
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > REPLAY_LIMIT.max) {
    return fail(400, 'invalid_request', `"limit" must be a whole number from 1 to ${REPLAY_LIMIT.max}`);
  }
  const shape = policyShapeError(body.policy);
  if (shape) return fail(400, 'invalid_request', shape);
  for (const k of ['questions', 'facts', 'requires'] as const) {
    if (body[k] !== undefined && !Array.isArray(body[k])) return fail(400, 'invalid_request', `"${k}" must be a list`);
  }
  const base = await deps.store.get(id, version as number | undefined);
  if (!base) return fail(404, 'profile_not_found', version === undefined ? 'unknown profile' : 'unknown profile or version');
  // The replay reads what the required decisions were: their profiles must be
  // allowed too. Checked before anything is compared with the draft, so the
  // answer never tells whether a guessed hidden profile id is right.
  for (const r of base.requires ?? []) {
    if (!(await allowed(r.profile))) return fail(403, 'forbidden', 'not allowed to use a profile that this profile requires');
  }
  const changed = unchangedPartError(base, body as Partial<Pick<Profile, 'questions' | 'facts' | 'requires'>>);
  if (changed) return fail(409, 'not_policy_only', changed);
  const required: RequiredProfiles = {};
  for (const r of base.requires ?? []) required[r.profile] = (await deps.store.get(r.profile)) ?? undefined;
  const policy = body.policy as Profile['policy'];
  let compiled;
  try {
    // Before the log is read: a policy that does not compile costs no D1 read.
    compiled = compileDraft(base, policy, required);
  } catch (err) {
    if (err instanceof PolicyError) return fail(400, 'invalid_policy', err.message);
    throw err;
  }
  const records = await deps.log.recent(base.id, base.version, limit as number);
  return { ok: true, replay: replay(base, policy, compiled, records, required) };
}

/**
 * Decide for one client: scope check, request check, model call (with
 * fallback models) and spatial facts, policy, decision log. Used by the
 * REST API and by MCP.
 */
export async function makeDecision(
  { store, adapterFor, log, facts: factProvider }: Pick<Deps, 'store' | 'adapterFor' | 'log'> & Partial<Pick<Deps, 'facts'>>,
  client: TokenRecord,
  profileId: string,
  raw: unknown,
  version?: number,
  {
    stateIsMapped = false,
    idempotencyKey,
  }: {
    /**
     * The state already has the profile's input fields (MCP callers send
     * them directly) instead of a raw payload for the input mapping.
     */
    stateIsMapped?: boolean;
    /** A repeated request with this key from the same client gets the logged decision again. */
    idempotencyKey?: string;
  } = {},
): Promise<DecisionResult> {
  // Checked before the profile lookup, so a token cannot probe which
  // profiles exist outside its scope.
  if (!canUse(client, profileId)) return fail(403, 'forbidden', 'this token may not use this profile');

  const body = parseBody(raw);
  if (typeof body === 'string') return fail(400, 'invalid_request', body);
  if (client.test && body.callback_url !== undefined) {
    return fail(400, 'invalid_request', 'a test token gets no callbacks: its decisions are not logged');
  }
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return fail(400, 'invalid_request', 'the idempotency key must be 1 to 200 printable characters');
  }
  // A test token's decisions are not logged, so it has none to build on, and
  // it must not read logged ones (P-TEST-TOKEN-ISOLATED).
  if (client.test && body.decisions !== undefined) {
    return fail(400, 'invalid_request', 'a test token cannot send decisions: its decisions are not logged');
  }

  const profile = await store.get(profileId, version);
  if (!profile) return fail(404, 'profile_not_found', 'unknown profile or version');

  const chained = (profile.requires ?? []).length > 0;
  if (!chained && body.decisions !== undefined) return fail(400, 'invalid_request', '"decisions": this profile requires no decisions');
  if (chained && client.test) return fail(400, 'invalid_request', 'a test token cannot decide a profile that requires other decisions');
  if (chained && body.ref === undefined) return fail(400, 'invalid_request', '"ref" is required when the profile requires decisions');

  // The same key from the same client: the decision already logged, if the
  // request is the same; a different request with that key is a conflict.
  // The version as requested (not the latest one it resolved to), so a retry
  // after a new profile version is published is still the same request.
  const digest = idempotencyKey === undefined ? undefined
    : await hashState({
      profile: profile.id, version: version ?? null, state: body.state, ref: body.ref ?? null,
      decisions: body.decisions ?? null, callback_url: body.callback_url ?? null, mapped: stateIsMapped === true,
    });
  if (idempotencyKey !== undefined && !client.test) {
    const earlier = await log.byIdempotencyKey(client.client, idempotencyKey);
    if (earlier) return repeated(earlier, digest!, log);
  }

  // A final decision that a person resolved is never replaced (docs/decision-chains.md).
  const earlierFinal = chained ? await log.latestFor(profile.id, body.ref!, client.client) : null;
  if (earlierFinal?.review?.status === 'resolved') {
    return fail(409, 'resolved_by_person', 'a person has resolved the decision this one would replace');
  }

  const required = chained ? await loadRequired(profile, body.decisions, body.ref!, client, log, store) : undefined;
  if (required && !required.ok) return fail(400, 'invalid_request', required.message);

  const state = stateIsMapped ? pickInputFields(profile, body.state) : buildState(profile, body.state);
  if (profile.input && Object.keys(state as object).length === 0) {
    return fail(400, 'invalid_request', stateIsMapped
      ? `"state" must be an object with at least one of: ${profile.input.map((i) => i.name).join(', ')}`
      : 'no field of the profile input mapping was found in "state"');
  }

  // Before the model call, so a broken profile costs no model call.
  // Profiles are validated before they reach a store, so an error here means
  // the deployment changed under a published profile (a fact module left out
  // of engine.json) or a store holds an unvalidated profile: a 500, like
  // other config errors.
  const missing = (profile.facts ?? []).find((f) => !factRegistry().type(f.type));
  if (missing) throw new ConfigError(`profile ${profile.id} v${profile.version}: no chosen fact module answers ${missing.type} facts`);
  const policy = compilePolicy(profile, required?.ok ? required.profiles : {});

  // Facts read the client's data (the `at` paths), not the mapped state.
  // Looked up while the model answers; lookupFacts never throws.
  const factsLookup = profile.facts?.length
    ? lookupFacts(profile.facts, body.state, factProvider, undefined, factContext(log, client, profile.id))
    : undefined;

  let answers: Decision['answers'] | undefined;
  let model: string | undefined;
  if (profile.questions.length === 0) {
    // Rules only (a profile with requires): no model call, no adapter needed.
    answers = {};
    model = NO_MODEL;
  } else {
    // The profile's model first, then its fallback models in order. A model
    // error (failed call, or an answer that does not fit the profile) moves
    // on to the next model; the decision records the model that answered.
    const models = [profile.model, ...(profile.fallback_models ?? [])];
    const served = models.filter((m) => adapterFor(m) !== null);
    if (served.length === 0) throw new ConfigError(`no adapter for any model of profile ${profile.id}`);
    for (const m of served) {
      try {
        const response = await adapterFor(m)!.decide(toModelRequest(profile, state, m));
        answers = normalizeAnswers(profile, response);
        model = response.model;
        break;
      } catch (err) {
        if (!(err instanceof ModelError)) throw err;
        console.error(`model error for profile ${profile.id}, model ${m}: ${err.message}`);
      }
    }
  }
  const facts = factsLookup ? await factsLookup : undefined;
  if (!answers || !model) return fail(502, 'model_error', 'the model did not return a usable answer');

  const { action, rule } = policy.decide(answers, facts, required?.ok ? required.inputs : {});
  const opensReview = peopleCheck(profile).includes(action);

  const decision: Decision = {
    decision_id: crypto.randomUUID(),
    ...(body.ref !== undefined && { ref: body.ref }),
    answers,
    action,
    profile: profile.id,
    profile_version: profile.version,
    model,
    created_at: new Date().toISOString(),
    rule,
    ...(facts && { facts }),
    ...(required?.ok && { requires: snapshotOf(required, policy) }),
    ...(earlierFinal && { replaces: earlierFinal.decision_id }),
    ...(opensReview && !client.test && { review: { status: 'pending' as const } }),
    versions: { engine: ENGINE_VERSION, modules: factModules(profile.facts ?? []) },
  };
  // A test token's decisions are not logged (and marked as such): they
  // check profiles and examples, nobody acts on them.
  if (client.test) return { ok: true, decision: { ...decision, test: true } };
  // Every decision is logged before it is returned. If the log fails, the
  // client gets a 500 and must not act on an unlogged decision.
  try {
    await log.insert({
      ...decision,
      client: client.client,
      state_hash: await hashState(state),
      ...(profile.log?.store_state && { state }),
      ...(body.callback_url !== undefined && { callback_url: body.callback_url }),
      ...(idempotencyKey !== undefined && digest !== undefined && { idempotency_key: idempotencyKey, request_digest: digest }),
    });
  } catch (err) {
    // Two requests with the same key at once: the other one was logged first.
    const earlier = idempotencyKey === undefined ? null : await log.byIdempotencyKey(client.client, idempotencyKey);
    if (!earlier) throw err;
    return repeated(earlier, digest!, log);
  }
  if (chained) {
    // A person resolved the decision this one replaces while it was being
    // made: their answer stays, and this one never counts. (Once this one is
    // logged, resolving the earlier one is refused, see DecisionLog.resolve.)
    if (earlierFinal && (await log.get(earlierFinal.decision_id))?.review?.status === 'resolved') {
      await log.discard(decision.decision_id, new Date().toISOString());
      return fail(409, 'resolved_by_person', 'a person has resolved the decision this one would replace');
    }
    // The new decision replaces the older ones of the same step for this
    // report: their open reviews leave the queue.
    await log.supersede({ ...decision, client: client.client });
  }
  return { ok: true, decision };
}

/** A repeated request with a logged idempotency key: the logged decision, or a conflict. */
async function repeated(earlier: DecisionRecord, digest: string, log: DecisionLog): Promise<DecisionResult> {
  if (earlier.request_digest !== digest) return fail(409, 'idempotency_conflict', 'this idempotency key was used for a different request');
  if (earlier.requires !== undefined) {
    // A person resolved the decision it replaces before it was logged (the
    // first try was discarded, failed before it could check, or is still
    // running): it never counts, the same answer as for the first try.
    if (earlier.discarded_at !== undefined
      || (earlier.replaces !== undefined && (await log.get(earlier.replaces))?.review?.status === 'resolved')) {
      if (earlier.discarded_at === undefined) await log.discard(earlier.decision_id, new Date().toISOString());
      return fail(409, 'resolved_by_person', 'a person has resolved the decision this one would replace');
    }
    // The first try may have failed after it was logged: close the replaced
    // reviews now (safe to repeat).
    await log.supersede(earlier);
  }
  return { ok: true, decision: decisionOf(earlier) };
}

/**
 * A logged decision as a token may read it: without callback_url and the
 * request digest, and with required decisions of profiles outside the
 * token's scope hidden (P-TOKEN-SCOPE).
 */
export function publicRecord<R extends DecisionRecord>(record: R, client: TokenRecord) {
  const { callback_url: _, request_digest: __, requires, ...visible } = record;
  const shown = visibleRequires(requires, (profile) => canUse(client, profile));
  return shown ? { ...visible, requires: shown } : visible;
}

/** The profile ids connected to `id` through requires, both ways, by the index. */
export function connected(id: string, summaries: { id: string; requires?: string[] }[]): Set<string> {
  // Only through profiles in the list (the ones in scope): a profile out of
  // scope does not join two others, as in decisionGraph.
  const known = new Set(summaries.map((s) => s.id));
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const next = [
      ...(summaries.find((s) => s.id === at)?.requires ?? []),
      ...summaries.filter((s) => s.requires?.includes(at)).map((s) => s.id),
    ];
    for (const n of next) {
      if (known.has(n) && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** The model of a decision made by rules only. */
export const NO_MODEL = 'none';
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

/** The review as the decide response shows it: its status and, once resolved, the person's action. */
function reviewOf(review: NonNullable<DecisionRecord['review']>): NonNullable<Decision['review']> {
  if (review.status !== 'resolved') return { status: review.status };
  return {
    status: 'resolved',
    ...(review.final_action !== undefined && { final_action: review.final_action }),
    ...(review.resolved_at !== undefined && { resolved_at: review.resolved_at }),
  };
}

/** A logged decision as the decide response (an idempotent repeat). */
function decisionOf(r: DecisionRecord): Decision {
  return {
    decision_id: r.decision_id,
    ...(r.ref !== undefined && { ref: r.ref }),
    answers: r.answers,
    action: r.action,
    profile: r.profile,
    profile_version: r.profile_version,
    model: r.model,
    created_at: r.created_at,
    rule: r.rule,
    ...(r.facts && { facts: r.facts }),
    ...(r.requires && { requires: r.requires }),
    ...(r.replaces !== undefined && { replaces: r.replaces }),
    ...(r.review && { review: reviewOf(r.review) }),
    ...(r.versions && { versions: r.versions }),
  };
}

/** Longer than one attempt (10 s timeout), so a claim never expires mid-send. */
const CLAIM_LEASE_MS = 60_000;

/**
 * One callback attempt for a resolved decision. The callback is claimed
 * first, so the first delivery and the cron retry can never send the same
 * attempt twice; only the claimant sends and records the outcome.
 */
export async function deliver(d: DecisionRecord, deps: Pick<Deps, 'log' | 'callbacks'>, now = new Date()): Promise<void> {
  const claim = {
    id: crypto.randomUUID(),
    now: now.toISOString(),
    leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
    attempts: d.callback?.attempts ?? 0,
  };
  if (!(await deps.log.claimCallback(d.decision_id, claim))) return; // someone else has it
  const state = await attempt(d, { ...deps.callbacks, now });
  await deps.log.recordCallback(d.decision_id, state, claim.id);
  if (state.status !== 'delivered') console.error(`callback for ${d.decision_id}: ${state.last_error} (${state.status})`);
}

/** Retry every callback that is due (run by the scheduled handler). */
export async function retryDueCallbacks(deps: Pick<Deps, 'log' | 'callbacks'>, now = new Date()): Promise<number> {
  const due = await deps.log.dueCallbacks(now.toISOString(), 50);
  for (const d of due) await deliver(d, deps, now);
  return due.length;
}
