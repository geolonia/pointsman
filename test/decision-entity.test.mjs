// The bridge's Decision entities (bridge/src/bridge.ts) against the data
// model's own JSON Schema (docs/data-model/decision/). Node runs the bridge's
// TypeScript directly (type stripping); Ajv cannot run in the Workers tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { toDecisionEntity } from '../bridge/src/bridge.ts';

const schema = JSON.parse(readFileSync(new URL('../docs/data-model/decision/Decision/schema.json', import.meta.url), 'utf8'));
// Formats are not checked here (no ajv-formats); the bridge test checks the dates.
const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);

/** The key-values values of a normalized entity, as the schema describes them. */
function values(entity) {
  const out = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k === '@context') continue;
    if (k === 'id' || k === 'type') out[k] = v;
    else if (v.type === 'Relationship') out[k] = v.object;
    else if (v.type === 'JsonProperty') out[k] = v.json;
    else if (v.type === 'VocabProperty') out[k] = v.vocab;
    else out[k] = v.value?.['@value'] ?? v.value;
  }
  return out;
}

const route = { type: 'RoadRestriction', profile: 'road-restriction-check', inputs: ['description'], attribute: 'check' };
const decision = {
  decision_id: '7d20731d-5cc8-4315-97ba-1576c5466269',
  action: 'review',
  profile: 'road-restriction-check',
  profile_version: 1,
  model: 'clef-flash',
  created_at: '2026-07-08T01:46:12.000Z',
  rule: null,
  // As Pointsman returns them (src/types.ts Answer).
  answers: {
    category: { type: 'choice', value: 'closedWeather', p: 0.81, probabilities: { closedWeather: 0.81, other: 0.19 } },
    danger: { type: 'noul', value: false, p: 0.58, yes: 0.42 },
    clarity: { type: 'score', value: 3, p: 0.74, score: 2.6, probabilities: { 0: 0.02, 1: 0.06, 2: 0.18, 3: 0.74 } },
  },
};

test('a Decision entity from the bridge matches the data model schema', () => {
  for (const d of [decision, { ...decision, action: 'publish', rule: 1 }]) {
    const kv = values(toDecisionEntity(d, 'urn:ngsi-ld:RoadRestriction:0001', route));
    assert.ok(validate(kv), JSON.stringify(validate.errors));
  }
});

test('the schema catches what the bridge must not write', () => {
  const kv = values(toDecisionEntity(decision, 'urn:ngsi-ld:RoadRestriction:0001', route));
  assert.ok(!validate({ ...kv, policyRule: '-1' }));
  assert.ok(!validate({ ...kv, humanInvolvement: 'HumanNotInvolved' }));
  const { refersTo: _, ...withoutTarget } = kv;
  assert.ok(!validate(withoutTarget), 'refersTo or externalReference is required');
});
