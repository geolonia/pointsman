// Spatial facts (src/facts.ts): checking locations and results, lookups that
// fail, and decisions whose rules use facts, stored in the decision log.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { noCallbacks } from './helpers';
import { ConfigError, createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { lookupFacts, MockFactProvider, resultError, toGeometry, type FactProvider } from '../../src/facts';
import { depsFor } from '../../src/index';
import { D1DecisionLog } from '../../src/log';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { FactSpec, Profile } from '../../src/types';
import * as contract from '../../generated/openapi-validators.mjs';

const line = { type: 'LineString', coordinates: [[139.7505, 35.695], [139.752, 35.6956]] };
const point = { type: 'Point', coordinates: [139.753, 35.6855] };

describe('locations', () => {
  it('accepts GeoJSON Points and LineStrings in WGS 84', () => {
    expect(toGeometry(point)).toEqual(point);
    expect(toGeometry(line)).toEqual(line);
    // A height is dropped.
    expect(toGeometry({ type: 'Point', coordinates: [139.7, 35.6, 12] })).toEqual({ type: 'Point', coordinates: [139.7, 35.6] });
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'Point'],
    ['a polygon', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }],
    ['latitude out of range', { type: 'Point', coordinates: [139.7, 95] }],
    ['longitude out of range', { type: 'Point', coordinates: [190, 35] }],
    ['text coordinates', { type: 'Point', coordinates: ['139.7', '35.6'] }],
    ['one position in a line', { type: 'LineString', coordinates: [[139.7, 35.6]] }],
    ['too many positions', { type: 'LineString', coordinates: Array.from({ length: 1001 }, (_, i) => [139 + i / 1e4, 35]) }],
  ])('refuses %s', (_, value) => {
    expect(toGeometry(value)).toBeNull();
  });
});

describe('results', () => {
  it('fit the fact type', () => {
    expect(resultError('inside', { values: { inside: true, rank: 4, class: '1 to 3 m' }, source: 'gsi' })).toBeNull();
    expect(resultError('nearest', { values: { found: false, distance_m: null, name: null }, source: 'gsi' })).toBeNull();
  });

  it.each([
    ['no source', 'inside', { values: { inside: true, rank: 1, class: 'x' } }, 'source'],
    ['an unknown field', 'inside', { values: { inside: true, rank: 1, class: 'x', depth: 3 }, source: 's' }, 'unknown field "depth"'],
    ['a missing field', 'detour', { values: { possible: true }, source: 's' }, 'missing field "extra_m"'],
    ['a wrong type', 'nearest', { values: { found: 'yes', distance_m: 1, name: 'a' }, source: 's' }, '"found" must be a boolean'],
    ['an infinite number', 'detour', { values: { possible: true, extra_m: Infinity }, source: 's' }, 'finite'],
  ] as const)('refuse %s', (_, type, result, message) => {
    expect(resultError(type, result)).toContain(message);
  });
});

describe('lookups', () => {
  const specs: FactSpec[] = [
    { name: 'flood', type: 'inside', layer: 'flood', at: '$.location.value' },
    { name: 'detour', type: 'detour', at: '$.location.value' },
  ];
  const state = (geometry: unknown) => ({ location: { type: 'GeoProperty', value: geometry } });

  it('look up every fact, with the layer and the location', async () => {
    const calls: unknown[] = [];
    const provider: FactProvider = { lookup: async (q) => (calls.push(q), new MockFactProvider().lookup(q)) };
    expect(await lookupFacts(specs, state(line), provider)).toEqual({
      flood: { missing: false, values: { inside: true, rank: 1, class: 'mock' }, source: 'mock' },
      detour: { missing: false, values: { possible: true, extra_m: 0 }, source: 'mock' },
    });
    expect(calls).toEqual([{ type: 'inside', layer: 'flood', geometry: line }, { type: 'detour', geometry: line }]);
  });

  it('record why a fact is missing, and never throw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mock = new MockFactProvider();
    // No location; a detour needs a line.
    expect(await lookupFacts(specs, { text: 'no place' }, mock)).toEqual({
      flood: { missing: true, reason: 'no_location' }, detour: { missing: true, reason: 'no_location' },
    });
    expect((await lookupFacts(specs, state(point), mock)).detour).toEqual({ missing: true, reason: 'no_location' });
    // No provider configured.
    expect((await lookupFacts(specs, state(line), undefined)).flood).toEqual({ missing: true, reason: 'unavailable' });
    // The provider fails, answers too late, or answers the wrong shape.
    const failing: FactProvider = { lookup: async () => { throw new Error('tiles down'); } };
    expect((await lookupFacts(specs, state(line), failing)).flood).toEqual({ missing: true, reason: 'error' });
    let aborted = false;
    const slow: FactProvider = {
      lookup: (_q, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; });
        setTimeout(() => resolve({ values: { inside: true, rank: 1, class: '' }, source: 's' }), 200);
      }),
    };
    expect((await lookupFacts(specs.slice(0, 1), state(line), slow, 20)).flood).toEqual({ missing: true, reason: 'timeout' });
    expect(aborted).toBe(true);
    const wrong: FactProvider = { lookup: async () => ({ values: { inside: 'yes' }, source: 's' }) as never };
    expect((await lookupFacts(specs, state(line), wrong)).flood).toEqual({ missing: true, reason: 'error' });
    // Errors are logged without the location.
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain('139.75');
    vi.restoreAllMocks();
  });
});

