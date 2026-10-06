// Review queue and callbacks, with the real D1 decision log.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, retryDueCallbacks, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { MAX_ATTEMPTS, sign, type Fetch } from '../../src/callbacks';
import { D1DecisionLog } from '../../src/log';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import * as contract from '../../generated/openapi-validators.mjs';

const DB = (env as unknown as { DB: D1Database }).DB;
const SECRET = 'test-callback-secret';
// issue-triage with a threshold the mock (team.p 0.9) never reaches: every
// decision becomes a review.
const triage = (bundled as Profile[]).find((p) => p.id === 'issue-triage')!;
const reviewing: Profile = { ...triage, policy: { rules: [{ when: 'team.p >= 0.95', action: 'auto' }], default: 'review' } };
const autoProfile: Profile = { ...triage, id: 'auto-triage', policy: { default: 'auto' } };

const ALL = newToken();
const OTHER = newToken();

type Sent = { url: string; headers: Record<string, string>; body: string };

function setup({ noSecret = false, status = 200 } = {}) {
  const secret = noSecret ? undefined : SECRET;
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    if (status === 0) throw new Error('connection refused');
    return new Response('', { status });
  };
  const tokens = new MemoryTokenStore();
  const deps: Deps = {
    store: new MemoryProfileStore([reviewing, autoProfile]),
    tokens,
    log: new D1DecisionLog(DB),
    adapterFor: () => new MockAdapter(),
    callbacks: { secret, fetch },
  };
  const app = createApp(() => deps);
  const call = async (method: string, path: string, body?: unknown, token = ALL) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }, env);
    return { status: res.status, data: res.status === 204 ? null : await res.json<any>() };
  };
  return { deps, call, sent, tokens };
}

async function addTokens(tokens: MemoryTokenStore) {
  tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
  tokens.records.set(await hashToken(OTHER), { client: 'other', profiles: ['auto-triage'], created_at: '' });
}

const issue = { issue: { title: 'Login page is blank', body: 'Since this morning.' } };

async function newReview(call: ReturnType<typeof setup>['call'], extra: Record<string, unknown> = {}) {
  const { status, data } = await call('POST', '/v1/decide/issue-triage', { state: issue, ref: 'example:7', ...extra });
  expect(status).toBe(200);
  expect(data.action).toBe('review');
  return data.decision_id as string;
}

const resolveBody = { action: 'auto', correct: { team: 'frontend' }, by: 'reviewer@example.com', note: 'login is frontend' };

