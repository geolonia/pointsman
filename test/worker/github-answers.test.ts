// Answers inside the pull request (docs/github-connector.md#answering-in-the-pull-request):
// the setting, the webhook's routing of clicks and commands, the checks of the
// person at answer time, and the run that acts on a taken answer. A fake
// GitHub, a fake Pointsman and an in-memory store for the pull request's object.

import { describe, expect, it, vi } from 'vitest';
import {
  ANSWER_CHECKS_PER_HOUR, ANSWER_READS_PER_HOUR, ANSWERS_PER_ACCOUNT_PER_HOUR, AppGitHub, answerOf, buttonsFor, checkDecision, commandOf, connectorSettings, GitHubError, githubConnector, httpEngine, pullRequestWork, readsContents, HEADS_KEPT,
  type Accepted, type AnswerEvent, type Answerer, type CheckRunOutput, type ConnectorGitHub, type ConnectorSettings, type Decision, type ObjectStorage, type PullRequestInfo,
} from '@pointsman/github';
import type { EngineApi } from '@pointsman/module-api';

const SECRET = `whsec-${crypto.randomUUID()}`;
const APP_ID = 4242;
const REPO = 'example/repo';
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
/** The heads as a command names them. */
const SHORT = HEAD.slice(0, 12);
const SHORT2 = HEAD2.slice(0, 12);
const PROFILE = 'pr-next-step';

async function pemKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}
const KEY = await pemKey();

/** Runs f with console.error caught: what was logged. */
async function logged(f: () => Promise<unknown>): Promise<string> {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await f();
    return spy.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    spy.mockRestore();
  }
}

/** The people of these tests: the author (1), who pushed the head (2), a maintainer (5), a reader (6). */
const AUTHOR: Answerer = { login: 'writer-1', id: 1 };
const PUSHER: Answerer = { login: 'pusher-2', id: 2 };
const MAINTAINER: Answerer = { login: 'Octo-Cat', id: 5 };
const READER: Answerer = { login: 'reader', id: 6 };

const ANSWERS = { profiles: { [PROFILE]: ['approve', 'reject'] }, command: false };
/** The settings of these tests; `answers: undefined` switches answers off. */
type Extra = Omit<Partial<ConnectorSettings>, 'answers'> & { answers?: ConnectorSettings['answers'] | undefined };
const settings = (extra: Extra = {}): ConnectorSettings => {
  const { answers, ...rest } = { answers: ANSWERS, ...extra };
  return {
    appId: APP_ID, privateKey: KEY, webhookSecret: SECRET, engine: { kind: 'http', url: 'https://pointsman.example.org', token: `pm_${crypto.randomUUID()}` },
    repos: new Set([REPO]), profiles: [PROFILE],
    actions: { [PROFILE]: { approve: { do: 'approve' } } },
    runs: {}, comment: { profiles: [PROFILE] }, ...rest, ...(answers && { answers }),
  };
};

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

type Call = { op: string; id?: number; head?: string; output?: CheckRunOutput; body?: string; login?: string };

function fakeGitHub() {
  let nextId = 100;
  const calls: Call[] = [];
  const state: PullRequestInfo = {
    open: true, merged: false, author: AUTHOR.login, authorId: AUTHOR.id, head: HEAD, headRef: 'feature', draft: false, base: 'main',
    title: 'Release', body: 'A body', fork: false, labels: [], requestedReviewers: [],
  };
  /** Permissions by login, and what the permission and activity calls do (a test sets them). */
  const people: Record<string, { id: number; permission: string }> = {
    [AUTHOR.login]: { id: AUTHOR.id, permission: 'write' }, [PUSHER.login]: { id: PUSHER.id, permission: 'write' },
    [MAINTAINER.login]: { id: MAINTAINER.id, permission: 'admin' }, [READER.login]: { id: READER.id, permission: 'read' },
  };
  const control: { pusher: Answerer | undefined | 'fail'; permission?: 'fail' | 404; update?: () => void } = { pusher: PUSHER };
  const github: ConnectorGitHub & { state: PullRequestInfo } = {
    state,
    pullRequest: async () => (calls.push({ op: 'get' }), { ...github.state }),
    findCheckRun: async () => undefined,
    createCheckRun: async (_r, head, _n, output) => { const id = nextId++; calls.push({ op: 'create', id, head, output }); return id; },
    updateCheckRun: async (_r, id, output) => { control.update?.(); calls.push({ op: 'update', id, output }); },
    findComment: async () => false,
    createComment: async (_r, _n, body) => (calls.push({ op: 'comment', body }), nextId++),
    findOwnComment: async () => undefined,
    updateComment: async (_r, _id, body) => void calls.push({ op: 'updateComment', body }),
    addLabels: async () => {},
    requestReviewers: async () => {},
    requestCopilot: async () => {},
    copilotAsked: async () => false,
    botLogin: async () => 'pointsman-test[bot]',
    ownApprovals: async () => [],
    ownApproval: async () => null,
    reviewSummary: async () => ({ head: github.state.head, decision: null, reviews: [] }),
    diff: async () => ({ diff: '', truncated: false }),
    approve: async (_r, _n, head) => (calls.push({ op: 'approve', head }), nextId++),
    dismissReview: async () => {},
    permission: async (_r, login) => {
      calls.push({ op: 'permission', login });
      if (control.permission === 'fail') throw new Error('GitHub permission: 502');
      if (control.permission === 404) throw new GitHubError('GitHub permission: 404', false, 404);
      const p = people[login];
      return p ? { account: { id: p.id, login }, permission: p.permission } : { account: { id: 999, login }, permission: 'none' };
    },
    headPusher: async (_r, branch, head) => {
      calls.push({ op: 'pusher', head, body: branch });
      if (control.pusher === 'fail') throw new Error('GitHub activity: 502');
      return control.pusher;
    },
  };
  return { github, calls, people, control };
}

const decision = (extra: Partial<Decision> = {}): Decision => ({
  decision_id: crypto.randomUUID(), action: 'review', profile: PROFILE, profile_version: 2, rule: 0, facts: {}, review: { status: 'pending' }, ...extra,
});

