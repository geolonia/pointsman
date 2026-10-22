// Shared fakes for tests that build their own dependencies.

import type { Fetch } from '../../src/callbacks';
import type { DecisionLog } from '../../src/log';
import type { FactProvider, ModuleRouter } from '../../src/facts';
import type { FactQueryBase } from '@pointsman/module-api';

/** A decision log that stores nothing; override the methods a test needs. */
export function fakeLog(overrides: Partial<DecisionLog> = {}): DecisionLog {
  return {
    insert: async () => {},
    stats: async () => ({ decisions: 0, actions: {}, reviews: { pending: 0, resolved: 0, superseded: 0, final_actions: {} }, corrected: 0 }),
    get: async () => null,
    addFeedback: async () => {},
    pendingReviews: async () => [],
    recent: async () => [],
    resolve: async () => false,
    dueCallbacks: async () => [],
    claimCallback: async () => true,
    recordCallback: async () => true,
    byIdempotencyKey: async () => null,
    latestFor: async () => null,
    supersede: async () => [],
    discard: async () => {},
    ...overrides,
  };
}

/** Callback settings that never send anything. */
export const noCallbacks: { secret: string | undefined; fetch: Fetch } = {
  secret: undefined,
  fetch: async () => {
    throw new Error('no callbacks in this test');
  },
};

/** The provider a deployment built for one fact module (src/facts.ts ModuleRouter). */
export const providerOf = (deps: { facts?: unknown }, module: string): FactProvider | undefined =>
  (deps.facts as ModuleRouter | undefined)?.providers.get(module);

/** Whether a provider gives the mock answers (for this fact type). */
export async function answersMock(p: FactProvider | undefined, query: FactQueryBase & Record<string, unknown>): Promise<boolean> {
  if (!p) return false;
  return (await p.lookup(query, new AbortController().signal)).source === 'mock';
}
