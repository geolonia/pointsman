// Shared fakes for tests that build their own dependencies.

import type { Fetch } from '../../src/callbacks';
import type { DecisionLog } from '../../src/log';

/** A decision log that stores nothing; override the methods a test needs. */
export function fakeLog(overrides: Partial<DecisionLog> = {}): DecisionLog {
  return {
    insert: async () => {},
    stats: async () => ({ decisions: 0, actions: {}, reviews: { pending: 0, resolved: 0, final_actions: {} }, corrected: 0 }),
    get: async () => null,
    addFeedback: async () => {},
    pendingReviews: async () => [],
    resolve: async () => false,
    dueCallbacks: async () => [],
    claimCallback: async () => true,
    recordCallback: async () => true,
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
