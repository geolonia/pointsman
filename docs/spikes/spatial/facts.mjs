// Spatial facts for one report, from public sources. For the spike only:
// the public services here are fine for a few hundred calls, not for
// production (see README.md).
//
//   flood    GSI hazard map tiles, river flooding, maximum assumed scale
//            (洪水浸水想定区域 想定最大規模): depth class at the place
//   shelters GSI designated emergency evacuation sites for flooding
//            (指定緊急避難場所, skhb01): nearest ones and their distance
//   routes   Valhalla (FOSSGIS public server, OpenStreetMap): do routes
//            from around the place to the nearest shelter pass the closed
//            section, and how much longer is the way around it?
//   address  GSI reverse geocoder: 市区町村 code and 町字

import { inflateSync } from 'node:zlib';

const UA = 'pointsman-spike (+https://github.com/geolonia/pointsman/issues/60)';
const get = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...init.headers } });
  return res;
};

// ---- geometry ----------------------------------------------------------------

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function distance([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
/** Moves a point by metres east and north. */
const offset = ([lon, lat], east, north) => [lon + (east / (R * Math.cos(rad(lat)))) * (180 / Math.PI), lat + (north / R) * (180 / Math.PI)];
/** Distance from p to segment a-b, in metres (local flat approximation). */
function toSegment(p, a, b) {
  const k = R * Math.cos(rad(p[1])) * (Math.PI / 180), m = R * (Math.PI / 180);
  const [px, py, ax, ay, bx, by] = [p[0] * k, p[1] * m, a[0] * k, a[1] * m, b[0] * k, b[1] * m];
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const points = (g) => (g.type === 'Point' ? [g.coordinates] : g.coordinates);
const center = (g) => { const p = points(g); return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length]; };
/** Distance from a point to a Point or LineString geometry. */
function toGeometry(p, g) {
  const ps = points(g);
  if (ps.length === 1) return distance(p, ps[0]);
  let best = Infinity;
  for (let i = 1; i < ps.length; i++) best = Math.min(best, toSegment(p, ps[i - 1], ps[i]));
  return best;
}
/** Points along a geometry, at most `step` metres apart. */
function along(g, step = 20) {
  const ps = points(g);
  const out = [ps[0]];
  for (let i = 1; i < ps.length; i++) {
    const n = Math.max(1, Math.ceil(distance(ps[i - 1], ps[i]) / step));
    for (let j = 1; j <= n; j++) out.push([ps[i - 1][0] + ((ps[i][0] - ps[i - 1][0]) * j) / n, ps[i - 1][1] + ((ps[i][1] - ps[i - 1][1]) * j) / n]);
  }
  return out;
}
/**
 * One polygon around a line, `r` metres to each side (a corridor). Valhalla
 * refuses many small overlapping polygons, so this is a single ring.
 */
function corridor(ps, r) {
  if (ps.length === 1) { const p = ps[0]; return [offset(p, -r, -r), offset(p, r, -r), offset(p, r, r), offset(p, -r, r), offset(p, -r, -r)]; }
  const side = (i, sign) => {
    const a = ps[Math.max(0, i - 1)], b = ps[Math.min(ps.length - 1, i + 1)];
    const k = Math.cos(rad(ps[i][1]));
    const dx = (b[0] - a[0]) * k, dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    // Perpendicular, extended a little past the ends.
    const ext = i === 0 ? -r : i === ps.length - 1 ? r : 0;
    return offset(ps[i], sign * (-dy / len) * r + (dx / len) * ext, sign * (dx / len) * r + (dy / len) * ext);
  };
  const left = ps.map((_, i) => side(i, 1)), right = ps.map((_, i) => side(i, -1)).reverse();
  return [...left, ...right, left[0]];
}

// ---- tiles -----------------------------------------------------------------------

const tileOf = ([lon, lat], z) => {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n;
  return { x: Math.floor(x), y: Math.floor(y), px: Math.floor((x % 1) * 256), py: Math.floor((y % 1) * 256) };
};

/** A minimal PNG decoder: 8-bit greyscale, RGB, palette or RGBA, not interlaced. */
function decodePng(buf) {
  let pos = 8, width, height, depth, type, palette, trns;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error('interlaced PNG'); }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels] : 0, b = y ? out[(y - 1) * stride + i] : 0, c = y && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
      const pr = () => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      out[y * stride + i] = (line[i] + [0, a, b, (a + b) >> 1, f === 4 ? pr() : 0][f]) & 255;
    }
  }
  return (x, y) => {
    const o = y * stride + x * channels;
    if (type === 3) { const i = out[o]; return [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2], trns && i < trns.length ? trns[i] : 255]; }
    if (type === 6) return [out[o], out[o + 1], out[o + 2], out[o + 3]];
    if (type === 2) return [out[o], out[o + 1], out[o + 2], 255];
    return [out[o], out[o], out[o], type === 4 ? out[o + 1] : 255];
  };
}

