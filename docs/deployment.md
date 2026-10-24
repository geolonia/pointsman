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
   repository. List the [fact modules](modules.md) your profiles need in
   `modules.facts` (`[]` for none); the build bundles only those. Without
   `modules`, every module is chosen. The workflows refuse to run while a
   `<placeholder>` is left, or a module is unknown
   (`engine/scripts/check-config.mjs`).

4. **Add your profiles** to `profiles/` (`<id>.yaml`, see
   [profile-format.md](profile-format.md)).

5. **Add the secrets** to the repository, in an environment named
   `production`:
   - `CLOUDFLARE_API_TOKEN`: an API token with *Workers Scripts: Edit*,
     *Workers KV Storage: Edit* and *D1: Edit* for the account
   - `CLOUDFLARE_ACCOUNT_ID`

6. **Push to `main`.** The deploy workflow applies the database migrations,
   deploys the engine and publishes the profiles.

7. **Set the callback secret** after the first deploy (once; only needed
   when clients use `callback_url`, see [reviews.md](reviews.md)):

   ```sh
   openssl rand -hex 32 | npx wrangler secret put CALLBACK_SECRET --config wrangler.jsonc
   ```

   Give the same value to the clients that receive callbacks.

   Secrets for facts are set the same way, for example the token for
   [GitHub facts](profile-format.md#github-pull-requests). Set the secret
   first, then turn the facts on: with `FACTS_GITHUB: "token"` and no
   `FACTS_GITHUB_TOKEN`, the engine refuses every request (a config error).

   1. Deploy once with `FACTS_GITHUB` unset or `"off"`.
   2. Set the secret:

      ```sh
      npx wrangler secret put FACTS_GITHUB_TOKEN --config wrangler.jsonc
      ```

   3. Set `FACTS_GITHUB: "token"` in `wrangler.jsonc` and push to `main`.

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
  `wrangler d1 migrations apply`, `wrangler deploy`, `publish-profiles.mjs`.
  The Cloudflare secrets are given only to these three steps. The engine is
  deployed before the profiles are published: a new engine reads older
  profiles, but the running engine may not understand a new profile (for
  example one with facts) and would fail its decisions in between.

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
validate workflow checks your profiles against that engine version, and the
fact modules in `modules`, before anything is deployed.

A newer engine can add database migrations (in the engine repository's
`migrations/`, so `engine/migrations/` in your checkout; for example
`0008_log_facts.sql` in 0.8.0, for facts from the decision log). The deploy
workflow applies them before it deploys the engine, so an update needs no
step of its own. If you deploy without the workflow, apply the migrations
first, from the configuration repository with the engine checked out and
installed (as in step 8) and access to the Cloudflare account:

```sh
engine/node_modules/.bin/wrangler d1 migrations apply DB --remote --config wrangler.jsonc
```

The engine repository itself is fixed in the workflows (`ENGINE_REPOSITORY`),
not taken from `engine.json`: the workflows run the engine's code, the deploy
workflow with the Cloudflare credentials, so a pull request that only edits
`engine.json` cannot point them at other code.

## Connect the GitHub connector

The [GitHub connector](github-connector.md) is a Worker of its own. In the
same Cloudflare account as the engine it can use an internal call, with no
token: a service binding `POINTSMAN` to the engine's `InternalEngine`, and
`INTERNAL_CLIENT` in the engine's config. Without the binding it needs
`POINTSMAN_URL` and an API token (step 8 of [Set up](#set-up)). The
settings, and the steps that switch a connector from its token to the
internal call, are in
[How it reaches Pointsman](github-connector.md#how-it-reaches-pointsman).

## Rotate an API token

Every client that calls Pointsman over its API has its own API token (the
GitHub connector's internal call has none, so there is nothing to rotate for
it). Rotate a token when it is about to expire, when someone who knew it
leaves, or when it may have leaked. These steps replace it without downtime: the old token keeps working
until you revoke it in step 3, unless it expires first. `--keep-old` does
not extend it, so check its expiry with `list` before you start, and finish
before that time.

Run the commands in a checkout of the Pointsman engine, with access to the
deployment's Cloudflare account. In a configuration repository made from the
template, the engine is in `engine/`: run `node engine/scripts/tokens.mjs`
instead. The examples use `--local`, the development Worker on
your computer; for a deployed Worker use `--remote --config <your wrangler config>`.

### 1. Make the new token

```sh
node scripts/tokens.mjs rotate --client github-triage --expires 90d --keep-old --local
```

```text
client:  github-triage
profiles: issue-triage
hash:    53d466bb…
expires: 2027-01-20T15:44:39.807Z

token (shown once, store it as a secret):
pm_…

old token kept; revoke it once the new one is in place:
  node scripts/tokens.mjs revoke --hash 3138a1cc… --local
```

The new token has the same profiles as the old one. It is shown only once:
copy it now. Pointsman stores only a hash of it. (In the output above, the
hashes and the token are shortened.)

`--expires` takes a duration from now (`12h`, `90d`, `2w`) or a date
(`2027-01-31`, the end of that day in UTC), at least one hour away. When the old token had an expiry,
the new one needs `--expires` too, or `--no-expiry`, so that a token never
loses its expiry by accident.

### 2. Give the client the new token

Put the new token into the client's secret store, for example a GitHub
Actions secret, and check that the client still works. Until you finish
step 3, `list` shows the client's name on the new token and on every old
one: two tokens if there was one old token, more if there were several.
That is expected here.

```sh
node scripts/tokens.mjs list --local
```

### 3. Revoke the old token

Run the command that step 1 printed, as it is: it has the same `--local` or
`--remote` and `--config` as step 1. For a deployed Worker it looks like the
second line:

```sh
node scripts/tokens.mjs revoke --hash <old hash> --local
node scripts/tokens.mjs revoke --hash <old hash> --remote --config=<your wrangler config>
```

```text
revoked 3138a1cc…
```

It can take up to about 60 seconds until the old token stops working
everywhere.

### If something goes wrong

- **The client fails with the new token:** the old one still works until
  step 3. Check the secret's name and value, then try again.
- **You lost the new token before step 2:** revoke it with the hash from
  step 1 and start again.
- **The token may have leaked:** skip `--keep-old`. Then the old token is
  revoked at once (it can still take up to about 60 seconds to stop working
  everywhere), and the client fails until it has the new one.

All options of the token script are in the README:
[API tokens](../README.md#api-tokens).
