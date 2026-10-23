// The GitHub connector's decision comment and signals (docs/github-connector.md#the-decision-comment),
// against a fake GitHub API at the HTTP level (so the real client finds its own comment) and a fake Pointsman.

import { describe, expect, it, vi } from 'vitest';
import {
  AppGitHub, COMMENT_MARKER, actsOnGitHub, checkOutput, checkText, columns, commentBody, connectorSettings, httpEngine, lineArt, MAX_COLUMNS, STATIONS, pullRequestWork, signalOf, switchArt,
  type ConnectorSettings, type Decision, type ObjectStorage,
} from '@pointsman/github';
import type { EngineApi } from '@pointsman/module-api';

const SECRET = `whsec-${crypto.randomUUID()}`;
const APP_ID = 4242;
const SLUG = 'pointsman-checks';
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
  repos: new Set([REPO]), profiles: ['pr-risk', 'pr-next-step'], actions: {}, runs: {}, comment: { profiles: ['pr-risk', 'pr-next-step'] }, ...extra,
});

function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage: ObjectStorage = {
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    put: async (entries) => { for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v)); },
    setAlarm: async () => {},
  };
  return { storage, data };
}

interface Comment { id: number; body: string; user: { login: string; type: string } }

/** GitHub's REST API as far as the connector uses it here. `fail` answers a comment write with this status. */
function fakeApi() {
  let nextId = 1000;
  const pr = { state: 'open', draft: false, title: 'Docs', body: 'A body', head: HEAD };
  const comments: Comment[] = [];
  const checkRuns: { id: number; head: string; name: string; output: { title: string; summary: string; text?: string } }[] = [];
  const log: string[] = [];
  const api = { pr, comments, checkRuns, log, fail: 0 };
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname;
    if (path.endsWith('/installation')) return Response.json({ id: 9, app_slug: SLUG, permissions: { metadata: 'read', pull_requests: 'write', checks: 'write' } });
    if (path.endsWith('/access_tokens')) return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    log.push(`${method} ${path.replace(`/repos/${REPO}`, '')}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (path === `/repos/${REPO}/pulls/7` && method === 'GET') {
      return Response.json({
        state: pr.state, draft: pr.draft, title: pr.title, body: pr.body, labels: [], requested_reviewers: [],
        head: { sha: pr.head, repo: { full_name: REPO } }, base: { ref: 'main', repo: { full_name: REPO } },
      });
    }
    if (path.startsWith(`/repos/${REPO}/commits/`) && path.endsWith('/check-runs')) {
      const name = url.searchParams.get('check_name');
      return Response.json({ check_runs: checkRuns.filter((c) => c.name === name).map((c) => ({ id: c.id, name: c.name, app: { id: APP_ID } })) });
    }
    if (path === `/repos/${REPO}/check-runs` && method === 'POST') {
      const run = { id: nextId++, head: body.head_sha, name: body.name, output: body.output };
      checkRuns.push(run);
      return Response.json({ id: run.id }, { status: 201 });
    }
    const runMatch = /\/check-runs\/(\d+)$/.exec(path);
    if (runMatch && method === 'PATCH') {
      checkRuns.find((c) => c.id === Number(runMatch[1]))!.output = body.output;
      return Response.json({});
    }
    if (path === `/repos/${REPO}/issues/7/comments`) {
      if (method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '1');
        return Response.json(page === 1 ? comments : []);
      }
      if (api.fail) return Response.json({ message: 'no' }, { status: api.fail });
      const c = { id: nextId++, body: body.body, user: { login: `${SLUG}[bot]`, type: 'Bot' } };
      comments.push(c);
      return Response.json(c, { status: 201 });
    }
    const commentMatch = /\/issues\/comments\/(\d+)$/.exec(path);
    if (commentMatch && method === 'PATCH') {
      if (api.fail) return Response.json({ message: 'no' }, { status: api.fail });
      const c = comments.find((x) => x.id === Number(commentMatch[1]));
      if (!c) return Response.json({ message: 'Not Found' }, { status: 404 });
      c.body = body.body;
      return Response.json(c);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { api, github: new AppGitHub(APP_ID, KEY, fetchFn, true) };
}

const decision = (profile: string, extra: Partial<Decision> = {}): Decision => ({
  decision_id: crypto.randomUUID(), action: 'approvable', profile, profile_version: 3, rule: 2, facts: { ci: { missing: false } }, ...extra,
});

function fakeEngine(answer: (profile: string) => unknown) {
  let calls = 0;
  const api: EngineApi = {
    url: 'https://pointsman.example.org',
    fetch: async (_url, init) => {
      calls++;
      const sent = JSON.parse(String(init.body));
      const profile = decodeURIComponent(String(_url).split('/v1/decide/')[1]!);
      const out = answer(profile);
      return Response.json(out !== null && typeof out === 'object' && !Array.isArray(out) && !('ref' in out) ? { ...out, ref: sent.ref } : out);
    },
  };
  return { engine: httpEngine(api, `pm_${crypto.randomUUID()}`), calls: () => calls };
}

/** Each profile answers what `answers[profile]` gives (a fresh decision id on every call, as the engine does). */
function setup(s: ConnectorSettings = settings(), mem = memoryStorage(), gh = fakeApi()) {
  const answers: Record<string, () => unknown> = {
    'pr-risk': () => decision('pr-risk', { action: 'approvable', answers: { matches_title: { type: 'noul', value: true, p: 0.9, yes: 0.9 } } }),
    'pr-next-step': () => decision('pr-next-step', { action: 'review', rule: 7 }),
  };
  const pm = fakeEngine((p) => answers[p]!());
  const work = pullRequestWork(s, mem.storage, pm.engine, gh.github);
  const event = async () => { await work.accept({ target: { repo: REPO, number: 7 }, delivery: crypto.randomUUID(), digest: crypto.randomUUID() }, Date.now()); await work.run(); };
  return { work, mem, gh, api: gh.api, answers, pm, event };
}
const commentCalls = (log: string[]) => log.filter((l) => l.includes('comments'));

describe('decision comment', () => {
  it('is off by default: no comment is read or written, and the token does not ask to write pull requests for it', async () => {
    const { comment: _, ...off } = settings();
    const { api, event } = setup(off);
    await event();
    expect(commentCalls(api.log)).toEqual([]);
    expect(api.checkRuns).toHaveLength(2);
    expect(actsOnGitHub(off)).toBe(false);
    expect(actsOnGitHub(settings())).toBe(true);
  });

  it('writes one comment for all its profiles, then updates the same comment only when it changed', async () => {
    const { api, answers, event } = setup();
    await event();
    expect(commentCalls(api.log)).toEqual(['GET /issues/7/comments', 'POST /issues/7/comments']);
    expect(api.comments).toHaveLength(1);
    const first = api.comments[0]!.body;
    expect(first.startsWith(COMMENT_MARKER)).toBe(true);
    // Both profiles, in the order of "profiles", in one comment.
    expect(first.indexOf('`pr-risk`')).toBeLessThan(first.indexOf('`pr-next-step`'));
    expect(first).toContain('| `pr-next-step` | 🔴 needs a person | `review` | rule 8 |');
    expect(first).toContain('| `pr-risk` | 🟡 decided: approvable | `approvable` | rule 3 |');
    // A new run with the same decisions (new decision ids): no call about the comment at all.
    api.log.length = 0;
    await event();
    expect(commentCalls(api.log)).toEqual([]);
    // A changed decision: the same comment is updated, once, without looking for it again.
    answers['pr-next-step'] = () => decision('pr-next-step', { action: 'approve', rule: 9 });
    await event();
    expect(commentCalls(api.log)).toEqual([`PATCH /issues/comments/${api.comments[0]!.id}`]);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('| `pr-next-step` | 🟢 go | `approve` | rule 10 |');
  });

  it('finds only its own comment: a person\'s or another bot\'s comment with the marker is never edited', async () => {
    const gh = fakeApi();
    gh.api.comments.push(
      { id: 1, body: `${COMMENT_MARKER}\nfake by a person`, user: { login: 'mallory', type: 'User' } },
      { id: 2, body: `${COMMENT_MARKER}\nfake by another app`, user: { login: 'other-app[bot]', type: 'Bot' } },
      { id: 3, body: `${COMMENT_MARKER}\nsame name, not a bot`, user: { login: `${SLUG}[bot]`, type: 'User' } },
    );
    const { api, event } = setup(settings(), memoryStorage(), gh);
    await event();
    expect(api.comments.slice(0, 3).map((c) => c.body)).toEqual([`${COMMENT_MARKER}\nfake by a person`, `${COMMENT_MARKER}\nfake by another app`, `${COMMENT_MARKER}\nsame name, not a bot`]);
    expect(api.comments).toHaveLength(4);
    const own = api.comments[3]!;
    // Its storage lost (or a run stopped after the write, before the record): found again by marker and bot, updated, not doubled.
    own.body = `${COMMENT_MARKER}\nolder text`;
    const again = setup(settings(), memoryStorage(), gh);
    again.api.log.length = 0;
    await again.event();
    expect(commentCalls(again.api.log)).toEqual(['GET /issues/7/comments', `PATCH /issues/comments/${own.id}`]);
    expect(again.api.comments).toHaveLength(4);
    expect(own.body).toContain('`pr-next-step`');
  });

  it('a record left open (the run stopped while writing) is written again, also with the same text, without a second comment', async () => {
    const { api, mem, event } = setup();
    await event();
    const record = mem.data.get('comment') as any;
    mem.data.set('comment', { ...record, pending: record.hash, id: undefined });
    api.log.length = 0;
    await event();
    expect(commentCalls(api.log)).toEqual(['GET /issues/7/comments', `PATCH /issues/comments/${api.comments[0]!.id}`]);
    expect(api.comments).toHaveLength(1);
    expect((mem.data.get('comment') as any).pending).toBeUndefined();
  });

  it('a comment deleted on GitHub is written again', async () => {
    const { api, answers, event } = setup();
    await event();
    api.comments.length = 0;
    answers['pr-next-step'] = () => decision('pr-next-step', { action: 'wait', rule: 1 });
    await event();
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]!.body).toContain('🟡 waiting');
  });

  it('test decisions and invalid answers never change it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api, answers, event } = setup();
    await event();
    const before = api.comments[0]!.body;
    for (const bad of [
      () => ({ ...decision('pr-next-step', { action: 'approve' }), test: true }),
      () => ({ ...decision('pr-next-step', { action: 'approve' }), action: 'Not An Action' }),
      () => 'not a decision',
    ]) {
      answers['pr-next-step'] = bad;
      api.log.length = 0;
      await event();
      expect(commentCalls(api.log)).toEqual([]);
      expect(api.comments[0]!.body).toBe(before);
    }
    // Only test decisions on a new comment: none is written.
    const fresh = setup();
    fresh.answers['pr-risk'] = () => ({ ...decision('pr-risk'), test: true });
    fresh.answers['pr-next-step'] = () => ({ ...decision('pr-next-step'), test: true });
    await fresh.event();
    expect(commentCalls(fresh.api.log)).toEqual([]);
    errors.mockRestore();
  });

  it('a refused write shows on the check runs, does not stop the run, and is not tried again until the text changes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api, answers, event } = setup();
    api.fail = 403;
    await event();
    expect(api.comments).toHaveLength(0);
    expect(api.checkRuns).toHaveLength(2);
    for (const run of api.checkRuns) expect(run.output.summary).toContain('The decision comment could not be written (403)');
    expect(errors.mock.calls.join(' ')).toContain('decision comment');
    // Same text: not tried again.
    api.log.length = 0;
    await event();
    expect(commentCalls(api.log)).toEqual([]);
    // New text: tried again.
    api.fail = 0;
    answers['pr-next-step'] = () => decision('pr-next-step', { action: 'approve', rule: 9 });
    await event();
    expect(api.comments).toHaveLength(1);
    errors.mockRestore();
  });

  it('a rate limit leaves the write open: the next run tries again, also with the same text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api, event } = setup();
    api.fail = 429;
    await expect(event()).resolves.toBeUndefined();
    expect(api.checkRuns[0]!.output.summary).toContain('the next run tries again');
    api.fail = 0;
    await event();
    expect(api.comments).toHaveLength(1);
    errors.mockRestore();
  });

  it('a new head starts with its own decisions in the same comment', async () => {
    const { api, mem, event, work } = setup(settings({ runs: { 'pr-risk': { skipDrafts: true } } }));
    await event();
    api.pr.head = HEAD2;
    api.pr.draft = true;
    await event();
    expect(api.comments).toHaveLength(1);
    const body = api.comments[0]!.body;
    // pr-risk skipped the draft: its decision of the older head is not shown.
    expect(body).not.toContain('`pr-risk`');
    expect(body).toContain(`For commit ${HEAD2.slice(0, 7)}`);
    expect(body).toContain('▲ draft: work in progress');
    expect((mem.data.get('comment') as any).head).toBe(HEAD2);
    expect(work).toBeDefined();
  });

  it('never echoes text from the pull request, and cleans what the engine says', async () => {
    const { api, answers, event } = setup();
    api.pr.title = 'Fix @everyone <img src=x onerror=alert(1)> ``` | [link](https://evil.example)';
    api.pr.body = api.pr.title;
    answers['pr-risk'] = () => decision('pr-risk', {
      action: 'risky',
      facts: { ci: { missing: true, reason: '```\n</details><img src=x onerror=alert(1)> @everyone [x](https://evil.example) |' } },
      answers: {
        kind: { type: 'choice', value: '**bold** <b>x</b>', p: 0.5, probabilities: {} },
        'bad name <b>': { type: 'noul', value: true, p: 1, yes: 1 },
        level: { type: 'score', value: 2, p: 0.6, score: 2.1, probabilities: {} },
      },
    });
    await event();
    const body = api.comments[0]!.body;
    for (const bad of ['@everyone', '<img', '</details><', 'evil.example', '**bold**', '<b>', 'bad name']) expect(body).not.toContain(bad);
    // Code fences only where the connector puts them.
    expect(body.split('```').length - 1).toBe(2 * 3);
    expect(body).toContain('kind: ?');
    expect(body).toContain('level: level 2');
    expect(body).toContain('✕ 1 of 1 missing:');
    expect(body).toContain('ci (');
    // The check run's details are cleaned the same way.
    const run = api.checkRuns.find((r) => r.name === 'Pointsman: pr-risk')!;
    expect(run.output.text).not.toContain('<img');
    expect(run.output.text!.split('```').length - 1).toBe(4);
  });

  it('the line shows the train at the app\'s own approval of this commit', async () => {
    const gh = fakeApi();
    // The approval (a review) is faked on the client: this test is about the line.
    const reviews: number[] = [];
    const client = gh.github as unknown as Record<string, unknown>;
    client.approve = async () => (reviews.push(77), 77);
    client.ownApprovals = async () => reviews.map((id) => ({ id, commit: HEAD, marker: '' }));
    const { api, answers, event } = setup(settings({ actions: { 'pr-next-step': { approve: { do: 'approve' } } } }), memoryStorage(), gh);
    answers['pr-next-step'] = () => decision('pr-next-step', { action: 'approve', rule: 0 });
    await event();
    expect(reviews).toHaveLength(1);
    expect(api.comments[0]!.body).toContain(lineArt('approved'));
  });
});

