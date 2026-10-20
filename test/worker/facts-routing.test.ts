// Detour facts from Valhalla (src/facts-routing.ts) with a fake server.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/app';
import { FactError, lookupFacts, type Geometry } from '../../src/facts';
import { GsiFactProvider } from '../../src/facts-gsi';
import { inside, ValhallaRouter } from '../../src/facts-routing';
import { distance } from '../../src/geo';
import { depsFor } from '../../src/index';

const URL_ = 'https://routing.test/v1';
// A 240 m section, north to south.
const section: Geometry = { type: 'LineString', coordinates: [[139.7505, 35.7025], [139.7505, 35.70034]] };
const ok = (km: number) => Response.json({ trip: { summary: { length: km } } });
const noPath = () => Response.json({ error_code: 442, error: 'No path could be found for input' }, { status: 400 });

/** A fake Valhalla: answers each call with the next response, and records the bodies. */
function server(...responses: (() => Response)[]) {
  const bodies: any[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`${URL_}/route`);
    expect(new Headers(init?.headers).get('user-agent')).toMatch(/^pointsman/);
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  }) as typeof fetch;
  return { bodies, router: new ValhallaRouter(`${URL_}/`, fetchFn) };
}

describe('detours', () => {
  it('compare the drive with and without the whole section, ends left open', async () => {
    const { bodies, router } = server(() => ok(0.24), () => ok(0.85));
    expect(await router.detour(section)).toEqual({ values: { possible: true, extra_m: 610, route: null }, source: expect.stringContaining('OpenStreetMap') });
    expect(bodies[0]).not.toHaveProperty('exclude_polygons');
    const polygons = bodies[1].exclude_polygons as [number, number][][];
    // The polygons cover the section without its ends (20 m open at each end).
    const [a, b] = (section as { coordinates: [number, number][] }).coordinates;
    const nearest = (p: [number, number]) => Math.min(...polygons.flat().map((q) => distance(p, q)));
    expect(nearest(a!)).toBeGreaterThan(15);
    expect(nearest(b!)).toBeGreaterThan(15);
    expect(bodies[1].costing).toBe('auto');
  });

  it('keep the way around as an encoded polyline only when asked', async () => {
    const shaped = (shape: unknown, legs = 1) => () => Response.json({ trip: { summary: { length: 0.85 }, legs: Array.from({ length: legs }, () => ({ shape })) } });
    const routeOf = async (answer: () => Response, withRoute = true) => {
      const { bodies, router } = server(() => ok(0.24), answer);
      const { values } = await router.detour(section, undefined, 'walk', withRoute);
      expect(bodies[1].shape_format).toBe('polyline6');
      expect(values.extra_m).toBe(610);
      return values.route;
    };
    expect(await routeOf(shaped('kz}fbAo~upiG??'))).toBe('kz}fbAo~upiG??');
    // Not asked for: the profile did not set route: true.
    expect(await routeOf(shaped('kz}fbAo~upiG??'), false)).toBeNull();
    // '??' is one position (two zero deltas): a valid polyline of any even length.
    expect(await routeOf(shaped('??'.repeat(3000)))).toHaveLength(6000);
    expect(await routeOf(shaped('??'.repeat(3001)))).toBeNull();
    // Only polyline characters, but incomplete: an open number, or half a position.
    expect(await routeOf(shaped('a'))).toBeNull();
    expect(await routeOf(shaped('???'))).toBeNull();
    expect(await routeOf(shaped('??'))).toBeNull();
    // Not an encoded polyline, or not one leg: left out, the length stays.
    expect(await routeOf(shaped('<b>x</b>'))).toBeNull();
    expect(await routeOf(shaped('abc def'))).toBeNull();
    expect(await routeOf(shaped(''))).toBeNull();
    expect(await routeOf(shaped(42))).toBeNull();
    expect(await routeOf(shaped('abc', 2))).toBeNull();
    expect(await routeOf(() => ok(0.85))).toBeNull();
  });

  it('fall back to a box in the middle when the whole section leaves no route', async () => {
    const { bodies, router } = server(() => ok(0.24), noPath, () => ok(0.5));
    expect((await router.detour(section)).values).toEqual({ possible: true, extra_m: 260, route: null });
    expect(bodies).toHaveLength(3);
  });

  it('never claim no way around: no path with the section closed is an error', async () => {
    const { router } = server(() => ok(0.24), noPath, noPath);
    await expect(router.detour(section)).rejects.toThrow(/no route with the section closed/);
    const failing = server(() => ok(0.24), () => new Response('down', { status: 503 }));
    await expect(failing.router.detour(section)).rejects.toThrow('routing 503');
  });

  it('never close an end, also when the section bends back to its start', async () => {
    // Out 60 m east, then back west to 5 m from the start.
    const hook: Geometry = { type: 'LineString', coordinates: [[139.7500, 35.7000], [139.75066, 35.7000], [139.75066, 35.70009], [139.75005, 35.70009]] };
    const { bodies, router } = server(() => ok(0.2), () => ok(0.4));
    await router.detour(hook);
    const start = (hook as { coordinates: [number, number][] }).coordinates[0]!;
    const end = (hook as { coordinates: [number, number][] }).coordinates[3]!;
    for (const b of bodies.slice(1)) {
      for (const polygon of b.exclude_polygons as [number, number][][]) {
        expect(inside(start, polygon)).toBe(false);
        expect(inside(end, polygon)).toBe(false);
      }
    }
  });

  it('cover every part of a U-shaped section whose arms run close together', async () => {
    // Two 100 m arms, 6 m apart.
    const u: Geometry = { type: 'LineString', coordinates: [[139.7500, 35.7000], [139.7511, 35.7000], [139.7511, 35.700054], [139.7500, 35.700054]] };
    const { bodies, router } = server(() => ok(0.2), () => ok(0.4));
    await router.detour(u);
    const polygons = bodies[1].exclude_polygons as [number, number][][];
    const covered = (p: [number, number]) => polygons.some((poly) => inside(p, poly));
    // Points along both arms, away from the open ends, are all inside a polygon.
    for (const lon of [139.7503, 139.7506, 139.7509]) {
      expect(covered([lon, 35.7000])).toBe(true);
      expect(covered([lon, 35.700054])).toBe(true);
    }
    expect(covered([139.7500, 35.7000])).toBe(false);
    expect(covered([139.7500, 35.700054])).toBe(false);
  });

  it('stay under the default vertex limit, and fall back when a server allows fewer', async () => {
    // A 1.4 km section with five 300 m legs at right angles (and many 5 m samples in between).
    const winding: Geometry = { type: 'LineString', coordinates: [[139.700, 35.700], [139.703, 35.700], [139.703, 35.7027], [139.706, 35.7027], [139.706, 35.700], [139.709, 35.700]] };
    const vertices = (b: any) => ((b.exclude_polygons ?? []) as unknown[][]).reduce((n, poly) => n + poly.length, 0);
    const limited = (limit: number) => {
      const bodies: any[] = [];
      const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (vertices(body) > limit) return Response.json({ error_code: 176, error: 'too many shape points' }, { status: 400 });
        return ok(body.exclude_polygons ? 2.5 : 2.0);
      }) as typeof fetch;
      return { bodies, router: new ValhallaRouter(URL_, fetchFn) };
    };
    const normal = limited(100);
    expect((await normal.router.detour(winding)).values).toEqual({ possible: true, extra_m: 500, route: null });
    expect(vertices(normal.bodies[1])).toBeLessThanOrEqual(100);
    // A server that allows only 20: the section's closure (5 rectangles, 25 vertices) is refused, the box at the middle is used.
    const strict = limited(20);
    expect((await strict.router.detour(winding)).values).toEqual({ possible: true, extra_m: 500, route: null });
    expect(strict.bodies).toHaveLength(3);
    expect(vertices(strict.bodies[2])).toBe(5);
  });

  it('put the fallback box at the middle, and refuse a section too short to close', async () => {
    // 30 m: too short for the ends-open corridor, long enough for a box at the middle.
    const short: Geometry = { type: 'LineString', coordinates: [[139.7500, 35.7000], [139.7500, 35.70027]] };
    const { bodies, router } = server(() => ok(0.03), () => ok(0.2));
    expect((await router.detour(short)).values).toEqual({ possible: true, extra_m: 170, route: null });
    const box = bodies[1].exclude_polygons[0] as [number, number][];
    expect(inside([139.7500, 35.700135], box)).toBe(true);
    // 4 m: any closure would cover an end, so no answer (not "no way around").
    const tiny: Geometry = { type: 'LineString', coordinates: [[139.7500, 35.7000], [139.7500, 35.700036]] };
    await expect(server().router.detour(tiny)).rejects.toThrow(/too short/);
  });

  it('stop when the lookup gives up', async () => {
    const controller = new AbortController();
    const { bodies, router } = server(() => { controller.abort(); return ok(0.24); }, () => ok(0.3));
    await expect(router.detour(section, controller.signal)).rejects.toThrow();
    expect(bodies).toHaveLength(1); // no request after the abort
  });

  it('refuse a section longer than 5 km before sampling it', async () => {
    const { bodies, router } = server();
    const t = Date.now();
    await expect(router.detour({ type: 'LineString', coordinates: [[0, 0], [179, 0]] })).rejects.toThrow(/longer than 5 km/);
    expect(Date.now() - t).toBeLessThan(100);
    expect(bodies).toHaveLength(0);
  });

  it('walk when asked to: pedestrian costing for every request', async () => {
    const { bodies, router } = server(() => ok(0.24), () => ok(0.4));
    expect((await router.detour(section, undefined, 'walk')).values).toEqual({ possible: true, extra_m: 160, route: null });
    expect(bodies.map((b) => b.costing)).toEqual(['pedestrian', 'pedestrian']);
    // Through the provider, from the profile's mode.
    const p = server(() => ok(0.24), () => ok(0.3));
    const facts = await lookupFacts([{ name: 'walk', type: 'detour', mode: 'walk', at: '$.g' }], { g: section }, new GsiFactProvider({ routing: p.router }));
    expect(facts.walk).toMatchObject({ missing: false, values: { extra_m: 60 } });
    expect(p.bodies.map((b) => b.costing)).toEqual(['pedestrian', 'pedestrian']);
  });

  it('give the route only to a fact with route: true', async () => {
    const shaped = () => Response.json({ trip: { summary: { length: 0.3 }, legs: [{ shape: 'kz}fbAo~upiG??' }] } });
    const ask = async (route?: boolean) => {
      const { router } = server(() => ok(0.24), shaped);
      const facts = await lookupFacts([{ name: 'walk', type: 'detour', mode: 'walk', at: '$.g', ...(route !== undefined && { route }) }], { g: section }, new GsiFactProvider({ routing: router }));
      const walk = facts.walk;
      return walk && !walk.missing ? walk.values.route : 'missing';
    };
    expect(await ask(true)).toBe('kz}fbAo~upiG??');
    expect(await ask()).toBeNull();
    expect(await ask(false)).toBeNull();
  });

  it('need a section, not a point', async () => {
    const { router } = server();
    await expect(router.detour({ type: 'Point', coordinates: [139.75, 35.70] })).rejects.toThrow(FactError);
  });

  it('come through the GSI provider when routing is configured', async () => {
    const { router } = server(() => ok(0.24), () => ok(0.3));
    const facts = await lookupFacts([{ name: 'detour', type: 'detour', at: '$.g' }], { g: section }, new GsiFactProvider({ routing: router }));
    expect(facts.detour).toMatchObject({ missing: false, values: { possible: true, extra_m: 60 } });
    expect((await lookupFacts([{ name: 'detour', type: 'detour', at: '$.g' }], { g: section }, new GsiFactProvider())).detour).toEqual({ missing: true, reason: 'unavailable' });
  });
});

