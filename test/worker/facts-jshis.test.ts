// The J-SHIS fact provider (packages/facts-jshis/src/provider.ts) with made-up answers: no network.

import { describe, expect, it } from 'vitest';
import { FactError, FactUnavailableError } from '@pointsman/module-api';
import { JshisFactProvider, meshCentre, meshCode, meshesAlong, parseMesh } from '@pointsman/facts-jshis';
import type { Geometry, Position } from '@pointsman/module-api';

const signal = new AbortController().signal;
// Kiyota-ku Satozuka, Sapporo, and its mesh (checked against J-SHIS on 2026-11-06).
const SATOZUKA: Position = [141.4415, 42.9735];
const SATOZUKA_MESH = '6441336534';
const point: Geometry = { type: 'Point', coordinates: SATOZUKA };

const hazard = (code: string, attr: string, value: string) => JSON.stringify({
  type: 'FeatureCollection', status: 'Success',
  features: [{ type: 'Feature', properties: { meshcode: code, [attr]: value } }],
});
const ground = (code: string, arv = '1.30') => JSON.stringify({
  type: 'FeatureCollection', status: 'Success',
  features: [{ type: 'Feature', properties: { ARV: arv, JCODE: '5', JNAME: '火山山麓地', meshcode: code, AVS: '294.4' } }],
});
const NOT_FOUND = JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No data is found for the query' }, type: 'FeatureCollection', features: [{ geometry: { coordinates: [[]] } }], status: 'Error' });

/** A fake J-SHIS: answers with body(url, mesh code of the asked position). */
function fakeServer(body: (url: string, code: string) => string | Response) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get('user-agent')).toMatch(/^pointsman/);
    const m = url.match(/position=([\d.]+),([\d.]+)/)!;
    const b = body(url, meshCode([Number(m[1]), Number(m[2])]));
    return typeof b === 'string' ? new Response(b) : b;
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('mesh codes', () => {
  it('match J-SHIS for a known place, and the centre lies in its own mesh', () => {
    expect(meshCode(SATOZUKA)).toBe(SATOZUKA_MESH);
    expect(meshCode([141.3544, 43.0621])).toBe('6441427814'); // Sapporo city hall
    for (const code of [SATOZUKA_MESH, '6441427814', '5339452211', '3036000044']) expect(meshCode(meshCentre(code))).toBe(code);
  });

  it('put a point on a grid line into the mesh north or east of it', () => {
    expect(meshCode([139.7, 35.7])).toBe('5339454611');
    expect(meshCode([139.75, 35.675])).toBe('5339461011');
    // Just south or west of the line stays in the other mesh.
    expect(meshCode([139.7, 35.7 - 1e-5])).not.toBe('5339454611');
    expect(meshCode([139.7 - 1e-5, 35.7])).not.toBe('5339454611');
  });

  it('refuse places outside Japan', () => {
    expect(() => meshCode([2.35, 48.85])).toThrow(FactUnavailableError);
  });

  it('list each mesh along a line once', () => {
    // About 1 km east: four or five 250 m meshes.
    const codes = meshesAlong({ type: 'LineString', coordinates: [SATOZUKA, [SATOZUKA[0] + 0.012, SATOZUKA[1]]] });
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThanOrEqual(4);
    expect(codes[0]).toBe(SATOZUKA_MESH);
  });
});

describe('answers', () => {
  it('are read, also "no data here"; anything else fails', () => {
    const G = 'jshis-ground-amplification';
    expect(parseMesh(SATOZUKA_MESH, ground(SATOZUKA_MESH), G).props?.ARV).toBe('1.30');
    expect(parseMesh(SATOZUKA_MESH, NOT_FOUND, G)).toEqual({ code: SATOZUKA_MESH, props: null });
    expect(() => parseMesh(SATOZUKA_MESH, '<html>', G)).toThrow(/not JSON/);
    expect(() => parseMesh(SATOZUKA_MESH, JSON.stringify({ status: 'Error', error: { code: 'BAD_REQUEST' } }), G)).toThrow(/BAD_REQUEST/);
    // Another mesh: the error names no mesh code (a location; errors are logged).
    expect(() => parseMesh(SATOZUKA_MESH, ground('6441336533'), G)).toThrow(/^J-SHIS answered for another mesh$/);
    expect(() => parseMesh(SATOZUKA_MESH, hazard(SATOZUKA_MESH, 'T30_I55_PS', 'x'), 'jshis-shaking-6lower-30y')).toThrow(/not a number/);
    expect(() => parseMesh(SATOZUKA_MESH, ground(SATOZUKA_MESH, ''), 'jshis-landform')).toThrow(/ARV is not a number/);
  });
});

