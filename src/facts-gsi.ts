// Spatial facts from public GSI data (FACTS_MODE "gsi"), for Japan:
//
//   gsi-flood-max       inside   river flood hazard zones, maximum assumed
//                                rainfall (洪水浸水想定区域 想定最大規模), from
//                                the hazard map portal's raster tiles
//   gsi-shelters-flood  nearest  designated emergency evacuation sites for
//                                floods (指定緊急避難場所, 洪水), GeoJSON tiles
//
// Both are free to use, also commercially, with attribution; the attribution
// is in each fact's `source`. Background: docs/spikes/spatial-facts.md.
// Tiles are cached for a day: in memory and in the Workers cache.

import { FactError, FactUnavailableError, type FactProvider, type FactQuery, type FactResult, type Geometry, type Position } from './facts';
import { along, center, distanceTo, offset, tileOf } from './geo';

const USER_AGENT = 'pointsman (+https://github.com/geolonia/pointsman)';
const TILE_TTL_S = 86_400;
const MEMORY_TILES = 64;

/** Depth classes by colour, from the portal's legend (shinsui_legend3.png). */
const FLOOD_CLASSES: { rgb: [number, number, number]; rank: number; class: string }[] = [
  // A map may split "below 0.5 m" at 0.3 m and "0.5 to 3 m" at 1 m; the
  // unsplit colours keep the wider label, so a label is never too precise.
  { rgb: [255, 255, 179], rank: 1, class: 'below 0.3 m' },
  { rgb: [247, 245, 169], rank: 2, class: 'below 0.5 m' },
  { rgb: [248, 225, 166], rank: 3, class: '0.5 to 1 m' },
  { rgb: [255, 216, 192], rank: 4, class: '0.5 to 3 m' },
  { rgb: [255, 183, 183], rank: 5, class: '3 to 5 m' },
  { rgb: [255, 145, 145], rank: 6, class: '5 to 10 m' },
  { rgb: [242, 133, 201], rank: 7, class: '10 to 20 m' },
  { rgb: [220, 122, 220], rank: 8, class: '20 m or more' },
];

const FLOOD = {
  url: (z: number, x: number, y: number) => `https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/${z}/${x}/${y}.png`,
  zoom: 17,
  source: (date: string) => `「ハザードマップポータルサイト」洪水浸水想定区域（想定最大規模）を加工して作成（${date}）`,
};

const SHELTERS = {
  url: (z: number, x: number, y: number) => `https://cyberjapandata.gsi.go.jp/xyz/skhb01/${z}/${x}/${y}.geojson`,
  // Published only at zoom 10 (about 30 km per tile in Japan).
  zoom: 10,
  /** Only sites this close count as found. */
  radius: 5000,
  source: (date: string) => `国土地理院 指定緊急避難場所データ（洪水）を加工して作成（${date}）`,
};

export const GSI_LAYERS = { 'gsi-flood-max': 'inside', 'gsi-shelters-flood': 'nearest' } as const;

type Pixels = (x: number, y: number) => [number, number, number, number];
type Shelter = { at: Position; name: string };
type Tile<T> = { data: T | null; date: string };

export interface GsiOptions {
  fetch?: typeof fetch;
  /** The Workers cache; leave out to use only memory. */
  cache?: Cache | undefined;
}

export class GsiFactProvider implements FactProvider {
  private readonly fetchFn: typeof fetch;
  private readonly cache: Cache | undefined;
  private readonly memory = new Map<string, Promise<Tile<unknown>>>();

  constructor({ fetch: fetchFn, cache }: GsiOptions = {}) {
    // A wrapper, not fetch itself: Workers refuse an unbound global fetch.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.cache = cache;
  }

  async lookup(query: FactQuery, signal: AbortSignal): Promise<FactResult> {
    if (query.type === 'detour') throw new FactUnavailableError('no routing provider');
    const kind = query.layer !== undefined && Object.hasOwn(GSI_LAYERS, query.layer) ? GSI_LAYERS[query.layer as keyof typeof GSI_LAYERS] : undefined;
    if (!kind) throw new FactUnavailableError(`unknown layer "${query.layer}"`);
    if (kind !== query.type) throw new FactError(`layer "${query.layer}" answers ${kind}, not ${query.type}`);
    return kind === 'inside' ? this.flood(query.geometry, signal) : this.shelters(query.geometry, signal);
  }

  /** The deepest class along the geometry, sampled every 15 m (at most 200 places). */
  private async flood(g: Geometry, signal: AbortSignal): Promise<FactResult> {
    const places = along(g, 15, 200).map((p) => ({ p, t: tileOf(p, FLOOD.zoom) }));
    const keys = [...new Set(places.map(({ t }) => `${t.x}/${t.y}`))];
    if (keys.length > 16) throw new FactError('geometry spans too many tiles');
    const tiles = new Map(await Promise.all(keys.map(async (k) => {
      const [x, y] = k.split('/').map(Number) as [number, number];
      return [k, await this.tile(FLOOD.url(FLOOD.zoom, x, y), 'png', signal)] as const;
    })));
    let worst: (typeof FLOOD_CLASSES)[number] | undefined;
    for (const { t } of places) {
      const tile = tiles.get(`${t.x}/${t.y}`)!;
      if (!tile.data) continue; // no tile: outside every zone
      const [r, gr, b, a] = (tile.data as Pixels)(t.px, t.py);
      if (a === 0) continue;
      const c = FLOOD_CLASSES.find((f) => Math.abs(f.rgb[0] - r) <= 6 && Math.abs(f.rgb[1] - gr) <= 6 && Math.abs(f.rgb[2] - b) <= 6);
      // A colour outside the legend means the tiles changed: fail, do not guess.
      if (!c) throw new FactError(`flood tile colour ${r},${gr},${b} is not in the legend`);
      if (!worst || c.rank > worst.rank) worst = c;
    }
    const date = latest([...tiles.values()].map((t) => t.date));
    return {
      values: worst ? { inside: true, rank: worst.rank, class: worst.class } : { inside: false, rank: 0, class: '' },
      source: FLOOD.source(date),
    };
  }

