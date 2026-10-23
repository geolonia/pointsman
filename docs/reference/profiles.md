---
title: Profiles at a glance
description: What a decision profile contains, shown on a real example, and where each part is described in full.
sidebar: { order: 5 }
---

A *profile* describes one kind of decision: the questions the AI answers,
the facts Pointsman looks up, and the rules that turn both into an action.
It is a YAML file, kept in your own configuration repository, and every
change gets a new version number.

## An example

This is the example profile
[`issue-triage`](../../examples/profiles/issue-triage.yaml), shortened (the
real file also has an `effort` question and makes the profile visible to
AI agents over MCP). It sends a new issue to a team, or to a person when the
AI is not sure which team. `$.issue.title` is a path into the request
(JSONPath), and `noul` is a yes-or-no question.

```yaml
id: issue-triage
version: 1
title:
  en: Issue triage
  ja: Issue の振り分け
description:
  en: Route a new issue to the right team and flag issues that block work today.
  ja: 新しい Issue を担当チームに振り分け、今日の作業を止めている Issue に印を付ける。
model: clef-flash
fallback_models: [clef]
input:
  - { name: title, path: $.issue.title }
  - { name: body, path: $.issue.body }
questions:
  - name: team
    type: choice
    instructions: Which team should handle this issue?
    criteria:
      - { value: backend, description: "APIs, databases, background jobs" }
      - { value: frontend, description: "Web pages, styles, browser behaviour" }
      - { value: docs, description: "Documentation, tutorials, examples" }
  - name: urgent
    type: noul
    instructions: Does this issue block someone's work today?
    criteria:
      true: Someone cannot continue their work until this is fixed.
      false: Work can continue; this can wait for normal planning.
policy:
  rules:
    - when: "team.p >= 0.85"
      action: auto
  default: review
```

## The parts

| Part | What it is | Details |
|---|---|---|
| `id`, `version` | The profile's name in the API (`POST /v1/decide/issue-triage`) and its version. Increase the version on every change. | [Fields](../profile-format.md#fields) |
| `title`, `description` | What the profile decides, in English and Japanese, for the people who approve it. | [Fields](../profile-format.md#fields) |
| `model`, `fallback_models` | Which AI model answers, and which ones to try when it fails. | [Models](../models.md) |
| `input` | Which parts of the request the AI sees. | [Fields](../profile-format.md#fields) |
| `questions` | What the AI answers: `noul` (yes or no), `choice` (one option) or `score` (a level). | [Question types](../profile-format.md#question-types) |
| `facts` | Data that Pointsman looks up itself (not in this example). | [Facts](../profile-format.md#facts), [Fact types](fact-types.md) |
| `requires` | Earlier decisions this one builds on (not in this example). | [Decision chains](../profile-format.md#decision-chains) |
| `policy` | The rules, checked in order; the first that fits gives the action. `default` applies when none fits. | [Policy conditions](../profile-format.md#policy-conditions) |

## Read it as sentences

`explain-profile` turns a profile into plain sentences, for the people who
approve it. Run it in a checkout of the Pointsman repository, with Node.js 24.
The rules part of its output for this example (shortened):

```sh
node scripts/explain-profile.mjs examples/profiles/issue-triage.yaml
```

```text
## Rules

The rules are checked in this order; the first one that matches gives the action.

1. If the AI's certainty about "team" is at least 85 %, the action is auto.

If no rule matches, the action is review.
```

`--lang ja` gives the same in Japanese:

```text
1. 「team」についての AI の確信度が 85 % 以上なら、アクションは auto です。
```

Before you publish a profile, also validate it and run its test cases; see
[Write a profile with an AI assistant](../authoring.md).