const tiles = new Map();
async function pixel(layer, p, z) {
  const t = tileOf(p, z), key = `${layer}/${z}/${t.x}/${t.y}`;
  if (!tiles.has(key)) {
    const res = await get(`https://disaportaldata.gsi.go.jp/raster/${key}.png`);
    tiles.set(key, res.status === 404 ? null : res.ok ? decodePng(Buffer.from(await res.arrayBuffer())) : Promise.reject(new Error(`${key}: ${res.status}`)));
  }
  const read = await tiles.get(key);
  return read ? read(t.px, t.py) : null;
}

// ---- flood -------------------------------------------------------------------------

/**
 * Depth classes by colour: the MLIT hazard map palette (水害ハザードマップ作成の
 * 手引き). Matched to the guideline, not to a legend published with the tiles;
 * older data uses #FFD8C0 for 0.5 to 3 m, so treat the classes as ranks.
 */
const FLOOD = [
  { rgb: [255, 255, 179], depth: 'below 0.3 m', rank: 1 },
  { rgb: [247, 245, 169], depth: '0.3 to 0.5 m', rank: 2 },
  { rgb: [248, 225, 166], depth: '0.5 to 1 m', rank: 3 },
  { rgb: [255, 216, 192], depth: '1 to 3 m', rank: 4 },
  { rgb: [255, 183, 183], depth: '3 to 5 m', rank: 5 },
  { rgb: [255, 145, 145], depth: '5 to 10 m', rank: 6 },
  { rgb: [242, 133, 201], depth: '10 to 20 m', rank: 7 },
  { rgb: [220, 122, 220], depth: '20 m or more', rank: 8 },
];

/** The deepest class along the geometry; a colour not in the palette counts as inside, depth unknown. */
export async function flood(g) {
  let worst = null;
  for (const p of along(g, 15)) {
    const px = await pixel('01_flood_l2_shinsuishin_data', p, 17);
    if (!px || px[3] === 0) continue;
    const c = FLOOD.find((f) => f.rgb.every((v, i) => Math.abs(v - px[i]) <= 6)) ?? { depth: 'unknown', rank: 0 };
    if (!worst || c.rank > worst.rank) worst = c;
  }
  return worst ? { inside: true, depth: worst.depth } : { inside: false };
}

// ---- shelters ---------------------------------------------------------------------

const shelterTiles = new Map();
async function sheltersNear(p) {
  // Published only at zoom 10 (about 35 km per tile here).
  const t = tileOf(p, 10), found = [];
  for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
    const key = `10/${t.x + dx}/${t.y + dy}`;
    if (!shelterTiles.has(key)) {
      const res = await get(`https://cyberjapandata.gsi.go.jp/xyz/skhb01/${key}.geojson`);
      // 404: no sites in this tile. Any other failure must not look like "no sites".
      if (!res.ok && res.status !== 404) throw new Error(`shelter tile ${key}: ${res.status}`);
      shelterTiles.set(key, res.ok ? (await res.json()).features : []);
    }
    found.push(...shelterTiles.get(key));
  }
  return found.map((f) => ({ name: f.properties.name, at: f.geometry.coordinates }));
}

export async function shelters(g) {
  const c = center(g);
  const list = (await sheltersNear(c)).map((s) => ({ ...s, m: Math.round(toGeometry(s.at, g)) })).sort((a, b) => a.m - b.m);
  return { nearest: list[0] ? { name: list[0].name, distance_m: list[0].m } : null, within_500m: list.filter((s) => s.m <= 500).length, list };
}

