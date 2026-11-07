// Capabilities: shared fact types with fixed fields, defined by the engine
// repository (decided on #145: a new capability is a pull request to this file,
// reviewed like code). A profile asks for `detour` and gets `extra_m`,
// whatever module answers it; the deployment chooses the module.
//
// Node-safe, like api.ts.

import type { DetourMode, FactInput, FactSpec, FactTypeDef } from './api.ts';

export type Position = [number, number];
export type Geometry = { type: 'Point'; coordinates: Position } | { type: 'LineString'; coordinates: Position[] };

export interface SpatialFactQuery {
  type: 'inside' | 'nearest' | 'detour';
  layer?: string;
  /** For `detour`; always set for detours (default drive). */
  mode?: DetourMode;
  /** For `detour`: also return the way around; always set for detours (default false). */
  route?: boolean;
  geometry: Geometry;
}

const MAX_POSITIONS = 1000;

const isPosition = (p: unknown): p is Position =>
  Array.isArray(p) && p.length >= 2 && p.length <= 3 && p.every((n) => typeof n === 'number' && Number.isFinite(n))
  && (p[0] as number) >= -180 && (p[0] as number) <= 180 && (p[1] as number) >= -90 && (p[1] as number) <= 90;

/** A GeoJSON Point or LineString (WGS 84), or null. A third coordinate (height) is dropped. */
export function toGeometry(value: unknown): Geometry | null {
  if (value === null || typeof value !== 'object') return null;
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  if (type === 'Point' && isPosition(coordinates)) return { type, coordinates: [coordinates[0], coordinates[1]] };
  if (type === 'LineString' && Array.isArray(coordinates) && coordinates.length >= 2
    && coordinates.length <= MAX_POSITIONS && coordinates.every(isPosition)) {
    return { type, coordinates: coordinates.map((p: Position) => [p[0], p[1]] as Position) };
  }
  return null;
}

const NO_LOCATION = { en: 'no location in the request', ja: 'リクエストに位置がない' };

/** A place: a GeoJSON Point or LineString. */
const place: FactInput = { read: (value) => toGeometry(value), missing: 'no_location', gloss: NO_LOCATION };
/** A section of road: a LineString. */
const section: FactInput = {
  read: (value) => {
    const g = toGeometry(value);
    return g?.type === 'LineString' ? g : null;
  },
  missing: 'no_location',
  gloss: NO_LOCATION,
};

const LAYER = {
  layer: {
    description: 'Layer id for inside and nearest, configured per deployment (source, licence, attribution).',
    type: 'string',
    pattern: '^[a-z0-9][a-z0-9._-]{0,62}$',
  },
};

const layerQuery = (spec: FactSpec, geometry: unknown): SpatialFactQuery => ({
  type: spec.type as 'inside' | 'nearest',
  ...(spec.layer !== undefined && { layer: spec.layer }),
  geometry: geometry as Geometry,
});

/** Inside an area of a layer; rank and class describe it (for example a flood depth class). Not inside: rank 0, class "". */
export const inside: FactTypeDef = {
  type: 'inside',
  description: 'inside: inside an area of a layer.',
  fields: { inside: { kind: 'boolean' }, rank: { kind: 'number' }, class: { kind: 'string' } },
  input: place,
  settings: LAYER,
  required: ['layer'],
  query: layerQuery,
  timeoutMs: 3000,
  mock: { inside: true, rank: 1, class: 'mock' },
  words: {
    en: {
      describe: (f, s) => `${f}: whether the place (${s.at}) is inside an area of the layer "${s.layer ?? ''}", with the area's rank and class.`,
      fields: { inside: ['the place is inside %', 'the place is not inside %'], rank: 'the rank of %', class: 'the class of %' },
    },
    ja: {
      describe: (f, s) => `${f}：場所（${s.at}）がレイヤー「${s.layer ?? ''}」の範囲内かどうかと、その範囲のランクと区分。`,
      fields: { inside: ['場所が%の範囲内', '場所が%の範囲外'], rank: '%のランク', class: '%の区分' },
    },
  },
  cases: { key: 'inside', absent: { rank: 0, class: '' }, optional: [] },
};

/** The nearest feature of a layer. Not found: found false, no distance or name. */
export const nearest: FactTypeDef = {
  type: 'nearest',
  description: 'nearest: the nearest feature of a layer.',
  fields: { found: { kind: 'boolean' }, distance_m: { kind: 'number' }, name: { kind: 'string' } },
  input: place,
  settings: LAYER,
  required: ['layer'],
  query: layerQuery,
  timeoutMs: 3000,
  mock: { found: true, distance_m: 250, name: 'Mock feature' },
  words: {
    en: {
      describe: (f, s) => `${f}: the nearest feature of the layer "${s.layer ?? ''}" to the place (${s.at}), with its distance and name.`,
      fields: {
        found: ['a nearest % was found', 'no nearest % was found'],
        distance_m: { subject: 'the distance to the nearest %', unit: 'm' },
        name: 'the name of the nearest %',
      },
    },
    ja: {
      describe: (f, s) => `${f}：場所（${s.at}）から最も近い、レイヤー「${s.layer ?? ''}」の地物と、その距離と名前。`,
      fields: {
        found: ['最寄りの%が見つかった', '最寄りの%が見つからない'],
        distance_m: { subject: '最寄りの%までの距離', unit: 'm' },
        name: '最寄りの%の名前',
      },
    },
  },
  cases: { key: 'found', absent: { distance_m: null, name: null }, optional: ['name'] },
};

