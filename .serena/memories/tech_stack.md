# Tech stack

- TypeScript (Worker, packages) + Node `.mjs` scripts. Node 24 (`.node-version`, `engines`), pnpm via `packageManager` in package.json; pnpm workspace = `packages/*` and `docs-site`.
- Hono on Cloudflare Workers; D1 (decision log), KV (profiles, tokens, OAuth grants), Workers AI; MCP server on `/mcp`.
- Tests: `node --test` for `test/*.test.mjs` (scripts); vitest in workerd (`@cloudflare/vitest-plugin`) for `test/worker/` and `test/bridge/`.
- Docs site: Astro Starlight, deployed through `docs-site/wrangler.jsonc`.
- Core must compile without Cloudflare types (`tsconfig.core.json`, `scripts/check-core.mjs`).
- Packages are private (not on npm); the engine bundles them. They share the engine version.

Serena: `typescript` and `markdown` language servers (see `.serena/project.yml`).
