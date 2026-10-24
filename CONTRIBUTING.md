# Contributing

Thank you for helping with Pointsman. Issues and pull requests are welcome.

## Before you start

- For a bug, open an issue with what you sent, what you expected and what
  happened. Never paste API tokens or private profiles.
- For a larger change, open an issue first, so we can agree on the approach
  before you write the code.

## Making a change

1. Fork the repository and create a branch.
2. Set up as in the [README](README.md#development): Node.js 24 and pnpm 12,
   then `pnpm install`.
3. Make your change with tests. Keep pull requests small: one topic each.
4. Run `pnpm check` (typecheck, tests, profile validation, public-data check
   and a dry-run deploy). It must pass.
5. Sign off every commit with `git commit -s` (see below), and open a pull
   request.

CI runs the same checks, plus security checks for workflows, dependencies and
secrets.

This is a public repository: do not commit organization-specific data such as
account IDs, real profiles or internal URLs. `pnpm check:public` looks for
common cases. Real deployments keep their configuration in a private
repository (see [docs/deployment.md](docs/deployment.md)).

The engine core uses no Cloudflare-specific API: code that needs one is an
adapter, listed in [docs/adapters.md](docs/adapters.md). `pnpm typecheck`
checks this (`pnpm check:core`).

A new source of facts is a fact module, not a change to the engine: see
[docs/modules.md](docs/modules.md). A new shared fact type (a capability) is
a change to `packages/module-api/src/capabilities.ts`.

The documentation site (https://pointsman.net/docs/) is built
from `docs/` with Astro Starlight (`docs-site/`):

- A page written for the site goes in `docs/<group>/` in English and in
  `docs/ja/<group>/` in Japanese, with the same headings and code blocks.
  Write each language natively; do not translate sentence by sentence.
- Link to other files with relative paths, as on GitHub; the build turns
  them into site links. Which older files in `docs/` are site pages, and
  which stay in the repository only (notes, design notes, plans), is set in
  `docs-site/pages.mjs`.
- The older English pages that are on the site (profile format, GitHub
  connector, writing a profile with AI, deployment) have Japanese
  translations in `docs/ja/`. They keep the English section ids
  (`## 見出し {#id}`), tables and code, which `pnpm docs:check` checks; when
  you change one of those English files, update its translation, or note it
  in the pull request. `pnpm docs:translations` lists the English changes
  since each translation's `translatedFrom` commit.
- A page goes on the site only when someone needs it now; there are no
  "planned" pages. When a page is removed or merged, add its old URL to
  `site/_redirects`; the build checks every line.
- The pages in `docs/reference/` marked as generated come from the code:
  after changing a fact module, `openapi.yaml` or the MCP tools, run
  `pnpm docs:reference` and commit the result.
- `pnpm docs:check` (part of `pnpm check`) checks the generated pages, the
  two languages, and that every linked file exists. `pnpm docs:build`
  builds the site and also checks every page and `#anchor` a link points
  at; CI runs both. `pnpm docs:dev` shows the site locally.
- `pnpm site:build` puts the whole site together in `_site/`, as
  pointsman.net serves it, with `/llms.txt` and `/llms-full.txt` for AI
  tools, made from the pages' titles and descriptions.

A new example profile goes in `examples/profiles/` and is linked from one
use-case topic, `examples/<topic>/README.md` (see
[examples/README.md](examples/README.md)). A test checks this.

## Sign-off (DCO)

`Signed-off-by: Name <email>` in a commit states that you agree to the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote
the change or have the right to submit it, and it may be published under this
repository's license (MIT). There is no separate contributor agreement.

- How: `git commit -s` (the name and email must match the commit's author).
- Forgot it: `git rebase --signoff origin/main`, then
  `git push --force-with-lease`. If you would rather not rewrite history, add
  one follow-up commit that signs off the earlier ones, with the text shown in
  the DCO check's details.

The [DCO app](https://github.com/apps/dco) checks that every commit in a pull
request (except bots and merge commits) has a sign-off from its author.

## License

By contributing, you agree that your contribution is published under the
[MIT License](LICENSE).