describe('shaking', () => {
  const lookup = (p: JshisFactProvider, layer = 'jshis-shaking-6lower-30y', geometry: Geometry = point) =>
    p.lookup({ type: 'inside', layer, geometry }, signal);

  it('give the class of the national map, with the exact value and mesh in the source', async () => {
    const { calls, fetchFn } = fakeServer((_, code) => hazard(code, 'T30_I55_PS', '0.032289'));
    const r = await lookup(new JshisFactProvider({ fetch: fetchFn }));
    expect(r.values).toEqual({ inside: true, rank: 3, class: '3% to 6%' });
    expect(r.source).toBe('防災科研 J-SHIS 確率論的地震動予測地図（Y2024、平均ケース・全地震、30年震度6弱以上の確率）を加工して作成（メッシュ 6441336534：3.23%）');
    expect(calls[0]).toMatch(/\/pshm\/Y2024\/AVR\/TTL_MTTL\/meshinfo\.geojson\?position=.*&epsg=4326&attr=T30_I55_PS$/);
  });

  it('ask for 6-upper with its own attribute', async () => {
    const { calls, fetchFn } = fakeServer((_, code) => hazard(code, 'T30_I60_PS', '0.0028'));
    const r = await lookup(new JshisFactProvider({ fetch: fetchFn }), 'jshis-shaking-6upper-30y');
    expect(r.values).toEqual({ inside: true, rank: 2, class: '0.1% to 3%' });
    expect(r.source).toContain('震度6強以上');
    expect(calls[0]).toMatch(/attr=T30_I60_PS$/);
  });

  it('put each value into its class, boundaries included', async () => {
    for (const [value, rank] of [['0', 1], ['0.00099', 1], ['0.001', 2], ['0.03', 3], ['0.06', 4], ['0.26', 5], ['0.9', 5]] as const) {
      const { fetchFn } = fakeServer((_, code) => hazard(code, 'T30_I55_PS', value));
      expect((await lookup(new JshisFactProvider({ fetch: fetchFn }))).values.rank, value).toBe(rank);
    }
  });

  it('take the highest class along a line', async () => {
    const line: Geometry = { type: 'LineString', coordinates: [SATOZUKA, [SATOZUKA[0] + 0.012, SATOZUKA[1]]] };
    const last = meshesAlong(line).at(-1)!;
    const { fetchFn } = fakeServer((_, code) => hazard(code, 'T30_I55_PS', code === last ? '0.3' : '0.02'));
    const r = await lookup(new JshisFactProvider({ fetch: fetchFn }), 'jshis-shaking-6lower-30y', line);
    expect(r.values).toEqual({ inside: true, rank: 5, class: '26% or more' });
    expect(r.source).toContain(`メッシュ ${last}：30.00%`);
  });

  it('are not inside where J-SHIS has no data (it answers 404 with NOT_FOUND)', async () => {
    for (const status of [200, 404]) {
      const { fetchFn } = fakeServer(() => new Response(NOT_FOUND, { status }));
      const r = await lookup(new JshisFactProvider({ fetch: fetchFn }));
      expect(r.values).toEqual({ inside: false, rank: 0, class: '' });
      expect(r.source).toContain('該当メッシュなし');
    }
    // A 404 without that body is an error, not "no data".
    await expect(lookup(new JshisFactProvider({ fetch: fakeServer(() => new Response('gone', { status: 404 })).fetchFn }))).rejects.toThrow('J-SHIS 404');
  });

  it('fail on a value that is not a number, and on server errors (403: over the limit)', async () => {
    await expect(lookup(new JshisFactProvider({ fetch: fakeServer((_, code) => hazard(code, 'T30_I55_PS', '')).fetchFn }))).rejects.toThrow(/not a number/);
    await expect(lookup(new JshisFactProvider({ fetch: fakeServer(() => new Response('', { status: 403 })).fetchFn }))).rejects.toThrow('J-SHIS 403');
  });
});

describe('ground', () => {
  it('give the amplification band, with value, AVS30 and landform in the source', async () => {
    const { fetchFn } = fakeServer((_, code) => ground(code));
    const r = await new JshisFactProvider({ fetch: fetchFn }).lookup({ type: 'inside', layer: 'jshis-ground-amplification', geometry: point }, signal);
    expect(r.values).toEqual({ inside: true, rank: 2, class: '1.0 to 1.4' });
    expect(r.source).toBe('防災科研 J-SHIS 表層地盤（V3）を加工して作成（メッシュ 6441336534：増幅率 1.30、AVS30 294 m/s、火山山麓地）');
  });

  it('give the landform for a point, from the same answer', async () => {
    const { calls, fetchFn } = fakeServer((_, code) => ground(code, '2.05'));
    const p = new JshisFactProvider({ fetch: fetchFn });
    const amp = await p.lookup({ type: 'inside', layer: 'jshis-ground-amplification', geometry: point }, signal);
    const land = await p.lookup({ type: 'inside', layer: 'jshis-landform', geometry: point }, signal);
    expect(amp.values).toMatchObject({ rank: 5, class: '2.0 or more' });
    expect(land.values).toEqual({ inside: true, rank: 5, class: '火山山麓地' });
    expect(calls).toHaveLength(1);
    const line: Geometry = { type: 'LineString', coordinates: [SATOZUKA, [SATOZUKA[0] + 0.01, SATOZUKA[1]]] };
    await expect(p.lookup({ type: 'inside', layer: 'jshis-landform', geometry: line }, signal)).rejects.toThrow(/needs a Point/);
  });
});

