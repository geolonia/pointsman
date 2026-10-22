// The GitHub connector (docs/github-connector.md) with a fake GitHub, a fake
// Pointsman and an in-memory store for the pull requests' objects.

import { describe, expect, it, vi } from 'vitest';
import githubModule, {
  AppGitHub, GitHubError, actingScope, actsOnGitHub, checkOutput, connectorScope, connectorSettings, githubConnector, pullRequestWork, RetryError, targetsOf,
  type CheckRunOutput, type ConnectorGitHub, type ConnectorSettings, type Decision, type ObjectStorage, type OwnApproval, type PullRequestInfo, UNCLEAR_MS,
} from '@pointsman/github';
import { ConfigError, type EngineApi } from '@pointsman/module-api';

// Made at run time, so no secret-looking literal sits in the code.
const SECRET = `whsec-${crypto.randomUUID()}`;
const APP_ID = 4242;
const REPO = 'example/repo';
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);

async function pemKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}
const KEY = await pemKey();

const settings = (extra: Partial<ConnectorSettings> = {}): ConnectorSettings => ({
  appId: APP_ID, privateKey: KEY, webhookSecret: SECRET, pointsmanToken: `pm_${crypto.randomUUID()}`,
  repos: new Set([REPO]), profiles: ['pr-docs-check', 'workflow-check'], actions: {}, ...extra,
});

function memoryStorage() {
  const data = new Map<string, unknown>();
  const alarms: number[] = [];
  const storage: ObjectStorage = {
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    put: async (entries) => { for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v)); },
    setAlarm: async (at) => void alarms.push(at),
  };
  return { storage, data, alarms };
}

function fakeGitHub(pr: Partial<PullRequestInfo> = {}) {
  let nextId = 100;
  const calls: { op: string; head?: string; name?: string; id?: number; output?: CheckRunOutput; body?: string; list?: string[] }[] = [];
  const state: PullRequestInfo = {
    open: true, head: HEAD, draft: false, base: 'main', title: 'Docs', body: 'A body', fork: false, labels: [], requestedReviewers: [], ...pr,
  };
  const approvals: OwnApproval[] = [];
  const comments: string[] = [];
  const github: ConnectorGitHub & { state: PullRequestInfo; existing?: number; approvals: OwnApproval[]; comments: string[] } = {
    state,
    approvals,
    comments,
    pullRequest: async () => (calls.push({ op: 'get' }), { ...github.state, labels: [...github.state.labels], requestedReviewers: [...github.state.requestedReviewers] }),
    findCheckRun: async (_r, head, name) => (calls.push({ op: 'find', head, name }), github.existing),
    createCheckRun: async (_r, head, name, output) => (calls.push({ op: 'create', head, name, output }), nextId++),
    updateCheckRun: async (_r, id, output) => void calls.push({ op: 'update', id, output }),
    findComment: async (_r, _n, marker) => (calls.push({ op: 'findComment' }), comments.some((c) => c.startsWith(marker))),
    createComment: async (_r, _n, body) => { calls.push({ op: 'comment', body }); comments.push(body); },
    addLabels: async (_r, _n, labels) => { calls.push({ op: 'label', list: labels }); github.state.labels.push(...labels); },
    requestReviewers: async (_r, _n, reviewers) => { calls.push({ op: 'request', list: reviewers }); github.state.requestedReviewers.push(...reviewers); },
    ownApprovals: async () => (calls.push({ op: 'approvals' }), approvals.map((a) => ({ ...a }))),
    approve: async (_r, _n, head, body) => { calls.push({ op: 'approve', head, body }); approvals.push({ id: nextId, commit: head, marker: body.split('\n')[0]! }); return nextId++; },
    dismissReview: async (_r, _n, id) => {
      calls.push({ op: 'dismiss', id });
      approvals.splice(approvals.findIndex((a) => a.id === id), 1);
    },
  };
  return { github, calls };
}

