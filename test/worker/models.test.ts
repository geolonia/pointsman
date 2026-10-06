// Workers AI adapter (with a fake AI binding) and fallback models.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { fakeLog, noCallbacks } from './helpers';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { depsFor } from '../../src/index';
import type { DecisionLog } from '../../src/log';
import { ModelError, toModelRequest, type ModelAdapter } from '../../src/models/adapter';
import { MockAdapter } from '../../src/models/mock';
import { WorkersAiAdapter, type AiRunner } from '../../src/models/workers-ai';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import clefFlashResponse from './fixtures/clef-flash-issue-triage.json';

const profiles = bundled as Profile[];
const triage = profiles.find((p) => p.id === 'issue-triage')!;
const request = toModelRequest(triage, { title: 'Login page is blank', body: 'Since this morning.' });

function fakeAi(result: unknown | (() => never)) {
  const calls: { model: string; input: unknown; options: unknown }[] = [];
  const ai: AiRunner = {
    async run(model, input, options) {
      calls.push({ model, input, options });
      if (typeof result === 'function') return (result as () => never)();
      return result;
    },
  };
  return { ai, calls };
}

describe('WorkersAiAdapter', () => {
  it('calls the Workers AI model with the request, through the gateway', async () => {
    const { ai, calls } = fakeAi(clefFlashResponse);
    const response = await new WorkersAiAdapter(ai, 'pointsman').decide(request);
    expect(calls).toEqual([{
      model: '@cf/cloudflare/clef-flash',
      input: request,
      options: { gateway: { id: 'pointsman', requestTimeoutMs: 10000 } },
    }]);
    expect(response.model).toBe(clefFlashResponse.model);
    expect(Object.keys(response.answers)).toEqual(['team', 'urgent', 'effort']);
  });

  it('calls without a gateway when none is configured', async () => {
    const { ai, calls } = fakeAi(clefFlashResponse);
    await new WorkersAiAdapter(ai, '').decide(request);
    expect(calls[0]!.options).toEqual({});
  });

  it('maps clef to its Workers AI name', async () => {
    const { ai, calls } = fakeAi(clefFlashResponse);
    await new WorkersAiAdapter(ai).decide({ ...request, model: 'clef' });
    expect(calls[0]!.model).toBe('@cf/cloudflare/clef');
  });

  it.each([
    ['an unknown model', { ...request, model: 'jev-latest' }, clefFlashResponse, 'not on Workers AI'],
    ['a prototype name as model', { ...request, model: 'constructor' }, clefFlashResponse, 'not on Workers AI'],
    ['a response without answers', request, { model: 'clef-flash' }, 'has no answers'],
    ['a non-object response', request, 'text', 'has no answers'],
  ])('throws ModelError for %s', async (_, req, result, message) => {
    const { ai } = fakeAi(result);
    await expect(new WorkersAiAdapter(ai).decide(req)).rejects.toThrow(ModelError);
    await expect(new WorkersAiAdapter(ai).decide(req)).rejects.toThrow(message);
  });

  it('turns binding errors into ModelError', async () => {
    const { ai } = fakeAi(() => {
      throw new Error('3040: Capacity temporarily exceeded');
    });
    await expect(new WorkersAiAdapter(ai).decide(request)).rejects.toThrow(/clef-flash: 3040: Capacity/);
  });

  it('uses the requested model id when the response has none', async () => {
    const { ai } = fakeAi({ answers: clefFlashResponse.answers });
    expect((await new WorkersAiAdapter(ai).decide(request)).model).toBe('clef-flash');
  });
});

describe('recorded Clef-flash response', () => {
  it('normalizes to the engine answer format through the API', async () => {
    const { ai } = fakeAi(clefFlashResponse);
    const token = newToken();
    const tokens = new MemoryTokenStore(new Map([[await hashToken(token), { client: 't', profiles: ['*'], created_at: '' }]]));
    const deps = { ...depsFor({ PROFILE_SOURCE: 'bundled', MODEL_MODE: 'workers-ai', TOKENS: env.TOKENS, DB: (env as any).DB, AI: ai }), tokens };
    const res = await createApp(() => deps).request('/v1/decide/issue-triage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ state: { issue: { title: 'Login page is blank', body: 'Since this morning.' } } }),
    }, env);
    expect(res.status).toBe(200);
    const d = await res.json<any>();
    expect(d.model).toBe('clef-flash');
    expect(d.answers).toEqual({
      team: { type: 'choice', value: 'frontend', p: 0.9633, probabilities: { backend: 0.0304, frontend: 0.9633, docs: 0.0063 } },
      urgent: { type: 'noul', value: true, p: 0.8348, yes: 0.8348 },
      effort: { type: 'score', value: 1, p: 0.524, score: 1.0223, probabilities: { '0': 0.2579, '1': 0.524, '2': 0.156, '3': 0.0621 } },
    });
    // team.p >= 0.85 is the first rule of issue-triage.
    expect(d.action).toBe('auto');
  });
});

describe('fallback models', () => {
  const token = newToken();
  const log: DecisionLog = fakeLog();
  const withFallback = { ...triage, model: 'clef-flash', fallback_models: ['clef'] };

  async function decide(adapters: Record<string, ModelAdapter>, profile: Profile = withFallback) {
    const tokens = new MemoryTokenStore(new Map([[await hashToken(token), { client: 't', profiles: ['*'], created_at: '' }]]));
    const deps: Deps = { callbacks: noCallbacks,
      store: new MemoryProfileStore([profile]),
      tokens,
      log,
      adapterFor: (m) => adapters[m] ?? null,
    };
    return createApp(() => deps).request('/v1/decide/issue-triage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ state: { issue: { title: 'T' } } }),
    }, env);
  }

  const failing: ModelAdapter = { decide: async () => { throw new ModelError('down'); } };
  const named = (model: string): ModelAdapter => ({
    decide: async (r) => ({ ...(await new MockAdapter().decide(r)), model }),
  });
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('uses the primary model when it answers', async () => {
    const res = await decide({ 'clef-flash': named('clef-flash'), clef: named('clef') });
    expect((await res.json<any>()).model).toBe('clef-flash');
  });

  it('falls back when the primary model fails', async () => {
    const logged = quiet();
    const res = await decide({ 'clef-flash': failing, clef: named('clef') });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).model).toBe('clef');
    expect(String(logged.mock.calls[0]?.[0])).toContain('model clef-flash: down');
    logged.mockRestore();
  });

  it('falls back when the primary answer does not fit the profile', async () => {
    const logged = quiet();
    const bad: ModelAdapter = { decide: async () => ({ model: 'clef-flash', answers: {} }) };
    const res = await decide({ 'clef-flash': bad, clef: named('clef') });
    expect((await res.json<any>()).model).toBe('clef');
    logged.mockRestore();
  });

  it('skips models without an adapter', async () => {
    const res = await decide({ clef: named('clef') });
    expect((await res.json<any>()).model).toBe('clef');
  });

  it('answers 502 when every model fails', async () => {
    const logged = quiet();
    const res = await decide({ 'clef-flash': failing, clef: failing });
    expect(res.status).toBe(502);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it('does not fall back on unexpected errors', async () => {
    const logged = quiet();
    const broken: ModelAdapter = { decide: async () => { throw new TypeError('bug'); } };
    const clef = { decide: vi.fn(named('clef').decide) };
    const res = await decide({ 'clef-flash': broken, clef });
    expect(res.status).toBe(500);
    expect(clef.decide).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