describe('decision comment and approvals', () => {
  it('an approval withdrawn for a test decision or an invalid answer: that profile\'s row goes, and the train moves back', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of [() => ({ ...decision('pr-next-step', { action: 'approve' }), test: true }), () => 'not a decision']) {
      const gh = fakeApi();
      const reviews: number[] = [];
      const client = gh.github as unknown as Record<string, unknown>;
      client.approve = async () => (reviews.push(77), 77);
      client.ownApprovals = async () => reviews.map((id) => ({ id, commit: HEAD, marker: '' }));
      client.dismissReview = async () => void reviews.pop();
      const { api, answers, event } = setup(settings({ actions: { 'pr-next-step': { approve: { do: 'approve' } } } }), memoryStorage(), gh);
      answers['pr-next-step'] = () => decision('pr-next-step', { action: 'approve', rule: 0 });
      await event();
      expect(api.comments[0]!.body).toContain('| `pr-next-step` | 🟢 go | `approve` |');
      answers['pr-next-step'] = bad;
      await event();
      expect(reviews).toEqual([]);
      const body = api.comments[0]!.body;
      expect(body).not.toContain('`pr-next-step`');
      expect(body).toContain('▲ ready for review');
      expect(body).toContain('`pr-risk`');
    }
    errors.mockRestore();
  });
});