const decision = (profile: string, extra: Partial<Decision> = {}): Decision => ({
  decision_id: crypto.randomUUID(), action: 'light', profile, profile_version: 3, rule: 0, facts: {}, ...extra,
});

function fakeEngine(answer: (profile: string) => Response = (p) => Response.json(decision(p))) {
  const calls: { profile: string; key: string; body: any; auth: string }[] = [];
  const engine: EngineApi = {
    url: 'https://pointsman.example.org',
    fetch: async (url, init) => {
      const profile = decodeURIComponent(url.split('/v1/decide/')[1]!);
      const headers = new Headers(init.headers);
      calls.push({ profile, key: headers.get('idempotency-key')!, body: JSON.parse(String(init.body)), auth: headers.get('authorization')! });
      return answer(profile);
    },
  };
  return { engine, calls };
}

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const prEvent = (number = 7, action = 'synchronize', repo = REPO) =>
  ({ action, repository: { full_name: repo }, pull_request: { number }, sender: { login: 'someone' } });

/** A connector whose objects run in memory, one storage per pull request. */
function setup(s = settings()) {
  const objects = new Map<string, ReturnType<typeof memoryStorage>>();
  const accepted: string[] = [];
  const connector = githubConnector(s, {
    idFromName: (name) => name,
    get: (id) => ({
      async fetch(_url, init) {
        const name = id as unknown as string;
        if (!objects.has(name)) objects.set(name, memoryStorage());
        const work = pullRequestWork(s, objects.get(name)!.storage, fakeEngine().engine, fakeGitHub().github);
        const result = await work.accept(JSON.parse(String(init.body)), Date.now());
        accepted.push(`${name}:${result}`);
        return Response.json({ result });
      },
    }),
  });
  const post = async (event: string, payload: unknown, opts: { delivery?: string; signature?: string | null; body?: string } = {}) => {
    const body = opts.body ?? JSON.stringify(payload);
    const headers: Record<string, string> = { 'x-github-event': event, 'x-github-delivery': opts.delivery ?? crypto.randomUUID() };
    const signature = opts.signature === undefined ? await sign(body) : opts.signature;
    if (signature !== null) headers['x-hub-signature-256'] = signature;
    return connector.fetch(new Request('https://connector.example.org/webhook', { method: 'POST', body, headers }));
  };
  return { connector, objects, accepted, post };
}

