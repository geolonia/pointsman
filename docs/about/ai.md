---
title: AI and agents
description: How an AI assistant or agent uses Pointsman, what it may and may not do, and the files on this site for AI tools.
sidebar: { order: 20 }
---

Pointsman is made to be used by AI agents as well as by people and scripts.
An agent asks a profile for a decision instead of deciding on its own, and
its decisions are recorded.

## How this site is made

Much of Pointsman's code and of this documentation was written with AI
assistance. People decide what goes in: every change is a pull request that
people review and merge, and CI checks it (the tests, the generated
reference pages, both languages of every page, and every link). If something
is wrong, please [open an issue](https://github.com/geolonia/pointsman/issues).

## For AI tools that read this site

- **Start here:** [llms.txt](https://pointsman.net/llms.txt), a short index of
  every page of the documentation with one line about each, in English.
- **Everything in one file:** [llms-full.txt](https://pointsman.net/llms-full.txt),
  the text of every English page.
- **The API:** the [HTTP API](../reference/http-api.md) and the
  [MCP tools](../reference/mcp-tools.md), generated from the code.
- This site's `robots.txt` permits search, AI answers and AI training.

## Connecting an AI assistant

Each deployment of Pointsman serves MCP (the Model Context Protocol, which AI
assistants use to call tools) at `/mcp`.

- **People** sign in with GitHub. Only members of the GitHub organizations
  that the deployment allows get in; membership is checked when they sign
  in, so someone who leaves keeps access for up to 7 days
  ([details](../mcp.md#authentication)). Geolonia's own deployment, at
  `https://mcp.pointsman.net/mcp`, is for its teams. To use Pointsman
  yourself, [deploy it](../deployment.md) and use the address of your
  deployment.
- **Scripts and CI** use an API token (`Authorization: Bearer <token>`),
  over MCP or the HTTP API. Each client has its own token, limited to some
  profiles; see [Rotate an API token](../deployment.md#rotate-an-api-token).

In Claude Code, add the server with:

```sh
claude mcp add --transport http pointsman https://<your deployment>/mcp
```

In Claude Desktop and on claude.ai, add it under Connectors as a custom
connector with the same URL. The [MCP server](../mcp.md) page has the
details, also for API tokens.

## What an agent can do, and what it cannot

An agent can:

- list the profiles it may use that are visible over MCP, and read one as
  plain sentences (`explain_profile`);
- ask a profile for a decision, and read a decision again later;
- try a changed policy on the decisions already made (replay), without
  changing anything;
- correct a decision's answers, when a person signed in with GitHub.

An agent cannot:

- change a profile or its rules: people publish profiles from their own
  configuration repository;
- use a profile outside its client's scope: such a profile looks unknown;
- make a decision over MCP that is not recorded: every such decision is
  logged under the client that asked (`github:<account id>` for a person). MCP
  refuses test tokens, whose decisions over the HTTP API are not logged;
- decide a review through MCP: a decision with the action `review` waits for
  a person, and MCP has no tool to resolve it. Over the HTTP API, a client
  whose token may use the profile can resolve reviews
  ([Reviews and callbacks](../reviews.md)), and the name it gives for who
  decided is not checked. So give such a token only to the tool the
  reviewers use, not to an agent.

In profiles whose input is written by outsiders, AI answers can only make a
decision stricter: see
[why](../explanation/decision-model.md#ai-answers-only-make-a-decision-stricter).

## Writing profiles with an assistant

An assistant can draft a profile, and Pointsman's own tools check it: the
schema, the rules read as sentences, the test cases, and a replay on the
decisions already made. A person approves what it says. See
[Write a profile with an AI assistant](../authoring.md).
