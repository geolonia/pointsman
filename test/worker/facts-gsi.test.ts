// The GSI fact provider (src/facts-gsi.ts) with made-up tiles: no network.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { FactError, FactUnavailableError, lookupFacts, type Geometry } from '../../src/facts';
import { decodePng, GsiFactProvider } from '../../src/facts-gsi';
import { depsFor } from '../../src/index';

/** A 256 × 256 PNG: colour type 6 (RGBA) or 3 (palette), each row with the given filter. */
async function png(pixel: (x: number, y: number) => [number, number, number, number], { type = 6, filter = 0 } = {}): Promise<Uint8Array> {
  const size = 256;
  const palette: number[][] = [];
  const index = (c: number[]) => {
    let i = palette.findIndex((p) => p.every((v, k) => v === c[k]));
    if (i < 0) i = palette.push(c) - 1;
    return i;
  };
  const channels = type === 6 ? 4 : 1;
  const rows = new Uint8Array(size * (size * channels + 1));
  for (let y = 0; y < size; y++) {
    const line = new Uint8Array(size * channels);
    for (let x = 0; x < size; x++) {
      const c = pixel(x, y);
      if (type === 6) line.set(c, x * 4);
      else line[x] = index(c);
    }
    const o = y * (size * channels + 1);
    rows[o] = filter;
    for (let i = 0; i < line.length; i++) {
      // Filter 1 (sub): store the difference to the byte one pixel to the left.
      rows[o + 1 + i] = filter === 1 ? (line[i]! - (i >= channels ? line[i - channels]! : 0)) & 255 : line[i]!;
    }
  }
  const zipped = new Uint8Array(await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk = (kind: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set([...kind].map((ch) => ch.charCodeAt(0)), 4);
    out.set(data, 8);
    return out; // CRC left at zero: the decoder does not check it
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, size);
  new DataView(ihdr.buffer).setUint32(4, size);
  ihdr.set([8, type, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (type === 3) {
    parts.push(chunk('PLTE', new Uint8Array(palette.flatMap((p) => p.slice(0, 3)))));
    parts.push(chunk('tRNS', new Uint8Array(palette.map((p) => p[3]!))));
  }
  parts.push(chunk('IDAT', zipped), chunk('IEND', new Uint8Array()));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
  return all;
}

const DEEP: [number, number, number, number] = [255, 183, 183, 255]; // 3 to 5 m
const SHALLOW: [number, number, number, number] = [255, 216, 192, 255]; // 0.5 to 3 m
const NONE: [number, number, number, number] = [0, 0, 0, 0];
const MODIFIED = 'Wed, 20 Aug 2025 09:41:13 GMT';

const point: Geometry = { type: 'Point', coordinates: [139.753, 35.6855] };
const signal = new AbortController().signal;

function fakeServer(flood: (url: string) => Promise<Uint8Array | null>, shelters: unknown = { type: 'FeatureCollection', features: [] }) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get('user-agent')).toMatch(/^pointsman/);
    if (url.includes('01_flood_l2_shinsuishin_data')) {
      const body = await flood(url);
      return body ? new Response(body, { headers: { 'last-modified': MODIFIED } }) : new Response('not found', { status: 404 });
    }
    if (url.includes('/skhb01/10/')) return new Response(JSON.stringify(shelters), { headers: { 'last-modified': MODIFIED } });
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('PNG tiles', () => {
  it('decode RGBA and palette images, and the sub filter', async () => {
    const half = (x: number): [number, number, number, number] => (x < 128 ? DEEP : NONE);
    for (const options of [{ type: 6 }, { type: 3 }, { type: 6, filter: 1 }]) {
      const read = await decodePng(await png(half, options));
      expect(read(10, 10)).toEqual(DEEP);
      expect(read(200, 10)[3]).toBe(0);
    }
  });

  it('refuse what they cannot read', async () => {
    await expect(decodePng(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).rejects.toThrow(FactError);
  });
});

describe('flood zones', () => {
  const lookup = (p: GsiFactProvider, geometry: Geometry = point) => p.lookup({ type: 'inside', layer: 'gsi-flood-max', geometry }, signal);

  it('give the deepest class along the geometry, with the source and its date', async () => {
    // Left half of every tile 0.5 to 3 m, right half 3 to 5 m: a long line crosses both.
    const { fetchFn } = fakeServer(() => png((x) => (x < 128 ? SHALLOW : DEEP)));
    const line: Geometry = { type: 'LineString', coordinates: [[139.7500, 35.6855], [139.7530, 35.6855]] };
    const r = await lookup(new GsiFactProvider({ fetch: fetchFn }), line);
    expect(r.values).toEqual({ inside: true, rank: 5, class: '3 to 5 m' });
    expect(r.source).toBe('「ハザードマップポータルサイト」洪水浸水想定区域（想定最大規模）を加工して作成（2025-08-20 時点）');
  });

  it('are not inside where the tile is transparent or missing', async () => {
    expect((await lookup(new GsiFactProvider({ fetch: fakeServer(() => png(() => NONE)).fetchFn }))).values).toEqual({ inside: false, rank: 0, class: '' });
    const missing = await lookup(new GsiFactProvider({ fetch: fakeServer(async () => null).fetchFn }));
    expect(missing).toEqual({ values: { inside: false, rank: 0, class: '' }, source: expect.stringContaining('日付不明') });
  });

  it('fail on a colour that is not in the legend, even a close one, and on server errors', async () => {
    await expect(lookup(new GsiFactProvider({ fetch: fakeServer(() => png(() => [10, 200, 10, 255])).fetchFn }))).rejects.toThrow(/not in the legend/);
    await expect(lookup(new GsiFactProvider({ fetch: fakeServer(() => png(() => [255, 183, 186, 255])).fetchFn }))).rejects.toThrow(/not in the legend/);
    const down = (async () => new Response('busy', { status: 503 })) as typeof fetch;
    await expect(lookup(new GsiFactProvider({ fetch: down }))).rejects.toThrow('tile 503');
  });

  it('keep tiles in memory, and in the Workers cache across providers', async () => {
    const server = fakeServer(() => png(() => DEEP));
    const cache = await caches.open('facts-gsi-test');
    const first = new GsiFactProvider({ fetch: server.fetchFn, cache });
    await lookup(first);
    await lookup(first);
    expect(server.calls).toHaveLength(1);
    // A new isolate (new provider) finds the tile in the cache, with its date.
    const second = await lookup(new GsiFactProvider({ fetch: server.fetchFn, cache }));
    expect(server.calls).toHaveLength(1);
    expect(second.source).toContain('2025-08-20');
  });

  it('keep tiles in memory for a day only', async () => {
    const server = fakeServer(() => png(() => DEEP));
    let now = Date.parse('2026-10-07T00:00:00Z');
    const p = new GsiFactProvider({ fetch: server.fetchFn, now: () => now });
    await lookup(p);
    now += 23 * 3600_000;
    await lookup(p);
    expect(server.calls).toHaveLength(1);
    now += 2 * 3600_000;
    await lookup(p);
    expect(server.calls).toHaveLength(2);
  });

  it('do not cancel a shared tile load when one lookup gives up', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Like a real fetch: an aborted signal fails the request.
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      init?.signal?.throwIfAborted();
      return new Response(await png(() => DEEP));
    }) as typeof fetch;
    const p = new GsiFactProvider({ fetch: fetchFn });
    const impatient = new AbortController();
    const first = p.lookup({ type: 'inside', layer: 'gsi-flood-max', geometry: point }, impatient.signal);
    const second = lookup(p);
    impatient.abort();
    release();
    expect((await second).values).toMatchObject({ inside: true });
    expect((await first).values).toMatchObject({ inside: true });
  });

  it('look at the whole of a long line, up to its end', async () => {
    // 400 segments of 9 m (more than the 200 places sampled): only the tile at its end is flooded.
    const coords: [number, number][] = Array.from({ length: 401 }, (_, i) => [139.70 + i * 0.0001, 35.6855]);
    const end = coords[coords.length - 1]!;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const m = String(input).match(/\/17\/(\d+)\/(\d+)\.png$/)!;
      const t = { x: Number(m[1]), y: Number(m[2]) };
      const lastX = Math.floor(((end[0] + 180) / 360) * 2 ** 17);
      return new Response(await png(() => (t.x === lastX ? DEEP : NONE)));
    }) as typeof fetch;
    const r = await lookup(new GsiFactProvider({ fetch: fetchFn }), { type: 'LineString', coordinates: coords });
    expect(r.values).toMatchObject({ inside: true, rank: 5 });
  });

  it('do not keep a failed tile', async () => {
    let fail = true;
    const fetchFn = (async () => (fail ? new Response('busy', { status: 503 }) : new Response(await png(() => DEEP)))) as typeof fetch;
    const p = new GsiFactProvider({ fetch: fetchFn });
    await expect(lookup(p)).rejects.toThrow();
    fail = false;
    expect((await lookup(p)).values).toMatchObject({ inside: true });
  });
});