describe('the provider', () => {
  it('answers only its own layers, and only inside', async () => {
    const p = new JshisFactProvider({ fetch: fakeServer(() => NOT_FOUND).fetchFn });
    await expect(p.lookup({ type: 'inside', layer: 'gsi-flood-max', geometry: point }, signal)).rejects.toThrow(FactUnavailableError);
    await expect(p.lookup({ type: 'nearest', layer: 'jshis-landform', geometry: point }, signal)).rejects.toThrow(FactUnavailableError);
  });

  it('refuses a line over too many meshes', async () => {
    // About 3 km: more than 8 meshes.
    const long: Geometry = { type: 'LineString', coordinates: [SATOZUKA, [SATOZUKA[0] + 0.036, SATOZUKA[1]]] };
    expect(meshesAlong(long).length).toBeGreaterThan(8);
    const p = new JshisFactProvider({ fetch: fakeServer((_, code) => ground(code)).fetchFn });
    await expect(p.lookup({ type: 'inside', layer: 'jshis-ground-amplification', geometry: long }, signal)).rejects.toThrow(FactError);
  });

  it('keeps answers in memory for a day, and in the Workers cache across providers', async () => {
    const server = fakeServer((_, code) => ground(code));
    let now = Date.parse('2026-11-06T00:00:00Z');
    const cache = await caches.open('facts-jshis-test');
    const p = new JshisFactProvider({ fetch: server.fetchFn, cache, now: () => now });
    const q = { type: 'inside' as const, layer: 'jshis-ground-amplification', geometry: point };
    await p.lookup(q, signal);
    await p.lookup(q, signal);
    expect(server.calls).toHaveLength(1);
    await new JshisFactProvider({ fetch: server.fetchFn, cache }).lookup(q, signal);
    expect(server.calls).toHaveLength(1);
    now += 25 * 3600_000;
    await new JshisFactProvider({ fetch: server.fetchFn, now: () => now }).lookup(q, signal);
    expect(server.calls).toHaveLength(2);
  });

  it('waits two minutes after a 403 before asking J-SHIS again', async () => {
    let now = Date.parse('2026-11-06T00:00:00Z');
    let status = 403;
    const { calls, fetchFn } = fakeServer((_, code) => (status === 403 ? new Response('', { status }) : ground(code)));
    const p = new JshisFactProvider({ fetch: fetchFn, now: () => now });
    const q = { type: 'inside' as const, layer: 'jshis-ground-amplification', geometry: point };
    await expect(p.lookup(q, signal)).rejects.toThrow('J-SHIS 403');
    status = 200;
    now += 60_000;
    await expect(p.lookup(q, signal)).rejects.toThrow(/waiting/);
    expect(calls).toHaveLength(1);
    now += 61_000;
    expect((await p.lookup(q, signal)).values).toMatchObject({ inside: true });
    expect(calls).toHaveLength(2);
  });

  it('refuses a long line, so samples stay 100 m apart', async () => {
    // 200 positions going back and forth over 3 km: short in extent, long in length.
    const zigzag: Position[] = Array.from({ length: 200 }, (_, i) => (i % 2 ? [SATOZUKA[0] + 0.036, SATOZUKA[1]] : SATOZUKA));
    expect(() => meshesAlong({ type: 'LineString', coordinates: zigzag })).toThrow(/line too long/);
  });

  it('does not cache an answer with a broken value, and recovers', async () => {
    let broken = true;
    const cache = await caches.open('facts-jshis-broken');
    const { calls, fetchFn } = fakeServer((_, code) => hazard(code, 'T30_I55_PS', broken ? '' : '0.05'));
    const q = { type: 'inside' as const, layer: 'jshis-shaking-6lower-30y', geometry: point };
    const p = new JshisFactProvider({ fetch: fetchFn, cache });
    await expect(p.lookup(q, signal)).rejects.toThrow(/not a number/);
    broken = false;
    expect((await new JshisFactProvider({ fetch: fetchFn, cache }).lookup(q, signal)).values).toMatchObject({ rank: 3 });
    // The first provider dropped its failed load and now finds the good answer in the cache.
    expect((await p.lookup(q, signal)).values).toMatchObject({ rank: 3 });
    expect(calls).toHaveLength(2);
  });

  it('does not keep a failed load', async () => {
    let fail = true;
    const { calls, fetchFn } = fakeServer((_, code) => (fail ? new Response('', { status: 503 }) : ground(code)));
    const p = new JshisFactProvider({ fetch: fetchFn });
    const q = { type: 'inside' as const, layer: 'jshis-ground-amplification', geometry: point };
    await expect(p.lookup(q, signal)).rejects.toThrow('J-SHIS 503');
    fail = false;
    expect((await p.lookup(q, signal)).values).toMatchObject({ inside: true });
    expect(calls).toHaveLength(2);
  });
});
