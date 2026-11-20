# Commands

- `pnpm install`, `pnpm db:migrate:local`, `pnpm dev` (mock model, example profiles, :8787). Full list: README "Development".
- `pnpm check` = everything CI runs (typecheck, tests, profiles + cases, `check:public`, `docs:check`, dry-run deploy). Run before a PR.
- `pnpm test` = `test:scripts` + `test:worker`; `test:worker` builds first, because `generated/` is git-ignored and Worker tests need it.
- `pnpm validate:profiles`, `pnpm test:cases` = example profiles and their cases.
- `pnpm docs:reference` after changing a fact module, `openapi.yaml` or MCP tools; commit the output. `pnpm docs:dev` = local site, `pnpm site:build` = full site in `_site/`.
- `pnpm docs:translations` = English docs changed since each Japanese translation.
- `pnpm check:public` = no org-specific data (account/resource ids, real profiles) in tracked files.
- `node scripts/tokens.mjs …` = API tokens (README "API tokens").