describe('webhook', () => {
  it('refuses a missing or wrong signature before reading the event', async () => {
    const { post, accepted } = setup();
    expect((await post('pull_request', prEvent(), { signature: null })).status).toBe(401);
    expect((await post('pull_request', prEvent(), { signature: await sign('other body') })).status).toBe(401);
    expect((await post('pull_request', prEvent(), { signature: await sign(JSON.stringify(prEvent()), `${SECRET}x`) })).status).toBe(401);
    expect((await post('pull_request', prEvent(), { signature: 'sha256=zz' })).status).toBe(401);
    // A bad signature on a body that is not even JSON: still 401, not 400.
    expect((await post('pull_request', null, { body: 'not json', signature: 'sha1=abc' })).status).toBe(401);
    expect(accepted).toEqual([]);
  });

  it('takes a signed event for a configured repository, and answers ping', async () => {
    const { post, accepted } = setup();
    expect((await post('ping', { zen: 'x' })).status).toBe(200);
    const res = await post('pull_request', prEvent());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ results: ['accepted'] });
    expect(accepted).toEqual(['example/repo#7:accepted']);
  });

  it('drops a replayed delivery, and the same body with a new delivery id', async () => {
    const { post, accepted } = setup();
    const delivery = crypto.randomUUID();
    await post('pull_request', prEvent(), { delivery });
    await post('pull_request', prEvent(), { delivery });
    await post('pull_request', prEvent());
    expect(accepted).toEqual(['example/repo#7:accepted', 'example/repo#7:replay', 'example/repo#7:replay']);
  });

  it('ignores other repositories, other events and its own check runs', async () => {
    const { post, accepted } = setup();
    expect(await (await post('pull_request', prEvent(7, 'opened', 'other/repo'))).json()).toEqual({ ignored: true });
    await post('pull_request', prEvent(7, 'closed'));
    await post('issues', { action: 'opened', repository: { full_name: REPO } });
    await post('check_suite', { action: 'completed', repository: { full_name: REPO }, check_suite: { app: { id: APP_ID }, pull_requests: [{ number: 7 }] } });
    // Each check run: no (its suite counts).
    await post('check_run', { action: 'completed', repository: { full_name: REPO }, check_run: { app: { id: 1 }, pull_requests: [{ number: 7 }] } });
    expect(accepted).toEqual([]);
    await post('check_suite', { action: 'completed', repository: { full_name: REPO }, check_suite: { app: { id: 1 }, pull_requests: [{ number: 7 }, { number: 8 }] } });
    expect(accepted).toEqual(['example/repo#7:accepted', 'example/repo#8:accepted']);
  });

  it('refuses other paths, methods, a missing delivery id and large bodies', async () => {
    const { connector, post } = setup();
    expect((await connector.fetch(new Request('https://c.example.org/other', { method: 'POST' }))).status).toBe(404);
    expect((await connector.fetch(new Request('https://c.example.org/webhook'))).status).toBe(405);
    expect((await post('pull_request', prEvent(), { delivery: '../x' })).status).toBe(400);
    const big = new Request('https://c.example.org/webhook', { method: 'POST', body: 'x', headers: { 'content-length': String(3 * 1024 * 1024) } });
    expect((await connector.fetch(big)).status).toBe(413);
    // Without a Content-Length (a stream): read only up to the limit.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream({ pull(c) { if (sent++ < 3) c.enqueue(chunk); else c.close(); } });
    const chunked = new Request('https://c.example.org/webhook', { method: 'POST', body: stream, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
    expect((await connector.fetch(chunked)).status).toBe(413);
  });

  it('reads pull requests from check suites, not from forks (no numbers)', () => {
    expect(targetsOf('check_suite', { action: 'completed', repository: { full_name: REPO }, check_suite: { app: { id: 1 }, pull_requests: [] } }, APP_ID)).toEqual([]);
    expect(targetsOf('pull_request_review', { action: 'submitted', repository: { full_name: REPO }, pull_request: { number: 3 } }, APP_ID)).toEqual([{ repo: REPO, number: 3 }]);
    expect(targetsOf('pull_request', { action: 'opened', repository: { full_name: 'bad name' }, pull_request: { number: 3 } }, APP_ID)).toEqual([]);
  });
});

