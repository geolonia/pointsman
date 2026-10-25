// The GitHub connector (docs/github-connector.md) with a fake GitHub, a fake
// Pointsman and an in-memory store for the pull requests' objects.

import { describe, expect, it, vi } from 'vitest';
import githubModule, {
  AppGitHub, GitHubError, actingScope, actionOf, botReviewOf, checkDecision, engineSetting, httpEngine, actsOnGitHub, authorText, readsDiff, scopeFor, checkOutput, connectorScope, connectorSettings, githubConnector, pullRequestWork, RetryError, targetsOf,
  type CheckRunOutput, type ConnectorGitHub, type ConnectorSettings, type Decision, type ObjectStorage, type OwnApproval, type PullRequestInfo, type ReviewSummary, UNCLEAR_MS,
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
  appId: APP_ID, privateKey: KEY, webhookSecret: SECRET, engine: { kind: 'http', url: 'https://pointsman.example.org', token: `pm_${crypto.randomUUID()}` },
  repos: new Set([REPO]), profiles: ['pr-docs-check', 'workflow-check'], actions: {}, runs: {}, ...extra,
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
    open: true, merged: false, author: 'author', head: HEAD, draft: false, base: 'main', title: 'Docs', body: 'A body', fork: false, labels: [], requestedReviewers: [], ...pr,
  };
  const approvals: OwnApproval[] = [];
  const comments: string[] = [];
  const github: ConnectorGitHub & { state: PullRequestInfo; existing?: number; approvals: OwnApproval[]; comments: string[]; diffText: string; summary: ReviewSummary; copilot: { requested: boolean; reviewed: string[]; refuse: boolean } } = {
    state,
    copilot: { requested: false, reviewed: [], refuse: false },
    summary: { head: HEAD, decision: null, reviews: [] },
    diffText: 'diff --git a/README.md b/README.md\n+one line\n',
    approvals,
    comments,
    pullRequest: async () => (calls.push({ op: 'get' }), { ...github.state, labels: [...github.state.labels], requestedReviewers: [...github.state.requestedReviewers] }),
    findCheckRun: async (_r, head, name) => (calls.push({ op: 'find', head, name }), github.existing),
    createCheckRun: async (_r, head, name, output) => (calls.push({ op: 'create', head, name, output }), nextId++),
    updateCheckRun: async (_r, id, output) => void calls.push({ op: 'update', id, output }),
    findComment: async (_r, _n, marker) => (calls.push({ op: 'findComment' }), comments.some((c) => c.startsWith(marker))),
    createComment: async (_r, _n, body) => { calls.push({ op: 'comment', body }); comments.push(body); return nextId++; },
    findOwnComment: async () => (calls.push({ op: 'findOwnComment' }), undefined),
    updateComment: async (_r, id, body) => void calls.push({ op: 'updateComment', id, body }),
    addLabels: async (_r, _n, labels) => { calls.push({ op: 'label', list: labels }); github.state.labels.push(...labels); },
    requestReviewers: async (_r, _n, reviewers) => { calls.push({ op: 'request', list: reviewers }); github.state.requestedReviewers.push(...reviewers); },
    requestCopilot: async () => {
      calls.push({ op: 'copilot' });
      if (github.copilot.refuse) throw new GitHubError('GitHub Copilot review request: Copilot was not added', false);
      github.copilot.requested = true;
    },
    copilotAsked: async (_r, _n, head) => (calls.push({ op: 'copilotAsked', head }), github.copilot.requested || github.copilot.reviewed.includes(head)),
    botLogin: async () => 'pointsman-test[bot]',
    ownApprovals: async () => (calls.push({ op: 'approvals' }), approvals.map((a) => ({ ...a }))),
    // By id: only when a recorded approval is not in the list. Not in `calls`.
    ownApproval: async (_r, _n, id) => { const a = approvals.find((x) => x.id === id); return a ? { ...a } : null; },
    // Read for the line on every run that draws it: not in `calls`, which follows what the connector decides and does.
    reviewSummary: async () => structuredClone(github.summary),
    diff: async (_r, _n, max) => (calls.push({ op: 'diff' }), { diff: github.diffText.slice(0, max), truncated: github.diffText.length > max }),
    approve: async (_r, _n, head, body) => { calls.push({ op: 'approve', head, body }); approvals.push({ id: nextId, commit: head, marker: body.split('\n')[0]! }); return nextId++; },
    dismissReview: async (_r, _n, id) => {
      calls.push({ op: 'dismiss', id });
      approvals.splice(approvals.findIndex((a) => a.id === id), 1);
    },
    // Answers in the pull request have tests of their own (github-answers.test.ts).
    permission: async () => { throw new Error('not used here'); },
    headPusher: async () => { throw new Error('not used here'); },
  };
  return { github, calls };
}

const decision = (profile: string, extra: Partial<Decision> = {}): Decision => ({
  decision_id: crypto.randomUUID(), action: 'light', profile, profile_version: 3, rule: 0, facts: {}, ...extra,
});

function fakeEngine(answer: (profile: string) => Response = (p) => Response.json(decision(p))) {
  const calls: { profile: string; key: string; body: any; auth: string }[] = [];
  /** The decisions it gave, by id, as GET /v1/decisions/{id} reads them back: a test sets a person's answer here. */
  const logged = new Map<string, any>();
  /** The get and close calls, in order. */
  const reads: { op: 'get' | 'close'; id: string; auth: string }[] = [];
  /** A test can make get or close answer otherwise. */
  const override: { get?: (id: string) => Response; close?: (id: string) => Response } = {};
  const api: EngineApi = {
    url: 'https://pointsman.example.org',
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      const byId = /\/v1\/(decisions|reviews)\/([^/]+)(\/close)?$/.exec(url);
      if (byId) {
        const id = decodeURIComponent(byId[2]!);
        const op = byId[3] ? 'close' : 'get';
        reads.push({ op, id, auth: headers.get('authorization')! });
        if (override[op]) return override[op]!(id);
        const record = logged.get(id);
        if (!record) return Response.json({ error: { code: 'decision_not_found', message: 'unknown decision' } }, { status: 404 });
        if (op === 'get') return Response.json(record);
        if (record.review?.status !== 'pending') return Response.json({ error: { code: 'not_pending', message: 'x' } }, { status: 409 });
        record.review = { status: 'superseded' };
        return Response.json({ decision_id: id, review: { status: 'superseded' } });
      }
      const profile = decodeURIComponent(url.split('/v1/decide/')[1]!);
      const sent = JSON.parse(String(init.body));
      calls.push({ profile, key: headers.get('idempotency-key')!, body: sent, auth: headers.get('authorization')! });
      const res = answer(profile);
      // As the engine does: a decision echoes the ref it was sent (one that sets its own ref keeps it).
      if (!res.ok) return res;
      const out: any = await res.clone().json().catch(() => undefined);
      const plain = out !== null && typeof out === 'object' && !Array.isArray(out);
      if (plain && typeof out.decision_id === 'string') logged.set(out.decision_id, { client: 'github-connector', feedback: [], ref: sent.ref, ...structuredClone(out) });
      return plain && !('ref' in out) ? Response.json({ ...out, ref: sent.ref }, { status: res.status }) : res;
    },
  };
  /** A person answers in Pointsman's review queue. */
  const resolve = (id: string, finalAction: string) => {
    logged.get(id).review = { status: 'resolved', resolved_by: 'someone@example.org', final_action: finalAction, resolved_at: '2026-10-25T00:00:00Z' };
  };
  // The HTTP adapter, as the connector Worker builds it.
  return { engine: httpEngine(api, `pm_${crypto.randomUUID()}`), api, calls, logged, reads, override, resolve };
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

  it('names the review of a review event only when a bot account sent it', () => {
    const review = (sender: unknown) => ({ action: 'submitted', repository: { full_name: REPO }, pull_request: { number: 3 }, review: { id: 42 }, sender });
    expect(botReviewOf('pull_request_review', review({ login: 'Pointsman[bot]', type: 'Bot' }))).toEqual({ id: 42, login: 'pointsman[bot]' });
    expect(botReviewOf('pull_request_review', review({ login: 'someone', type: 'User' }))).toBeUndefined();
    expect(botReviewOf('pull_request_review', review(undefined))).toBeUndefined();
    expect(botReviewOf('pull_request', review({ login: 'pointsman[bot]', type: 'Bot' }))).toBeUndefined();
    expect(botReviewOf('pull_request_review', { ...review({ type: 'Bot' }), review: { id: 'x' } })).toBeUndefined();
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
    expect(out).toMatchObject({ conclusion: 'neutral', externalId: d.decision_id, title: '🟡 retry (shadow)' });
    expect(out.summary).toContain('`ci` (unavailable)');
    expect(out.summary).toContain('by its default');
    expect(out.summary).toContain(d.decision_id);
  });
});

