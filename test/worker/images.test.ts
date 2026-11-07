// Images for the model (src/images.ts): read from the request, checked, sent
// to the model beside the state, kept out of the gateway's log, never stored.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { noCallbacks } from './helpers';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { MAX_IMAGE_BYTES, readImages } from '../../src/images';
import { D1DecisionLog } from '../../src/log-d1';
import { toModelRequest } from '../../src/models/adapter';
import { MockAdapter } from '../../src/models/mock';
import { WorkersAiAdapter, type AiRunner } from '../../src/models/workers-ai';
import { ModelServerAdapter } from '../../src/models/http';
import { explainProfile, explanationText } from '../../src/explain';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';

const bytes = (...b: number[]) => String.fromCharCode(...b);
const dataUrl = (type: string, raw: string) => `data:${type};base64,${btoa(raw)}`;
const PNG = dataUrl('image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + 'rest of a png');
const JPEG = dataUrl('image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0) + 'rest of a jpeg');
const WEBP = dataUrl('image/webp', 'RIFF' + bytes(0, 0, 0, 0) + 'WEBPVP8 rest');

const profile: Profile = {
  id: 'concern', version: 1, title: { en: 'C', ja: 'C' }, description: { en: 'C', ja: 'C' }, model: 'clef-flash',
  input: [{ name: 'description', path: '$.description.value' }],
  images: { path: '$.photos.value', max: 3 },
  questions: [{ name: 'danger_now', type: 'noul', instructions: 'Could people be hurt now?' }],
  policy: { rules: [{ when: 'danger_now.yes >= 0.5', action: 'now' }], default: 'low' },
};

describe('readImages', () => {
  it('reads one image or a list, and no path or an empty list as none', () => {
    expect(readImages(profile, { photos: { value: PNG } })).toEqual({ ok: true, images: [PNG] });
    expect(readImages(profile, { photos: { value: [PNG, JPEG, WEBP] } })).toEqual({ ok: true, images: [PNG, JPEG, WEBP] });
    expect(readImages(profile, { description: { value: 'x' } })).toEqual({ ok: true, images: [] });
    expect(readImages(profile, { photos: { value: [] } })).toEqual({ ok: true, images: [] });
    const { images: _, ...noImages } = profile;
    expect(readImages(noImages, { photos: { value: ['not checked'] } })).toEqual({ ok: true, images: [] });
  });

  it('refuses more than max, other kinds, wrong data, and too large images; the message names only the place', () => {
    const bad = (value: unknown) => readImages(profile, { photos: { value } });
    expect(bad([PNG, PNG, PNG, PNG])).toEqual({ ok: false, message: 'at most 3 images' });
    for (const v of ['https://example.com/a.png', 'data:image/gif;base64,R0lGODlh', `data:image/png;base64,${btoa('not a png at all')}`, 'data:image/png;base64,abc', 42, { url: PNG }]) {
      const r = bad([PNG, v]);
      expect(r.ok, String(v)).toBe(false);
      expect((r as { message: string }).message).toMatch(/^image 2: /);
    }
    // A JPEG sent as PNG: the first bytes decide, not the label.
    expect(bad(JPEG.replace('image/jpeg', 'image/png'))).toEqual({ ok: false, message: 'image 1: the data is not a image/png image' });
    const big = dataUrl('image/jpeg', bytes(0xff, 0xd8, 0xff) + 'x'.repeat(MAX_IMAGE_BYTES));
    expect(bad(big)).toEqual({ ok: false, message: 'image 1: at most 4 MiB' });
    const three = dataUrl('image/jpeg', bytes(0xff, 0xd8, 0xff) + 'x'.repeat(3 * 1024 * 1024));
    expect(bad([three, three, three])).toEqual({ ok: false, message: 'at most 8 MiB of images together' });
  });
});

describe('the model request', () => {
  it('has images only when there are any', () => {
    expect(toModelRequest(profile, { description: 'x' })).not.toHaveProperty('images');
    expect(toModelRequest(profile, { description: 'x' }, 'clef', [PNG]).images).toEqual([PNG]);
  });

  it('goes through the gateway without its log when it has images', async () => {
    const calls: unknown[] = [];
    const ai: AiRunner = { run: async (_m, _i, options) => { calls.push(options); return { answers: {} }; } };
    const adapter = new WorkersAiAdapter(ai, 'pointsman');
    await adapter.decide(toModelRequest(profile, { description: 'x' }, 'clef-flash'));
    await adapter.decide(toModelRequest(profile, { description: 'x' }, 'clef-flash', [PNG]));
    expect(calls).toEqual([
      { gateway: { id: 'pointsman', requestTimeoutMs: 10000 } },
      { gateway: { id: 'pointsman', requestTimeoutMs: 10000, collectLog: false } },
    ]);
  });
});

describe('a decision with images, end to end', () => {
  const TOKEN = newToken();
  const tokens = new MemoryTokenStore();
  const headers = { authorization: `Bearer ${TOKEN}` };

  async function decide(state: unknown) {
    tokens.records.set(await hashToken(TOKEN), { client: 'test', profiles: ['*'], created_at: '' });
    const model = new MockAdapter();
    const asked = vi.spyOn(model, 'decide');
    const deps: Deps = { callbacks: noCallbacks, store: new MemoryProfileStore([profile]), tokens, log: new D1DecisionLog(env.DB), adapterFor: () => model };
    const app = createApp(() => deps);
    const res = await app.request('/v1/decide/concern', { method: 'POST', headers, body: JSON.stringify({ state }) }, env);
    const body = await res.json<any>();
    const logged = res.status === 200 ? await (await app.request(`/v1/decisions/${body.decision_id}`, { headers }, env)).json<any>() : null;
    return { status: res.status, body, logged, asked };
  }

  it('sends the images beside the mapped state, and logs a hash that covers them, never the images', async () => {
    const one = await decide({ description: { value: 'A diagonal crack from the window corner.' }, photos: { value: [PNG, JPEG] } });
    expect(one.status).toBe(200);
    expect(one.asked).toHaveBeenCalledWith({
      model: 'clef-flash',
      state: { description: 'A diagonal crack from the window corner.' },
      questions: { danger_now: { type: 'noul', instructions: 'Could people be hurt now?' } },
      images: [PNG, JPEG],
    });
    expect(JSON.stringify(one.logged)).not.toContain('base64');
    const other = await decide({ description: { value: 'A diagonal crack from the window corner.' }, photos: { value: [PNG] } });
    expect(other.logged.state_hash).not.toBe(one.logged.state_hash);
    const none = await decide({ description: { value: 'A diagonal crack from the window corner.' } });
    expect(none.asked.mock.calls[0]![0]).not.toHaveProperty('images');
  });

  it('refuses a bad image before any model call', async () => {
    const r = await decide({ description: { value: 'x' }, photos: { value: ['https://example.com/a.png'] } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: 'invalid_request', message: 'image 1: must be a base64 data URL of a PNG, JPEG or WebP image' } });
    expect(r.asked).not.toHaveBeenCalled();
  });
});

describe('more about images', () => {
  it('a model server gets the images in the same field', async () => {
    const bodies: unknown[] = [];
    const adapter = new ModelServerAdapter({ url: 'http://127.0.0.1:8794', models: { local: 'local' }, timeoutMs: 10_000,
      fetch: async (_u, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ model: 'local', answers: {} }); } });
    await adapter.decide(toModelRequest(profile, { description: 'x' }, 'local', [PNG]));
    expect(bodies[0]).toMatchObject({ images: [PNG] });
  });

  it('a Workers AI error is cut short in the log, so it cannot carry images', async () => {
    const ai: AiRunner = { run: async () => { throw new Error(`invalid input: ${'A'.repeat(5000)}`); } };
    const err = await new WorkersAiAdapter(ai).decide(toModelRequest(profile, {}, 'clef-flash', [PNG])).catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(260);
  });

  it('explain names the images, in English and Japanese', () => {
    expect(explanationText(explainProfile(profile, 'en'))).toContain('The AI also sees up to 3 images from the request ($.photos.value); images are never stored.');
    expect(explanationText(explainProfile(profile, 'ja'))).toContain('AI はリクエストの画像（$.photos.value）も最大 3 枚見ます。画像は保存しません。');
  });
});

