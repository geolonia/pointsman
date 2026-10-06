// Per-client API tokens.
//
// A client sends `Authorization: Bearer <token>`. Only the SHA-256 hash of a
// token is stored, so a leaked store does not leak usable tokens. Tokens are
// 32 random bytes, so a plain hash is enough (no slow password hash needed).
//
// Tokens are created and revoked with scripts/tokens.mjs. They never appear in
// logs, responses or the decision log; the client name does.
//
// This file is also imported by scripts/tokens.mjs under Node.js, so it uses
// only TypeScript syntax that Node can strip.

export interface TokenRecord {
  /** Client name, for example "github-triage". Recorded with decisions. */
  client: string;
  /** Profile ids this token may use; ["*"] for all profiles. */
  profiles: string[];
  created_at: string;
}

export interface TokenStore {
  /** The record for a token hash, or null when unknown or revoked. */
  get(hash: string): Promise<TokenRecord | null>;
}

export const TOKEN_PREFIX = 'pm_';
const TOKEN_FORMAT = /^pm_[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return TOKEN_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** KV key for a token hash. */
export const tokenKey = (hash: string) => `token:${hash}`;

/**
 * Tokens in a KV namespace, keyed `token:<sha256 hex>`. KV is eventually
 * consistent: a revoked token can keep working for up to about 60 seconds in
 * other locations.
 */
export class KvTokenStore implements TokenStore {
  kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  get(hash: string): Promise<TokenRecord | null> {
    return this.kv.get<TokenRecord>(tokenKey(hash), 'json');
  }
}

export class MemoryTokenStore implements TokenStore {
  records: Map<string, TokenRecord>;

  constructor(records: Map<string, TokenRecord> = new Map()) {
    this.records = records;
  }

  async get(hash: string): Promise<TokenRecord | null> {
    return this.records.get(hash) ?? null;
  }
}

/**
 * The token record for an Authorization header value, or null when the header
 * is missing, malformed, or names an unknown token.
 */
export async function authenticate(header: string | undefined, store: TokenStore): Promise<TokenRecord | null> {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  // Checking the format first avoids a store lookup for obvious garbage.
  if (!match || !TOKEN_FORMAT.test(match[1]!)) return null;
  return store.get(await hashToken(match[1]!));
}

export function canUse(record: TokenRecord, profileId: string): boolean {
  return record.profiles.includes('*') || record.profiles.includes(profileId);
}
