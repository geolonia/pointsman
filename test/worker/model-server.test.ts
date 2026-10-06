// Model server adapter (src/models/http.ts): HTTP calls in the shared format,
// configuration, and fallback through the API.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { fakeLog, noCallbacks } from './helpers';
import { ConfigError, createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { depsFor } from '../../src/index';
import { ModelError, toModelRequest, type ModelAdapter } from '../../src/models/adapter';
import { checkServerUrl, ModelServerAdapter, parseModelList, type Fetch } from '../../src/models/http';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';

const profiles = bundled as Profile[];
const triage = profiles.find((p) => p.id === 'issue-triage')!;
const request = toModelRequest(triage, { title: 'Login page is blank' }, 'local-decider');
// Made at run time, so no secret-looking literal sits in the repository.
const KEY = crypto.randomUUID();

const answers = {
  team: { type: 'choice', choice: 'frontend', probabilities: { backend: 0.03, frontend: 0.96, docs: 0.01 }, confidence: 0.94 },
  urgent: { type: 'noul', noul: 0.7 },
  effort: { type: 'score', score: 1.5, legend: {}, probabilities: { '0': 0.2, '1': 0.3, '2': 0.3, '3': 0.2 }, confidence: 0.37 },
};

function server(respond: (url: string, init: RequestInit) => Promise<Response> | Response, extra: Partial<ConstructorParameters<typeof ModelServerAdapter>[0]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  const adapter = new ModelServerAdapter({
    url: 'http://127.0.0.1:8794',
    models: { 'local-decider': 'strands-decider-2B-hobson-v19' },
    timeoutMs: 10_000,
    fetch,
    ...extra,
  });
  return { adapter, calls };
}

async function errorOf(p: Promise<unknown>): Promise<ModelError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    return err as ModelError;
  }
  throw new Error('expected a ModelError');
}

describe('ModelServerAdapter', () => {
  it('posts the request to /v1/systemone with the server model name', async () => {
    const { adapter, calls } = server(() => Response.json({ model: 'strands-decider-2B-hobson-v19', answers }));
    const res = await adapter.decide(request);
    expect(res).toEqual({ model: 'strands-decider-2B-hobson-v19', answers });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8794/v1/systemone');
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ ...request, model: 'strands-decider-2B-hobson-v19' });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBeNull();
  });

  it('sends the API key as a bearer token, and never puts it in errors', async () => {
    const { adapter, calls } = server(() => new Response('denied', { status: 401 }), { apiKey: KEY });
    const err = await errorOf(adapter.decide(request));
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(err.message).toBe('strands-decider-2B-hobson-v19: model server answered HTTP 401');
    expect(err.message).not.toContain(KEY);
  });

  it('uses the profile model id when the response names no model', async () => {
    const { adapter } = server(() => Response.json({ answers }));
    expect((await adapter.decide(request)).model).toBe('local-decider');
  });

  it.each([
    ['an HTTP error, without the body', () => new Response('state: Login page is blank', { status: 500 }), 'answered HTTP 500'],
    ['invalid JSON', () => new Response('not json', { status: 200 }), 'invalid JSON'],
    ['a response without answers', () => Response.json({ model: 'x' }), 'response has no answers'],
    ['answers that are not an object', () => Response.json({ answers: [] }), 'response has no answers'],
  ])('turns %s into a ModelError', async (_, respond, message) => {
    const { adapter } = server(respond);
    const err = await errorOf(adapter.decide(request));
    expect(err.message).toContain(message);
    expect(err.message).not.toContain('Login page');
  });

  it('turns an unreachable server into a ModelError', async () => {
    const { adapter } = server(() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8794');
    });
    expect((await errorOf(adapter.decide(request))).message).toBe('strands-decider-2B-hobson-v19: model server not reachable');
  });

  it('stops waiting after the timeout', async () => {
    const { adapter, calls } = server(
      (_, init) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      { timeoutMs: 100 },
    );
    const err = await errorOf(adapter.decide(request));
    expect(err.message).toBe('strands-decider-2B-hobson-v19: no answer within 100 ms');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a body that stalls after the headers as a timeout', async () => {
    const { adapter } = server(
      (_, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"answers":'));
              init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      { timeoutMs: 100 },
    );
    expect((await errorOf(adapter.decide(request))).message).toBe('strands-decider-2B-hobson-v19: no answer within 100 ms');
  });

  it('refuses a model it does not serve', async () => {
    const { adapter, calls } = server(() => Response.json({ answers }));
    expect(adapter.serves('clef-flash')).toBe(false);
    await errorOf(adapter.decide({ ...request, model: 'clef-flash' }));
    expect(calls).toHaveLength(0);
  });
});

