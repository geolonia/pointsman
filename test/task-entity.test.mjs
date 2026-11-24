// The bridge's Task entities (packages/fiware/src/tasks.ts) against the Task model's
// JSON Schema and context (datamodels.jp, pinned copy in test/fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { handleMessage, toTaskEntity } from '../packages/fiware/src/bridge.ts';

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
const ID = 'urn:ngsi-ld:Task:example-1';
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

/**
 * The Tasks the bridge leaves in a broker after these decisions for one
 * entity (handleMessage, with a fake broker that keeps Task entities and
 * applies the bridge's updates and deletes).
 */
async function tasksAfter(decisions, task = { actions: ['review'], name: 'roadName', priority: { review: 5 } }) {
  const tasks = new Map();
  let asked = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.host === 'pm.test') return Response.json(decisions[asked++]);
    if (url.pathname === '/ngsi-ld/v1/entities' && method === 'POST') {
      if (body.type !== 'Task') return new Response(null, { status: 201 });
      if (tasks.has(body.id)) return new Response(null, { status: 409 });
      tasks.set(body.id, body);
      return new Response(null, { status: 201 });
    }
    const m = /^\/ngsi-ld\/v1\/entities\/([^/]+)(?:\/attrs(?:\/([^/]+))?)?$/.exec(url.pathname);
    const found = m && tasks.get(decodeURIComponent(m[1]));
    if (found && method === 'GET') return Response.json(found);
    if (found && method === 'POST') {
      Object.assign(found, body);
      return new Response(null, { status: 204 });
    }
    if (found && method === 'DELETE' && m[2]) {
      delete found[decodeURIComponent(m[2])];
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: method === 'GET' || method === 'PATCH' ? 404 : 204 });
  };
  const route = { type: 'RoadRestriction', profile: 'road-restriction-check', inputs: ['roadName'], attribute: 'check', task };
  const config = { routes: [route], notifySecret: 's', pointsman: { url: 'https://pm.test', token: 't' }, broker: { url: 'https://broker.test' }, fetch };
  for (let i = 0; i < decisions.length; i++) {
    const result = await handleMessage({ path: '/notify', entity }, config);
    assert.ok('write' in result, JSON.stringify(result));
  }
  return tasks;
}

test('a completed Task from the bridge matches the data model schema', async () => {
  // A retry after a person resolved the review: the Task is written completed, with their action.
  const resolved = { ...decision, review: { status: 'resolved', final_action: 'reject', resolved_at: '2026-07-08T03:00:00.000Z' } };
  const tasks = await tasksAfter([resolved]);
  assert.equal(tasks.size, 1);
  const kv = values([...tasks.values()][0]);
  assert.equal(kv.progress, 'completed');
  assert.equal(kv.statusLabel, 'reject');
  assert.equal(kv.completedAt, '2026-07-08T03:00:00.000Z');
  assert.ok(validate(kv), JSON.stringify(validate.errors));
});

test('a cancelled Task from the bridge matches the data model schema', async () => {
  // A review first (an open Task), then, for the same inputs, an action that needs no person.
  const tasks = await tasksAfter([decision, { ...decision, decision_id: '0b8f7d1e-4a52-4f63-9a1c-2f0e5d6c7b8a', action: 'publish' }]);
  assert.equal(tasks.size, 1);
  const kv = values([...tasks.values()][0]);
  assert.equal(kv.progress, 'cancelled');
  assert.equal(kv.statusLabel, 'publish');
  assert.ok(validate(kv), JSON.stringify(validate.errors));
});
