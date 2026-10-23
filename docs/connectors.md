# Connectors

A **connector** connects Pointsman to another system. It brings cases in (webhooks, notifications, polling) and carries the results out, for example by writing a decision back to a context broker. A connector is a role of a [module](modules.md), like looking up facts; one module can have both roles.

| Module | Role | What it does |
| --- | --- | --- |
| `@pointsman/fiware` | connector | The [FIWARE bridge](../bridge/README.md): NGSI-LD notifications in, the result back on the entity |
| `@pointsman/github` | facts and connector | [GitHub connector](github-connector.md): pull-request webhooks in, a check run with the decision out, and actions a deployment switches on (comment, label, review request, approve), and one decision comment per pull request; in its own Worker |

`actions/triage` and `actions/deploy-watch` are connectors too, as GitHub Actions; they are not modules yet.

## The rule: through the public API

A connector asks the engine only through its public API ([openapi.yaml](../openapi.yaml)), with its own client token. So each of its decisions passes the same checks as any other client's: the token and the profiles it may use, the profile's rules, idempotency, and the decision log, where the decision shows the connector's client name. A connector never calls the engine's code around that. The GitHub connector can instead use an [internal call](adapters.md#internal-calls) when it runs in the same Cloudflare account: no token, but the same checks, as the client the engine names.

A connector says which actions it can carry out, a fixed list (`actions` in its definition), so a review sees everything it may do to the other system. The bridge's are its writes to the context broker. A connector that acts on its own judgement, like the GitHub connector (#147), carries out only the actions a deployment switched on from that list.

## Where it runs

A connector runs in one of two places; its code is the same in both.

- **Inside the engine Worker** (placement `engine`). The Worker serves it under `/connectors/<id>/`, for example `/connectors/fiware/notify`. It reaches the engine in process: a request to the engine's own routes, with its token, without the network. One Worker to deploy.
- **Next to the engine** (placement `own`): its own Worker or process, which calls the engine at its URL. Use this when the connector holds secrets the engine should not have (for example a key that can write to another system), or when it needs to scale or fail on its own.

Each connector says where it can run (`placements`). The FIWARE bridge can run in both. The GitHub connector runs only in its own Worker ([connectors/github](../connectors/github)), because it holds a key that can write to GitHub and the engine must not.

Inside the engine Worker:

- A connector gets only the settings it lists, not the engine's or the other modules'. The list is part of the module, so a review checks it; code in the same Worker could still reach more.
- It is off when none of its settings is set. With some of them missing or wrong, its paths answer 500 (`not_configured`) and the log names the setting, so a half-configured connector is noticed. Other connectors keep working.
- It reaches only the engine's API (`/v1/`), with its own token.
- The Worker's queue consumer hands the messages to its only connector with a queue set up.
- All the work of one request to the connector runs in that request, within the Worker's limits per request (time, subrequests). For many entities per notification, use the bridge's queue: each batch is then a request of its own.
- Edge rules on the engine's `/v1/` paths (a firewall, rate limits) do not see a connector's calls inside the Worker, only the request to `/connectors/…`.

## Choosing connectors

A deployment lists its connectors in `engine.json`, next to its fact modules:

```json
{
  "repository": "geolonia/pointsman",
  "ref": "<engine commit>",
  "modules": {
    "facts": ["@pointsman/facts-gsi"],
    "connectors": ["@pointsman/fiware"]
  }
}
```

- `pnpm build` bundles the chosen connectors into the engine Worker (`generated/modules.ts`). Only connectors with the placement `engine` are served there.
- With `modules` but without `connectors`, no connector is chosen. Without `modules`, every module in this repository is chosen, connectors too; they stay off until their settings are set.
- A version after `@` is checked against the module in the engine, as for fact modules.

A connector in its own Worker is not listed: its Worker imports it (for example [bridge/src/index.ts](../bridge/src/index.ts)).

## The interface

The interface is in `packages/module-api/src/connector.ts`:

- **The definition** (`ConnectorDef`, the module's `connector` part): its `id` (the path under `/connectors/`), `placements`, the `settings` it reads, and its fixed list of `actions`. Data, readable under Node.js.
- **The entry** (`ConnectorEntry`): `connect(env, runtime, placement)` returns the connector, `undefined` when it is off, or throws `ConfigError`. `runtime.engine` is the engine's API: a base URL and a `fetch`.
- **The connector**: `fetch(request)` for its paths (relative to where it is mounted), and optionally `queue(batch)`.

Connector code is part of the core in the sense of [adapters.md](adapters.md): it uses no Cloudflare-specific API (`pnpm check:core` checks this). A queue or another binding is a setting with a small interface (the bridge's `BridgeQueue`).

## Trust

A connector inside the engine Worker runs next to the engine's code, so, like a fact module, a connector from someone else needs a review before a deployment chooses it. In its own Worker it holds only its own secrets and reaches the engine only with its token.