/** Pointsman: decides with a pending review, and reads back, resolves and closes as the engine does. */
function fakeEngine() {
  const logged = new Map<string, any>();
  const calls: { op: string; id?: string; body?: any }[] = [];
  const override: { get?: () => Response; resolve?: () => Response } = {};
  /** Fields added to every decision it makes (a test spoofs one). */
  const extra: Record<string, unknown> = {};
  const peopleAnswers = ['approve', 'reject'];
  const api: EngineApi = {
    url: 'https://pointsman.example.org',
    fetch: async (url, init) => {
      const m = /\/v1\/(decisions|reviews)\/([^/]+)(\/close|\/resolve)?$/.exec(url);
      if (!m) {
        const sent = JSON.parse(String(init.body));
        const d = { ...decision(), ref: sent.ref, ...extra };
        logged.set(d.decision_id, structuredClone(d));
        calls.push({ op: 'decide' });
        return Response.json(d);
      }
      const id = decodeURIComponent(m[2]!);
      const op = m[3] === '/close' ? 'close' : m[3] === '/resolve' ? 'resolve' : 'get';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ op, id, ...(body && { body }) });
      if (op !== 'close' && override[op]) return override[op]!();
      const record = logged.get(id);
      if (!record) return Response.json({ error: { code: 'decision_not_found', message: 'x' } }, { status: 404 });
      if (op === 'get') return Response.json(record);
      if (record.review?.status !== 'pending') return Response.json({ error: { code: 'not_pending', message: 'x' } }, { status: 409 });
      if (op === 'close') {
        record.review = { status: 'superseded' };
        return Response.json({ decision_id: id, review: { status: 'superseded' } });
      }
      if (!peopleAnswers.includes(body.action)) return Response.json({ error: { code: 'invalid_request', message: 'x' } }, { status: 400 });
      record.review = { status: 'resolved', final_action: body.action, resolved_by: body.by };
      return Response.json({ decision_id: id, action: body.action, resolved_by: body.by, answers: {}, resolved_at: 'now', callback: 'none' });
    },
  };
  return { engine: httpEngine(api, `pm_${crypto.randomUUID()}`), logged, calls, override, peopleAnswers, extra };
}

/** A pull request with an open question on HEAD: its object, its check run and the decision asked. */
async function asking(extra: Extra = {}) {
  const mem = memoryStorage();
  const gh = fakeGitHub();
  const pm = fakeEngine();
  const work = pullRequestWork(settings(extra), mem.storage, pm.engine, gh.github);
  const target = { repo: REPO, number: 7 };
  const accept = (more: Partial<Accepted> = {}) => work.accept({ target, delivery: crypto.randomUUID(), digest: crypto.randomUUID(), ...more }, Date.now());
  await accept();
  await work.run();
  const id = [...pm.logged.keys()][0]!;
  const checkRun = gh.calls.find((c) => c.op === 'create')!.id!;
  /** Sends an answer and runs the object's alarm. */
  const answer = async (event: AnswerEvent, by: Answerer = MAINTAINER) => {
    const result = await accept({ answer: { event, by } });
    await work.run();
    return result;
  };
  const click = (n: number, by: Answerer = MAINTAINER, more: Partial<Extract<AnswerEvent, { kind: 'button' }>> = {}) =>
    answer({ kind: 'button', checkRun, head: HEAD, externalId: id, identifier: `${n}-${id.slice(0, 8)}`, ...more }, by);
  const lastOutput = () => gh.calls.filter((c) => c.output).at(-1)!.output!;
  const resolves = () => pm.calls.filter((c) => c.op === 'resolve');
  return { work, mem, gh, pm, id, checkRun, accept, answer, click, lastOutput, resolves };
}

describe('the setting: answers in the pull request, off unless switched on', () => {
  const env = (connector: unknown) => ({
    GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x',
    GITHUB_CONNECTOR: JSON.stringify({ repos: [REPO], profiles: [PROFILE, 'other'], ...(connector as object) }),
  });
  const parse = (answers: unknown) => connectorSettings(env({ answers }))!.answers;

  it('is off without the setting; buttons where answers are on, the command only when switched on', () => {
    expect(connectorSettings(env({}))!.answers).toBeUndefined();
    expect(parse({ profiles: { [PROFILE]: ['approve', 'reject', 'approve'] } })).toEqual({ profiles: { [PROFILE]: ['approve', 'reject'] }, command: false });
    expect(parse({ profiles: { [PROFILE]: ['approve'] }, command: true })).toEqual({ profiles: { [PROFILE]: ['approve'] }, command: true });
    // With answers on, the token may read contents: GitHub lists who pushed (the activity) only with contents: read.
    expect(readsContents(connectorSettings(env({}))!)).toBe(false);
    expect(readsContents(connectorSettings(env({ answers: { profiles: { [PROFILE]: ['approve'] } } }))!)).toBe(true);
  });

  it('more than three answers, or a name longer than a button label, needs the command', () => {
    const four = ['approve', 'reject', 'wait', 'pay'];
    expect(() => parse({ profiles: { [PROFILE]: four } })).toThrow(/gets no buttons; switch on answers.command/);
    expect(() => parse({ profiles: { [PROFILE]: ['a-very-long-answer-name'] } })).toThrow(/longer than 20 characters/);
    expect(parse({ profiles: { [PROFILE]: four }, command: true })!.profiles[PROFILE]).toEqual(four);
  });

  it('refuses wrong settings', () => {
    expect(() => parse({ profiles: {} })).toThrow(/at least one profile/);
    expect(() => parse({ profiles: { unknown: ['approve'] } })).toThrow(/not in "profiles"/);
    expect(() => parse({ profiles: { [PROFILE]: [] } })).toThrow(/1 to 10 action names/);
    expect(() => parse({ profiles: { [PROFILE]: ['review'] } })).toThrow(/not review/);
    expect(() => parse({ profiles: { [PROFILE]: ['Approve'] } })).toThrow(/action names/);
    expect(() => parse({ profiles: { [PROFILE]: ['approve'] }, command: 'yes' })).toThrow(/answers.command must be true or false/);
    expect(() => parse({ profiles: { [PROFILE]: ['approve'] }, buttons: true })).toThrow(/unknown key buttons/);
    expect(() => parse([])).toThrow(/must be an object/);
  });
});

