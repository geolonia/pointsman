// API tokens (src/auth.ts) in a Cloudflare KV namespace. A Cloudflare
// adapter (docs/adapters.md).

import { tokenKey, type TokenRecord, type TokenStore } from './auth';

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
