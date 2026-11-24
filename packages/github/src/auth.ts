// How the GitHub facts get a token (FACTS_GITHUB "token" or "app"): one
// fixed token, or a GitHub App's installation tokens, down-scoped and kept
// until shortly before they expire. Also used by the connector, with its own
// write app and scope (connector/github.ts). The one POST it sends creates
// an installation token; it changes no repository.

import { FactError } from '@pointsman/module-api';
import { APP_SLUG as APP_SLUG_PATTERN, GITHUB_TIMEOUT_MS, type PullRequestRef } from './definition';
import { API, isObject } from './github-http';
import { getJson, headers, readJson } from './requests';

/** A GitHub App's slug: lower case letters, digits and hyphens. */
const APP_SLUG = new RegExp(APP_SLUG_PATTERN);

/** Gives a token for the repositories of one owner. Never logged. */
export interface GitHubAuth {
  token(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string>;
}

/** One token for every repository (FACTS_GITHUB "token"). */
export class TokenAuth implements GitHubAuth {
  private readonly value: string;
  constructor(token: string) {
    this.value = token;
  }
  async token(): Promise<string> {
    return this.value;
  }
}

const b64url = (bytes: Uint8Array | string): string => {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** DER length bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/** A PKCS#1 RSA key (GitHub's "BEGIN RSA PRIVATE KEY") wrapped as PKCS#8, which WebCrypto reads. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  // AlgorithmIdentifier: rsaEncryption, NULL parameters.
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(pkcs1.length)];
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  const total = body.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(total), ...body, ...pkcs1]);
  return out;
}

/** The key's DER bytes as PKCS#8, from a PEM in either format; null when it is not one. */
export function privateKeyDer(pem: string): Uint8Array<ArrayBuffer> | null {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
  if (!m || Boolean(m[1]) !== Boolean(m[3])) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(m[2]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 64) return null;
  return m[1] ? pkcs1ToPkcs8(bytes) : bytes;
}

/** Permissions GitHub has only as "write"; a read-only token leaves them out. */
const WRITE_ONLY = new Set(['workflows']);

/** The permissions of a token, from those the installation has. */
export type Scope = (granted: Record<string, string>) => Record<string, string>;

/**
 * What the facts read (docs/github-connector.md): pull requests, files,
 * checks, statuses, workflow runs, custom properties, organization members.
 */
export const FACTS_PERMISSIONS = ['metadata', 'contents', 'pull_requests', 'checks', 'statuses', 'actions', 'repository_custom_properties', 'members'];

/** The facts' scope: of the permissions the facts use, those the installation has, as "read" only. */
export const readOnly: Scope = (granted) =>
  Object.fromEntries(FACTS_PERMISSIONS.filter((p) => granted[p] !== undefined && !WRITE_ONLY.has(p)).map((p) => [p, 'read']));

/**
 * A GitHub App (FACTS_GITHUB "app"): signs a JWT with the app's private key,
 * finds the app's installation for the repository and creates an
 * installation token, kept until five minutes before it expires (one hour).
 * The token is down-scoped (default: read-only, whatever the app may do),
 * so even an app with write permissions gives the facts a token that only
 * reads. The app for facts should still have read permissions only
 * (docs/github-connector.md).
 */
export class GitHubAppAuth implements GitHubAuth {
  private readonly appId: string;
  private readonly der: Uint8Array<ArrayBuffer>;
  private readonly scope: Scope;
  private readonly perRepository: boolean;
  private key: Promise<CryptoKey> | undefined;
  private readonly tokens = new Map<string, { token: Promise<string>; until: number }>();
  /** The app's slug, as each installation's answer names it. */
  private readonly slugs = new Map<string, string>();
  /** The clock (tests set it). */
  now: () => number = () => Date.now();

  /** perRepository: each token only for the one repository (the connector's); default one per owner (the facts read org data too). */
  constructor(appId: string, privateKeyPem: string, scope: Scope = readOnly, perRepository = false) {
    const der = privateKeyDer(privateKeyPem);
    if (!der) throw new Error('not a PEM private key');
    this.appId = appId;
    this.der = der;
    this.scope = scope;
    this.perRepository = perRepository;
  }

  private key_(pr: PullRequestRef): string {
    return (this.perRepository ? `${pr.owner}/${pr.repo}` : pr.owner).toLowerCase();
  }

  private async jwt(): Promise<string> {
    this.key ??= crypto.subtle.importKey('pkcs8', this.der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    let key: CryptoKey;
    try {
      key = await this.key;
    } catch {
      this.key = undefined;
      throw new FactError('the GitHub App key cannot be read');
    }
    const now = Math.floor(this.now() / 1000);
    // Issued a minute early against clock drift; GitHub allows at most 10 minutes.
    const payload = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }))}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
    return `${payload}.${b64url(new Uint8Array(signature))}`;
  }

  token(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string> {
    // One installation per owner.
    const id = this.key_(pr);
    const cached = this.tokens.get(id);
    if (cached && cached.until > this.now()) return cached.token;
    const entry = { token: this.create(pr, fetchFn), until: this.now() + 60_000 };
    this.tokens.set(id, entry);
    entry.token.then(
      () => undefined,
      () => { if (this.tokens.get(id) === entry) this.tokens.delete(id); },
    );
    return entry.token;
  }

  /** Drops the cached token for this pull request's repository (or owner) when it is still `used`: GitHub refused it. */
  async forget(pr: PullRequestRef, used: string): Promise<void> {
    const id = this.key_(pr);
    const entry = this.tokens.get(id);
    if (!entry) return;
    const value = await entry.token.catch(() => undefined);
    if (value === used && this.tokens.get(id) === entry) this.tokens.delete(id);
  }

  /**
   * The app's slug, from the installation's answer (its bot is
   * "<slug>[bot]"). Gets a token first when none was made yet; a FactError
   * when GitHub did not name it.
   */
  async slug(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string> {
    await this.token(pr, fetchFn);
    const slug = this.slugs.get(this.key_(pr));
    if (!slug) throw new FactError('GitHub installation: no app slug');
    return slug;
  }

  private async create(pr: PullRequestRef, fetchFn: typeof fetch): Promise<string> {
    const jwt = await this.jwt();
    const signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    const installation = await getJson(fetchFn, `/repos/${pr.owner}/${pr.repo}/installation`, jwt, signal, 'installation');
    const { id: installationId, permissions: granted, app_slug: slug } = installation as { id?: unknown; permissions?: unknown; app_slug?: unknown };
    if (typeof installationId !== 'number') throw new FactError('GitHub installation: unexpected answer');
    if (typeof slug === 'string' && APP_SLUG.test(slug)) this.slugs.set(this.key_(pr), slug);
    const permissions = this.scope(isObject(granted) ? Object.fromEntries(Object.entries(granted).filter((e): e is [string, string] => typeof e[1] === 'string')) : {});
    if (Object.keys(permissions).length === 0) throw new FactError('GitHub installation: the app has none of the permissions needed');
    // The only request that is not a GET: it creates a token, it changes no repository.
    const res = await fetchFn(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST', headers: { ...headers(jwt), 'content-type': 'application/json' }, body: JSON.stringify({ permissions, ...(this.perRepository && { repositories: [pr.repo] }) }), redirect: 'manual', signal,
    });
    const body = await readJson(res, 'installation token');
    const { token, expires_at: expiresAt } = body as { token?: unknown; expires_at?: unknown };
    const until = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (typeof token !== 'string' || token === '' || !Number.isFinite(until)) throw new FactError('GitHub installation token: unexpected answer');
    const entry = this.tokens.get(this.key_(pr));
    if (entry) entry.until = until - 5 * 60_000;
    return token;
  }
}
