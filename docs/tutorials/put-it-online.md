---
title: Put it online
description: Deploy your own Pointsman to Cloudflare from a private GitHub repository, call it over the internet, and change a profile with a pull request.
sidebar: { order: 30 }
---

So far, Pointsman ran on your computer. Now you put it online, so other
systems can call it over the internet. Your profiles live in a private
GitHub repository, the *config repository*. Each push to it deploys
Pointsman to your Cloudflare account. It takes about 45 minutes.

## Before you start

- Do [Real answers, with photos](real-answers.md) first. You are signed in
  to Cloudflare with Wrangler from there.
- You need a GitHub account, and the [GitHub CLI](https://cli.github.com/)
  (`gh`), signed in with `gh auth login`. The deploy keeps its secrets in a
  GitHub *environment*; in a private repository, that needs GitHub Pro,
  Team or Enterprise.

<details><summary>What you will create, and what it costs</summary>

- A private GitHub repository with your profiles.
- In your Cloudflare account: a Worker (Pointsman itself), two KV namespaces
  (stores for profiles and tokens) and a D1 database (the decision log).
- All of these fit in Cloudflare's free plan for a test like this one. The
  AI calls use Workers AI, as in the last tutorial.

At the end you can delete everything; see [Clean up](#clean-up).

</details>

## 1. Make the config repository

Start in your `pointsman` folder, as at the end of the last tutorial. The
first command goes up one folder; the new folder `my-pointsman` is created
next to `pointsman`. Copy the template, and put the lost-and-found profile
and its test cases into it:

```sh
cd ..
mkdir my-pointsman
cp -R pointsman/template/config-repo/. my-pointsman/
cd my-pointsman
rm profiles/issue-triage.yaml
cp ../pointsman/examples/profiles/lost-and-found.yaml profiles/
mkdir cases
cp ../pointsman/examples/cases/lost-and-found.yaml cases/
```

The profile must be version 1: if you did not clean up after the last
tutorial, run `git -C ../pointsman checkout examples` and copy the two files
again.

Every deploy uses one fixed version of the engine, and the scripts on your
computer should use the same one. So the config repository keeps a copy in
the folder `engine/`, which Git ignores. Get version 0.22.0 (the download
takes a minute):

```sh
git clone https://github.com/geolonia/pointsman engine
git -C engine checkout 42fb81afa0a2e66193f9883115452af4fd022826
pnpm --dir engine install --frozen-lockfile
```

## 2. Create the storage on Cloudflare

Open `wrangler.jsonc` in your editor. It is JSON that may contain comments
(*JSONC*). Give your Worker a name: replace the line with `"name"` by this
one. The name becomes part of the Worker's web address, so use lowercase
letters and dashes:

```jsonc
  "name": "my-pointsman",
```

Then create the two KV namespaces and the D1 database:

```sh
engine/node_modules/.bin/wrangler kv namespace create PROFILES
engine/node_modules/.bin/wrangler kv namespace create TOKENS
engine/node_modules/.bin/wrangler d1 create my-pointsman
```

Each command prints an id (the D1 command calls it `database_id`), for
example:

```text
    {
      "binding": "PROFILES",
      "id": "<32 characters: 0-9 and a-f>"
    }
? Would you like Wrangler to add it on your behalf?
```

Answer **No**: the template already has the entries, you only fill in the
ids in the next step. Keep the three ids until then.

## 3. Fill in the config

In `wrangler.jsonc`, replace each `<placeholder>` with your values:

- `<PROFILES namespace id>` and `<TOKENS namespace id>`: the two KV ids.
- `<D1 database name, e.g. pointsman>`: `my-pointsman`.
- `<D1 database id>`: the D1 id.

Also delete the line `"AI_GATEWAY_ID": "pointsman"` and the comment above
it. As in the last tutorial, Pointsman then calls Workers AI directly. The
line before it now ends the list, so delete its comma too. The start of
`vars` then reads:

```jsonc
  "vars": {
    "PROFILE_SOURCE": "kv",
    "MODEL_MODE": "workers-ai"
```

If you break the file, the check below names the line.

Replace the whole of `engine.json` with:

```json
{
  "repository": "geolonia/pointsman",
  "ref": "42fb81afa0a2e66193f9883115452af4fd022826",
  "modules": { "facts": [] }
}
```

`ref` is the engine version (0.22.0) that every deploy uses. `facts` is
empty, because the lost-and-found profile reads no facts from data. Check
the config and the profile:

```sh
node engine/scripts/check-config.mjs
node engine/scripts/validate-profiles.mjs profiles
```

```text
Config ready.
ok    profiles/lost-and-found.yaml

1 valid, 0 invalid
```

<details><summary>Facts, the AI Gateway, and newer engine versions</summary>

- A profile that reads facts (for example flood zones) needs their module in
  `modules.facts`: see [Fact modules](../modules.md).
- An AI Gateway keeps logs of the model calls: see [Models](../models.md).
- To use a newer engine, put the commit of a newer
  [release](https://github.com/geolonia/pointsman/releases) into `ref`, and
  check it out in `engine/` too.

</details>

## 4. Create the GitHub repository

```sh
git init -b main
git add .
git commit -m "My Pointsman"
gh repo create my-pointsman --private --source . --remote origin
gh api -X PUT 'repos/{owner}/{repo}/environments/production'
```

The last command creates the environment `production`. The deploy reads
its secrets from there. Do not push yet: the deploy needs two secrets first.

**A Cloudflare API token for the deploy.** GitHub keeps it as a *secret*:
the deploy can use it, but nobody can read it back. In the Cloudflare
dashboard, open
[Account API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens),
select **Create Token**, then **Get started** next to **Custom token**.
Choose your account, and add these permissions:

- **Workers Admin**: the first deploy creates the Worker.
- **Workers KV Storage Write**: the deploy publishes the profiles.
- **D1 Write**: the deploy prepares the decision log.

Store the token as a secret. The command asks you to paste it; nothing
appears while you paste, so press Enter once:

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production
```

**Your account id.** `engine/node_modules/.bin/wrangler whoami` shows it in
the column "Account ID". Store it the same way:

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID --env production
```

## 5. Deploy

```sh
git push -u origin main
gh run watch
```

`gh run watch` asks which run to follow: two start at the same time.
Choose **Deploy**. It checks the config and the profile, prepares the
database, deploys Pointsman, and publishes the profile, in a few minutes.
If the push is refused because of `.github/workflows`, run
`gh auth refresh -s workflow` and push again.

To find the address, read the log of the same run (`gh run view --log`,
choose **Deploy** again). The end of the deploy reads (with your names):

```text
Uploaded my-pointsman (2.04 sec)
Deployed my-pointsman triggers (0.79 sec)
  https://my-pointsman.<your-subdomain>.workers.dev
  schedule: */5 * * * *
New: lost-and-found@1
Index: lost-and-found@1
Published.
```

The line that ends in `workers.dev` is the address of your Pointsman.

<details><summary>If the deploy fails</summary>

`gh run view --log-failed` shows the error.

- **"No access to the specified resource"** right after the upload starts:
  the token cannot create a Worker. Give it **Workers Admin**, store it
  again, and run `gh run rerun --failed`.
- **"This Worker does not exist on your account" (code 10007)** right after
  "Uploaded": on the very first deploy, Cloudflare sometimes needs a moment.
  Run `gh run rerun --failed`.
- **"Config not ready"**: a `<placeholder>` is left, or a module name is
  wrong. The message names it.
- **An error about a workers.dev subdomain**: your account has none yet.
  Open **Workers & Pages** in the Cloudflare dashboard once, choose a
  subdomain, and run `gh run rerun --failed`.

</details>

## 6. Call it over the internet

Make an API token on the deployed Pointsman, for the lost-and-found
profile only. The command prints the token once: put it into
`POINTSMAN_TOKEN`, and your address from step 5 into `POINTSMAN_URL`:

```sh
node engine/scripts/tokens.mjs create --client tutorial --profiles lost-and-found --remote --config wrangler.jsonc
export POINTSMAN_TOKEN=pm_...
export POINTSMAN_URL=https://my-pointsman.<your-subdomain>.workers.dev
```

Send the goldfish photo, as in the last tutorial, now to the internet:

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A goldfish, found on the ground." \
  "$(base64 < ../pointsman/examples/tutorials/photos/goldfish-cracker.jpg | tr -d '\n')" > request.json
curl -s "$POINTSMAN_URL/v1/decide/lost-and-found" \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

The answer is the same as on your computer: `"action": "review"`, with food
45 % and alive 33 %. Anyone with the address and a token can now ask your
Pointsman. A request without a valid token gets `401`.

## 7. Change the profile with a pull request

Changes to a profile go through a pull request, so that someone can check
them first. Make version 2 of the profile on a new branch:

```sh
git switch -c bento-rule
```

In `profiles/lost-and-found.yaml`, make the same change as in step 6 of
[the last tutorial](real-answers.md): `version: 2`, and the `policy` block
with the two new rules. Add the two new test cases to
`cases/lost-and-found.yaml` too. Then:

```sh
git commit -am "lost-and-found v2: a person checks what may be alive; throw away food that spoils"
git push -u origin bento-rule
gh pr create --fill
```

On the pull request, the check **Validate profiles and config** runs the
test cases and checks that the version went up. Wait until it passes, then
merge:

```sh
gh pr checks --watch
gh pr merge --squash --delete-branch
gh run watch
```

The deploy publishes the new version (`New: lost-and-found@2`). Send the
bento photo:

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A bento box." \
  "$(base64 < ../pointsman/examples/tutorials/photos/bento.jpg | tr -d '\n')" > request.json
curl -s "$POINTSMAN_URL/v1/decide/lost-and-found" \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

The action is now `discard`, with `"profile_version": 2`.

<details><summary>Where to keep profiles</summary>

| Situation | Where the profiles live |
|---|---|
| One team, one Pointsman | Its own config repository, as in this tutorial. |
| Several teams or apps in one organisation | One shared config repository for the organisation's Pointsman. Each app gets a token for its own profiles only. |
| In an application's own repository | Not supported yet: the template expects a repository of its own. |

Protect `main` so that every change needs a pull request and a passing
check: see the config repository's `README.md`.

</details>

## What you did

You put Pointsman online from a private config repository, called it over
the internet with its own token, and changed a profile with a pull request
that was checked before it went live. Next:

- [Deploy Pointsman](../deployment.md): all settings, tokens with an expiry
  date, and how to rotate them.
- [Choose a setup](../how-to/choose-a-setup.md): connect a FIWARE platform.
- [Write a profile with an AI assistant](../authoring.md): your own profile,
  in your config repository.

## Clean up

To delete everything this tutorial created, run these commands in
`my-pointsman`. Each one asks you to confirm. The KV ids are in
`wrangler.jsonc`:

```sh
engine/node_modules/.bin/wrangler delete --config wrangler.jsonc
engine/node_modules/.bin/wrangler kv namespace delete --namespace-id <PROFILES id>
engine/node_modules/.bin/wrangler kv namespace delete --namespace-id <TOKENS id>
engine/node_modules/.bin/wrangler d1 delete my-pointsman
gh auth refresh -s delete_repo
gh repo delete
```

`gh` may delete repositories only after `gh auth refresh -s delete_repo`.
Deleting the repository also deletes its secrets.
Then delete the API token in the Cloudflare dashboard.
