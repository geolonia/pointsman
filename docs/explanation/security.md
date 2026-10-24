---
title: Security
description: What Pointsman protects, against whom, and what it does not promise; with links to the threat model and how to report a problem.
sidebar: { order: 20 }
---

Pointsman decides about cases that other systems send, often written by
people outside the organisation. This page sums up what it protects and
what it does not. The full analysis is the
[threat model](../../threat-model.md).

## API tokens

- Every request to the HTTP API and to MCP needs a token. Without a valid
  one, the answer is 401 and nothing else happens.
- A token acts only on the profiles it was made for, unless it was made
  for every profile (`--profiles '*'`). Other profiles look as if they did
  not exist, also their decisions and reviews.
- Only a SHA-256 hash of each token is stored. The token is shown once, when
  it is made.
- A token can expire; one without `--expires` works until it is revoked. A
  revoke can take up to about 60 seconds to reach every location.
- A *test token* only decides and lists its profiles; its decisions are not
  logged and never reach the review queue. How to replace a token: [Deploy
  Pointsman](../deployment.md#rotate-an-api-token).

## People over MCP

People sign in with GitHub. Only members of the GitHub organisations the
deployment allows get in, and membership is checked at sign-in: someone who
leaves keeps access until the sign-in ends, at most 7 days. A person may use
every profile that is visible over MCP. GitHub's token is used only to read
the login and membership, and is not stored.

## Internal calls

The GitHub connector can call the engine inside the same Cloudflare account
without a token. Every Worker in that account with a binding to the engine
decides as one fixed client, with a fixed list of profiles and no expiry.
So anyone who can deploy code to the account can make such calls: keep that
permission to the people who run the engine.

## Input written by outsiders

The text of a case is written by whoever sent it, and it can try to steer
the AI. Pointsman does not claim to resist this. Profile authors should use
AI answers only to make a decision stricter, and check what must be true
with facts ([why](decision-model.md#ai-answers-only-make-a-decision-stricter)).
Pointsman does not enforce this: where a profile approves on AI answers
alone, the author of a pull request can steer that approval.
Pointsman does not check the content of a request beyond its form: a
profile's input mapping selects fields, it does not validate them.

## Facts and outside services

- Facts are looked up, never guessed; a fact that cannot be read is missing.
- Facts are only as true as their source: GSI and OpenStreetMap data, what
  GitHub reports about a pull request, and for npm dependency bumps the
  publish times from registry.npmjs.org, read without a token.
- GitHub facts read with the deployment's credential, only what they need,
  and only to read. The token is never logged.
- Facts from the decision log see only the asking client's own decisions.

## What is recorded

What the decision log keeps is described under
[The decision log](decision-model.md#the-decision-log). The request is kept
as a plain SHA-256 hash, so equal requests give equal hashes. The log shows
what the engine saw and did, not that the request was true. It is not
signed or chained: whoever runs the deployment can change it. Who resolved a
review (`by`) is a name the client sends, not checked.

## Not promised

Pointsman does not promise that an AI answer is right, rate limits per
client, an allow-list of callback hosts (private addresses are refused), or
exactly-once delivery of callbacks. The threat model lists each of these with
its reason.

## Reporting a problem

Please do not open a public issue for a security problem. The
[security policy](../../SECURITY.md) says how to report one.
