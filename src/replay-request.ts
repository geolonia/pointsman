// Replay requests: checks a replay of a changed policy for a caller and runs
// it on the logged decisions (the replay itself is in src/replay.ts,
// docs/profile-format.md#replay). Used by the HTTP API (src/app.ts) and MCP
// (src/mcp.ts). It uses no runtime-specific API (docs/adapters.md).

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Deps } from './decide';
import { PolicyError, type RequiredProfiles } from './policy';
import { compileDraft, policyShapeError, replay, REPLAY_LIMIT, unchangedPartError, type ReplayResult } from './replay';
import type { Profile } from './types';

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