describe('the work of one pull request', () => {
  async function accepted(s = settings(), n = 1) {
    const mem = memoryStorage();
    const gh = fakeGitHub();
    const pm = fakeEngine();
    const work = pullRequestWork(s, mem.storage, pm.engine, gh.github);
    for (let i = 0; i < n; i++) await work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    return { work, mem, gh, pm };
  }

  it('asks each profile once for a burst of events, and shows each decision as a neutral check run', async () => {
    const { work, gh, pm, mem } = await accepted(settings(), 3);
    expect(mem.alarms).toHaveLength(3);
    await work.run();
    expect(pm.calls.map((c) => c.profile)).toEqual(['pr-docs-check', 'workflow-check']);
    expect(pm.calls[0]!.body).toEqual({
      state: { pull_request: { repo: REPO, number: 7, head: HEAD, title: 'Docs', body: 'A body' } },
      ref: `github:${REPO}#7@${HEAD}`,
    });
    const creates = gh.calls.filter((c) => c.op === 'create');
    expect(creates.map((c) => [c.name, c.head, c.output!.conclusion])).toEqual([
      ['Pointsman: pr-docs-check', HEAD, 'neutral'], ['Pointsman: workflow-check', HEAD, 'neutral'],
    ]);
    // Nothing but reading and check runs.
    expect(new Set(gh.calls.map((c) => c.op))).toEqual(new Set(['get', 'create']));
    // Nothing new: nothing to do.
    await work.run();
    expect(pm.calls).toHaveLength(2);
  });

  it('updates its check run on the same head, and makes a new one for a new head', async () => {
    const { work, gh, mem } = await accepted(settings({ profiles: ['pr-docs-check'] }));
    await work.run();
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await work.run();
    expect(gh.calls.filter((c) => c.op !== 'get').map((c) => [c.op, c.id])).toEqual([['create', undefined], ['update', 100]]);
    gh.github.state.head = HEAD2;
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await work.run();
    expect(gh.calls.filter((c) => c.op === 'create').map((c) => c.head)).toEqual([HEAD, HEAD2]);
    expect(mem.data.get('checks')).toMatchObject({ head: HEAD2 });
  });

  it('writes the record before the check run, and looks for it after a stop in between', async () => {
    const { work, gh, mem } = await accepted(settings({ profiles: ['pr-docs-check'] }));
    gh.github.createCheckRun = async () => {
      // The record is there before GitHub is asked.
      expect((mem.data.get('checks') as any).runs['pr-docs-check'].id).toBeUndefined();
      throw new Error('stopped');
    };
    await work.run();
    // The next run finds the check run that may have been made, and updates it.
    gh.github.existing = 555;
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await work.run();
    expect(gh.calls.filter((c) => c.op !== 'get').map((c) => [c.op, c.id ?? c.name])).toEqual([['find', 'Pointsman: pr-docs-check'], ['update', 555]]);
  });

  it('is tried again when Pointsman is down', async () => {
    const mem = memoryStorage();
    const gh = fakeGitHub();
    let down = true;
    const pm = fakeEngine((p) => (down ? new Response(null, { status: 503 }) : Response.json(decision(p))));
    const work = pullRequestWork(settings({ profiles: ['pr-docs-check'] }), mem.storage, pm.engine, gh.github);
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: 'd1', digest: 'x1' }, Date.now());
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    down = false;
    await work.run();
    expect(pm.calls).toHaveLength(2);
    expect(gh.calls.filter((c) => c.op === 'create')).toHaveLength(1);
  });

  it('is not tried again when Pointsman refuses (a setting to fix), and shows nothing', async () => {
    const mem = memoryStorage();
    const gh = fakeGitHub();
    const pm = fakeEngine(() => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const work = pullRequestWork(settings(), mem.storage, pm.engine, gh.github);
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: 'd1', digest: 'x1' }, Date.now());
    await work.run();
    expect(gh.calls.filter((c) => c.op !== 'get')).toEqual([]);
    expect(errors.mock.calls.join(' ')).not.toContain(pm.calls[0]!.auth.slice(7));
    errors.mockRestore();
  });

  it('is tried again when GitHub cannot be reached, not when it refuses', async () => {
    const { work, gh } = await accepted();
    gh.github.pullRequest = async () => { throw new GitHubError('GitHub pull request: TypeError', true); };
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    gh.github.pullRequest = async () => { throw new GitHubError('GitHub pull request: 404', false, 404); };
    await work.run();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('makes a new check run when its check run was deleted', async () => {
    const { work, gh } = await accepted(settings({ profiles: ['pr-docs-check'] }));
    await work.run();
    gh.github.updateCheckRun = async () => { throw new GitHubError('GitHub check run: 404', false, 404); };
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await work.run();
    expect(gh.calls.filter((c) => c.op === 'create')).toHaveLength(2);
  });

  it('leaves closed pull requests alone', async () => {
    const { work, gh, pm } = await accepted();
    gh.github.state.open = false;
    await work.run();
    expect(pm.calls).toEqual([]);
    expect(gh.calls.map((c) => c.op)).toEqual(['get']);
  });

  it('shows missing facts and the decision id; never blocks', () => {
    const d = decision('pr-docs-check', { action: 'retry', rule: null, facts: { ci: { missing: true, reason: 'unavailable' } } });
    const out = checkOutput(d);
    expect(out).toMatchObject({ conclusion: 'neutral', externalId: d.decision_id, title: 'retry (shadow)' });
    expect(out.summary).toContain('`ci` (unavailable)');
    expect(out.summary).toContain('by its default');
    expect(out.summary).toContain(d.decision_id);
  });
});

