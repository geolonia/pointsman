# Decision chains (design)

Status: **agreed design**, for #101 (decisions of 2026-10-20 at the end).
Nothing here is built yet.

A decision can build on earlier decisions: the report is evaluated, more
checks run, and a final decision uses all of it. This document says how a
profile names the decisions it builds on, what its rules can read from them,
who runs the chain, and how people see it.

## The idea in one picture

The FIWARE demo today (#66) has two checks whose results stay side by side.
With chains, a third, final decision combines them:

```mermaid
flowchart LR
  report[/"Road closure report<br/>(RoadRestriction)"/]
  check["<b>check</b><br/>road-restriction-check<br/>AI: 4 questions · flood zone"]
  evac["<b>evacuation</b><br/>evacuation-access-check<br/>AI: 1 question · evacuation site · way around"]
  final["<b>final</b><br/>road-closure-final<br/>no AI: rules only"]
  report --> check
  report --> evac
  check --> evac
  check --> final
  evac --> final
  final --> result(["publish · review · urgent<br/>(+ alert for the site)"])
```

Each box is one decision with its own profile, its own decision log row and
its own Decision entity. An arrow means "uses the result of".

## Words from DMN, rules of our own

DMN (Decision Model and Notation, OMG) describes exactly this structure as a
*decision requirements graph*: **decisions**, the **input data** they read,
and **information requirements** between them (decision B requires decision
A). We use these concepts and their names, so the graph can be shown in DMN
tools and read by people who know DMN.

We do **not** run DMN decision logic. The spike on DMN decision tables (#13,
[spikes/dmn-policy-tables.md](spikes/dmn-policy-tables.md)) found that FEEL
tables work in a Worker but add about 25 % to the Worker, need their own
validation, and read worse than our one-line rules for small profiles. Each
decision keeps its questions, facts and threshold rules as today.

| DMN (1.3–1.6) | Pointsman |
|---|---|
| `decision` (with `question`, `allowedAnswers`) | a profile, decided once per entity: one decision log row, one Decision entity. `question` = the profile's description, `allowedAnswers` = its actions |
| `inputData` | the state's fields the profile reads, and each fact (named after its layer) |
| `informationRequirement` → `requiredDecision` | `requires` in the profile (below) |
| `businessKnowledgeModel` + `knowledgeRequirement` | the profile's AI questions and model (DMN uses BKMs for analytic models; we export it without logic) |
| `knowledgeSource` + `authorityRequirement` | the fact layers' sources (GSI, OpenStreetMap) and the profile document, with `locationURI` |
| `decisionService` with `inputDecision`s | a profile with `requires`: the required decisions' results are given to it, not evaluated by it (see "Who runs the chain") |
| Decision logic (FEEL, decision tables) | **not used**: questions, facts and `policy.rules` as today |

## In the profile: `requires`

A profile names the decisions it builds on. Each has a local name (used in
rules) and the profile it must come from:

```yaml
id: road-closure-final
version: 1
requires:
  - { name: check, profile: road-restriction-check }
  - { name: evacuation, profile: evacuation-access-check, optional: true }
facts:
  - { name: flood, type: inside, layer: gsi-flood-max, at: $.location.value }
policy:
  rules:
    - when: "decisions.evacuation.action == 'alert'"
      action: urgent
    - when: "decisions.check.action == 'urgent'"
      action: urgent
    - when: "decisions.check.action == 'publish' and facts.flood.rank < 5"
      action: publish
  default: review
```

- `optional: true`: the decision may not exist. In the demo the evacuation
  check runs only for urgent and review reports; a published report has none.
- A profile with `requires` may have **no questions**: the final decision is
  then rules only, with no model call (cheap and fast). Today `questions`
  needs at least one item; this would allow zero when `requires` is set.
- A required profile may itself require others. Cycles are refused when
  profiles are published.
- **Checked both ways.** A profile with `requires` is checked against the
  required profile's latest version when it is published, and publishing a
  new version of a required profile checks every profile that requires it:
  if one would break (a question or fact it reads is gone or has another
  type), the publish fails in CI and names it. A decision of an older
  version that lacks a field gives *unknown* at run time.

### What rules can read

`decisions.<name>.<field>`, checked at validation against the required
profile (its latest version when this profile is published):

| Field | Type | Meaning |
|---|---|---|
| `missing` | boolean | no such decision was given (only for `optional`) |
| `action` | text, one of the required profile's actions | the decision's action |
| `final_action` | text | the action after a person's review; unknown while it waits |
| `rule` | number | the index of the rule that matched |
| `answers.<question>.<field>` | as for questions | the required decision's answers (`value`, `p`, `yes`, …) |
| `facts.<fact>.<field>` | as for facts | the required decision's facts |

Unknown values work as for facts today: a comparison with a missing decision
or a value that is not there is *unknown*, `missing == true` is always known,
and a rule matches only when its condition is true.

This is what #101 asks for: **the map checks count in the final decision**,
from the decision that looked them up (`decisions.evacuation.facts.walk.extra_m`)
or looked up again by the final profile itself (`facts.flood.rank`).

## In the request: decisions by id, read from the log

The client names the earlier decisions by id; Pointsman reads them from its
own decision log:

```json
POST /v1/decide/road-closure-final
{
  "state": { "...": "the entity" },
  "ref": "urn:ngsi-ld:RoadRestriction:demo-…",
  "decisions": { "check": "1f0c…", "evacuation": "8a2d…" }
}
```

- **Read, not trusted.** The client sends only ids. The action, answers and
  facts come from the decision log, so a client cannot make a final decision
  "urgent" by claiming the first one was. A decision of another profile, or
  one the token may not see (scope), is refused (`400`).
- **Same report, same client.** A required decision must have this
  request's `ref` and come from the same client (API token), otherwise the
  request is refused (`400`). The state hash is not compared: the state
  changes between steps, because the bridge adds the results.
- **Logged.** The new decision row stores the ids it used (`requires` as a
  JSON map); `GET /v1/decisions/{id}` returns them, and the Decision entity
  gets one `prov:wasInformedBy` per id (today: one, from the bridge's
  `informedBy`).
- Test tokens and MCP work the same way.

### Who runs the chain

**The caller orchestrates, the engine checks.** In DMN terms, each profile
with `requires` is a *decision service* whose required decisions are *input
decisions*: given to it, not evaluated by it. DMN engines (Apache KIE,
Camunda) usually evaluate a whole graph in one call; we split it on purpose. Pointsman still decides one
profile per request; the caller sends the next request when the earlier
results are there. For FIWARE that is the bridge, driven by subscriptions, as
for the evacuation check today. The engine does not run several profiles in
one request: a step can wait for a person's review, and each step has its
own time limits and log row.

## In the bridge

A route lists what it requires, by the attribute where that decision's
result is:

```json
{ "type": "RoadRestriction", "profile": "road-closure-final", "name": "final",
  "inputs": ["description", "check", "evacuation"], "attribute": "final",
  "requires": { "check": "check", "evacuation": "evacuation" }, "decisionEntity": true }
```

- The bridge reads each required attribute's `decisionId` and sends it in
  `decisions`. This replaces `informedBy` (kept for a while as one entry).
- **When to run the final step:** when all required decisions are there,
  and optional ones are either there or will not come; and again when a
  required decision's `finalAction` is set by a review (decision 1). The subscription
  watches the required attributes; for the demo: `check` is `publish` (no
  evacuation check will come), or `evacuation` is set.
- The existing loop guard (input hash) and `PATCH …/attrs/{name}` apply as
  today.

## In the demo

The page shows three stages: **first result → additional checks → final
result**. The developer view's sequence diagram gets the third decision; a
small graph (the picture above, drawn on the page) marks the path this report
took: which decisions ran, which rule matched in each, and what each used.

## The graph for DMN tools

`GET /v1/profiles/{id}/graph` returns the graph a profile belongs to, as
JSON whose nodes and edges use the DMN names, so the DMN XML is a direct
serialization of it:

```json
{ "nodes": [
    { "id": "decision_road-closure-final", "type": "decision", "name": "final", "profile": "road-closure-final", "version": 1, "allowedAnswers": ["publish", "review", "urgent"] },
    { "id": "input_location", "type": "inputData", "name": "location" },
    { "id": "bkm_road-restriction-check", "type": "businessKnowledgeModel", "name": "AI questions" },
    { "id": "ks_gsi-flood-max", "type": "knowledgeSource", "name": "GSI flood zones", "locationURI": "https://disaportal.gsi.go.jp/" } ],
  "edges": [
    { "type": "informationRequirement", "from": "decision_road-restriction-check", "to": "decision_road-closure-final", "optional": false },
    { "type": "knowledgeRequirement", "from": "bkm_road-restriction-check", "to": "decision_road-restriction-check" },
    { "type": "authorityRequirement", "from": "ks_gsi-flood-max", "to": "decision_road-restriction-check" } ] }
```

and as **DMN 1.3 XML** (`https://www.omg.org/spec/DMN/20191111/MODEL/`):
only the decision requirements diagram (conformance level 1, no decision
logic), **with DMNDI** shapes and edges (a simple layered layout, which the
demo reuses), ids as NCNames (`decision_…`, `input_…`), and the profile
version and `optional` in `extensionElements`. DMN 1.3, not a newer version,
because it is the one that bpmn.io dmn-js, Camunda Modeler, Apache KIE and
Trisotech all open; without DMNDI, dmn-js does not lay the graph out. The
export is checked by opening it in those tools. Optional, after the rest.

## The path one report took

For one report, the chain is the list of decisions that ran. `GET
/v1/decisions/{id}` of the last one returns, with the ids it used, a short
trace. There is no standard format for decision traces; the names follow
Apache KIE (`TraceEvent`, `evaluationStatus`) and Camunda
(`EvaluatedDecisionResult`), so people who know those read it at once:

```json
"evaluatedDecisions": [
  { "decision": "1f0c…", "name": "check", "profile": "road-restriction-check", "status": "SUCCEEDED", "action": "urgent", "matchedRule": { "index": 0 } },
  { "decision": "8a2d…", "name": "evacuation", "profile": "evacuation-access-check", "status": "SUCCEEDED", "action": "alert", "matchedRule": { "index": 0 } } ],
"used": { "decisions": ["check", "evacuation"], "facts": ["flood"] }
```

`status` is `SUCCEEDED`, `SKIPPED` (an optional decision that did not run)
or `FAILED`. `used` lists what the matching rule read, which is what the
demo highlights.

In the data platform, the final Decision entity has one `wasInformedBy`
Relationship per required decision (`objectType: Decision`), qualified with
the local name (PROV-O `qualifiedCommunication` with `hadRole: "check"`).
NGSI-LD 1.8 *linked entity retrieval* (`join=inline&joinLevel=2`) can then
fetch the whole chain in one request; broker support (GeonicDB, Orion-LD,
Scorpio) is checked in the compliance testbed before the demo relies on it.
An alert stays a Smart Data Models `Alert` (`alertSource` the final
Decision).

## The rule language

Conditions stay our own small language (`src/policy.ts`), now with
`decisions.*`. It is **not** a subset of S-FEEL or CEL (FEEL compares with
`=`, CEL combines with `&&`, and our names contain `-`), but each condition
translates one to one, and our *unknown* matches FEEL's null and SQL's NULL
three-valued logic. The docs get a semantics note and this mapping, so a DMN
export could carry the rules as FEEL text later:

| Ours | FEEL | CEL |
|---|---|---|
| `a == 'x'` | `a = "x"` | `a == "x"` |
| `a != 'x'` | `a != "x"` | `a != "x"` |
| `x and y`, `x or y` | `x and y`, `x or y` | `x && y`, `x \|\| y` |
| `not x` | `not(x)` | `!x` |
| `decisions.check.action` | `decisions.check.action` (context path) | `decisions.check.action` |
| a missing value | `null` | an error, absorbed by `&&`/`\|\|` |

## Steps

1. **Engine:** `requires` in the profile format and schema, `decisions.*` in
   conditions (compiled and validated like facts), `decisions` in the decide
   request, read from the log with the checks above, `requires` stored with
   the decision, profiles without questions when `requires` is set. Docs,
   OpenAPI, threat model (a new input that reads other decisions: scope and
   same-entity checks).
2. **Bridge:** `requires` on routes, `wasInformedBy` per required decision.
3. **pointsman-config:** the `road-closure-final` profile and its route.
4. **Demo:** three stages, the graph in the developer view.
5. **Later:** the DMN 1.3 export (with DMNDI) and the graph endpoint; a
   table view of rules (the spike's suggestion).

Before step 4 relies on it: check `join` / `joinLevel` support in the
brokers (compliance testbed).

## Standards considered

Checked on 2026-10-20. Used where they fit, recorded where not:

| Candidate | Status | Used? | Why |
|---|---|---|---|
| OMG DMN, decision requirements graph | 1.6 formal (2026); tools read 1.3 | **Yes**: names and the export | The graph structure is exactly ours; see the mapping above |
| DMN decision logic (FEEL, S-FEEL, tables) | Same | No | Spike #13: +25 % Worker size, separate validation; our rules read better at this size |
| DMN TCK | Active (Apache-2.0) | No | Tests decision logic, which we do not export |
| Apache KIE (Drools/Kogito) DMN, Camunda DMN | Mature engines | Names only | They run the whole graph in one call; we take their trace field names |
| W3C PROV-O | Recommendation | **Yes** (already) | `wasInformedBy` per requirement, qualified with the role |
| NGSI-LD Relationships, linked entity retrieval (1.8) | ETSI GS CIM 009 | **Yes** | Links between Decision entities; one request for the chain (after a broker check) |
| Smart Data Models `Alert` | Maintained | **Yes** (already) | The alert of the evacuation check |
| Google CEL | Active (Kubernetes) | No | Well specified, but about 82 KB in the Worker and its own type environment |
| JsonLogic | Stagnant | No | Untyped JSON trees, hard to read in YAML |
| OPA / Rego | Mature (CNCF) | No | A policy language for sets and data; far too large for threshold rules |
| CNCF Serverless Workflow, BPMN | Active / mature | No | Workflow languages for an orchestrator; our chain is driven by subscriptions |
| OpenLineage | Active | No | Data lineage for jobs; nothing in FIWARE reads it |
| CloudEvents | CNCF graduated | Not now | For decision events to callers outside FIWARE, later |
| FIWARE Perseo (CEP) | Maintained, NGSI-v2, AGPL | No | Event correlation rules, not decisions with a model; a separate server |
| A Smart Data Models "Decision" or "Rule" | Does not exist | — | Our Decision model stays our own ([decision-model-standards.md](decision-model-standards.md)) |

## Decisions (2026-10-20)

1. **Reviews in the chain: decide now, again after the review.** The final
   step runs as soon as its required decisions have their automatic
   results (an urgent alert is not delayed). When a person resolves a
   required decision, the final step runs again with `final_action`; the
   new final decision records which revised decision it used (PROV-O
   `used`, the review being `wasRevisionOf`). Both final decisions stay in
   the log; the latest counts, and the report's `final` attribute holds it.
   In the trace, a decision that waits for a person is `SUCCEEDED` with its
   `action`; its review is a second entry.
2. **Same report: same `ref` and same client.** See "In the request".
3. **Versions: checked both ways when publishing.** See "In the profile".
4. **Demo: three stages.** The page shows first result → additional checks →
   final result; the first two marked as intermediate, the final one as the
   headline, each with what it was based on. Apps (the residents' map) read
   the report's `final` attribute.
