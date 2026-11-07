// Values from the request (packages/facts-field, field_number/text/flag):
// exact values, missing reasons, and a rules-only decision without a model.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { noCallbacks } from './helpers';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { D1DecisionLog } from '../../src/log-d1';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import * as contract from '../../generated/openapi-validators.mjs';
import { FieldFactProvider } from '@pointsman/facts-field';
import { FactMissingError, MAX_FIELD_TEXT } from '@pointsman/module-api';
import { lookupFacts, resultError } from '../../src/facts';
import { depsFor } from '../../src/index';
import type { FactSpec, Profile } from '../../src/types';

const provider = new FieldFactProvider();
const base = { PROFILE_SOURCE: 'bundled', MODEL_MODE: 'mock', TOKENS: env.TOKENS, DB: env.DB };

describe('the field provider', () => {
  it('gives the value exactly as sent', async () => {
    expect(await provider.lookup({ type: 'field_number', value: 1981 })).toEqual({ values: { value: 1981 }, source: 'request' });
    expect(await provider.lookup({ type: 'field_text', value: '601' })).toEqual({ values: { value: '601' }, source: 'request' });
    expect(await provider.lookup({ type: 'field_flag', value: false })).toEqual({ values: { value: false }, source: 'request' });
  });

  it('never converts: another kind is missing as wrong_kind, and the message has no value', async () => {
    for (const [type, value] of [
      ['field_number', '1981'], ['field_number', Number.NaN], ['field_number', true],
      ['field_text', 1981], ['field_text', 'x'.repeat(MAX_FIELD_TEXT + 1)], ['field_text', ['601']],
      ['field_flag', 'true'], ['field_flag', 1],
    ] as const) {
      const err = await provider.lookup({ type, value }).catch((e: unknown) => e);
      expect(err, `${type} ${String(value)}`).toBeInstanceOf(FactMissingError);
      expect((err as FactMissingError).reason).toBe('wrong_kind');
      // A fixed text that names the expected kind only: never the value (it may be logged).
      expect((err as Error).message).toMatch(/^expected (a number|a text of at most \d+ characters|true or false)$/);
    }
  });
});

describe('the engine', () => {
  it('refuses a field_text result longer than the type allows, also from another module', () => {
    expect(resultError('field_text', { values: { value: 'x'.repeat(MAX_FIELD_TEXT) }, source: 'request' })).toBeNull();
    expect(resultError('field_text', { values: { value: 'x'.repeat(MAX_FIELD_TEXT + 1) }, source: 'request' })).toMatch(/at most 64 characters/);
  });
});

describe('field facts in a decision', () => {
  const specs: FactSpec[] = [
    { name: 'year', type: 'field_number', at: '$.yearOfConstruction.value' },
    { name: 'structure', type: 'field_text', at: '$.buildingStructureType.value' },
    { name: 'checked', type: 'field_flag', at: '$.selfCheck' },
  ];

  it('are looked up with every FACTS_MODE, also off', async () => {
    for (const mode of ['off', 'mock', 'gsi']) {
      const deps = depsFor({ ...base, FACTS_MODE: mode } as never);
      const facts = await lookupFacts(specs, { yearOfConstruction: { value: 1975 }, buildingStructureType: { value: '601' }, selfCheck: true }, deps.facts);
      expect(facts, mode).toEqual({
        year: { missing: false, values: { value: 1975 }, source: 'request' },
        structure: { missing: false, values: { value: '601' }, source: 'request' },
        checked: { missing: false, values: { value: true }, source: 'request' },
      });
    }
  });

  it('are missing with a reason: no_value when absent or null, wrong_kind otherwise', async () => {
    const deps = depsFor({ ...base, FACTS_MODE: 'off' } as never);
    const facts = await lookupFacts(specs, { yearOfConstruction: { value: '1975' }, buildingStructureType: { value: null } }, deps.facts);
    expect(facts).toEqual({
      year: { missing: true, reason: 'wrong_kind' },
      structure: { missing: true, reason: 'no_value' },
      checked: { missing: true, reason: 'no_value' },
    });
  });
});

describe('a rules-only profile with field facts, end to end', () => {
  const profile: Profile = {
    id: 'building-check', version: 1, title: { en: 'B', ja: 'B' }, description: { en: 'B', ja: 'B' }, model: 'none', questions: [],
    facts: [
      { name: 'year', type: 'field_number', at: '$.yearOfConstruction.value' },
      { name: 'structure', type: 'field_text', at: '$.buildingStructureType.value' },
    ],
    policy: {
      rules: [
        { when: 'facts.year.missing == true or facts.structure.missing == true', action: 'more-evidence' },
        { when: "facts.year.value <= 1981 and facts.structure.value == '601'", action: 'high' },
      ],
      default: 'low',
    },
  };
  const TOKEN = newToken();
  const tokens = new MemoryTokenStore();
  const headers = { authorization: `Bearer ${TOKEN}` };

  async function decide(state: unknown) {
    tokens.records.set(await hashToken(TOKEN), { client: 'test', profiles: ['*'], created_at: '' });
    const model = new MockAdapter();
    const asked = vi.spyOn(model, 'decide');
    // FACTS_MODE off: only the field module is on, as a deployment without spatial data.
    const deps: Deps = { callbacks: noCallbacks, store: new MemoryProfileStore([profile]), tokens, log: new D1DecisionLog(env.DB), adapterFor: () => model, facts: depsFor({ ...base, FACTS_MODE: 'off' } as never).facts };
    const app = createApp(() => deps);
    const res = await app.request('/v1/decide/building-check', { method: 'POST', headers, body: JSON.stringify({ state }) }, env);
    expect(res.status).toBe(200);
    const d = await res.json<any>();
    expect(contract.decision(d), JSON.stringify(contract.decision.errors)).toBe(true);
    const logged = await (await app.request(`/v1/decisions/${d.decision_id}`, { headers }, env)).json<any>();
    expect(logged.facts).toEqual(d.facts);
    expect(asked).not.toHaveBeenCalled();
    return d;
  }

  it('decides by rules on the values, without a model, and records the facts', async () => {
    const d = await decide({ yearOfConstruction: { value: 1975 }, buildingStructureType: { value: '601' } });
    expect(d).toMatchObject({ action: 'high', rule: 1, model: 'none' });
    expect(d.facts).toEqual({ year: { missing: false, values: { value: 1975 }, source: 'request' }, structure: { missing: false, values: { value: '601' }, source: 'request' } });
  });

  it('asks for evidence when a value is missing or of another kind, and gives the default otherwise', async () => {
    expect(await decide({ buildingStructureType: { value: '601' } })).toMatchObject({ action: 'more-evidence', rule: 0, facts: { year: { missing: true, reason: 'no_value' } } });
    expect(await decide({ yearOfConstruction: { value: '1975' }, buildingStructureType: { value: '601' } })).toMatchObject({ action: 'more-evidence', facts: { year: { missing: true, reason: 'wrong_kind' } } });
    expect(await decide({ yearOfConstruction: { value: 2005 }, buildingStructureType: { value: '601' } })).toMatchObject({ action: 'low', rule: null });
  });
});
