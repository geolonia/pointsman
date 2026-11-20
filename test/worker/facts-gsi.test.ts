// The GSI fact provider (packages/facts-gsi/src/provider.ts) with made-up tiles: no network.

import { providerOf } from './helpers';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { FactError, FactUnavailableError, lookupFacts, type Geometry } from '../../src/facts';
import { decodePng, GsiFactProvider } from '@pointsman/facts-gsi';
import { depsFor } from '../../src/index';

/** The spatial provider behind the deployment's fact router. */

/**
 * A PNG of `size` × `size` (256 by default): colour type 6 (RGBA), 3
 * (palette), 2 (RGB) or 0 (greyscale), each row with the given filter (0 to
 * 4). `key`: a tRNS colour key for types 0 and 2 (one 16-bit value per
 * channel, as PNG writes it).
 */
async function png(
  pixel: (x: number, y: number) => [number, number, number, number],
  { type = 6, filter = 0, size = 256, key }: { type?: number; filter?: number; size?: number; key?: number[] } = {},
): Promise<Uint8Array> {
  const palette: number[][] = [];
  const index = (c: number[]) => {
    let i = palette.findIndex((p) => p.every((v, k) => v === c[k]));
    if (i < 0) i = palette.push(c) - 1;
    return i;
  };
  const channels = ({ 0: 1, 2: 3, 3: 1, 6: 4 } as Record<number, number>)[type]!;
  const stride = size * channels;
  const lines: Uint8Array[] = [];
  for (let y = 0; y < size; y++) {
    const line = new Uint8Array(stride);
    for (let x = 0; x < size; x++) {
      const c = pixel(x, y);
      if (type === 6) line.set(c, x * 4);
      else if (type === 2) line.set(c.slice(0, 3), x * 3);
      else if (type === 0) line[x] = c[0]!;
      else line[x] = index(c);
    }
    lines.push(line);
  }
  const rows = new Uint8Array(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    const line = lines[y]!;
    const up = y > 0 ? lines[y - 1]! : new Uint8Array(stride);
    const o = y * (stride + 1);
    rows[o] = filter;
    for (let i = 0; i < stride; i++) {
      // Each filter stores the difference to a prediction from the bytes left (a), above (b) and above-left (c).
      const a = i >= channels ? line[i - channels]! : 0;
      const b = up[i]!;
      const c = i >= channels ? up[i - channels]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      rows[o + 1 + i] = (line[i]! - predicted) & 255;
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
  if (key) parts.push(chunk('tRNS', new Uint8Array(key.flatMap((v) => [v >> 8, v & 255]))));
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

  it('decode RGB and greyscale images, with every filter', async () => {
    // A pattern that differs left, above and diagonally, so every predictor matters.
    const pattern = (x: number, y: number): [number, number, number, number] => [(x * 7 + y * 3) & 255, (x * 5 + y * 11) & 255, (x * 13 + y) & 255, 255];
    for (const type of [6, 2, 0]) {
      for (const filter of [0, 1, 2, 3, 4]) {
        const read = await decodePng(await png(pattern, { type, filter }));
        for (const [x, y] of [[0, 0], [1, 0], [0, 1], [37, 91], [255, 255]] as const) {
          const want = pattern(x, y);
          expect(read(x, y), `type ${type} filter ${filter} at ${x},${y}`).toEqual(type === 0 ? [want[0], want[0], want[0], 255] : want);
        }
      }
    }
  });

  it('read the colour key of RGB and greyscale images as transparent', async () => {
    const rgb = await decodePng(await png((x) => (x < 128 ? DEEP : [1, 2, 3, 255]), { type: 2, key: [1, 2, 3] }));
    expect(rgb(10, 10)).toEqual(DEEP);
    expect(rgb(200, 10)).toEqual([1, 2, 3, 0]);
    const grey = await decodePng(await png((x) => (x < 128 ? [9, 9, 9, 255] : [200, 200, 200, 255]), { type: 0, key: [200] }));
    expect(grey(10, 10)).toEqual([9, 9, 9, 255]);
    expect(grey(200, 10)).toEqual([200, 200, 200, 0]);
    // An 8-bit image uses the low byte of each 16-bit key value, as libpng does.
    const high = await decodePng(await png(() => [5, 6, 7, 255], { type: 2, key: [0x0105, 0x0106, 0x0107] }));
    expect(high(0, 0)).toEqual([5, 6, 7, 0]);
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

  it('date the data by the oldest tile used, and say when a date is unknown', async () => {
    const line: Geometry = { type: 'LineString', coordinates: [[139.7500, 35.6855], [139.7530, 35.6855]] };
    const dates = new Map<string, string>();
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      // The first tile asked for is older than the others.
      if (!dates.has(url)) dates.set(url, dates.size === 0 ? 'Mon, 01 Jul 2024 00:00:00 GMT' : MODIFIED);
      return new Response(await png(() => DEEP), { headers: { 'last-modified': dates.get(url)! } });
    }) as typeof fetch;
    expect((await lookup(new GsiFactProvider({ fetch: fetchFn }), line)).source).toContain('2024-07-01 時点');
    const undated = (async () => new Response(await png(() => DEEP))) as typeof fetch;
    expect((await lookup(new GsiFactProvider({ fetch: undated }), line)).source).toContain('日付不明');
  });

  it('are not inside where the tile is transparent or missing', async () => {
    expect((await lookup(new GsiFactProvider({ fetch: fakeServer(() => png(() => NONE)).fetchFn }))).values).toEqual({ inside: false, rank: 0, class: '' });
    const missing = await lookup(new GsiFactProvider({ fetch: fakeServer(async () => null).fetchFn }));
    expect(missing).toEqual({ values: { inside: false, rank: 0, class: '' }, source: expect.stringContaining('日付不明') });
  });

  it('refuse a tile that is not 256 × 256, and do not keep it', async () => {
    let calls = 0;
    const big = (async () => (calls++, new Response(await png(() => DEEP, { size: 512 }), { headers: { 'last-modified': MODIFIED } }))) as typeof fetch;
    const p = new GsiFactProvider({ fetch: big });
    await expect(lookup(p)).rejects.toThrow(/512 × 512, not 256 × 256/);
    await expect(lookup(p)).rejects.toThrow(/not 256 × 256/);
    expect(calls).toBe(2);
  });

  it('a transparent colour key is outside every zone, not a colour outside the legend', async () => {
    const keyed = fakeServer(() => png(() => [1, 2, 3, 255], { type: 2, key: [1, 2, 3] }));
    expect((await lookup(new GsiFactProvider({ fetch: keyed.fetchFn }))).values).toEqual({ inside: false, rank: 0, class: '' });
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

  it('put only readable tiles into the cache, and fetch an unreadable cached tile again', async () => {
    const cache = await caches.open('facts-gsi-broken');
    let body: Uint8Array = new Uint8Array([1, 2, 3]); // not a PNG
    const server = { calls: 0 };
    const fetchFn = (async () => (server.calls++, new Response(body))) as typeof fetch;
    await expect(lookup(new GsiFactProvider({ fetch: fetchFn, cache }))).rejects.toThrow(FactError);
    const url = 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/17/116418/51611.png';
    expect(await cache.match(url)).toBeUndefined();
    // A bad body already in the cache (from an older version) is dropped and fetched again.
    await cache.put(url, new Response(new Uint8Array([9, 9]), { headers: { 'cache-control': 'max-age=3600' } }));
    body = await png(() => DEEP);
    expect((await lookup(new GsiFactProvider({ fetch: fetchFn, cache }))).values).toMatchObject({ inside: true, rank: 5 });
    expect(server.calls).toBe(2);
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

  it('widen the search by 5 km also at the far latitude of a line', async () => {
    // A north-south line close to the tile edge at 139.21875° E (zoom 10,
    // x 907 | 908). 5 km west of its southern end stays east of the edge; 5 km
    // west of its northern end crosses it. The site is 4.98 km west of the
    // northern end, across the edge.
    const north: [number, number] = [139.27430, 36.30];
    const siteLon = north[0] - (4980 / (6371008.8 * Math.cos((36.30 * Math.PI) / 180))) * (180 / Math.PI);
    const fetchFn = (async (input: RequestInfo | URL) => {
      const x = Number(String(input).match(/\/10\/(\d+)\//)![1]);
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: x === 907 ? [site(siteLon, 36.30, 'Edge school')] : [] }));
    }) as typeof fetch;
    expect(siteLon).toBeLessThan(139.21875);
    const line: Geometry = { type: 'LineString', coordinates: [[north[0], 35.70], north] };
    expect((await lookup(new GsiFactProvider({ fetch: fetchFn }), line)).values).toMatchObject({ found: true, name: 'Edge school' });
  });

  it('refuse a geometry at or near a pole or the 180° meridian, as a missing fact, without fetching tiles', async () => {
    const server = fakeServer(async () => null);
    const p = new GsiFactProvider({ fetch: server.fetchFn });
    // Far outside Japan: GSI has no data there (outside the tile grid, too).
    for (const coordinates of [[139.75, 90], [139.75, -90], [180, 0], [-180, 0], [139.75, 89.99]] as [number, number][]) {
      await expect(lookup(p, { type: 'Point', coordinates }), String(coordinates)).rejects.toThrow(FactUnavailableError);
    }
    const facts = await lookupFacts([{ name: 'shelter', type: 'nearest', layer: 'gsi-shelters-flood', at: '$.g' }], { g: { type: 'Point', coordinates: [0, 90] } }, p);
    expect(facts.shelter).toEqual({ missing: true, reason: 'unavailable' });
    expect(server.calls).toHaveLength(0);
  });

  it('find none farther than 5 km', async () => {
    const far = { type: 'FeatureCollection', features: [site(139.82, 35.6855, 'Far school')] };
    expect((await lookup(new GsiFactProvider({ fetch: fakeServer(async () => null, far).fetchFn }))).values).toEqual({ found: false, distance_m: null, name: null });
  });
});

describe('outside Japan', () => {
  const specs = [
    { name: 'flood', type: 'inside' as const, layer: 'gsi-flood-max', at: '$.g' },
    { name: 'shelter', type: 'nearest' as const, layer: 'gsi-shelters-flood', at: '$.g' },
  ];

  it('is unavailable, never "not in a zone" or "no site", and fetches no tile', async () => {
    const server = fakeServer(async () => null);
    const p = new GsiFactProvider({ fetch: server.fetchFn });
    // Paris; the sea south of Japan; a line that leaves Japan's box (beyond 154° E).
    const outside: Geometry[] = [
      { type: 'Point', coordinates: [2.3522, 48.8566] },
      { type: 'Point', coordinates: [139.75, 15] },
      { type: 'LineString', coordinates: [[153.9, 35], [154.1, 35]] },
    ];
    for (const g of outside) {
      const facts = await lookupFacts(specs, { g }, p);
      expect(facts, JSON.stringify(g)).toEqual({ flood: { missing: true, reason: 'unavailable' }, shelter: { missing: true, reason: 'unavailable' } });
    }
    expect(server.calls).toHaveLength(0);
  });

  it('swapped latitude and longitude of a place in Japan is no location at all', async () => {
    const p = new GsiFactProvider({ fetch: fakeServer(async () => null).fetchFn });
    // [lat, lon] instead of [lon, lat]: the latitude is then over 90.
    const facts = await lookupFacts(specs, { g: { type: 'Point', coordinates: [35.6855, 139.753] } }, p);
    expect(facts.flood).toEqual({ missing: true, reason: 'no_location' });
  });

  it('the edges of the box still count as Japan', async () => {
    const p = new GsiFactProvider({ fetch: fakeServer(async () => null).fetchFn });
    // Yonaguni (122.9° E), Minamitorishima (153.98° E), Okinotorishima (20.4° N), Wakkanai (45.4° N).
    for (const coordinates of [[122.94, 24.45], [153.98, 24.28], [136.08, 20.42], [141.67, 45.41]] as [number, number][]) {
      expect((await p.lookup({ type: 'inside', layer: 'gsi-flood-max', geometry: { type: 'Point', coordinates } }, signal)).values, String(coordinates)).toEqual({ inside: false, rank: 0, class: '' });
    }
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
    expect(providerOf(depsFor({ PROFILE_SOURCE: 'bundled', MODEL_MODE: 'mock', FACTS_MODE: 'gsi', TOKENS: env.TOKENS, DB: env.DB }), '@pointsman/facts-gsi')).toBeInstanceOf(GsiFactProvider);
  });
});
