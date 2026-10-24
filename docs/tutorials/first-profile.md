---
title: Your first profile
description: Run Pointsman on your computer, write a profile, check it with examples, and make a first decision. No cloud account needed.
sidebar: { order: 10 }
---

In this tutorial you run Pointsman on your own computer, write a small
profile that decides about reports, check it with examples, and ask it for
a decision. A *mock* AI model gives fixed answers, so you need no cloud
account and no AI service. It takes about 15 minutes.

What a profile, a rule and an action are: [How a decision is
made](../explanation/decision-model.md). You do not need to read it first.

## Before you start

You need Node.js 24, pnpm 12 and Git. Get the code:

```sh
git clone https://github.com/geolonia/pointsman.git
cd pointsman
pnpm install
```

## 1. Start Pointsman

Create the local decision log, then start Pointsman:

```sh
pnpm db:migrate:local
pnpm dev
```

It is ready when it prints:

```text
[wrangler:info] Ready on http://localhost:8787
```

Leave it running, and use a second terminal for the next steps. This local
Pointsman serves the example profiles in `examples/profiles/`, and its mock
model answers every yes-or-no question with "no", 80 % sure.

## 2. Make a token

Every request needs an API token. Make one for this tutorial, for every
profile (`'*'`), in the local store:

```sh
node scripts/tokens.mjs create --client tutorial --profiles '*' --local
export POINTSMAN_TOKEN=pm_...
```

The command prints the token once (`pm_` and 43 more characters). Put it in
`POINTSMAN_TOKEN`, as in the second line.

## 3. Write a profile

Save this as `examples/profiles/report-check.yaml`. It asks one question
about a report, and has one rule: when the AI is at least 70 % sure that
someone is in danger, the action is `urgent`. Otherwise a person checks the
report (`review`).

```yaml
id: report-check
version: 1
title:
  en: Report check
  ja: 報告の確認
description:
  en: Send a report about danger to the urgent queue, and every other report to a person.
  ja: 危険についての報告を至急の対応に回し、それ以外の報告は人が確認する。
model: clef-flash
input:
  - { name: text, path: $.report.text }
questions:
  - name: danger
    type: noul
    instructions: Does the report say that someone may be in danger now?
    criteria:
      true: Someone may be hurt or in danger now.
      false: Nobody is in danger now.
policy:
  rules:
    - when: "danger.yes >= 0.7"
      action: urgent
  default: review
```

## 4. Check it

Validate it, and read it as plain sentences, as the people who approve a
profile do:

```sh
node scripts/validate-profiles.mjs examples/profiles
node scripts/explain-profile.mjs examples/profiles/report-check.yaml
```

The first command prints `ok` for each profile. The second prints the
whole profile in sentences; its rules read:

```text
## Rules

The rules are checked in this order; the first one that matches gives the action.

1. If the probability that "danger" is yes is at least 70 %, the action is urgent.

If no rule matches, the action is review.
```

## 5. Test it with examples

Test cases say which action you expect for which answers, so a rule that
does not do what you meant is found before anyone uses it. Save this as
`examples/cases/report-check.yaml`, then run it:

```yaml
profile: report-check
cases:
  - name: a sure danger is urgent
    expect: urgent
    answers: { danger: 0.9 }

  - name: an unsure report goes to a person
    expect: review
    answers: { danger: 0.5 }
```

```sh
node scripts/test-profile.mjs examples/cases/report-check.yaml --profiles examples/profiles
```

```text
examples/cases/report-check.yaml (report-check, v1)
  PASS  a sure danger is urgent: urgent
         If the probability that "danger" is yes is at least 70 %, the action is urgent.
  PASS  an unsure report goes to a person: review
         If no rule matches, the action is review.
2 passed, 0 failed, 0 could not run, 0 skipped
```

## 6. Ask Pointsman

Stop Pointsman (Ctrl+C) and start it again with `pnpm dev`, so it loads the
new profile. Then send it a report:

```sh
curl -s localhost:8787/v1/decide/report-check \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state": {"report": {"text": "A tree fell on the road near the school."}}}'
```

The answer (shortened):

```json
{
  "decision_id": "f91cb02c-8f0a-4c47-8011-ba742e148cbc",
  "answers": {
    "danger": { "type": "noul", "value": false, "p": 0.8, "yes": 0.2 }
  },
  "action": "review",
  "profile": "report-check",
  "profile_version": 1,
  "model": "mock",
  "rule": null,
  "review": { "status": "pending" }
}
```

The mock model said "no danger" (`yes: 0.2`), so no rule fit and the default
action `review` applies: the decision waits for a person.

## 7. Check it as a person

List the decisions that wait, then resolve this one: the person says it is
urgent after all, and corrects the AI's answer. Put the `decision_id` from
step 6 into the second command:

```sh
curl -s 'localhost:8787/v1/reviews?profile=report-check' \
  -H "authorization: Bearer $POINTSMAN_TOKEN"
curl -s -X POST localhost:8787/v1/reviews/<decision_id>/resolve \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action": "urgent", "correct": {"danger": true}, "by": "you@example.com"}'
```

The second command answers:

```json
{
  "decision_id": "f91cb02c-8f0a-4c47-8011-ba742e148cbc",
  "action": "urgent",
  "answers": { "danger": { "value": true, "source": "human" } },
  "resolved_by": "you@example.com",
  "callback": "none"
}
```

The correction is kept as feedback, so you can later measure how often the
profile was right.

## What you did

You wrote a profile, read it as sentences, tested it with examples, made a
decision, and checked it as a person. Next:

- [Profile format](../profile-format.md): every field, also facts and
  chains.
- [Write a profile with an AI assistant](../authoring.md): the same steps,
  with an assistant drafting.
- [Deploy Pointsman](../deployment.md): run it for real, with a real model.

To clean up, delete `examples/profiles/report-check.yaml` and
`examples/cases/report-check.yaml`.