describe('review queue', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await addTokens(s.tokens);
  });

  it('lists pending reviews, not other decisions', async () => {
    const id = await newReview(s.call);
    await s.call('POST', '/v1/decide/auto-triage', { state: issue });
    const { status, data } = await s.call('GET', '/v1/reviews');
    expect(status).toBe(200);
    expect(contract.reviewList(data), JSON.stringify(contract.reviewList.errors)).toBe(true);
    // D1 is shared by the tests of this file, so look for this review only.
    const mine = data.reviews.filter((r: any) => r.decision_id === id);
    expect(mine).toHaveLength(1);
    expect(data.reviews.every((r: any) => r.action === 'review' && r.review.status === 'pending')).toBe(true);
    expect(mine[0]).toMatchObject({ profile: 'issue-triage', ref: 'example:7', review: { status: 'pending' } });
    expect(mine[0].callback_url).toBeUndefined();
  });

  it('filters by profile and by token scope', async () => {
    await newReview(s.call);
    // auto-triage never has reviews; OTHER may only see auto-triage.
    expect((await s.call('GET', '/v1/reviews?profile=auto-triage')).data.reviews).toEqual([]);
    expect((await s.call('GET', '/v1/reviews', undefined, OTHER)).data.reviews).toEqual([]);
    const own = (await s.call('GET', '/v1/reviews?profile=issue-triage')).data.reviews;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r: any) => r.profile === 'issue-triage')).toBe(true);
    const res = await s.call('GET', '/v1/reviews?profile=issue-triage', undefined, OTHER);
    expect(res.status).toBe(403);
  });

  it('resolves a review: final answers, feedback, removed from the queue', async () => {
    const id = await newReview(s.call);
    const { status, data } = await s.call('POST', `/v1/reviews/${id}/resolve`, resolveBody);
    expect(status).toBe(200);
    expect(contract.resolution(data), JSON.stringify(contract.resolution.errors)).toBe(true);
    expect(data).toMatchObject({ decision_id: id, action: 'auto', resolved_by: 'reviewer@example.com', callback: 'none' });
    expect(data.answers).toEqual({
      team: { value: 'frontend', source: 'human' },
      urgent: { value: false, source: 'model' },
      effort: { value: 0, source: 'model' },
    });

    const record = (await s.call('GET', `/v1/decisions/${id}`)).data;
    expect(contract.decisionRecord(record), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
    expect(record.action).toBe('review');
    expect(record.review).toMatchObject({ status: 'resolved', final_action: 'auto', resolved_by: 'reviewer@example.com' });
    expect(record.feedback).toEqual([expect.objectContaining({ by: 'reviewer@example.com', correct: { team: 'frontend' }, note: 'login is frontend' })]);
    expect(record.callback).toBeUndefined();
    const ids = (await s.call('GET', '/v1/reviews')).data.reviews.map((r: any) => r.decision_id);
    expect(ids).not.toContain(id);
  });

  it('keeps the model answers and writes no feedback when nothing is corrected', async () => {
    const id = await newReview(s.call);
    const { data } = await s.call('POST', `/v1/reviews/${id}/resolve`, { action: 'close', by: 'x' });
    expect(data.answers.team).toEqual({ value: 'backend', source: 'model' });
    expect((await s.call('GET', `/v1/decisions/${id}`)).data.feedback).toEqual([]);
  });

  it('answers 409 for a second resolve and for a decision without review', async () => {
    const id = await newReview(s.call);
    expect((await s.call('POST', `/v1/reviews/${id}/resolve`, resolveBody)).status).toBe(200);
    const again = await s.call('POST', `/v1/reviews/${id}/resolve`, { ...resolveBody, by: 'second' });
    expect(again.status).toBe(409);
    expect(again.data.error.code).toBe('not_pending');
    expect((await s.call('GET', `/v1/decisions/${id}`)).data.feedback).toHaveLength(1);

    const auto = (await s.call('POST', '/v1/decide/auto-triage', { state: issue })).data.decision_id;
    expect((await s.call('POST', `/v1/reviews/${auto}/resolve`, resolveBody)).status).toBe(409);
  });

  it('a resolve that loses the race writes no feedback', async () => {
    const id = await newReview(s.call);
    const log = new D1DecisionLog(DB);
    const r = { resolved_at: '2026-10-06T00:00:00Z', resolved_by: 'a', client: 'c', final_action: 'auto', final_answers: {}, correct: { team: 'docs' } };
    expect(await log.resolve(id, r)).toBe(true);
    expect(await log.resolve(id, { ...r, resolved_by: 'b', correct: { team: 'backend' } })).toBe(false);
    const record = await log.get(id);
    expect(record?.feedback.map((f) => f.by)).toEqual(['a']);
  });

  it('answers 404 for unknown decisions and decisions out of scope', async () => {
    expect((await s.call('POST', '/v1/reviews/00000000-0000-4000-8000-000000000000/resolve', resolveBody)).status).toBe(404);
    const id = await newReview(s.call);
    expect((await s.call('POST', `/v1/reviews/${id}/resolve`, resolveBody, OTHER)).status).toBe(404);
  });

  it.each([
    ['invalid JSON', '{'],
    ['action review', { ...resolveBody, action: 'review' }],
    ['no action', { by: 'x' }],
    ['an upper-case action', { ...resolveBody, action: 'Auto' }],
    ['no by', { action: 'auto' }],
    ['an unknown field', { ...resolveBody, extra: 1 }],
    ['an unknown option', { ...resolveBody, correct: { team: 'ops' } }],
    ['a correct that is not an object', { ...resolveBody, correct: ['team'] }],
  ])('rejects %s with 400 and leaves the review pending', async (_, body) => {
    const id = await newReview(s.call);
    const res = await s.call('POST', `/v1/reviews/${id}/resolve`, body);
    expect(res.status).toBe(400);
    expect(contract.error(res.data)).toBe(true);
    expect((await s.call('GET', `/v1/decisions/${id}`)).data.review.status).toBe('pending');
  });
});

