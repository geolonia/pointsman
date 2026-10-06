# Models

A profile names a `model` and optional `fallback_models`. The engine tries
them in order; a model error (failed call, or an answer that does not fit the
profile) moves on to the next one. The decision records the model that
answered.

`MODEL_MODE` in the wrangler config chooses the adapters:

| `MODEL_MODE` | Models | Used for |
|---|---|---|
| `mock` | every model id, answered by a fixed mock | development and tests |
| `workers-ai` | `clef-flash`, `clef` (Workers AI) | real deployments, `pnpm dev:live` |

Other backends (Jev, a local model) are new adapters behind the same
interface (`src/models/adapter.ts`); see issue #15 for a local model.

## Workers AI and AI Gateway

With `MODEL_MODE=workers-ai` the Worker needs the `AI` binding. When
`AI_GATEWAY_ID` is set, calls go through that [AI Gateway][aig] (logs,
caching, rate limits, 10-second timeout). Without it, calls go to Workers AI
directly.

The gateway settings are in [`ai-gateway.json`](../ai-gateway.json). Wrangler
has no command for gateways, so `scripts/ai-gateway.mjs` creates or updates
the gateway through the Cloudflare API:

```sh
pnpm ai-gateway show
pnpm ai-gateway apply --dry-run
pnpm ai-gateway apply
```

Settings: logs on (100,000, oldest deleted first), no caching (a cached
answer would hide a model or profile change), rate limit 600 calls per minute,
no gateway retries (the engine's fallback models handle failures), and
authentication on (calls through the Worker binding are authenticated
automatically; direct HTTP calls need a token).

The script needs an API token with **AI Gateway: Read and Edit** in
`CLOUDFLARE_API_TOKEN` (the token from `wrangler login` has no AI Gateway
permission) and the account in `CLOUDFLARE_ACCOUNT_ID`, unless the wrangler
login has exactly one account. You can also create the gateway in the
dashboard (AI → AI Gateway) with the same settings.

**Logs hold the state.** With `collect_logs: true`, the gateway stores every
model call, including the state sent to the model. The decision log in D1
stores only a hash of the state by default (see
[decision-log.md](decision-log.md)); the gateway logs are the place where
inputs can be seen for debugging. Set `collect_logs: false` when inputs must
not be kept, and set a log limit in the gateway if needed.

## Trying a real call

```sh
wrangler login          # an account with Workers AI
pnpm ai-gateway apply   # once, with an AI Gateway token (see above)
pnpm db:migrate:local
node scripts/tokens.mjs create --client me --profiles '*' --local
pnpm dev:live           # real model calls; profiles, tokens and log stay local
```

[aig]: https://developers.cloudflare.com/ai-gateway/