describe('limits of the whole request', () => {
  const TOKEN = newToken();
  const tokens = new MemoryTokenStore();
  const headers = { authorization: `Bearer ${TOKEN}` };
  async function post(body: string, extra: Record<string, string> = {}) {
    tokens.records.set(await hashToken(TOKEN), { client: 'test', profiles: ['*'], created_at: '' });
    const model = new MockAdapter();
    const asked = vi.spyOn(model, 'decide');
    const deps: Deps = { callbacks: noCallbacks, store: new MemoryProfileStore([profile]), tokens, log: new D1DecisionLog(env.DB), adapterFor: () => model };
    const res = await createApp(() => deps).request('/v1/decide/concern', { method: 'POST', headers: { ...headers, ...extra }, body }, env);
    return { status: res.status, body: await res.json<any>(), asked };
  }

  it('refuses images and state that together pass the model\'s 13 MiB, before the model call', async () => {
    const three = dataUrl('image/jpeg', bytes(0xff, 0xd8, 0xff) + 'x'.repeat(2_600_000));
    const r = await post(JSON.stringify({ state: { description: { value: 'y'.repeat(3_600_000) }, photos: { value: [three, three, three] } } }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/13 MiB/);
    expect(r.asked).not.toHaveBeenCalled();
  });

  it('refuses a body over 14 MiB by its length, before reading it', async () => {
    const r = await post('{}', { 'content-length': String(15 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });
});
