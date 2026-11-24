// How the GitHub facts send a request: a GET to the REST API, a GraphQL
// query (a POST, never a mutation), and the reading of an answer, where a
// failure becomes a FactError (FactUnavailableError for 403 and 404) that
// names the status, never the token. The shared form is in github-http.ts.

import { FactError, FactUnavailableError } from '@pointsman/module-api';
import { API, githubHeaders, isObject } from './github-http';
import { rateLimited } from './rate-limit';

const USER_AGENT = 'pointsman (+https://github.com/geolonia/pointsman)';

export function headers(token: string): Record<string, string> {
  return githubHeaders(token, USER_AGENT);
}

/** The JSON body of a 2xx answer; otherwise a FactError that names `what` and the status (never the token). */
export async function readJson(res: Response, what: string): Promise<unknown> {
  if (res.status >= 200 && res.status < 300) {
    try {
      return await res.json();
    } catch {
      throw new FactError(`GitHub ${what}: not JSON`);
    }
  }
  // Uses up the body (of a 403, at most its first bytes, for GitHub's message).
  const limited = await rateLimited(res);
  // Redirects are not followed: they would carry the token to another place.
  if (res.status >= 300 && res.status < 400) throw new FactError(`GitHub ${what}: redirect ${res.status} not followed`);
  if (limited) throw new FactError(`GitHub ${what}: rate limited (${res.status})`);
  // Not there, or this token may not see it: the facts are unavailable for it.
  if (res.status === 404 || res.status === 403) throw new FactUnavailableError(`GitHub ${what}: ${res.status}`);
  throw new FactError(`GitHub ${what}: ${res.status}`);
}

/** The way this file reads GitHub's REST API: a GET. */
export function get(fetchFn: typeof fetch, path: string, token: string, signal: AbortSignal): Promise<Response> {
  return fetchFn(`${API}${path}`, { method: 'GET', headers: headers(token), redirect: 'manual', signal });
}

export async function getJson(fetchFn: typeof fetch, path: string, token: string, signal: AbortSignal, what: string): Promise<unknown> {
  return readJson(await get(fetchFn, path, token, signal), what);
}

/**
 * A GraphQL query (GitHub's GraphQL API takes a POST). Only queries this
 * file defines, never a mutation; their `data`, or a FactError when GitHub
 * answers with errors.
 */
export async function graphql(fetchFn: typeof fetch, query: string, variables: Record<string, unknown>, token: string, signal: AbortSignal, what: string): Promise<unknown> {
  if (!/^query\b/.test(query)) throw new FactError('only GraphQL queries are sent');
  const res = await fetchFn(`${API}/graphql`, {
    method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), redirect: 'manual', signal,
  });
  const body = await readJson(res, what);
  if (!isObject(body) || (body.errors !== undefined && body.errors !== null) || !isObject(body.data)) throw new FactError(`GitHub ${what}: unexpected answer`);
  return body.data;
}

/** The "after" cursor of a Link header's next page; null when there is none. Only the cursor is used, never the URL. */
export function nextCursor(link: string | null): string | null {
  const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
  if (!m) return null;
  try {
    const after = new URL(m[1]!).searchParams.get('after');
    return after && after.length <= 500 ? after : null;
  } catch {
    return null;
  }
}
