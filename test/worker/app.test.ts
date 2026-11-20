// Error paths with fake model adapters and stores.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { fakeLog, noCallbacks } from './helpers';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { makeDecision } from '../../src/decide';
import { depsFor } from '../../src/index';
import type { FactProvider } from '@pointsman/module-api';
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
const log: DecisionLog = fakeLog();

function appWith(adapter: ModelAdapter | null) {
  const deps: Deps = { callbacks: noCallbacks, store, tokens, log, adapterFor: () => adapter };
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
    ['an option left out', (r) => {
      const a = r.answers.phase;
      if (a?.type === 'choice') a.probabilities = { waiting: 1 };
    }],
    ['probabilities that do not add up to 1', (r) => {
      const a = r.answers.phase;
      if (a?.type === 'choice') a.probabilities = { creating: 1, rolling_back: 1, cleaning_up: 1, waiting: 1 };
    }],
  ])('answers 502 for %s', async (_, edit) => {
    await expectError(await decide(appWith(tampered(edit))), 502, 'model_error');
  });

  it('a caller that stopped waiting (its request aborted) gets no decision logged', async () => {
    const inserts: unknown[] = [];
    const slow: ModelAdapter = { decide: async (req) => (await new Promise((r) => setTimeout(r, 40)), new MockAdapter().decide(req)) };
    const deps: Deps = { callbacks: noCallbacks, store, tokens, log: fakeLog({ insert: async (d) => { inserts.push(d); } }), adapterFor: () => slow };
    const app = createApp(() => deps);
    // As the FIWARE bridge calls the engine in process: the time limit fires while the model answers.
    const gone = await app.request(new Request('https://pointsman.test/v1/decide/deploy-progress', { method: 'POST', body, headers, signal: AbortSignal.timeout(10) }), undefined, env);
    expect(gone.status).toBe(502);
    expect(inserts).toHaveLength(0);
    // A caller that waits gets its decision, logged.
    const waited = await app.request('/v1/decide/deploy-progress', { method: 'POST', body, headers }, env);
    expect(waited.status).toBe(200);
    expect(inserts).toHaveLength(1);
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
    ['unknown MODEL_MODE', { ...base, MODEL_MODE: 'openai' }, 'MODEL_MODE must be'],
    ['missing MODEL_MODE', { ...base, MODEL_MODE: undefined }, 'MODEL_MODE must be'],
    ['workers-ai without an AI binding', { ...base, MODEL_MODE: 'workers-ai' }, 'no AI binding'],
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

  it('answers 500 when no model of the profile has an adapter', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps: Deps = { callbacks: noCallbacks, store, tokens, log, adapterFor: () => null };
      await expectError(await decide(createApp(() => deps)), 500, 'internal_error');
      expect(String(logged.mock.calls[0]?.[0])).toContain('no adapter for any model');
    } finally {
      logged.mockRestore();
    }
  });
});

describe('fact lookups and model failures (#258)', () => {
  // A profile with questions and a fact: the fact is looked up while the model answers.
  const triage = profiles.find((p) => p.id === 'issue-triage')!;
  const withFact = { ...triage, facts: [{ name: 'pr', type: 'github_pr', at: '$.pull_request' }] } as Profile;
  const factStore = new MemoryProfileStore([withFact]);
  const client = { client: 'test', profiles: ['*'], created_at: '' };
  const state = { issue: { title: 'Login page is blank' }, pull_request: { repo: 'octo-org/demo', number: 1, head: 'a'.repeat(40) } };

  it('looks up no fact when no model of the profile has an adapter', async () => {
    let looked = false;
    const facts: FactProvider = { lookup: async () => { looked = true; throw new Error('not needed'); } };
    await expect(makeDecision({ store: factStore, adapterFor: () => null, log, facts }, client, 'issue-triage', { state }))
      .rejects.toThrow('no adapter for any model');
    expect(looked).toBe(false);
  });

  it('answers 502 when every model fails, without waiting for the fact lookups', async () => {
    const vi_ = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A lookup that never answers (its own limit is many seconds).
    const facts: FactProvider = { lookup: () => new Promise(() => {}) };
    const failing: ModelAdapter = { decide: async () => { throw new ModelError('down'); } };
    const result = await Promise.race([
      makeDecision({ store: factStore, adapterFor: () => failing, log, facts }, client, 'issue-triage', { state }),
      new Promise((r) => setTimeout(() => r('waited'), 1000)),
    ]);
    expect(result).toMatchObject({ ok: false, status: 502 });
    vi_.mockRestore();
  });
});

describe('test tokens', () => {
  const TEST_TOKEN = newToken();
  const auth = { authorization: `Bearer ${TEST_TOKEN}` };
  async function setup() {
    const testTokens = new MemoryTokenStore(new Map([
      [await hashToken(TEST_TOKEN), { client: 'examples-check', profiles: ['deploy-progress'], created_at: '2026-10-15T00:00:00Z', test: true }],
    ]));
    const insert = vi.fn(async () => {});
    const deps: Deps = { callbacks: noCallbacks, store, tokens: testTokens, log: fakeLog({ insert }), adapterFor: () => new MockAdapter() };
    return { app: createApp(() => deps), insert };
  }

  it('decide like any token, but nothing is logged and the decision says so', async () => {
    const { app, insert } = await setup();
    const res = await app.request('/v1/decide/deploy-progress', { method: 'POST', body, headers: auth }, env);
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(contract.decision(data), JSON.stringify(contract.decision.errors)).toBe(true);
    expect(data).toMatchObject({ test: true, profile: 'deploy-progress' });
    expect(typeof data.action).toBe('string');
    expect(insert).not.toHaveBeenCalled();
  });

  it('get no callbacks (refused before the model is asked)', async () => {
    const { app, insert } = await setup();
    const res = await app.request('/v1/decide/deploy-progress', {
      method: 'POST', body: JSON.stringify({ state: 'Deploy has had no event for 40 minutes.', callback_url: 'https://example.com/cb' }), headers: auth,
    }, env);
    await expectError(res, 400, 'invalid_request');
    expect(insert).not.toHaveBeenCalled();
  });

  it('may list their profiles, and do nothing else', async () => {
    const { app } = await setup();
    expect((await app.request('/v1/profiles', { headers: auth }, env)).status).toBe(200);
    const id = crypto.randomUUID();
    for (const [method, path] of [
      ['GET', '/v1/reviews'], ['GET', `/v1/decisions/${id}`], ['POST', `/v1/decisions/${id}/feedback`], ['POST', `/v1/reviews/${id}/resolve`],
      ['GET', '/v1/decide/deploy-progress'], ['POST', '/v1/decide/deploy-progress/x'], ['GET', '/v1/stats/deploy-progress'],
    ] as const) {
      await expectError(await app.request(path, { method, headers: auth, ...(method === 'POST' && { body: '{}' }) }, env), 403, 'forbidden');
    }
    // HEAD answers without a body.
    expect((await app.request('/v1/profiles', { method: 'HEAD', headers: auth }, env)).status).toBe(403);
  });

  it('do not change normal tokens: their decisions are logged and not marked', async () => {
    const insert = vi.fn(async () => {});
    const deps: Deps = { callbacks: noCallbacks, store, tokens, log: fakeLog({ insert }), adapterFor: () => new MockAdapter() };
    const res = await decide(createApp(() => deps));
    expect(res.status).toBe(200);
    expect(await res.json<any>()).not.toHaveProperty('test');
    expect(insert).toHaveBeenCalledOnce();
  });
});
