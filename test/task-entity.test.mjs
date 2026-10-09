// The bridge's Task entities (bridge/src/bridge.ts) against the Task model's
// JSON Schema and context (datamodels.jp, pinned copy in test/fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { toTaskEntity } from '../bridge/src/bridge.ts';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/datamodels/task/${name}`, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema(fixture('geometry.schema.json'));
const validate = ajv.compile(fixture('schema.json'));
const context = fixture('context.jsonld')['@context'];

/** The key-values values of a normalized entity, as the schema describes them. */
function values(entity) {
  const out = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k === '@context') continue;
    if (k === 'id' || k === 'type') out[k] = v;
    else if (v.type === 'Relationship') out[k] = v.object;
    else out[k] = v.value?.['@value'] ?? v.value;
  }
  return out;
}

const decision = { decision_id: '7d20731d-5cc8-4315-97ba-1576c5466269', action: 'review', profile: 'road-restriction-check', profile_version: 1, model: 'clef-flash', created_at: '2026-07-08T01:46:12.000Z', answers: {} };
const entity = { id: 'urn:ngsi-ld:RoadRestriction:0001', type: 'RoadRestriction', roadName: { type: 'Property', value: '県道12号' } };
const ID = 'urn:ngsi-ld:Task:0f3c2a9b6d1e4f5a8b7c6d5e4f3a2b1c';
const options = { actions: ['review', 'urgent'], name: 'roadName', priority: { urgent: 1, review: 5 } };

test('a Task entity from the bridge matches the data model schema', () => {
  for (const [d, o] of [[decision, options], [{ ...decision, action: 'urgent' }, options], [decision, { actions: ['review'] }]]) {
    const kv = values(toTaskEntity(d, entity, o, ID));
    assert.ok(validate(kv), JSON.stringify(validate.errors));
  }
});

test('the published context defines every term the bridge writes', () => {
  const task = toTaskEntity(decision, entity, options, ID);
  // name is an NGSI-LD core term; the others come from the Task context.
  for (const term of Object.keys(task)) {
    if (['@context', 'id', 'type', 'name'].includes(term)) continue;
    assert.ok(term in context, `${term} is not in the Task context`);
  }
  assert.ok('Task' in context);
});

test('the schema catches what the bridge must not write', () => {
  const kv = values(toTaskEntity(decision, entity, options, ID));
  assert.ok(!validate({ ...kv, progress: 'pending' }));
  assert.ok(!validate({ ...kv, priority: 10 }));
  assert.ok(!validate({ ...kv, decision: 'urn:ngsi-ld:Decision:x' }), 'no attributes outside the model');
});
