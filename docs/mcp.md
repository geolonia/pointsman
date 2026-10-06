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

`submit_feedback` (correcting a decision) will be available only to people
logged in through OAuth, not to API tokens (issue #11, step 2).

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

**People** (MCP clients with an "add connector" dialog, which use OAuth): step
2 of issue #11. Pointsman will act as its own OAuth 2.1 authorization server
and delegate login to a configurable identity provider (first GitHub, limited
to members of allowed organizations), so no vendor identity service is needed.

## Decisions through MCP

MCP decisions go through the same checks, policy and decision log as the REST
API. The decision log records the token's client name; `ref` is whatever the
caller sends.