/**
 * Extra metres around a closed section. No way around: possible false, no
 * extra_m. route: the way around (encoded polyline, precision 6), for people
 * and maps; null when not known.
 */
export const detour: FactTypeDef = {
  type: 'detour',
  description: 'detour: extra metres around a closed section (needs a LineString).',
  fields: { possible: { kind: 'boolean' }, extra_m: { kind: 'number' }, route: { kind: 'string', display: true } },
  input: section,
  settings: {
    mode: { description: 'For detour: by car (drive, the default) or on foot (walk).', enum: ['drive', 'walk'] },
    route: {
      description: 'For detour: also return the way around (route, an encoded polyline). Default false: the route starts and ends at the section, so it is stored with each decision.',
      type: 'boolean',
    },
  },
  query: (spec, geometry): SpatialFactQuery => ({
    type: 'detour',
    mode: spec.mode ?? 'drive',
    route: spec.route === true,
    geometry: geometry as Geometry,
  }),
  // A provider written before the route field gives none: null. The route
  // shows the place, so it is kept only when the profile asks for it.
  normalize: (values, spec) => {
    const route = values.route;
    if (route === undefined || (spec.route !== true && (route === null || typeof route === 'string'))) {
      return { ...values, route: null };
    }
    return values;
  },
  // Two calls at once, one retry: a routing server that starts cold needs a few seconds.
  timeoutMs: 8000,
  mock: { possible: true, extra_m: 0, route: null },
  words: {
    en: {
      describe: (f, s) =>
        `${f}: how much longer the way around the closed section (${s.at}) is ${s.mode === 'walk' ? 'on foot' : 'by car'}${s.route === true ? '; the way itself is kept for people and maps' : ''}.`,
      fields: {
        possible: ['there is a way around (%)', 'there is no way around (%)'],
        extra_m: { subject: 'the extra distance of the way around (%)', unit: 'm' },
      },
    },
    ja: {
      describe: (f, s) =>
        `${f}：通れない区間（${s.at}）を${s.mode === 'walk' ? '歩いて' : '車で'}避けると、どれだけ遠回りになるか${s.route === true ? '。迂回路そのものも、人と地図のために残します' : ''}。`,
      fields: {
        possible: ['迂回路（%）がある', '迂回路（%）がない'],
        extra_m: { subject: '迂回路（%）で遠回りになる距離', unit: 'm' },
      },
    },
  },
  cases: { key: 'possible', absent: { extra_m: null, route: null }, optional: ['route'] },
};

/** The query of a field fact: the value as the request has it (checked by the module). */
export interface FieldFactQuery {
  type: 'field_number' | 'field_text' | 'field_flag';
  value: unknown;
}

/**
 * The longest text a field_text fact takes (UTF-16 code units). Short on
 * purpose: field values are stored with the decision, so field_text is for
 * codes ("601"), not free text.
 */
export const MAX_FIELD_TEXT = 64;

const NO_VALUE = { en: 'no value in the request', ja: 'リクエストに値がない' };

/** Any value at `at`; null or absent is "no value". The module checks its type. */
const anyValue: FactInput = { read: (value) => (value === undefined || value === null ? null : value), missing: 'no_value', gloss: NO_VALUE };

/**
 * A value from the request itself, for rules (decided 2026-11-07): a number,
 * a short text or a yes-or-no, exactly as sent, never converted or guessed.
 * A value of another type is missing ("wrong_kind"), like an absent one
 * ("no_value"). For data the client already has, for example the year a
 * building was built.
 */
function fieldType(type: FieldFactQuery['type'], kind: 'number' | 'string' | 'boolean', what: { en: string; ja: string }, mock: number | string | boolean): FactTypeDef {
  return {
    type,
    description: `${type}: ${what.en} from the request, as sent.`,
    // The engine and test cases check the length too, so a case cannot pass on a value the module refuses.
    fields: { value: kind === 'string' ? { kind, maxLength: MAX_FIELD_TEXT } : { kind } },
    input: anyValue,
    query: (_spec, value): FieldFactQuery => ({ type, value }),
    timeoutMs: 1000,
    mock: { value: mock },
    words: {
      en: {
        describe: (f, s) => `${f}: the ${what.en} in the request (${s.at}).`,
        fields: { value: kind === 'boolean' ? ['% is yes', '% is no'] : 'the value of %' },
      },
      ja: {
        describe: (f, s) => `${f}：リクエストの${what.ja}（${s.at}）。`,
        fields: { value: kind === 'boolean' ? ['%がはい', '%がいいえ'] : '%の値' },
      },
    },
    cases: { nullable: [], defaults: {} },
  };
}

/** A number from the request. */
export const field_number = fieldType('field_number', 'number', { en: 'number', ja: '数値' }, 0);
/** A short text (a code) from the request, at most MAX_FIELD_TEXT characters. */
export const field_text = fieldType('field_text', 'string', { en: 'text', ja: 'テキスト' }, 'mock');
/** A yes-or-no value from the request. */
export const field_flag = fieldType('field_flag', 'boolean', { en: 'yes-or-no value', ja: 'はい・いいえの値' }, true);

/** Every capability, by type. */
export const CAPABILITIES: Record<string, FactTypeDef> = { inside, nearest, detour, field_number, field_text, field_flag };

/** Capabilities whose facts name a layer: a module may serve some layers only. */
export const LAYER_CAPABILITIES = ['inside', 'nearest'];

