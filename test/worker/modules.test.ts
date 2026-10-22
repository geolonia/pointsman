// Fact modules in the Worker (docs/modules.md): routing a fact to its
// module, what a module may answer, and the versions recorded with each
// decision.

import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noCallbacks } from './helpers';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { factModules, lookupFacts, MockFactProvider, ModuleRouter, resultError, type FactProvider } from '../../src/facts';
import { D1DecisionLog } from '../../src/log-d1';
import { FactMissingError, type FactModuleEntry } from '../../src/modules/api';
import { inside } from '../../src/modules/capabilities';
import { useFactModules } from '../../src/modules/registry';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import { ENGINE_VERSION } from '../../src/version';
import type { FactSpec, Profile } from '../../src/types';
import modules from '../../generated/modules';
import * as contract from '../../generated/openapi-validators.mjs';

const point = { type: 'Point', coordinates: [139.753, 35.6855] };
const HEAD = 'a'.repeat(40);
const state = { location: point, pr: { repo: 'octo/repo', number: 1, head: HEAD } };
const answer = (values: Record<string, unknown>): FactProvider => ({ lookup: async () => ({ values: values as never, source: 'test' }) });

// A made-up module: a second answer for `inside` (its own layer), and a type of its own with a probability.
const floods: FactModuleEntry = {
  name: '@example/facts-floods',
  version: '2.1.0',
  roles: ['facts'],
  capabilities: [{ type: 'inside', layers: ['example-flood'] }],
  types: [{
    ...inside,
    type: 'example/confidence',
    description: 'example/confidence: a test type.',
    fields: { score: { kind: 'number', probability: true } },
    settings: {},
    required: [],
    mock: { score: 0.5 },
    cases: { nullable: [], defaults: {} },
  }],
  reasons: { flooded_sensor: { en: 'the sensor is under water', ja: 'センサーが水没' } },
  settings: [],
  create: () => new MockFactProvider(),
};

afterEach(() => {
  useFactModules(modules);
});

describe('ModuleRouter', () => {
  it('sends each fact to the module of its type and layer', async () => {
    useFactModules([...modules, floods]);
    const router = new ModuleRouter(new Map<string, FactProvider | undefined>([
      ['@pointsman/facts-gsi', answer({ inside: true, rank: 3, class: 'gsi' })],
      ['@example/facts-floods', answer({ inside: false, rank: 0, class: '' })],
    ]));
    const facts = await lookupFacts([
      { name: 'a', type: 'inside', layer: 'gsi-flood-max', at: '$.location' },
      { name: 'b', type: 'inside', layer: 'example-flood', at: '$.location' },
      { name: 'c', type: 'inside', layer: 'nobody', at: '$.location' },
      { name: 'd', type: 'detour', at: '$.location' },
    ], state, router);
    expect(facts.a).toMatchObject({ missing: false, values: { class: 'gsi' } });
    expect(facts.b).toMatchObject({ missing: false, values: { class: '' } });
    // No module serves the layer: unavailable. A detour needs a section: no_location.
    expect(facts.c).toEqual({ missing: true, reason: 'unavailable' });
    expect(facts.d).toEqual({ missing: true, reason: 'no_location' });
  });

  it('a module that is off makes its facts unavailable', async () => {
    const router = new ModuleRouter(new Map([['@pointsman/facts-github', undefined]]));
    expect((await lookupFacts([{ name: 'pr', type: 'github_pr', at: '$.pr' }], state, router)).pr).toEqual({ missing: true, reason: 'unavailable' });
  });
});

describe('what a module may answer', () => {
  it('a probability field must be from 0 to 1', () => {
    useFactModules([...modules, floods]);
    expect(resultError('example/confidence', { values: { score: 0.9 }, source: 'x' })).toBeNull();
    expect(resultError('example/confidence', { values: { score: 1.2 }, source: 'x' })).toMatch(/from 0 to 1/);
    expect(resultError('example/confidence', { values: { score: -0.1 }, source: 'x' })).toMatch(/from 0 to 1/);
  });

  it('a missing reason counts only when a chosen module declares it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: FactProvider = { lookup: () => Promise.reject(new FactMissingError('flooded_sensor', 'sensor')) };
    const spec: FactSpec[] = [{ name: 'f', type: 'inside', layer: 'gsi-flood-max', at: '$.location' }];
    expect((await lookupFacts(spec, state, failing)).f).toEqual({ missing: true, reason: 'error' });
    useFactModules([...modules, floods]);
    expect((await lookupFacts(spec, state, failing)).f).toEqual({ missing: true, reason: 'flooded_sensor' });
  });

  it('a type no chosen module answers is unavailable', async () => {
    useFactModules(modules.filter((m) => m.name !== '@pointsman/facts-github'));
    expect((await lookupFacts([{ name: 'pr', type: 'github_pr', at: '$.pr' }], state, new MockFactProvider())).pr)
      .toEqual({ missing: true, reason: 'unavailable' });
  });
});

describe('versions', () => {
  const profile: Profile = {
    id: 'versions-check',
    version: 1,
    title: { en: 'Versions', ja: 'バージョン' },
    description: { en: 'Versions.', ja: 'バージョン。' },
    model: 'mock',
    questions: [{ name: 'ok', type: 'noul', instructions: 'Is it fine?' }],
    facts: [
      { name: 'flood', type: 'inside', layer: 'gsi-flood-max', at: '$.location' },
      { name: 'pr', type: 'github_pr', at: '$.pr' },
    ],
    policy: { default: 'review' },
  };

  it('lists the modules that answer a profile\'s facts', () => {
    expect(factModules(profile.facts!)).toEqual({ '@pointsman/facts-gsi': ENGINE_VERSION, '@pointsman/facts-github': ENGINE_VERSION });
    expect(factModules([{ name: 'x', type: 'inside', layer: 'unknown', at: '$.x' }])).toEqual({});
  });

  it('are returned and logged with every decision', async () => {
    const TOKEN = newToken();
    const tokens = new MemoryTokenStore();
    tokens.records.set(await hashToken(TOKEN), { client: 'test', profiles: ['*'], created_at: '' });
    const plain: Profile = { ...profile, id: 'plain', facts: [] };
    const deps: Deps = {
      callbacks: noCallbacks, store: new MemoryProfileStore([profile, plain]), tokens,
      log: new D1DecisionLog(env.DB), adapterFor: () => new MockAdapter(), facts: new MockFactProvider(),
    };
    const app = createApp(() => deps);
    const headers = { authorization: `Bearer ${TOKEN}` };
    for (const [id, versions] of [
      ['versions-check', { engine: ENGINE_VERSION, modules: { '@pointsman/facts-gsi': ENGINE_VERSION, '@pointsman/facts-github': ENGINE_VERSION } }],
      ['plain', { engine: ENGINE_VERSION, modules: {} }],
    ] as const) {
      const res = await app.request(`/v1/decide/${id}`, { method: 'POST', headers, body: JSON.stringify({ state }) }, env);
      const d = await res.json<any>();
      expect(contract.decision(d), JSON.stringify(contract.decision.errors)).toBe(true);
      expect(d.versions).toEqual(versions);
      const logged = await (await app.request(`/v1/decisions/${d.decision_id}`, { headers }, env)).json<any>();
      expect(contract.decisionRecord(logged), JSON.stringify(contract.decisionRecord.errors)).toBe(true);
      expect(logged.versions).toEqual(versions);
    }
  });
});