describe('settings and tokens', () => {
  const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x', GITHUB_CONNECTOR: JSON.stringify({ repos: ['Example/Repo'], profiles: ['pr-docs-check'] }) };

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
    expect(githubModule.connect({}, { engine: fakeEngine().api }, 'own')).toBeUndefined();
    expect(() => githubModule.connect(env, { engine: fakeEngine().api }, 'own')).toThrow(ConfigError);
    const objects = { idFromName: () => 1, get: () => ({ fetch: async () => new Response() }) };
    expect(() => githubModule.connect({ ...env, PULL_REQUESTS: objects }, { engine: fakeEngine().api }, 'engine')).toThrow(/own Worker/);
    expect(githubModule.connect({ ...env, PULL_REQUESTS: objects }, { engine: fakeEngine().api }, 'own')).toBeDefined();
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
    expect(gh.calls.find((c) => c.op === 'create')!.output!.title).toBe('🟡 wait (shadow)');
  });

  it('carries out a mapped action once per head, and says so on the check run', async () => {
    const { work, gh, mem, event } = await acting(ACT, (p) => Response.json(decision(p, { action: 'light' })));
    await work.run();
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['label']);
    const last = gh.calls.filter((c) => c.output).at(-1)!.output!;
    expect(last.title).toBe('🟡 light');
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
    gh.github.createComment = async (_r, _n, body) => gh.github.comments.push(body);
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

  it('leaves out the events about its own approval and its dismissal, not a person\'s or another bot\'s', async () => {
    const { work, gh, event } = await acting({ 'pr-docs-check': { light: { do: 'approve' as const } } }, (p) => Response.json(decision(p, { action: 'light' })));
    await work.run();
    const own = gh.github.approvals[0]!.id;
    const BOT = 'pointsman-test[bot]';
    const review = (botReview?: { id: number; login: string }) => work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID(), ...(botReview !== undefined && { botReview }) }, Date.now());
    expect(await review({ id: own, login: BOT })).toBe('own');
    // Another review, another bot dismissing its approval, or a person: a run.
    expect(await review({ id: own + 1000, login: BOT })).toBe('accepted');
    expect(await review({ id: own, login: 'other-app[bot]' })).toBe('accepted');
    expect(await review()).toBe('accepted');
    // Its own login cannot be read: a run, as before.
    const botLogin = gh.github.botLogin;
    gh.github.botLogin = async () => { throw new Error('no slug'); };
    expect(await review({ id: own, login: BOT })).toBe('accepted');
    gh.github.botLogin = botLogin;
    await work.run();
    // A push dismisses the approval: the event about that dismissal is its own too.
    gh.github.state.head = HEAD2;
    await event();
    await work.run();
    expect(ops(gh.calls)).toContain('dismiss');
    expect(await review({ id: own, login: BOT })).toBe('own');
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
    const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x' };
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

  it('keeps its approval when a later decision on the same commit says it is already approved (keep_approval)', async () => {
    let action = 'light';
    const KEEP = { 'pr-docs-check': { light: { do: 'approve' as const }, done: { do: 'keep_approval' as const } } };
    const { work, gh, mem, event } = await acting(KEEP, (p) => Response.json(decision(p, { action })));
    await work.run();
    expect(gh.github.approvals).toHaveLength(1);
    // CodeRabbit reviewed since: the profile now says done (already approved). The approval stands.
    action = 'done';
    await event();
    await work.run();
    expect(gh.github.approvals).toHaveLength(1);
    expect(ops(gh.calls)).toEqual(['approve']);
    const kept = gh.calls.filter((c) => c.output).at(-1)!.output!;
    expect(kept.title).toBe('🟢 done');
    expect(kept.summary).toContain('Done: approval of this commit kept');
    expect((mem.data.get('acts') as any).done['pr-docs-check:approve'].state).toBe('done');
    // Approving again on the same commit: no second approval.
    action = 'light';
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['approve']);
    expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('already done for this commit');
    // A later decision that neither approves nor keeps (a person must look, a review, a paid review, a split): withdrawn.
    for (const other of ['ask-person', 'review', 'pay', 'split']) {
      action = 'light';
      await event();
      await work.run();
      action = other;
      await event();
      await work.run();
      expect(gh.github.approvals, other).toHaveLength(0);
    }
    expect(ops(gh.calls)).toEqual(['approve', 'dismiss', 'approve', 'dismiss', 'approve', 'dismiss', 'approve', 'dismiss']);
  });

  it('keep_approval withdraws while a person checks the decision, keeps nothing on a new head, and approves nothing itself', async () => {
    let action = 'light';
    let review: Decision['review'];
    const KEEP = { 'pr-docs-check': { light: { do: 'approve' as const }, done: { do: 'keep_approval' as const } } };
    const { work, gh, event } = await acting(KEEP, (p) => Response.json(decision(p, { action, ...(review && { review }) })));
    // Never approved: keep_approval approves nothing.
    action = 'done';
    await work.run();
    expect(ops(gh.calls)).toEqual([]);
    expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('no approval of this commit to keep');
    // An edit changed the class: pr-risk is no longer approvable, so the next step asks a person. Withdrawn.
    action = 'light';
    await event();
    await work.run();
    gh.github.state.title = 'Now touches the workflows';
    action = 'ask-person';
    await event();
    await work.run();
    expect(gh.github.approvals).toHaveLength(0);
    // A push: the approval of the old head is dismissed, and done on the new head keeps nothing.
    action = 'light';
    await event();
    await work.run();
    gh.github.state.head = HEAD2;
    action = 'done';
    await event();
    await work.run();
    expect(gh.github.approvals).toHaveLength(0);
    // Still done, but a person checks it first: fail-safe, withdrawn (the question is kept for this head from then on).
    action = 'light';
    await event();
    await work.run();
    expect(gh.github.approvals).toHaveLength(1);
    action = 'done';
    review = { status: 'pending' };
    await event();
    await work.run();
    expect(gh.github.approvals).toHaveLength(0);
    expect(ops(gh.calls)).toEqual(['approve', 'dismiss', 'approve', 'dismiss', 'approve', 'dismiss']);
  });

  it('withdraws an approval whose run stopped before its id was kept, and says so when it cannot withdraw', async () => {
    let action = 'review';
    const { work, gh, mem, event } = await acting({ 'pr-docs-check': { light: { do: 'approve' } } }, (p) => Response.json(decision(p, { action })));
    // The approval is on GitHub, its record still pending, its id not kept.
    gh.github.approvals.push({ id: 555, commit: HEAD, marker: `<!-- pointsman approve pr-docs-check ${HEAD} -->` });
    mem.data.set('acts', { head: HEAD, done: { 'pr-docs-check:approve': { decision: 'd', state: 'pending', at: Date.now() } } });
    await work.run();
    expect(gh.calls.filter((c) => c.op === 'dismiss').map((c) => c.id)).toEqual([555]);
    expect(gh.github.approvals).toHaveLength(0);

    // Approved again; then dismissing fails: the check run says so, and the record stays for the next run.
    action = 'light';
    await event();
    await work.run();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    gh.github.dismissReview = async () => { throw new GitHubError('GitHub dismissal: 422', false, 422); };
    action = 'review';
    await event();
    await work.run();
    const last = gh.calls.filter((c) => c.output).at(-1)!.output!;
    expect(last.summary).toContain('could not be withdrawn');
    expect((mem.data.get('acts') as any).done['pr-docs-check:approve'].state).toBe('done');
    errors.mockRestore();
  });

  it('an approval missing from the review list (past its 1,000 reviews) is read by its id: dismissed, or kept when it cannot be read', async () => {
    let action = 'light';
    const { work, gh, mem, event } = await acting({ 'pr-docs-check': { light: { do: 'approve' } } }, (p) => Response.json(decision(p, { action })));
    await work.run();
    expect(gh.github.approvals).toHaveLength(1);
    // The list is cut before the approval; it still stands on GitHub.
    gh.github.ownApprovals = async () => [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const byId = gh.github.ownApproval;
    gh.github.ownApproval = async () => { throw new GitHubError('GitHub review: 502', false, 502); };
    action = 'review';
    await event();
    await work.run();
    // Not known: not dismissed, not forgotten, shown.
    expect(ops(gh.calls)).toEqual(['approve']);
    expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('could not be withdrawn');
    expect(mem.data.get('approvals')).toHaveLength(1);
    expect((mem.data.get('acts') as any).done['pr-docs-check:approve'].state).toBe('done');
    // GitHub busy (a retryable error): the run is retried, the record stays.
    gh.github.ownApproval = async () => { throw new GitHubError('GitHub review: 502', true, 502); };
    await event();
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    expect(ops(gh.calls)).toEqual(['approve']);
    expect(mem.data.get('approvals')).toHaveLength(1);
    // The next run reads it: still approved, so it is dismissed.
    gh.github.ownApproval = byId;
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['approve', 'dismiss']);
    expect(gh.github.approvals).toHaveLength(0);
    expect(mem.data.get('approvals')).toEqual([]);
    errors.mockRestore();
  });

  it('reads one review by id: its own standing approval, else null; 404 is gone, other errors are errors', async () => {
    const marker = `<!-- pointsman approve pr-docs-check ${HEAD} -->`;
    const answers: Record<string, Response | (() => Response)> = {
      '/pulls/7/reviews/1': Response.json({ id: 1, state: 'APPROVED', body: marker, commit_id: HEAD, user: { login: 'pointsman-checks[bot]', type: 'Bot' } }),
      '/pulls/7/reviews/2': Response.json({ id: 2, state: 'DISMISSED', body: marker, commit_id: HEAD, user: { login: 'pointsman-checks[bot]', type: 'Bot' } }),
      '/pulls/7/reviews/3': Response.json({ id: 3, state: 'APPROVED', body: marker, commit_id: HEAD, user: { login: 'other-app[bot]', type: 'Bot' } }),
      '/pulls/7/reviews/4': new Response('{}', { status: 404 }),
      '/pulls/7/reviews/5': new Response('{}', { status: 500 }),
    };
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/installation')) return Response.json({ id: 9, app_slug: 'pointsman-checks', permissions: { metadata: 'read', pull_requests: 'write', checks: 'write' } });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      const path = url.replace(`https://api.github.com/repos/${REPO}`, '');
      if (answers[path]) return answers[path] as Response;
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const gh = new AppGitHub(APP_ID, KEY, fetchFn, true);
    expect(await gh.ownApproval(REPO, 7, 1)).toEqual({ id: 1, commit: HEAD, marker });
    expect(await gh.ownApproval(REPO, 7, 2)).toBeNull();
    expect(await gh.ownApproval(REPO, 7, 3)).toBeNull();
    expect(await gh.ownApproval(REPO, 7, 4)).toBeNull();
    await expect(gh.ownApproval(REPO, 7, 5)).rejects.toBeInstanceOf(GitHubError);
  });

  it('an open approve record: kept when its trace is found, and a trace that cannot be read leaves it open and is shown', async () => {
    let action = 'done';
    const KEEP = { 'pr-docs-check': { light: { do: 'approve' as const }, done: { do: 'keep_approval' as const } } };
    const { work, gh, mem, event } = await acting(KEEP, (p) => Response.json(decision(p, { action })));
    const open = () => mem.data.set('acts', { head: HEAD, done: { 'pr-docs-check:approve': { decision: 'd', state: 'pending', at: Date.now() } } });
    const state = () => (mem.data.get('acts') as any).done['pr-docs-check:approve']?.state;
    const lastSummary = () => gh.calls.filter((c) => c.output).at(-1)!.output!.summary;
    // keep_approval: the approval is on GitHub, its record still open: found, closed and kept.
    gh.github.approvals.push({ id: 556, commit: HEAD, marker: `<!-- pointsman approve pr-docs-check ${HEAD} -->` });
    open();
    await work.run();
    expect(state()).toBe('done');
    expect(lastSummary()).toContain('approval of this commit kept');
    expect(ops(gh.calls)).toEqual([]);

    // The reviews cannot be read (an error that does not pass): the record stays open, the check run says so.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    gh.github.ownApprovals = async () => { throw new GitHubError('GitHub app token: GitHub installation: no app slug', false); };
    for (const [next, text] of [['done', 'unclear, the record stays open'], ['light', 'result unclear, the record stays open'], ['review', 'could not be withdrawn']] as const) {
      open();
      action = next;
      await event();
      await work.run();
      expect(state(), next).toBe('pending');
      expect(lastSummary(), next).toContain(text);
    }
    expect(ops(gh.calls)).toEqual([]);
    errors.mockRestore();
  });

  it('settings: keep_approval only next to approve, without settings', () => {
    const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x' };
    const conf = (actions: unknown) => ({ ...env, GITHUB_CONNECTOR: JSON.stringify({ repos: ['a/b'], profiles: ['p'], actions }) });
    expect(connectorSettings(conf({ p: { light: { do: 'approve' }, done: { do: 'keep_approval' } } }))!.actions).toEqual({ p: { light: { do: 'approve' }, done: { do: 'keep_approval' } } });
    expect(() => connectorSettings(conf({ p: { done: { do: 'keep_approval' } } }))).toThrow(/keep_approval needs an action of the same profile mapped to approve/);
    expect(() => connectorSettings(conf({ p: { light: { do: 'approve' }, done: { do: 'keep_approval', for: 'x' } } }))).toThrow(/unknown key for/);
  });

  it('settings: no approve or keep_approval in a profile asked once per head', () => {
    const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x' };
    const conf = (actions: unknown) => ({ ...env, GITHUB_CONNECTOR: JSON.stringify({ repos: ['a/b'], profiles: ['p', 'q'], actions, runs: { p: { once_per_head: {} } } }) });
    expect(() => connectorSettings(conf({ p: { light: { do: 'approve' } } }))).toThrow(/runs\.p\.once_per_head: not with an action mapped to approve or keep_approval/);
    expect(() => connectorSettings(conf({ p: { light: { do: 'approve' }, done: { do: 'keep_approval' } } }))).toThrow(/once_per_head: not with/);
    // Another action in that profile, or an approval in a profile asked every run: allowed.
    expect(connectorSettings(conf({ p: { risky: { do: 'label', labels: ['risky'] } }, q: { light: { do: 'approve' } } }))!.runs).toEqual({ p: { oncePerHead: { rerun: [] } } });
  });

  it('counts only its own bot\'s approvals as its own (the app\'s slug from the installation), never another bot\'s', async () => {
    const marker = `<!-- pointsman approve pr-docs-check ${HEAD} -->`;
    const reviewList = [
      { id: 1, state: 'APPROVED', body: marker, commit_id: HEAD, user: { login: 'pointsman-checks[bot]', type: 'Bot' } },
      { id: 2, state: 'APPROVED', body: marker, commit_id: HEAD, user: { login: 'other-app[bot]', type: 'Bot' } },
      { id: 3, state: 'APPROVED', body: marker, commit_id: HEAD, user: { login: 'pointsman-checks[bot]', type: 'User' } },
      { id: 4, state: 'APPROVED', body: marker, commit_id: HEAD, user: { login: 'pointsman-checks', type: 'User' } },
      { id: 5, state: 'DISMISSED', body: marker, commit_id: HEAD, user: { login: 'pointsman-checks[bot]', type: 'Bot' } },
      { id: 6, state: 'APPROVED', body: 'Looks good', commit_id: HEAD, user: { login: 'pointsman-checks[bot]', type: 'Bot' } },
    ];
    const fetchWith = (installation: Record<string, unknown>) => (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/installation')) return Response.json({ id: 9, permissions: { metadata: 'read', pull_requests: 'write', checks: 'write' }, ...installation });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      if (url.includes('/pulls/7/reviews')) return Response.json(reviewList);
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const gh = new AppGitHub(APP_ID, KEY, fetchWith({ app_slug: 'pointsman-checks' }), true);
    expect(await gh.ownApprovals(REPO, 7)).toEqual([{ id: 1, commit: HEAD, marker }]);
    // GitHub did not name the app: none is taken for its own (an error, so nothing is approved or recorded on it).
    const unnamed = new AppGitHub(APP_ID, KEY, fetchWith({}), true);
    await expect(unnamed.ownApprovals(REPO, 7)).rejects.toMatchObject({ retry: false, message: expect.stringContaining('no app slug') });
  });

  it('reads the review decision and the reviews in one GraphQL query, without their text; errors are errors', async () => {
    const sent: { url: string; method: string; body: any }[] = [];
    let answer: unknown;
    const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/installation')) return Response.json({ id: 9, app_slug: 'pointsman-checks', permissions: { metadata: 'read', pull_requests: 'write', checks: 'write' } });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      sent.push({ url, method: init.method ?? 'GET', body: JSON.parse(String(init.body)) });
      return Response.json(answer);
    }) as typeof fetch;
    const gh = new AppGitHub(APP_ID, KEY, fetchFn, true);
    const node = (databaseId: number, state: string, author: unknown, oid: string | null = HEAD) => ({ databaseId, state, commit: oid ? { oid } : null, author, body: 'Looks good @everyone' });
    answer = { data: { repository: { pullRequest: { headRefOid: HEAD, reviewDecision: 'APPROVED', reviews: { nodes: [
      node(1, 'APPROVED', { __typename: 'Bot', login: 'pointsman-checks' }),
      node(2, 'APPROVED', { __typename: 'Bot', login: 'coderabbitai' }),
      node(3, 'COMMENTED', { __typename: 'User', login: 'pointsman-checks' }),
      node(4, 'CHANGES_REQUESTED', null, null),
      node(5, 'APPROVED', { __typename: 'User', login: 'Bob' }),
    ] } } } } };
    expect(await gh.reviewSummary(REPO, 7)).toEqual({ head: HEAD, decision: 'APPROVED', reviews: [
      { id: 1, state: 'APPROVED', commit: HEAD, login: 'pointsman-checks[bot]', own: true },
      { id: 2, state: 'APPROVED', commit: HEAD, login: 'coderabbitai[bot]', own: false },
      { id: 3, state: 'COMMENTED', commit: HEAD, login: 'pointsman-checks', own: false },
      { id: 4, state: 'CHANGES_REQUESTED', commit: '', login: 'ghost:4', own: false },
      { id: 5, state: 'APPROVED', commit: HEAD, login: 'bob', own: false },
    ] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://api.github.com/graphql', method: 'POST', body: { variables: { owner: 'example', name: 'repo', number: 7 } } });
    expect(sent[0]!.body.query).toMatch(/^query\b/);
    expect(sent[0]!.body.query).not.toMatch(/mutation|body/);
    // No review rule: GitHub decides nothing.
    answer = { data: { repository: { pullRequest: { headRefOid: HEAD, reviewDecision: null, reviews: { nodes: [] } } } } };
    expect((await gh.reviewSummary(REPO, 7)).decision).toBeNull();
    for (const bad of [{ errors: [{ type: 'RATE_LIMITED' }], data: null }, { data: { repository: { pullRequest: null } } }, { errors: [{ message: 'x' }], data: { repository: { pullRequest: { headRefOid: HEAD, reviewDecision: 'APPROVED', reviews: { nodes: [] } } } } }]) {
      answer = bad;
      await expect(gh.reviewSummary(REPO, 7), JSON.stringify(bad)).rejects.toBeInstanceOf(GitHubError);
    }
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

  it('keeps a due recheck when that run is to be tried again', async () => {
    const { work, gh, mem } = await acting({ 'pr-docs-check': { light: { do: 'comment', text: 'Docs only.' } } }, (p) => Response.json(decision(p, { action: 'light' })));
    let t = 2_000_000;
    work.now = () => t;
    await work.run(); // the event: comment written
    // An unclear comment on this head, due for its recheck now.
    mem.data.set('acts', { head: HEAD, done: { 'pr-docs-check:comment': { decision: 'd', state: 'pending', at: t - UNCLEAR_MS } } });
    mem.data.set('recheckAt', t);
    gh.github.comments.length = 0;
    const findComment = gh.github.findComment;
    gh.github.findComment = async () => { throw new GitHubError('GitHub comments: 502', true, 502); };
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    expect(mem.data.get('recheckAt')).toBe(t);
    // The retried alarm: the recheck runs, no trace, the comment is written again once.
    gh.github.findComment = findComment;
    await work.run();
    expect(gh.github.comments).toHaveLength(1);
  });

  describe('copilot_review', () => {
    const COPILOT = { 'pr-docs-check': { light: { do: 'copilot_review' as const } } };
    const light = (p: string) => Response.json(decision(p, { action: 'light' }));
    const asks = (calls: { op: string }[]) => calls.filter((c) => c.op === 'copilot').length;

    it('is a kind with no settings', () => {
      const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x' };
      const conf = (spec: unknown) => ({ ...env, GITHUB_CONNECTOR: JSON.stringify({ repos: ['a/b'], profiles: ['p'], actions: { p: { light: spec } } }) });
      expect(connectorSettings(conf({ do: 'copilot_review' }))!.actions.p!.light).toEqual({ do: 'copilot_review' });
      expect(() => connectorSettings(conf({ do: 'copilot_review', reviewers: ['someone'] }))).toThrow(/unknown key reviewers/);
    });

    it('asks Copilot once per head, and says so on the check run', async () => {
      const { work, gh, event } = await acting(COPILOT, light);
      await work.run();
      await event();
      await work.run();
      expect(asks(gh.calls)).toBe(1);
      expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('review requested from Copilot');
      gh.github.state.head = HEAD2;
      gh.github.copilot.requested = false;
      await event();
      await work.run();
      expect(asks(gh.calls)).toBe(2);
    });

    it('does not ask again when Copilot is already requested or reviewed this head, whoever asked', async () => {
      const { work, gh, mem } = await acting(COPILOT, light);
      gh.github.copilot.reviewed = [HEAD];
      await work.run();
      expect(asks(gh.calls)).toBe(0);
      expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('Copilot already asked or reviewed this commit');
      expect((mem.data.get('acts') as any).done['pr-docs-check:copilot_review'].state).toBe('done');
      // A review of an older head does not count; a pending request does.
      const other = await acting(COPILOT, light);
      other.gh.github.copilot.reviewed = [HEAD2];
      other.gh.github.copilot.requested = true;
      await other.work.run();
      expect(asks(other.gh.calls)).toBe(0);
    });

    it('asks once when two profiles map it', async () => {
      const mem = memoryStorage();
      const gh = fakeGitHub();
      const pm = fakeEngine(light);
      const actions = { 'pr-docs-check': { light: { do: 'copilot_review' as const } }, 'workflow-check': { light: { do: 'copilot_review' as const } } };
      const work = pullRequestWork(settings({ actions }), mem.storage, pm.engine, gh.github);
      await work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
      await work.run();
      expect(asks(gh.calls)).toBe(1);
    });

    it('is not done for a pull request from a fork, or a closed one', async () => {
      for (const pr of [{ fork: true }, { open: false }]) {
        const { work, gh } = await acting(COPILOT, light, pr);
        await work.run();
        expect(gh.calls.filter((c) => c.op.startsWith('copilot')), JSON.stringify(pr)).toEqual([]);
      }
      const { work, gh } = await acting(COPILOT, light, { fork: true });
      await work.run();
      expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('copilot_review: not done for a closed pull request or one from a fork');
    });

    it('asks nothing while it cannot read whether Copilot was asked, and looks again later', async () => {
      const { work, gh, mem, event } = await acting(COPILOT, light);
      const t = 5_000_000;
      work.now = () => t;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      gh.github.copilotAsked = async () => { throw new GitHubError('GitHub reviews: 404', false, 404); };
      await work.run();
      expect(asks(gh.calls)).toBe(0);
      expect((mem.data.get('acts') as any)?.done?.['pr-docs-check:copilot_review']).toBeUndefined();
      expect(mem.data.get('recheckAt')).toBe(t + UNCLEAR_MS);
      expect(mem.alarms).toContain(t + UNCLEAR_MS);
      expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('whether Copilot was asked is unclear, checked again later');
      // A GitHub error that may pass: the run is tried again, nothing recorded, nothing asked.
      gh.github.copilotAsked = async () => { throw new GitHubError('GitHub reviews: 502', true, 502); };
      await event();
      await expect(work.run()).rejects.toBeInstanceOf(RetryError);
      expect(asks(gh.calls)).toBe(0);
      expect((mem.data.get('acts') as any)?.done?.['pr-docs-check:copilot_review']).toBeUndefined();
    });

    it('asks nothing when the head moved after the decision', async () => {
      const { work, gh } = await acting(COPILOT, light);
      const copilotAsked = gh.github.copilotAsked;
      // The push lands between the decision and the request.
      gh.github.copilotAsked = async (r, n, h) => { const asked = await copilotAsked(r, n, h); gh.github.state.head = HEAD2; return asked; };
      await work.run();
      expect(asks(gh.calls)).toBe(0);
      expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('copilot_review: not done, the pull request changed');
    });

    it('settles a request left open by a stop through its trace, without asking again', async () => {
      const { work, gh, mem, event } = await acting(COPILOT, light);
      mem.data.set('acts', { head: HEAD, done: { 'pr-docs-check:copilot_review': { decision: 'd', state: 'pending', at: Date.now() } } });
      gh.github.copilot.requested = true;
      await event();
      await work.run();
      expect(asks(gh.calls)).toBe(0);
      expect((mem.data.get('acts') as any).done['pr-docs-check:copilot_review'].state).toBe('done');
    });

    it('counts a request GitHub did not take as refused: not tried again for that commit', async () => {
      const { work, gh, mem, event } = await acting(COPILOT, light);
      gh.github.copilot.refuse = true;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await work.run();
      await event();
      await work.run();
      expect(asks(gh.calls)).toBe(1);
      expect((mem.data.get('acts') as any).done['pr-docs-check:copilot_review'].state).toBe('failed');
      expect(gh.calls.filter((c) => c.output).at(-1)!.output!.summary).toContain('failed earlier');
    });

    it('asks GitHub for the fixed reviewer, checks the answer, and knows Copilot by its account id', async () => {
      const COPILOT_BOT = { login: 'Copilot', id: 175728472, type: 'Bot' };
      const sent: { url: string; method: string; body?: any }[] = [];
      let answer: Record<string, unknown> = {};
      let reviews: unknown[] = [];
      const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/installation')) return Response.json({ id: 9, permissions: { metadata: 'read', pull_requests: 'write', checks: 'write' } });
        if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
        sent.push({ url, method: init.method ?? 'GET', ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (url.includes('/reviews')) return Response.json(reviews);
        return Response.json(answer, { status: init.method === 'POST' ? 201 : 200 });
      }) as typeof fetch;
      const gh = new AppGitHub(APP_ID, KEY, fetchFn, true);
      answer = { requested_reviewers: [COPILOT_BOT] };
      await gh.requestCopilot(REPO, 7);
      expect(sent[0]).toEqual({ url: 'https://api.github.com/repos/example/repo/pulls/7/requested_reviewers', method: 'POST', body: { reviewers: ['copilot-pull-request-reviewer[bot]'] } });
      // A 201 without Copilot (Copilot review off), or an account that only takes its name: refused.
      for (const listed of [[], [{ login: 'Copilot', id: 1, type: 'User' }], [{ ...COPILOT_BOT, type: 'User' }]]) {
        answer = { requested_reviewers: listed };
        await expect(gh.requestCopilot(REPO, 7), JSON.stringify(listed)).rejects.toMatchObject({ retry: false });
      }
      answer = { requested_reviewers: [COPILOT_BOT] };
      expect(await gh.copilotAsked(REPO, 7, HEAD)).toBe(true);
      answer = { requested_reviewers: [{ login: 'Copilot', id: 5, type: 'Bot' }] };
      reviews = [
        { user: { login: 'copilot-pull-request-reviewer[bot]', id: 175728472, type: 'Bot' }, commit_id: HEAD2, state: 'COMMENTED' },
        { user: { login: 'copilot-pull-request-reviewer[bot]', id: 6, type: 'Bot' }, commit_id: HEAD, state: 'COMMENTED' },
        { user: { login: 'copilot-pull-request-reviewer[bot]', id: 175728472, type: 'Bot' }, commit_id: HEAD, state: 'PENDING' },
      ];
      expect(await gh.copilotAsked(REPO, 7, HEAD)).toBe(false);
      reviews.push({ user: { login: 'copilot-pull-request-reviewer[bot]', id: 175728472, type: 'Bot' }, commit_id: HEAD, state: 'COMMENTED' });
      expect(await gh.copilotAsked(REPO, 7, HEAD)).toBe(true);
      // 1,000 reviews (the most #list reads) without one of the head: not known, an error.
      reviews = Array.from({ length: 100 }, () => ({ user: { login: 'someone', id: 9, type: 'User' }, commit_id: HEAD, state: 'COMMENTED' }));
      await expect(gh.copilotAsked(REPO, 7, HEAD)).rejects.toMatchObject({ retry: false });
    });
  });
});

describe('chains: profiles that build on each other', () => {
  const RISK = 'pr-risk';
  const NEXT = 'pr-next-step';
  const chain = (runs: ConnectorSettings['runs'] = {
    [RISK]: { skipDrafts: true, oncePerHead: { rerun: ['incomplete'] }, diff: 2000 },
    [NEXT]: { requires: { risk: RISK }, recheck: { actions: ['wait'], minutes: 10, max: 2 } },
  }) => settings({ profiles: [RISK, NEXT], runs });

  async function chained(s = chain(), pr: Partial<PullRequestInfo> = {}, answer?: (p: string) => Response) {
    const mem = memoryStorage();
    const gh = fakeGitHub(pr);
    const pm = fakeEngine(answer ?? ((p) => Response.json(decision(p, { action: p === RISK ? 'normal' : 'wait' }))));
    const work = pullRequestWork(s, mem.storage, pm.engine, gh.github);
    let t = 5_000_000;
    work.now = () => t;
    const event = () => work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, t);
    await event();
    return { work, mem, gh, pm, event, later: (ms: number) => { t += ms; } };
  }

  it('sends the decision of the required profile from the same run, and the diff where asked', async () => {
    const { work, pm } = await chained();
    await work.run();
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT]);
    expect(pm.calls[0]!.body.state.pull_request).toMatchObject({ diff: 'diff --git a/README.md b/README.md\n+one line\n', diff_truncated: false });
    expect(pm.calls[0]!.body.decisions).toBeUndefined();
    expect(pm.calls[1]!.body.state.pull_request.diff).toBeUndefined();
    const risk = pm.calls[0]!;
    expect(pm.calls[1]!.body.decisions).toEqual({ risk: expect.any(String) });
    expect(pm.calls[1]!.key).not.toBe(risk.key);
  });

  it('cuts a long diff and says so', async () => {
    const { work, pm, gh } = await chained();
    gh.github.diffText = 'x'.repeat(5000);
    await work.run();
    expect(pm.calls[0]!.body.state.pull_request.diff).toHaveLength(2000);
    expect(pm.calls[0]!.body.state.pull_request.diff_truncated).toBe(true);
  });

  it('does not ask a skipped profile for a draft; the next one is asked without it', async () => {
    const { work, pm, gh } = await chained(chain(), { draft: true });
    await work.run();
    expect(pm.calls.map((c) => c.profile)).toEqual([NEXT]);
    expect(pm.calls[0]!.body.decisions).toBeUndefined();
    expect(gh.calls.filter((c) => c.op === 'diff')).toHaveLength(0);
  });

  it('asks a once-per-head profile again only for a new head, title, body or base, or after a rerun action', async () => {
    const ids: string[] = [];
    let riskAction = 'normal';
    const { work, pm, gh, event } = await chained(chain(), {}, (p) => {
      const d = decision(p, { action: p === RISK ? riskAction : 'wait' });
      if (p === RISK) ids.push(d.decision_id);
      return Response.json(d);
    });
    await work.run();
    await event();
    await work.run();
    // pr-risk once, pr-next-step twice, both times with the same pr-risk decision.
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT, NEXT]);
    expect(pm.calls[2]!.body.decisions).toEqual({ risk: ids[0] });
    expect(gh.calls.filter((c) => c.op === 'diff')).toHaveLength(1);
    // An edited title: asked again.
    gh.github.state.title = 'Docs: another title';
    await event();
    await work.run();
    expect(pm.calls.filter((c) => c.profile === RISK)).toHaveLength(2);
    // A rerun action (facts were missing): asked again on the next run.
    riskAction = 'incomplete';
    gh.github.state.body = 'edited';
    await event();
    await work.run();
    await event();
    await work.run();
    expect(pm.calls.filter((c) => c.profile === RISK)).toHaveLength(4);
    // A new head: asked again.
    riskAction = 'normal';
    gh.github.state.head = HEAD2;
    await event();
    await work.run();
    expect(pm.calls.filter((c) => c.profile === RISK)).toHaveLength(5);
    expect(pm.calls.at(-1)!.body.decisions).toEqual({ risk: ids.at(-1) });
  });

  it('asks a waiting profile again after its minutes, without an event, at most max times per head', async () => {
    const { work, pm, mem, later, event } = await chained();
    await work.run();
    expect(mem.data.get('recheckAt')).toBe(5_000_000 + 10 * 60_000);
    // Not due yet: nothing; the alarm for it stays set.
    later(60_000);
    await work.run();
    expect(pm.calls).toHaveLength(2);
    expect(mem.alarms.at(-1)).toBe(5_000_000 + 10 * 60_000);
    later(9 * 60_000);
    await work.run();
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT, NEXT]);
    later(10 * 60_000);
    await work.run();
    expect(pm.calls).toHaveLength(4);
    // max 2 per head: no third recheck.
    later(10 * 60_000);
    await work.run();
    expect(pm.calls).toHaveLength(4);
    // An event still asks.
    await event();
    await work.run();
    expect(pm.calls).toHaveLength(5);
  });

  it('counts rechecks per profile: one that used its max is not asked again by a recheck', async () => {
    const s = { ...chain({ a: { recheck: { actions: ['wait'], minutes: 10, max: 1 } }, b: { recheck: { actions: ['wait'], minutes: 10, max: 3 } } }), profiles: ['a', 'b'] };
    const { work, pm, later } = await chained(s, {}, (p) => Response.json(decision(p, { action: 'wait' })));
    await work.run(); // the event: a, b
    for (let i = 0; i < 4; i++) { later(10 * 60_000); await work.run(); }
    // a: 1 recheck, b: 3 rechecks.
    expect(pm.calls.filter((c) => c.profile === 'a')).toHaveLength(2);
    expect(pm.calls.filter((c) => c.profile === 'b')).toHaveLength(4);
  });

  it('a retried recheck keeps the deadline that was due, not a later one', async () => {
    const s = { ...chain({ a: { recheck: { actions: ['wait'], minutes: 10, max: 3 } }, b: {} }), profiles: ['a', 'b'] };
    let down = false;
    const { work, mem, later } = await chained(s, {}, (p) => (down && p === 'b' ? new Response(null, { status: 503 }) : Response.json(decision(p, { action: 'wait' }))));
    await work.run();
    const due = mem.data.get('recheckAt') as number;
    later(10 * 60_000);
    down = true;
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    expect(mem.data.get('recheckAt')).toBe(due);
  });

  it('a recheck that fails does not use one up; an event when a recheck is due counts as an event', async () => {
    const s = { ...chain({ a: { recheck: { actions: ['wait'], minutes: 10, max: 1 } } }), profiles: ['a'] };
    let down = false;
    const { work, pm, mem, later } = await chained(s, {}, (p) => (down ? new Response(null, { status: 503 }) : Response.json(decision(p, { action: 'wait' }))));
    await work.run();
    later(10 * 60_000);
    down = true;
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    down = false;
    await work.run(); // the retried recheck: still allowed
    expect(pm.calls.filter((c) => !c.body.decisions)).toHaveLength(3);
    expect((mem.data.get('rechecks') as { count: Record<string, number> }).count.a).toBe(1);
    // A new recheck is due, but an event comes first: an event run, not counted.
    const { work: w2, pm: pm2, mem: mem2, later: later2, event: event2 } = await chained(s, {}, (p) => Response.json(decision(p, { action: 'wait' })));
    await w2.run();
    later2(10 * 60_000);
    await event2();
    await w2.run();
    expect(pm2.calls).toHaveLength(2);
    expect(mem2.data.get('rechecks')).toBeUndefined();
  });

  it('a new head gets its own recheck deadline, not the older head\'s earlier one', async () => {
    const s = { ...chain({ a: { recheck: { actions: ['wait'], minutes: 10, max: 1 } } }), profiles: ['a'] };
    const { work, mem, gh, later, event } = await chained(s, {}, (p) => Response.json(decision(p, { action: 'wait' })));
    await work.run();
    later(9 * 60_000);
    gh.github.state.head = HEAD2;
    await event();
    await work.run();
    expect(mem.data.get('recheckAt')).toBe(5_000_000 + 19 * 60_000);
    expect(mem.data.get('recheckHead')).toBe(HEAD2);
  });

  it('a new head voids the older head\'s recheck deadline, also when nothing waits on the new head', async () => {
    const s = { ...chain({ a: { recheck: { actions: ['wait'], minutes: 10, max: 1 } } }), profiles: ['a'] };
    let action = 'wait';
    const { work, pm, mem, gh, later, event } = await chained(s, {}, (p) => Response.json(decision(p, { action })));
    await work.run(); // head A waits: recheck due in 10 min
    later(9 * 60_000);
    action = 'done';
    gh.github.state.head = HEAD2;
    await event();
    await work.run(); // head B: done, no recheck
    expect(mem.data.get('recheckAt')).toBe(0);
    later(2 * 60_000);
    await work.run(); // A's old deadline passed: nothing is asked
    expect(pm.calls).toHaveLength(2);
    expect(mem.data.get('rechecks')).toBeUndefined();
  });

  it('a recheck whose check run fails is not counted', async () => {
    const s = { ...chain({ a: { recheck: { actions: ['wait'], minutes: 10, max: 1 } } }), profiles: ['a'] };
    const { work, mem, gh, later } = await chained(s, {}, (p) => Response.json(decision(p, { action: 'wait' })));
    await work.run();
    later(10 * 60_000);
    const update = gh.github.updateCheckRun;
    gh.github.updateCheckRun = async () => { throw new GitHubError('GitHub check run: 502', true, 502); };
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    expect(mem.data.get('rechecks')).toBeUndefined();
    gh.github.updateCheckRun = update;
    await work.run();
    expect((mem.data.get('rechecks') as { count: Record<string, number> }).count.a).toBe(1);
  });

  it('does not schedule a recheck for an action that does not wait', async () => {
    const { work, mem } = await chained(chain(), {}, (p) => Response.json(decision(p, { action: 'done' })));
    await work.run();
    expect(mem.data.get('recheckAt')).toBeUndefined();
  });

  it('keeps a decision only after its check run is written, so a retried run asks again', async () => {
    const { work, pm, gh } = await chained();
    const create = gh.github.createCheckRun;
    let fail = true;
    gh.github.createCheckRun = async (...a) => { if (fail) { fail = false; throw new GitHubError('GitHub check run: 502', true, 502); } return create(...a); };
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    await work.run();
    expect(pm.calls.filter((c) => c.profile === RISK)).toHaveLength(2);
  });

  it('does not keep a decision whose action was not done, so a later run does it', async () => {
    const s = { ...chain({ [RISK]: { oncePerHead: { rerun: [] } } }), profiles: [RISK], actions: { [RISK]: { normal: { do: 'approve' as const } } } };
    const { work, pm, gh, event } = await chained(s, { draft: true });
    await work.run(); // a draft: approve skipped
    expect(gh.calls.filter((c) => c.op === 'approve')).toHaveLength(0);
    gh.github.state.draft = false;
    await event();
    await work.run(); // ready on the same head: asked again, approved
    expect(pm.calls).toHaveLength(2);
    expect(gh.calls.filter((c) => c.op === 'approve')).toHaveLength(1);
  });

  it('keeps a decision a person still checks as the question: read back, not asked again, and sent on as it is', async () => {
    const { work, pm, event } = await chained(chain(), {}, (p) => Response.json(decision(p, { action: 'normal', review: { status: 'pending' } })));
    await work.run();
    await event();
    await work.run();
    expect(pm.calls.filter((c) => c.profile === RISK)).toHaveLength(1);
    const risk = pm.calls.find((c) => c.profile === RISK)!;
    // NEXT waits for a person too: kept as well; both read back on the second run.
    expect(pm.calls.filter((c) => c.profile === NEXT)).toHaveLength(1);
    expect(pm.reads.map((r) => r.op)).toEqual(['get', 'get']);
    expect(pm.reads[0]!.id).toBe([...pm.logged.keys()][0]);
    expect(risk.body.ref).toBe(`github:${REPO}#7@${HEAD}`);
  });

  it('a kept decision is made anew once a person answers the question it rests on', async () => {
    const runs = { [RISK]: {}, [NEXT]: { requires: { risk: RISK }, oncePerHead: { rerun: [] } } };
    const { work, pm, event } = await chained(chain(runs), {},
      (p) => Response.json(decision(p, p === RISK ? { action: 'review', review: { status: 'pending' } } : { action: 'wait' })));
    await work.run();
    await event();
    await work.run();
    // The question to a person is kept, and so is the decision resting on it.
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT]);
    pm.resolve([...pm.logged.keys()][0]!, 'normal');
    await event();
    await work.run();
    // The answer changes what NEXT rests on: asked again, with the same decision id of RISK.
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT, NEXT]);
    expect(pm.calls[2]!.body.decisions).toEqual({ risk: [...pm.logged.keys()][0] });
  });

  it('a question rests on what the required decision says, not its id: answerable across runs, asked anew when that changes', async () => {
    const runs = { [RISK]: {}, [NEXT]: { requires: { risk: RISK } } };
    let riskAction = 'normal';
    const { work, pm, gh, event } = await chained({ ...chain(runs), actions: { [NEXT]: { approve: { do: 'approve' as const } } } }, {},
      (p) => Response.json(decision(p, p === RISK ? { action: riskAction } : { action: 'review', review: { status: 'pending' } })));
    await work.run();
    const nextId = [...pm.logged.values()].find((d) => d.profile === NEXT).decision_id;
    // RISK is decided anew (a new id) with the same action: NEXT keeps its one question, nothing is closed.
    await event();
    await work.run();
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT, RISK]);
    expect(pm.reads.map((r) => r.op)).toEqual(['get']);
    // An answer given between two runs is acted on.
    pm.resolve(nextId, 'approve');
    await event();
    await work.run();
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT, RISK, RISK]);
    expect(gh.calls.filter((c) => c.op === 'approve').map((c) => c.head)).toEqual([HEAD]);
    // RISK says something else now: NEXT is asked anew (its answered question needs no close), and the approval goes.
    riskAction = 'risky';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await event();
    await work.run();
    expect(errors.mock.calls.join(' ')).toContain(`decision ${nextId} (resolved) rests on what changed; dropped and asked anew`);
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT, RISK, RISK, RISK, NEXT]);
    expect(gh.github.approvals).toEqual([]);
    // And a pending question is closed when RISK changes again.
    const second = [...pm.logged.values()].filter((d) => d.profile === NEXT).at(-1).decision_id;
    riskAction = 'normal';
    await event();
    await work.run();
    errors.mockRestore();
    expect(pm.reads.filter((r) => r.op === 'close').map((r) => r.id)).toEqual([second]);
    expect(pm.logged.get(second).review).toEqual({ status: 'superseded' });
    expect(pm.calls.filter((c) => c.profile === NEXT)).toHaveLength(3);
  });

  it('a kept decision that rests on an earlier one is asked again when that one is new', async () => {
    let n = 0;
    const s = { ...chain({ a: { oncePerHead: { rerun: ['incomplete'] } }, b: { requires: { a: 'a' }, oncePerHead: { rerun: [] } } }), profiles: ['a', 'b'] };
    const { work, pm, event } = await chained(s, {}, (p) => Response.json(decision(p, { action: p === 'a' && n++ === 0 ? 'incomplete' : 'normal' })));
    await work.run(); // a: incomplete, b decided on it
    await event();
    await work.run(); // a asked again (rerun): a new decision, so b too
    await event();
    await work.run(); // both kept
    expect(pm.calls.map((c) => c.profile)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('tries again later when a push comes in while the diff is read', async () => {
    const { work, pm, gh } = await chained();
    const diff = gh.github.diff;
    gh.github.diff = async (...a) => { gh.github.state.head = HEAD2; return diff(...a); };
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    expect(pm.calls).toHaveLength(0);
  });

  it('a refused diff (no permission) is sent as empty and cut, and the run goes on', async () => {
    const { work, pm, gh } = await chained();
    gh.github.diff = async () => { throw new GitHubError('GitHub diff: 403', false, 403); };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await work.run();
    errors.mockRestore();
    expect(pm.calls.map((c) => c.profile)).toEqual([RISK, NEXT]);
    expect(pm.calls[0]!.body.state.pull_request).toMatchObject({ diff: '', diff_truncated: true });
    expect(pm.calls[1]!.body.decisions).toEqual({ risk: expect.any(String) });
  });

  it('reads the head again after a refused diff too', async () => {
    const { work, pm, gh } = await chained();
    gh.github.diff = async () => { gh.github.state.head = HEAD2; throw new GitHubError('GitHub diff: 403', false, 403); };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
    errors.mockRestore();
    expect(pm.calls).toHaveLength(0);
  });

  it('a decision made without a refused diff is not kept; other errors still end the run', async () => {
    const { work, pm, gh, event } = await chained();
    let refuse = true;
    const diff = gh.github.diff;
    gh.github.diff = async (...a) => { if (refuse) throw new GitHubError('GitHub diff: 403', false, 403); return diff(...a); };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await work.run();
    refuse = false;
    await event();
    await work.run(); // asked again, now with the diff
    expect(pm.calls.filter((c) => c.profile === RISK).map((c) => c.body.state.pull_request.diff_truncated)).toEqual([true, false]);
    // An uninstalled app or a broken key is not a refused diff.
    gh.github.diff = async () => { throw new GitHubError('GitHub app token: not installed', false); };
    gh.github.state.head = HEAD2;
    await event();
    await work.run();
    errors.mockRestore();
    expect(pm.calls.filter((c) => c.body.state.pull_request.head === HEAD2)).toHaveLength(0);
    // A rate limit is tried again later.
    gh.github.diff = async () => { throw new GitHubError('GitHub diff: 429', true, 429); };
    await event();
    await expect(work.run()).rejects.toBeInstanceOf(RetryError);
  });

  it('asks for contents: read only when a profile gets the diff', () => {
    const granted = { metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'write' };
    expect(scopeFor(false, false)(granted)).toEqual({ metadata: 'read', pull_requests: 'read', checks: 'write' });
    expect(scopeFor(false, true)(granted)).toEqual({ metadata: 'read', pull_requests: 'read', checks: 'write', contents: 'read' });
    expect(scopeFor(true, true)(granted)).toEqual({ metadata: 'read', pull_requests: 'write', checks: 'write', contents: 'read' });
    // Never more than the app has: no contents permission, none asked.
    expect(scopeFor(false, true)({ metadata: 'read', pull_requests: 'read', checks: 'write' })).toEqual({ metadata: 'read', pull_requests: 'read', checks: 'write' });
    expect(readsDiff(chain())).toBe(true);
    expect(readsDiff(settings())).toBe(false);
  });

  it('CodeRabbit\'s summary in the description neither asks a once-per-head profile again nor reaches the model', async () => {
    const block = (text: string) => `<!-- This is an auto-generated comment: release notes by coderabbit.ai -->\n${text}\n<!-- end of auto-generated comment: release notes by coderabbit.ai -->`;
    const { work, pm, gh, event } = await chained(chain(), { body: 'A body' });
    await work.run();
    gh.github.state.body = `A body\n\n${block('## Summary by CodeRabbit\n- Docs')}`;
    await event();
    await work.run();
    // The same pr-risk decision: CodeRabbit's edit is not the author's.
    expect(pm.calls.filter((c) => c.profile === RISK)).toHaveLength(1);
    expect(pm.calls.at(-1)!.body.state.pull_request.body).toBe('A body');
    // An edit by the author asks again.
    gh.github.state.body = `A body, edited\n\n${block('## Summary by CodeRabbit\n- Docs, more')}`;
    await event();
    await work.run();
    expect(pm.calls.filter((c) => c.profile === RISK).map((c) => c.body.state.pull_request.body)).toEqual(['A body', 'A body, edited']);
  });

  it('authorText leaves out CodeRabbit\'s whole blocks only', () => {
    const start = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';
    const end = '<!-- end of auto-generated comment: release notes by coderabbit.ai -->';
    expect(authorText('Fix the docs.')).toBe('Fix the docs.');
    // No block: the author's text exactly, also its leading spaces (an indented code block).
    expect(authorText('    code\nmore  \n')).toBe('    code\nmore  \n');
    expect(authorText(`Fix the docs.\n${start}\nbot\n${end}\nMore by the author.`)).toBe('Fix the docs.\n\nMore by the author.');
    expect(authorText(`${start}a${end}x${start}b${end}`)).toBe('x');
    // Only whole blocks: a start marker without an end stays text (quoted in prose, or a broken edit).
    expect(authorText(`Fix.\n${start}\nno end`)).toBe(`Fix.\n${start}\nno end`);
    // Nested: the first end closes the block; the rest is text.
    expect(authorText(`${start}a${start}b${end}c${end}`)).toBe(`c${end}`);
    // Reversed: no whole block.
    expect(authorText(`${end}x${start}`)).toBe(`${end}x${start}`);
    // CRLF, and a body that is only a block.
    expect(authorText(`A\r\n${start}\r\nbot\r\n${end}\r\nB`)).toBe('A\r\n\r\nB');
    expect(authorText(`${start}\nbot\n${end}`)).toBe('');
    expect(authorText(`${end} only an end marker`)).toBe(`${end} only an end marker`);
  });

  it('settings: runs only for listed profiles, requires only earlier ones, checked values', () => {
    const env = { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x' };
    const parse = (runs: unknown) => connectorSettings({ ...env, GITHUB_CONNECTOR: JSON.stringify({ repos: ['a/b'], profiles: [RISK, NEXT], runs }) })!.runs;
    expect(parse(undefined)).toEqual({});
    expect(parse({ [RISK]: { skip_drafts: true, once_per_head: { rerun: ['incomplete'] }, diff: 30000 }, [NEXT]: { requires: { risk: RISK }, recheck: { actions: ['wait', 'queue'], minutes: 10 } } })).toEqual({
      [RISK]: { skipDrafts: true, oncePerHead: { rerun: ['incomplete'] }, diff: 30000 },
      [NEXT]: { requires: { risk: RISK }, recheck: { actions: ['wait', 'queue'], minutes: 10, max: 12 } },
    });
    expect(() => parse({ other: {} })).toThrow(/not in "profiles"/);
    expect(() => parse({ [RISK]: { requires: { next: NEXT } } })).toThrow(/listed before/);
    expect(() => parse({ [NEXT]: { requires: { Risk: RISK } } })).toThrow(/not a name/);
    expect(() => parse({ [RISK]: { diff: 10 } })).toThrow(/diff must be a whole number/);
    expect(() => parse({ [RISK]: { recheck: { actions: ['wait'], minutes: 1 } } })).toThrow(/minutes/);
    expect(() => parse({ [RISK]: { recheck: { actions: [], minutes: 10 } } })).toThrow(/actions/);
    expect(() => parse({ [RISK]: { skip: true } })).toThrow(/unknown key skip/);
    expect(() => parse({ [RISK]: { once_per_head: { rerun: ['incomplete'] }, recheck: { actions: ['wait'], minutes: 10 } } })).toThrow(/must be in rerun/);
  });

  it('reads the diff from GitHub, up to the limit, and none for a very large pull request', async () => {
    const answer = (res: () => Response) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/installation')) return Response.json({ id: 9, permissions: { metadata: 'read', pull_requests: 'read', checks: 'write' } });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      expect(new Headers(init?.headers).get('accept')).toBe('application/vnd.github.diff');
      return res();
    }) as typeof fetch;
    const small = new AppGitHub(APP_ID, KEY, answer(() => new Response('diff --git a/x b/x\n')));
    expect(await small.diff(REPO, 7, 1000)).toEqual({ diff: 'diff --git a/x b/x\n', truncated: false });
    const large = new AppGitHub(APP_ID, KEY, answer(() => new Response('y'.repeat(70_000))));
    expect(await large.diff(REPO, 7, 1000)).toEqual({ diff: 'y'.repeat(1000), truncated: true });
    const secondary = new AppGitHub(APP_ID, KEY, answer(() => Response.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 })));
    await expect(secondary.diff(REPO, 7, 1000)).rejects.toMatchObject({ retry: true });
    const refused = new AppGitHub(APP_ID, KEY, answer(() => Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })));
    await expect(refused.diff(REPO, 7, 1000)).rejects.toMatchObject({ retry: false, status: 403 });
    const tooLarge = new AppGitHub(APP_ID, KEY, answer(() => new Response(null, { status: 406 })));
    expect(await tooLarge.diff(REPO, 7, 1000)).toEqual({ diff: '', truncated: true });
    const busy = new AppGitHub(APP_ID, KEY, answer(() => new Response(null, { status: 502 })));
    await expect(busy.diff(REPO, 7, 1000)).rejects.toMatchObject({ retry: true });
  });
});

