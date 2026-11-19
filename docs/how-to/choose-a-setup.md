---
title: Choose a setup
description: What you need to try Pointsman, to use one that is already running, to run your own, or to connect a FIWARE platform.
sidebar: { order: 5 }
---

What you need depends on what you want to do. To try Pointsman, you need no
cloud account and no AI service: start with the first row.

| You want to | You need | Start here |
|---|---|---|
| Try Pointsman and write a first profile | Node.js 24, pnpm 12 and Git | [Your first profile](../tutorials/first-profile.md) |
| Send cases to a Pointsman that someone already runs | Its URL and an API token from the people who run it | [HTTP API](../reference/http-api.md) |
| Run your own Pointsman | A Cloudflare account, a Cloudflare API token and a private Git repository for your profiles | [Deploy Pointsman](../deployment.md) |
| Connect a FIWARE platform | A running Pointsman, and the broker's URL, tenant and API key or token | [FIWARE bridge](../../bridge/README.md) |

## Try it on your computer

Pointsman runs on your computer with a *mock* AI model, which gives fixed
answers. You make a local API token with one command; it works only on your
computer. [Your first profile](../tutorials/first-profile.md) takes about
15 minutes.

## Use a Pointsman that is already running

Ask the people who run it for two things:

- **The URL** of the Pointsman.
- **An API token** for your client. A token is limited to some profiles. Tell
  them which profiles you need.

Your profiles live in their private configuration repository. To add or
change one, ask them, or send a pull request to that repository. Write and
test the profile on your computer first, as in the tutorial.

An AI agent can use Pointsman too: see [AI and agents](../about/ai.md).

## Run your own

A deployment is a private Git repository made from a template. It pins one
version of Pointsman and holds your profiles. GitHub Actions deploy it to
your Cloudflare account. You need:

- **A Cloudflare account**, where Pointsman stores profiles, tokens and the
  decision log.
- **A Cloudflare API token** for the deploy, kept as a secret of the
  repository.
- **An AI model.** By default Pointsman uses Workers AI in the same
  Cloudflare account, so you need no other key.

The steps: [Deploy Pointsman](../deployment.md).

## Connect a FIWARE platform

The FIWARE bridge connects an NGSI-LD context broker, such as GeonicDB, to
Pointsman. When an entity changes, the broker tells the bridge, the bridge
asks Pointsman, and it writes the decision back to the entity. You need:

- **A Pointsman** that is running (your own, or one you have a token for),
  and an API token for the bridge.
- **The broker's URL**, and the **tenant** if the broker has more than one.
- **An API key or token** for the broker, if it needs one (GeonicDB uses an
  API key).

The settings and the subscription: [FIWARE bridge](../../bridge/README.md).