describe('the webhook: which events are answers', () => {
  const sender = (u: Partial<Answerer> & { type?: string } = {}) => ({ login: MAINTAINER.login, id: MAINTAINER.id, type: 'User', ...u });
  const click = (more: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => ({
    action: 'requested_action', repository: { full_name: REPO }, sender: sender(),
    check_run: { id: 100, app: { id: APP_ID }, head_sha: HEAD, external_id: 'd', pull_requests: [{ number: 7 }], ...run },
    requested_action: { identifier: '1-0123abcd' }, ...more,
  });
  const comment = (body: string, more: Record<string, unknown> = {}) => ({
    action: 'created', repository: { full_name: REPO }, sender: sender(),
    issue: { number: 7, pull_request: { url: 'x' } }, comment: { body, user: sender() }, ...more,
  });

  it('a click on one of its own check runs, with one of its identifiers, by a person', () => {
    expect(answerOf('check_run', click(), APP_ID, false)).toEqual({
      targets: [{ repo: REPO, number: 7 }], by: MAINTAINER,
      answer: { kind: 'button', checkRun: 100, head: HEAD, externalId: 'd', identifier: '1-0123abcd' },
    });
    // Another app's check run, another action, an identifier it never made, no pull request (a fork): none.
    expect(answerOf('check_run', click({}, { app: { id: 1 } }), APP_ID, false)).toBeUndefined();
    expect(answerOf('check_run', click({ action: 'completed' }), APP_ID, false)).toBeUndefined();
    expect(answerOf('check_run', click({ requested_action: { identifier: 'approve' } }), APP_ID, false)).toBeUndefined();
    expect(answerOf('check_run', click({}, { pull_requests: [] }), APP_ID, false)).toBeUndefined();
  });

  it('nothing from a bot, an app or the ghost account', () => {
    expect(answerOf('check_run', click({ sender: sender({ type: 'Bot', login: 'pointsman-test[bot]' }) }), APP_ID, true)).toBeUndefined();
    expect(answerOf('check_run', click({ sender: sender({ login: 'ghost' }) }), APP_ID, true)).toBeUndefined();
    expect(answerOf('check_run', click({ sender: sender({ id: 'x' as never }) }), APP_ID, true)).toBeUndefined();
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT}`, { sender: sender({ type: 'Bot', login: 'github-actions[bot]' }) }), APP_ID, true)).toBeUndefined();
  });

  it('a comment only when the command is on, only when created, only on a pull request, only by the sender', () => {
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT}`), APP_ID, true)).toEqual({ targets: [{ repo: REPO, number: 7 }], by: MAINTAINER, answer: { kind: 'command', answer: 'approve', head: SHORT } });
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT} 0a1b2c3d`), APP_ID, true)).toMatchObject({ answer: { kind: 'command', answer: 'approve', head: SHORT, question: '0a1b2c3d' } });
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT}`), APP_ID, false)).toBeUndefined();
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT}`, { action: 'edited' }), APP_ID, true)).toBeUndefined();
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT}`, { action: 'deleted' }), APP_ID, true)).toBeUndefined();
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT}`, { issue: { number: 7 } }), APP_ID, true)).toBeUndefined();
    expect(answerOf('issue_comment', comment(`/pointsman approve ${SHORT}`, { comment: { body: `/pointsman approve ${SHORT}`, user: sender({ id: 9 }) } }), APP_ID, true)).toBeUndefined();
  });

  it('the command: the whole comment is one line with the answer and the head, exactly; quotes, code blocks, other text and upper case are not', () => {
    expect(commandOf('/pointsman approve 0123456789ab')).toEqual({ answer: 'approve', head: '0123456789ab' });
    expect(commandOf('  /pointsman approve 0123456789ab\n')).toEqual({ answer: 'approve', head: '0123456789ab' });
    expect(commandOf('/pointsman reject-now_2 0123456789ab')).toEqual({ answer: 'reject-now_2', head: '0123456789ab' });
    expect(commandOf('/pointsman approve 0123456789ab 89abcdef')).toEqual({ answer: 'approve', head: '0123456789ab', question: '89abcdef' });
    for (const body of ['/pointsman approve 0123456789ab 89abcde', '/pointsman approve 0123456789ab 89ABCDEF', '/pointsman approve 0123456789ab 89abcdef0', '/pointsman approve 0123456789ab  89abcdef']) expect(commandOf(body), body).toBeUndefined();
    for (const body of [
      // Without the head, or with a head that is not 7 lower-case hex characters: not a command.
      '/pointsman approve', '/pointsman approve 0123abc', '/pointsman approve 0123456789a', '/pointsman approve 0123456789abc', '/pointsman approve 0123456789AB', '/pointsman approve main12345678',
      '> /pointsman approve 0123456789ab', '```\n/pointsman approve 0123456789ab\n```', '`/pointsman approve 0123456789ab`', '    /pointsman approve 0123456789ab x', 'yes\n/pointsman approve 0123456789ab',
      '/pointsman approve 0123456789ab\nthanks', '/Pointsman approve 0123456789ab', '/pointsman Approve 0123456789ab', '/pointsman  approve 0123456789ab', '/pointsman', '/pointsmanapprove 0123456789ab', 'please /pointsman approve 0123456789ab',
    ]) expect(commandOf(body), body).toBeUndefined();
    expect(commandOf(undefined)).toBeUndefined();
  });

  it('routes an answer to the pull request\'s object as an answer, only for its repositories and only where answers are on', async () => {
    const seen: Accepted[] = [];
    const connector = (s: ConnectorSettings) => githubConnector(s, {
      idFromName: (name) => name,
      get: () => ({ async fetch(_url, init) { seen.push(JSON.parse(String(init.body))); return Response.json({ result: 'answer' }); } }),
    });
    const post = async (c: ReturnType<typeof connector>, event: string, payload: unknown) => {
      const body = JSON.stringify(payload);
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      return c.fetch(new Request('https://c.example.org/webhook', { method: 'POST', body, headers: { 'x-github-event': event, 'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': `sha256=${mac}` } }));
    };
    const on = connector(settings({ answers: { ...ANSWERS, command: true } }));
    expect(await (await post(on, 'check_run', click())).json()).toEqual({ results: ['answer'] });
    expect(seen[0]).toMatchObject({ target: { repo: REPO, number: 7 }, answer: { by: MAINTAINER, event: { kind: 'button', identifier: '1-0123abcd' } } });
    await post(on, 'issue_comment', comment(`/pointsman approve ${SHORT}`));
    expect(seen[1]).toMatchObject({ answer: { by: MAINTAINER, event: { kind: 'command', answer: 'approve', head: SHORT } } });
    // Another repository; answers off; a comment that is not a command: ignored.
    expect(await (await post(on, 'check_run', click({ repository: { full_name: 'other/repo' } }))).json()).toEqual({ ignored: true });
    expect(await (await post(on, 'issue_comment', comment('LGTM'))).json()).toEqual({ ignored: true });
    // A closed pull request reaches its object with answers on and the decision comment off: its question is closed.
    const closed = { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 7 }, sender: sender() };
    expect(await (await post(connector(settings({ comment: undefined } as never)), 'pull_request', closed)).json()).toEqual({ results: ['answer'] });
    seen.pop();
    const off = connector(settings({ answers: undefined }));
    expect(await (await post(off, 'check_run', click())).json()).toEqual({ ignored: true });
    expect(await (await post(off, 'issue_comment', comment(`/pointsman approve ${SHORT}`))).json()).toEqual({ ignored: true });
    expect(seen).toHaveLength(2);
  });
});

describe('buttons on the check run', () => {
  it('while the question is open: one per answer, bound to the question; removed once answered', async () => {
    const { id, gh, lastOutput, click } = await asking();
    const created = gh.calls.find((c) => c.op === 'create')!.output!;
    expect(created.actions).toEqual([
      { label: 'approve', description: 'Pointsman: answer approve', identifier: `1-${id.slice(0, 8)}` },
      { label: 'reject', description: 'Pointsman: answer reject', identifier: `2-${id.slice(0, 8)}` },
    ]);
    expect(created.summary).toContain('Answer in the pull request with a button above. Only people with write access can answer; not the author');
    await click(1);
    expect(lastOutput().actions).toEqual([]);
  });

  it('none for a profile whose answers do not fit, labels and identifiers within GitHub\'s limits', () => {
    expect(buttonsFor(crypto.randomUUID(), ['approve', 'reject', 'wait', 'pay'])).toEqual([]);
    const id = crypto.randomUUID();
    for (const b of buttonsFor(id, ['a'.repeat(20), 'b', 'c'])) {
      expect(b.label.length).toBeLessThanOrEqual(20);
      expect(b.description.length).toBeLessThanOrEqual(40);
      expect(b.identifier).toMatch(/^[1-3]-[0-9a-f]{8}$/);
    }
  });

  it('a push removes the old head\'s buttons and closes its question', async () => {
    const { gh, pm, id, checkRun, accept, work } = await asking();
    gh.github.state.head = HEAD2;
    await accept();
    await work.run();
    const cleared = gh.calls.find((c) => c.op === 'update' && c.id === checkRun)!.output!;
    expect(cleared.actions).toEqual([]);
    expect(cleared.summary).toContain('The pull request has newer commits: this question is closed.');
    expect(pm.logged.get(id).review).toEqual({ status: 'superseded' });
  });

  it('a closed pull request closes the question and removes the buttons, also with the decision comment off', async () => {
    const { gh, pm, id, checkRun, accept, work } = await asking({ comment: undefined } as never);
    gh.github.state.open = false;
    await accept();
    await work.run();
    expect(pm.logged.get(id).review).toEqual({ status: 'superseded' });
    const cleared = gh.calls.filter((c) => c.op === 'update' && c.id === checkRun).at(-1)!.output!;
    expect(cleared.actions).toEqual([]);
    expect(cleared.summary).toContain('The pull request is closed: this question is closed.');
  });

  it('a removal of buttons that fails while GitHub is busy is tried again on the next run', async () => {
    const { gh, checkRun, accept, work, mem } = await asking();
    gh.github.state.head = HEAD2;
    let fail = true;
    gh.control.update = () => { if (fail) { fail = false; throw new GitHubError('GitHub check run: 502', true, 502); } };
    await logged(async () => { await accept(); await work.run(); });
    expect(gh.calls.filter((c) => c.op === 'update' && c.id === checkRun)).toEqual([]);
    expect((mem.data.get('clearing') as any[]).map((c) => c.id)).toEqual([checkRun]);
    await accept();
    await work.run();
    expect(gh.calls.filter((c) => c.op === 'update' && c.id === checkRun).at(-1)!.output!.actions).toEqual([]);
    expect(mem.data.get('clearing')).toEqual([]);
  });

  it('a removal left from a close is dropped when the pull request is reopened on the same commit: the live question keeps its buttons', async () => {
    const { gh, checkRun, accept, work, mem } = await asking();
    gh.github.state.open = false;
    gh.control.update = () => { throw new GitHubError('GitHub check run: 502', true, 502); };
    await logged(async () => { await accept(); await work.run(); });
    expect((mem.data.get('clearing') as any[]).map((c) => c.id)).toEqual([checkRun]);
    delete gh.control.update;
    gh.github.state.open = true;
    const before = gh.calls.length;
    await accept();
    await work.run();
    expect(mem.data.get('clearing')).toEqual([]);
    const after = gh.calls.slice(before).filter((c) => c.op === 'update' && c.id === checkRun);
    expect(after.some((c) => c.output!.summary.includes('The pull request is closed'))).toBe(false);
    expect(after.at(-1)!.output!.actions).toHaveLength(2);
  });

  it('a deployment without answers sends no actions at all', async () => {
    const { gh } = await asking({ answers: undefined });
    expect(gh.calls.filter((c) => c.output).every((c) => c.output!.actions === undefined)).toBe(true);
  });
});

describe('an answer: checked with GitHub at answer time, then resolved and acted on', () => {
  it('a click by a maintainer resolves the question as them, and the run approves the unchanged head once', async () => {
    const { id, gh, pm, mem, click, lastOutput, resolves } = await asking();
    let result: unknown;
    const log = await logged(async () => { result = await click(1); });
    expect(result).toBe('answer');
    expect(resolves()).toEqual([{ op: 'resolve', id, body: { action: 'approve', by: 'github:Octo-Cat (5)' } }]);
    // Who answered is read anew, by login, and compared by id.
    expect(gh.calls.filter((c) => c.op === 'permission').map((c) => c.login)).toEqual(['Octo-Cat']);
    expect(gh.calls.filter((c) => c.op === 'pusher')).toEqual([{ op: 'pusher', head: HEAD, body: 'feature' }]);
    expect(gh.calls.filter((c) => c.op === 'approve').map((c) => c.head)).toEqual([HEAD]);
    // Shown without a mention; logs never carry the login.
    expect(lastOutput().title).toBe('🟢 approve: answered by Octo-Cat');
    expect(lastOutput().summary).toContain('Answered by Octo-Cat in the pull request: **approve**');
    const comment = gh.calls.filter((c) => c.op === 'comment' || c.op === 'updateComment').at(-1)!.body!;
    expect(comment).toContain('| `pr-next-step` | 🟢 go | `approve` | answered by Octo-Cat |');
    expect(comment).toContain('answered by Octo-Cat: approve');
    expect(comment).not.toContain('@Octo-Cat');
    expect(log).not.toContain('Octo-Cat');
    expect(log).toContain(`an answer to decision ${id} was taken`);
    expect((mem.data.get('asked') as any).byProfile[PROFILE].decision).toMatchObject({ review: { status: 'resolved', final_action: 'approve' }, answered_by: 'Octo-Cat' });
    // The same click again: answered already, nothing more.
    await logged(async () => { await click(1); await click(2); });
    expect(resolves()).toHaveLength(1);
    expect(gh.calls.filter((c) => c.op === 'approve')).toHaveLength(1);
    expect(pm.calls.filter((c) => c.op === 'decide')).toHaveLength(1);
  });

  // Each refusal: nothing resolved, nothing done, a fixed note on the check run, logged with the decision id.
  const refusals: [string, (t: Awaited<ReturnType<typeof asking>>) => void | Promise<void>, Answerer, string][] = [
    ['the author', () => {}, AUTHOR, 'the author of the pull request cannot answer'],
    ['the person who pushed the head', () => {}, PUSHER, 'the person who pushed this commit cannot answer'],
    ['a person without write access', () => {}, READER, 'only people with write access can answer'],
    ['a person GitHub does not know as a collaborator', () => {}, { login: 'stranger', id: 77 }, 'the account could not be confirmed'],
    ['a renamed login now held by another account', (t) => { t.gh.people[MAINTAINER.login] = { id: 55, permission: 'admin' }; }, MAINTAINER, 'the account could not be confirmed'],
    ['a failed permission read (fail closed)', (t) => { t.gh.control.permission = 'fail'; }, MAINTAINER, 'the permission could not be read; answer again'],
    ['an unknown last pusher (fail closed)', (t) => { t.gh.control.pusher = undefined; }, MAINTAINER, 'who pushed this commit is not known'],
    ['a failed read of who pushed (fail closed)', (t) => { t.gh.control.pusher = 'fail'; }, MAINTAINER, 'who pushed this commit could not be read; answer again'],
    ['an author GitHub gives no id for', (t) => { t.gh.github.state.authorId = 0; }, MAINTAINER, 'the author of the pull request could not be read'],
    ['a pull request from a fork', (t) => { t.gh.github.state.fork = true; }, MAINTAINER, 'who pushed this commit cannot be read for a pull request from a fork'],
    ['a head that moved since the question', (t) => { t.gh.github.state.head = HEAD2; }, MAINTAINER, 'the pull request has newer commits'],
    ['a closed pull request', (t) => { t.gh.github.state.open = false; }, MAINTAINER, 'the pull request is closed'],
    ['a question closed in Pointsman', (t) => { t.pm.logged.get(t.id).review = { status: 'superseded' }; }, MAINTAINER, 'this question is no longer open'],
    ['an answer Pointsman does not take (not in people_answers)', (t) => { t.pm.peopleAnswers.splice(0); }, MAINTAINER, 'Pointsman did not accept this answer for the profile'],
    ['Pointsman down on resolve', (t) => { t.pm.override.resolve = () => new Response('', { status: 503 }); }, MAINTAINER, 'Pointsman did not take the answer; answer again'],
  ];
  for (const [what, arrange, by, text] of refusals) {
    it(`refuses ${what}`, async () => {
      const t = await asking();
      await arrange(t);
      const log = await logged(() => t.click(1, by));
      const failed = text.startsWith('Pointsman did not');
      expect(t.resolves()).toHaveLength(failed ? 1 : 0);
      expect(t.gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
      const note = t.gh.calls.filter((c) => c.op === 'update' && c.id === t.checkRun).at(-1)!.output!.summary;
      expect(note).toContain(`An answer was not taken: ${text}`);
      expect(log).toContain(`an answer to decision ${t.id} was not taken`);
      // The log names the decision, never the person.
      expect(log).not.toContain(by.login);
    });
  }

  it('the author is refused before GitHub is asked about anyone else; a reader costs one permission lookup', async () => {
    const t = await asking();
    await logged(() => t.click(1, AUTHOR));
    expect(t.gh.calls.filter((c) => c.op === 'permission' || c.op === 'pusher')).toEqual([]);
    await logged(() => t.click(1, READER));
    expect(t.gh.calls.filter((c) => c.op === 'permission' || c.op === 'pusher').map((c) => c.op)).toEqual(['permission']);
  });

  it('a click bound to another question, head or check run is not taken', async () => {
    const t = await asking();
    const log = await logged(async () => {
      // An identifier of an earlier question on the same check run; another decision id; a button that was never offered.
      await t.click(1, MAINTAINER, { identifier: '1-ffffffff' });
      await t.click(1, MAINTAINER, { externalId: crypto.randomUUID() });
      await t.click(3);
      // Another head's check run, or a check run it has no record of: ignored without a note.
      await t.click(1, MAINTAINER, { head: HEAD2 });
      await t.click(1, MAINTAINER, { checkRun: 999 });
    });
    expect(t.resolves()).toEqual([]);
    expect(t.gh.calls.filter((c) => c.op === 'permission')).toEqual([]);
    expect(log).toContain('which it has no record of for this head; ignored');
    expect(t.gh.calls.filter((c) => c.op === 'update' && c.output!.summary.includes('this question is no longer open'))).toHaveLength(3);
  });

  it('answered first in Pointsman\'s queue: that answer stands, this one is not taken', async () => {
    const t = await asking();
    t.pm.logged.get(t.id).review = { status: 'resolved', final_action: 'reject', resolved_by: 'someone' };
    await logged(() => t.click(1));
    expect(t.resolves()).toEqual([]);
    expect(t.gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
    // The run read it back: the person's answer from the queue, with nobody named.
    expect(t.lastOutput().title).toBe('🟡 reject: a person\'s answer (shadow)');
  });

  it('answered in between (409 on resolve): read back, this answer not reported as taken', async () => {
    const t = await asking();
    t.pm.override.resolve = () => {
      t.pm.logged.get(t.id).review = { status: 'resolved', final_action: 'reject' };
      return Response.json({ error: { code: 'not_pending', message: 'x' } }, { status: 409 });
    };
    const log = await logged(() => t.click(1));
    expect(log).toContain('was answered or closed first; this answer was not taken');
    expect(t.gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
    expect(t.lastOutput().title).toBe('🟡 reject: a person\'s answer (shadow)');
  });

  it(`one account: at most ${ANSWERS_PER_ACCOUNT_PER_HOUR} answers an hour, noted once; it cannot block a maintainer`, async () => {
    const t = await asking();
    const log = await logged(async () => { for (let i = 0; i < ANSWERS_PER_ACCOUNT_PER_HOUR + 3; i++) await t.click(1, READER); });
    expect(t.gh.calls.filter((c) => c.op === 'permission')).toHaveLength(ANSWERS_PER_ACCOUNT_PER_HOUR);
    expect(log).toContain(`more than ${ANSWERS_PER_ACCOUNT_PER_HOUR} answers from one account this hour`);
    expect(t.gh.calls.filter((c) => c.output?.summary.includes('answers from one account this hour; answer again in the next hour'))).toHaveLength(1);
    await logged(() => t.click(1));
    expect(t.resolves()).toHaveLength(1);
  });

  it(`all accounts: at most ${ANSWER_CHECKS_PER_HOUR} permission lookups and ${ANSWER_READS_PER_HOUR} reads of the pull request an hour`, async () => {
    const t = await asking();
    const stranger = (i: number): Answerer => ({ login: `stranger-${i}`, id: 1000 + i });
    // Strangers that pass the checks of the pull request: one permission lookup each, up to the cap.
    const log = await logged(async () => { for (let i = 0; i < ANSWER_CHECKS_PER_HOUR + 2; i++) await t.click(1, stranger(i)); });
    expect(t.gh.calls.filter((c) => c.op === 'permission')).toHaveLength(ANSWER_CHECKS_PER_HOUR);
    expect(log).toContain(`more than ${ANSWER_CHECKS_PER_HOUR} answers checked this hour`);
    const capNotes = (x: typeof t) => x.gh.calls.filter((c) => c.output?.summary.includes('answer again in the next hour')).length;
    expect(capNotes(t)).toBe(1);
    // Other accounts over their own cap later in the hour: no second note, whichever cap.
    await logged(async () => { for (let i = 0; i < ANSWERS_PER_ACCOUNT_PER_HOUR + 1; i++) await t.click(1, READER); });
    expect(capNotes(t)).toBe(1);
    // Answers refused by the pull request's own checks (the author) cost no lookup, but each reads the pull request.
    const t2 = await asking();
    t2.gh.github.state.authorId = 0;
    const reads = () => t2.gh.calls.filter((c) => c.op === 'get').length;
    const before = reads();
    await logged(async () => { for (let i = 0; i < ANSWER_READS_PER_HOUR + 2; i++) await t2.click(1, stranger(i)); });
    expect(reads() - before).toBe(ANSWER_READS_PER_HOUR);
    expect(t2.gh.calls.filter((c) => c.op === 'permission')).toEqual([]);
    // The reads cap notes once too, and the hour's counts keep only the accounts that were let through.
    expect(capNotes(t2)).toBe(1);
    expect(Object.keys((t2.mem.data.get('answerCounts') as any).accounts)).toHaveLength(ANSWER_READS_PER_HOUR);
    // The next clock hour starts anew.
    const later = Date.now() + 3600_000;
    t2.work.now = () => later;
    await logged(() => t2.click(1, stranger(99)));
    expect(reads() - before).toBe(ANSWER_READS_PER_HOUR + 1);
  });

  it('a failure on GitHub\'s or Pointsman\'s side does not use up the person\'s answers', async () => {
    const t = await asking();
    t.gh.control.permission = 'fail';
    await logged(async () => { for (let i = 0; i < ANSWERS_PER_ACCOUNT_PER_HOUR + 2; i++) await t.click(1, MAINTAINER); });
    expect(t.gh.calls.filter((c) => c.op === 'permission')).toHaveLength(ANSWERS_PER_ACCOUNT_PER_HOUR + 2);
    delete t.gh.control.permission;
    await logged(() => t.click(1));
    expect(t.resolves()).toHaveLength(1);
  });

  it('notes for answers that bind to nothing count under the caps: an ambiguous command cannot make it write without end', async () => {
    const t = await asking({ answers: { ...ANSWERS, command: true } });
    const asked = t.mem.data.get('asked') as any;
    asked.byProfile.other = { ...asked.byProfile[PROFILE], decision: { ...asked.byProfile[PROFILE].decision, decision_id: crypto.randomUUID() } };
    t.mem.data.set('asked', asked);
    await logged(async () => { for (let i = 0; i < 10; i++) await t.answer({ kind: 'command', answer: 'approve', head: SHORT }, READER); });
    // No question named, two open: notes for the account's 3 answers of the hour, then nothing more (the cap's own note: once).
    expect(t.gh.calls.filter((c) => c.output?.summary.includes('the command names no question')).length).toBeLessThanOrEqual(2 * ANSWERS_PER_ACCOUNT_PER_HOUR + 1);
    expect((t.mem.data.get('answerCounts') as any).reads).toBe(ANSWERS_PER_ACCOUNT_PER_HOUR);
  });

  it('a permission GitHub does not find (404) is no write access', async () => {
    const t = await asking();
    t.gh.control.permission = 404;
    const log = await logged(() => t.click(1));
    expect(t.lastOutput().summary).toContain('An answer was not taken: only people with write access can answer');
    // The log has GitHub's status, never the login.
    expect(log).toContain('(GitHub permission: 404)');
    expect(log).not.toContain('Octo-Cat');
  });

  it('a replayed answer is dropped, and a full queue drops more', async () => {
    const t = await asking();
    const delivery = crypto.randomUUID();
    const event: AnswerEvent = { kind: 'button', checkRun: t.checkRun, head: HEAD, externalId: t.id, identifier: `1-${t.id.slice(0, 8)}` };
    const send = () => t.work.accept({ target: { repo: REPO, number: 7 }, delivery, digest: crypto.randomUUID(), answer: { event, by: READER } }, Date.now());
    expect(await send()).toBe('answer');
    expect(await send()).toBe('replay');
    // The same body again with a new delivery id: a second click on the same button, not a replay.
    const digest = crypto.randomUUID();
    const again = () => t.work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest, answer: { event, by: READER } }, Date.now());
    expect(await again()).toBe('answer');
    expect(await again()).toBe('answer');
    const more: string[] = [];
    await logged(async () => { for (let i = 0; i < 6; i++) more.push(await t.accept({ answer: { event, by: READER } })); });
    expect(more.filter((r) => r === 'dropped')).toHaveLength(4);
  });
});

describe('the comment command (when switched on)', () => {
  const on = { answers: { ...ANSWERS, command: true } };

  it('answers the one open question that offers the answer; the decision comment lists the commands', async () => {
    const t = await asking(on);
    const comment = t.gh.calls.filter((c) => c.op === 'comment').at(-1)!.body!;
    const q = t.id.slice(0, 8);
    expect(comment).toContain(`<code>pr-next-step</code> waits for a person about commit ${SHORT}: answer with a comment of one line, \`/pointsman approve ${SHORT} ${q}\` or \`/pointsman reject ${SHORT} ${q}\`.`);
    expect(t.gh.calls.find((c) => c.op === 'create')!.output!.summary).toContain(`or with a comment of one line: \`/pointsman approve ${SHORT} ${q}\`, \`/pointsman reject ${SHORT} ${q}\``);
    await logged(() => t.answer({ kind: 'command', answer: 'reject', head: SHORT, question: q }));
    expect(t.resolves()).toEqual([{ op: 'resolve', id: t.id, body: { action: 'reject', by: 'github:Octo-Cat (5)' } }]);
    expect(t.lastOutput().title).toBe('🟡 reject: answered by Octo-Cat (shadow)');
  });

  it('a command that answers no open question does nothing, quietly; one that matches two is refused on both', async () => {
    const t = await asking(on);
    await logged(() => t.answer({ kind: 'command', answer: 'wait', head: SHORT, question: t.id.slice(0, 8) }));
    expect(t.gh.calls.filter((c) => c.op === 'permission')).toEqual([]);
    const updates = t.gh.calls.filter((c) => c.op === 'update').length;
    // A second open question offering the same answer, whose decision id starts the same.
    const asked = t.mem.data.get('asked') as any;
    asked.byProfile.other = { ...asked.byProfile[PROFILE], decision: { ...asked.byProfile[PROFILE].decision, decision_id: `${t.id.slice(0, 8)}${crypto.randomUUID().slice(8)}` } };
    t.mem.data.set('asked', asked);
    const log = await logged(() => t.answer({ kind: 'command', answer: 'approve', head: SHORT, question: t.id.slice(0, 8) }));
    expect(t.resolves()).toEqual([]);
    expect(log).toContain('more than one open question');
    expect(t.gh.calls.filter((c) => c.op === 'update').slice(updates).some((c) => c.output!.summary.includes('the command matches more than one open question'))).toBe(true);
  });

  it('a command names the commit: one written for an older head never answers the question of a newer one', async () => {
    const t = await asking(on);
    // Pushed, not yet run: the command for the old head is bound to the old question, and refused (the head moved).
    t.gh.github.state.head = HEAD2;
    await logged(() => t.answer({ kind: 'command', answer: 'approve', head: SHORT, question: t.id.slice(0, 8) }));
    expect(t.resolves()).toEqual([]);
    expect(t.lastOutput().summary).toContain('An answer was not taken: the pull request has newer commits');
    // The run made the new question; the same command, late (or delivered out of order), is not about it.
    await t.accept();
    await t.work.run();
    expect(t.pm.calls.filter((c) => c.op === 'decide')).toHaveLength(2);
    const log = await logged(() => t.answer({ kind: 'command', answer: 'approve', head: SHORT, question: t.id.slice(0, 8) }));
    expect(log).toContain(`a command for commit ${SHORT}, which has no open question; ignored`);
    expect(t.resolves()).toEqual([]);
    expect(t.gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
    // Written for the new head and its question: taken.
    const next = (t.mem.data.get('asked') as any).byProfile[PROFILE].decision.decision_id as string;
    await logged(() => t.answer({ kind: 'command', answer: 'approve', head: SHORT2, question: next.slice(0, 8) }));
    expect(t.resolves()).toHaveLength(1);
    expect(t.gh.calls.filter((c) => c.op === 'approve').map((c) => c.head)).toEqual([HEAD2]);
  });

  it('a commit prefix shared by two heads of the pull request is refused; the list of heads is bounded', async () => {
    const t = await asking(on);
    // Two heads that start with the same 12 characters (an author could make such a pair).
    const prefix = 'c'.repeat(12);
    const first = `${prefix}${'d'.repeat(28)}`;
    const second = `${prefix}${'e'.repeat(28)}`;
    for (const head of [first, second]) {
      t.gh.github.state.head = head;
      await t.accept();
      await t.work.run();
    }
    expect((t.mem.data.get('asked') as any).head).toBe(second);
    const log = await logged(() => t.answer({ kind: 'command', answer: 'approve', head: prefix, question: 'ffffffff' }));
    expect(log).toContain(`a command for commit ${prefix}, a prefix of more than one commit of this pull request; refused`);
    expect(t.resolves()).toEqual([]);
    expect(t.gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
    expect(t.lastOutput().summary).toContain('An answer was not taken: the command names a commit prefix used by more than one commit of this pull request; answer with a button');
    // Buttons are bound to the check run and decision, not to a prefix: still taken.
    const run = t.gh.calls.filter((c) => c.op === 'create' && c.head === second).at(-1)!.id!;
    const id = (t.mem.data.get('asked') as any).byProfile[PROFILE].decision.decision_id as string;
    await logged(() => t.answer({ kind: 'button', checkRun: run, head: second, externalId: id, identifier: `1-${id.slice(0, 8)}` }));
    expect(t.resolves()).toHaveLength(1);
    // At most HEADS_KEPT heads, the oldest dropped.
    t.mem.data.set('heads', Array.from({ length: HEADS_KEPT }, (_, i) => i.toString(16).padStart(40, '0')));
    t.gh.github.state.head = HEAD2;
    await t.accept();
    await t.work.run();
    const heads = t.mem.data.get('heads') as string[];
    expect(heads).toHaveLength(HEADS_KEPT);
    expect(heads.at(-1)).toBe(HEAD2);
    expect(heads[0]).toBe((1).toString(16).padStart(40, '0'));
  });

  it('a command names the question: one for a question that was replaced on the same head, or none, is refused with a note', async () => {
    const t = await asking(on);
    // The author changed the description: a new decision for the same head replaced the question the person read.
    const asked = t.mem.data.get('asked') as any;
    const replacement = crypto.randomUUID();
    asked.byProfile[PROFILE].decision = { ...asked.byProfile[PROFILE].decision, decision_id: replacement };
    t.mem.data.set('asked', asked);
    const log = await logged(() => t.answer({ kind: 'command', answer: 'approve', head: SHORT, question: t.id.slice(0, 8) }));
    expect(log).toContain('the command names a question that is no longer open');
    expect(t.resolves()).toEqual([]);
    expect(t.gh.calls.filter((c) => c.op === 'approve')).toEqual([]);
    // Without the question (a command from before it was named): refused too.
    await logged(() => t.answer({ kind: 'command', answer: 'approve', head: SHORT }));
    expect(t.resolves()).toEqual([]);
    // Naming the open question: bound to it (the engine here does not know this made-up decision, so nothing is resolved).
    const taken = await logged(() => t.answer({ kind: 'command', answer: 'approve', head: SHORT, question: replacement.slice(0, 8) }));
    expect(taken).not.toContain('a command not taken');
  });

  it('a command for a commit with no question is ignored without a note', async () => {
    const t = await asking(on);
    const updates = t.gh.calls.filter((c) => c.op === 'update').length;
    await logged(() => t.answer({ kind: 'command', answer: 'approve', head: '0123456789ab' }));
    expect(t.resolves()).toEqual([]);
    expect(t.gh.calls.filter((c) => c.op === 'update')).toHaveLength(updates);
    expect(t.gh.calls.filter((c) => c.op === 'permission' || c.op === 'get').length).toBeLessThanOrEqual(2);
  });

  it('with the command off, a queued command is not taken', async () => {
    const t = await asking();
    await t.answer({ kind: 'command', answer: 'approve', head: SHORT });
    expect(t.resolves()).toEqual([]);
  });
});

