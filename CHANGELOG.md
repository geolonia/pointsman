# Changelog

Pointsman follows [semantic versioning](https://semver.org/). Before 1.0, a
minor release (0.x) may change the API, the profile format or the decision
log; the notes say how. Each release is a tag on `main`; its version is in
`package.json`, `openapi.yaml` (`info.version`) and `src/version.ts` (also
the MCP server's version), and, while the fact modules are released with
the engine, in each `packages/*/package.json` and module definition (a test
checks they agree). A deployment pins
the engine by commit in its config repository: to use a release, set
`ref` in `engine.json` to the commit of its tag
(`git rev-parse 'v<version>^{commit}'`, for example `v0.2.0`, which also
works for annotated tags).

## 0.5.0 (2026-10-22)

Fact modules (#145) and a core without Cloudflare (#146): the engine no
longer has its fact providers built in. GSI, Valhalla and GitHub are
modules (packages in this repository), and each deployment chooses the
modules it uses. Profiles, fact names, settings and decisions stay the
same.

### Added

- Fact modules (#154, #155): see [docs/modules.md](docs/modules.md). The
  packages `@pointsman/module-api` (the interface and the capabilities
  `inside`, `nearest`, `detour`), `@pointsman/facts-gsi`,
  `@pointsman/facts-valhalla` and `@pointsman/facts-github`.
- `engine.json` `"modules": { "facts": [...] }` chooses the modules, with
  an optional `@version` that must match. The build bundles only those;
  the profile validator, test cases and explanations use the same list.
  Without `modules`, every module is chosen (as before).
- Each decision records `versions`: the engine version and the modules
  that answer its facts (migration `0007_versions.sql`, `Versions` in
  `openapi.yaml`). Decisions made before have none.
- A fact field can be declared a probability (0 to 1); the engine refuses
  values outside.
- `pnpm check:core` (part of `pnpm typecheck`): the core compiles without
  Cloudflare's types (#153). The adapter boundaries and what each adapter
  must guarantee: [docs/adapters.md](docs/adapters.md).

### Changed

- The fact part of `schema/profile-v1.schema.json` is generated from the
  modules. A setting of another fact type now says so (`"layer" is not a
  setting of this fact type`) instead of `must NOT be valid`.
- A `FACTS_*` setting that no chosen module reads is a config error. Each
  module sees only its own settings.
- A profile version whose facts no chosen module answers fails before the
  model is asked (a config error), instead of after it.
- Detours are answered by `@pointsman/facts-valhalla`; the GSI provider no
  longer forwards them. With `FACTS_MODE: gsi` and no
  `FACTS_ROUTING_URL`, detours are unavailable, as before.
- The decision logic moved from `src/app.ts` to `src/decide.ts`, and the
  Cloudflare stores to their own files (`log-d1.ts`, `auth-kv.ts`,
  `profiles/store-kv.ts`) (#153).

### For deployments

- Optional: add `"modules"` to `engine.json` to bundle only what your
  profiles need. The scripts read `engine.json` from the config
  repository's root, so the workflows need no change.
- The deploy applies migration `0007_versions.sql` as usual.

## 0.4.0 (2026-10-22)

Facts from GitHub (#135, #141): Pointsman reads a pull request itself, so
rules can use its state (draft, changed files, required checks, signed
commits, who pushed, code owners, repository properties, changed GitHub
Actions files). The client names only the pull request, `{ repo, number,
head }`; it cannot claim "docs only" or "the checks passed". Off unless a
deployment turns it on.

### Added

- GitHub fact types `github_pr`, `github_paths`, `github_checks` and
  `github_property` (#135): see
  [GitHub pull requests](docs/profile-format.md#github-pull-requests). All
  facts of a decision come from one read of the pull request; when its head
  commit is not the `head` the client sent, every GitHub fact is missing.
- `github_pr` fields `pushed_by_author` (who pushed the commits, from the
  repository's activity list, up to 500 entries, #142) and
  `author_sole_code_owner` (by the base branch's `CODEOWNERS`, with bounded
  work, #143).
- GitHub fact type `github_workflows` (#141): reads and parses the GitHub
  Actions files a pull request changes and counts known unsafe patterns
  (pwn requests, untrusted input in scripts, write permissions, unpinned
  actions, persisted credentials and more): see
  [GitHub workflows](docs/profile-format.md#github-workflows).
- Settings `FACTS_GITHUB` (`off`, `mock`, `token`, `app`),
  `FACTS_GITHUB_TOKEN`, `FACTS_GITHUB_APP_ID`,
  `FACTS_GITHUB_APP_PRIVATE_KEY` and `FACTS_GITHUB_IGNORE_CHECK`. Read
  permissions only; the token and the key are never logged.
- Example profiles `pr-docs-check` (is a light review enough?, #135, #140)
  and `workflow-check` (are the workflow changes safe?, #141), with test
  cases.
- Explanations (`explain_profile`) and test cases cover GitHub facts.
- Threat model: GitHub as a fact source (#138, #144).

### Changed

- Facts can be missing for two more reasons: `no_pr` (no pull request at
  the fact's path) and `stale` (GitHub has another head commit), also in
  the API (`Fact.reason` in `openapi.yaml`): clients that check the reason
  must accept them. Rules that test `facts.<name>.reason` may want to
  handle them.
- `FACTS_MODE` and `FACTS_GITHUB` are separate: `FACTS_MODE: mock` does
  not answer GitHub facts, and `FACTS_GITHUB: mock` does not answer
  spatial ones.
- Config repository template: AGENTS.md says how to make and revoke a
  short-lived replay token; `actions/setup-node` 7.1.0; Dependabot also
  watches the template's workflows (#136).

### For existing deployments

Move `ref` in `engine.json` to the commit of `v0.4.0` as usual. Nothing
changes until `FACTS_GITHUB` is set. To turn GitHub facts on, set the
secret first, then the setting: with `FACTS_GITHUB: "token"` and no
`FACTS_GITHUB_TOKEN`, the engine refuses every request (a config error).
It also refuses every request when another `FACTS_GITHUB_*` setting does
not fit `FACTS_GITHUB` (for example `FACTS_GITHUB_TOKEN` without
`"token"`), or `FACTS_GITHUB` has another value than `off`, `mock`,
`token` or `app`. See [docs/deployment.md](docs/deployment.md), step 7.

## 0.3.0 (2026-10-21)

Tools for writing and changing profiles, with an AI assistant or by hand
(#128): put a profile into plain sentences, run example cases against it,
and try a changed policy on the decisions already made. The guide
[docs/authoring.md](docs/authoring.md) puts them together.

### Added

- Explain a profile as plain sentences, in English or Japanese, for the
  people who approve it: `GET /v1/profiles/{id}/explain` (JSON, or Markdown
  with `?format=text`), the MCP tool `explain_profile`, and
  `scripts/explain-profile.mjs` for a draft file. The rules are read with the
  engine's own parser (#129).
- Test cases: examples with the action a person expects, in their own
  files (`cases/<id>.yaml`). Cases with answers check the rules without a
  model; cases with a real request are answered by a deployed profile's
  model and facts (`--url`, test token), and the rules of the file are
  applied. `scripts/test-profile.mjs`; the examples have cases in
  `examples/cases/`, run by CI (#131).
- Replay a changed policy on the newest logged decisions of a version:
  how many actions would change, how many decisions would go to a person,
  and how often the new rules give the answer a person gave. No model is
  called; only the policy may change. `POST /v1/profiles/{id}/replay`, the
  MCP tool `replay_profile`, and `scripts/replay-profile.mjs` for a draft
  file (#132).
- Authoring guide [docs/authoring.md](docs/authoring.md), and
  `AGENTS.md` / `CLAUDE.md` in the config repository template, so an AI
  assistant in a config repository follows the same steps (#133).
- Website: a FAQ (#124), and a shorter menu (#127). Examples by use case:
  `examples/README.md` and one README per topic, with a section on the
  website (#126).

### Changed

- Test tokens may also read `GET /v1/profiles/{id}/explain` (it reads no
  decisions). A replay needs a token that is not a test token, and that may
  use the profile and every profile it requires.
- Error codes: `invalid_policy` (400) and `not_policy_only` (409), from
  the replay.
- MCP lists two more tools, `explain_profile` and `replay_profile`.
- `DecisionLog` has a new method, `recent` (only matters for code that
  implements its own decision log).

### For existing deployments

The config repository template has new files. A config repository made from
an older template does not get them by moving `engine.json`; copy them from
`template/config-repo/` when wanted, after `engine.json` points to 0.3.0
(the new workflow step runs a script that 0.2.0 does not have):

- `.github/workflows/validate.yml`: the step that runs `cases/` when the
  folder exists.
- `AGENTS.md` and `CLAUDE.md`: the steps for an AI assistant.

Every token that is not a test token can now replay the profiles in its
scope. A replay lists up to 50 changed decisions of a profile from every
client, with their ids and refs, as the review queue does. A token already
sees the decisions of the profiles in its scope, but check that each token's
scope is what you want.

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
