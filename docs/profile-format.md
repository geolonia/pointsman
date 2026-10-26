# Decision profile format

A decision profile is a named, versioned set of typed questions plus a policy.
The engine sends the questions and a state to a decision model, then the policy
turns the answers into an action.

- Schema: [`schema/profile-v1.schema.json`](../schema/profile-v1.schema.json) (JSON Schema 2020-12)
- Examples: [`examples/profiles/`](../examples/profiles/)
- Validate: `node scripts/validate-profiles.mjs <file-or-directory>...`

## At a glance

This is the example profile
[`issue-triage`](../examples/profiles/issue-triage.yaml), shortened (the real
file also has an `effort` question and makes the profile visible to AI agents
over MCP). It sends a new issue to a team, or to a person when the AI is not
sure which team. `$.issue.title` is a path into the request (JSONPath), and
`noul` is a yes-or-no question.

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

`node scripts/explain-profile.mjs <file>` reads a profile as plain sentences,
in English or Japanese (`--lang ja`); see [Explain](#explain). The rest of
this page describes every field.

Profiles are YAML (or JSON). The file name must be `<id>.yaml`.

To write a profile with an AI assistant, and check it, see
[authoring.md](authoring.md).

## Fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Used in the URL: `POST /v1/decide/{id}`. Lower case, digits, `-`. |
| `version` | yes | Integer, starts at 1. Increase it on every change. Each decision records the version it used. |
| `title`, `description` | yes | Text in English (`en`) and Japanese (`ja`), so that non-engineers can read the profile. |
| `model` | yes | Model id, for example `clef-flash`. `none` for a profile with no questions (rules only, no model call). |
| `fallback_models` | no | Models to try, in order, when the primary model fails. |
| `input` | no | List of `{ name, path }`. Builds the state from a raw client payload with a simple JSONPath (`$.issue.title`). Without it, the request state is sent as is. |
| `questions` | yes | Up to 64 questions (see below). At least 1, unless the profile has `requires`. |
| `requires` | no | Up to 8 earlier decisions the rules read, as `{ name, profile, optional }` (see [Decision chains](#decision-chains)). |
| `facts` | no | Up to 16 spatial facts to look up for each decision, for rules (see [Facts](#facts)). |
| `policy` | yes | `rules` (checked in order, first match wins) and a `default` action; optionally `people_check` and `people_answers` (see [People](#people-check-and-answers)). |
| `mcp` | no | `visible: true` lists the profile and allows calling it through MCP (default false, see [mcp.md](mcp.md)). |
| `log` | no | `store_state: true` keeps the full state in the decision log (default: only a hash, see [decision-log.md](decision-log.md)). |

Actions are `auto`, `review`, or a custom name such as `cancel`. See
[Policy conditions](#policy-conditions).

### Lists, not maps

Questions, choice options and input mappings are lists of objects, not maps
with dynamic keys. Form-based editors (for example Decap CMS) handle lists
well and maps with free keys badly. The engine converts the lists to the maps
that the model APIs expect.

## Question types

The three question types follow the decision model APIs exactly, so that a
profile works with any of them.

| Type | Use | `criteria` in the profile | Model answer |
|---|---|---|---|
| `noul` | Yes / no | Optional `{ true: ..., false: ... }` | `noul`: probability of yes (0–1) |
| `choice` | Pick one option | List of `{ value, description? }`, 2–255 items | `choice` (top option), `probabilities` per option, `confidence` |
| `score` | Rate on an ordered rubric | List of level descriptions, lowest first, 2–10 items | `score` (probability-weighted level, can fall between levels), `probabilities` per level, `legend`, `confidence` |

Question names follow the model APIs: letters, digits, `_`, `.`, `-`, at most
100 characters. Answers come back under the same names. Choice option values
use the same characters, so that policy conditions can refer to them
(`team.probabilities.customer-support`); put readable text in `description`.

## Model API format (checked 2026-10-06)

Clef / Clef-flash (Workers AI, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`)
and Jev (Typesafe) use the same request and response shape:

```json
{
  "model": "clef-flash",
  "state": "free text, or any JSON value",
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "backend": "APIs, databases", "frontend": "Web pages" }
    },
    "urgent": { "type": "noul", "instructions": "Does this block work today?" },
    "effort": { "type": "score", "instructions": "How much work?", "criteria": ["Small", "Medium", "Large"] }
  }
}
```

```json
{
  "model": "clef-flash",
  "answers": {
    "team":   { "type": "choice", "choice": "backend", "probabilities": { "backend": 0.93, "frontend": 0.07 }, "confidence": 0.86 },
    "urgent": { "type": "noul", "noul": 0.12 },
    "effort": { "type": "score", "score": 0.4, "legend": { "0": "Small", "1": "Medium", "2": "Large" }, "probabilities": { "0": 0.65, "1": 0.3, "2": 0.05 }, "confidence": 0.5 }
  },
  "usage": { "input_tokens": 120, "output_tokens": 12 }
}
```

The example values are made up. Notes:

- `noul` answers have only the probability of yes, no `confidence`.
- `choice` criteria are a map of option id to description. A description can
  be a string, an object, an array or `null`. Profiles allow only an optional
  string for now.
- `score` criteria are a list, indexed from 0. Probabilities are keyed by the
  level index as a string.
- `instructions` can also be an object or array in the model APIs. Profiles
  allow only a string for now.
- Clef limits: 1–64 questions, 2–255 choice options, 2–10 score levels, up to
  4 images. Jev documents the same 255-option limit.
- Sources: [Clef-flash model page](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
  ([input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json),
  [output schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-output.json)),
  [Jev docs](https://docs.typesafe.ai/primitives/choice).

## Engine answer format

The engine normalizes model answers (`src/models/normalize.ts`) so that `p` is
always the probability of `value`:

| Type | `value` | `p` | Extra |
|---|---|---|---|
| `noul` | `true` when P(yes) ≥ 0.5 | P(value) | `yes`: P(yes) |
| `choice` | most likely option | its probability | `probabilities` |
| `score` | most likely level (0 = lowest) | its probability | `score` (weighted level), `probabilities` |

Policy conditions use these fields, for example `team.p >= 0.85` or
`stuck.yes >= 0.9` (see below). Answers that do not fit the profile (missing question,
unknown option, probability outside 0–1) are rejected with a `model_error`.

## Policy conditions

`policy.rules` are checked in order. The first rule whose `when` condition is
true gives the action; when no rule matches, `policy.default` applies.

```yaml
policy:
  rules:
    - when: "stuck.yes >= 0.9 and phase.value != 'rolling_back'"
      action: cancel
    - when: "team.p >= 0.85 or team.probabilities.backend >= 0.95"
      action: auto
  default: review
```

A condition compares a question field with a value:

| Field | Question types | Type |
|---|---|---|
| `<question>.value` | all | `noul`: true/false, `choice`: option, `score`: level |
| `<question>.p` | all | number: probability of `value` |
| `<question>.yes` | `noul` | number: P(yes) |
| `<question>.score` | `score` | number: weighted level |
| `<question>.probabilities.<option>` | `choice`, `score` (level index) | number |
| `facts.<fact>.<field>` | facts (see [Facts](#facts)) | as the field |
| `decisions.<name>.<field>` | `requires` (see [Decision chains](#decision-chains)) | as the field |

- Comparisons: `==`, `!=`, `>=`, `>`, `<=`, `<`. Only numbers can be ordered.
- Combine with `and`, `or`, `not` and parentheses. `and` binds tighter than `or`.
- Values: numbers (`0.85`), strings in single or double quotes (`'maps'`),
  `true`, `false`.

Conditions are checked when the profile is validated: a question name that
does not exist, a field the question type does not have, an option that the
question does not list, or a comparison of different types fails validation.
The engine evaluates conditions with its own parser; nothing is run as code.

## Explain

A profile can be read as plain sentences, in English or Japanese, for the
people who approve it. They read the sentences, not the YAML:

```text
1. If the probability that "danger" is yes is at least 70 %, the action is urgent.
2. If the rank of "flood" is at least 5 and the probability that "danger" is yes is at least 40 %, the action is urgent.
```

The rules are read with the engine's own parser, so the sentences say what
the engine does. YAML comments are not part of a profile and are not shown.
Question texts are shown as written.

- **A draft (a file):** `node scripts/explain-profile.mjs <file> [--lang ja] [--json]`.
  The file is validated first; an invalid profile is not explained, and the
  errors are listed. The profiles it requires are read from the same
  directory and from each `--with <file-or-directory>`.
- **A published profile:** `GET /v1/profiles/{id}/explain` (`?lang=ja`,
  `?version=N`, `?format=text` for Markdown), and the MCP tool
  `explain_profile` for profiles that MCP shows. A required profile that the
  caller may not use is not named, and a rule that reads it is shown as
  written.

This is the first part of AI-assisted profile authoring (#128): an assistant
drafts a profile, and the person approves what the sentences say.

## Test cases

Test cases are examples with the action a person expects. They are kept in
their own files, one per profile (for example `cases/<id>.yaml`, not next to
the profiles: every file in the profiles directory must be a profile), and
show whether the rules do what the person wants, now and after each change:

```yaml
profile: road-restriction-check
cases:
  - name: a possible danger in a deep flood zone is urgent
    expect: urgent
    answers: { category: closedWeather, status_matches: true, danger: 0.45, clarity: 2 }
    facts: { flood: { inside: true, rank: 5, class: 3 to 5 m } }
  - name: a real report from last week
    expect: publish
    state: { roadName: { type: Property, value: 県道 12 号 }, description: { type: Property, value: … } }
```

A case gives either **answers** or a **state**:

- **answers**: what the AI answered, written short, plus `facts` and earlier
  `decisions` when the rules read them. Only the rules are checked, without
  a model, so these cases are free and always give the same result.
  - yes/no: `true`, `false`, or the probability of yes (`0.45`)
  - choice: an option (`closedWeather`), or probabilities by option
    (`{ closedWeather: 0.7, other: 0.3 }`)
  - score: a level (`2`), or probabilities by level (`{ "1": 0.2, "2": 0.8 }`);
    the weighted level is computed from them
  - facts: the fact's fields, or `missing`, or `{ missing: <reason> }`. A
    fact left out is missing. The fields follow what the engine gives: the
    first one says whether something was found (`inside`, `found`,
    `possible`). When it is false, leave the others out (not inside: rank 0,
    class ""). When it is true, give the others (a name and a route may be
    left out).
  - decisions: `{ action, outcome, reviewed, answers, facts }`, or `missing`.
    Without a person (`reviewed` left out), the outcome is the action, so one
    of them is enough. With `reviewed: true`, give both: the action, and the
    person's answer as the outcome.
- **state**: a real request. A deployed Pointsman's published profile of the
  same id answers it (its model and its facts), and the rules of the profile
  file are applied to those answers. So a changed threshold can be tried on
  real reports before it is published. The answers must fit the file's
  questions; for new questions, publish them first or use answers. Not for
  profiles with `requires`.

Run them with:

```sh
node scripts/test-profile.mjs cases --profiles profiles
# cases with a state too, through a deployment, with a test token:
POINTSMAN_TOKEN=pm_… node scripts/test-profile.mjs cases --profiles profiles --url https://pointsman.example.workers.dev
```

The profiles are validated first. Each case prints PASS or FAIL with the rule
that matched, as a sentence (see [Explain](#explain)), or ERROR when it cannot
run (for example an answer for a question the profile does not have), or SKIP;
`--lang ja` for Japanese, `--json` for the results as JSON. A failed case, or
one that cannot run, makes the exit code 1. Cases with a state are skipped
without `--url`.

With `--url` (https, or http on localhost), use a test token: its decisions
are not logged. Any other token is refused after its first answer, but that
one decision is logged, and may wait for a person in the review queue. Each
case with a state is a model call.

The examples in this repository have cases in
[examples/cases/](../examples/cases/), run by CI. A config repository made
from the template runs `cases/` in its validation workflow when the folder
exists.

## Replay

A replay shows what a changed policy would have decided on the decisions a
deployment has already made, before the change is published:

```text
road-restriction-check: the draft's rules on 200 decisions of version 4 (2026-10-14 01:00 to 2026-10-21 03:00 UTC).
  12 would get another action.
    review → publish: 9
    urgent → review: 3
  To a person: 64 now, 55 with the new rules.
  Of the 30 a person answered, the new rules give the person's answer for 18.
```

The last two lines are about people: how many decisions go to a person now
(an action in the published `people_check`) and would with the new policy
(the draft's `people_check`), and, for the decisions a person answered, how
often the new rules would have given that answer by themselves.

Only the **policy** changes: the logged answers and facts are used as they
were, so no model is called, and the questions, facts and requires must be
the same as in the published version (for new questions, publish them first
and use [test cases](#test-cases) meanwhile). Earlier decisions are read from
the snapshot each decision keeps: their action, outcome and whether a person
checked them, and the values the old rules read. When a new rule reads a
value the old rules did not keep, the decision is not replayed: it is counted
as **inexact** and left out of every other number (every rule's reads count,
so this errs on the side of inexact). A decision whose log lacks an answer
the new rules read is **skipped** the same way. The profiles a profile
requires are read at their latest version, as for a new decision.

The newest decisions of the version are replayed, including ones a later
decision about the same thing replaced (they were made), so one ref can
count more than once.

- **A draft (a file):** `POINTSMAN_TOKEN=pm_… node scripts/replay-profile.mjs <file> --url <pointsman url>`
  (`--limit N`, default 200, at most 500; `--version N`; `--lang ja`;
  `--json`). The draft is validated first. Its questions, facts and requires
  are sent along and checked to be the same.
- **API:** `POST /v1/profiles/{id}/replay` with `{ "policy": { … } }` (and
  optionally `version`, `limit`, `questions`, `facts`, `requires`).
- **MCP:** the tool `replay_profile`.

A replay reads logged decisions, so the token must be allowed to use the
profile and every profile it requires, and test tokens cannot replay. It lists
at most 50 changed decisions (id, time, ref, before and after, and the
person's answer), from every client of the profile; the counts cover all of
them.

## Decision chains

A profile can build on earlier decisions about the same report: a final step
that reads the first check and the map checks. The design, with the DMN
mapping, is in [decision-chains.md](decision-chains.md).

```yaml
model: none
requires:
  - { name: check, profile: road-restriction-check }
  - { name: evacuation, profile: evacuation-access-check, optional: true }
questions: []
policy:
  rules:
    - when: "decisions.check.outcome == 'reject'"
      action: reject
    - when: "decisions.evacuation.outcome == 'alert'"
      action: urgent
    - when: "decisions.check.outcome == 'urgent'"
      action: urgent
    - when: "decisions.check.outcome == 'publish'"
      action: publish
  default: review
  people_check: []
```

A rule that leads to an action nobody answers keeps a report there: here
`review` only means the first step's review is still open, and answering it
runs the final step again (the first step sends deep flood zones to a person;
see examples/profiles/).

The request sends the ids of the earlier decisions, by name, and a `ref`:
`{"state": {}, "ref": "report-7", "decisions": {"check": "<decision_id>"}}`.
Pointsman reads them from the decision log; the caller cannot claim a result.
Each one must be of the named profile, in the token's scope, with the same
`ref` and made by the same client, and the newest decision of its profile
for that report (an older one was replaced). Every
other case gives the same `400` (`decisions.<name> is not a usable
decision`), so a token cannot find out which decisions exist. One exception:
an `optional` decision that was itself made from an older decision than one
given here (for example an evacuation check made for an earlier first check)
is left out, as if it had not run. Then `decisions.<name>.missing` is true,
and the answer's `requires` does not list it: compare it with what you sent.
A required one in that case is refused. Test tokens cannot send `decisions`.

Rules read these fields:

| Field | Type | Meaning |
|---|---|---|
| `decisions.<name>.missing` | boolean | the decision was not given (only for `optional`); always known |
| `decisions.<name>.action` | text | the action Pointsman decided |
| `decisions.<name>.outcome` | text | what counts now: the person's answer when its review was resolved, otherwise the action |
| `decisions.<name>.reviewed` | boolean | a person resolved its review |
| `decisions.<name>.answers.<question>.<field>` | as for questions | its answers; a person's corrected values when the review was resolved with corrections |
| `decisions.<name>.facts.<fact>.<field>` | as for facts | its facts |

A missing optional decision makes every field but `missing` unknown, as for
a missing fact. The decision keeps what the rules read from each one in
`requires` (see [decision-log.md](decision-log.md)).

When profiles are validated, they are checked as one set: each required
profile must be in the set, a profile cannot require itself or form a cycle,
and every field and value a rule reads must exist in the required profile (its
questions, facts, actions and `people_answers`). So a change to a required
profile that breaks a profile built on it fails validation and names it. The
name `decisions` cannot be used for a question.

A newer decision of the same profile, `ref` and client replaces the earlier
one: the response has `replaces` with the earlier id, and its open review is
closed as `superseded`; it can no longer be resolved. Once a person has
resolved a review of a profile with `requires`, a new decision for that
report is refused (`409 resolved_by_person`): a person's answer stays. When
the person resolves it while the new decision is being made, the new one is
logged as discarded (`discarded_at`; it never counts) and the answer is the
same `409`, also for a retry with the same idempotency key.

### People: check and answers

- `policy.people_check` lists the actions a person checks before they count
  (default `[review]`). Each decision with one of these actions opens a review
  (see [reviews.md](reviews.md)); the decide response then has
  `review: {status: pending}`.
- `policy.people_answers` lists the answers a person may give when resolving
  a review (default: the profile's actions without `review`, plus `reject`).
  Any other answer is refused (`400`). `review` is never an answer.

```yaml
policy:
  rules:
    - when: "closed.yes >= 0.8"
      action: urgent
  default: review
  people_check: [review, urgent]
  people_answers: [publish, reject]
```

## Facts

A language model is weak at geometry: given coordinates, it guesses
distances and areas. Facts are computed by spatial operations instead, and
rules use them directly, so measurable things stay exact and explainable.
Background and measurements: [spikes/spatial-facts.md](spikes/spatial-facts.md).
Facts can also come from GitHub: the state of a pull request, read by
Pointsman itself ([GitHub pull requests](#github-pull-requests)).

```yaml
facts:
  - { name: flood, type: inside, layer: gsi-flood-max, at: $.location.value }
  - { name: shelter, type: nearest, layer: gsi-shelters-flood, at: $.location.value }
  - { name: detour, type: detour, at: $.location.value }

policy:
  rules:
    - when: "facts.flood.rank >= 5 and danger.yes >= 0.4"
      action: urgent
    - when: "facts.detour.extra_m >= 300"
      action: review
    - when: "facts.flood.missing == true"
      action: review
  default: auto
```

| Field | Meaning |
|---|---|
| `name` | Used in rules as `facts.<name>.<field>`. Same characters as question names. No question may be named `facts` or start with `facts.`. |
| `type` | `inside`, `nearest` or `detour` (below), or a [GitHub fact](#github-pull-requests). Fact types come from the [fact modules](modules.md) the deployment chooses: a profile can use only the types of those modules. |
| `at` | JSONPath to a GeoJSON `Point` or `LineString` (WGS 84) in the request state, for example `$.location.value` for an NGSI-LD `GeoProperty`. Read from what the client sends, before the `input` mapping. Through MCP, clients send the input fields themselves, so there `at` reads those (for example `$.location`). |
| `layer` | For `inside` and `nearest`: the layer to look in. Layers are set up per deployment (source, licence, attribution), not in the profile. |
| `mode` | For `detour`: `drive` (default) or `walk`, the way around by car or on foot. |
| `route` | For `detour`: `true` to also return the way around (`route`). Default `false`: the route starts and ends at the section, so it shows the place, and facts are stored with every decision even when the state is not ([decision-log.md](decision-log.md#what-is-stored)). |

| Type | Fields | Notes |
|---|---|---|
| `inside` | `inside` (boolean), `rank` (number), `class` (text) | Inside an area of the layer. `rank` and `class` describe the area, for example a flood depth class. Not inside: `rank` 0, `class` empty. |
| `nearest` | `found` (boolean), `distance_m` (number), `name` (text) | The nearest feature of the layer. None found: `found` false, no distance or name. |
| `detour` | `possible` (boolean), `extra_m` (number), `route` (text) | Extra metres around a closed section, by car or on foot (`mode`). Needs a `LineString`. No way around: `possible` false, no `extra_m`. `route` is the way around, from one end of the section to the other, as an encoded polyline with precision 6 (as Valhalla sends it), so that apps can draw it. It has a value only when the fact sets `route: true`, the server sent a valid shape, and it is at most 6,000 characters. Rules cannot refer to it. |

Every fact also has `missing` (boolean) and `reason` (text: why it is
missing; unknown when it is not missing).

**A missing fact is never guessed.** A lookup can fail: no location in the
state, or not of the kind the fact needs, for example a point for a
`detour`, which needs a road section (`no_location`), no fact provider (`unavailable`), too slow
(`timeout`, 3 s per fact, 8 s for `detour`, 5 s for GitHub facts) or an error (`error`).
GitHub facts have two more reasons, `no_pr` and `stale`
([below](#missing-github-facts)). A comparison with a missing
fact, or with a field that has no value, is *unknown*, and a rule matches
only when its condition is true:

- `false and unknown` is false, `true or unknown` is true, `not unknown` is
  unknown;
- `facts.<name>.missing == true` is always known: use it to send decisions
  with missing facts to a person.
- `facts.<name>.reason` tells a failed lookup from one that does not apply:
  `facts.walk.missing == true and facts.walk.reason != 'no_location'` sends
  only a real failure to a person, not a report that marks a point. A
  `reason` that is not one of the reasons is refused when the profile is
  validated. A `reason` comparison on its own never matches a fact that was
  found (its reason is unknown): keep the `missing == true` part.

The facts are looked up while the model answers. Each decision returns them
and the decision log keeps them (`facts`):

```json
"facts": {
  "flood": { "missing": false, "values": { "inside": true, "rank": 5, "class": "3 to 5 m" }, "source": "…" },
  "detour": { "missing": true, "reason": "timeout" }
}
```

The model does not see the facts. In the spike, facts in the model's input
raised `danger` even where they were reassuring.

### Fact providers

Spatial facts come from the [fact modules](modules.md) `@pointsman/facts-gsi`
(`inside`, `nearest`) and `@pointsman/facts-valhalla` (`detour`).
`FACTS_MODE` in the wrangler config switches both (GitHub facts have their
own setting, [`FACTS_GITHUB`](#settings)):

| `FACTS_MODE` | Facts |
|---|---|
| `off` (default) | none: every fact is missing (`unavailable`) |
| `mock` | fixed answers for development and tests: inside (rank 1), nearest 250 m, no detour |
| `gsi` | public data of the Geospatial Information Authority of Japan (GSI), layers below; `detour` with a routing server (`FACTS_ROUTING_URL`, below), otherwise `unavailable` |

Layers of `gsi`:

| Layer | Type | Data |
|---|---|---|
| `gsi-flood-max` | `inside` | River flood hazard zones for the maximum assumed rainfall (洪水浸水想定区域 想定最大規模), from the hazard map portal's raster tiles at zoom 17. `rank` 1 to 8 and `class` follow the portal's legend: below 0.3 m, below 0.5 m, 0.5 to 1 m, 0.5 to 3 m, 3 to 5 m, 5 to 10 m, 10 to 20 m, 20 m or more. Where a map does not split a class, the wider label is used. A line gets the deepest class along it. |
| `gsi-shelters-flood` | `nearest` | Designated emergency evacuation sites for floods (指定緊急避難場所, 洪水), GeoJSON tiles. Only sites within 5 km count. |

- Both are free to use, also commercially, with attribution. Each fact's
  `source` is the attribution text with the data date (for example
  「ハザードマップポータルサイト」洪水浸水想定区域（想定最大規模）を加工して作成（2025-08-20 時点）);
  a page that shows a fact shows its `source` too.
- Tiles are cached for a day, in memory and in the Workers cache. A flood
  lookup reads one or a few tiles (at most 16). An evacuation site lookup
  reads the tiles within 5 km: up to four of about 350 KB for a point, up to
  nine for a long line (about 3 MB with cold caches; fine on Workers Paid).
- The date in `source` is the oldest date of the tiles that had data, and
  "日付不明" when one of them has no date.
- A colour that is not in the legend fails the lookup (`error`) instead of
  guessing, so a change of the tiles shows up at once.

### Detours

With `FACTS_ROUTING_URL` (the URL of a [Valhalla](https://github.com/valhalla/valhalla)
server: https, http only for localhost; no credentials, query or fragment;
only with `FACTS_MODE=gsi`), `detour` facts are answered: the way between
the two ends of the closed section, with and without the section, by car
or on foot (`mode`; Valhalla's `auto` and `pedestrian` costing;
OpenStreetMap data). `source` names the data and the date of the routing
tiles, for example `© OpenStreetMap contributors (ODbL), routed with
Valhalla (routing data 2026-10-17 時点)`: the build time of the tiles
(`tileset_last_modified` in the server's `GET /status`, UTC), kept for a
day per Worker instance. Without it the date is `日付不明`, and `/status` is
asked again after five minutes; a failed or slow `/status` (more than a
second after the routes) never fails the fact.
A server that needs a key (such as Geolonia's hosted Valhalla) gets it from
the Worker secret `FACTS_ROUTING_API_KEY`, sent as the `x-api-key` header.
The key is never logged and never sent to browsers. Redirects are not
followed (they would carry the key to another host): a 3xx answer is an
`error`.

- The whole section is closed except 20 m at each end, measured along it:
  Valhalla drops every road an exclusion area touches, and a route cannot
  start on a dropped road. If that finds no route, a small box at the middle
  closes it instead. No closure may cover either end; a section too short for
  that is an `error`, not "no way around".
- Valhalla closes whole road edges, so "no path" with the section closed
  cannot tell "no way around" from "the road at an end is closed too": it is
  an `error`, like any other failure. This provider never answers
  `possible: false`.
- Sections longer than 5 km are refused (`error`).
- The ways with and without the section are asked for at the same time, so
  a server that starts cold (for example on AWS Lambda) delays the answer
  once, not twice. A `detour` fact has 8 s instead of 3 s for that.
- A call that gets no connection or a gateway answer (502, 504) is tried
  once more, after a short pause, within those 8 s. A server that refuses
  the request (wrong key: 403; too many requests: 429) or says it is
  overloaded (503) is not asked again: the fact is `error`, and the Worker
  log shows the status. A detour fact makes at most 6 calls.
- Facts are looked up while the model answers, so a slow routing server
  adds waiting only when it is the slowest part: at most 8 s for a decide.

Geocoding is still open (issue #65).

### GitHub pull requests

Pointsman can read a pull request from GitHub itself, so rules can use its
state: is it a draft, which files does it change, did the required checks
pass? The client names only the pull request. It cannot claim "docs only"
or "the checks passed".

```yaml
facts:
  - { name: pr, type: github_pr, at: $.pull_request }
  - name: docs
    type: github_paths
    at: $.pull_request
    paths: ["docs/**", "**/*.md"]
    except: ["**/AGENTS.md"]
  - { name: ci, type: github_checks, at: $.pull_request }
  - { name: level, type: github_property, at: $.pull_request, property: security-level }
```

`at` points to the pull request in the request state:

```json
{ "pull_request": { "repo": "octo-org/demo", "number": 7, "head": "<the full 40-character commit id>" } }
```

`head` is the commit the client saw. If the pull request on GitHub has
another head commit, every GitHub fact is missing (`stale`), so rules never
decide on a state the client did not see.

| Type | Fields | Notes |
|---|---|---|
| `github_pr` | `open`, `merged`, `draft`, `wip_title`, `base_is_default`, `author_member`, `author_dependabot`, `fork`, `all_commits_verified`, `author_sole_code_owner` (booleans); `files`, `changed_lines` (numbers); `pushed_by_author` (text) | `wip_title`: "WIP" is a word in the title (`WIP: …`, `[WIP] …`). `changed_lines`: lines added plus lines removed. `base_is_default`: the pull request targets the default branch. `author_member`: the author is a member of the organization that owns the repository (for a person's repository: the author is that person); no value when GitHub does not tell (the token cannot see private members, or may not read members). `author_dependabot`: the author is the `dependabot[bot]` app. `fork`: the changes come from another repository. `all_commits_verified`: every commit has a signature that GitHub verified; for a pull request by Dependabot, every commit must also be Dependabot's own: its author is the `dependabot[bot]` app and its committer is GitHub (`web-flow`, which signs it), so a commit someone else adds and signs with their own key makes it false; no value for more than 250 commits (GitHub lists no more). `pushed_by_author`: who pushed the commits, from the repository's activity list (pushes to the head branch; a push brings the commits after its previous head): `yes` when every commit came in a push by the author, `no` when one came in a push by someone else (for example "Update branch" clicked by a reviewer), `unavailable` when GitHub does not show it and no push by someone else is known (pushes older than the newest 500 entries of the branch's activity list, a fork the token cannot see, more than 250 commits). A signature cannot show who pushed, so this is the only source. `author_sole_code_owner`: the author is the only code owner of every changed file (both names of a renamed file), by the `CODEOWNERS` file of the base branch; a team owns as its members. False when another person, team or email address owns a file, a file has no owner, there is no `CODEOWNERS` file, no file changed, or more than 1,000 files changed. A `CODEOWNERS` file or team that cannot be read makes the whole fact missing, and so does a `CODEOWNERS` file over the limits under [One snapshot](#one-snapshot). |
| `github_paths` | `any`, `all` (booleans), `count` (number) | The changed files that match `paths` and none of `except`: `any` is true when there is one, `all` when every changed file matches, `count` says how many. `all` is false when no file changed. A renamed file has two names: it counts for `any` when one of them matches, and for `all` only when both do. |
| `github_checks` | `required` (number), `green`, `pending`, `failed` (booleans) | The required checks of the base branch (rulesets and branch protection) and the workflows that a ruleset requires, on the head commit. `green`: every one passed (success, neutral or skipped). `failed`: one failed. `pending`: none failed, and one has not finished or not reported yet. `green` is false when there are no required checks. Two required workflows with the same path from another repository or ref fail the fact (`error`): a workflow run names its file by path only, so one run could count for both. The same workflow (path, repository and ref) required by more than one ruleset counts once in `required`. |
| `github_property` | `value` (text) | The repository's custom property `property`. A property that is not set is `unset`: a known value, not a missing fact. A list (multi-select) is sorted and joined with commas. |
| `github_workflows` | counts (numbers), `detail` (text, not for rules) | The GitHub Actions files the pull request changes: see [GitHub workflows](#github-workflows). |
| `github_copilot` | `requested`, `reviewed_head`, `approved_head` (booleans), `reviews` (number) | Copilot's code review. `requested`: a Copilot review is requested now. `reviewed_head`: Copilot reviewed the head commit. `approved_head`: Copilot's latest review that decides (approve, request changes, or a dismissed one) approves the head commit. `reviews`: how many reviews Copilot made on the pull request. Only Copilot's own bot account counts (its login and its account id), so a person or another app cannot stand in for it. Without Copilot: false, false, false, 0. Copilot usually leaves its review as a comment, so `approved_head` is true only where it approves. |
| `github_app_approval` | `approved_head`, `approved_any` (booleans), `reviews` (number) | Whether a GitHub App's approval stands, for example the GitHub connector's own approval ([github-connector.md](github-connector.md#actions)). The app is the fact's `app` (and `bot_id`). `approved_head`: the app's latest review that decides (approve, request changes, or a dismissed one) approves the head commit. A dismissed approval has the state "dismissed" on GitHub, so it never counts; an approval of an older commit does not count either. `approved_any`: that latest review approves, on any commit. `reviews`: how many reviews the app made on the pull request (pending ones left out). Only the app's own bot account counts: the account type is Bot, the login is `<app>[bot]`, and with `bot_id` the account id must match too. Another app, a person, or a person named like the app never counts. Without a review by the app: false, false, 0. |
| `github_release` | `version_only` (boolean); `from`, `to`, `level` (text) | Whether the pull request only moves a version, as a release pull request does. `version_only` is true when every changed file is either a changelog (`changelogs`, default `CHANGELOG.md`; new or edited, only lines added) or an edited file where each changed line is the same line with one version string (`1.2.3`, optionally `-rc.1`; not part of a longer dotted number such as an address; no `v` in front) replaced by another, the same pair in every file, up to a release (not to a pre-release). In the `version_files` such a line must set the version: a key `version` (any case), `__version__` or a name ending in `_VERSION`, then `:` or `=` and the version alone (`"version": "1.2.3",`, `version: 1.2.3`, `export const ENGINE_VERSION = '1.2.3';`); in a `package.json` only its `"version"` line, and the file is also read at the head: with the change taken back, it must differ only in its top-level `"version"` (a dependency named `version` does not count). So a dependency, a URL or a minimum version that moves by the same pair does not count. In other version files only the line is checked: a nested key that sets a version (`version = "1.2.3"` in a TOML dependency table) still counts, so list only files whose version lines are the package's own. In the `version_text_files` any line may carry the version. At least one line that sets the version must move. `from` and `to` are that pair; `level` is `major`, `minor` or `patch`. A file without a patch (binary, too large), a new, removed or renamed file other than a changelog, a removed changelog line, or any other change gives false, `""`, `""`, `none`. It says nothing about who made the change: pair it with `github_pr` (author, signatures, pushes). |
| `github_bump` | `applies`, `only_manifests`, `version_only`, `dev_only`, `registry_changed` (booleans); `semver` (text); `manifest_lines`, `release_age_days` (numbers) | Whether the pull request only bumps npm dependency versions, as a Dependabot pull request does. `applies` is true when every changed file is a `package.json`, `pnpm-lock.yaml`, `package-lock.json` (in any folder) or `.npmrc`, every one but `.npmrc` edited in place (not new, removed or renamed), and at least one `package.json` changes the spec of a dependency (in `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies`). Any other pull request (another ecosystem such as GitHub Actions, Docker or pip, code, docs, a lockfile alone, `yarn.lock`, `pnpm-workspace.yaml`) gives `applies` false, and then every other field has its strictest value: false, `none`, `registry_changed` true, 0. Each changed `package.json` is read whole at the head commit; its earlier text is that text with the pull request's patch taken back, so both sides are the pull request's own. `only_manifests`: no `.npmrc` changed. `version_only`: `only_manifests`, and the `package.json` files change nothing but the specs of dependencies they already had, each an exact version or one after `^` or `~` (`1.2.3`, `^1.2.3`, `~1.2.3`). `semver`: the largest step, `major`, `minor` or `patch`, over the bumped dependencies and over every package version a lockfile changes (transitive ones too); `none` when a spec is anything else (a range such as `>=1.2.3`, a pre-release, a tag, a URL), changes its operator (`^` to `~`) or goes down. As the caret does, leading zeros move the step up: from `0.y.z` a minor step counts as `major` and a patch step as `minor`, from `0.0.z` every step is `major`; so only versions from `1.0.0` on give `patch`. Lockfiles are read through their patch only: each removed version is paired with the added version of the same package at the same place (in a `pnpm-lock.yaml` a package key, by name, in `packages` and in `snapshots`; the version of an importer's dependency; the version of a package's dependency; in a `package-lock.json` an entry, by its `node_modules/...` path, or by name for a package that only moved to another path). A lockfile also gives `none` for a package added with no version removed (a new transitive dependency), one removed with no version added, more than one version of one package on a side (they cannot be paired without doubt; a change of peers only, the same version on both sides, is no step), a downgrade, a pre-release or another version that is not `x.y.z`, a version line whose place the patch does not show (no section in the hunk header, no key above it), a changed `lockfileVersion` or another section (`overrides`, `settings`), a changed `version:` field inside a `pnpm-lock.yaml` package block (a tarball or repository package), and in a `package-lock.json` the root's or a workspace's own version or any version outside the `packages` object (so a lockfile v1 or v2, with its legacy `dependencies` copy, gives `none`; its `"resolved"` lines there already give `registry_changed` true). A dependency line of a package added or removed is no step by itself (the package keys say what is installed). Other changed lines (`resolution`, `engines`, `peerDependencies` ranges) give no step. `dev_only`: every bumped dependency is changed in `devDependencies`; no `package.json` of the repository (each changed one before and after, every other one at the head) has a bumped package or a package a lockfile changes in another section (`dependencies`, `optionalDependencies`, `peerDependencies`) or bundles it (`bundleDependencies`, or a bundle list that is not a list of names); and no lockfile shows a changed package outside development: in a `package-lock.json`, every changed `node_modules/...` entry that is still there must show `"dev": true` in the patch (`devOptional` is not dev; a mark the patch does not show counts as missing); in a `pnpm-lock.yaml` v6 (keys with a leading `/`), every changed package must show `dev: true`, and in any `pnpm-lock.yaml` a changed line whose package key the patch does not show counts as not dev; a changed version of an importer's dependency in a section other than `devDependencies` is not dev (one whose section the patch does not show is left to the `package.json` check, since an importer is a `package.json`); a line not understood (another section, no section) counts as not dev. The other `package.json` files are found in the repository's tree at the head (GitHub's recursive tree) and read only when everything else says dev only; a tree GitHub cuts short, more than 50 `package.json` files, or one larger than 512 KB makes the whole fact missing, and one that is not a JSON object gives false. The limit: a `pnpm-lock.yaml` v9 has no dev marks, so for a package that changes only in such a lockfile, `dev_only` checks that no `package.json` lists it, or a package whose dependency line on it changes, outside `devDependencies`; it does not check whether a runtime dependency reaches it through more packages than that. `registry_changed`: a changed `.npmrc`; a changed lockfile line with a URL other than `https://registry.npmjs.org/`, a backslash (an escape such as `\u0065` can spell a field or URL), a source key (`tarball`, `repo`, `commit`, `directory`, `registry`) or a protocol (`git+`, `git:`, `github:`, `file:`, `link:`, `npm:`, `workspace:` and the like); in a `pnpm-lock.yaml`, a changed `version:` that is not a pinned version (peers in parentheses aside), such as an alias `other@1.0.0`, or a changed package key that is not `name@version` (lockfile v9, or v6 with a leading `/`; a v5 key `/name/1.0.0`, a new importer); in a `package-lock.json`, a changed `"resolved"` that is not the registry's tarball of the entry's own package (or whose entry the patch does not show), or a changed `"link"`; or a changed spec that names a source instead of a version. `manifest_lines`: lines added plus lines removed in the `package.json` files (not the lockfiles). `release_age_days`: whole days since the youngest of the bumped versions was published (the versions in the new specs, and every version a lockfile adds, transitive ones too), from the npm registry (`https://registry.npmjs.org/<package>`, its `time` object; read without the GitHub token); 0 when no spec is understood. A `package.json` or lockfile without a patch (too large), a patch that does not fit the file, more than 30 such versions, or a registry that does not answer with the publish time makes the whole fact missing. It says nothing about who made the change: pair it with `github_pr` (`author_dependabot`, `all_commits_verified`, `pushed_by_author`). |

Fact settings:

| Field | For | Meaning |
|---|---|---|
| `paths` | `github_paths` | The files that count: 1 to 100 globs from the top of the repository. `*` is any characters except `/`, `**` is any number of folders (also none), `?` is one character. `*.md` matches `README.md` but not `docs/a.md`; use `**/*.md` for every folder. |
| `except` | `github_paths` | Files that never count, even when they match `paths`: the except list wins. |
| `version_files` | `github_release` | Required: the files where a line that sets the version may change (1 to 50 globs, as for `paths`), for example `package.json`, `packages/*/package.json`, `src/version.ts`. |
| `version_text_files` | `github_release` | Files where any line may carry the version, for docs that name it (up to 20 globs). Never files that run: there a changed URL or dependency with the same version would count. |
| `changelogs` | `github_release` | The changelog files (1 to 20 globs, as for `paths`), which may only get lines added. Default `CHANGELOG.md`. Name the exact files. |
| `property` | `github_property` | The name of the custom property. |
| `app` | `github_app_approval` | Required: the GitHub App's slug, as in its URL `github.com/apps/<slug>` (lower case). Its bot account is `<slug>[bot]`. |
| `bot_id` | `github_app_approval` | The account id of the app's bot, checked too. Set it: then an app that took over the slug of a deleted app does not count. Find it with `gh api '/users/<slug>[bot]' --jq .id`. |

**Safety.** A rule with a missing fact never matches. But a missing fact
can also stop an earlier rule that blocks something, so that a later rule
that allows it matches instead. So check for missing facts first, and in
rules that allow something (approve, skip a review), write every condition
as a known, positive value (`facts.risky.any == false`), instead of
counting on an earlier rule:

```yaml
rules:
  - when: "facts.pr.missing == true or facts.docs.missing == true or facts.ci.missing == true"
    action: retry
  - when: "facts.docs.all == true and facts.ci.green == true and facts.pr.all_commits_verified == true"
    action: light
```

The example profile [`pr-docs-check`](../examples/profiles/pr-docs-check.yaml)
follows these rules.

#### One snapshot

All GitHub facts of a decision come from one read of the pull request.
First the pull request and its commits (both checked against `head`), then
only the parts the facts need (files, membership, checks, properties), each
once, at the same time. The facts share 5 seconds. Globs are matched
without regular expressions, so a long pattern cannot slow a decision down.

- `github_bump` then reads the npm registry, with its own 8 seconds, and
  may take 10 seconds in all. A registry document is read as a stream and
  only its `time` object is kept, up to 64 MB; each changed `package.json`
  up to 512 KB. When the rest says `dev_only`, it also reads the
  repository's tree at the head and each other `package.json` in it (at
  most 50, up to 512 KB each): at most 51 more GitHub requests, within the
  same 5 seconds.

- Files are read 100 per page, all pages at once. A pull request with more
  than 1,000 changed files makes `github_paths` facts missing (`error`);
  `github_pr` still knows the number of files.
- Commits: up to 250 (GitHub lists no more).
- Pushes to the head branch (for `pushed_by_author`): the branch's activity
  list, 100 entries per page, newest first, page by page until the push that
  created the branch, at most 5 pages (500 entries). The list also holds
  other changes to the branch, such as merges, so 500 entries can be fewer
  than 500 pushes.
  - When the creation push is found, older pushes belong to an earlier
    branch with the same name and are left out.
  - When it is not found within 5 pages, older pushes stay unknown.
  - Pushes on a later page that GitHub does not show stay unknown too.
- Check runs: up to 300 on the head commit. Commit statuses and workflow
  runs: up to 100.
- A workflow that a ruleset requires counts only through a run that GitHub
  started for the ruleset, not through a workflow at the same path in the
  repository (a pull request can change that one).
- The file list is the pull request's current one, so the pull request is
  read once more after it: a push in between makes the facts `stale`.
- A check run and a commit status with the same name that disagree: the
  stricter result counts.
- Reviews and conversation comments: 100 per page, page by page, fewer
  than 500 each; 500 or more make the facts that need them missing
  (`error`). After them the pull request is read once more, as after the
  file list: a push in between makes those facts `stale`. Review requests
  and review threads come from GitHub's GraphQL API, in one query (checked
  against `head`): at most 100 requests (more: `error`) and 100 threads
  (more: the thread count has no value).
- The head commit's status history (every status, not only the latest):
  fewer than 300.
- `CODEOWNERS`: at most 128 KiB, and each pattern at most 1,024
  characters. Matching all changed files against its patterns is limited
  to 50 million steps; a file of 1,000 folder patterns such as `build/`
  against 2,000 file names stays far within it. Past any of these limits
  `github_pr` is missing (`error`), never a guessed owner. GitHub itself
  ignores a `CODEOWNERS` file over 3 MB.

#### Missing GitHub facts

| Reason | When |
|---|---|
| `no_pr` | No pull request at `at`: `repo` must be `owner/name`, `number` a whole number from 1, `head` a full 40-character commit id. Nothing is sent to GitHub. |
| `stale` | GitHub's head commit is not `head`: every GitHub fact of the decision is `stale`. A push that comes in while the changed files are read makes the facts that use them `stale` (`github_paths`, and `github_pr`, which reads them for `author_sole_code_owner`); so does a push while the reviews or review threads are read (`github_copilot`, `github_app_approval`); `github_checks` is read by the commit id, so a later push does not change it. |
| `unavailable` | No GitHub provider (`FACTS_GITHUB` is off), or the token cannot see the repository (GitHub answers 404 or 403, or the app is not installed there). |
| `timeout` | GitHub took longer than 5 seconds. |
| `error` | Anything else: a GitHub error (5xx), a rate limit, a redirect (not followed: it would carry the token elsewhere), an answer of the wrong shape, too many files or checks. |

#### Settings

`FACTS_GITHUB` in the wrangler config:

| `FACTS_GITHUB` | GitHub facts |
|---|---|
| `off` (default) | none: every GitHub fact is missing (`unavailable`) |
| `mock` | fixed answers for development and tests: an open pull request by a member who pushed every commit and is not the only code owner, one changed file (10 lines) that matches every path list, signed commits, one required check that passed; every property is `unset`; one changed workflow file with no findings; no Copilot review |
| `token` | read with the Worker secret `FACTS_GITHUB_TOKEN` |
| `app` | read as a GitHub App: `FACTS_GITHUB_APP_ID` and the Worker secret `FACTS_GITHUB_APP_PRIVATE_KEY` (the PEM file GitHub gives you) |

- `FACTS_MODE` and `FACTS_GITHUB` are separate: `FACTS_MODE: mock` does not
  answer GitHub facts, and `FACTS_GITHUB: mock` does not answer spatial ones.
- With `app`, Pointsman finds the app's installation for the repository and
  makes an installation token. The token is kept until 5 minutes before it
  expires (after one hour). Making the token is the only request that is
  not a read (GraphQL queries are sent as POST, but they only read). The token is down-scoped: it gets only the permissions the
  facts use, as read only. Still give the app read permissions only, and
  use another app for anything that writes ([github-connector.md](github-connector.md#the-two-github-apps)).
  An app can read the checks of private repositories; a fine-grained token
  cannot.
- `FACTS_GITHUB_IGNORE_CHECK`: the name of the check run that your own
  Pointsman client adds to pull requests. It never counts as a required
  check, so Pointsman never waits for itself. It is a deployment setting,
  not a profile field, so a profile cannot drop a real check.
- The token and the key are never logged. A fact's `source` names only the
  pull request: `GitHub octo-org/demo#7 at 1a2b3c4`.

Permissions (all read) for a fine-grained token or an app:

| Permission | For |
|---|---|
| Pull requests | `github_pr`, `github_paths`, `github_workflows`, `github_release`, `github_bump`, `github_copilot` (reviews, review requests, review threads, conversation comments), `github_app_approval` (reviews) |
| Contents | the commits of the pull request, pushes to its branch, `CODEOWNERS`, the files `github_workflows` reads, the `package.json` files `github_bump` and `github_release` read, the files `rebase_only` reads at the base when a rebase moved them |
| Metadata | always (every app has it) |
| Checks (apps only), Commit statuses | `github_checks`; commit statuses also for facts of other modules that read the snapshot |
| Actions | `github_checks`, when a ruleset requires workflows |
| Custom properties | `github_property` |
| Organization: Members | `author_member` for members who hide their membership; the members of a team in `CODEOWNERS` |

Fine-grained tokens have no Checks permission: only apps have it. Leave it
out for a token.

The required checks come from the branch's rules and its protection, as
GitHub shows them to anyone who can read the repository: no administration
permission is needed.

### CodeRabbit reviews

The module `@pointsman/coderabbit` reads what [CodeRabbit](https://coderabbit.ai)
did on a pull request, from GitHub, through the same snapshot as the
GitHub facts:

```yaml
facts:
  - { name: coderabbit, type: coderabbit, at: $.pull_request, not_reviewed: ["**/pnpm-lock.yaml", "**/dist/**"] }
```

| Field | Meaning |
|---|---|
| `installed` | CodeRabbit runs in the repository: it left a review, comment or status on this pull request, or a status on the head of one of the 5 newest other pull requests. No value when it cannot tell (no other pull requests). |
| `ignored` | The description has `@coderabbitai ignore`, outside CodeRabbit's own summary block there (a whole block, from its start to its end marker; a start marker alone hides nothing). |
| `reviewed_any`, `reviewed_head` | CodeRabbit reviewed a commit of the pull request; the head commit (a review on it, or a CodeRabbit status on it that says it was reviewed: "Review completed", "Review approved", or the approve command's). |
| `in_progress` | CodeRabbit's latest status on the head is "Review in progress". |
| `approved_head`, `changes_requested` | CodeRabbit's latest review that decides (approve, request changes, or a dismissed one) approves the head commit; requests changes. |
| `rebase_only` | The head has exactly the change of the commit CodeRabbit approved: compared with the base commit of the pull request, every file's patch is the same, line for line with its context lines and the hunks' line numbers. Only in a file that the base branch changed between the two (a rebase moved its lines) may the line numbers differ, and then the lines each hunk had before it must occur once in that file at the new base, so the place is clear. So the same edit at another place is a new change, also next to an identical block, and a rebase that changed lines next to the edit asks for a review again. False when there is no approval or it is on the head. No value when the change cannot be compared (a file without a patch, such as a binary file, no files listed, 300 files or more, more than 10 files the base moved, or a hunk whose lines occur more than once at the new base). |
| `unresolved_threads` | Open review threads that CodeRabbit started. No value for more than 100 threads. |
| `outside_diff_findings` | CodeRabbit's latest review with text has findings outside the diff (they are not threads). An approval without text does not take them back. |
| `billable_files`, `price_stated` | The files a review would bill: CodeRabbit's own count for this head when it stated one (`price_stated` true), else the changed files minus `not_reviewed` (a renamed file counts once). A count is for this head only when CodeRabbit's comment names the head as the end of the range it is about ("between <commit> and <head>"): it edits its summary in place, so the time of an edit does not tell. |

Only CodeRabbit's own account counts: reviews and statuses of its bot
(login `coderabbitai[bot]` and its account id), comments of its bot made
through its GitHub App. Anyone else who writes the same text, or an account
with the same login, does not count. People with write access can edit a
bot's comment: when anyone but CodeRabbit last edited one of its comments
or reviews, the whole fact is missing (`error`), and so it is when the
editors cannot be read (more than 100 comments or reviews), or when the
editors are read with other text than the comment or review itself (an
edit between the two reads).

The fact is missing (`error`, `stale`, `unavailable`, `timeout`) as the
GitHub facts are, and also when the reviews, comments, the head's statuses,
the review threads, the other pull requests or a comparison cannot be read.

Three more types also read this client's earlier decisions of the same
profile, from the last 24 hours (the spend: `pr_hours` or `window_hours`, whichever is longer) ([modules.md](modules.md#facts-from-the-decision-log)).
They write the pull request (`pull_request`, as `owner/repo#n`) and its
author (`author`) into their values, as text for people (rules cannot use
it), so later decisions can find them. More than 999 decisions in that time,
a log that cannot be read, or a test token (`no_log`) make them missing.

```yaml
facts:
  - { name: budget, type: coderabbit_budget, at: $.pull_request }
  - { name: queue, type: coderabbit_queue, at: $.pull_request, waiting: [wait, queue] }
  - { name: spend, type: coderabbit_spend, at: $.pull_request, pay_actions: [pay], usd_per_file: 0.25, not_reviewed: ["**/pnpm-lock.yaml"] }
```

**`coderabbit_budget`**: the CodeRabbit review budget of the pull request's
author. CodeRabbit's limits are per developer and follow the person who
opened the pull request, so only answers about the author count:
CodeRabbit's limit notices on this pull request, its replies when every
command in the 10 minutes before the reply was the author's, and the
author's readings on other pull requests in this client's decisions. A
reply that may answer anyone else's command, an app's included, is about
their budget and never counts.

| Field | Meaning |
|---|---|
| `known` | There is a reading, its wait is not over, and free reviews in it were stated at most an hour ago. |
| `available` | Free reviews stated; 0 when it states none, only a wait, or nothing is known. |
| `wait_stated`, `wait_minutes` | CodeRabbit stated a wait; the minutes left (no value when not stated). |
| `allowance_per_hour` | The reviews per hour CodeRabbit last stated (no value when never). |
| `observed_minutes_ago` | Minutes since the reading (no value when there is none). |
| `asked_minutes_ago` | Minutes since the author last asked `@coderabbitai rate limit` here (no value when never). |
| `taken_by_other_pr` | After the reading, a pull request of the author (another one, or this one at an earlier head) got a decision with one of `review_actions` (default `review`) from this profile: that free review may be gone. |

**`coderabbit_queue`**: the author's other pull requests that wait for a
free review ahead of this one. A pull request waits when its latest
decision of this profile has one of the actions in `waiting` (required),
made within `max_age_minutes` (default 120). Those that started waiting
earlier are ahead. `ahead` is their number; `wait_minutes` is CodeRabbit's
wait plus one slot (60 ÷ reviews per hour) per pull request ahead, 0 when
there are more free reviews than pull requests ahead, no value when it
cannot be computed (budget not known, no allowance stated). Free reviews
taken since the reading (decisions with one of `review_actions`, as for
the budget) are not free any more.

**`coderabbit_spend`**: what paid reviews cost.

| Field | Meaning |
|---|---|
| `price_usd` | This review's price: CodeRabbit's stated price for this head, else the billable files (as for `coderabbit`) times `usd_per_file`. |
| `per_pr_usd_after` | Payments for this pull request in the last `pr_hours` (default 48, at most 168) plus this review. |
| `per_window_usd_after` | Earlier payments of every pull request in the last `window_hours` (default 5, at most 24) plus this review. |
| `paid_for_head` | A paid review command (`@coderabbitai review --use-credits`) for this head: written after the head was pushed, by the author, an organization owner or member, or an app in `payer_apps` (by id), and CodeRabbit started or finished a review of the head within 10 minutes after it. An edited comment counts from its last edit, and only when its author made that edit. |

Payments come from this client's decisions of the profile with an action
in `pay_actions`, at the `price_usd` their spend fact recorded, once per
head (at its highest price). An earlier decision for this head is the same
review, so it is not added twice: this head counts once, at the higher of
its earlier price and now. A pay decision is a reservation: the
engine does not know whether it was carried out, so it counts. For the
pull request it stops counting after 24 hours, unless a paid review command
was written after it. This counts too much, never too little.

Settings: `FACTS_CODERABBIT` `on` reads GitHub with the GitHub module's
settings (`FACTS_GITHUB` `token` or `app`, so choose `@pointsman/github`
too), `mock` gives fixed answers (CodeRabbit runs and has not reviewed;
one billable file), `off` (default) makes the facts missing. Permissions
as for the GitHub facts: pull requests, contents (to compare commits),
commit statuses.

### GitHub workflows

A `github_workflows` fact reads the GitHub Actions files a pull request
changes, so a profile can decide whether the change is safe to merge: pass,
fix, or a person checks. It is a GitHub fact like the others: same snapshot,
same `head` check, same [missing reasons](#missing-github-facts). The client
sends only the pull request; Pointsman reads the files itself.

```yaml
facts:
  - name: wf
    type: github_workflows
    at: $.pull_request
    pin_exempt: ["example-org/*"]
```

The example profile [`workflow-check`](../examples/profiles/workflow-check.yaml)
uses it.

**What it reads.** The changed files in this scope, at the head commit and
at the base tip (`base.sha` of the pull request):

- workflows: `.github/workflows/*.yml` and `*.yaml` (not in subfolders:
  GitHub does not run those);
- local actions: every file in a folder with an `action.yml` or
  `action.yaml`, at head or at the base (also `index.js`, a `Dockerfile` or
  scripts next to it). The folders come from the commit's file tree;
- scanner settings of zizmor and pinact: `zizmor.yml`, `.github/zizmor.yml`,
  `.pinact.yml`, `.github/pinact.yml`, `.github/.pinact.yml`, each also as
  `.yaml`.

Workflows and `action.yml` files are parsed; the other files only count.
Nothing is run, and `${{ }}` expressions are read with a small tokenizer,
not evaluated. A file renamed out of the scope counts as removed.

**Fields.** Rule fields are single values, so the fact counts over all files.
Every field is a number, except `detail`.

| Field | Counts |
|---|---|
| `changed`, `removed` | changed (added, changed, renamed) and removed files in the scope |
| `unparsed` | files that could not be parsed, are over a limit, or have an unexpected shape ([below](#parser-limits)) |
| `bytes` | the size of the changed files at head |
| `privileged` | changed workflows with a trigger that runs in the base repository's context, with its secrets and a write token (`privileged_triggers`) |
| `privileged_new` | privileged triggers that the version at the base does not have (a new file: all of them) |
| `head_checkout` | privileged jobs that may check out code other than the base. An allow-list: a checkout is the base only when `repository` is empty, the repository itself or `${{ github.repository }}`, and `ref` is empty, a literal branch or tag (not `refs/pull/…`, not a commit id), or exactly one expression on `base_refs`. A ref from `steps.*.outputs`, `env` or `needs` counts. So does a script that may fetch code: a `run:` with the word `git` and `checkout`, `switch`, `fetch`, `pull`, `clone` or similar (also across line continuations), `gh` with `checkout`, `clone` or `download`, `curl` or `wget` of an archive; a `github-script` that runs a program. This part is best effort: a script can fetch code in ways no word list sees, so send every `privileged` change to a person. |
| `pwn_request` | of those, jobs with any step that may run repository content: a `run:`, a local action, or an action not on `inert_actions`. Anywhere in the job, also before the checkout: an action that ran before it still runs its `post:` step later, in the checked-out code. |
| `artifact_in_privileged` | privileged jobs that download an artifact: `actions/download-artifact` (also of the same run: another job may have made it from checked-out code), `dawidd6/action-download-artifact`, `gh run download` or the word `artifacts` in a `run:`, the artifacts API in a `github-script` `script:` |
| `remote_reusable` | privileged jobs that call a reusable workflow of another repository, and every job with `secrets: inherit` |
| `secrets_new` | secrets a job reads at head but not at the base, in any workflow (also in `if:` and the workflow's `env:`; `toJSON(secrets)` counts as a new one) |
| `injection` | untrusted expressions in a `run:` or a `github-script` `script:`: every reference to `github` or below it that is not on `safe_contexts`, and every reference to `env`, `steps`, `needs` or `inputs` (values passed on, which may come from `github.event`). Also bare `github`, `*`, an index (`github['event']` is `github.event`), references inside functions (`toJSON(github.event)`), and expressions that cannot be read. Pass a value through `env:` and quote the variable instead. Values that reach a script through files are not counted. |
| `permissions_missing` | jobs with no `permissions:` at job or workflow level (the repository's default applies, which the file does not show) |
| `write_all` | `write-all` in a job, and workflows with any write scope at workflow level |
| `write_new` | write scopes a job has at head but not at the base (a job block replaces the workflow block) |
| `persisted` | `actions/checkout` without `persist-credentials: false`, in jobs with no git step (a `run:` with `git push`, `commit`, `tag`, `fetch` or `pull`, or `gh`; or an action on `git_actions`). An expression counts as on. |
| `unpinned` | `uses:` not pinned to a 40-character commit id (actions on `pin_exempt` need not be), and images without a `@sha256:` digest (`docker://…`, `container:`, `services:`, a Docker action's `image`). Local `./` actions are not counted. |
| `suppressions_new` | `zizmor: ignore` lines at head that are not at the base (a moved one counts), and changed or removed scanner settings |
| `local_unresolved` | changed local actions (once per folder: only `action.yml` is parsed, not the code), changed reusable workflows (`workflow_call`: their callers are not read), and privileged jobs that call a local reusable workflow (it is not read) |
| `detail` | text: the first 20 findings with file and line, for people and the log. Rules cannot read it, like `route` of `detour`. |

Workflow files, action files and job ids are compared by name: a file at
the base is the same name, or the earlier name of a renamed file. A version
at the base that cannot be parsed counts as none, so everything in it is new.

**Settings.** Each is a list that is added to the defaults; a profile
cannot remove a default.

| Field | Default | Entries |
|---|---|---|
| `privileged_triggers` | `pull_request_target`, `workflow_run`, `issue_comment`, `issues`, `discussion`, `discussion_comment`, `fork`, `watch`, `gollum` | trigger names |
| `inert_actions` | `actions/checkout`, `actions/upload-artifact` | actions known not to run workspace content: `owner/repo`, or `owner/*` for every repository of that owner (exactly that owner: `example-org/*` does not cover `example-org-x/…`) |
| `safe_contexts` | `github.sha`, `github.run_id`, `github.run_number`, `github.run_attempt`, `github.job`, `github.event_name`, `github.repository`, `github.repository_id`, `github.repository_owner`, `github.repository_owner_id`, `github.server_url`, `github.api_url`, `github.workspace`, `github.event.number`, `github.event.pull_request.number`, `github.event.issue.number`, `github.event.pull_request.head.sha`, `github.event.pull_request.base.sha`, `github.event.workflow_run.id`, `github.event.workflow_run.head_sha` | exact `github.*` paths in lower case that are safe in a script: numbers, ids, commit ids |
| `base_refs` | `github.sha`, `github.ref` | expressions that name the base in a checkout's `ref` (for the default triggers, both are the base branch or the default branch) |
| `git_actions` | none | actions that need the checkout's git credentials |
| `pin_exempt` | none | actions that need not be pinned to a commit, for example your organization's own actions at a major tag |

#### Parser limits

The files are written by the pull request's author. Each of these makes a
file `unparsed`, so a profile can send it to a person; it is never skipped,
and an unparsed file counts nothing else:

- YAML 1.2 core schema: no directives (`%YAML`), no custom tags, no merge
  keys (`<<`, which GitHub does not accept), no duplicate keys, keys must be
  text, one document per file.
- At most 100 aliases and 50,000 values per file once aliases are expanded.
- At most 50 parsed files per pull request (the rest are `unparsed`, and not
  read), and 256 KB per file; a file that is not UTF-8 text.
- An unexpected shape at a key that matters: `on`, `jobs`, `steps`,
  `permissions`, `uses`, `with`, `run`, `secrets`, `container`, `services`,
  `runs`. For example `steps` that is not a list, a step with both `uses`
  and `run`, an expression in `uses`, a `${{` that is not closed, or a key
  GitHub reads in lower case written another way (`Run:`).
- Inputs under `with:` are read without case, as actions read them
  (`Persist-Credentials` is `persist-credentials`).

More than 1,000 changed files makes the fact missing (`error`), as for
`github_paths`. So does a repository tree that GitHub cuts short (very large
repositories).

**Not covered yet.** Whether a pinned commit belongs to the action's
repository and not only to a fork of it (an impostor commit) is not checked.
Local reusable workflows and the code of local actions are not read: they
go to a person (`local_unresolved`). Scripts a workflow calls outside an
action folder (`run: ./scripts/deploy.sh`) are not in the scope: a change to
only such a script gives no finding. Two file trees are read per pull
request, so a repository near GitHub's tree limit (100,000 entries) needs
more memory; a tree GitHub cuts short makes the fact missing.

**Safety rules for profiles.** As for every GitHub fact: a missing fact
gives "not decided yet" (`retry`), never a pass; the pass rule names every
condition as a known value; AI answers only make the result stricter (they
can send a change to a person, never pass it), because the files and the
pull request text are written by its author.

