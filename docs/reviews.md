# Reviews and callbacks

When a policy returns the action `review`, the decision waits for a person.
The client gets the decision right away (with `action: review` and
`review: {status: pending}`) and can pass a `callback_url` to receive the
final answer later. A profile can list other actions that a person checks too
(`policy.people_check`, see
[profile-format.md](profile-format.md#people-check-and-answers)).

## Review queue

```sh
# Pending reviews for the profiles this token may use (oldest first, max 100)
curl -s "$POINTSMAN/v1/reviews?profile=issue-triage" -H "authorization: Bearer $TOKEN"

# Resolve one: the final action, who decided, and optionally corrected answers
curl -s -X POST "$POINTSMAN/v1/reviews/$ID/resolve" -H "authorization: Bearer $TOKEN" \
  -d '{"action": "auto", "correct": {"team": "frontend"}, "by": "reviewer@example.com"}'
```

- `action` is the final answer: one of the profile's `people_answers`
  (default: its actions without `review`, plus `reject`). Any other answer
  is refused (`400`).
- Answers in `correct` replace the model's (`source: human`); the others are
  kept (`source: model`). `correct` is also stored as feedback, so it counts
  in the accuracy numbers (see [decision-log.md](decision-log.md)).
- A review can be resolved once. A second resolve, also at the same moment,
  answers `409 not_pending`.
- `GET /v1/decisions/{id}` shows `review` (status, final action and answers)
  and `callback` (delivery status).
- For a profile with `requires`, a newer decision for the same report
  replaces the earlier one: the earlier review leaves the queue with status
  `superseded`, cannot be resolved (`409 not_pending`), and sends no
  callback. See [decision-chains.md](decision-chains.md).

## Callbacks

When a review with a `callback_url` is resolved, Pointsman POSTs:

```json
{
  "decision_id": "…",
  "ref": "github:example/repo#42",
  "profile": "issue-triage",
  "profile_version": 1,
  "action": "auto",
  "answers": { "team": { "value": "frontend", "source": "human" } },
  "resolved_by": "reviewer@example.com",
  "resolved_at": "2026-10-06T10:00:00.000Z"
}
```

Every callback is signed with the Worker secret `CALLBACK_SECRET`
(`wrangler secret put CALLBACK_SECRET`). Without that secret, nothing is sent
(the callback status says why). Check the signature, and reject old
timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, timestamp, signature, body, maxAgeSeconds = 300) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > maxAgeSeconds) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// verify(secret, req.headers['x-pointsman-timestamp'], req.headers['x-pointsman-signature'], rawBody)
```

Answer with any 2xx status. Otherwise (or on a network error or a timeout of
10 seconds) Pointsman retries after 1 minute, 5 minutes, 30 minutes, 2 hours
and 12 hours, then gives up (`callback.status: failed`). Retries are run by
the Worker's cron trigger (every 5 minutes, `triggers` in the wrangler
config). A callback can arrive more than once if your 2xx answer is lost, so
make the handler safe to repeat (use `decision_id`).