describe('who answered is the connector\'s own note, never the engine\'s', () => {
  it('checkDecision drops answered_by from any answer', () => {
    const ref = `github:${REPO}#7@${HEAD}`;
    const d = { ...decision(), ref, answered_by: 'mallory' };
    const checked = checkDecision(d, { profile: PROFILE, ref });
    expect(checked.kind).toBe('decision');
    expect((checked as { decision: Decision }).decision.answered_by).toBeUndefined();
    expect(d.answered_by).toBe('mallory');
  });

  it('a decision or a read-back that names someone shows nobody', async () => {
    const t = await asking();
    // A new decision (after a push) that names someone: not kept, not shown.
    t.pm.extra.answered_by = 'mallory';
    t.gh.github.state.head = HEAD2;
    await t.accept();
    await t.work.run();
    expect((t.mem.data.get('asked') as any).byProfile[PROFILE].decision.answered_by).toBeUndefined();
    expect(JSON.stringify(t.gh.calls)).not.toContain('mallory');
    delete t.pm.extra.answered_by;
    t.gh.github.state.head = HEAD;
    await t.accept();
    await t.work.run();
    t.id = [...t.pm.logged.keys()].at(-1)!;
    // A read-back of an answer given in the queue, with a spoofed answered_by.
    t.pm.logged.get(t.id).review = { status: 'resolved', final_action: 'approve' };
    t.pm.logged.get(t.id).answered_by = 'mallory';
    await t.accept();
    await t.work.run();
    expect(t.lastOutput().title).toBe('🟢 approve: a person\'s answer');
    const all = JSON.stringify(t.gh.calls);
    expect(all).not.toContain('mallory');
    expect((t.mem.data.get('asked') as any).byProfile[PROFILE].decision.answered_by).toBeUndefined();
  });
});

