# Conventions

Authoritative: CONTRIBUTING.md and AGENTS.md. Easy to miss:
- Core vs adapter: new code goes into the core unless it needs a runtime API; then a new adapter file, added to `tsconfig.core.json` and docs/adapters.md. Casts like `(globalThis as any).caches` pass `check:core`; reviews catch them.
- New fact source = fact module in `packages/`; new shared fact type = change to `packages/module-api/src/capabilities.ts`. Connectors call the engine only through the public API (docs/connectors.md).
- Only example profiles here. No account/resource ids, real profiles or internal URLs (`check:public`); real config lives in a private repo.
- CHANGELOG.md: only the release PR writes it (AGENTS.md "Changelog").
- Version appears in package.json, `openapi.yaml`, `src/version.ts` and each `packages/*` (a test checks they agree).
- Docs: English page in `docs/<group>/` plus Japanese in `docs/ja/<group>/` with the same headings and code; terms in `docs-site/terms-ja.md`. Moved page → add old URL to `site/_redirects`. New example profile → link it from one `examples/<topic>/README.md` (a test checks).
- Plain English in docs, PRs and commits (issue intake has its own language rule in AGENTS.md); DCO sign-off (`git commit -s`); small PRs with tests.
