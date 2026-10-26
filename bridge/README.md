# FIWARE bridge

Connects an NGSI-LD context broker to Pointsman. When an entity is created or
one of its input attributes changes, the broker notifies the bridge; the
bridge asks Pointsman to decide about the entity, and writes the result back
to the entity as one property.

## Why a bridge

FIWARE is open-source software for smart-city data platforms. It uses
NGSI-LD, an open standard for this kind of data and its API (made by ETSI, a
European standards body). At the center of such a platform is a service
called a **context broker**. It keeps **entities** and shares them with apps:
things like a road, a report or a sensor, each with its attributes. Apps can **subscribe** to entities: then the broker sends them a
message (a **notification**) when an entity changes.

Pointsman and a context broker cannot work together directly:

- **Pointsman knows nothing about FIWARE.** It has a simple web API: you
  send it some data, and it answers with a decision. This keeps Pointsman
  usable from anywhere, not only from FIWARE.
- **The broker cannot use Pointsman alone.** It can only send a notification
  to a web address. It cannot turn the notification into a question for
  Pointsman, and it cannot save Pointsman's answer.

The bridge connects the two. It is more than a proxy, which only passes
messages on:

- **It asks.** It receives the broker's notifications. For each entity, it
  asks Pointsman with the right profile.
- **It saves the answer.** It writes the decision back to the broker as
  data, so other apps can use it: on the entity itself, and if you want, as
  separate `Decision` and `Task` entities (models from
  [datamodels.jp](https://datamodels.jp)).
- **It does the extra work.** It ignores the notifications that its own
  writes cause. It can chain decisions, one after another. It finishes a
  review when a person resolves it in the broker or in another app. With a
  queue, it also tries again until a decision is made.

In FIWARE terms, the bridge is a connector (an NGSI-LD adapter: it speaks
the NGSI-LD API of the broker). It is similar to an IoT Agent, which connects
devices to a broker. It is not a FIWARE "Generic Enabler": that is a name
for the components in the official FIWARE catalogue.

The bridge runs as its own Cloudflare Worker (this folder), or inside
another Worker, as in the demo. A city can run it in its own account, next
to its own broker.

## How it works

One route, for one notified entity:

```mermaid
sequenceDiagram
  participant Broker as Context broker
  participant Bridge
  participant P as Pointsman
  Broker->>Bridge: notification (entity) + shared secret
  opt with a queue
    Bridge-->>Broker: 202 at once, the queue handler goes on
  end
  Bridge->>Bridge: inputs unchanged since the last decision? then stop
  Bridge->>P: POST /v1/decide/{profile} {state, ref, decisions?} + Idempotency-Key
  Note over P: asks the model, looks up the facts, applies the rules
  P-->>Bridge: decision id, answers, facts, action
  opt Decision or Task entities on for the route
    Bridge->>Broker: create the Decision entity, create or cancel the Task
  end
  Bridge->>Broker: write the result attribute on the entity
```

- `state` is the entity and `ref` its id. `decisions` is only sent for a
  route with `requires` (a chain): the ids of the earlier decisions, read
  from the entity. While a required one is missing, the bridge waits for
  the next notification; a missing `optional` one is left out.
- Pointsman looks up the facts the profile asks for itself (in the demo:
  flood zone, evacuation site, way around on foot); the bridge sends no
  facts.
- A person's answer comes back the other way: the broker notifies
  `/reviews` with a resolved `Decision`, and the bridge resolves the review
  in Pointsman (`POST /v1/reviews/{id}/resolve`) and writes the final
  action. A completed work order from another app (a `Task`, with
  `BRIDGE_WORK_ORDERS` set) is first turned into a resolved `Decision`.

How the demo uses this, with three chained decisions: [docs/fiware-demo.md](../docs/fiware-demo.md#how-it-runs).

The profile reads the entity as the broker sends it (normalized NGSI-LD), so
there is no mapping code: the input paths in the profile point at the
attributes, for example `$.description.value`. See
[examples/profiles/road-restriction-check.yaml](../examples/profiles/road-restriction-check.yaml).

Background: [docs/spikes/fiware-bridge.md](../docs/spikes/fiware-bridge.md)
(#14, #41). Tried with GeonicDB; the broker check in #41 also covers Orion-LD,
Scorpio and Stellio.

## The result on the entity

One property, named in the configuration (here `check`):

```json
"check": {
  "type": "Property",
  "value": "publish",
  "observedAt": "2026-10-07T03:40:12.120Z",
  "decisionId": { "type": "Property", "value": "be691aa7-…" },
  "decision": { "type": "Relationship", "object": "urn:ngsi-ld:Decision:be691aa7-…" },
  "profile": { "type": "Property", "value": "road-restriction-check" },
  "profileVersion": { "type": "Property", "value": 1 },
  "policyRule": { "type": "Property", "value": "1" },
  "model": { "type": "Property", "value": "clef-flash" },
  "category": { "type": "Property", "value": "closedWeather" },
  "categoryProbability": { "type": "Property", "value": 0.96 },
  "danger": { "type": "Property", "value": false },
  "dangerProbability": { "type": "Property", "value": 0.53 },
  "inputHash": { "type": "Property", "value": "5a2380cd…" }
}
```

- The value is the action, so other applications can subscribe to it or query
  it (`q=check=="urgent"`).
- Each answer and its probability are sub-properties, one level deep (Orion-LD
  drops a third level). So a question must not be named like a field of the
  result (`value`, `inputHash`, `decision`, `reviewStatus`, `finalAction`,
  `reviewedAt` and the others above, or NGSI-LD's such as `observedAt` and
  `createdAt`), and neither may `<name>Probability`: the bridge then writes
  nothing for the decision and reports it, without a retry. Once the question
  is renamed, the entity's next change is decided again (a replay of the same
  notification would get the same logged decision).
- `decisionId` is Pointsman's decision id: use it to fetch the full record or
  to send feedback.
- `policyRule` is the rule of the profile's policy that gave the action
  (`"0"`, `"1"`, …, or `"default"`): the reason for the result.
- `decision` points to the Decision entity, when the route creates one (below).

## Decision entities

With `"decisionEntity": true` in a route, the bridge also creates one
`Decision` entity per decision, following the Decision model on
[datamodels.jp](https://datamodels.jp/models/decision/Decision/): the answers with their probabilities,
the profile version, the rule, the model, the time, how a person takes part,
and, for profiles with spatial facts, every fact the profile asked for, as
looked up for the decision (`facts`,
see [docs/profile-format.md](../docs/profile-format.md#facts)). Decisions can then be queried across entities, for example all that wait
for a person (`type=Decision&q=reviewStatus=="pending"`).

- The entity is created before the property is written; if the broker refuses
  it, nothing is written and the notification fails (502 when a retry may
  help).
- `humanInvolvement` is `dpv:HumanInvolvementForVerification` (and
  `reviewStatus` `pending`) for every decision Pointsman opens a review for
  (`review: {status: pending}` in its answer, from the profile's
  `people_check`) and for the route's `reviewActions`;
  `dpv:HumanInvolvementForOversight` for the other actions: they are taken,
  and a person can correct them later through Pointsman's feedback.
- `@context` is the model's published context,
  `https://datamodels.jp/context/decision/v1.jsonld` (`DECISION_CONTEXT`), so
  the broker must be able to fetch it.
- It uses NGSI-LD 1.8 `JsonProperty` and `VocabProperty`, which Orion-LD does
  not accept yet (see [docs/decision-model-standards.md](../docs/decision-model-standards.md)).
  Tried with GeonicDB.

## Task entities

With `"task": {"actions": ["review", "urgent"]}` in a route, the bridge also
creates a `Task` entity for each decision with one of these actions, and for
each decision Pointsman opens a review for (whatever its action),
following the Task model on
[datamodels.jp](https://datamodels.jp/models/task/Task/). Any app that lists
tasks from the broker (for example Redmine with GTT) then shows the work for
a person, without knowing about Pointsman.

- `name`: the action and the text of the attribute named in `task.name` (for
  example `"roadName"`: `[urgent] 県道12号`), or the entity id.
- `refersTo`: the entity; `progress` `needs-action`; `statusLabel` the
  action; `subtype` the profile; `dateCreated` the time of the decision.
- `priority` from `task.priority`, 1 (highest) to 9, per action, for example
  `{"urgent": 1, "review": 5}`.
- Its id is made from the entity id, the route's attribute and the input
  hash (`taskEntityId`), so a retried notification finds the Task it already
  created instead of adding a second one (a retry decides again, with a new
  decision id). From the entity: the result's `inputHash`. The Task model has
  no attribute for a Decision; the way is Task → `refersTo` → the entity's
  result → `decision`.
- Like the Decision entity, it is created before the property is written.
- The Task follows the latest decision for these input values: one that
  exists already (a retry, or values that came back after a change) is
  updated in place (open again, without its old `completedAt`); when a later decision for the same values needs no person, an
  open Task is set to `cancelled`, a done one stays.
- Apart from that cancel, the bridge does not change `progress`: whoever
  resolves the review sets it to `completed` (or `cancelled`).
- `@context` is `https://datamodels.jp/context/task/v1.jsonld`
  (`TASK_CONTEXT`).

## Reviews resolved in the broker

A person can resolve a decision in their own FIWARE app, without Pointsman's
API: the app writes the result to the `Decision` entity, and a subscription
sends it to the bridge's `/reviews`.

- The app sets `reviewStatus` to `resolved`, `finalAction` (for example
  `publish`), `reviewedBy` (an account or role, not a personal name),
  `reviewedAt` (an RFC 3339 date and time; the Decision model requires it
  with `resolved`), and optionally `corrections` (a `JsonProperty` list of
  `{name, value, by, at}`, as in the Decision model).
- The bridge resolves the review in Pointsman. For an action Pointsman did
  not queue (only `review` is queued, for example not `urgent`), it sends the
  corrections as feedback instead.
- Then it writes `finalAction` and `reviewedAt` to the entity's result (for
  example `check`), and completes the Task, when the entity still has this
  decision.
- Safe to repeat: a review Pointsman already has as resolved, or the same
  feedback from the same person, is not sent again. So a review resolved
  through Pointsman's API and then written to the Decision does no harm.
- Who may resolve is decided by the broker's access control: the bridge takes
  `reviewedBy` as written.
- Pointsman's resolution counts: if the review is already resolved there
  with another action, the bridge reports it and writes nothing. When
  Pointsman refuses the resolve (`409`), the bridge goes on only if the
  review is now resolved there with the same action; a review that is still
  pending is tried again (not when its profile version is gone), and one
  closed as superseded is reported.
- Two notifications for the same Decision at the same moment can both send
  the same corrections as feedback (Pointsman's feedback has no key that
  makes a repeat harmless); the values are the same.
- NGSI-LD has no conditional update, so there is a short window: if a new
  decision is written to the entity between the bridge's read and its write,
  the review's write puts the older result back. The next change of the
  inputs decides again.

The subscription, with the Decision context so the notification has short
names (full IRIs work too):

```json
{
  "type": "Subscription",
  "entities": [{ "type": "Decision" }],
  "watchedAttributes": ["reviewStatus"],
  "q": "reviewStatus==\"resolved\"",
  "jsonldContext": "https://datamodels.jp/context/decision/v1.jsonld",
  "notification": {
    "format": "normalized",
    "endpoint": {
      "uri": "https://<bridge>/reviews",
      "accept": "application/json",
      "receiverInfo": [{ "key": "x-bridge-secret", "value": "<NOTIFY_SECRET>" }]
    }
  }
}
```

Send it with `Link: <https://datamodels.jp/context/decision/v1.jsonld>`, so
`Decision` and `reviewStatus` are read from the Decision context.

## Work orders from other apps

Apps that manage work as their own `Task` entities, for example Redmine with
the [GTT FIWARE plugin](https://github.com/gtt-project/redmine_gtt_fiware),
do not write `Decision` entities. With `BRIDGE_WORK_ORDERS`, the bridge
reads their completed Tasks as the person's answer:

1. The app subscribes to the entities (for example `RoadRestriction` with
   `q=check=="review"|check=="urgent"`) and creates its own work order for
   each, at the entity's location.
2. When the person closes it, the app publishes it as a `Task` with
   `refersTo` the entity, `progress` `completed`, and its own status name as
   `statusLabel`. GTT does this with issue emission in the Task vocabulary.
3. The bridge maps `statusLabel` to a final action
   (`BRIDGE_WORK_ORDERS`, for example `{"Published": "publish", "Rejected":
   "reject"}`). It then writes it to the Decision of the entity's result that
   waits for a person, on the type's main route (the one without a name;
   later steps of a chain keep their own review path): `reviewStatus` `resolved`, `finalAction`, `reviewedBy`
   (`redmine:<instance>#<issue>` for GTT, otherwise the Task's id) and
   `reviewedAt` (the Task's `dateModified`).
4. The broker notifies `/reviews` about the Decision, and the steps above do
   the rest: Pointsman, the entity's result, the bridge's own Task.

Details:

- An unmapped status, a Task that is not completed, and an entity whose
  result is already resolved or needs no person are skipped.
- First writer wins: a Decision that is already resolved (by another work
  order or app) is left alone. Between that read and the write there is a
  short window (NGSI-LD has no conditional update); if a second writer gets
  through, `/reviews` sees that the Decision says something other than what
  Pointsman accepted, reports it and writes nothing.
- Refused (no retry): a Task id longer than 100 characters (Pointsman's limit
  for who resolved it), and a Task without `dateModified` (the bridge does not
  make up the time).
- The bridge's own Tasks are skipped too, recognised by their id
  (`urn:ngsi-ld:Task:` and 32 hexadecimal digits): other apps must not use
  that form.
- Corrections of answers cannot come this way yet.
- The subscription goes to `/reviews` as well:

```json
{
  "type": "Subscription",
  "entities": [{ "type": "Task" }],
  "watchedAttributes": ["progress"],
  "q": "progress==\"completed\"",
  "jsonldContext": "https://datamodels.jp/context/task/v1.jsonld",
  "notification": {
    "format": "normalized",
    "endpoint": {
      "uri": "https://<bridge>/reviews",
      "accept": "application/json",
      "receiverInfo": [{ "key": "x-bridge-secret", "value": "<NOTIFY_SECRET>" }]
    }
  }
}
```

## Chains of decisions

A second route on the same entity type can decide on the first route's
result, for example: a road restriction report is decided `urgent` or
`review` (route 1, attribute `check`), then a second profile asks whether
the closure cuts people off from their evacuation site (route 2).

- Give the second route a `name`, and point its subscription to
  `/notify?route=<name>`. `/notify` without a name serves the type's route
  without a name; each type has at most one of those.
- Its `inputs` include the first route's attribute (`check`), and its
  subscription watches that attribute, with `q` limiting it to the actions
  that should go on (for example `check=="urgent"`).
- `informedBy: "check"`: its Decision entities link the first decision
  (`wasInformedBy`, from `check.decision`), so the chain can be followed in
  the broker. Pointsman does not know about this link. When the second
  profile `requires` the first (next section), Pointsman checks it and its
  graph shows the order; the demo moves to this with
  geolonia/pointsman-config#19 (planned for 2026-10-21). (So the
  example uses a profile of your own: `evacuation-access-check` requires
  `check` since version 4, and a route for it needs `requires`.)

```json
[
  { "type": "RoadRestriction", "profile": "road-restriction-check", "inputs": ["description"], "attribute": "check", "decisionEntity": true },
  { "type": "RoadRestriction", "profile": "my-second-check", "inputs": ["description", "check"], "attribute": "evacuation",
    "name": "evacuation", "informedBy": "check", "decisionEntity": true }
]
```

### A final decision from several earlier ones (`requires`)

A profile can build on earlier decisions about the same entity
([docs/decision-chains.md](../docs/decision-chains.md)): for example a final
decision on a road closure from the first check and the evacuation check.
Pointsman reads the earlier decisions from its log; the bridge sends only
their ids, from the result attributes the earlier routes wrote.

```json
{ "type": "RoadRestriction", "profile": "road-closure-final", "name": "final",
  "inputs": ["description", "check", "evacuation"], "attribute": "final", "decisionEntity": true,
  "requires": { "check": { "attribute": "check", "rerunOnReview": true },
                "evacuation": { "attribute": "evacuation", "optional": true, "rerunOnReview": true } } }
```

- `requires` maps the names in the profile's `requires` to the attributes
  with those results: an attribute name, or `{ "attribute", "rerunOnReview",
  "optional" }`. Each attribute must be one of the `inputs`.
- **When it runs:** when every required decision that is not `optional` is
  on the entity (its `decisionId`); until then the message is skipped
  (`waiting for decisions`). Whether an optional one will still come is the
  subscription's `q` (in the demo: `check` is `publish`, or `evacuation` is
  set); the bridge does not guess it.
- **Running again:** a new earlier decision (another `decisionId`) is a new
  input. With `rerunOnReview: true` a person's answer on it (`finalAction`,
  `reviewedAt`) is one too, and the final decision is made again on it. The
  bridge writes these on the result for reviews resolved in the broker; an
  app that resolves reviews in Pointsman's review queue must write them on
  the result too, or the final route does not run again.
- **Replaced decisions:** a new final decision replaces the earlier one for
  the entity (`replaces` in Pointsman's answer). The bridge marks the earlier
  Decision entity's open check as `superseded` and cancels its open Task. An
  alert that was sent stays sent. When a person has resolved the earlier
  final decision, Pointsman keeps their answer (`409 resolved_by_person`);
  the bridge logs this and is done (`resolved by person`). A person's answer
  in the broker on a decision that was replaced before the answer reached
  Pointsman is reported as an error (not sent): answer the newer one.
- **Decision entities** get one `wasInformedBy` per earlier decision (one
  Relationship instance each, told apart by `datasetId`),
  `requiredDecisions` (the names with the decisions) and `replaces`, as in
  the [datamodels.jp Decision model](https://datamodels.jp/models/decision/Decision/).
  `informedBy` cannot be combined with `requires`.
- Whether a person checks the decision comes from Pointsman (the profile's
  `people_check`). The route's `reviewActions` can only add actions to that,
  never remove one: when Pointsman says a review is pending, the bridge
  always marks the decision as waiting for a person. A checked result has
  `reviewStatus: pending`, so work orders find it.
- **From the queue only:** routes with `requires` need the queue (below) with
  `max_concurrency` 1, so two runs for one entity never overlap and the
  newer decision is written last. Without the queue the Worker refuses the
  configuration. Their messages hold only the entity's id and type (the
  consumer reads the entity anyway), so a large entity still fits. In
  addition, the bridge writes nothing (no Decision entity, Task or result)
  for a decision older than the result on the entity (`observedAt`).
- Routes that read each other's results in a circle (one route's attribute
  among the other's inputs, required or not) are refused.

## How it avoids loops

The bridge writes to the entity it was notified about. Two things keep that
from starting a new decision:

- It writes with `PATCH …/attrs/{name}` (and `POST …/attrs` the first time),
  never `PATCH …/attrs`: Orion-LD notifies on the latter even for attributes
  the subscription does not watch (#41).
- It stores a hash of the input values (`inputHash`) with the result, and
  ignores a notification whose inputs have that hash. For an attribute in
  `requires` the hash also covers the earlier decision's id (and with
  `rerunOnReview` the person's answer on it). For this the
  notification must include the result attribute: do not limit
  `notification.attributes`, or include the result attribute in it.

A notification about a deleted entity (with `deletedAt`) is skipped.

## Configuration

Variables (`vars` in [wrangler.jsonc](wrangler.jsonc)):

| Name | Meaning |
|---|---|
| `BRIDGE_ROUTES` | JSON list of routes: `type`, `profile`, `inputs` (the attributes the profile reads), `attribute` (where the result goes; must not be an input); optional `decisionEntity` (true: also create Decision entities), `reviewActions` (more actions a person checks first, for Pointsman versions or profiles that do not say so; a decision Pointsman opens a review for, from the profile's `people_check`, is always checked), `name`, `informedBy` and `requires` (for chains, above), `task` (also create Task entities, above) |
| `POINTSMAN_URL` | Pointsman's base URL (in its own Worker only; leave it out inside the Pointsman Worker) |
| `BRIDGE_WORK_ORDERS` | Optional JSON object: a completed work order's `statusLabel` to the final action, for example `{"Published": "publish"}` (see "Work orders from other apps") |
| `BROKER_URL` | The broker's base URL (without `/ngsi-ld/v1`) |
| `BROKER_TENANT` | Optional: sent as `NGSILD-Tenant`. One bridge serves one tenant. |
| `BROKER_CONTEXT` | Optional: JSON-LD context URL for the writes, when the entity's attribute names are not core terms (for example the datamodels.jp context) |

Secrets (`wrangler secret put <NAME> --config bridge/wrangler.jsonc`, or
`bridge/.dev.vars` for `wrangler dev`):

| Name | Meaning |
|---|---|
| `NOTIFY_SECRET` | Shared secret the subscription sends in `x-bridge-secret`; other notifications are refused |
| `POINTSMAN_TOKEN` | A Pointsman API token limited to the bridge's profiles (`node scripts/tokens.mjs create --client fiware-bridge --profiles road-restriction-check --remote`) |
| `BROKER_TOKEN` | Optional: sent as `Authorization: Bearer …` to the broker |
| `BROKER_API_KEY` | Optional, instead of `BROKER_TOKEN`: sent as `X-Api-Key` (for example a GeonicDB API key; its `allowedOrigins` must include `*`, because the bridge sends no `Origin`) |

URLs must use https; plain http is accepted only for `localhost`.
The bridge does not follow redirects: a 3xx from the broker or from Pointsman
is an error, so the broker credentials, the Pointsman token and the entity
are never sent to another URL. Set the URL the service answers on, not one
that redirects to it.

## The subscription

One per entity type. Watch the profile's input attributes, ask for the
normalized format, and send the shared secret:

```json
{
  "type": "Subscription",
  "entities": [{ "type": "RoadRestriction" }],
  "watchedAttributes": ["roadName", "restrictionStatus", "statusLabel", "description"],
  "notification": {
    "format": "normalized",
    "endpoint": {
      "uri": "https://<bridge>/notify",
      "accept": "application/json",
      "receiverInfo": [{ "key": "x-bridge-secret", "value": "<NOTIFY_SECRET>" }]
    }
  }
}
```

Create it with the same `@context` (Link header) as the entities, so the
attribute names in the notification match the ones in `BRIDGE_ROUTES`.

## Failures and retries

The bridge answers `502` when an entity failed in a way a second try may fix
(Pointsman or the broker not reachable, a 5xx or 429), and `200` otherwise,
also when Pointsman refused the input (a retry would fail the same way). A
redirect from the broker or Pointsman also answers `200`: the URL is wrong
and a retry by the broker would fail the same way until the configuration
is fixed. With the queue (below), such a message is retried, not dropped.
The response lists what happened to each entity. Entities that succeeded are
skipped on a retry because of the input hash.

Whether a broker sends a failed notification again depends on the broker.
GeonicDB tries for about 5 minutes (4 attempts, then 2 more deliveries 2
minutes apart), then keeps the notification in its own dead-letter queue.
After an hour of failures it pauses the subscription (`inactive`), and every
later notification is lost until someone activates it again (#88). Without
retries, the next change of an input decides again, but a review or work
order whose notification was lost stays open.

### Reliable delivery (queue)

With a Cloudflare Queue (`BRIDGE_QUEUE`, see [wrangler.jsonc](wrangler.jsonc)):

- **Arrival:** `/notify` and `/reviews` check the secret, put one message per
  entity on the queue, and answer `202` at once. The broker never sees a
  failure of Pointsman or the bridge, so it never pauses the subscription.
  If the queue does not take the notification, the answer is `502`, and the
  broker may send it again. An entity larger than a queue message (about
  120 KB) is handled right away, as without a queue.
- **Processing:** the Worker's queue consumer runs the bridge for each
  message. It first reads the entity as it is now. So a message delivered
  twice finds the result it already wrote (input hash), and a change made in
  the meantime is handled with its latest values. This also holds for
  reviews and work orders. Set `max_concurrency` to 1 (as in the example): the
  consumer then handles one batch at a time, so two messages for the same
  entity never run at the same moment.
- **Retries:** a failure a second try may fix is retried after 30 seconds,
  then with the delay doubling up to an hour. With `max_retries` 20 that
  covers about 14 hours. After the last try, the message goes to the
  dead-letter queue (`pointsman-bridge-dlq` in the example). Its messages
  hold the notified entity and can be sent to the queue again. Failures a
  retry cannot fix (Pointsman refused the input) are logged and acknowledged.
  A redirect from the broker or Pointsman is retried too, although it will
  fail until the URL is fixed: the message then ends in the dead-letter
  queue, and can be sent again once the configuration is right.
- **Repeats:** every decide request carries an `Idempotency-Key` made from
  the route, the entity and the exact request. A retry of the same request
  after Pointsman has logged the decision gets that decision again instead
  of a new one; when the entity changed in the meantime, it is a new request
  and a new decision. If a person answered the review before the retry, the
  bridge writes it as resolved with their action (`finalAction` on the
  result and the Decision entity, the Task completed); if a newer decision
  replaced it, the retry writes nothing. If Pointsman still answers `409 idempotency_conflict`
  (the same key for another request, which no retry can fix), the message
  goes straight to the dead-letter queue when the bridge has it as a
  producer (`BRIDGE_DEAD_LETTER`), otherwise it is retried until it ends
  there.
- **Setup:** create both queues once
  (`wrangler queues create pointsman-bridge`, and the same for the
  dead-letter queue), then add the `queues` block to the Worker's
  configuration. Without the binding, the bridge works as before.

For a Worker that mounts the bridge itself, pass the producer binding as
`queue` in the config, and call `handleQueueBatch(batch, config)` from the
Worker's `queue` handler.

## Run it

The bridge is the connector of the module `@pointsman/fiware`
([packages/fiware](../packages/fiware), [docs/connectors.md](../docs/connectors.md)).
It runs in one of two places, with the same settings:

- **Inside the Pointsman Worker.** List it in the deployment's `engine.json`
  (`"modules": { "connectors": ["@pointsman/fiware"] }`) and set its settings
  on the Pointsman Worker, without `POINTSMAN_URL`. It serves
  `/connectors/fiware/notify` and `/connectors/fiware/reviews`, so the
  subscription's endpoint is `https://<pointsman>/connectors/fiware/notify`.
  It still calls Pointsman's API with its own `POINTSMAN_TOKEN`, in process:
  the same routes, checks and decision log as from outside. For the queue,
  add the queue bindings to the Pointsman Worker; its queue consumer hands
  the messages to the bridge.
- **In its own Worker**, next to Pointsman (this folder):

```sh
pnpm install
cd bridge
../node_modules/.bin/wrangler dev        # local, with bridge/.dev.vars
../node_modules/.bin/wrangler deploy     # with your own copy of wrangler.jsonc
```

Another Worker can mount the bridge instead of running it on its own:
`handleRequest(request, config)` from
[packages/fiware/src/bridge.ts](../packages/fiware/src/bridge.ts) (also
still at `bridge/src/bridge.ts`), with `configFrom` from
[packages/fiware/src/config.ts](../packages/fiware/src/config.ts).

Tests: `pnpm test:worker` (in `test/bridge/`, with a fake broker and
Pointsman, and inside the Pointsman Worker).
