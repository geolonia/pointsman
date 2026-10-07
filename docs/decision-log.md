# Decision log

Every decision is stored in D1 (binding `DB`, schema in
[`migrations/`](../migrations/)) **before** it is returned. If the log cannot
be written, the client gets a 500 and no decision, so no action is taken on an
unlogged decision.

## What is stored

| Column | Meaning |
|---|---|
| `id` | `decision_id` returned to the client |
| `created_at` | UTC time |
| `client` | Client name of the API token (never the token) |
| `ref` | The client's reference, for example an issue id |
| `profile_id`, `profile_version` | The exact profile version used |
| `model` | The model that answered |
| `action`, `rule` | The action, and the index of the policy rule that matched (`NULL` = default) |
| `answers` | All answers with probabilities (JSON) |
| `facts` | Only for profiles with facts: each fact as looked up, or why it is missing (JSON, see [profile-format.md](profile-format.md#facts)) |
| `state_hash` | SHA-256 of the state sent to the model, with object keys sorted |
| `state` | The state itself, **only** when the profile sets `log.store_state: true` |
| `callback_url` | For the review queue (#9); not returned by the API |

By default only the hash of the state is kept: the state can hold personal or
confidential data (issue text, sensor data). The hash still shows when the
same input was decided twice. Turn on `log.store_state` for a profile when you
need the inputs, for example to build a training set later.

## Feedback

`POST /v1/decisions/{id}/feedback` stores a correction:

```json
{ "correct": { "team": "frontend" }, "by": "reviewer@example.com", "note": "optional" }
```

Corrections are checked against the profile version of the decision: the
question must exist, and the value must fit its type (`true`/`false`, a listed
option, or a level). A decision can get feedback more than once; all of it is
kept. `GET /v1/decisions/{id}` returns the decision with its feedback.

A token sees and corrects only decisions of profiles in its scope. Other
decisions answer 404, as if they did not exist.

## Accuracy per profile version

With feedback, accuracy can be measured per profile version.
[`accuracy.sql`](accuracy.sql) lists, per profile version, the number of
decisions, how many got feedback, and how many were overridden (a feedback
that changes at least one answer):

```sh
wrangler d1 execute DB --remote --file docs/accuracy.sql
```

The override rate is `overridden / with_feedback`; the feedback rate is
`with_feedback / decisions`. Group by `action` as well to see whether `auto`
decisions are wrong more often than the policy threshold suggests.

Notes:

- Only decisions that someone looked at get feedback. A low feedback rate
  means the override rate describes a sample, not all decisions.
- `noul` corrections are `true`/`false`; SQLite's JSON functions return them
  as 1/0, and the comparison above handles that the same way for answers.

## Local development

```sh
pnpm db:migrate:local   # apply migrations/ to the local D1
pnpm dev
```
