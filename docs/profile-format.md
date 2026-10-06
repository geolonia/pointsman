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
| `policy` | yes | `rules` (checked in order, first match wins) and a `default` action. |

Actions are `auto`, `review`, or a custom name such as `cancel`. The syntax of
`when` conditions is defined in the policy issue (#4); for now it is only
checked to be a non-empty string.

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
100 characters. Answers come back under the same names.

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
`stuck.yes >= 0.9`. Answers that do not fit the profile (missing question,
unknown option, probability outside 0–1) are rejected with a `model_error`.