// ---- routes ------------------------------------------------------------------------

function decodePolyline(s, precision = 6) {
  let i = 0, lat = 0, lon = 0;
  const out = [], f = 10 ** precision;
  const next = () => { let r = 0, shift = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << shift; shift += 5; } while (b >= 32); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { lat += next(); lon += next(); out.push([lon / f, lat / f]); }
  return out;
}

async function route(from, to, exclude, costing = 'pedestrian') {
  const body = { locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }], costing, units: 'kilometers', ...(exclude && { exclude_polygons: exclude }) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await get('https://valhalla1.openstreetmap.de/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    const j = await res.json();
    // Valhalla answers 400 with error_code 442 when there is no path; anything else is a failure.
    if (!res.ok && j.error_code === 442) return null; // no route
    if (!res.ok) throw new Error(`valhalla: ${res.status} ${j.error_code ?? ''}`);
    return { m: Math.round(j.trip.summary.length * 1000), shape: decodePolyline(j.trip.legs[0].shape) };
  }
  throw new Error('valhalla: rate limited');
}

/**
 * From four places 400 m around the report, the walking route to their
 * nearest shelter: does it pass the closed section (within 15 m), and if so,
 * how much longer is the way around it? Walking, because evacuation in a
 * flood is on foot.
 */
export async function routes(g, list) {
  const c = center(g), out = [];
  for (const [e, n] of [[0, 400], [400, 0], [0, -400], [-400, 0]]) {
    const from = offset(c, e, n);
    const near = list.map((s) => ({ ...s, d: distance(from, s.at) })).sort((a, b) => a.d - b.d)[0];
    if (!near) continue;
    const r = await route(from, near.at);
    if (!r) continue;
    // Check the route's segments, not only its vertices: a segment can cross
    // the closed section between two vertices that are both far from it.
    const passes = along({ type: 'LineString', coordinates: r.shape }, 5).some((p) => toGeometry(p, g) <= 15);
    let detour_m = null;
    let reachable = true;
    if (passes) {
      const around = await route(from, near.at, [corridor(points(g), 15)]);
      // JSON has no Infinity: no way around is reachable: false.
      if (around) detour_m = around.m - r.m;
      else reachable = false;
    }
    out.push({ shelter: near.name, length_m: r.m, passes, detour_m, reachable });
  }
  const blocked = out.filter((r) => r.passes);
  return {
    checked: out.length,
    blocked: blocked.length,
    cut_off: blocked.filter((r) => !r.reachable).length,
    max_detour_m: blocked.length ? Math.max(0, ...blocked.map((r) => r.detour_m ?? 0)) : 0,
    routes: out,
  };
}

/**
 * For a closed section (LineString): how much longer is the drive between
 * its two ends when it is closed? A Point has no direction, so no answer.
 */
export async function detour(g) {
  if (g.type !== 'LineString') return null;
  const ps = g.coordinates, a = ps[0], b = ps[ps.length - 1];
  // Start and arrive at the ends, and close a small box in the middle:
  // Valhalla drops every road edge the polygon touches, and a route cannot
  // start or arrive on a dropped edge.
  const pts = along(g, 5);
  if (distance(a, b) < 40) return null; // too short to tell
  const mid = pts[Math.floor(pts.length / 2)];
  const direct = await route(a, b, undefined, 'auto');
  const around = await route(a, b, [corridor([mid], 8)], 'auto');
  return { direct_m: direct?.m ?? null, around_m: around?.m ?? null, extra_m: direct && around ? around.m - direct.m : null };
}

// ---- address -----------------------------------------------------------------------

export async function address(g) {
  const [lon, lat] = center(g);
  const res = await get(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`);
  const r = (await res.json()).results;
  return r ? { muni_code: r.muniCd, area: r.lv01Nm } : null;
}

export async function factsFor(g) {
  const s = await shelters(g);
  const [f, r, d, a] = [await flood(g), await routes(g, s.list), await detour(g), await address(g)];
  return { flood: f, shelters: { nearest: s.nearest, within_500m: s.within_500m }, routes: r, detour: d, address: a };
}