describe('evacuation sites', () => {
  const site = (lon: number, lat: number, name: string) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name } });
  const lookup = (p: GsiFactProvider, geometry: Geometry = point) => p.lookup({ type: 'nearest', layer: 'gsi-shelters-flood', geometry }, signal);

  it('give the nearest site within 5 km, with its distance', async () => {
    const shelters = { type: 'FeatureCollection', features: [site(139.7530, 35.6900, 'North school'), site(139.7530, 35.6870, 'Near school'), { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { name: 'bad' } }] };
    const r = await lookup(new GsiFactProvider({ fetch: fakeServer(async () => null, shelters).fetchFn }));
    expect(r.values).toEqual({ found: true, distance_m: 167, name: 'Near school' });
    expect(r.source).toBe('国土地理院 指定緊急避難場所データ（洪水）を加工して作成（2025-08-20 時点）');
  });

  it('look around the whole of a line, not only its middle', async () => {
    // A 60 km line over three zoom-10 tiles; the only site is near its west end, two tiles from the middle.
    const shelters = (x: number) => ({ type: 'FeatureCollection', features: x === 907 ? [site(139.1010, 35.6855, 'West school')] : [] });
    const fetchFn = (async (input: RequestInfo | URL) => {
      const x = Number(String(input).match(/\/10\/(\d+)\//)![1]);
      return new Response(JSON.stringify(shelters(x)));
    }) as typeof fetch;
    const line: Geometry = { type: 'LineString', coordinates: [[139.10, 35.6855], [139.75, 35.6855]] };
    expect((await lookup(new GsiFactProvider({ fetch: fetchFn }), line)).values).toMatchObject({ found: true, name: 'West school' });
  });

  it('find none farther than 5 km', async () => {
    const far = { type: 'FeatureCollection', features: [site(139.82, 35.6855, 'Far school')] };
    expect((await lookup(new GsiFactProvider({ fetch: fakeServer(async () => null, far).fetchFn }))).values).toEqual({ found: false, distance_m: null, name: null });
  });
});

