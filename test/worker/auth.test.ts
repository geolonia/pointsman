import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { authenticate, canUse, hashToken, isExpired, MemoryTokenStore, newToken, tokenKey } from '../../src/auth';
import * as contract from '../../generated/openapi-validators.mjs';

const BASE = 'http://pointsman.test';
const ALL = newToken();
const TRIAGE_ONLY = newToken();
const REVOKED = newToken();

async function store(token: string, profiles: string[]) {
  const record = { client: 'test', profiles, created_at: '2026-10-06T00:00:00Z' };
  await env.TOKENS.put(tokenKey(await hashToken(token)), JSON.stringify(record));
}

beforeEach(async () => {
  await store(ALL, ['*']);
  await store(TRIAGE_ONLY, ['issue-triage']);
});

function call(path: string, authorization?: string, method = 'POST') {
  return exports.default.fetch(`${BASE}${path}`, {
    method,
    headers: authorization === undefined ? {} : { authorization },
    ...(method === 'POST' && { body: JSON.stringify({ state: 'text' }) }),
  });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const text = await res.text();
  const data = JSON.parse(text);
  expect(contract.error(data), JSON.stringify(contract.error.errors)).toBe(true);
  expect(data.error.code).toBe(code);
  return text;
}

describe('tokens', () => {
  it('have the expected format and are unique', () => {
    const a = newToken();
    expect(a).toMatch(/^pm_[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('are stored as SHA-256 hex', async () => {
    expect(await hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another scheme', `Basic ${ALL}`],
    ['a token without a scheme', ALL],
    ['extra text', `Bearer ${ALL} x`],
    ['a malformed token', 'Bearer pm_short'],
  ])('reject %s', async (_, header) => {
    expect(await authenticate(header, new MemoryTokenStore())).toBeNull();
  });

  it.each(['bearer', 'BEARER', 'BeArEr', 'Bearer  ', 'Bearer   '])('accept the scheme written as %j', async (scheme) => {
    const tokens = new MemoryTokenStore(new Map([
      [await hashToken(ALL), { client: 'c', profiles: ['*'], created_at: '' }],
    ]));
    expect(await authenticate(`${scheme} ${ALL}`, tokens)).toMatchObject({ client: 'c' });
  });

  it('treat the token itself as case-sensitive', async () => {
    const tokens = new MemoryTokenStore(new Map([
      [await hashToken(ALL), { client: 'c', profiles: ['*'], created_at: '' }],
    ]));
    const changed = `pm_${ALL.slice(3).replace(/[a-z]/, (ch) => ch.toUpperCase())}`;
    expect(changed).not.toBe(ALL);
    expect(await authenticate(`Bearer ${changed}`, tokens)).toBeNull();
  });

  it('accept a known token and reject an unknown one', async () => {
    const tokens = new MemoryTokenStore(new Map([
      [await hashToken(ALL), { client: 'c', profiles: ['*'], created_at: '' }],
    ]));
    expect(await authenticate(`Bearer ${ALL}`, tokens)).toMatchObject({ client: 'c' });
    expect(await authenticate(`Bearer ${REVOKED}`, tokens)).toBeNull();
  });

  it('stop working at their expiry, also when the expiry cannot be read', async () => {
    const at = Date.parse('2027-01-31T23:59:59Z');
    const record = { client: 'c', profiles: ['*'], created_at: '', expires_at: '2027-01-31T23:59:59.000Z' };
    const tokens = new MemoryTokenStore(new Map([[await hashToken(ALL), record]]));
    expect(await authenticate(`Bearer ${ALL}`, tokens, at - 1)).toMatchObject({ client: 'c' });
    expect(await authenticate(`Bearer ${ALL}`, tokens, at)).toBeNull();
    expect(isExpired({ ...record, expires_at: 'soon' })).toBe(true);
    expect(isExpired({ client: 'c', profiles: [], created_at: '' })).toBe(false);
  });

  it('scope profiles', () => {
    const record = { client: 'c', profiles: ['a'], created_at: '' };
    expect(canUse(record, 'a')).toBe(true);
    expect(canUse(record, 'b')).toBe(false);
    expect(canUse({ ...record, profiles: ['*'] }, 'b')).toBe(true);
    expect(canUse({ ...record, profiles: [] }, 'a')).toBe(false);
  });
});

describe('API', () => {
  it.each([
    ['POST', '/v1/decide/issue-triage'],
    ['GET', '/v1/profiles'],
    ['GET', '/v1/unknown'],
  ])('rejects %s %s without a token', async (method, path) => {
    const res = await call(path, undefined, method);
    await expectError(res, 401, 'unauthorized');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects an unknown token and does not echo it', async () => {
    const text = await expectError(await call('/v1/decide/issue-triage', `Bearer ${REVOKED}`), 401, 'unauthorized');
    expect(text).not.toContain(REVOKED);
  });

  it('rejects an expired token like an unknown one', async () => {
    const EXPIRED = newToken();
    await env.TOKENS.put(tokenKey(await hashToken(EXPIRED)), JSON.stringify({ client: 'old', profiles: ['*'], created_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z' }));
    const text = await expectError(await call('/v1/decide/issue-triage', `Bearer ${EXPIRED}`), 401, 'unauthorized');
    expect(text).not.toMatch(/expire/i);
  });

  it('rejects a revoked token', async () => {
    await env.TOKENS.delete(tokenKey(await hashToken(TRIAGE_ONLY)));
    await expectError(await call('/v1/decide/issue-triage', `Bearer ${TRIAGE_ONLY}`), 401, 'unauthorized');
  });

  it('allows a profile in scope', async () => {
    const res = await call('/v1/decide/deploy-progress', `Bearer ${ALL}`);
    expect(res.status).toBe(200);
  });

  it('rejects a profile out of scope with 403', async () => {
    await expectError(await call('/v1/decide/deploy-progress', `Bearer ${TRIAGE_ONLY}`), 403, 'forbidden');
  });

  it('answers 403, not 404, for an unknown profile out of scope', async () => {
    await expectError(await call('/v1/decide/no-such-profile', `Bearer ${TRIAGE_ONLY}`), 403, 'forbidden');
  });

  it('lists only the profiles in scope', async () => {
    const res = await call('/v1/profiles', `Bearer ${TRIAGE_ONLY}`, 'GET');
    const { profiles } = await res.json<any>();
    expect(profiles.map((p: any) => p.id)).toEqual(['issue-triage']);
  });
});
