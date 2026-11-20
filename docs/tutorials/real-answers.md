---
title: Real answers, with photos
description: Let a real AI model answer your profile, send a photo with a case, and change the rules after you see the answers. Needs a free Cloudflare account.
sidebar: { order: 20 }
---

In [Your first profile](first-profile.md), a mock model gave fixed answers.
Now a real AI model answers, in your own Cloudflare account. The example is
a station's lost and found desk: someone hands in an item, and Pointsman
decides what happens to it. You will see the main idea of Pointsman at
work: the AI gives probabilities, and your rules turn them into an action.
It takes about 20 to 30 minutes.

## Before you start

- Do [Your first profile](first-profile.md) first. This tutorial uses the
  same folder.
- You need a Cloudflare account. The free plan is enough.

<details><summary>What this costs, and where your data goes</summary>

The AI model runs on Workers AI, Cloudflare's AI service, in your Cloudflare
account. Workers AI has a free amount every day
([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)),
and this tutorial makes about ten calls. The item texts and photos you send
go to Workers AI in your account. Everything else stays on your computer:
Pointsman, the profile, the token and the decision log.

</details>

## 1. Start Pointsman with a real model

Sign in to Cloudflare with Wrangler, Cloudflare's command-line tool (a
browser window opens). Then start Pointsman:

```sh
pnpm exec wrangler login
pnpm dev:live --var AI_GATEWAY_ID:
```

The colon at the end is right: it sets an empty value. Pointsman is ready
when it prints `Ready on http://localhost:8787`. If port 8787 is in use, it
prints another port; use that one in the commands below.

Use a second terminal for the next steps, with `POINTSMAN_TOKEN` set as in
the first tutorial. If you no longer have the token, make a new one with
another name:

```sh
node scripts/tokens.mjs create --client tutorial-2 --profiles '*' --local
export POINTSMAN_TOKEN=pm_...
```

<details><summary>Why <code>--var AI_GATEWAY_ID:</code>?</summary>

By default, `pnpm dev:live` sends the model calls through an AI Gateway
named `pointsman`, which keeps logs of the calls. Your account has no such
gateway, so the empty value makes Pointsman call Workers AI directly. How
to set up a gateway: [Models](../models.md).

</details>

## 2. Read the profile

The profile is already in the repository:
[`examples/profiles/lost-and-found.yaml`](../../examples/profiles/lost-and-found.yaml).
It asks the AI two questions: what kind of item it is (one choice from a
list), and whether it spoils before tomorrow (yes or no). Read it as
sentences:

```sh
node scripts/explain-profile.mjs examples/profiles/lost-and-found.yaml
```

The part with the rules:

```text
## Rules

The rules are checked in this order; the first one that matches gives the action.

1. If the probability that "kind" is "alive" is at least 50 %, the action is care-now.
2. If the probability that "kind" is "id-or-money" is at least 50 %, the action is police.
3. If the probability that "perishable" is yes is at least 80 %, the action is discard.
4. If the AI's certainty about "kind" is at least 70 % and the probability that "perishable" is yes is less than 30 %, the action is shelf.

If no rule matches, the action is review.
```

## 3. Ask with text

```sh
curl -s localhost:8787/v1/decide/lost-and-found \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state": {"item": {"description": "A black folding umbrella.", "found_at": "Platform 2"}}}'
```

The answer (shortened):

```json
{
  "answers": {
    "kind": { "type": "choice", "value": "umbrella", "p": 0.975 },
    "perishable": { "type": "noul", "value": false, "p": 0.9074, "yes": 0.0926 }
  },
  "action": "shelf",
  "model": "clef-flash",
  "rule": 3
}
```

- `value` is the AI's answer, and `p` is how sure the AI is of it.
- `noul` is a yes-or-no question; `yes` is the probability of "yes".

The AI is 97.5 % sure that it is an umbrella, and 91 % sure that it does
not spoil, so the item goes on the shelf. `rule` counts from 0, so `3` is
the fourth rule. The model does not always give the same numbers, so yours
can differ a little.

Now try `"A goldfish, found on the ground."` as the description. The AI
answers `alive` (86 %), and the action is `care-now`: someone must look after
the fish at once.

<details><summary>The full answer for a choice question</summary>