describe('asking a person: the question stays until it is answered or the head moves', () => {
  const APPROVE = { 'pr-docs-check': { light: { do: 'approve' as const }, review: { do: 'request_reviewer' as const, reviewers: ['octocat'] } } };
  const ops = (calls: { op: string }[]) => calls.map((c) => c.op).filter((o) => !['get', 'find', 'create', 'update', 'approvals'].includes(o));
  const pendingReview = (p: string) => Response.json(decision(p, { action: 'review', review: { status: 'pending' } }));

  async function asking(answer: (p: string) => Response = pendingReview, actions: ConnectorSettings['actions'] = APPROVE, extra: Partial<ConnectorSettings> = {}) {
    const mem = memoryStorage();
    const gh = fakeGitHub();
    const pm = fakeEngine(answer);
    const work = pullRequestWork(settings({ profiles: ['pr-docs-check'], actions, comment: { profiles: ['pr-docs-check'] }, ...extra }), mem.storage, pm.engine, gh.github);
    const event = () => work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await event();
    const again = async () => { await event(); await work.run(); };
    const lastCheck = () => gh.calls.filter((c) => c.output).at(-1)!.output!;
    return { work, mem, gh, pm, event, again, lastCheck };
  }

  it('one decision per head while a person checks it: read back on every run, nothing done, shown as waiting', async () => {
    const { work, gh, pm, again, lastCheck } = await asking();
    await work.run();
    await again();
    await again();
    expect(pm.calls).toHaveLength(1);
    const id = pm.calls.length === 1 ? [...pm.logged.keys()][0]! : '';
    expect(pm.reads).toEqual([{ op: 'get', id, auth: expect.stringMatching(/^Bearer pm_/) }, { op: 'get', id, auth: expect.stringMatching(/^Bearer pm_/) }]);
    // Nothing done: not the mapped request for review, no approval.
    expect(ops(gh.calls).filter((o) => o !== 'comment' && o !== 'findOwnComment' && o !== 'updateComment')).toEqual([]);
    expect(lastCheck().title).toBe('🔴 review: a person checks first');
    expect(lastCheck().summary).toContain('Waiting for a person');
    expect(lastCheck().summary).toContain('a person checks this decision first');
  });

  it('a person\'s answer in the queue is read back and acted on, once, through the same table and guards', async () => {
    const { work, gh, pm, mem, again, lastCheck } = await asking();
    await work.run();
    const id = [...pm.logged.keys()][0]!;
    pm.resolve(id, 'light');
    await again();
    expect(gh.calls.filter((c) => c.op === 'approve').map((c) => c.head)).toEqual([HEAD]);
    expect(gh.calls.find((c) => c.op === 'approve')!.body).toContain(id);
    expect(lastCheck().title).toBe('🟡 light: a person\'s answer');
    expect(lastCheck().summary).toContain('Pointsman decided **review**');
    expect(lastCheck().summary).toContain('A person answered **light**');
    expect(lastCheck().summary).toContain('Done: approved this commit');
    // Who answered is not shown.
    expect(JSON.stringify(gh.calls)).not.toContain('someone@example.org');
    const comment = gh.calls.filter((c) => c.op === 'comment' || c.op === 'updateComment').at(-1)!.body!;
    expect(comment).toContain('| `pr-docs-check` | 🟡 decided: light | `light` | a person |');
    expect(comment).toContain('a person answered: light');
    // The row shows what is acted on; the details why the rules asked a person, with the answer.
    expect(comment).toContain('<summary><code>pr-docs-check</code>: why <code>review</code>; a person answered <code>light</code></summary>');
    expect(comment).toContain('━ review');
    // The answer stands for this head: not read again, no new decision, not approved twice.
    await again();
    expect(pm.calls).toHaveLength(1);
    expect(pm.reads.filter((r) => r.op === 'get')).toHaveLength(1);
    expect(gh.calls.filter((c) => c.op === 'approve')).toHaveLength(1);
    expect(lastCheck().summary).toContain('already done for this commit');
    expect((mem.data.get('asked') as any).byProfile['pr-docs-check'].decision.review).toEqual({ status: 'resolved', final_action: 'light' });
  });

  it('an answer for an older head is never acted on: the head moved, so the old question is closed and Pointsman decides anew', async () => {
    const { work, gh, pm, again } = await asking();
    await work.run();
    const old = [...pm.logged.keys()][0]!;
    gh.github.state.head = HEAD2;
    pm.resolve(old, 'light');
    await again();
    expect(gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
    // Answered already: closing it gets 409, which is fine.
    expect(pm.reads.map((r) => [r.op, r.id])).toEqual([['close', old]]);
    expect(pm.calls.map((c) => c.body.ref)).toEqual([`github:${REPO}#7@${HEAD}`, `github:${REPO}#7@${HEAD2}`]);
  });

  it('a push closes the pending question of the old head; a close that fails never holds up the new head, is tried again (spaced), then given up', async () => {
    const { work, gh, pm, mem, again } = await asking();
    let t = 1_000_000;
    work.now = () => t;
    await work.run();
    const old = [...pm.logged.keys()][0]!;
    gh.github.state.head = HEAD2;
    pm.override.close = () => new Response('busy', { status: 503 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await again();
    // Decided on the new head all the same; the close is listed for a later run.
    expect(pm.calls).toHaveLength(2);
    expect((mem.data.get('asked') as any).close).toEqual([{ id: old, since: t, tries: 1, lastTry: t }]);
    expect(errors.mock.calls.join(' ')).toContain(`Pointsman closing ${old} for ${REPO}#7: 503; tried again later`);
    // A burst of events within 5 minutes does not try again.
    delete pm.override.close;
    await again();
    await again();
    expect(pm.reads.filter((r) => r.op === 'close')).toHaveLength(1);
    t += 5 * 60_000;
    await again();
    expect(pm.logged.get(old).review).toEqual({ status: 'superseded' });
    expect(pm.reads.filter((r) => r.op === 'close').map((r) => r.id)).toEqual([old, old]);
    // The new head has its own question, kept as before.
    expect(pm.calls).toHaveLength(2);
    const fresh = [...pm.logged.keys()][1]!;
    expect((mem.data.get('asked') as any)).toMatchObject({ head: HEAD2, close: [] });
    expect((mem.data.get('asked') as any).byProfile['pr-docs-check'].decision.decision_id).toBe(fresh);
    // An engine without the close call (older than the connector): logged, tried again, given up after a day.
    pm.override.close = () => { throw new TypeError('The RPC receiver does not implement the method "close".'); };
    gh.github.state.head = HEAD;
    await again();
    expect((mem.data.get('asked') as any).close).toEqual([{ id: fresh, since: t, tries: 1, lastTry: t }]);
    t += 24 * 3600_000;
    await again();
    expect((mem.data.get('asked') as any).close).toEqual([]);
    expect(errors.mock.calls.join(' ')).toContain(`Pointsman closing ${fresh} for ${REPO}#7: The RPC receiver does not implement the method "close".; given up`);
    // A refusal is logged and not tried again.
    delete pm.override.close;
    const third = [...pm.logged.keys()].at(-1)!;
    pm.override.close = () => Response.json({ error: { code: 'forbidden', message: 'x' } }, { status: 403 });
    gh.github.state.head = HEAD2;
    await again();
    expect(errors.mock.calls.join(' ')).toContain(`Pointsman closing ${third} for ${REPO}#7: 403`);
    expect((mem.data.get('asked') as any).close).toEqual([]);
    errors.mockRestore();
  });

  it('a close of a closed pull request that fails still lets the comment show it', async () => {
    const { work, gh, pm, again } = await asking();
    await work.run();
    gh.github.state.open = false;
    pm.override.close = () => new Response('busy', { status: 503 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = gh.calls.filter((c) => c.op === 'updateComment').length;
    await again();
    errors.mockRestore();
    expect(gh.calls.filter((c) => c.op === 'updateComment').length).toBe(before + 1);
  });

  it('a closed pull request closes its open questions', async () => {
    const { work, gh, pm, mem, again } = await asking();
    await work.run();
    const id = [...pm.logged.keys()][0]!;
    gh.github.state.open = false;
    await again();
    expect(pm.logged.get(id).review).toEqual({ status: 'superseded' });
    expect((mem.data.get('asked') as any)).toEqual({ head: '', byProfile: {}, close: [] });
    // Reopened: asked anew.
    gh.github.state.open = true;
    await again();
    expect(pm.calls).toHaveLength(2);
  });

  it('an answer that is not a valid action is not acted on, and the question stays (no new decision)', async () => {
    const { work, gh, pm, again, lastCheck } = await asking();
    await work.run();
    const id = [...pm.logged.keys()][0]!;
    pm.logged.get(id).review = { status: 'resolved', final_action: 'Not An Action' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await again();
    await again();
    expect(lastCheck().title).toBe('invalid answer: nothing done');
    expect(errors.mock.calls.join(' ')).toContain('"review"');
    expect(errors.mock.calls.join(' ')).not.toContain('Not An Action');
    errors.mockRestore();
    expect(ops(gh.calls).filter((o) => o === 'approve' || o === 'request')).toEqual([]);
    expect(pm.calls).toHaveLength(1);
    // Another decision read back under the id: not acted on either.
    pm.logged.get(id).review = { status: 'resolved', final_action: 'light' };
    pm.override.get = () => Response.json({ ...pm.logged.get(id), decision_id: crypto.randomUUID() });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await again();
    quiet.mockRestore();
    expect(lastCheck().title).toBe('invalid answer: nothing done');
    expect(gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
  });

  it('a question closed in Pointsman, or gone, is asked anew once; an engine that cannot read it is tried again', async () => {
    const { work, pm, again } = await asking();
    await work.run();
    const first = [...pm.logged.keys()][0]!;
    pm.logged.get(first).review = { status: 'superseded' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await again();
    expect(pm.calls).toHaveLength(2);
    pm.logged.delete([...pm.logged.keys()][1]!);
    await again();
    expect(pm.calls).toHaveLength(3);
    errors.mockRestore();
    pm.override.get = () => new Response('', { status: 502 });
    await expect(again()).rejects.toBeInstanceOf(RetryError);
    expect(pm.calls).toHaveLength(3);
  });

  it('a question whose title, description or settings changed is closed and asked anew, so an answer never rests on older state', async () => {
    const { work, gh, pm, mem, again } = await asking();
    await work.run();
    const first = [...pm.logged.keys()][0]!;
    gh.github.state.title = 'Docs, and a workflow';
    pm.resolve(first, 'light');
    await again();
    // The answer to the old question is not acted on: closed (409, answered already) and asked anew.
    expect(gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
    expect(pm.calls).toHaveLength(2);
    expect(pm.reads.map((r) => [r.op, r.id])).toEqual([['close', first]]);
    const second = [...pm.logged.keys()][1]!;
    // A settings change (another mapped action) asks anew too.
    const changed = pullRequestWork(settings({ profiles: ['pr-docs-check'], actions: { 'pr-docs-check': { light: { do: 'label', labels: ['docs-only'] } } }, comment: { profiles: ['pr-docs-check'] } }),
      mem.storage, pm.engine, gh.github);
    await changed.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await changed.run();
    errors.mockRestore();
    expect(pm.calls).toHaveLength(3);
    expect(pm.logged.get(second).review).toEqual({ status: 'superseded' });
  });

  it('a question that cannot be read back (refused) is shown on the check run, nothing is done, and it stays', async () => {
    const { work, pm, again, lastCheck } = await asking();
    await work.run();
    pm.override.get = () => Response.json({ error: { code: 'forbidden', message: 'x' } }, { status: 403 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await again();
    errors.mockRestore();
    expect(lastCheck().title).toBe('answer could not be read: nothing done');
    expect(lastCheck().summary).toContain('(403)');
    expect(pm.calls).toHaveLength(1);
    delete pm.override.get;
    await again();
    expect(lastCheck().title).toBe('🔴 review: a person checks first');
  });

  it('a question of a profile taken out of the settings is closed', async () => {
    const { work, gh, pm, mem } = await asking();
    await work.run();
    const id = [...pm.logged.keys()][0]!;
    const other = pullRequestWork(settings({ profiles: ['workflow-check'] }), mem.storage, pm.engine, gh.github);
    await other.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await other.run();
    expect(pm.logged.get(id).review).toEqual({ status: 'superseded' });
    expect(Object.keys((mem.data.get('asked') as any).byProfile)).toEqual(['workflow-check']);
  });

  it('a decision that needs no person is not kept as a question', async () => {
    const { work, pm, mem, again } = await asking((p) => Response.json(decision(p, { action: 'light' })));
    await work.run();
    await again();
    expect(pm.calls).toHaveLength(2);
    expect(pm.reads).toEqual([]);
    expect(mem.data.get('asked')).toBeUndefined();
  });
});

describe('the engine\'s answer: checked before anything is done (checkDecision)', () => {
  const PROFILE = 'pr-docs-check';
  const REF = `github:${REPO}#7@${HEAD}`;
  const asked = { profile: PROFILE, ref: REF };
  /** A decision as the engine gives it, with the fields the connector does not read. */
  const full = () => ({
    decision_id: crypto.randomUUID(), ref: REF, answers: { kind: 'docs' }, action: 'light', profile: PROFILE, profile_version: 3, model: 'none',
    created_at: '2026-10-23T00:00:00.000Z', rule: null, facts: { ci: { missing: false, values: { green: true }, source: 'github' }, owners: { missing: true, reason: 'not found' } },
    review: { status: 'pending' }, replaces: crypto.randomUUID(), versions: { engine: '0.13.0', modules: { '@pointsman/github': '0.13.0' } }, requires: {}, later_field: [1, 2],
  });

  it('passes a valid decision on unchanged, extra fields and all', () => {
    const d = full();
    expect(checkDecision(d, asked)).toEqual({ kind: 'decision', decision: d });
    expect((checkDecision(d, asked) as { decision: unknown }).decision).toBe(d);
    // The fields that may be missing: facts, review, test (false is not a test decision).
    const { facts: _f, review: _v, ...lean } = d;
    expect(checkDecision({ ...lean, rule: 0 }, asked).kind).toBe('decision');
    expect(checkDecision({ ...lean, test: false }, asked).kind).toBe('decision');
    // Every action name a profile can give, at its longest.
    expect(checkDecision({ ...lean, action: `a${'b'.repeat(62)}` }, asked).kind).toBe('decision');
  });

  it('refuses an answer that is not a decision, naming the field and never its value', () => {
    const big = `ZQ${crypto.randomUUID()}`.repeat(100);
    const cases: [string, unknown][] = [
      ['not an object', null], ['not an object', 'light'], ['not an object', [full()]], ['not an object', 42],
      ['"decision_id"', { ...full(), decision_id: undefined }], ['"decision_id"', { ...full(), decision_id: 7 }], ['"decision_id"', { ...full(), decision_id: big }],
      ['"action"', { ...full(), action: undefined }], ['"action"', { ...full(), action: 1 }], ['"action"', { ...full(), action: '' }],
      ['"action"', { ...full(), action: { do: 'approve' } }], ['"action"', { ...full(), action: 'a'.repeat(65) }], ['"action"', { ...full(), action: big }],
      ['"action"', { ...full(), action: 'Light' }], ['"action"', { ...full(), action: 'light\n' }],
      ['"profile"', { ...full(), profile: 'other' }], ['"profile"', { ...full(), profile: undefined }],
      ['"ref"', { ...full(), ref: `github:${REPO}#7@${HEAD2}` }], ['"ref"', { ...full(), ref: undefined }],
      ['"review"', { ...full(), review: { status: 'resolved' } }], ['"review"', { ...full(), review: { status: 'Pending' } }],
      ['"review"', { ...full(), review: { status: 'resolved', final_action: 'Approve' } }], ['"review"', { ...full(), review: { status: 'resolved', final_action: 7 } }],
      ['"review"', { ...full(), review: { status: 'resolved', final_action: big } }], ['"review"', { ...full(), review: { status: 'superseded' } }],
      ['"facts"', { ...full(), facts: { 'a`b': { missing: true, reason: 'r' } } }], ['"facts"', { ...full(), facts: { '': { missing: true } } }],
      ['"profile_version"', { ...full(), profile_version: 0 }], ['"profile_version"', { ...full(), profile_version: '3' }],
      ['"rule"', { ...full(), rule: undefined }], ['"rule"', { ...full(), rule: -1 }], ['"rule"', { ...full(), rule: 1.5 }],
      ['"review"', { ...full(), review: 'pending' }], ['"review"', { ...full(), review: null }], ['"review"', { ...full(), review: {} }], ['"review"', { ...full(), review: [] }],
      ['"facts"', { ...full(), facts: [] }], ['"facts"', { ...full(), facts: { ci: null } }], ['"facts"', { ...full(), facts: { ci: { missing: 'yes' } } }], ['"facts"', { ...full(), facts: { ci: { missing: true, reason: 3 } } }],
      ['"test"', { ...full(), test: 'true' }], ['"test"', { ...full(), test: 1 }],
    ];
    for (const [field, body] of cases) {
      const checked = checkDecision(body, asked);
      expect(checked.kind, JSON.stringify(body)?.slice(0, 80)).toBe('invalid');
      const reason = (checked as { reason: string }).reason;
      expect(reason).toContain(field);
      expect(reason.length).toBeLessThan(80);
      expect(reason).not.toContain('ZQ');
    }
  });

  it('a person\'s answer read back is a decision whose action is the answer (actionOf)', () => {
    const d = { ...full(), action: 'review', review: { status: 'resolved', final_action: 'light', resolved_by: 'someone' } };
    expect(checkDecision(d, asked)).toEqual({ kind: 'decision', decision: d });
    expect(actionOf(d)).toBe('light');
    expect(actionOf({ action: 'review', review: { status: 'pending' } })).toBe('review');
  });

  it('marks a test decision as one', () => {
    const d = { ...full(), test: true };
    expect(checkDecision(d, asked)).toEqual({ kind: 'test', decision: d });
    // A test decision of the wrong shape is invalid first.
    expect(checkDecision({ ...d, action: '' }, asked).kind).toBe('invalid');
  });

  const ACT = { [PROFILE]: { light: { do: 'label' as const, labels: ['docs-only'] }, review: { do: 'request_reviewer' as const, reviewers: ['octocat'] } } };
  async function acting(actions: ConnectorSettings['actions'], answer: (p: string) => Response, runs: ConnectorSettings['runs'] = {}) {
    const mem = memoryStorage();
    const gh = fakeGitHub();
    const pm = fakeEngine(answer);
    const work = pullRequestWork(settings({ profiles: [PROFILE], actions, runs }), mem.storage, pm.engine, gh.github);
    const event = () => work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now());
    await event();
    return { work, mem, gh, pm, event };
  }
  const ops = (calls: { op: string }[]) => calls.map((c) => c.op).filter((o) => !['get', 'find', 'create', 'update', 'approvals'].includes(o));
  const lastOutput = (calls: { output?: CheckRunOutput }[]) => calls.filter((c) => c.output).at(-1)!.output!;

  it('an invalid answer: nothing done, logged without its content, shown on the check run, not tried again, not kept', async () => {
    // Not an action name (upper case), so it must not be echoed anywhere.
    const secretish = `PM_${crypto.randomUUID()}`;
    for (const body of [{ ...decision(PROFILE), decision_id: undefined }, { ...decision(PROFILE), action: 7 }, { ...decision(PROFILE), action: '' }, { ...decision(PROFILE), review: 'pending' }, 'light', [decision(PROFILE)], { ...decision(PROFILE), action: secretish }]) {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { work, gh, mem, pm, event } = await acting(ACT, () => Response.json(body), { [PROFILE]: { oncePerHead: { rerun: [] } } });
      await expect(work.run()).resolves.toBeUndefined();
      expect(ops(gh.calls)).toEqual([]);
      const out = lastOutput(gh.calls);
      expect(out.title).toBe('invalid answer: nothing done');
      expect(out.conclusion).toBe('neutral');
      expect(out.summary).toContain('Nothing was done');
      expect(out.summary + errors.mock.calls.join(' ')).not.toContain(secretish);
      expect(errors.mock.calls.join(' ')).toContain('not a decision');
      expect(mem.data.get('kept')).toBeUndefined();
      // Asked again on the next event (once_per_head kept nothing), not before.
      await work.run();
      expect(pm.calls).toHaveLength(1);
      await event();
      await work.run();
      expect(pm.calls).toHaveLength(2);
      errors.mockRestore();
    }
  });

  it('a test decision: nothing done, and the check run says it was a test decision', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let test = true;
    const { work, gh, mem, event } = await acting(ACT, (p) => Response.json({ ...decision(p, { action: 'light' }), ...(test && { test }) }), { [PROFILE]: { oncePerHead: { rerun: [] } } });
    await work.run();
    expect(ops(gh.calls)).toEqual([]);
    const out = lastOutput(gh.calls);
    expect(out.title).toBe('test decision: nothing done');
    expect(out.summary).toContain('test decision');
    expect(out.summary).toContain('nothing was done');
    expect(errors.mock.calls.join(' ')).toContain('a test decision');
    expect(mem.data.get('kept')).toBeUndefined();
    // The same decision without test: acted on and kept (the settings keep a valid one).
    test = false;
    await event();
    await work.run();
    expect(ops(gh.calls)).toEqual(['label']);
    expect((mem.data.get('kept') as any).byProfile[PROFILE]).toBeDefined();
    errors.mockRestore();
  });

  it('a kept decision is checked again: one kept before the check (a test decision) is asked anew', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { work, mem, pm, event } = await acting(ACT, (p) => Response.json(decision(p, { action: 'wait' })), { [PROFILE]: { oncePerHead: { rerun: [] } } });
    await work.run();
    await event();
    await work.run();
    expect(pm.calls).toHaveLength(1);
    const kept = mem.data.get('kept') as any;
    kept.byProfile[PROFILE].decision.test = true;
    mem.data.set('kept', kept);
    await event();
    await work.run();
    expect(pm.calls).toHaveLength(2);
    errors.mockRestore();
  });

  it('a 2xx that is not JSON is an invalid answer over HTTP too, not tried again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { work, gh } = await acting(ACT, () => new Response('<html>', { status: 200 }));
    await expect(work.run()).resolves.toBeUndefined();
    expect(ops(gh.calls)).toEqual([]);
    expect(lastOutput(gh.calls).summary).toContain('not an object');
    errors.mockRestore();
  });

  it('a test decision is never sent on to the profiles that require it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mem = memoryStorage();
    const gh = fakeGitHub();
    const pm = fakeEngine((p) => Response.json(p === 'pr-risk' ? { ...decision(p), test: true } : decision(p)));
    const s = settings({ profiles: ['pr-risk', 'pr-next'], runs: { 'pr-next': { requires: { risk: 'pr-risk' } } } });
    const work = pullRequestWork(s, mem.storage, pm.engine, gh.github);
    await work.accept({ target: { repo: REPO, number: 7 }, delivery: 'd1', digest: 'x1' }, Date.now());
    await work.run();
    expect(pm.calls.map((c) => c.body.decisions)).toEqual([undefined, undefined]);
    // pr-next was still asked and shown.
    expect(gh.calls.filter((c) => c.op === 'create').map((c) => c.name)).toEqual(['Pointsman: pr-risk', 'Pointsman: pr-next']);
    errors.mockRestore();
  });

  it('an invalid answer or a test decision after an approval: the approval is withdrawn, never kept', async () => {
    const KEEP = { [PROFILE]: { light: { do: 'approve' as const }, done: { do: 'keep_approval' as const } } };
    for (const bad of [
      (p: string) => ({ ...decision(p, { action: 'done' }), test: true }),
      (p: string) => ({ ...decision(p, { action: 'done' }), profile_version: 'x' }),
      (p: string) => ({ ...decision(p, { action: 'light' }), action: 'light'.repeat(20) }),
      () => [],
    ]) {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      let answer: (p: string) => unknown = (p) => decision(p, { action: 'light' });
      const { work, gh, event } = await acting(KEEP, (p) => Response.json(answer(p)));
      await work.run();
      expect(gh.github.approvals).toHaveLength(1);
      answer = bad;
      await event();
      await work.run();
      expect(gh.github.approvals).toHaveLength(0);
      expect(ops(gh.calls)).toEqual(['approve', 'dismiss']);
      expect(lastOutput(gh.calls).title).toMatch(/nothing done$/);
      // When it cannot be withdrawn, the check run says so.
      answer = (p) => decision(p, { action: 'light' });
      await event();
      await work.run();
      gh.github.dismissReview = async () => { throw new GitHubError('GitHub dismissal: 422', false, 422); };
      answer = bad;
      await event();
      await work.run();
      expect(lastOutput(gh.calls).summary).toContain('could not be withdrawn');
      errors.mockRestore();
    }
  });
});
