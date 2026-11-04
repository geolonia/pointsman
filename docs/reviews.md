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
  answers `409 not_pending`. So does a resolve after the review was
  [closed](#closing-a-review).
- `by` is stored as the client sends it (`resolved_by`). The GitHub connector
  sends `github:<login> (<account id>)` for an answer given in a pull request,
  after it checked the person with GitHub
  ([github-connector.md](github-connector.md#answering-in-the-pull-request));
  Pointsman itself checks the token, not the person.
- `GET /v1/decisions/{id}` shows `review` (status, final action and answers)
  and `callback` (delivery status).
- For a profile with `requires`, a newer decision for the same report
  replaces the earlier one: the earlier review leaves the queue with status
  `superseded`, cannot be resolved (`409 not_pending`), and sends no
  callback. See [decision-chains.md](decision-chains.md).

## Closing a review

The client that made a decision can close its pending review when the
question no longer applies, for example the GitHub connector after a push
(the review was about the older commit):

```sh
curl -s -X POST "$POINTSMAN/v1/reviews/$ID/close" -H "authorization: Bearer $TOKEN"
```

- Only the client that made the decision may close it. For any other token,
  also one that may use the profile, the decision does not exist (`404`).
  A test token may not close (`403`).
- The review leaves the queue with status `superseded`, as for a decision
  that a newer one replaced. No callback is sent.
- A review can be closed or resolved, once. A resolve after the close, or a
  second close, answers `409 not_pending`; so does a close after a resolve.
  Of a close and a resolve at the same moment, only one succeeds.
- `GET /v1/stats/{profile}` counts closed reviews under `superseded`.

## Callbacks

When a review with a `callback_url` is resolved, Pointsman POSTs:

```json
{
  "decision_id": "…",
  "client": "issue-bot",
  "callback_url": "https://issue-bot.example.org/pointsman",
  "ref": "github:example/repo#42",
  "profile": "issue-triage",
  "profile_version": 1,
  "action": "auto",
  "answers": { "team": { "value": "frontend", "source": "human" } },
  "resolved_by": "reviewer@example.com",
  "resolved_at": "2026-10-06T10:00:00.000Z"
}
```

`client` is the client that made the decision (its API token's client name,
or the `INTERNAL_CLIENT` name for an [internal call](adapters.md)), and
`callback_url` is the URL it gave. Both are in the signed body.

Every callback is signed with the Worker secret `CALLBACK_SECRET`
(`wrangler secret put CALLBACK_SECRET`). Without that secret, nothing is sent
(the callback status says why). One secret signs the callbacks of every
client of the deployment. Any client with a token can name your `ref` and your
`callback_url` in its own decision, and its callback is signed too. So check
all of these:

- the signature;
- the timestamp is recent;
- `client` is your own client name;
- `callback_url` is your own URL.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body as received, before JSON parsing.
function verify({ secret, client, url }, headers, rawBody, maxAgeSeconds = 300) {
  const timestamp = headers['x-pointsman-timestamp'];
  const signature = headers['x-pointsman-signature'] ?? '';
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > maxAgeSeconds) return null;
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(rawBody);
  // Signed, but for another client or another receiver: not yours.
  if (payload.client !== client || payload.callback_url !== url) return null;
  return payload;
}

// verify({ secret, client: 'issue-bot', url: 'https://issue-bot.example.org/pointsman' }, req.headers, rawBody)
```

**Changed after v0.18.0.** Callbacks up to v0.18.0 had no `client` and no
`callback_url`. The signature is made the same way, so a receiver that checks
only the signature keeps working. To be safe against other clients, add the
`client` and `callback_url` checks. A receiver that refuses unknown fields
must accept the two new fields. Every receiver of a deployment holds the
same secret, so whoever runs one receiver can also sign callbacks for the
others; give the secret only to receivers you trust.

Answer with any 2xx status. Otherwise (or on a network error or a timeout of
10 seconds) Pointsman retries after 1 minute, 5 minutes, 30 minutes, 2 hours
and 12 hours, then gives up (`callback.status: failed`). Retries are run by
the Worker's cron trigger (every 5 minutes, `triggers` in the wrangler
config). A callback can arrive more than once if your 2xx answer is lost, so
make the handler safe to repeat (use `decision_id`).