describe('callbacks', () => {
  it('sends the final answer, signed, and records the delivery', async () => {
    const s = setup();
    await addTokens(s.tokens);
    const id = await newReview(s.call, { callback_url: 'https://client.example/hook' });
    const { data } = await s.call('POST', `/v1/reviews/${id}/resolve`, resolveBody);
    expect(data.callback).toBe('pending');

    expect(s.sent).toHaveLength(1);
    const { url, headers, body } = s.sent[0]!;
    expect(url).toBe('https://client.example/hook');
    const ts = Number(headers['x-pointsman-timestamp']);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(60);
    expect(headers['x-pointsman-signature']).toBe(`sha256=${await sign(SECRET, ts, body)}`);
    expect(JSON.parse(body)).toEqual({
      decision_id: id,
      ref: 'example:7',
      profile: 'issue-triage',
      profile_version: 1,
      action: 'auto',
      answers: data.answers,
      resolved_by: 'reviewer@example.com',
      resolved_at: data.resolved_at,
    });

    const record = (await s.call('GET', `/v1/decisions/${id}`)).data;
    expect(contract.decisionRecord(record), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
    expect(record.callback).toEqual({ status: 'delivered', attempts: 1 });
    expect(record.callback_url).toBeUndefined();
  });

  it('retries failed deliveries on schedule, then gives up', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ status: 503 });
    await addTokens(s.tokens);
    const id = await newReview(s.call, { callback_url: 'https://client.example/hook' });
    await s.call('POST', `/v1/reviews/${id}/resolve`, resolveBody);

    let record = (await s.call('GET', `/v1/decisions/${id}`)).data;
    expect(record.callback).toMatchObject({ status: 'pending', attempts: 1, last_error: 'HTTP 503' });

    // Not due yet: nothing happens.
    expect(await retryDueCallbacks(s.deps, new Date())).toBe(0);

    // Run the schedule far enough ahead each time until it gives up.
    let at = Date.now();
    for (let n = 2; n <= MAX_ATTEMPTS; n++) {
      at += 13 * 3600 * 1000;
      expect(await retryDueCallbacks(s.deps, new Date(at))).toBe(1);
    }
    record = (await s.call('GET', `/v1/decisions/${id}`)).data;
    expect(record.callback).toEqual({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: 'HTTP 503' });
    expect(s.sent).toHaveLength(MAX_ATTEMPTS);
    expect(await retryDueCallbacks(s.deps, new Date(at + 13 * 3600 * 1000))).toBe(0);
    quiet.mockRestore();
  });

  it('records a connection error and delivers on a later retry', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = setup({ status: 0 });
    await addTokens(failing.tokens);
    const id = await newReview(failing.call, { callback_url: 'https://client.example/hook' });
    await failing.call('POST', `/v1/reviews/${id}/resolve`, resolveBody);
    expect((await failing.call('GET', `/v1/decisions/${id}`)).data.callback.last_error).toBe('connection refused');

    const working = setup();
    expect(await retryDueCallbacks(working.deps, new Date(Date.now() + 120_000))).toBe(1);
    expect(working.sent).toHaveLength(1);
    expect((await failing.call('GET', `/v1/decisions/${id}`)).data.callback).toEqual({ status: 'delivered', attempts: 2 });
    quiet.mockRestore();
  });

  it('never sends unsigned callbacks', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ noSecret: true });
    await addTokens(s.tokens);
    const id = await newReview(s.call, { callback_url: 'https://client.example/hook' });
    await s.call('POST', `/v1/reviews/${id}/resolve`, resolveBody);
    expect(s.sent).toHaveLength(0);
    expect((await s.call('GET', `/v1/decisions/${id}`)).data.callback)
      .toMatchObject({ status: 'pending', attempts: 1, last_error: 'CALLBACK_SECRET is not set' });
    quiet.mockRestore();
  });
});
