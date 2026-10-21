# Changelog

Pointsman follows [semantic versioning](https://semver.org/). Before 1.0, a
minor release (0.x) may change the API, the profile format or the decision
log; the notes say how. Each release is a tag on `main`; its version is in
`package.json`, `openapi.yaml` (`info.version`) and `src/mcp.ts` (the MCP
server's version). A deployment pins
the engine by commit in its config repository: to use a release, set
`ref` in `engine.json` to the commit of its tag
(`git rev-parse 'v<version>^{commit}'`, for example `v0.2.0`, which also
works for annotated tags).

## 0.2.0 (2026-10-21)

### Added

- API tokens can expire: `scripts/tokens.mjs create|rotate --expires <when>`
  (a duration such as `90d`, or a date). The Worker refuses an expired token
  like an unknown one (401), and KV deletes the key then. `rotate` asks for
  `--expires` or `--no-expiry` when the old token had an expiry; `list`
  shows the expiry. The README has a rotation procedure without downtime
  (#121).
- Detour facts name the date of the routing data in `source`, like the GSI
  facts: `… routed with Valhalla (routing data 2026-10-17 時点)`, from the
  routing server's `GET /status` (`tileset_last_modified`), kept for a day.
  `日付不明` when the server cannot say or answers more than a second after
  the routes; a failed `/status` is asked again after five minutes. It is one
  more call to the routing server (with its API key), about once a day per
  Worker instance (#120).
- Example profile `road-restriction-check` v4 looks up the way around by
  car (`drive`) for a closed section, as context: no rule reads it (#122).

### Changed

- The `source` text of detour facts is longer (the date is added). Code
  that compares it with the old fixed text must match the start instead.
- Dependencies: wrangler 4.149, zod 4.6.6, @cloudflare/vitest-plugin 1.4,
  @cloudflare/workers-oauth-provider 1.2.3; actions/setup-node 7.1.0.

## 0.1.0 (2026-10-21)

The first release: what the proof of concept and the FIWARE demo built.

### Decisions

- `POST /v1/decide/{profile}`: typed questions (yes/no, choice, score)
  answered by a model, with probabilities; a policy of rules turns the
  answers into one action. A small condition language, checked when a
  profile is loaded, never run as code.
- Profiles in YAML with a JSON Schema, validated in CI, published
  write-once per version from a private config repository (template
  included).
- Facts from public data in the rules: river flood zones and the nearest
  evacuation site (GSI), the way around a closed road by car or on foot
  (Valhalla on OpenStreetMap). The model never sees them; each fact names
  its source, and `facts.<fact>.reason` says why one is missing.
- Decision chains: a profile `requires` earlier decisions about the same
  `ref`, read from the decision log by id. A final decision can be rules
  only. A person's answer on an earlier step counts, and a final decision a
  person resolved is never replaced. An optional earlier step that was based
  on an older version of another step in the same request is left out.
- `GET /v1/profiles/{id}/graph`: the chain as JSON, SVG (a left-to-right
  flow) or DMN 1.3 with DMNDI for DMN tools.

### People in the loop

- A review queue for decisions below the thresholds, resolved through the
  API (`POST /v1/reviews/{id}/resolve`) or the FIWARE bridge; the final
  answer is sent, signed, to the request's `callback_url` if it gave one.
- Feedback and corrections next to the answers; accuracy per profile
  version and `GET /v1/stats/{profile}`.

### Access

- Per-client API tokens, limited to profiles; test tokens check profiles
  without logging decisions.
- MCP server: `list_profiles`, `decide` and `get_decision` for API tokens;
  people log in with GitHub and can also correct decisions
  (`submit_feedback`).
- OpenAPI description of the REST API.

### Models

- Cloudflare Workers AI (`clef-flash`, `clef`), optionally through AI
  Gateway, with fallback models; an HTTP adapter for your own model server
  (for example a local Strands Decider); a mock model for development.

### Integrations

- FIWARE bridge (`bridge/`): NGSI-LD notifications in, decisions written
  back to the entity, with `Decision` and `Task` entities (datamodels.jp
  models), reviews resolved in the broker or by work orders from other
  apps, chains of routes, and an optional queue for reliable delivery.
- GitHub Actions: issue triage (`actions/triage`) and a deploy watch that
  stops stuck CloudFormation deploys (`actions/deploy-watch`).

### Security

- Threat model (`threat-model.md`) from the Alpha-Omega pilot, and
  `SECURITY.md` for reporting.
