// Earthquake facts from J-SHIS (地震ハザードステーション, NIED), FACTS_MODE
// "gsi" (real public data), for Japan. All layers answer `inside`; a place is
// "inside" when J-SHIS has its 250 m mesh, and rank and class say how much:
//
//   jshis-shaking-6lower-30y    chance of intensity 6-lower or more within
//                               30 years (T30_I55_PS), in the classes of the
//                               national seismic hazard map
//   jshis-shaking-6upper-30y    the same for 6-upper or more (T30_I60_PS)
//   jshis-ground-amplification  surface ground amplification (ARV), in bands
//                               for rules (ours, not J-SHIS's)
//   jshis-landform              landform class (JNAME), rank is J-SHIS's
//                               landform code (JCODE); a Point only
//
// The exact value goes into the fact's `source`, with the mesh code. J-SHIS
// data may be used and edited with credit; the credit is in `source`
// (https://www.j-shis.bosai.go.jp/agreement). J-SHIS answers by mesh, so
// answers are kept per mesh for a day: in memory and in the Workers cache.

import {
  along, distanceTo, FactError, FactUnavailableError,
  type FactProvider, type FactResult, type Geometry, type Position, type SpatialFactQuery,
} from '@pointsman/module-api';
import { JSHIS_LAYERS } from './definition';

export { JSHIS_LAYERS };

const USER_AGENT = 'pointsman (+https://github.com/geolonia/pointsman)';
const TTL_S = 86_400;
const MEMORY_ENTRIES = 256;
const LOAD_TIMEOUT_MS = 10_000;
/**
 * A line is sampled every 100 m; at most this many meshes per lookup (about
 * 2 km). Each mesh is one request with cold caches, and Workers open few
 * connections at once, so more would not fit in the 3 s of `inside`.
 */
const MAX_MESHES = 8;
/** Sample spacing along a line, and the most samples; a longer line is refused, so spacing never grows. */
const STEP_M = 100;
const MAX_SAMPLES = 200;
/** After a 403 (J-SHIS's request limit), no requests for this long. */
const BLOCKED_MS = 120_000;

const BASE = 'https://www.j-shis.bosai.go.jp/map/api';
/** The newest hazard model (average case, all earthquakes) and ground model. */
const HAZARD_MODEL = 'Y2024';
const GROUND_MODEL = 'V3';

type Layer = keyof typeof JSHIS_LAYERS;
type Band = { from: number; rank: number; class: string };

/** Classes of the national seismic hazard map (地震調査研究推進本部): about once in 30,000, 1,000, 500 and 100 years. */
const PROBABILITY: Band[] = [
  { from: 0, rank: 1, class: 'below 0.1%' },
  { from: 0.001, rank: 2, class: '0.1% to 3%' },
  { from: 0.03, rank: 3, class: '3% to 6%' },
  { from: 0.06, rank: 4, class: '6% to 26%' },
  { from: 0.26, rank: 5, class: '26% or more' },
];

/** Bands of the amplification factor, for rules; the higher, the stronger the shaking at the surface. */
const AMPLIFICATION: Band[] = [
  { from: 0, rank: 1, class: 'below 1.0' },
  { from: 1.0, rank: 2, class: '1.0 to 1.4' },
  { from: 1.4, rank: 3, class: '1.4 to 1.6' },
  { from: 1.6, rank: 4, class: '1.6 to 2.0' },
  { from: 2.0, rank: 5, class: '2.0 or more' },
];

const SHAKING: Record<string, { attr: string; label: string }> = {
  'jshis-shaking-6lower-30y': { attr: 'T30_I55_PS', label: '震度6弱以上' },
  'jshis-shaking-6upper-30y': { attr: 'T30_I60_PS', label: '震度6強以上' },
};

/** One mesh's answer: the properties, or null where J-SHIS has no data (the sea, outside Japan). */
type Mesh = { code: string; props: Record<string, string> | null };

