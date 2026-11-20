---
title: Choose a setup
description: What you need to try Pointsman, to use one that is already running, to run your own, or to connect a FIWARE platform.
sidebar: { order: 5 }
---

What you need depends on what you want to do. To try Pointsman, you need no
cloud account and no AI service: start with the first row.

| You want to | You need | Start here |
|---|---|---|
| Try Pointsman and write a first profile | Node.js 24 or newer, pnpm 10.23 or newer, and Git | [Your first profile](../tutorials/first-profile.md) |
| Send cases to a Pointsman that someone already runs | Its URL and an API token from the people who run it | [HTTP API](../reference/http-api.md) |
| Run your own Pointsman | A Cloudflare account and a private GitHub repository for your profiles | [Deploy Pointsman](../deployment.md) |
| Connect a FIWARE platform | A running Pointsman, a Cloudflare account for the bridge, and access to the broker | [FIWARE bridge](../../bridge/README.md) |

## Try it on your computer

Pointsman runs on your computer with a *mock* AI model, which gives the
same fixed answer to every question. You make a local API token with one command; it works only on your
computer. [Your first profile](../tutorials/first-profile.md) takes about
15 minutes.

## Use a Pointsman that is already running

Ask the people who run it for two things:

- **The URL** of the Pointsman.
- **An API token** for your client. A token is limited to some profiles. Tell
  them which profiles you need.

Your profiles usually live in their private configuration repository. To add or
change one, ask them, or send a pull request to that repository. Write and
test the profile on your computer first, as in the tutorial.

An AI agent can use Pointsman too: see [AI and agents](../about/ai.md).

## Run your own

Your deployment is set up from a private GitHub repository, made from a
template. The repository holds your profiles and names the version of
Pointsman to use. On every push to `main`, GitHub Actions deploy it to your
Cloudflare account. Pointsman uses Workers AI in the same account, so you
need no key from another AI service.

The steps: [Deploy Pointsman](../deployment.md).

<details><summary>Everything a deployment needs</summary>

- **A Cloudflare account.** Pointsman stores profiles, tokens and the
  decision log there, and calls Workers AI there.
- **A private GitHub repository**, made from
  [`template/config-repo`](../../template/config-repo/).
- **Two secrets in that repository:** a Cloudflare API token with
  Workers Admin, Workers KV Storage Write and D1 Write, and the Cloudflare
  account id.
- **Optional: an AI Gateway** for logs and limits on the AI calls. Create it
  as [Models](../models.md) says, or remove `AI_GATEWAY_ID` from the config.

</details>

## Connect a FIWARE platform

FIWARE platforms keep their data in a *context broker*, such as GeonicDB.
The FIWARE bridge connects such a broker to Pointsman. When an entity (a
record, for example a road report) changes, the broker tells the bridge.
The bridge asks Pointsman, and writes the decision back to the entity.

The bridge is a small Cloudflare Worker. You need a running Pointsman and
access to the broker. The settings and the subscription:
[FIWARE bridge](../../bridge/README.md).

<details><summary>Everything the bridge needs</summary>

- **A running Pointsman** (your own, or one you have access to), and an API
  token for the bridge, limited to its profiles.
- **A Cloudflare account** to run the bridge in. It can also run inside the
  Pointsman Worker.
- **The broker's URL**, and the **tenant** (a separate data space in the
  broker) if it has more than one.
- **An API key or token** for the broker, if it needs one (GeonicDB uses an
  API key).
- **A shared secret** that you choose. The broker's subscription sends it,
  and the bridge refuses notifications without it.
- **Routes:** for each type of entity, which profile decides, which
  attributes it reads, and where the result goes.

</details>