describe('decision comment with nothing to show', () => {
  it('an existing comment is updated to a neutral text, never left stale; without one, none is written', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Its only profile's approval is withdrawn (a test decision): no row is left.
    const gh = fakeApi();
    const reviews: number[] = [];
    const client = gh.github as unknown as Record<string, unknown>;
    client.approve = async () => (reviews.push(77), 77);
    client.ownApprovals = async () => reviews.map((id) => ({ id, commit: HEAD, marker: '' }));
    client.dismissReview = async () => void reviews.pop();
    const s = settings({ comment: { profiles: ['pr-next-step'] }, actions: { 'pr-next-step': { approve: { do: 'approve' } } } });
    const { api, answers, event } = setup(s, memoryStorage(), gh);
    answers['pr-next-step'] = () => decision('pr-next-step', { action: 'approve', rule: 0 });
    await event();
    expect(api.comments[0]!.body).toContain(lineArt('approved'));
    answers['pr-next-step'] = () => ({ ...decision('pr-next-step', { action: 'approve' }), test: true });
    await event();
    expect(api.comments).toHaveLength(1);
    let body = api.comments[0]!.body;
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain(`No decision to show for commit ${HEAD.slice(0, 7)}`);
    expect(body).not.toContain('`pr-next-step`');
    expect(body).toContain('▲ ready for review');
    // Unchanged on the next run: no call.
    api.log.length = 0;
    await event();
    expect(commentCalls(api.log)).toEqual([]);
    // A new head on which every shown profile skips the draft: the older head's decisions are not left standing.
    const draft = setup(settings({ comment: { profiles: ['pr-risk'] }, runs: { 'pr-risk': { skipDrafts: true } } }));
    await draft.event();
    expect(draft.api.comments[0]!.body).toContain('`pr-risk`');
    draft.api.pr.head = HEAD2;
    draft.api.pr.draft = true;
    await draft.event();
    body = draft.api.comments[0]!.body;
    expect(draft.api.comments).toHaveLength(1);
    expect(body).toContain(`No decision to show for commit ${HEAD2.slice(0, 7)}`);
    expect(body).toContain('▲ draft: work in progress');
    // No comment yet and nothing to show: none is written.
    const none = setup(settings({ comment: { profiles: ['pr-risk'] }, runs: { 'pr-risk': { skipDrafts: true } } }));
    none.api.pr.draft = true;
    await none.event();
    expect(commentCalls(none.api.log)).toEqual([]);
    errors.mockRestore();
  });
});

