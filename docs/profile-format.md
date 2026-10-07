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
| `model` | yes | Model id, for example `clef-flash`. |
| `fallback_models` | no | Models to try, in order, when the primary model fails. |
| `input` | no | List of `{ name, path }`. Builds the state from a raw client payload with a simple JSONPath (`$.issue.title`). Without it, the request state is sent as is. |
| `questions` | yes | 1 to 64 questions (see below). |
| `facts` | no | Up to 16 spatial facts to look up for each decision, for rules (see [Facts](#facts)). |
| `policy` | yes | `rules` (checked in order, first match wins) and a `default` action. |
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

- Comparisons: `==`, `!=`, `>=`, `>`, `<=`, `<`. Only numbers can be ordered.
- Combine with `and`, `or`, `not` and parentheses. `and` binds tighter than `or`.
- Values: numbers (`0.85`), strings in single or double quotes (`'maps'`),
  `true`, `false`.

Conditions are checked when the profile is validated: a question name that
does not exist, a field the question type does not have, an option that the
question does not list, or a comparison of different types fails validation.
The engine evaluates conditions with its own parser; nothing is run as code.

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

| Type | Fields | Notes |
|---|---|---|
| `inside` | `inside` (boolean), `rank` (number), `class` (text) | Inside an area of the layer. `rank` and `class` describe the area, for example a flood depth class. Not inside: `rank` 0, `class` empty. |
| `nearest` | `found` (boolean), `distance_m` (number), `name` (text) | The nearest feature of the layer. None found: `found` false, no distance or name. |
| `detour` | `possible` (boolean), `extra_m` (number) | Extra metres around a closed section, by car or on foot (`mode`). Needs a `LineString`. No way around: `possible` false, no `extra_m`. |

Every fact also has `missing` (boolean).

**A missing fact is never guessed.** A lookup can fail: no location in the
state (`no_location`), no fact provider (`unavailable`), too slow
(`timeout`, 3 s per fact) or an error (`error`). A comparison with a missing
fact, or with a field that has no value, is *unknown*, and a rule matches
only when its condition is true:

- `false and unknown` is false, `true or unknown` is true, `not unknown` is
  unknown;
- `facts.<name>.missing == true` is always known: use it to send decisions
  with missing facts to a person.

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
OpenStreetMap data, `source`: © OpenStreetMap contributors).

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
- A server that starts cold (for example on AWS Lambda) can take longer than
  the 3 s limit for the first lookups: those facts are `timeout`.

Geocoding is still open (issue #65).

