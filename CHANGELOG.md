# Changelog

Pointsman follows [semantic versioning](https://semver.org/). Before 1.0, a
minor release (0.x) may change the API, the profile format or the decision
log; the notes say how. Each release is a tag on `main`; a deployment pins
the engine by commit in its config repository (`engine.json`).

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
  person resolved is never replaced. An optional earlier step made for an
  older decision is left out.
- `GET /v1/profiles/{id}/graph`: the chain as JSON, SVG (a left-to-right
  flow) or DMN 1.3 with DMNDI for DMN tools.

### People in the loop

- A review queue for decisions below the thresholds, resolved by API, MCP
  or the FIWARE bridge; the final answer goes to a signed callback.
- Feedback and corrections next to the answers; accuracy per profile
  version and `GET /v1/stats/{profile}`.

### Access

- Per-client API tokens, limited to profiles; test tokens check profiles
  without logging decisions.
- MCP server (`list_profiles`, `decide`, `get_decision`, `submit_feedback`),
  with GitHub login for people.
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