describe('signals and the check run', () => {
  it('maps actions to signals: the deployment\'s table, then defaults, then yellow "decided: <action>"; a pending review is red', () => {
    const table = { 'pr-risk': { approvable: { signal: 'green' as const }, risky: { signal: 'red' as const, text: 'look at the code' } } };
    expect(signalOf(table, decision('pr-risk', { action: 'approvable' }))).toEqual({ colour: 'green', text: 'go' });
    expect(signalOf(table, decision('pr-risk', { action: 'risky' }))).toEqual({ colour: 'red', text: 'look at the code' });
    expect(signalOf(table, decision('pr-next-step', { action: 'review' }))).toEqual({ colour: 'red', text: 'needs a person' });
    expect(signalOf(table, decision('pr-next-step', { action: 'wait' }))).toEqual({ colour: 'yellow', text: 'waiting' });
    expect(signalOf(table, decision('pr-next-step', { action: 'pass' }))).toEqual({ colour: 'green', text: 'go' });
    expect(signalOf(table, decision('pr-next-step', { action: 'split-it' }))).toEqual({ colour: 'yellow', text: 'decided: split-it' });
    expect(signalOf(undefined, decision('pr-risk', { action: 'toString' as string }))).toEqual({ colour: 'yellow', text: 'decided: toString' });
    expect(signalOf(table, decision('pr-risk', { action: 'approvable', review: { status: 'pending' } }))).toEqual({ colour: 'red', text: 'a person checks first' });
  });

  it('titles the check run with the signal and the action; the line and the switch are its details', () => {
    const d = decision('pr-next-step', { action: 'approve', rule: 3, facts: { ci: { missing: false }, reviews: { missing: true, reason: 'timeout' } } });
    const out = checkOutput(d, { kind: 'done', text: 'approved this commit' }, { head: HEAD, station: 'approved' });
    expect(out.title).toBe('🟢 approve');
    expect(checkOutput(d).title).toBe('🟢 approve (shadow)');
    expect(checkOutput({ ...d, review: { status: 'pending' } }).title).toBe('🔴 approve: a person checks first (shadow)');
    expect(checkOutput(d).text).toBeUndefined();
    expect(out.text).toContain(lineArt('approved'));
    expect(out.text).toContain(switchArt(d, HEAD));
    expect(out.text).toContain('✕ 1 of 2 missing: reviews (timeout)');
    expect(out.text).toContain('┡━━━┿━━━┿━━━ approve  ← rule 4');
  });

  it('renders the comment as documented', () => {
    const body = commentBody([
      decision('pr-risk', { action: 'approvable', rule: 2, facts: { ci: { missing: false } }, answers: { matches_title: { type: 'noul', value: true } } }),
      decision('pr-next-step', { action: 'review', rule: 7, facts: { ci: { missing: false }, coderabbit: { missing: false } } }),
    ], { 'pr-risk': { approvable: { signal: 'green', text: 'low risk' } } }, HEAD, 'ready');
    expect(body).toMatchInlineSnapshot(`
      "<!-- pointsman decision-comment -->
      ### 🚦 Pointsman

      | Profile | Signal | Decision | Set by |
      | --- | --- | --- | --- |
      | \`pr-risk\` | 🟢 low risk | \`approvable\` | rule 3 |
      | \`pr-next-step\` | 🔴 needs a person | \`review\` | rule 8 |

      \`\`\`text
       draft       ready      reviewed    approved     merged
      ━━━○━━━┿━━━┿━━━●━━━┿━━━┿━━━○━━━┿━━━┿━━━○━━━┿━━━┿━━━○━━━
                     ▲ ready for review
      \`\`\`

      <details><summary><code>pr-risk</code>: why <code>approvable</code></summary>

      \`\`\`text
      pr-risk @ aaaaaaa
      ┃ facts  ✓ 1 read
      ┃ AI     matches_title: yes
      ┃
      ┡━━━┿━━━┿━━━ approvable  ← rule 3
      │
      └───┼───┼─── later rules and the default: not taken
      \`\`\`

      </details>

      <details><summary><code>pr-next-step</code>: why <code>review</code></summary>

      \`\`\`text
      pr-next-step @ aaaaaaa
      ┃ facts  ✓ 2 read
      ┃ AI     – none asked
      ┃
      ┡━━━┿━━━┿━━━ review  ← rule 8
      │
      └───┼───┼─── later rules and the default: not taken
      \`\`\`

      </details>

      <sub>For commit aaaaaaa. One comment, updated when a decision changes; the check runs \`Pointsman: <profile>\` have the decision ids.</sub>"
    `);
  });
});