describe('settings and tokens', () => {
  const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_TOKEN: 'pm_x', GITHUB_CONNECTOR: JSON.stringify({ repos: ['Example/Repo'], profiles: ['pr-docs-check'] }) };

  it('is off without settings, and refuses missing or wrong ones', () => {
    expect(connectorSettings({})).toBeUndefined();
    expect(connectorSettings(env)!.repos).toEqual(new Set(['example/repo']));
    expect(() => connectorSettings({ ...env, GITHUB_WEBHOOK_SECRET: '' })).toThrow(/GITHUB_WEBHOOK_SECRET is not set/);
    expect(() => connectorSettings({ ...env, GITHUB_WEBHOOK_SECRET: 'short' })).toThrow(/at least 20/);
    expect(() => connectorSettings({ ...env, GITHUB_APP_PRIVATE_KEY: 'x' })).toThrow(/PEM/);
    expect(() => connectorSettings({ ...env, GITHUB_CONNECTOR: '{"repos":["a/b"],"profiles":["p"],"extra":{}}' })).toThrow(/unknown key extra/);
    expect(() => connectorSettings({ ...env, GITHUB_CONNECTOR: '{"repos":[],"profiles":["p"]}' })).toThrow(/repos/);
    expect(() => connectorSettings({ ...env, GITHUB_CONNECTOR: '{"repos":["a/b"],"profiles":["../x"]}' })).toThrow(/profiles/);
  });

  it('runs only in its own Worker, with its objects', () => {
    expect(githubModule.connect({}, { engine: fakeEngine().engine }, 'own')).toBeUndefined();
    expect(() => githubModule.connect(env, { engine: fakeEngine().engine }, 'own')).toThrow(ConfigError);
    const objects = { idFromName: () => 1, get: () => ({ fetch: async () => new Response() }) };
    expect(() => githubModule.connect({ ...env, PULL_REQUESTS: objects }, { engine: fakeEngine().engine }, 'engine')).toThrow(/own Worker/);
    expect(githubModule.connect({ ...env, PULL_REQUESTS: objects }, { engine: fakeEngine().engine }, 'own')).toBeDefined();
  });

  it('asks GitHub for a token that can only read pull requests and write check runs', async () => {
    expect(connectorScope({ metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'write' })).toEqual({ metadata: 'read', pull_requests: 'read', checks: 'write' });
    expect(connectorScope({ metadata: 'read', checks: 'read' })).toEqual({ metadata: 'read', checks: 'read' });

    const requests: { url: string; method: string; body?: any }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith('/installation')) return Response.json({ id: 9, permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'write' } });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      if (url.endsWith('/check-runs')) return Response.json({ id: 77 }, { status: 201 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const gh = new AppGitHub(APP_ID, KEY, fetchFn);
    expect(await gh.createCheckRun(REPO, HEAD, 'Pointsman: x', checkOutput(decision('x')))).toBe(77);
    expect(requests.find((r) => r.url.endsWith('/access_tokens'))!.body).toEqual({ permissions: { metadata: 'read', pull_requests: 'read', checks: 'write' }, repositories: ['repo'] });
    expect(requests.at(-1)).toMatchObject({ method: 'POST', body: { name: 'Pointsman: x', head_sha: HEAD, status: 'completed', conclusion: 'neutral' } });
  });

  it('classifies failures: not installed needs a person, a network error is tried again', async () => {
    const notInstalled = new AppGitHub(APP_ID, KEY, (async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
    await expect(notInstalled.pullRequest(REPO, 7)).rejects.toMatchObject({ retry: false });
    const down = new AppGitHub(APP_ID, KEY, (async () => { throw new TypeError('network'); }) as unknown as typeof fetch);
    await expect(down.pullRequest(REPO, 7)).rejects.toMatchObject({ retry: true });
    const busy = new AppGitHub(APP_ID, KEY, (async () => new Response(null, { status: 502 })) as unknown as typeof fetch);
    await expect(busy.pullRequest(REPO, 7)).rejects.toMatchObject({ retry: true });
  });
});

describe('actions (switched on per profile action)', () => {
  const ACT = { 'pr-docs-check': { light: { do: 'label' as const, labels: ['docs-only'] }, review: { do: 'request_reviewer' as const, reviewers: ['dkastl'] } } };

  async function acting(actions: ConnectorSettings['actions'], answer?: (p: string) => Response, pr: Partial<PullRequestInfo> = {}) {
    const mem = memoryStorage();
    const gh = fakeGitHub(pr);
    const pm = fakeEngine(answer);
    const work = pullRequestWork(settings({ profiles: ['pr-docs-check'], actions }), mem.storage, pm.engine, gh.github);
    const event = () => work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await event();
    return { work, mem, gh, pm, event };
  }
  const ops = (calls: { op: string }[]) => calls.map((c) => c.op).filter((o) => !['get', 'find', 'create', 'update', 'approvals'].includes(o));

  it('does nothing but the check run for an action that is not mapped', async () => {
    const { work, gh } = await acting(ACT, (p) => Response.json(decision(p, { action: 'wait' })));
    await work.run();
    expect(ops(gh.calls)).toEqual([]);
    expect(gh.calls.find((c) => c.op === 'create')!.output!.title).toBe('wait (shadow)');
  });

  it('carries out a mapped action once per head, and says so on the check run', async () => {
    const { work, gh, mem, event } = await acting(ACT, (p) => Response.json(decision(p, { action: 'light' })));
    await work.run();
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['label']);
    const last = gh.calls.filter((c) => c.output).at(-1)!.output!;
    expect(last.title).toBe('light');
    expect(last.conclusion).toBe('neutral');
    expect(last.summary).toContain('labels added: docs-only');
    expect((mem.data.get('acts') as any).done['pr-docs-check:label'].state).toBe('done');
    // A new head: once more.
    gh.github.state.head = HEAD2;
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['label', 'label']);
  });

  it('does nothing while a person checks the decision', async () => {
    const { work, gh } = await acting(ACT, (p) => Response.json(decision(p, { action: 'review', review: { status: 'pending' } })));
    await work.run();
    expect(ops(gh.calls)).toEqual([]);
    expect(gh.calls.find((c) => c.op === 'create')!.output!.summary).toContain('a person checks this decision first');
  });

  it('writes the record before the action; after a stop it looks for the trace, and waits before doing it again', async () => {
    const { work, gh, mem, event } = await acting({ 'pr-docs-check': { light: { do: 'comment', text: 'Docs only.' } } }, (p) => Response.json(decision(p, { action: 'light' })));
    let t = 1_000_000;
    work.now = () => t;
    gh.github.createComment = async () => {
      expect((mem.data.get('acts') as any).done['pr-docs-check:comment'].state).toBe('pending');
      throw new Error('stopped');
    };
    await expect(work.run()).resolves.toBeUndefined();
    // Not a GitHub answer that may pass: failed, not done again for this commit.
    expect((mem.data.get('acts') as any).done['pr-docs-check:comment'].state).toBe('failed');

    // A real stop between record and action: pending, no trace, young: not done again yet.
    mem.data.set('acts', { head: HEAD, done: { 'pr-docs-check:comment': { decision: 'd', state: 'pending', at: t } } });
    gh.github.createComment = async (_r, _n, body) => void gh.github.comments.push(body);
    await event();
    await work.run();
    expect(gh.github.comments).toEqual([]);
    expect(mem.alarms.at(-1)).toBe(t + UNCLEAR_MS);
    // Before the time: the alarm finds nothing to do.
    await work.run();
    expect(gh.github.comments).toEqual([]);
    // At the time, without a new event (the alarm alone): still no trace, so done again, once.
    t += UNCLEAR_MS;
    await work.run();
    expect(gh.github.comments).toHaveLength(1);
    expect(gh.github.comments[0]).toContain('Docs only.');
    expect(gh.github.comments[0]).toContain(`pointsman comment pr-docs-check ${HEAD}`);
  });

  it('a pending record with a trace on GitHub counts as done', async () => {
    const { work, gh, mem, event } = await acting(ACT, (p) => Response.json(decision(p, { action: 'light' })));
    mem.data.set('acts', { head: HEAD, done: { 'pr-docs-check:label': { decision: 'd', state: 'pending', at: Date.now() } } });
    gh.github.state.labels.push('docs-only');
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual([]);
    expect((mem.data.get('acts') as any).done['pr-docs-check:label'].state).toBe('done');
  });

  it('approves only the decided commit, never a draft or a fork, and dismisses its approval after a push', async () => {
    const APPROVE = { 'pr-docs-check': { light: { do: 'approve' as const } } };
    const light = (p: string) => Response.json(decision(p, { action: 'light' }));
    const draft = await acting(APPROVE, light, { draft: true });
    await draft.work.run();
    expect(ops(draft.gh.calls)).toEqual([]);
    const fork = await acting(APPROVE, light, { fork: true });
    await fork.work.run();
    expect(ops(fork.gh.calls)).toEqual([]);

    const { work, gh, event } = await acting(APPROVE, light);
    await work.run();
    expect(gh.calls.filter((c) => c.op === 'approve').map((c) => c.head)).toEqual([HEAD]);
    expect(gh.github.approvals).toEqual([{ id: expect.any(Number), commit: HEAD, marker: expect.stringContaining(HEAD) }]);

    // A push: the old approval is dismissed, and the new head is approved on its own decision.
    gh.github.state.head = HEAD2;
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['approve', 'dismiss', 'approve']);
    expect(gh.github.approvals.map((a) => a.commit)).toEqual([HEAD2]);
  });

  it('does not approve when the head moved between the decision and the approval', async () => {
    const { work, gh } = await acting({ 'pr-docs-check': { light: { do: 'approve' } } }, (p) => {
      gh.github.state.head = HEAD2; // a push while Pointsman decided
      return Response.json(decision(p, { action: 'light' }));
    });
    await work.run();
    expect(ops(gh.calls)).toEqual([]);
    expect(gh.calls.find((c) => c.op === 'create')!.output!.summary).toContain('the pull request changed');
  });

  it('a refused action (a missing label) is shown and not tried again for that commit', async () => {
    const { work, gh, event } = await acting(ACT, (p) => Response.json(decision(p, { action: 'light' })));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let tries = 0;
    gh.github.addLabels = async () => { tries++; throw new GitHubError('GitHub labels: 422', false, 422); };
    await work.run();
    await event();
    await work.run();
    expect(tries).toBe(1);
    const outputs = gh.calls.filter((c) => c.output).map((c) => c.output!.summary);
    expect(outputs[0]).toContain('failed (422)');
    expect(outputs.at(-1)).toContain('failed earlier; not tried again');
    errors.mockRestore();
  });

  it('settings: actions only for listed profiles, from the fixed list, with checked values', () => {
    const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_TOKEN: 'pm_x' };
    const conf = (actions: unknown) => ({ ...env, GITHUB_CONNECTOR: JSON.stringify({ repos: ['a/b'], profiles: ['p'], actions }) });
    expect(connectorSettings(conf({ p: { light: { do: 'label', labels: ['x'] } } }))!.actions).toEqual({ p: { light: { do: 'label', labels: ['x'] } } });
    expect(actsOnGitHub(connectorSettings(conf({ p: {} }))!)).toBe(false);
    expect(() => connectorSettings(conf({ q: { light: { do: 'label', labels: ['x'] } } }))).toThrow(/not in "profiles"/);
    expect(() => connectorSettings(conf({ p: { light: { do: 'merge' } } }))).toThrow(/"do" must be one of/);
    expect(() => connectorSettings(conf({ p: { light: { do: 'label', labels: [] } } }))).toThrow(/labels/);
    expect(() => connectorSettings(conf({ p: { light: { do: 'request_reviewer', reviewers: ['bad name'] } } }))).toThrow(/reviewers/);
    expect(() => connectorSettings(conf({ p: { light: { do: 'comment', text: '' } } }))).toThrow(/text/);
    expect(() => connectorSettings(conf({ p: { light: { do: 'approve', body: 'x' } } }))).toThrow(/unknown key body/);
  });

  it('asks for pull requests: write only when actions are switched on', () => {
    expect(actingScope({ metadata: 'read', pull_requests: 'write', checks: 'write' })).toEqual({ metadata: 'read', pull_requests: 'write', checks: 'write' });
    expect(connectorScope({ metadata: 'read', pull_requests: 'write', checks: 'write' })).toEqual({ metadata: 'read', pull_requests: 'read', checks: 'write' });
    // An app without write on pull requests: the token reads them; the actions then fail (403) and show on the check run.
    expect(actingScope({ metadata: 'read', pull_requests: 'read', checks: 'write' })).toEqual({ metadata: 'read', pull_requests: 'read', checks: 'write' });
  });

  it('withdraws its approval when a later decision on the same commit no longer approves', async () => {
    let action = 'light';
    const { work, gh, event } = await acting({ 'pr-docs-check': { light: { do: 'approve' } } }, (p) => Response.json(decision(p, { action })));
    await work.run();
    expect(gh.github.approvals).toHaveLength(1);
    action = 'review'; // CI failed, say: same commit, another decision
    await event();
    await work.run();
    expect(gh.github.approvals).toHaveLength(0);
    expect(ops(gh.calls)).toEqual(['approve', 'dismiss']);
    // Approving again later is possible.
    action = 'light';
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['approve', 'dismiss', 'approve']);
  });

  it('dismisses only approvals it recorded giving, and approves nothing while an old one cannot be dismissed', async () => {
    const light = (p: string) => Response.json(decision(p, { action: 'light' }));
    const { work, gh, event } = await acting({ 'pr-docs-check': { light: { do: 'approve' } } }, light);
    // Another bot's review with the marker: never touched.
    gh.github.approvals.push({ id: 999, commit: 'c'.repeat(40), marker: '<!-- pointsman approve pr-docs-check ' + 'c'.repeat(40) + ' -->' });
    await work.run();
    expect(gh.calls.filter((c) => c.op === 'dismiss')).toEqual([]);
    // A push; dismissing its own old approval fails: no new approval, the run still shows its checks.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    gh.github.dismissReview = async () => { throw new GitHubError('GitHub dismissal: 422', false, 422); };
    gh.github.state.head = HEAD2;
    await event();
    await work.run();
    expect(gh.calls.filter((c) => c.op === 'approve').map((c) => c.head)).toEqual([HEAD]);
    const last = gh.calls.filter((c) => c.output).at(-1)!.output!;
    expect(last.summary).toContain('an older approval could not be dismissed');
    errors.mockRestore();
  });

  it('asks Pointsman anew on every run, also on a retry', async () => {
    const mem = memoryStorage();
    const gh = fakeGitHub();
    let down = true;
    const pm = fakeEngine((p) => (down ? new Response(null, { status: 503 }) : Response.json(decision(p))));
    const work = pullRequestWork(settings({ profiles: ['pr-docs-check'] }), mem.storage, pm.engine, gh.github);
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: 'd1', digest: 'x1' }, Date.now());
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    down = false;
    await work.run();
    expect(pm.calls[0]!.key).not.toBe(pm.calls[1]!.key);
  });
});
