---
title: Rotate an API token
description: Replace a client's API token with a new one, without a moment in which the client cannot reach Pointsman.
sidebar: { order: 50 }
---

Every client that calls Pointsman has its own API token. Rotate a token when
it is about to expire, when someone who knew it leaves, or when it may have
leaked. These steps replace it without downtime: the old token keeps working
until you revoke it in step 3.

Run the commands in a checkout of the Pointsman engine, with access to the
deployment's Cloudflare account. In a configuration repository made from the
template, the engine is in `engine/`: run `node engine/scripts/tokens.mjs`
instead. The examples use `--local`, the development Worker on
your computer; for a deployed Worker use `--remote --config <your wrangler config>`.

## 1. Make the new token

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
copy it now. Pointsman stores only a hash of it.

`--expires` takes a duration from now (`12h`, `90d`, `2w`) or a date
(`2027-01-31`, the end of that day in UTC). When the old token had an expiry,
the new one needs `--expires` too, or `--no-expiry`, so that a token never
loses its expiry by accident.

## 2. Give the client the new token

Put the new token into the client's secret store, for example a GitHub
Actions secret, and check that the client still works. Until you finish
step 3, `list` shows the client's name on two tokens. That is expected here.

```sh
node scripts/tokens.mjs list --local
```

## 3. Revoke the old token

Run the command that step 1 printed:

```sh
node scripts/tokens.mjs revoke --hash <old hash> --local
```

```text
revoked 3138a1cc…
```

It can take up to about 60 seconds until the old token stops working
everywhere.

## If something goes wrong

- **The client fails with the new token:** the old one still works until
  step 3. Check the secret's name and value, then try again.
- **You lost the new token before step 2:** revoke it with the hash from
  step 1 and start again.
- **The token may have leaked:** skip `--keep-old`. Then the old token is
  revoked at once (it can still take up to about 60 seconds to stop working
  everywhere), and the client fails until it has the new one.

All options of the token script are in the README:
[API tokens](../../README.md#api-tokens).
