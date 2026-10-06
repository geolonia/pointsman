// OAuth for /mcp: people log in with GitHub (docs/mcp.md).
//
// Pointsman is its own OAuth 2.1 authorization server
// (@cloudflare/workers-oauth-provider). It shows a consent page, sends the
// person to GitHub, checks that they are a member of an allowed GitHub
// organization, and then issues its own access token for /mcp. The GitHub
// token is used only for that check and is not stored.
//
// API tokens (scripts/tokens.mjs) keep working at /mcp next to OAuth tokens,
// so machines need no OAuth flow.

import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import { authenticate, type TokenRecord, type TokenStore } from './auth';
import type { Fetch } from './callbacks';

export interface OAuthConfig {
  /** Public origin of the Worker, for example https://pointsman.example.workers.dev. */
  issuer: string;
  github: {
    clientId: string;
    clientSecret: string;
    /** GitHub organizations whose members may log in (any one is enough). */
    orgs: string[];
    fetch: Fetch;
  };
}

/** The env the OAuth library reads its storage from. */
export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
}

/** Who is calling /mcp: an API token, or a person logged in through OAuth. */
export type Caller =
  | { kind: 'token'; record: TokenRecord }
  | { kind: 'person'; login: string };

/** Props stored with an OAuth grant (encrypted by the library). */
interface PersonProps {
  login: string;
}

const ACCESS_TOKEN_TTL = 60 * 60;
// Organization membership is checked only at login, so a person removed from
// the organization keeps access until their grant ends: at most this long.
const GRANT_TTL = 7 * 24 * 60 * 60;

const servers = new Map<string, OAuthAuthorizationServer<OAuthEnv>>();

function authorizationServer(config: OAuthConfig): OAuthAuthorizationServer<OAuthEnv> {
  let server = servers.get(config.issuer);
  if (!server) {
    server = new OAuthAuthorizationServer<OAuthEnv>({
      issuer: config.issuer,
      resources: [mcpResource(config)],
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: ACCESS_TOKEN_TTL,
      refreshTokenTTL: GRANT_TTL,
    });
    servers.set(config.issuer, server);
  }
  return server;
}

const mcpResource = (config: OAuthConfig) => `${config.issuer}/mcp`;

/**
 * Serve /mcp and its resource metadata: a valid API token or OAuth access
 * token is needed; anything else gets a 401 that tells MCP clients where to
 * log in.
 */
export function serveProtectedMcp(
  request: Request,
  env: OAuthEnv,
  ctx: ExecutionContext,
  config: OAuthConfig,
  tokens: TokenStore,
  handle: (request: Request, caller: Caller) => Promise<Response>,
): Promise<Response> {
  const server = authorizationServer(config);
  const resource = new OAuthResourceServer<OAuthEnv, Caller>({
    resourceMetadata: {
      resource: mcpResource(config),
      authorization_servers: [config.issuer],
      resource_name: 'Pointsman',
    },
    validateToken: (e) => async (res, token) => {
      // API tokens have their own format, so they are never sent to the
      // authorization server, and OAuth tokens never reach the token store.
      if (token.startsWith('pm_')) {
        const record = await authenticate(`Bearer ${token}`, tokens);
        return record && { props: { kind: 'token', record }, audience: res };
      }
      const valid = await server.validateToken<PersonProps>(res, token, e);
      return valid && { ...valid, props: { kind: 'person', login: valid.props.login } };
    },
    handler: { fetch: (req, _env, c) => handle(req, c.props) },
  });
  return resource.fetch(request, env, ctx);
}

/** Discovery, token, revocation and client registration endpoints. */
export function serveAuthorizationServer(request: Request, env: OAuthEnv, ctx: ExecutionContext, config: OAuthConfig): Promise<Response> {
  return authorizationServer(config).fetch(request, env, ctx);
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}</style>
${body}`,
    { status, headers },
  );
}

function consentPage(d: ConsentDescription, handle: string, orgs: string[]): string {
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const local = d.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started logging in from it.</p>'
    : '';
  return `<h1>Allow ${escape(d.clientName)} to use Pointsman?</h1>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${local}