describe('routing API key', () => {
  // Built at run time: no key-looking literal in the repository (secret scanning).
  const key = crypto.randomUUID();
  const recording = (res: () => Response) => {
    const headers: Headers[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      headers.push(new Headers(init?.headers));
      return res();
    }) as typeof fetch;
    return { headers, fetchFn };
  };

  it('is sent as x-api-key, and only when set', async () => {
    const withKey = recording(() => ok(0.24));
    await new ValhallaRouter(URL_, withKey.fetchFn, key).detour(section).catch(() => {});
    expect(withKey.headers.length).toBeGreaterThan(0);
    for (const h of withKey.headers) expect(h.get('x-api-key')).toBe(key);
    const without = recording(() => ok(0.24));
    await new ValhallaRouter(URL_, without.fetchFn).detour(section).catch(() => {});
    for (const h of without.headers) expect(h.has('x-api-key')).toBe(false);
    const empty = recording(() => ok(0.24));
    await new ValhallaRouter(URL_, empty.fetchFn, '').detour(section).catch(() => {});
    for (const h of empty.headers) expect(h.has('x-api-key')).toBe(false);
  });

  it('a refused key or too many requests is an error with the status, without the key', async () => {
    for (const status of [403, 429]) {
      const { fetchFn } = recording(() => Response.json({ message: 'no' }, { status }));
      const err = await new ValhallaRouter(URL_, fetchFn, key).detour(section).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactError);
      expect(String((err as Error).message)).toBe(`routing ${status}`);
      expect(String((err as Error).message)).not.toContain(key);
    }
  });

  it('a redirect is not followed: it is an error', async () => {
    // Bodies with Valhalla's "no path" (442) and "too many vertices" (176) codes too.
    const bodies = [null, { error_code: 442 }, { error_code: 176 }];
    for (const status of [301, 302, 307, 308]) {
      for (const body of bodies) {
        const headers = { location: 'https://elsewhere.test/route' };
        const { fetchFn } = recording(() => (body ? Response.json(body, { status, headers }) : new Response(null, { status, headers })));
        const err = await new ValhallaRouter(URL_, fetchFn, key).detour(section).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(FactError);
        expect(String((err as Error).message)).toBe(`routing ${status}`);
        expect(String((err as Error).message)).not.toContain(key);
      }
    }
  });
});

