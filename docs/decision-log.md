# Decision log

Every decision is stored in D1 (binding `DB`, schema in
[`migrations/`](../migrations/)) **before** it is returned. If the log cannot
be written, the client gets a 500 and no decision, so no action is taken on an
unlogged decision.

The one exception is a **test token** ([README](../README.md#api-tokens)):
its decisions are made the same way but not stored, and marked
`"test": true`. They are for checking profiles and examples; nobody acts on
them, and they never reach the review queue or the accuracy numbers.

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
| `review_status` | `pending`, `resolved` or `superseded` for a decision whose action a person checks (see [reviews.md](reviews.md)) |
| `requires` | Only for profiles with `requires`: for each required decision its id, profile and version, `action`, `outcome`, `reviewed`, and every value the rules read from it (`read`, JSON, see [profile-format.md](profile-format.md#decision-chains)) |
| `idempotency_key`, `request_digest` | When the request had an `Idempotency-Key`: the key, and a SHA-256 of the request (profile, the version as requested, state, ref, decisions, callback_url). The digest is not returned by the API |
| `replaces` | The earlier decision of the same profile, `ref` and client that this one replaced |
| `discarded_at` | A decision made while a person resolved the one it would replace: the client got `409 resolved_by_person`, and it never counts (not in the stats, not usable in a chain, cannot be resolved) |

By default only the hash of the state is kept: the state can hold personal or
confidential data (issue text, sensor data). The hash still shows when the
same input was decided twice. Turn on `log.store_state` for a profile when you
need the inputs, for example to build a training set later.

Facts are stored as looked up, also without `log.store_state`. They are
derived values (a flood class, the nearest site and its distance, extra
metres); the nearest site and its distance already tell roughly where the
place is. A `detour` fact with `route: true` goes further: it keeps the way
around, which starts and ends at the place in the state. Set it only where
that place may be kept.

The `requires` snapshot shows what a decision was based on, even when a
required decision gets a review answer later. `GET /v1/decisions/{id}` shows a
required decision of a profile outside the token's scope as
`{"decision": null}`.

### Repeated requests

A client that may send a request twice (a queue that retries) sends an
`Idempotency-Key` header (1 to 200 printable ASCII characters). The same key
from the same client returns the decision already logged, when the request is
the same; with another request it answers `409 idempotency_conflict`. Keys of
different clients do not meet. Test tokens are not logged, so a key does
nothing for them.

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

For apps, `GET /v1/stats/{profile}?days=7` gives the same kind of numbers
without database access, for the profiles the token may use: decisions per
action, the review queue (pending, resolved, superseded, and the final
actions people chose), and how many decisions a person corrected. Counts only, no single
decisions. The window applies to when a decision was made: a decision from
the window that was resolved or corrected later is counted with it.

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
