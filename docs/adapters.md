# Adapters: what the engine needs from a runtime

Pointsman runs as a Cloudflare Worker today, but the engine core does not depend on Cloudflare. The core takes a case, looks up facts, asks a model, applies the rules and logs the decision. Everything it needs from the outside goes through a few interfaces (ports). An **adapter** connects one port to one runtime or service, for example the decision log to Cloudflare D1.

Cloudflare Workers is the reference runtime. Other runtimes (a Node.js container, AWS Lambda) need their own adapters for the same ports; profiles and rules stay the same.

## The rule

The core uses no Cloudflare-specific API. `pnpm typecheck` checks this with `scripts/check-core.mjs`: it compiles the core (`tsconfig.core.json`) without Cloudflare's types, so a core file that uses `KVNamespace`, `D1Database`, `ExecutionContext`, `caches.default` or a `cloudflare:` module, or imports a file that does, fails the check. It also fails when the core reaches a Cloudflare package or the Worker types wrangler generates. It is a check of types and imports: a cast such as `(globalThis as any).caches` gets past it, so reviews still look for that.

The core is all of `src/` except these Cloudflare adapters, the only files that may use Cloudflare APIs:

| File | Adapter for |
| --- | --- |
| `src/index.ts` | Runtime entry: reads the Worker's settings and bindings, builds the adapters, mounts the connectors, runs the cron trigger and the queue consumer; the `InternalEngine` entrypoint for [internal calls](#internal-calls) |
| `src/app.ts` | HTTP routes on the Worker (Hono), including the OAuth routes |
| `src/oauth.ts` | GitHub login for `/mcp` (`@cloudflare/workers-oauth-provider`, grants in KV) |
| `src/log-d1.ts` | Decision log in D1 |
| `src/auth-kv.ts` | API tokens in KV |
| `src/profiles/store-kv.ts` | Profiles in KV |
| `src/models/workers-ai.ts` | Models on Workers AI |

The modules' code in `packages/*/src` is core too. A connector's own Worker (`connectors/github/src`) is a Cloudflare adapter as a whole.

New code goes into the core unless it needs a runtime API. Then it is a new adapter: a new file, listed in `tsconfig.core.json` and in this table, behind an interface the core defines.

## Ports

Each port is an interface in the core. Every adapter for it must keep the guarantees listed, because the engine relies on them.

### Runtime entry

Today: `src/index.ts` (Worker `fetch` and `scheduled`), with the routes in `src/app.ts`.

The entry reads the deployment's settings, builds the other adapters and passes them to the core as `Deps` (`src/decide.ts`). The decision logic itself is in `src/decide.ts` (`makeDecision`, `makeReplay`) and `src/mcp.ts`.

An adapter must:

- Fail on a broken configuration (`ConfigError`), for example half of the OAuth settings, instead of running with a part switched off. The Worker reads its configuration for each request and cron run, so each of them fails.
- Never log a request's state, tokens or secrets.
- Answer every route of `openapi.yaml` the same way, whatever the runtime.

### Decision log

Interface: `DecisionLog` in `src/log.ts`. Today: D1 (`src/log-d1.ts`, schema in `migrations/`).

An adapter must:

- Store a decision before the engine returns it. If storing fails, the call fails, so no client acts on a decision that is not logged. (Decisions for a test token are not logged, by design: they are marked `test`.)
- Keep an idempotency key unique per client: of two inserts with the same key, exactly one succeeds.
- Resolve a review only while it is pending, and claim a callback for one caller only (`resolve`, `claimCallback` are compare-and-set).
- Keep decisions as they were written: only review, callback and discard fields change later.
- Answer `recentFor(client, profiles, since, limit)` with that client's decisions of those profiles since a time, newest first, without discarded ones, and never more than `limit`. Facts read the log through it ([modules.md](modules.md#facts-from-the-decision-log)); the engine limits it to the profiles the client's token may use.

### Profile store

Interface: `ProfileStore` in `src/profiles/store.ts`. Today: KV (`src/profiles/store-kv.ts`, written by `scripts/publish-profiles.mjs`) or the profiles bundled into the build (`MemoryProfileStore`).

An adapter must:

- Hold only profiles that passed validation. The store does not validate: the publish step does (`scripts/publish-profiles.mjs` after `validate-profiles.mjs`, or the build for bundled profiles), and the store trusts it.
- Return the version asked for, or nothing. Without a version, return the newest readable one.

### Tokens and login

Interface: `TokenStore` and `Caller` in `src/auth.ts`. Today: KV for API tokens (`src/auth-kv.ts`), and `src/oauth.ts` for GitHub login.

An adapter must:

- Store only the hash of a token, never the token.
- Fail closed: an unknown, expired or unreadable token is refused.
- State how long a revoked token can keep working (KV: up to about 60 seconds).

### Model

