// Error paths with fake model adapters and stores.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { depsFor } from '../../src/index';
import type { DecisionLog } from '../../src/log';
import { ModelError, type ModelAdapter, type ModelResponse } from '../../src/models/adapter';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import * as contract from '../../generated/openapi-validators.mjs';

const profiles = bundled as Profile[];
const store = new MemoryProfileStore(profiles);
const body = JSON.stringify({ state: 'Deploy has had no event for 40 minutes.' });
const TOKEN = newToken();
const tokens = new MemoryTokenStore(new Map([
  [await hashToken(TOKEN), { client: 'test', profiles: ['*'], created_at: '2026-10-06T00:00:00Z' }],
]));
const headers = { authorization: `Bearer ${TOKEN}` };
const log: DecisionLog = { insert: async () => {}, get: async () => null, addFeedback: async () => {} };

function appWith(adapter: ModelAdapter | null) {
  const deps: Deps = { store, tokens, log, adapterFor: () => adapter };
  return createApp(() => deps);
}

function decide(app: ReturnType<typeof createApp>) {
  return app.request('/v1/decide/deploy-progress', { method: 'POST', body, headers }, env);
}

/** Adapter that edits the mock's answer before returning it. */
function tampered(edit: (r: ModelResponse) => void): ModelAdapter {
  return {
    async decide(req) {
      const res = await new MockAdapter().decide(req);
      edit(res);
      return res;
    },
  };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const data = await res.json<any>();
  expect(contract.error(data), JSON.stringify(contract.error.errors)).toBe(true);
  expect(data.error.code).toBe(code);
  return data;
}

describe('model failures', () => {
  it('answers 502 when the adapter reports a model error', async () => {
    const failing: ModelAdapter = {
      decide: async () => {
        throw new ModelError('backend timeout');
      },
    };
    const data = await expectError(await decide(appWith(failing)), 502, 'model_error');
    expect(data.error.message).not.toContain('timeout');
  });

  it.each<[string, (r: ModelResponse) => void]>([
    ['a missing answer', (r) => delete r.answers.stuck],
    ['a wrong answer type', (r) => (r.answers.stuck = { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 })],
    ['a probability above 1', (r) => (r.answers.stuck = { type: 'noul', noul: 1.2 })],
    ['an unknown option', (r) => {
      const a = r.answers.phase;
      if (a?.type === 'choice') a.probabilities = { invented: 1 };
    }],
    ['empty probabilities', (r) => {
      const a = r.answers.phase;
      if (a?.type === 'choice') a.probabilities = {};
    }],
  ])('answers 502 for %s', async (_, edit) => {
    await expectError(await decide(appWith(tampered(edit))), 502, 'model_error');
  });

  it('answers 500 without details when no adapter serves the model', async () => {
    const data = await expectError(await decide(appWith(null)), 500, 'internal_error');
    expect(data.error.message).toBe('internal error');
  });

  it('answers 500 without details for an unexpected error', async () => {
    const broken: ModelAdapter = {
      decide: async () => {
        throw new Error('secret detail');
      },
    };
    const data = await expectError(await decide(appWith(broken)), 500, 'internal_error');
    expect(JSON.stringify(data)).not.toContain('secret');
  });
});

describe('configuration', () => {
  const DB = (env as unknown as { DB: D1Database }).DB;
  const base = { PROFILE_SOURCE: 'bundled', MODEL_MODE: 'mock', TOKENS: env.TOKENS, DB };

  // All of these are 500s, so the logged error shows which check failed.
  it.each([
    ['unknown PROFILE_SOURCE', { ...base, PROFILE_SOURCE: 'files' }, 'PROFILE_SOURCE must be'],
    ['missing PROFILE_SOURCE', { ...base, PROFILE_SOURCE: undefined }, 'PROFILE_SOURCE must be'],
    ['kv without a PROFILES binding', { ...base, PROFILE_SOURCE: 'kv' }, 'no PROFILES binding'],
    ['a missing TOKENS binding', { ...base, TOKENS: undefined }, 'no TOKENS binding'],
    ['a missing DB binding', { ...base, DB: undefined }, 'no DB binding'],
  ])('answers 500 for %s', async (_, vars, cause) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp(() => depsFor(vars));
      const res = await app.request('/v1/profiles', { headers }, env);
      await expectError(res, 500, 'internal_error');
      expect(String(logged.mock.calls[0]?.[0])).toContain(cause);
    } finally {
      logged.mockRestore();
    }
  });

  it('serves no model outside mock mode', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp(() => ({ ...depsFor({ ...base, MODEL_MODE: undefined }), tokens, log }));
      await expectError(await decide(app), 500, 'internal_error');
      expect(String(logged.mock.calls[0]?.[0])).toContain('no adapter for model');
    } finally {
      logged.mockRestore();
    }
  });
});