export interface JshisOptions {
  fetch?: typeof fetch;
  /** The Workers cache; leave out to use only memory. */
  cache?: Cache | undefined;
  /** For tests: the clock for the memory cache. */
  now?: () => number;
}

export class JshisFactProvider implements FactProvider<SpatialFactQuery> {
  private readonly fetchFn: typeof fetch;
  private readonly cache: Cache | undefined;
  private readonly memory = new Map<string, { mesh: Promise<Mesh>; until: number }>();
  private readonly now: () => number;
  /** Until when J-SHIS is not asked, after a 403. */
  private blockedUntil = 0;

  constructor({ fetch: fetchFn, cache, now }: JshisOptions = {}) {
    // A wrapper, not fetch itself: Workers refuse an unbound global fetch.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.cache = cache;
    this.now = now ?? Date.now;
  }

  async lookup(query: SpatialFactQuery, signal: AbortSignal): Promise<FactResult> {
    if (query.type !== 'inside') throw new FactUnavailableError(`J-SHIS has no ${query.type}`);
    const layer = query.layer !== undefined && Object.hasOwn(JSHIS_LAYERS, query.layer) ? (query.layer as Layer) : undefined;
    if (!layer) throw new FactUnavailableError(`unknown layer "${query.layer}"`);
    if (layer === 'jshis-landform' && query.geometry.type !== 'Point') throw new FactError('layer "jshis-landform" needs a Point');
    // As in facts-gsi: a load is shared, so one lookup's signal must not cancel it.
    void signal;
    const codes = meshesAlong(query.geometry);
    if (codes.length > MAX_MESHES) throw new FactError('geometry spans too many meshes');
    const meshes = await Promise.all(codes.map((code) => this.mesh(layer, code)));
    return answer(layer, meshes);
  }