describe('model server settings', () => {
  it.each([
    ['https://models.example', 'https://models.example'],
    ['https://models.example/base/', 'https://models.example/base'],
    ['http://127.0.0.1:8794', 'http://127.0.0.1:8794'],
    ['http://localhost:8794/', 'http://localhost:8794'],
    ['http://[::1]:8794', 'http://[::1]:8794'],
  ])('accepts %s', (raw, value) => {
    expect(checkServerUrl(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ['not a url', 'is not a URL'],
    ['http://models.example', 'https'],
    ['ftp://models.example', 'https'],
    ['https://user:pw@models.example', 'credentials'],
    ['https://models.example/?a=1', 'query'],
    ['https://models.example/#x', 'query'],
  ])('refuses %s', (raw, message) => {
    const r = checkServerUrl(raw);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain(message);
  });

  it('parses model lists with optional server names', () => {
    expect(parseModelList('local-decider, other=other-v2')).toEqual({
      ok: true,
      value: { 'local-decider': 'local-decider', other: 'other-v2' },
    });
    // A model may be called "error" without being mistaken for a failure.
    expect(parseModelList('error')).toEqual({ ok: true, value: { error: 'error' } });
  });

  it.each([
    ['', 'at least one'],
    [' , ', 'at least one'],
    ['Bad-Name', 'invalid entry'],
    ['a=b=c', 'invalid entry'],
    ['a=', 'invalid entry'],
    ['a, a=b', 'listed twice'],
  ])('refuses the model list %j', (raw, message) => {
    const r = parseModelList(raw);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain(message);
  });

  const base = { ...(env as object), MODEL_MODE: 'mock' };

  it('routes its models to the server and the rest by MODEL_MODE', () => {
    const deps = depsFor({ ...base, MODEL_SERVER_URL: 'http://127.0.0.1:8794', MODEL_SERVER_MODELS: 'local-decider' } as never);
    expect(deps.adapterFor('local-decider')).toBeInstanceOf(ModelServerAdapter);
    expect(deps.adapterFor('clef-flash')).toBeInstanceOf(MockAdapter);
    expect(depsFor(base as never).adapterFor('local-decider')).toBeInstanceOf(MockAdapter);
  });

  it('reads the key and timeout', () => {
    const deps = depsFor({
      ...base,
      MODEL_SERVER_URL: 'https://models.example',
      MODEL_SERVER_MODELS: 'local-decider',
      MODEL_SERVER_API_KEY: KEY,
      MODEL_SERVER_TIMEOUT_MS: '2500',
    } as never);
    const adapter = deps.adapterFor('local-decider') as ModelServerAdapter;
    expect(adapter.config).toMatchObject({ url: 'https://models.example', apiKey: KEY, timeoutMs: 2500 });
  });

  it.each([
    ['a URL without models', { MODEL_SERVER_URL: 'http://127.0.0.1:8794' }, 'go together'],
    ['models without a URL', { MODEL_SERVER_MODELS: 'local-decider' }, 'go together'],
    ['a key without a server', { MODEL_SERVER_API_KEY: KEY }, 'need MODEL_SERVER_URL'],
    ['a timeout without a server', { MODEL_SERVER_TIMEOUT_MS: '2000' }, 'need MODEL_SERVER_URL'],
    ['a plain http URL', { MODEL_SERVER_URL: 'http://models.example', MODEL_SERVER_MODELS: 'x' }, 'MODEL_SERVER_URL must use https'],
    ['a bad model list', { MODEL_SERVER_URL: 'https://m.example', MODEL_SERVER_MODELS: 'Bad' }, 'MODEL_SERVER_MODELS: invalid entry'],
    ['a bad timeout', { MODEL_SERVER_URL: 'https://m.example', MODEL_SERVER_MODELS: 'x', MODEL_SERVER_TIMEOUT_MS: '5s' }, 'MODEL_SERVER_TIMEOUT_MS'],
    ['a too long timeout', { MODEL_SERVER_URL: 'https://m.example', MODEL_SERVER_MODELS: 'x', MODEL_SERVER_TIMEOUT_MS: '600000' }, 'MODEL_SERVER_TIMEOUT_MS'],
  ])('refuses %s', (_, settings, message) => {
    expect(() => depsFor({ ...base, ...settings } as never)).toThrow(ConfigError);
    expect(() => depsFor({ ...base, ...settings } as never)).toThrow(message);
  });
});

describe('model server through the API', () => {
  const token = newToken();
  const profile: Profile = { ...triage, model: 'local-decider', fallback_models: ['clef-flash'] };

  async function decide(adapter: ModelServerAdapter) {
    const tokens = new MemoryTokenStore(new Map([[await hashToken(token), { client: 't', profiles: ['*'], created_at: '' }]]));
    const fallback: ModelAdapter = {
      decide: async (r) => ({ ...(await new MockAdapter().decide(r)), model: 'clef-flash' }),
    };
    const deps: Deps = {
      callbacks: noCallbacks,
      store: new MemoryProfileStore([profile]),
      tokens,
      log: fakeLog(),
      adapterFor: (m) => (adapter.serves(m) ? adapter : m === 'clef-flash' ? fallback : null),
    };
    const res = await createApp(() => deps).request('/v1/decide/issue-triage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ state: { issue: { title: 'Login page is blank' } } }),
    }, env);
    return { status: res.status, body: await res.json<any>() };
  }

  it('decides with the server answers, normalized like any model', async () => {
    const { adapter } = server(() => Response.json({ model: 'strands-decider-2B-hobson-v19', answers }));
    const { status, body } = await decide(adapter);
    expect(status).toBe(200);
    expect(body.model).toBe('strands-decider-2B-hobson-v19');
    expect(body.answers.team).toEqual({ type: 'choice', value: 'frontend', p: 0.96, probabilities: answers.team.probabilities });
    expect(body.answers.urgent).toEqual({ type: 'noul', value: true, p: 0.7, yes: 0.7 });
    expect(body.action).toBe('auto');
  });

  it.each([
    ['is down', () => { throw new TypeError('connect ECONNREFUSED'); }],
    ['answers HTTP 503', () => new Response('busy', { status: 503 })],
    ['answers in a shape that does not fit the profile', () => Response.json({ answers: { team: { type: 'noul', noul: 0.5 } } })],
  ])('falls back to the next model when the server %s', async (_, respond) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { adapter } = server(respond);
    const { status, body } = await decide(adapter);
    expect(status).toBe(200);
    expect(body.model).toBe('clef-flash');
    logged.mockRestore();
  });
});
