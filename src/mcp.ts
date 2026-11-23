// MCP server (Streamable HTTP, stateless) at /mcp. See docs/mcp.md.
//
// Tools: list_profiles, explain_profile, replay_profile, decide, get_decision, and submit_feedback for people
// logged in through OAuth (not for API tokens). Only profiles that set
// `mcp.visible: true` and are in the caller's scope are listed or callable;
// any other profile looks unknown. People may use every MCP-visible profile.

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { PEOPLE_ONLY, TOOLS } from './mcp-tools';
import { makeDecision, makeReplay, publicRecord, type Deps } from './decide';
import { canUse, type TokenRecord } from './auth';
import { visibleRequires } from './chains';
import { explainProfile, explanationText } from './explain';
import { peopleAnswers, peopleCheck, profileActions } from './policy';
import type { DecisionRecord, RequiredSnapshot } from './log';
import { errorMessage, feedbackAnswer, findDecision } from './internal';
import type { Caller } from './auth';
import type { Profile } from './types';
import { ENGINE_VERSION } from './version';

type McpDeps = Pick<Deps, 'store' | 'adapterFor' | 'log'>;

/**
 * The scope a caller acts with; people are recorded as "github:<account id>",
 * which never changes: a login can be renamed and then taken by another
 * account, which must not own the earlier holder's decisions.
 */
export function clientOf(caller: Caller): TokenRecord {
  return caller.kind === 'token'
    ? caller.record
    : { client: `github:${caller.id}`, profiles: ['*'], created_at: '' };
}

/** A result as structured content, and the same JSON as text for clients that read only text. */
function json(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
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
    actions: profileActions(p),
    // When a person checks an action: the answers they may give, which become
    // the decision's outcome (get_decision), as in the graph's allowed answers.
    ...(peopleCheck(p).some((a) => profileActions(p).includes(a)) && { people_answers: peopleAnswers(p) }),
    // Earlier decisions to send in `decisions`, by name (docs/decision-chains.md).
    // The required profile's id only when the caller may see it through MCP.
    ...(p.requires?.length && {
      requires: p.requires.map((r) => ({ name: r.name, ...(seen.has(r.profile) && { profile: r.profile }), ...(r.optional && { optional: true }) })),
    }),
  };
}

function server(deps: McpDeps, caller: Caller): McpServer {
  const client = clientOf(caller);
  const server = new McpServer({ name: 'pointsman', version: ENGINE_VERSION });
  // Every tool's unexpected error is logged, and the caller gets "internal
  // error" without its details, as the REST API answers internal_error (#247).
  // Without this the SDK sends the error's message to the caller, unlogged.
  // Tools in PEOPLE_ONLY are registered only for people logged in through
  // OAuth, not for API tokens.
  const mcp = {
    registerTool: ((name: string, config: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
      // People-only tools (mcp-tools.ts) are not even listed for a token.
      if (PEOPLE_ONLY.has(name) && caller.kind !== 'person') return undefined;
      return server.registerTool(name, config as never, (async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (err) {
          console.error(`mcp tool ${name}:`, err);
          return failure('internal error');
        }
      }) as never);
    }) as McpServer['registerTool'],
  };

  /** Whether the caller may see a decision of this profile through MCP (as for decide, on its latest version). */
  const shownDecision = async (record: DecisionRecord) => visible(await deps.store.get(record.profile), client);
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
      // The index once, then each profile in scope at the version it names,
      // as the graph route does: KV allows a limited number of reads per
      // request. The latest readable version only when that one is not
      // readable yet (KV is eventually consistent, src/profiles/store-kv.ts).
      const summaries = (await deps.store.list()).filter((s) => canUse(client, s.id));
      const latest = await Promise.all(summaries.map(async (s) => (await deps.store.get(s.id, s.version)) ?? deps.store.get(s.id)));
      // A required profile is shown when the caller may see it through MCP: it
      // is then in scope, so among the profiles read here.
      const shown = latest.filter((p): p is Profile => visible(p, client));
      const seen = new Set(shown.map((p) => p.id));
      const profiles = shown.map((p) => describe(p, seen));
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
      // Decisions of profiles that are not MCP-visible look unknown too.
      const record = await findDecision(client, deps.log, decision_id);
      if (!record || !(await shownDecision(record))) return failure(`unknown decision "${decision_id}"`);
      // As GET /v1/decisions/{id}, without state, and a required decision of
      // a profile the caller may not see through MCP is hidden.
      const seen = await seenProfiles(Object.values(record.requires ?? {}).map((r) => r.profile));
      const { state: _, ...shown } = publicRecord(record, client, (p) => seen.has(p));
      return json(shown);
    },
  );

  // Feedback is a person's judgement, so only people logged in through OAuth
  // get this tool (PEOPLE_ONLY); it is recorded under their GitHub login.
  mcp.registerTool(
    'submit_feedback',
    TOOLS.submit_feedback,
    async ({ decision_id, correct, note }) => {
      // Only to narrow the type: registerTool never lists this tool for a token.
      if (caller.kind !== 'person') throw new Error('submit_feedback is only for people');
      const body = { correct, by: caller.login, ...(note !== undefined && { note }) };
      const answer = await feedbackAnswer(deps, client, decision_id, async () => body, shownDecision);
      if (answer.status === 404) return failure(`unknown decision "${decision_id}"`);
      if (answer.status !== 204) return failure(errorMessage(answer));
      return json({ recorded: true });
    },
  );

  return server;
}

/** Serve one MCP request for an authenticated caller. */
export function serveMcp(request: Request, deps: McpDeps, caller: Caller): Promise<Response> {
  const handler = createMcpHandler(() => server(deps, caller), { legacy: 'stateless' });
  return handler.fetch(request);
}
