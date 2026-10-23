// MCP server (Streamable HTTP, stateless) at /mcp. See docs/mcp.md.
//
// Tools: list_profiles, explain_profile, replay_profile, decide, get_decision, and submit_feedback for people
// logged in through OAuth (not for API tokens). Only profiles that set
// `mcp.visible: true` and are in the caller's scope are listed or callable;
// any other profile looks unknown. People may use every MCP-visible profile.

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { TOOLS } from './mcp-tools';
import { makeDecision, makeReplay, type Deps } from './decide';
import { canUse, type TokenRecord } from './auth';
import { visibleRequires } from './chains';
import { explainProfile, explanationText } from './explain';
import type { RequiredSnapshot } from './log';
import { parseFeedback } from './feedback';
import type { Caller } from './auth';
import type { Profile } from './types';
import { ENGINE_VERSION } from './version';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type McpDeps = Pick<Deps, 'store' | 'adapterFor' | 'log'>;

/** The scope a caller acts with; people are recorded as "github:<login>". */
export function clientOf(caller: Caller): TokenRecord {
  return caller.kind === 'token'
    ? caller.record
    : { client: `github:${caller.login}`, profiles: ['*'], created_at: '' };
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const visible = (p: Profile | null, client: TokenRecord) => !!p && p.mcp?.visible === true && canUse(client, p.id);

function describe(p: Profile, seen: Set<string>) {
  return {
    id: p.id,
    version: p.version,
    title: p.title,
    description: p.description,
    // What the caller should send: the input mapping, or free state.
    state: p.input ? { fields: p.input.map((i) => i.name) } : 'free text or JSON',
    questions: p.questions.map((q) => ({
      name: q.name,
      type: q.type,
      instructions: q.instructions,
      ...(q.type === 'choice' && { options: q.criteria.map((c) => c.value) }),
      ...(q.type === 'score' && { levels: q.criteria }),
    })),
    actions: [...new Set([...(p.policy.rules ?? []).map((r) => r.action), p.policy.default])],
    // Earlier decisions to send in `decisions`, by name (docs/decision-chains.md).
    // The required profile's id only when the caller may see it through MCP.
    ...(p.requires?.length && {
      requires: p.requires.map((r) => ({ name: r.name, ...(seen.has(r.profile) && { profile: r.profile }), ...(r.optional && { optional: true }) })),
    }),
  };
}

function server(deps: McpDeps, caller: Caller): McpServer {
  const client = clientOf(caller);
  const mcp = new McpServer({ name: 'pointsman', version: ENGINE_VERSION });

  /** The profiles of these ids the caller may see through MCP. */
  const seenProfiles = async (ids: string[]) => {
    const seen = new Set<string>();
    for (const id of new Set(ids)) if (visible(await deps.store.get(id), client)) seen.add(id);
    return seen;
  };
  /** `requires` with required decisions of profiles the caller may not see through MCP hidden. */
  const shownRequires = async (requires: Record<string, RequiredSnapshot> | undefined) => {
    const seen = await seenProfiles(Object.values(requires ?? {}).map((s) => s.profile));
    return visibleRequires(requires, (p) => seen.has(p));
  };

  mcp.registerTool(
    'list_profiles',
    TOOLS.list_profiles,
    async () => {
      const summaries = (await deps.store.list()).filter((s) => canUse(client, s.id));
      const profiles = [];
      for (const s of summaries) {
        const p = await deps.store.get(s.id);
        if (visible(p, client)) profiles.push(describe(p!, await seenProfiles(p!.requires?.map((r) => r.profile) ?? [])));
      }
      return json({ profiles });
    },
  );

  mcp.registerTool(
    'explain_profile',
    TOOLS.explain_profile,
    async ({ profile, lang, version }) => {
      // Visibility is checked on the latest version, as for decide.
      if (!visible(await deps.store.get(profile), client)) return failure(`unknown profile "${profile}"`);
      const p = await deps.store.get(profile, version);
      if (!p) return failure(`unknown version ${String(version)} of profile "${profile}"`);
      const required: Record<string, Profile> = {};
      for (const r of p.requires ?? []) {
        const q = Object.hasOwn(required, r.profile) ? null : await deps.store.get(r.profile);
        if (q && visible(q, client)) required[r.profile] = q;
      }
      const explanation = explainProfile(p, lang ?? 'en', required);
      return json({ ...explanation, text: explanationText(explanation) });
    },
  );

  mcp.registerTool(
    'replay_profile',
    TOOLS.replay_profile,
    async ({ profile, ...body }) => {
      // Hidden profiles look unknown, as for decide.
      const seen = async (id: string) => visible(await deps.store.get(id), client);
      if (!(await seen(profile))) return failure(`unknown profile "${profile}"`);
      const given = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      const result = await makeReplay(deps, profile, given, seen);
      if (!result.ok) return failure(`${result.code}: ${result.message}`);
      return json(result.replay);
    },
  );

  mcp.registerTool(
    'decide',
    TOOLS.decide,
    async ({ profile, state, ref, decisions, idempotency_key }) => {
      if (!visible(await deps.store.get(profile), client)) return failure(`unknown profile "${profile}"`);
      const body = { state, ...(ref !== undefined && { ref }), ...(decisions !== undefined && { decisions }) };
      const result = await makeDecision(deps, client, profile, body, undefined,
        { stateIsMapped: true, ...(idempotency_key !== undefined && { idempotencyKey: idempotency_key }) });
      if (!result.ok) return failure(`${result.code}: ${result.message}`);
      const requires = await shownRequires(result.decision.requires);
      return json(requires ? { ...result.decision, requires } : result.decision);
    },
  );

  mcp.registerTool(
    'get_decision',
    TOOLS.get_decision,
    async ({ decision_id }) => {
      const record = UUID.test(decision_id) ? await deps.log.get(decision_id) : null;
      // Decisions of profiles that are not MCP-visible look unknown too.
      const profile = record ? await deps.store.get(record.profile) : null;
      if (!record || !visible(profile, client)) return failure(`unknown decision "${decision_id}"`);
      const { callback_url: _, state: __, request_digest: ___, requires, ...shown } = record;
      // A required decision of a profile the caller may not see through MCP is hidden.
      const hidden = await shownRequires(requires);
      return json(hidden ? { ...shown, requires: hidden } : shown);
    },
  );

  // Feedback is a person's judgement, so only people logged in through OAuth
  // get this tool; it is recorded under their GitHub login.
  if (caller.kind === 'person') {
    mcp.registerTool(
      'submit_feedback',
      TOOLS.submit_feedback,
      async ({ decision_id, correct, note }) => {
        const record = UUID.test(decision_id) ? await deps.log.get(decision_id) : null;
        if (!record || !visible(await deps.store.get(record.profile), client)) return failure(`unknown decision "${decision_id}"`);
        // Checked against the profile version the decision used.
        const profile = await deps.store.get(record.profile, record.profile_version);
        if (!profile) return failure('the profile version of this decision is no longer available');
        const feedback = parseFeedback({ correct, by: caller.login, ...(note !== undefined && { note }) }, profile);
        if (typeof feedback === 'string') return failure(feedback);
        await deps.log.addFeedback(decision_id, { ...feedback, created_at: new Date().toISOString(), client: client.client });
        return json({ recorded: true });
      },
    );
  }

  return mcp;
}

/** Serve one MCP request for an authenticated caller. */
export function serveMcp(request: Request, deps: McpDeps, caller: Caller): Promise<Response> {
  const handler = createMcpHandler(() => server(deps, caller), { legacy: 'stateless' });
  return handler.fetch(request);
}
