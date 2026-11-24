// What every request to GitHub's API has in common, for the facts
// (provider.ts, with the facts' read-only token) and the connector
// (connector/github.ts, with its own write app's token). Only the shared
// form: each caller keeps its own token, user agent and its own reading of
// a failed answer (FactError for facts, GitHubError for the connector).

export const API = 'https://api.github.com';
/** GitHub's JSON media type: the default `accept`. */
export const GITHUB_JSON = 'application/vnd.github+json';

/** The headers of a request to GitHub's API: the caller's token and user agent, GitHub's API version. */
export function githubHeaders(token: string, userAgent: string, accept = GITHUB_JSON): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept,
    'x-github-api-version': '2022-11-28',
    'user-agent': userAgent,
  };
}

/** A JSON object (not null, not an array). */
export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