<p>The app can list decision profiles, ask for decisions and send feedback in your name.
You log in with GitHub next; only members of ${orgs.map((o) => `<strong>${escape(o)}</strong>`).join(' or ')} can continue.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`;
}

function failurePage(message: string, status = 400): Response {
  return page('Pointsman login', `<h1>Login failed</h1><p>${escape(message)}</p><p>Start again from your MCP client.</p>`, status);
}

/** Errors the person caused (old page, wrong browser, bad request): show them; anything else is a 500. */
function shown(err: unknown): Response {
  if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
  if (err instanceof AuthorizationError) return failurePage(err.description);
  if (err instanceof CimdFetchError) return failurePage('This app could not be verified.');
  throw err;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** GET /authorize: check the request and show the consent page. */
export async function showConsent(request: Request, env: OAuthEnv, config: OAuthConfig): Promise<Response> {
  const oauth = authorizationServer(config).getOAuthApi(env);
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return page('Pointsman login', consentPage(details, consent.handle, config.github.orgs), 200, consent.headers);
  } catch (err) {
    return shown(err);
  }
}

/** POST /authorize: the person allowed or denied; on allow, go to GitHub. */
export async function answerConsent(request: Request, env: OAuthEnv, config: OAuthConfig): Promise<Response> {
  const oauth = authorizationServer(config).getOAuthApi(env);
  try {
    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const github = new URL('https://github.com/login/oauth/authorize');
    github.search = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: `${config.issuer}/callback`,
      state,
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: 'S256',
      allow_signup: 'false',
    }).toString();
    headers.set('location', github.toString());
    return new Response(null, { status: 302, headers });
  } catch (err) {
    return shown(err);
  }
}

const GITHUB_API = {
  accept: 'application/vnd.github+json',
  'user-agent': 'pointsman',
  'x-github-api-version': '2022-11-28',
};

/** The GitHub login of the person behind a GitHub code, or null when GitHub refuses the code. */
async function githubLogin(code: string, verifier: string, config: OAuthConfig): Promise<{ login: string; token: string } | null> {
  const { clientId, clientSecret, fetch } = config.github;
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${config.issuer}/callback`,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed: HTTP ${res.status}`);
  // GitHub answers a bad or expired code with HTTP 200 and an "error" field.
  const body = await res.json<{ access_token?: unknown }>();
  if (typeof body.access_token !== 'string') return null;
  const token = body.access_token;
  const user = await fetch('https://api.github.com/user', { headers: { ...GITHUB_API, authorization: `Bearer ${token}` } });
  if (!user.ok) throw new Error(`GitHub user lookup failed: HTTP ${user.status}`);
  const { login } = await user.json<{ login?: unknown }>();
  if (typeof login !== 'string' || login === '') throw new Error('GitHub user has no login');
  return { login, token };
}

/** True when the person is an active member of one of the allowed organizations. */
async function isMember(token: string, config: OAuthConfig): Promise<boolean> {
  for (const org of config.github.orgs) {
    const res = await config.github.fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
      headers: { ...GITHUB_API, authorization: `Bearer ${token}` },
    });
    // 404 (or 403): not a member, or the GitHub App is not installed there.
    if (res.status === 404 || res.status === 403) continue;
    if (!res.ok) throw new Error(`GitHub membership check failed: HTTP ${res.status}`);
    const { state } = await res.json<{ state?: unknown }>();
    if (state === 'active') return true;
  }
  return false;
}

/** GET /callback: GitHub sent the person back; check them and finish the login. */
export async function finishLogin(request: Request, env: OAuthEnv, config: OAuthConfig): Promise<Response> {
  const oauth = authorizationServer(config).getOAuthApi(env);
  let resumed;
  try {
    resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  } catch (err) {
    return shown(err);
  }
  const { request: original, data, headers } = resumed;
  const deny = (description: string) => {
    headers.set('location', authorizationErrorRedirect(original, 'access_denied', description));
    return new Response(null, { status: 302, headers });
  };
  const code = new URL(request.url).searchParams.get('code');
  // The person declined at GitHub, or GitHub failed.
  if (!code) return deny('GitHub login was not completed');
  const person = await githubLogin(code, data.verifier, config);
  if (!person) return deny('GitHub did not accept the login');
  if (!(await isMember(person.token, config))) {
    return deny(`only members of ${config.github.orgs.join(', ')} can use Pointsman`);
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    // GitHub logins have no ":" (the library's separator).
    userId: `github-${person.login}`,
    metadata: { login: person.login },
    scope: [],
    props: { login: person.login } satisfies PersonProps,
  });
  headers.set('location', redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Remove expired OAuth records; resumes where the last run stopped. */
export async function purgeExpired(env: OAuthEnv, config: OAuthConfig): Promise<void> {
  const cursor = (await env.OAUTH_KV.get('purge-cursor')) ?? undefined;
  const result = await authorizationServer(config).purgeExpiredData(env, { batchSize: 100, ...(cursor && { cursor }) });
  if (result.cursor) await env.OAUTH_KV.put('purge-cursor', result.cursor);
  else await env.OAUTH_KV.delete('purge-cursor');
}
