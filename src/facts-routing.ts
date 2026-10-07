// The `detour` fact from a Valhalla routing server (FACTS_ROUTING_URL): how
// much longer is the drive between the two ends of a closed section when the
// section is closed? Data: OpenStreetMap. Lessons from the spike
// (docs/spikes/spatial-facts.md, review of #63):
//
// - Valhalla drops every road an exclusion polygon touches, and a route
//   cannot start or end on a dropped road. So the ends of the section stay
//   open: the polygon covers the section without its first and last 20 m,
//   measured along it.
// - If that still leaves no route (a short section, or one road edge that
//   runs past both ends), a small box at the middle closes it instead.
// - No polygon may cover either end; a section too short for that fails.
// - "No route" (Valhalla error 442) with the section closed cannot tell "no
//   way around" from "the road edge at an end is closed too", so it is an
//   error, like any other failure; this provider never says possible: false.

import { FactError, type FactResult, type Geometry, type Position } from './facts';
import { distance, offset } from './geo';

const USER_AGENT = 'pointsman (+https://github.com/geolonia/pointsman)';
const TIMEOUT_MS = 10_000;
/** Metres around the closed section that the polygon covers. */
const HALF_WIDTH = 10;
/** Metres at each end that stay open. */
const OPEN_ENDS = 20;
/** Longer sections are refused before any sampling (CPU and memory stay bounded). */
const MAX_SECTION_M = 5000;
/** Rectangles for the closed section: 5 vertices each, under Valhalla's default limit of 100. */
const MAX_RECTS = 19;

/** Valhalla error 176: the exclusion polygons have more vertices than the server allows. */
class TooManyVertices extends FactError {}
const SOURCE = '© OpenStreetMap contributors (ODbL), routed with Valhalla';

export class ValhallaRouter {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, fetchFn?: typeof fetch) {
    this.url = url.replace(/\/+$/, '');
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  /**
   * The detour fact for a closed section (a LineString). `signal` is the
   * lookup's time limit: once it fires, no further request starts.
   */
  async detour(g: Geometry, signal?: AbortSignal): Promise<FactResult> {
    if (g.type !== 'LineString') throw new FactError('a detour needs a LineString');
    const ps = g.coordinates;
    const a = ps[0]!;
    const b = ps[ps.length - 1]!;
    let length = 0;
    for (let i = 1; i < ps.length; i++) length += distance(ps[i - 1]!, ps[i]!);
    if (length > MAX_SECTION_M) throw new FactError(`section longer than ${MAX_SECTION_M / 1000} km`);
    const run = measure(ps, 5);
    const total = run[run.length - 1]!.at;
    // The closures to try, in order, each a list of polygons; none may cover
    // either end, or "no route" would only say that the route cannot start.
    //  1. The section without its open ends, as one rectangle per segment of
    //     the simplified line: rectangles never cross themselves (a U-shaped
    //     section stays covered), and at most MAX_RECTS keep the vertices
    //     under Valhalla's default limit of 100.
    //  2. A small box at the middle.
    const closures: Position[][][] = [];
    const inner = run.filter((s) => s.at >= OPEN_ENDS && s.at <= total - OPEN_ENDS).map((s) => s.p);
    if (inner.length >= 2) {
      // Wider by the simplification's tolerance, so the whole road stays covered.
      const { line, tolerance } = simplify(inner, MAX_RECTS + 1);
      closures.push(rectangles(line, HALF_WIDTH + tolerance));
    }
    const half = Math.min(8, total / 2 - 2);
    if (half >= 1) closures.push([corridor([pointAt(run, total / 2)], half)]);
    const usable = closures.filter((polys) => polys.every((poly) => !inside(a, poly) && !inside(b, poly)));
    if (usable.length === 0) throw new FactError('section too short to close without closing its ends');

    const direct = await this.route(a, b, undefined, signal);
    if (direct === null) throw new FactError('no route along the section itself');
    for (const polygons of usable) {
      let around: number | null;
      try {
        around = await this.route(a, b, polygons, signal);
      } catch (err) {
        // A server with a lower vertex limit than the default refuses the
        // closure (error 176): try the next, smaller one.
        if (err instanceof TooManyVertices) continue;
        throw err;
      }
      if (around !== null) return { values: { possible: true, extra_m: Math.max(0, around - direct) }, source: SOURCE };
    }
    // Valhalla closes whole road edges: if one edge runs past an end, "no
    // path" may only mean that the route cannot start. That is not proof of
    // no way around, so it is an error, never possible: false.
    throw new FactError('no route with the section closed (no way around, or a closed road edge at an end)');
  }

