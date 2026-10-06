# Deployment

The engine is open source; everything specific to one organization stays
private. A deployment is a **private config repository** made from
[`template/config-repo`](../template/config-repo/), which pins one engine
commit and holds the profiles and the deploy config.

| What | Where | Visibility |
|---|---|---|
| Engine (Worker, adapters, policy), profile schema, validator, scripts, docs, example profiles | this repository | public |
| Real profiles, wrangler config (resource ids, worker name, routes), AI Gateway settings | your config repository | private |
| Profiles as deployed, API tokens (hashed) | KV namespaces `PROFILES`, `TOKENS` | your Cloudflare account |
| Decision log and feedback | D1 database | your Cloudflare account; never in Git |
| Cloudflare API token and account id | GitHub Actions secrets of the config repository | private |

This repository must not contain account ids, resource ids or real
profiles. `scripts/check-public.mjs` checks that in CI.

## Set up

1. **Create the Cloudflare resources** (once), with `wrangler login`:

   ```sh
   npx wrangler kv namespace create PROFILES
   npx wrangler kv namespace create TOKENS
   npx wrangler d1 create pointsman
   ```

   Create the AI Gateway as described in [models.md](models.md), or remove
   `AI_GATEWAY_ID` from the config to call Workers AI directly.

2. **Create a private repository** from the template: copy the contents of
   `template/config-repo/` into it (including `.github/` and `.gitignore`).

3. **Fill in the placeholders** in `wrangler.jsonc` (the ids from step 1, a
   worker name) and pin the engine in `engine.json` to a commit SHA of this
   repository. The workflows refuse to run while a `<placeholder>` is left
   (`engine/scripts/check-config.mjs`).

4. **Add your profiles** to `profiles/` (`<id>.yaml`, see
   [profile-format.md](profile-format.md)).

5. **Add the secrets** to the repository, in an environment named
   `production`:
   - `CLOUDFLARE_API_TOKEN`: an API token with *Workers Scripts: Edit*,
     *Workers KV Storage: Edit* and *D1: Edit* for the account
   - `CLOUDFLARE_ACCOUNT_ID`

6. **Push to `main`.** The deploy workflow applies the database migrations,
   publishes the profiles and deploys the engine.

7. **Set the callback secret** after the first deploy (once; only needed
   when clients use `callback_url`, see [reviews.md](reviews.md)):

   ```sh
   openssl rand -hex 32 | npx wrangler secret put CALLBACK_SECRET --config wrangler.jsonc
   ```

   Give the same value to the clients that receive callbacks.

8. **Create API tokens** for your clients:

   ```sh
   git clone https://github.com/geolonia/pointsman engine   # once, at the pinned commit
   git -C engine checkout "$(jq -r .ref engine.json)" && pnpm --dir engine install
   node engine/scripts/tokens.mjs create --client my-client --profiles issue-triage --remote --config wrangler.jsonc
   ```

## What the workflows do

- **Validate** (pull requests and `main`; no secrets): checks the config,
  validates the profiles with the pinned engine (so the schema version is
  pinned too), and dry-runs the deploy.
- **Deploy** (`main`): the same checks, a build and dry run, and only then
  `wrangler d1 migrations apply`, `publish-profiles.mjs`, `wrangler deploy`.
  The Cloudflare secrets are given only to these three steps.

## Profile versions

`publish-profiles.mjs` writes `profile:<id>:<version>` keys and an `index`.
A published version never changes: every version is first registered with a
hash of its content in the D1 table `profile_versions`, which (unlike KV) is
strongly consistent. If the content of a registered version differs, the
deploy stops and nothing is written. Increase `version` for every
change; the validation workflow checks this on pull requests
(`scripts/check-profile-versions.mjs`), so a missing bump is caught before the
merge. Old versions stay in KV, so feedback on old decisions is checked
against the version that made them. Removing a profile from the repository
removes it from the index (it can no longer be called), but keeps its versions.

## Updating the engine

Change `ref` in `engine.json` to a newer commit and open a pull request: the
validate workflow checks your profiles against that engine version before
anything is deployed.

The engine repository itself is fixed in the workflows (`ENGINE_REPOSITORY`),
not taken from `engine.json`: the workflows run the engine's code, the deploy
workflow with the Cloudflare credentials, so a pull request that only edits
`engine.json` cannot point them at other code.