describe('FACTS_ROUTING_URL', () => {
  const base = { PROFILE_SOURCE: 'bundled', MODEL_MODE: 'mock', TOKENS: env.TOKENS, DB: env.DB };

  it('needs FACTS_MODE gsi and a valid https URL', () => {
    expect(depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_URL: URL_ }).facts).toBeInstanceOf(GsiFactProvider);
    expect(() => depsFor({ ...base, FACTS_MODE: 'mock', FACTS_ROUTING_URL: URL_ })).toThrow(ConfigError);
    expect(() => depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_URL: 'http://routing.test' })).toThrow(ConfigError);
    expect(() => depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_URL: 'https://routing.test/v1?key=x' })).toThrow(ConfigError);
    expect(() => depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_URL: 'https://routing.test:bad' })).toThrow(ConfigError);
    // Built at run time: no credential-looking URL in the repository (secret scanning).
    const withLogin = new URL('https://routing.test');
    withLogin.username = 'u';
    withLogin.password = crypto.randomUUID();
    expect(() => depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_URL: withLogin.toString() })).toThrow(ConfigError);
  });

  it('FACTS_ROUTING_API_KEY needs FACTS_ROUTING_URL', () => {
    const key = crypto.randomUUID();
    expect(depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_URL: URL_, FACTS_ROUTING_API_KEY: key }).facts).toBeInstanceOf(GsiFactProvider);
    expect(() => depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_API_KEY: key })).toThrow(ConfigError);
    // An empty secret counts as unset.
    expect(depsFor({ ...base, FACTS_MODE: 'gsi', FACTS_ROUTING_API_KEY: '' }).facts).toBeInstanceOf(GsiFactProvider);
  });
});