  /** The nearest site within 5 km of the geometry. */
  private async shelters(g: Geometry, signal: AbortSignal): Promise<FactResult> {
    const c = center(g);
    const keys = new Set<string>();
    for (const [e, n] of [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const t = tileOf(offset(c, e * SHELTERS.radius, n * SHELTERS.radius), SHELTERS.zoom);
      keys.add(`${t.x}/${t.y}`);
    }
    const tiles = await Promise.all([...keys].map((k) => {
      const [x, y] = k.split('/').map(Number) as [number, number];
      return this.tile(SHELTERS.url(SHELTERS.zoom, x, y), 'geojson', signal);
    }));
    let best: { d: number; name: string } | undefined;
    for (const tile of tiles) {
      for (const s of (tile.data as Shelter[] | null) ?? []) {
        const d = distanceTo(s.at, g);
        if (d <= SHELTERS.radius && (!best || d < best.d)) best = { d, name: s.name };
      }
    }
    return {
      values: best ? { found: true, distance_m: Math.round(best.d), name: best.name } : { found: false, distance_m: null, name: null },
      source: SHELTERS.source(latest(tiles.map((t) => t.date))),
    };
  }

  /** A tile, decoded; data null when the server has none (404). */
  private tile(url: string, format: 'png' | 'geojson', signal: AbortSignal): Promise<Tile<unknown>> {
    let hit = this.memory.get(url);
    if (!hit) {
      hit = this.load(url, format, signal);
      // A failed load is not kept: the next decision tries again.
      hit.catch(() => this.memory.delete(url));
      this.memory.set(url, hit);
      if (this.memory.size > MEMORY_TILES) this.memory.delete(this.memory.keys().next().value!);
    }
    return hit;
  }

  private async load(url: string, format: 'png' | 'geojson', signal: AbortSignal): Promise<Tile<unknown>> {
    let res = this.cache ? await this.cache.match(url) : undefined;
    if (!res) {
      res = await this.fetchFn(url, { headers: { 'user-agent': USER_AGENT }, signal });
      if (res.status === 404) return { data: null, date: '' };
      if (!res.ok) throw new FactError(`tile ${res.status}`);
      if (this.cache) {
        const stored = new Response(res.clone().body, { headers: { 'cache-control': `public, max-age=${TILE_TTL_S}`, 'last-modified': res.headers.get('last-modified') ?? '' } });
        await this.cache.put(url, stored).catch(() => {}); // a cache miss next time is fine
      }
    }
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    const date = Number.isNaN(modified) ? '' : new Date(modified).toISOString().slice(0, 10);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { data: format === 'png' ? await decodePng(bytes) : shelterList(bytes), date };
  }
}

/** The latest of the tiles' dates, or "date unknown". */
function latest(dates: string[]): string {
  const known = dates.filter(Boolean).sort();
  return known.length ? `${known[known.length - 1]} 時点` : '日付不明';
}

function shelterList(bytes: Uint8Array): Shelter[] {
  const json = JSON.parse(new TextDecoder().decode(bytes)) as { features?: { geometry?: { type?: string; coordinates?: unknown }; properties?: { name?: unknown } }[] };
  const out: Shelter[] = [];
  for (const f of json.features ?? []) {
    const c = f.geometry?.coordinates;
    if (f.geometry?.type !== 'Point' || !Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    out.push({ at: [c[0], c[1]], name: typeof f.properties?.name === 'string' ? f.properties.name : '' });
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" is the zlib format, as in PNG.
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A small PNG decoder: 8-bit greyscale, RGB, palette, grey with alpha or RGBA, not interlaced. */
export async function decodePng(buf: Uint8Array): Promise<Pixels> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let type = -1;
  let palette: Uint8Array | undefined;
  let alpha: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos);
    const kind = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      if (data[8] !== 8) throw new FactError(`PNG bit depth ${data[8]}`);
      type = data[9]!;
      if (data[12] !== 0) throw new FactError('interlaced PNG');
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') alpha = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || width === 0 || height === 0 || (type === 3 && !palette)) throw new FactError('unsupported PNG');
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  idat.reduce((at, d) => (joined.set(d, at), at + d.length), 0);
  const raw = await inflate(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new FactError('PNG data too short');
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new FactError(`PNG filter ${filter}`);
      out[y * stride + i] = (raw[line + i]! + predicted) & 255;
    }
  }
  return (x, y) => {
    const o = y * stride + x * channels;
    switch (type) {
      case 3: {
        const i = out[o]!;
        return [palette![i * 3]!, palette![i * 3 + 1]!, palette![i * 3 + 2]!, alpha && i < alpha.length ? alpha[i]! : 255];
      }
      case 6: return [out[o]!, out[o + 1]!, out[o + 2]!, out[o + 3]!];
      case 2: return [out[o]!, out[o + 1]!, out[o + 2]!, 255];
      case 4: return [out[o]!, out[o]!, out[o]!, out[o + 1]!];
      default: return [out[o]!, out[o]!, out[o]!, 255];
    }
  };
}
