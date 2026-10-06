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

A **model server** (below) can serve some model ids in either mode; those
go to the server, all others as `MODEL_MODE` says. Other backends are new
adapters behind the same interface (`src/models/adapter.ts`).

## Model server (local or self-hosted models)

Any server that answers `POST /v1/systemone` in the shared request and answer
format can serve models, for example a local
[Strands Decider](https://strandsagents.com/blog/introducing-strands-decider/)
(see the spike, [spikes/local-decider.md](spikes/local-decider.md)).

| Setting | Meaning |
|---|---|
| `MODEL_SERVER_URL` | Base URL, for example `http://127.0.0.1:8794`. https, or http only for `localhost`, `127.0.0.1`, `[::1]`. No credentials, query or fragment. |
| `MODEL_SERVER_MODELS` | Comma-separated model ids from profiles that the server answers. `id=name` sends a different model name to the server. |
| `MODEL_SERVER_API_KEY` | Optional. Sent as `Authorization: Bearer …`; a Worker secret, never logged. |
| `MODEL_SERVER_TIMEOUT_MS` | Optional, 100 to 60000 (default 10000). |

URL and models go together; with only one of them, or an invalid value,
every request fails with a configuration error, so the mistake shows up at once. A failed call (not reachable, timeout,
HTTP error, invalid answer) is a model error, so the profile's next fallback
model answers. Errors and logs never include the request, the response body
or the key.

### Real answers in local development

About 4.6 GB is downloaded on first use (the decider and its
Qwen3.5-2B backbone, both Apache-2.0). Python 3.10 or newer.

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 --port 8794
```

Then, in a second terminal, put the settings in `.dev.vars` (not committed)
and start the Worker as usual:

```sh
cat > .dev.vars <<'VARS'
MODEL_SERVER_URL=http://127.0.0.1:8794
MODEL_SERVER_MODELS=clef-flash=strands-decider-2B-hobson-v19
VARS
pnpm dev
```

Profiles that use `clef-flash` are now answered by the local decider (a
decision records `strands-decider-2B-hobson-v19` as its model); everything
else still uses the mock. A deployed Worker needs an https server it can
reach; Workers cannot call addresses on your own machine.

The decider's probabilities run lower than Clef-flash's for the same answer
(see the spike), so check a profile's thresholds against its accuracy before
switching a deployed profile to it.

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
