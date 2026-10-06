# MCP server

Pointsman serves the [Model Context Protocol](https://modelcontextprotocol.io)
at `/mcp` (Streamable HTTP, stateless), so agents can ask a decision profile
instead of deciding on their own.

## Tools

| Tool | What it does |
|---|---|
| `list_profiles` | The profiles you can use: questions, answer options, possible actions, and the state fields to send |
| `decide` | Ask a profile; returns typed answers with probabilities and the action (for example `auto`, or `review` when a person should decide) |
| `get_decision` | A decision by id: answers, action, profile version, model, review status, feedback |
| `submit_feedback` | Correct a decision: the right answer for one or more questions. Only for people logged in with GitHub, recorded under their login |

Feedback is a person's judgement, so API tokens do not get `submit_feedback`.

Only profiles that set `mcp.visible: true` are listed or callable through MCP,
and only those in the caller's scope; any other profile looks unknown.

```yaml
# in a profile
mcp:
  visible: true
```

For a profile with an `input` mapping, MCP callers send the input fields
directly (`{"title": "…", "body": "…"}`), as `list_profiles` shows them;
the REST API instead takes the raw payload that the mapping reads from.

## Authentication

**Machines** (agents, CI, scripts) use the same API tokens as the REST API
(`scripts/tokens.mjs`), as a bearer token. Token scopes apply.

```bash
claude mcp add --transport http pointsman https://pointsman.example.workers.dev/mcp --header "Authorization: Bearer $POINTSMAN_TOKEN"
```

**People** log in with GitHub. Add Pointsman as a custom connector in Claude
(or any MCP client that supports OAuth) with the URL `https://<your worker>/mcp`.
The client opens a Pointsman page that asks whether it may act for you, then
GitHub's login. Only active members of the allowed GitHub organizations get
in. People may use every MCP-visible profile; their decisions and feedback are
recorded as `github:<login>`.

Pointsman is its own OAuth 2.1 authorization server
([workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)),
so no vendor identity service is needed. GitHub is only the login step: its
token is used to read the person's login and organization membership, and is
not stored. MCP clients register themselves (dynamic client registration, or a
client ID metadata document).

Membership is checked at login. Pointsman access tokens last one hour, and a
login lasts at most 7 days; someone removed from the organization keeps access
until then.

### Setting up GitHub login

1. In the GitHub organization, create a GitHub App (Settings → Developer
   settings → GitHub Apps):
   - Callback URL: `https://<your worker>/callback`
   - Webhook: off
   - Permissions: Organization → Members: Read-only, nothing else
   - Where can this GitHub App be installed: only on this account
2. Install the app on the organization (and on any other allowed organization),
   so the membership check works.
3. Generate a client secret and store it as the Worker secret
   `GITHUB_CLIENT_SECRET` (dashboard, or `wrangler secret put GITHUB_CLIENT_SECRET`).
4. Create a KV namespace for OAuth grants and bind it as `OAUTH_KV`.
5. Set the vars `PUBLIC_URL` (the Worker's https origin), `GITHUB_CLIENT_ID`
   and `ALLOWED_GITHUB_ORGS` (comma-separated). The config repository template
   has them commented out in `wrangler.jsonc`.

Set all of these or none: without them `/mcp` takes API tokens only; with only
some of them every request and every cron run (including callback retries) fails with a configuration error, so the mistake shows up at once.

## Decisions through MCP

MCP decisions go through the same checks, policy and decision log as the REST
API. The decision log records the token's client name; `ref` is whatever the
caller sends.
