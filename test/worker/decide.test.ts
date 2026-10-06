// Integration tests through the Worker's fetch handler, with the bundled
// example profiles and the mock model (see wrangler.jsonc). Responses are
// checked against openapi.yaml.

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as contract from '../../generated/openapi-validators.mjs';
import type { Validator } from '../../generated/openapi-validators.mjs';

const BASE = 'http://pointsman.test';

function post(path: string, body: unknown, raw = false) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function json(res: Response, validator: Validator) {
  const data = await res.json();
  expect(validator(data), JSON.stringify(validator.errors)).toBe(true);
  return data as any;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const issue = { issue: { title: 'Login page is blank', body: 'Since this morning.' } };

describe('POST /v1/decide/{profile}', () => {
  it('returns a decision that matches openapi.yaml', async () => {
    const res = await post('/v1/decide/issue-triage', { state: issue, ref: 'example:1' });
    expect(res.status).toBe(200);
    const d = await json(res, contract.decision);
    expect(d.decision_id).toMatch(UUID);
    expect(d).toMatchObject({
      ref: 'example:1',
      profile: 'issue-triage',
      profile_version: 1,
      model: 'mock',
      // Mock: team.p = 0.9, and the rule is team.p >= 0.85.
      action: 'auto',
    });
    expect(d.answers.team).toMatchObject({ type: 'choice', value: 'backend', p: 0.9 });
    expect(d.answers.urgent).toEqual({ type: 'noul', value: false, p: 0.8, yes: 0.2 });
    expect(d.answers.effort).toMatchObject({ type: 'score', value: 0, p: 0.7 });
  });

  it('gives each decision its own id', async () => {
    const a = await (await post('/v1/decide/issue-triage', { state: issue })).json<any>();
    const b = await (await post('/v1/decide/issue-triage', { state: issue })).json<any>();
    expect(a.decision_id).not.toBe(b.decision_id);
  });

  it('accepts a text state for a profile without input mapping', async () => {
    const res = await post('/v1/decide/deploy-progress', { state: 'No stack event for 40 minutes.' });
    expect(res.status).toBe(200);
    const d = await json(res, contract.decision);
    expect(d.ref).toBeUndefined();
    // Mock: stuck.yes = 0.2, below both rules.
    expect(d.action).toBe('continue');
  });

  it('serves a given version', async () => {
    expect((await post('/v1/decide/issue-triage?version=1', { state: issue })).status).toBe(200);
  });

  it.each([
    ['unknown profile', '/v1/decide/no-such-profile', 404, 'profile_not_found'],
    ['unknown version', '/v1/decide/issue-triage?version=99', 404, 'profile_not_found'],
    ['invalid version', '/v1/decide/issue-triage?version=1.5', 400, 'invalid_request'],
  ])('%s', async (_, path, status, code) => {
    const res = await post(path, { state: issue });
    expect(res.status).toBe(status);
    expect((await json(res, contract.error)).error.code).toBe(code);
  });

  it.each([
    ['invalid JSON', '{"state":', true],
    ['an array body', [issue], false],
    ['missing state', { ref: 'x' }, false],
    ['null state', { state: null }, false],
    ['a number state', { state: 3 }, false],
    ['an empty text state', { state: ' ' }, false],
    ['an unknown field', { state: issue, extra: 1 }, false],
    ['an empty ref', { state: issue, ref: '' }, false],
    ['a too long ref', { state: issue, ref: 'x'.repeat(201) }, false],
    ['an http callback_url', { state: issue, callback_url: 'http://example.com/cb' }, false],
    ['an invalid callback_url', { state: issue, callback_url: 'not a url' }, false],
    ['a state without any mapped input field', { state: { other: 1 } }, false],
  ])('rejects %s with 400', async (_, body, raw) => {
    const res = await post('/v1/decide/issue-triage', body, raw);
    expect(res.status).toBe(400);
    expect((await json(res, contract.error)).error.code).toBe('invalid_request');
  });

  it('accepts an https callback_url', async () => {
    const res = await post('/v1/decide/issue-triage', { state: issue, callback_url: 'https://example.com/cb' });
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/profiles', () => {
  it('lists the bundled profiles', async () => {
    const res = await exports.default.fetch(`${BASE}/v1/profiles`);
    expect(res.status).toBe(200);
    const { profiles } = await json(res, contract.profileList);
    expect(profiles.map((p: any) => p.id)).toEqual(['deploy-progress', 'issue-triage']);
    expect(profiles[1]).toMatchObject({ version: 1, versions: [1], title: { en: 'Issue triage' } });
  });
});

describe('other routes', () => {
  it('answers 404 in the error format', async () => {
    const res = await exports.default.fetch(`${BASE}/v1/nothing`);
    expect(res.status).toBe(404);
    expect((await json(res, contract.error)).error.code).toBe('not_found');
  });

  it('answers 404 for GET on the decide endpoint', async () => {
    const res = await exports.default.fetch(`${BASE}/v1/decide/issue-triage`);
    expect(res.status).toBe(404);
  });
});