The answer also lists the probability of every option, for example
`"probabilities": { "umbrella": 0.975, "other": 0.0127, … }`. A rule can read
each one (`kind.probabilities.alive`), or the probability of the top option
(`kind.p`). All fields: [Profile format](../profile-format.md#policy-conditions).

</details>

## 4. Add a photo

The profile also reads up to two photos, at `item.photos` in the request.
A photo is sent as text: its bytes written in base64, in a *data URL*. These
commands put the request into a file, `request.json`, then send it. The
text says "goldfish", but the photo shows something else:

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A goldfish, found on the ground." \
  "$(base64 < examples/tutorials/photos/goldfish-cracker.jpg | tr -d '\n')" > request.json
curl -s localhost:8787/v1/decide/lost-and-found \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

```json
{
  "answers": {
    "kind": {
      "type": "choice", "value": "food", "p": 0.4547,
      "probabilities": { "food": 0.4547, "alive": 0.3299, … }
    },
    "perishable": { "type": "noul", "value": true, "p": 0.7641, "yes": 0.7641 }
  },
  "action": "review",
  "rule": null,
  "review": { "status": "pending" }
}
```

The photo shows a goldfish cracker. Now the AI is not sure: food 45 %,
alive 33 %. No rule fits, so a person checks the item, as in the first
tutorial. Pointsman never stores the photos.

<details><summary>More about photos</summary>

- The profile says where the photos are: `images: { path: $.item.photos, max: 2 }`.
- PNG, JPEG and WebP work, at most 4 MiB each. A photo alone, without
  text, works too.
- The decision log keeps only a hash of each photo: a short fingerprint,
  from which the photo cannot be made again.
- More photos to try are in [`examples/tutorials/photos/`](../../examples/tutorials/photos/):
  an umbrella, a wallet and a bento box. For a PNG file, write
  `data:image/png` instead of `data:image/jpeg`.
- Details: [Profile format, Images](../profile-format.md#images).

</details>

## 5. Find a gap

Send the bento box:

```sh
printf '{"state": {"item": {"description": "%s", "photos": ["data:image/jpeg;base64,%s"]}}}' \
  "A bento box." \
  "$(base64 < examples/tutorials/photos/bento.jpg | tr -d '\n')" > request.json
curl -s localhost:8787/v1/decide/lost-and-found \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d @request.json
```

The AI is 94 % sure that it is food, and 72 % sure that it spoils. That is
below the 80 % of the third rule, so the action is `review`: a person must
check every bento.

There is a second gap. The model does not always answer the same. Once, the
cracker photo gave food 61 % and alive 19 %, and the third rule threw it
away. Something that may be alive should go to a person.

## 6. Change the rules

In `examples/profiles/lost-and-found.yaml`, change `version: 1` to
`version: 2`. Then add the two rules marked `# new` to `policy`:

```yaml
policy:
  rules:
    - when: "kind.probabilities.alive >= 0.5"
      action: care-now
    - when: "kind.probabilities.id-or-money >= 0.5"
      action: police
    - when: "kind.probabilities.alive >= 0.1" # new
      action: review
    - when: "kind.probabilities.food >= 0.8 and perishable.yes >= 0.6" # new
      action: discard
    - when: "perishable.yes >= 0.8"
      action: discard
    - when: "kind.p >= 0.7 and perishable.yes < 0.3"
      action: shelf
  default: review
```

The numbers are a choice: here, 10 % is enough doubt to call a person, and
60 % is enough to throw away food. Choose your own for your cases.

Add two test cases at the end of `examples/cases/lost-and-found.yaml`, and
run them:

```yaml
  - name: a bento that will spoil is thrown away
    expect: discard
    answers: { kind: food, perishable: 0.7 }

  - name: something that may be alive goes to a person
    expect: review
    answers: { kind: { food: 0.5, alive: 0.3, other: 0.2 }, perishable: 0.8 }
```

```sh
node scripts/test-profile.mjs examples/cases/lost-and-found.yaml --profiles examples/profiles
```

The end of the output (the five older cases also pass):

```text
  PASS  a bento that will spoil is thrown away: discard
         If the probability that "kind" is "food" is at least 80 % and the probability that "perishable" is yes is at least 60 %, the action is discard.
  PASS  something that may be alive goes to a person: review
         If the probability that "kind" is "alive" is at least 10 %, the action is review.
7 passed, 0 failed, 0 could not run, 0 skipped
```

Restart Pointsman, so that it loads version 2: press Ctrl+C in its
terminal, then run `pnpm dev:live --var AI_GATEWAY_ID:` again. Send the
bento again. Now the action is `discard`, with `"profile_version": 2`.

## What you did

A real AI model answered your profile, from text and from a photo. When the
answers showed a gap, you changed the rules and proved the change with
tests, without asking the AI again. Next:

- [Choose a setup](../how-to/choose-a-setup.md): run Pointsman online, so
  other systems can use it.
- [Write a profile with an AI assistant](../authoring.md): draft your own
  profile.

To clean up, stop Pointsman (Ctrl+C), undo the changes and delete the
request file:

```sh
git checkout examples/profiles/lost-and-found.yaml examples/cases/lost-and-found.yaml
rm request.json
```
