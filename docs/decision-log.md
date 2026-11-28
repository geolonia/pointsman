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
| `versions` | The engine version and the [fact modules](modules.md) that answered the decision's facts, with their versions (JSON: `{ "engine", "modules": { name: version } }`). Empty for decisions made before modules |
| `discarded_at` | A decision made while a person resolved the one it would replace: the client got `409 resolved_by_person`, and it never counts (not in the stats, not usable in a chain, cannot be resolved) |

Facts can read earlier decisions of the same client, as they were logged
(their profile, action and facts; [modules.md](modules.md#facts-from-the-decision-log)).
So a fact's values in the log can feed later decisions: for example the
CodeRabbit spend counts earlier pay decisions at the price their fact
recorded.

By default only the hash of the state is kept: the state can hold personal or
confidential data (issue text, sensor data). The hash still shows when the
same input was decided twice. Turn on `log.store_state` for a profile when you
need the inputs, for example to build a training set later.

Facts are stored as looked up, also without `log.store_state`. They are
derived values (a flood class, the nearest site and its distance, extra
metres); the nearest site and its distance already tell roughly where the
place is. A `detour` fact with `route: true` goes further: it keeps the way
around, which starts and ends at the place in the state. Set it only where
that place may be kept. A value fact (`field_number`, `field_text`,
`field_flag`) keeps the request value it read, as sent: use it only for data
that may be kept (docs/profile-format.md, "Values from the request").
Images (a profile with `images`) are never stored, also not with
`log.store_state`: they go to the model beside the state, and the state's
hash then covers a SHA-256 of each image, so a decision still shows when
two requests had the same photos (docs/profile-format.md, "Images").

The `requires` snapshot shows what a decision was based on, even when a
required decision gets a review answer later. `GET /v1/decisions/{id}` shows a
required decision of a profile outside the token's scope as
`{"decision": null}`.

### Repeated requests

A client that may send a request twice (a queue that retries) sends an
`Idempotency-Key` header (1 to 200 printable ASCII characters). The same key
from the same client returns the decision already logged, when the request is
the same, with its review as it is now (`review: {status: resolved,
final_action}` once a person answered, `superseded` once a newer decision
replaced it), so a retry never shows a checked decision as unchecked; with
another request it answers `409 idempotency_conflict`. Keys of
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

## Retention

By default the log keeps every decision. A deployment that sets the Worker
variable `DECISION_LOG_DAYS` keeps them that long. The value is a whole number
of days, from 30 to 36500. Then the cron trigger (every 5 minutes) deletes up
to 500 older decisions per run, with their feedback. That is at most 144,000
a day, so a large backlog takes several runs to clear the first time.

```jsonc
// wrangler.jsonc of the deployment
"vars": { "DECISION_LOG_DAYS": "365" }
```

How long to keep decisions is the deployment's decision. They can hold
personal data: references, answers, facts, and with `log.store_state` the
state. For a high-risk system, the EU AI Act asks for at least six months
(Art. 19, 26(6)). Six calendar months can be 184 days (1 July to 1 January),
and the setting counts days, so set at least `185`.

Exceptions and effects:

- **Kept while pending:** a decision whose review is still pending, or whose
  callback is still pending, stays until that is done. Then it goes in the
  next run. A review nobody answers keeps its decision for ever, so close
  stale reviews (`POST /v1/reviews/{id}/close`) to let them go.
- **Counts:** stats (`GET /v1/stats`) and replays read only what is left, so
  keep at least as long as you count back.
- **Repeated requests:** an `Idempotency-Key` is remembered only as long as
  its decision is kept. A retry after that makes a new decision.
- **Chains:** once the earlier step of a ref is deleted, a later step that
  requires it is refused as for any unusable required decision. A new decision
  for that ref no longer meets a person's resolution of the old one, so it is
  not refused with `resolved_by_person`.
- **A bad value:** the engine logs `decision log retention: DECISION_LOG_DAYS
  must be ...` and deletes nothing. Requests are not affected.
  `scripts/check-config.mjs` refuses such a value in `wrangler.jsonc`, so the
  validate workflow catches it before a deploy. Unset or empty keeps
  everything.

The deletion uses the index `decisions_created` (migration
`0009_decisions_created.sql`). The deploy workflow applies migrations before
it deploys the engine, so set the variable with that engine version or a
later one.

## Local development

```sh
pnpm db:migrate:local   # apply migrations/ to the local D1
pnpm dev
```