describe('reading who may answer from GitHub (AppGitHub)', () => {
  const app = (answer: (url: string) => Response) => new AppGitHub(APP_ID, KEY, (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/installation')) return Response.json({ id: 9, permissions: { metadata: 'read', pull_requests: 'read', checks: 'write' } });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    return answer(url);
  }) as typeof fetch);

  it('the permission and the account behind a login', async () => {
    const urls: string[] = [];
    const gh = app((url) => (urls.push(url), Response.json({ permission: 'write', role_name: 'maintain', user: { login: 'Octo-Cat', id: 5 } })));
    expect(await gh.permission(REPO, 'Octo-Cat')).toEqual({ account: { id: 5, login: 'Octo-Cat' }, permission: 'write' });
    expect(urls).toEqual([`https://api.github.com/repos/${REPO}/collaborators/Octo-Cat/permission`]);
    await expect(gh.permission(REPO, '../x')).rejects.toThrow(/not a login/);
    await expect(app(() => Response.json({ permission: 'write' })).permission(REPO, 'x')).rejects.toThrow(/unexpected answer/);
    await expect(app(() => Response.json({ message: 'Not Found' }, { status: 404 })).permission(REPO, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('who pushed the head: only the newest push to the branch, when it ended at the head', async () => {
    const urls: string[] = [];
    const push = (after: string, type = 'push') => [{ after, before: 'c'.repeat(40), activity_type: type, actor: { login: 'pusher', id: 2 } }];
    const gh = app((url) => (urls.push(url), Response.json(push(HEAD))));
    expect(await gh.headPusher(REPO, 'feature', HEAD)).toEqual({ id: 2, login: 'pusher' });
    expect(urls[0]).toBe(`https://api.github.com/repos/${REPO}/activity?ref=refs%2Fheads%2Ffeature&per_page=1`);
    expect(await app(() => Response.json(push(HEAD2))).headPusher(REPO, 'feature', HEAD)).toBeUndefined();
    expect(await app(() => Response.json(push(HEAD, 'branch_deletion'))).headPusher(REPO, 'feature', HEAD)).toBeUndefined();
    expect(await app(() => Response.json([])).headPusher(REPO, 'feature', HEAD)).toBeUndefined();
    expect(await app(() => Response.json([{ ...push(HEAD)[0], actor: null }])).headPusher(REPO, 'feature', HEAD)).toBeUndefined();
    expect(await gh.headPusher(REPO, '', HEAD)).toBeUndefined();
    await expect(app(() => Response.json({})).headPusher(REPO, 'feature', HEAD)).rejects.toThrow(/unexpected answer/);
  });
});
