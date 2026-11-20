# Done checklist

- `pnpm check` passes, and for docs changes the `docs` job too: `pnpm site:build` and the docs-site dry-run deploy (`mem:suggested_commands`).
- Behaviour change has a test (`test/worker/*.test.ts` for Worker, `test/*.test.mjs` for scripts).
- Fact module, `openapi.yaml` or MCP tool changed → `pnpm docs:reference` run and committed.
- Docs changed → Japanese twin updated, or the PR says it is not.
- API or profile-format change → consumers (pointsman-config, demo repos) need a follow-up PR moving `engine.json` to the release commit, after merge and release here.
- New D1 migration → file in `migrations/`. The deploy workflow applies it; a deploy without the workflow must apply it before deploying the engine (docs/deployment.md).
- Commits signed off (`-s`); no CHANGELOG.md edit outside a release PR.