  /** Driving distance in metres, or null when Valhalla finds no route. */
  private async route(from: Position, to: Position, exclude: Position[][] | undefined, signal?: AbortSignal): Promise<number | null> {
    signal?.throwIfAborted();
    const body = {
      locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }],
      costing: 'auto',
      units: 'kilometers',
      ...(exclude && { exclude_polygons: exclude }),
    };
    const limit = AbortSignal.timeout(TIMEOUT_MS);
    const res = await this.fetchFn(`${this.url}/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    const json = (await res.json().catch(() => null)) as { trip?: { summary?: { length?: unknown } }; error_code?: unknown } | null;
    if (!res.ok) {
      if (json?.error_code === 442) return null; // no path
      if (json?.error_code === 176) throw new TooManyVertices('routing: too many polygon vertices');
      throw new FactError(`routing ${res.status}${typeof json?.error_code === 'number' ? ` (${json.error_code})` : ''}`);
    }
    const km = json?.trip?.summary?.length;
    if (typeof km !== 'number' || !Number.isFinite(km)) throw new FactError('routing answer has no length');
    return Math.round(km * 1000);
  }
}

type Sample = { p: Position; at: number };

/** Positions along the line every `step` metres or less, with their distance from the start along it. */
function measure(ps: Position[], step: number): Sample[] {
  const out: Sample[] = [{ p: ps[0]!, at: 0 }];
  let at = 0;
  for (let i = 1; i < ps.length; i++) {
    const from = ps[i - 1]!;
    const to = ps[i]!;
    const len = distance(from, to);
    const n = Math.max(1, Math.ceil(len / step));
    for (let j = 1; j <= n; j++) out.push({ p: [from[0] + ((to[0] - from[0]) * j) / n, from[1] + ((to[1] - from[1]) * j) / n], at: at + (len * j) / n });
    at += len;
  }
  return out;
}

/** The position `at` metres along the line. */
function pointAt(run: Sample[], at: number): Position {
  const k = run.findIndex((s) => s.at >= at);
  if (k <= 0) return run[Math.max(0, k)]!.p;
  const s0 = run[k - 1]!;
  const s1 = run[k]!;
  const t = s1.at > s0.at ? (at - s0.at) / (s1.at - s0.at) : 0;
  return [s0.p[0] + (s1.p[0] - s0.p[0]) * t, s0.p[1] + (s1.p[1] - s0.p[1]) * t];
}

/** Point in polygon (ray casting; good enough for small polygons in lon/lat). */
export function inside([x, y]: Position, ring: Position[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** One rectangle around each segment, `r` metres to each side. */
function rectangles(ps: Position[], r: number): Position[][] {
  const out: Position[][] = [];
  for (let i = 1; i < ps.length; i++) out.push(corridor([ps[i - 1]!, ps[i]!], r));
  return out;
}

/**
 * The line with at most `max` positions (Douglas-Peucker, tolerance raised
 * until it fits), keeping both ends; `tolerance` is the largest distance in
 * metres between the original line and the simplified one.
 */
export function simplify(ps: Position[], max: number): { line: Position[]; tolerance: number } {
  if (ps.length <= max) return { line: ps, tolerance: 0 };
  const k = Math.cos((ps[0]![1] * Math.PI) / 180);
  const toM = (p: Position) => [p[0] * k * 111_320, p[1] * 110_574] as const;
  const xy = ps.map(toM);
  const off = (i: number, a: number, b: number) => {
    const [px, py] = xy[i]!;
    const [ax, ay] = xy[a]!;
    const [bx, by] = xy[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  for (let tol = 0.5; ; tol *= 2) {
    const keep = new Set([0, ps.length - 1]);
    const stack: [number, number][] = [[0, ps.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      let worst = -1;
      let at = -1;
      for (let i = a + 1; i < b; i++) {
        const d = off(i, a, b);
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > tol) { keep.add(at); stack.push([a, at], [at, b]); }
    }
    if (keep.size <= max) return { line: [...keep].sort((x, y) => x - y).map((i) => ps[i]!), tolerance: tol };
  }
}

/** One polygon around a line, `r` metres to each side; around a point, a square. */
export function corridor(ps: Position[], r: number): Position[] {
  if (ps.length === 1) {
    const p = ps[0]!;
    return [offset(p, -r, -r), offset(p, r, -r), offset(p, r, r), offset(p, -r, r), offset(p, -r, -r)];
  }
  const side = (i: number, sign: 1 | -1): Position => {
    const prev = ps[Math.max(0, i - 1)]!;
    const next = ps[Math.min(ps.length - 1, i + 1)]!;
    const k = Math.cos((ps[i]![1] * Math.PI) / 180);
    const dx = (next[0] - prev[0]) * k;
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    return offset(ps[i]!, sign * (-dy / len) * r, sign * (dx / len) * r);
  };
  const left = ps.map((_, i) => side(i, 1));
  const right = ps.map((_, i) => side(i, -1)).reverse();
  return [...left, ...right, left[0]!];
}
