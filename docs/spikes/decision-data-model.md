# Spike: a `Decision` data model for geolonia/datamodels

Issue #16. Question: should a decision result be published as a data model in
[geolonia/datamodels](https://github.com/geolonia/datamodels), so systems can
store decisions as NGSI-LD entities?

**Short answer: yes, eventually, as a small model whose provenance part maps
to W3C PROV-O. Not yet.** The FIWARE bridge (#14) works with a Property on the
entity, and Pointsman keeps the full record in its own decision log. A
`Decision` entity is worth proposing when a real application needs decisions
in its broker, queryable across entities. That matches how the catalog works
(launch after models are proven in real apps). The draft below is ready for
that proposal.

## What a decision needs to carry

From Pointsman's decision record (`GET /v1/decisions/{id}`) and the review and
feedback flow:

- what was decided about (the entity, or an external reference)
- the action (`auto`, `review`, or a custom one)
- the answers: per question its type, value and probability
- how: profile id and version, model
- when
- a person's review and corrections, if any

## Upstream considered (2026-10-07)

| Candidate | Fit | Why |
|---|---|---|
| **W3C PROV-O** | **Use for provenance** | A decision is a `prov:Activity` that `prov:used` the entity, was associated with an agent (the model) following a plan (the profile version), and ended at a time. A review is another activity, by a person, that `prov:wasInformedBy` the decision. A W3C Recommendation, general, not tied to one country or product. It says nothing about questions, answers or probabilities, so those stay ours. |
| schema.org `ChooseAction` | Partly | The act of choosing among options, with `object`, `instrument`, `actionOption`, `result`. Close in words, but made for a person choosing among offers; no probabilities, no plan. Usable as an alias for search, not as the base. |
| W3C ML Schema (`mls:Run`) | No | Describes training and evaluation runs of algorithms (hyperparameters, evaluation measures), not single decisions on one input. |
| Smart Data Models `DataQuality/DataQualityAssessment` | No | Quality figures of a sensor measurement (accuracy, completeness, outliers). |
| Smart Data Models `Alert/Alert`, `Alert/Anomaly` | No | An event with category, severity and source. A decision may raise an alert, but is not one. |
| DMN (OMG) | No | Defines decision logic (tables, FEEL), not records of decisions made (see the DMN spike, #13). |

Nothing upstream covers questions with typed answers and probabilities. The
model would be minted, with PROV-O for its provenance attributes.

## Draft model: `Decision`

Subject: a new `decision` subject (deciding new subjects is the datamodels
group's call), or `common` if the group prefers.

| Attribute | NGSI-LD | Required | Meaning | Maps to |
|---|---|---|---|---|
| `refersTo` | Relationship | yes, or `externalReference` | The entity the decision is about | `prov:used` |
| `externalReference` | Property (text) | | A reference outside the broker (an issue URL) | |
| `action` | Property (text) | yes | `auto`, `review`, or a custom action of the profile | (ours) |
| `answers` | Property (structured, list) | yes | Per question: `name`, `type` (`noul`, `choice`, `score`), `value`, `probability`, and for choice/score the `probabilities` per option or level | (ours) |
| `profile` | Property (text) | yes | Profile id | the plan (`prov:hadPlan` on a qualified association), with `profileVersion` |
| `profileVersion` | Property (integer) | yes | Profile version | |
| `model` | Property (text) | yes | Model id that answered | `prov:wasAssociatedWith` (software agent) |
| `decidedAt` | Property (DateTime) | yes | When the decision was made | `prov:endedAtTime` |
| `reviewStatus` | Property (text) | | `pending`, `resolved`; absent when no review was asked | |
| `finalAction` | Property (text) | | The action after a person's review | |
| `reviewedBy` | Relationship | | The person or team who resolved it | `prov:wasAssociatedWith` of the review activity |
| `reviewedAt` | Property (DateTime) | | When it was resolved | |
| `corrections` | Property (structured, list) | | Corrected answers, each with `name`, `value`, `by`, `at`, optional `note` | (ours) |

Notes on choices:

- **`action` as the main value**, as in the bridge Property (#14), so queries
  like "all decisions waiting for review" are simple (`q=action=="review"`).
- **`answers` as one structured Property** rather than one attribute per
  question: questions differ per profile, and a model cannot list them all.
  Its items have a fixed shape (above), so the JSON Schema can check them.
- **Review and feedback on the same entity**, not separate entities, to keep
  consumers simple. In PROV-O terms the review is its own activity; the mapping
  documents that. A separate `DecisionReview` entity can come later if needed.
- **No state, prompt or input copy.** The input can hold personal data;
  Pointsman stores only a hash by default. `refersTo` points to the input.
- **Ids:** `urn:ngsi-ld:Decision:<decision id from Pointsman>`, so the entity
  and the log record share the id.

### Example (normalized)

```json
{
  "id": "urn:ngsi-ld:Decision:7d20731d-5cc8-4315-97ba-1576c5466269",
  "type": "Decision",
  "refersTo": { "type": "Relationship", "object": "urn:ngsi-ld:ServiceRequest:002" },
  "action": { "type": "Property", "value": "review" },
  "answers": {
    "type": "Property",
    "value": [
      { "name": "department", "type": "choice", "value": "parks", "probability": 0.62,
        "probabilities": { "roads": 0.21, "parks": 0.62, "waste": 0.17 } },
      { "name": "safety", "type": "noul", "value": true, "probability": 0.74 }
    ]
  },
  "profile": { "type": "Property", "value": "service-request-triage" },
  "profileVersion": { "type": "Property", "value": 1 },
  "model": { "type": "Property", "value": "clef-flash" },
  "decidedAt": { "type": "Property", "value": { "@type": "DateTime", "@value": "2026-10-06T16:09:35Z" } },
  "reviewStatus": { "type": "Property", "value": "pending" }
}
```

### Context sketch

```json
{
  "@context": {
    "dec": "https://datamodels.jp/ns/decision/",
    "prov": "http://www.w3.org/ns/prov#",
    "Decision": "dec:Decision",
    "refersTo": { "@id": "prov:used", "@type": "@id" },
    "decidedAt": { "@id": "prov:endedAtTime", "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    "model": "dec:model",
    "profile": "dec:profile",
    "profileVersion": "dec:profileVersion",
    "action": "dec:action",
    "answers": { "@id": "dec:answers", "@type": "@json" }
  }
}
```

`Decision` would be declared a subclass of `prov:Activity` in the vocabulary.
The profile as a plan needs PROV's qualified form (`prov:qualifiedAssociation`
with `prov:agent` and `prov:hadPlan`); the flat attributes stay simple for
NGSI-LD users, and the vocabulary documents the mapping.
`answers` as `@json` keeps its inner keys from being expanded.

## How it relates to the bridge Property (#14)

- The **Property on the entity** (`triage`) is the light form: the action and
  key answers where consumers look.
- The **`Decision` entity** is the full form: one per decision, queryable
  across entities, with review and corrections.
- The bridge can write both: the Property, and with a setting, a `Decision`
  entity that the Property points to (`decisionId` becomes a Relationship).
  Sub-property names in the Property should match the model's attribute names.

## Recommendation

- Keep the draft here for now; do not open a datamodels proposal yet.
- Propose it (a datamodels proposal issue, decided by the datamodels group)
  when an application needs decisions in its broker: likely the first FIWARE
  bridge in real use. Bring that use as the first adopter.
- Until then, align the bridge's Property names with this draft
  (`action` as value, `profile`, `profileVersion`, `model`, per-answer values
  and probabilities), so the step to the model is small.
