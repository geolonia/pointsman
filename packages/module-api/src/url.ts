// Checking the URL of a server a deployment configures (a model server, a
// routing server). Node-safe, like api.ts.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Checks a server base URL: https, or http for a loopback host (local
 * development). No credentials, query or fragment. The value has no trailing
 * slash.
 */
export function checkServerUrl(raw: string): Parsed<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'is not a URL' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return { ok: false, error: 'must use https (http only for localhost)' };
  }
  if (url.username || url.password) return { ok: false, error: 'must not contain credentials' };
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    return { ok: false, error: 'must not have a query or fragment' };
  }
  return { ok: true, value: url.toString().replace(/\/+$/, '') };
}
