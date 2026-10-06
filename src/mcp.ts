// MCP server (Streamable HTTP, stateless) at /mcp. See docs/mcp.md.
//
// Tools: list_profiles, decide, get_decision. Only profiles that set
// `mcp.visible: true` and are in the caller's scope are listed or callable;
// any other profile looks unknown. Callers authenticate like the REST API
// (API token as bearer token). submit_feedback is added for people logged in
// through OAuth (step 2 of issue #11), not for API tokens.

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { makeDecision, type Deps } from './app';
import { canUse, type TokenRecord } from './auth';
import type { Profile } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type McpDeps = Pick<Deps, 'store' | 'adapterFor' | 'log'>;

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const visible = (p: Profile | null, client: TokenRecord) => !!p && p.mcp?.visible === true && canUse(client, p.id);

function describe(p: Profile) {
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
  };
}

function server(deps: McpDeps, client: TokenRecord): McpServer {
  const mcp = new McpServer({ name: 'pointsman', version: '0.1.0' });

  mcp.registerTool(
    'list_profiles',
    {
      description: 'List the decision profiles you can use: their questions, answer options and possible actions.',
      inputSchema: {},
    },
    async () => {
      const summaries = (await deps.store.list()).filter((s) => canUse(client, s.id));
      const profiles = [];
      for (const s of summaries) {
        const p = await deps.store.get(s.id);
        if (visible(p, client)) profiles.push(describe(p!));
      }
      return json({ profiles });
    },
  );

  mcp.registerTool(
    'decide',
    {
      description:
        'Ask a decision profile. Returns typed answers with probabilities and the action to take '
        + '(for example "auto", or "review" when a person should decide). Use list_profiles first. '
        + 'For profiles with input fields, send state as an object with those fields under the names the profile expects.',
      inputSchema: {
        profile: z.string().describe('Profile id from list_profiles'),
        state: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('What to decide about: text, or a JSON object'),
        ref: z.string().optional().describe('Your reference for this decision, for example an issue URL'),
      },
    },
    async ({ profile, state, ref }) => {
      if (!visible(await deps.store.get(profile), client)) return failure(`unknown profile "${profile}"`);
      const result = await makeDecision(deps, client, profile, { state, ...(ref !== undefined && { ref }) }, undefined, { stateIsMapped: true });
      return result.ok ? json(result.decision) : failure(`${result.code}: ${result.message}`);
    },
  );

  mcp.registerTool(
    'get_decision',
    {
      description: 'Get a decision by id: answers, action, profile version, model, review status and feedback.',
      inputSchema: { decision_id: z.string().describe('decision_id returned by decide') },
    },
    async ({ decision_id }) => {
      const record = UUID.test(decision_id) ? await deps.log.get(decision_id) : null;
      // Decisions of profiles that are not MCP-visible look unknown too.
      const profile = record ? await deps.store.get(record.profile) : null;
      if (!record || !visible(profile, client)) return failure(`unknown decision "${decision_id}"`);
      const { callback_url: _, state: __, ...shown } = record;
      return json(shown);
    },
  );

  return mcp;
}

/** Serve one MCP request for an authenticated client. */
export function serveMcp(request: Request, deps: McpDeps, client: TokenRecord): Promise<Response> {
  const handler = createMcpHandler(() => server(deps, client), { legacy: 'stateless' });
  return handler.fetch(request);
}