Interface: `ModelAdapter` in `src/models/adapter.ts`. Today: Workers AI (`src/models/workers-ai.ts`), any server speaking the shared format over HTTP (`src/models/http.ts`), and a mock.

An adapter must:

- Answer in the shared format, or throw `ModelError`, so the engine tries the next fallback model.
- Send the backend only what the profile's input mapping gives it.

### Cache

A fact module gets the runtime's shared cache, if it has one, in `create(env, runtime)` ([modules.md](modules.md)); today the Workers cache (`caches.default`, from `src/index.ts`), used by the GSI module.

An adapter must:

- Treat a missing or failing cache as a miss, never as an error.
- Keep only public data (map tiles), never a request's state or a token.

### Engine client (a connector's way to the engine)

Interface: `EngineClient` in `packages/github/src/connector/engine.ts`, with the one call the GitHub connector makes: `decide(profile, body, { idempotencyKey })`, the same as `POST /v1/decide/{profile}`. It answers the HTTP status and, with a 2xx status, the decision. The connector's logic (`pull-request.ts`) uses only this interface. The settings choose the adapter (`engineSetting`):

| Adapter | Where | Chosen by |
| --- | --- | --- |
| HTTP with a token | `httpEngine` in `engine.ts` (core: any runtime with `fetch`) | `POINTSMAN_URL` and `POINTSMAN_TOKEN` (the default) |
| Internal call, Cloudflare | `connectors/github/src/engine-binding.ts`: a service binding to the engine Worker's `InternalEngine` entrypoint | a binding named `POINTSMAN` |
| In process (planned) | a runtime that runs the connector and the engine in one process gives `decideInternal` (`src/internal.ts`) with the deployment's internal client behind the same interface | not built yet: no runtime runs both in one process |

An adapter must:

- Throw when the engine cannot be reached or does not answer within 60 seconds, so the run is tried again; answer the engine's status otherwise (the connector retries 5xx and 429, and logs other refusals).
- Never put a token or a secret in an error or a log line.

### Scheduled jobs

Today: the Worker's cron trigger (`wrangler.jsonc` `triggers`, every 5 minutes) calls `retryDueCallbacks` (`src/decide.ts`) and removes expired OAuth records.

An adapter must:

- Run the jobs regularly; how often decides how late a callback retry is.
- Be safe to run twice at the same time: a callback is claimed before it is sent, so no attempt is sent twice. (A receiver can still get a callback more than once, after a retry: see [reviews.md](reviews.md).)

## Internal calls

An internal call reaches the engine without a token, through a channel of the runtime that is not reachable from outside. On Cloudflare that is a named entrypoint of the engine Worker, `InternalEngine` (`src/index.ts`), which another Worker reaches through a service binding with `"entrypoint": "InternalEngine"`.

Who can call it: only a Worker in the same Cloudflare account that has a binding to it. A named entrypoint has no URL: the Worker's `workers.dev` address and routes reach only its default export (the HTTP API). So the trust boundary is the account: anyone who can deploy a Worker to it can call the entrypoint. That person (or a Cloudflare API token with Workers Scripts: Edit, which is account-wide) can already change the engine Worker itself or bind its token store and decision log, so the entrypoint gives no one more than they have. Keep that permission to the people who deploy the engine.

Who the caller is: the engine decides, not the caller. The engine's setting `INTERNAL_CLIENT` names one client and the profiles it may use, for example `{"client":"github-connector","profiles":["pr-docs-check","workflow-check"]}`. Every internal call is made as that client. Without the setting, every internal call is refused (500 `not_configured`, the log names the setting). `"*"` is not allowed: the profiles are always listed.

What it checks: after the token check, the HTTP route and the internal call run the same code (`decideAnswer` in `src/internal.ts`). So an internal call passes the same checks as the client's token would: the profile scope (a profile outside `INTERNAL_CLIENT` gets the same 403), the body, the idempotency key (per client), the decision log under the client's name, and facts from the decision log, which see only that client's decisions of its profiles. The internal client is never a test token and never expires. The body goes through JSON on the way in, so only JSON values reach the engine, as over HTTP.

What differs from HTTP: edge rules on `/v1/` (a firewall, Cloudflare rate limits) do not see internal calls, as for a connector inside the engine Worker ([connectors.md](connectors.md)). The engine itself has no rate limits on either path.

Today it serves one client per deployment, for `decide` only. A second internal caller or another call would need its own setting.

## Not yet

There is no adapter for another runtime yet. A Node.js adapter comes when a deployment or the tests need it (decided 2026-10-22, #146). Fact providers and connectors are modules, not adapters ([modules.md](modules.md), [connectors.md](connectors.md), #145). A connector inside the Worker reaches the engine through its routes in process (`src/index.ts`); `bridge/src/index.ts` is the Worker entry of the FIWARE bridge in its own Worker. The GitHub connector in its own Worker reaches the engine over HTTP or by an [internal call](#internal-calls); the FIWARE bridge in its own Worker only over HTTP.