describe('the art lines up', () => {
  // Box Drawing and Geometric Shapes: the only characters a rail is made of.
  const BOX = /^[\u2500-\u257F\u25A0-\u25FF]$/u;
  /** The rail a line starts with: its box characters up to the first other one (none: a line of text). */
  const railOf = (line: string) => {
    const rail: string[] = [];
    for (const ch of line) {
      if (!BOX.test(ch)) break;
      rail.push(ch);
    }
    return rail;
  };
  /** Each rail line: only box characters up to its end, then nothing or a space and its text, with no box character in that text. */
  const expectRails = (art: string) => {
    for (const line of art.split('\n')) {
      expect(columns(line), line).toBeLessThanOrEqual(MAX_COLUMNS);
      expect([...line].length, line).toBeLessThanOrEqual(MAX_COLUMNS);
      const rail = railOf(line);
      const text = [...line].slice(rail.length).join('');
      if (rail.length > 0) expect(text === '' || text.startsWith(' '), line).toBe(true);
      expect([...text].some((ch) => BOX.test(ch) && ch !== '▲'), line).toBe(false);
    }
  };
  const sleepers = (rail: string[]) => rail.flatMap((ch, i) => ('┿┼'.includes(ch) ? [i] : []));

  const LABELS = { short: 'a', long: 'x'.repeat(64), cjk: '低リスク承認', odd: '```<b>@everyone|\n`' + '\t~~~' };
  const decisionsFor = (l: string) => [2, null, 999].flatMap((rule) => [false, true].map((pending) => decision(l, {
    action: l, rule,
    facts: { ci: { missing: false }, [l]: { missing: true, reason: l }, ['f'.repeat(64)]: { missing: true, reason: `${l} ${l}` } },
    answers: { q: { type: 'choice', value: l }, ['q'.repeat(64)]: { type: 'noul', value: true } },
    ...(pending && { review: { status: 'pending' } }),
  })));

  it('the line: station names centred over their stations, the train under its station, for every station', () => {
    const at = 'approved' as const;
    const [names, rail, train] = lineArt(at).split('\n') as [string, string, string];
    expect(railOf(rail)).toHaveLength([...rail].length);
    const stations = [...rail].flatMap((ch, i) => ('○●'.includes(ch) ? [i] : []));
    expect(stations).toHaveLength(STATIONS.length);
    STATIONS.forEach((s, i) => {
      const start = names.indexOf(s);
      expect(start + Math.floor((s.length - 1) / 2), s).toBe(stations[i]);
    });
    for (const station of [...STATIONS, undefined]) {
      const art = lineArt(station);
      expectRails(art);
      const lines = art.split('\n');
      expect(lines[0]).toBe(names);
      expect([...lines[1]!].flatMap((ch, i) => ('○●'.includes(ch) ? [i] : []))).toEqual(stations);
      if (!station) {
        expect(lines).toHaveLength(2);
        expect(lines[1]).not.toContain('●');
        continue;
      }
      const filled = [...lines[1]!].indexOf('●');
      expect(filled).toBe(stations[STATIONS.indexOf(station)]);
      expect([...lines[2]!].indexOf('▲')).toBe(filled);
      expect(lines[2]!.slice(0, filled).trim()).toBe('');
    }
    expect(train).toBe(`${' '.repeat(stations[3]!)}▲`);
  });

  it('the switch: the same junction and sleeper columns for short, long, Japanese and odd names, no line wider than 60', () => {
    const reference = switchArt(decision('a'), HEAD).split('\n').map(railOf).filter((r) => r.length > 1);
    expect(reference.map((r) => r.length)).toEqual([12, 12]);
    for (const [kind, l] of Object.entries(LABELS)) {
      for (const d of decisionsFor(l)) {
        const art = switchArt(d, HEAD);
        expectRails(art);
        const lines = art.split('\n');
        const rails = lines.map(railOf);
        // The legs of the points: both start at column 0, as long, with sleepers at the same columns.
        const legs = rails.filter((r) => r.length > 1);
        expect(legs.map((r) => r.length), kind).toEqual([12, 12]);
        expect(legs.map(sleepers), kind).toEqual(reference.map(sleepers));
        expect(legs.map((r) => r[0]), kind).toEqual(d.rule === null ? ['┠', '┗'] : ['┡', '└']);
        // Every line but the first (the profile) and the last of a pending review starts on the track, at column 0.
        const track = lines.slice(1, d.review ? -1 : undefined);
        for (const line of track) expect(BOX.test([...line][0]!) || line.trimStart().startsWith('← '), line).toBe(true);
        if (d.review) expect(lines.at(-1)).toBe('a person checks this decision before it counts');
      }
    }
  });

  it('long and odd names are cut or stacked, never let out of the code block', () => {
    for (const l of Object.values(LABELS)) {
      for (const d of decisionsFor(l)) {
        const text = checkText(d, HEAD, 'approved');
        expect(text.split('```').length - 1).toBe(4);
        const inside = text.split('\n').filter((line) => !line.startsWith('```'));
        for (const line of inside) {
          expect(line).not.toMatch(/[`<>|\t~]|@everyone/);
          expect(columns(line), line).toBeLessThanOrEqual(MAX_COLUMNS);
        }
      }
    }
    const long = switchArt(decision('pr-risk', { action: 'a'.repeat(64), rule: 11 }), HEAD).split('\n');
    expect(long).toContain(`┡━━━┿━━━┿━━━ ${'a'.repeat(46)}…`);
    expect(long).toContain('│            ← rule 12');
    const many = switchArt(decision('pr-risk', { facts: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`fact${i}`, { missing: true, reason: 'timeout' }])) }), HEAD);
    expect(many).toContain('┃ facts  ✕ 12 of 12 missing:\n┃        fact0 (timeout)\n');
    expect(many).toContain('┃        +4 more');
  });

  it('counts columns as a monospace font draws them', () => {
    expect(columns('approvable')).toBe(10);
    expect(columns('低リスク')).toBe(8);
    expect(columns('━┿●○▲')).toBe(5);
  });
});

describe('settings', () => {
  const env = (connector: Record<string, unknown>) => ({
    GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: KEY, GITHUB_WEBHOOK_SECRET: SECRET, POINTSMAN_URL: 'https://pointsman.example.org', POINTSMAN_TOKEN: 'pm_x',
    GITHUB_CONNECTOR: JSON.stringify({ repos: ['example/repo'], profiles: ['pr-risk', 'pr-next-step'], ...connector }),
  });

  it('reads "comment" and "signals", and refuses wrong ones', () => {
    const s = connectorSettings(env({
      comment: { profiles: ['pr-next-step', 'pr-risk'] },
      signals: { 'pr-risk': { approvable: 'green', risky: { signal: 'red', text: 'look at the code' } } },
    }))!;
    expect(s.comment).toEqual({ profiles: ['pr-risk', 'pr-next-step'] });
    expect(s.signals).toEqual({ 'pr-risk': { approvable: { signal: 'green' }, risky: { signal: 'red', text: 'look at the code' } } });
    const off = connectorSettings(env({}))!;
    expect(off.comment).toBeUndefined();
    expect(off.signals).toBeUndefined();
    for (const [bad, message] of [
      [{ comment: { profiles: [] } }, /comment.profiles/],
      [{ comment: { profiles: ['other'] } }, /comment.profiles/],
      [{ comment: true }, /"comment" must be an object/],
      [{ comment: { profiles: ['pr-risk'], every: true } }, /unknown key every/],
      [{ signals: { other: {} } }, /signals.other: not in "profiles"/],
      [{ signals: { 'pr-risk': { approvable: 'blue' } } }, /red, yellow or green/],
      [{ signals: { 'pr-risk': { 'Not An Action': 'red' } } }, /not an action name/],
      [{ signals: { 'pr-risk': { approvable: { signal: 'green', text: '<b>go</b>' } } } }, /text must be/],
      [{ signals: { 'pr-risk': { approvable: { signal: 'green', text: '[go](https://x.example)' } } } }, /text must be/],
      [{ signals: { 'pr-risk': { approvable: { signal: 'green', text: 'x'.repeat(41) } } } }, /text must be/],
      [{ signals: { 'pr-risk': { approvable: { signal: 'green', text: 'see https.x.example/a' } } } }, /text must be/],
      [{ signals: { 'pr-risk': { approvable: { signal: 'green', text: 'go :tada:' } } } }, /text must be/],
      [{ signals: { 'pr-risk': { approvable: { signal: 'green', colour: 'x' } } } }, /unknown key colour/],
    ] as const) {
      expect(() => connectorSettings(env(bad as Record<string, unknown>)), JSON.stringify(bad)).toThrow(message);
    }
    expect(connectorSettings(env({ signals: { 'pr-risk': { approvable: { signal: 'green', text: '低リスク' } } } }))!.signals!['pr-risk']!.approvable!.text).toBe('低リスク');
  });
});