describe('decisions with facts', () => {
  // A profile like the demo's road restriction check, with facts in the rules.
  const profile: Profile = {
    id: 'place-check',
    version: 1,
    title: { en: 'Place check', ja: '場所の確認' },
    description: { en: 'Test', ja: 'テスト' },
    model: 'mock',
    input: [{ name: 'description', path: '$.description.value' }],
    questions: [{ name: 'danger', type: 'noul', instructions: 'Are people in danger?' }],
    facts: [
      { name: 'flood', type: 'inside', layer: 'flood', at: '$.location.value' },
      { name: 'shelter', type: 'nearest', layer: 'shelters', at: '$.location.value' },
    ],
    policy: {
      rules: [
        // Mock: danger.yes 0.2, flood rank 1, shelter 250 m.
        { when: 'facts.flood.rank >= 1 and danger.yes >= 0.1', action: 'urgent' },
        { when: 'facts.flood.missing == true', action: 'review' },
      ],
      default: 'publish',
    },
  };
  const TOKEN = newToken();
  const tokens = new MemoryTokenStore();
  const headers = { authorization: `Bearer ${TOKEN}` };
  const report = { description: { type: 'Property', value: 'Underpass flooded' }, location: { type: 'GeoProperty', value: line } };

  async function decide(facts: FactProvider | undefined, state: unknown = report) {
    tokens.records.set(await hashToken(TOKEN), { client: 'test', profiles: ['*'], created_at: '' });
    const deps: Deps = {
      callbacks: noCallbacks, store: new MemoryProfileStore([profile]), tokens,
      log: new D1DecisionLog(env.DB), adapterFor: () => new MockAdapter(), facts,
    };
    const app = createApp(() => deps);
    const res = await app.request('/v1/decide/place-check', { method: 'POST', headers, body: JSON.stringify({ state }) }, env);
    expect(res.status).toBe(200);
    const d = await res.json<any>();
    expect(contract.decision(d), JSON.stringify(contract.decision.errors)).toBe(true);
    const logged = await (await app.request(`/v1/decisions/${d.decision_id}`, { headers }, env)).json<any>();
    expect(contract.decisionRecord(logged), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
    expect(logged.facts).toEqual(d.facts);
    return d;
  }

  it('use the facts in the rules, and record them', async () => {
    const d = await decide(new MockFactProvider());
    expect(d).toMatchObject({ action: 'urgent', rule: 0 });
    expect(d.facts).toEqual({
      flood: { missing: false, values: { inside: true, rank: 1, class: 'mock' }, source: 'mock' },
      shelter: { missing: false, values: { found: true, distance_m: 250, name: 'Mock feature' }, source: 'mock' },
    });
  });

  it('skip rules that need a missing fact, and let a rule check for it', async () => {
    const d = await decide(undefined);
    expect(d).toMatchObject({ action: 'review', rule: 1 });
    expect(d.facts.flood).toEqual({ missing: true, reason: 'unavailable' });
  });

  it('read the location from what the client sent, not from the mapped state', async () => {
    // The input mapping keeps only the description; the facts still find the location.
    const d = await decide(new MockFactProvider());
    expect(d.facts.flood.missing).toBe(false);
    // Without a location, the facts are missing and the decision is still made.
    const without = await decide(new MockFactProvider(), { description: report.description });
    expect(without).toMatchObject({ action: 'review', facts: { flood: { missing: true, reason: 'no_location' } } });
  });

  it('are left out for profiles without facts', async () => {
    const { facts: _, ...rest } = profile;
    const plain: Profile = { ...rest, id: 'plain', policy: { default: 'review' } };
    tokens.records.set(await hashToken(TOKEN), { client: 'test', profiles: ['*'], created_at: '' });
    const deps: Deps = { callbacks: noCallbacks, store: new MemoryProfileStore([plain]), tokens, log: new D1DecisionLog(env.DB), adapterFor: () => new MockAdapter(), facts: new MockFactProvider() };
    const res = await createApp(() => deps).request('/v1/decide/plain', { method: 'POST', headers, body: JSON.stringify({ state: report }) }, env);
    expect(await res.json()).not.toHaveProperty('facts');
  });
});

describe('FACTS_MODE', () => {
  const base = { PROFILE_SOURCE: 'bundled', MODEL_MODE: 'mock', TOKENS: env.TOKENS, DB: env.DB };

  it('is off unless set, and refuses unknown modes', () => {
    expect(depsFor(base).facts).toBeUndefined();
    expect(depsFor({ ...base, FACTS_MODE: 'off' }).facts).toBeUndefined();
    expect(depsFor({ ...base, FACTS_MODE: 'mock' }).facts).toBeInstanceOf(MockFactProvider);
    expect(() => depsFor({ ...base, FACTS_MODE: 'osm' })).toThrow(ConfigError);
  });
});
