// Small geometry helpers for spatial facts (src/facts.ts): distances on the
// sphere, points along a line, and web map tile numbers. Good to a few
// metres at city scale, which is all the facts need.

import type { Geometry, Position } from './facts';

const R = 6371008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distance([lon1, lat1]: Position, [lon2, lat2]: Position): number {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance from p to the segment a-b in metres (flat approximation around p). */
function toSegment(p: Position, a: Position, b: Position): number {
  const kx = R * Math.cos(rad(p[1])) * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  const [ax, ay, bx, by, px, py] = [a[0] * kx, a[1] * ky, b[0] * kx, b[1] * ky, p[0] * kx, p[1] * ky];
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a position to a Point or LineString, in metres. */
export function distanceTo(p: Position, g: Geometry): number {
  if (g.type === 'Point') return distance(p, g.coordinates);
  let best = Infinity;
  for (let i = 1; i < g.coordinates.length; i++) best = Math.min(best, toSegment(p, g.coordinates[i - 1]!, g.coordinates[i]!));
  return best;
}

/** The average of the geometry's positions. */
export function center(g: Geometry): Position {
  if (g.type === 'Point') return g.coordinates;
  const n = g.coordinates.length;
  return [g.coordinates.reduce((s, p) => s + p[0], 0) / n, g.coordinates.reduce((s, p) => s + p[1], 0) / n];
}

/**
 * Positions along the geometry, about `step` metres apart, at most `max`
 * (a long line gets a larger step).
 */
export function along(g: Geometry, step: number, max: number): Position[] {
  if (g.type === 'Point') return [g.coordinates];
  const ps = g.coordinates;
  let length = 0;
  for (let i = 1; i < ps.length; i++) length += distance(ps[i - 1]!, ps[i]!);
  const s = Math.max(step, length / Math.max(1, max - 1));
  const out: Position[] = [ps[0]!];
  for (let i = 1; i < ps.length && out.length < max; i++) {
    const a = ps[i - 1]!;
    const b = ps[i]!;
    const n = Math.max(1, Math.ceil(distance(a, b) / s));
    for (let j = 1; j <= n && out.length < max; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  return out;
}

/** Web map tile (x, y) at zoom z, and the pixel inside a 256 px tile. */
export function tileOf([lon, lat]: Position, z: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n;
  return { x: Math.floor(x), y: Math.floor(y), px: Math.min(255, Math.floor((x % 1) * 256)), py: Math.min(255, Math.floor((y % 1) * 256)) };
}

/** Moves a position by metres east and north. */
export function offset([lon, lat]: Position, east: number, north: number): Position {
  return [lon + (east / (R * Math.cos(rad(lat)))) * (180 / Math.PI), lat + (north / R) * (180 / Math.PI)];
}
