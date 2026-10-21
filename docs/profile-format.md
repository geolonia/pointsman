# Decision profile format

A decision profile is a named, versioned set of typed questions plus a policy.
The engine sends the questions and a state to a decision model, then the policy
turns the answers into an action.

- Schema: [`schema/profile-v1.schema.json`](../schema/profile-v1.schema.json) (JSON Schema 2020-12)
- Examples: [`examples/profiles/`](../examples/profiles/)
- Validate: `node scripts/validate-profiles.mjs <file-or-directory>...`

Profiles are YAML (or JSON). The file name must be `<id>.yaml`.

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
| `type` | `inside`, `nearest` or `detour` (below). |
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
(`timeout`, 3 s per fact, 8 s for `detour`) or an error (`error`). A comparison with a missing
fact, or with a field that has no value, is *unknown*, and a rule matches
only when its condition is true:

- `false and unknown` is false, `true or unknown` is true, `not unknown` is
  unknown;
- `facts.<name>.missing == true` is always known: use it to send decisions
  with missing facts to a person.
- `facts.<name>.reason` tells a failed lookup from one that does not apply:
  `facts.walk.missing == true and facts.walk.reason != 'no_location'` sends
  only a real failure to a person, not a report that marks a point. A
  `reason` that is not one of the four is refused when the profile is
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

`FACTS_MODE` in the wrangler config:

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

