# Pointsman (geolonia/pointsman)

The decision engine on Cloudflare Workers, plus FIWARE bridge, GitHub connector, fact modules and the docs site. Public repo.

Canonical docs (do not duplicate): AGENTS.md (changelog rule, issue intake from Slack), README.md (what it does, API, tokens, Development), CONTRIBUTING.md (change flow, docs rules, DCO), CHANGELOG.md header (versioning, how deployments pin `ref`), docs/ (adapters.md, modules.md, connectors.md, profile-format.md, deployment.md), openapi.yaml (the API contract), bridge/README.md.

Source map:
- `src/` = engine core. `decide.ts` (makeDecision/makeReplay), `policy.ts` (rules), `facts.ts`, `mcp*.ts`, `models/` (model adapters), `profiles/` (stores), `modules/` (registry).
- Cloudflare adapters = the only `src/` files that may use CF APIs (`connectors/github/src` is an adapter as a whole): `index.ts`, `app.ts`, `oauth.ts`, `log-d1.ts`, `auth-kv.ts`, `profiles/store-kv.ts`, `models/workers-ai.ts`. List lives in `tsconfig.core.json` and docs/adapters.md; keep both in step.
- `packages/` = pnpm workspace: `module-api` (interface + capabilities in `src/capabilities.ts`), `facts-*`, `github`, `coderabbit`, `fiware` (the bridge as a module).
- `bridge/` = FIWARE bridge Worker; `connectors/github/` = GitHub connector Worker (own Worker on purpose: it holds a write key).
- `actions/` = GitHub Actions `triage`, `deploy-watch` (connectors, not modules).
- `examples/profiles/` = example profiles only (bundled into the dev Worker); `examples/cases/` = their test cases; `template/config-repo/` = starter for a private config repo.
- `scripts/` = node tools (build, validate, tokens, publish, checks); `scripts/lib/modules.mjs` reads `engine.json` when run in a config repo (none at this root; see `template/config-repo/`).
- `migrations/` = D1 SQL, applied in order. `generated/` is git-ignored build output.
- `docs/` = source of the site; `docs-site/` = Astro Starlight build; `site/` = static landing pages. Site pages need `docs/ja/` twins; page lists in `docs-site/pages.mjs`.
- `docs/reference/` pages are generated (`pnpm docs:reference`); `schema/profile-v1.schema.json` fact part is rewritten by `pnpm build`.

Cross-repo: pointsman-config and the demo repos pin an engine commit in their `engine.json` (`repository` + `ref`, config also lists modules). Merge and release here first, then bump `ref` in consumers; never point at an unmerged commit. Docs that demos link to (`docs/fiware-demo.md`, `profile-format.md`, `deployment.md`) live here. Nothing from the private config repo goes into this one.

Further: `mem:tech_stack`, `mem:suggested_commands`, `mem:conventions`, `mem:task_completion`.
