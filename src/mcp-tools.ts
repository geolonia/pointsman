// The MCP tools: names, descriptions and input schemas (docs/mcp.md). The
// handlers are in mcp.ts. Kept apart and Node-safe, so the reference page
// (docs/reference/mcp-tools.md) is generated from the same definitions.

import { z } from 'zod';

export const TOOLS = {
  list_profiles: {
    description: 'List the decision profiles you can use: their questions, answer options and possible actions.',
    inputSchema: {},
  },
  explain_profile: {
    description:
      'Explain a decision profile in plain sentences: what the AI is asked, which facts and earlier decisions it uses, '
      + 'and each rule as "If ..., the action is ...". Show the text to the person who approves the profile.',
    inputSchema: {
      profile: z.string().describe('Profile id from list_profiles'),
      lang: z.enum(['en', 'ja']).optional().describe('Language of the sentences (default en)'),
      version: z.number().int().positive().optional().describe('A published version (default: the latest)'),
    },
  },
  replay_profile: {
    description:
      'Try a changed policy on the decisions already made: what the new rules would have decided on the last logged '
      + 'decisions of a profile version, with the logged answers and facts (no model is called). Returns how many actions '
      + 'would change, from what to what, how often they would match what a person answered, and the changed decisions. '
      + 'Only the policy may change; send questions, facts and requires too to check that they are the same.',
    inputSchema: {
      profile: z.string().describe('Profile id from list_profiles'),
      policy: z.record(z.string(), z.unknown()).describe('The new policy: { rules: [{ when, action }], default, people_check?, people_answers? }'),
      version: z.number().int().positive().optional().describe('The published version to replay (default: the latest)'),
      limit: z.number().int().min(1).max(500).optional().describe('How many of the newest decisions (default 200)'),
      questions: z.array(z.unknown()).optional().describe("The draft's questions, to check they did not change"),
      facts: z.array(z.unknown()).optional().describe("The draft's facts, to check they did not change"),
      requires: z.array(z.unknown()).optional().describe("The draft's requires, to check they did not change"),
    },
  },
  decide: {
    description:
      'Ask a decision profile. Returns typed answers with probabilities and the action to take '
      + '(for example "auto", or "review" when a person should decide). Use list_profiles first. '
      + 'For profiles with input fields, send state as an object with those fields under the names the profile expects.',
    inputSchema: {
      profile: z.string().describe('Profile id from list_profiles'),
      state: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('What to decide about: text, or a JSON object'),
      ref: z.string().optional().describe('Your reference for this decision, for example an issue URL'),
      decisions: z.record(z.string(), z.string()).optional()
        .describe('For profiles with requires: the decision_id of each earlier decision, by the name in requires. Needs ref.'),
      idempotency_key: z.string().optional()
        .describe('Send the same key again to get the same decision instead of a new one'),
    },
  },
  get_decision: {
    description: 'Get a decision by id: answers, action, profile version, model, review status and feedback.',
    inputSchema: { decision_id: z.string().describe('decision_id returned by decide') },
  },
  // Only for people logged in through OAuth (see mcp.ts).
  submit_feedback: {
    description:
      'Correct a decision: give the right answer for one or more of its questions. '
      + 'Recorded in your name and used to measure how often the profile is right.',
    inputSchema: {
      decision_id: z.string().describe('decision_id returned by decide'),
      correct: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()]))
        .describe('The right answers, by question name, for example {"team": "frontend"}'),
      note: z.string().optional().describe('Why, in a sentence'),
    },
  },
};

/** Tools only people logged in through OAuth get, not API tokens. */
export const PEOPLE_ONLY: ReadonlySet<string> = new Set(['submit_feedback']);