  private mesh(layer: Layer, code: string): Promise<Mesh> {
    const url = urlFor(layer, code);
    const now = this.now();
    const hit = this.memory.get(url);
    if (hit && hit.until > now) return hit.mesh;
    const entry = { mesh: this.load(url, code, layer), until: now + TTL_S * 1000 };
    // A failed load is not kept: the next decision tries again.
    entry.mesh.catch(() => {
      if (this.memory.get(url) === entry) this.memory.delete(url);
    });
    this.memory.delete(url); // re-insert at the end: the oldest entry goes first
    this.memory.set(url, entry);
    if (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
    return entry.mesh;
  }

  private async load(url: string, code: string, layer: Layer): Promise<Mesh> {
    // A cache that fails is a miss, never an error.
    const cached = this.cache ? await this.cache.match(url).catch(() => undefined) : undefined;
    if (cached) {
      try {
        return parseMesh(code, await cached.text(), layer);
      } catch {
        await this.cache!.delete(url).catch(() => {}); // unreadable: fetch it again
      }
    }
    if (this.now() < this.blockedUntil) throw new FactError('J-SHIS 403 (waiting before asking again)');
    const res = await this.fetchFn(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
    // 404 with a NOT_FOUND body: no data here (the sea, outside Japan).
    // 403: J-SHIS's answer when its request limit is exceeded.
    if (!res.ok && res.status !== 404) {
      if (res.status === 403) this.blockedUntil = this.now() + BLOCKED_MS;
      await res.body?.cancel().catch(() => {}); // free the connection
      throw new FactError(`J-SHIS ${res.status}`);
    }
    const text = await res.text();
    // Parsed first: only an answer that can be read goes into the shared cache.
    let mesh: Mesh;
    try {
      mesh = parseMesh(code, text, layer);
    } catch (e) {
      throw res.status === 404 ? new FactError('J-SHIS 404') : e;
    }
    if (this.cache) {
      const stored = new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${TTL_S}` } });
      await this.cache.put(url, stored).catch(() => {}); // a cache miss next time is fine
    }
    return mesh;
  }
}

function urlFor(layer: Layer, code: string): string {
  const [lon, lat] = meshCentre(code);
  const position = `position=${lon.toFixed(6)},${lat.toFixed(6)}&epsg=4326`;
  const shaking = SHAKING[layer];
  if (shaking) return `${BASE}/pshm/${HAZARD_MODEL}/AVR/TTL_MTTL/meshinfo.geojson?${position}&attr=${shaking.attr}`;
  // Amplification and landform share one answer (and one cache entry).
  return `${BASE}/sstrct/${GROUND_MODEL}/meshinfo.geojson?${position}`;
}

/**
 * J-SHIS's answer for one mesh, with the values the layer needs checked, so
 * a broken answer is never cached. Throws on anything but data or "no data
 * here". Error messages carry no mesh code: a mesh code is a location, and
 * errors are logged.
 */
export function parseMesh(code: string, text: string, layer: Layer): Mesh {
  let json: { status?: unknown; error?: { code?: unknown }; features?: { properties?: Record<string, unknown> }[] };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new FactError('J-SHIS answer is not JSON');
  }
  if (json.status === 'Error' && json.error?.code === 'NOT_FOUND') return { code, props: null };
  const props = json.status === 'Success' ? json.features?.[0]?.properties : undefined;
  if (!props) throw new FactError(`J-SHIS answer without data (${String(json.error?.code ?? json.status)})`);
  // The mesh J-SHIS used must be the one asked for: a different one means the mesh grid changed.
  if (props.meshcode !== code) throw new FactError('J-SHIS answered for another mesh');
  const out = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v)]));
  // Amplification and landform share one answer, so it must have both.
  const numbers = SHAKING[layer] ? [SHAKING[layer].attr] : ['ARV', 'JCODE'];
  for (const key of numbers) {
    const value = out[key] === undefined || out[key] === '' ? NaN : Number(out[key]);
    if (!Number.isFinite(value) || value < 0) throw new FactError(`J-SHIS ${key} is not a number`);
  }
  if (!SHAKING[layer] && !out.JNAME) throw new FactError('J-SHIS landform without a name');
  return { code, props: out };
}

function answer(layer: Layer, meshes: Mesh[]): FactResult {
  const found = meshes.filter((m): m is Mesh & { props: Record<string, string> } => m.props !== null);
  const shaking = SHAKING[layer];
  if (found.length === 0) {
    const source = shaking ? hazardSource(shaking.label, '該当メッシュなし') : groundSource('該当メッシュなし');
    return { values: { inside: false, rank: 0, class: '' }, source };
  }
  if (layer === 'jshis-landform') {
    const { code, props } = found[0]!;
    // Both checked in parseMesh.
    const rank = Number(props.JCODE);
    const name = props.JNAME ?? '';
    return { values: { inside: true, rank, class: name }, source: groundSource(`メッシュ ${code}：${name}`) };
  }
  // The highest band along the geometry; its mesh and value go into the source.
  let worst: { band: Band; value: number; mesh: Mesh & { props: Record<string, string> } } | undefined;
  for (const mesh of found) {
    const value = Number(shaking ? mesh.props[shaking.attr] : mesh.props.ARV); // checked in parseMesh
    const band = bandOf(shaking ? PROBABILITY : AMPLIFICATION, value);
    if (!worst || band.rank > worst.band.rank || (band.rank === worst.band.rank && value > worst.value)) worst = { band, value, mesh };
  }
  const { band, value, mesh } = worst!;
  const source = shaking
    ? hazardSource(shaking.label, `メッシュ ${mesh.code}：${percent(value)}`)
    : groundSource(`メッシュ ${mesh.code}：増幅率 ${value.toFixed(2)}${mesh.props.AVS ? `、AVS30 ${Math.round(Number(mesh.props.AVS))} m/s` : ''}${mesh.props.JNAME ? `、${mesh.props.JNAME}` : ''}`);
  return { values: { inside: true, rank: band.rank, class: band.class }, source };
}

function bandOf(bands: Band[], value: number): Band {
  let out = bands[0]!;
  for (const b of bands) if (value >= b.from) out = b;
  return out;
}

const percent = (p: number) => `${(p * 100).toFixed(p < 0.001 ? 3 : 2)}%`;

const hazardSource = (label: string, detail: string) =>
  `防災科研 J-SHIS 確率論的地震動予測地図（${HAZARD_MODEL}、平均ケース・全地震、30年${label}の確率）を加工して作成（${detail}）`;
const groundSource = (detail: string) => `防災科研 J-SHIS 表層地盤（${GROUND_MODEL}）を加工して作成（${detail}）`;

/**
 * The 250 m meshes along the geometry (sampled every 100 m), in order, each
 * once. A line that only cuts a corner of a mesh (less than 100 m in it) may
 * miss that mesh.
 */
export function meshesAlong(g: Geometry): string[] {
  if (g.type === 'LineString') {
    const ps = g.coordinates;
    const length = ps.slice(1).reduce((sum, p, i) => sum + distanceTo(p, { type: 'Point', coordinates: ps[i]! }), 0);
    if (length > STEP_M * (MAX_SAMPLES - 1)) throw new FactError('line too long');
  }
  const places: Position[] = g.type === 'Point' ? [g.coordinates] : along(g, STEP_M, MAX_SAMPLES);
  return [...new Set(places.map(meshCode))];
}

// The standard grid of Japan (JIS X 0410), in minutes: 1st mesh 40' × 60',
// 2nd 5' × 7.5', 3rd 30" × 45" (about 1 km), then halves twice (500 m, 250 m),
// each numbered 1 SW, 2 SE, 3 NW, 4 NE. J-SHIS's 250 m mesh code has 10 digits.
const LAT = [40, 5, 0.5, 0.25, 0.125];
const LON = [60, 7.5, 0.75, 0.375, 0.1875];

/**
 * Whole 250 m cells from the grid's origin. A value a hair below a grid line
 * (35.7 × 480 is 17135.999…) counts as on it, so a point on a line always
 * falls into the mesh north or east of it, as in the standard.
 */
function cells(value: number): number {
  const near = Math.round(value);
  return Math.abs(value - near) < 1e-6 ? near : Math.floor(value);
}

/** The 10-digit 250 m mesh code of a position (WGS 84; JGD2011 differs by far less than a mesh). */
export function meshCode([lon, lat]: Position): string {
  if (lat < 20 || lat >= 46 || lon < 122 || lon >= 154) throw new FactUnavailableError('J-SHIS covers Japan only');
  // In 250 m cells, both axes divide the same way: 320 per 1st mesh, 40 per
  // 2nd, 4 per 3rd, then 2 per 500 m half.
  const y = cells((lat * 60) / LAT[4]!);
  const x = cells(((lon - 100) * 60) / LON[4]!);
  const digits = (n: number) => [Math.floor(n / 320), Math.floor((n % 320) / 40), Math.floor((n % 40) / 4), Math.floor((n % 4) / 2), n % 2];
  const [p, q, r, ny, qy] = digits(y);
  const [u, v, w, nx, qx] = digits(x);
  return `${p}${u}${q}${v}${r}${w}${1 + nx! + 2 * ny!}${1 + qx! + 2 * qy!}`;
}

/** The centre of a 10-digit mesh, [lon, lat]. */
export function meshCentre(code: string): Position {
  const d = [...code].map(Number);
  let lat = (d[0]! * 10 + d[1]!) * LAT[0]! + d[4]! * LAT[1]! + d[6]! * LAT[2]!;
  let lon = (d[2]! * 10 + d[3]!) * LON[0]! + d[5]! * LON[1]! + d[7]! * LON[2]!;
  for (const [i, n] of [[3, d[8]!], [4, d[9]!]] as const) {
    if (n === 3 || n === 4) lat += LAT[i]!;
    if (n === 2 || n === 4) lon += LON[i]!;
  }
  return [100 + (lon + LON[4]! / 2) / 60, (lat + LAT[4]! / 2) / 60];
}
