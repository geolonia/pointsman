// Values from the request (packages/facts-field, field_number/text/flag):
// exact values, missing reasons, and a rules-only decision without a model.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { FieldFactProvider } from '@pointsman/facts-field';
import { FactMissingError, MAX_FIELD_TEXT } from '@pointsman/module-api';
import { lookupFacts } from '../../src/facts';
import { depsFor } from '../../src/index';
import type { FactSpec } from '../../src/types';

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