describe('what the provider cannot answer', () => {
  const p = new GsiFactProvider({ fetch: fakeServer(async () => null).fetchFn });
  const line: Geometry = { type: 'LineString', coordinates: [[139.75, 35.68], [139.751, 35.681]] };

  it('is unavailable: detours, and unknown layers', async () => {
    await expect(p.lookup({ type: 'detour', geometry: line }, signal)).rejects.toThrow(FactUnavailableError);
    await expect(p.lookup({ type: 'inside', layer: 'city-zones', geometry: point }, signal)).rejects.toThrow(FactUnavailableError);
    const facts = await lookupFacts([{ name: 'detour', type: 'detour', at: '$.g' }], { g: line }, p);
    expect(facts.detour).toEqual({ missing: true, reason: 'unavailable' });
  });

  it('is an error: a layer asked for the wrong type', async () => {
    await expect(p.lookup({ type: 'nearest', layer: 'gsi-flood-max', geometry: point }, signal)).rejects.toThrow(/answers inside, not nearest/);
  });

  it('is selected with FACTS_MODE "gsi"', () => {
    expect(depsFor({ PROFILE_SOURCE: 'bundled', MODEL_MODE: 'mock', FACTS_MODE: 'gsi', TOKENS: env.TOKENS, DB: env.DB }).facts).toBeInstanceOf(GsiFactProvider);
  });
});
