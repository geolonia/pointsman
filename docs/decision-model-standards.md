# Decision data model: existing standards

Issue #51. Before the `Decision` model goes further (draft in
[spikes/decision-data-model.md](spikes/decision-data-model.md), next step #52):
what already exists, what fits, and what we take from it.

Checked on 2026-10-07: the specifications themselves, the Smart Data Models
repositories, all published ETSI ISG CIM documents, and the texts of the laws
and guidelines listed below. Links are at the end.

## Short answer

**Nothing existing covers a decision record as a whole: one decision about one
entity, with typed answers, probabilities, an action and a person's review.**
So the model stays our own, but most of its parts can use existing terms:

- **W3C PROV-O** is the backbone (as in the spike): the decision is an
  activity that used the entity, followed a plan (the profile version), and was
  carried out by a software agent (the model). PROV-O also covers chains of
  decisions and the review.
- **W3C/OGC SOSA/SSN** publishes its own alignment to PROV-O, with the same
  shape. We document the SOSA equivalents, so SOSA users can read our data.
- **W3C DPV** has terms for how people are involved in automated decisions;
  we use them for the review part.
- **NGSI-LD core** (ETSI GS CIM 009) has property types that fit: a JSON
  property for the list of answers, a vocabulary property for status values,
  and multi-attribute instances for several models on one entity.
- **Regulation and guidelines** (EU AI Act, GDPR, Japan's AI事業者ガイドライン,
  Digital Agency DS-920) do not define a record format. Japan's guideline and
  DS-920 ask for **the reason for the result** in logs (non-binding), and the
  duties to explain and inform are easier to meet when the record says
  **whether a person took part**. The draft has neither yet.
- **Probabilities** have no usable standard. They stay our own attributes.

## Candidates

### Provenance and observations

| Candidate | Status | Fit | Why |
|---|---|---|---|
| **PROV-O** (W3C Recommendation, 2013) | Widely used | **Yes, backbone** | `prov:Activity` with `prov:used` (entity), `prov:endedAtTime`, `prov:wasAssociatedWith` a `prov:SoftwareAgent` (model), `prov:qualifiedAssociation` / `prov:hadPlan` (profile version). `prov:wasInformedBy` links a decision to the one before it in a chain. A review is a second activity by a person; the corrected result points back with `prov:wasRevisionOf`. |
| **SOSA/SSN** (W3C/OGC Recommendation, 2017; 2023 edition still a Working Draft) | Widely used in IoT; ETSI GR CIM 021 uses it with NGSI-LD | **Partial, as documented equivalents** | A software system can be a sensor, and SOSA's published PROV alignment matches ours term by term: `sosa:hasFeatureOfInterest` ⊑ `prov:used`, `sosa:madeBySensor` ⊑ `prov:wasAssociatedWith`, `sosa:usedProcedure` ⊑ the plan, and for the end time `sosa:resultTime` ⊑ `prov:endedAtTime` (2017) or `sosa:endTime` ⊑ `prov:endedAtTime` (2023 draft; there `resultTime` is when the result became available). One observation has one result, so a decision with several answers would be an `ObservationCollection` (only in the 2023 draft), and a question would have to be an "observable property", which is a stretch. Not used as the type; equivalents listed in the model notes. `sosa:Actuation` does not fit the action (it changes a property of a thing, not a workflow). |
| PROV-ML, ProvONE | Research / scientific workflows | No | About training runs and workflows, not single decisions; no published namespace for PROV-ML. |

### Human involvement and AI terms

| Candidate | Status | Fit | Why |
|---|---|---|---|
| **DPV 2.3** (W3C Community Group final report, 2026) | Used in EU compliance tools | **Partial, for the review** | Terms for the kind of human involvement: `dpv:HumanInvolvementForVerification`, `…ForDecision`, `…ForOversight`, `…ForIntervention`, and `dpv:CorrectingProcessOutput`, `dpv:ChallengingProcessOutput`, `dpv:hasAutomationLevel`. DPV describes processes, not single records, so it types the profile ("this profile has people verify `review` results") and gives the review values their meaning. |
| AIRO / VAIR | Research (ADAPT, TCD), small adoption | No | System-level risk descriptions; nothing for one output. At most a tag on the profile. |
| ISO/IEC 22989:2022 (AI concepts and terms) | International standard | **Terms only** | Use its words where we name things: "output", "prediction", "input data", "AI subject"; "ground truth" for a person's correction. |
| ML Schema, FAIR4ML | W3C CG report / RDA | No (for the record) | Describe models and training runs. FAIR4ML could describe the model the `model` attribute names. |
| schema.org `AssessAction`, `ChooseAction`, `Rating` | Widely used on the web | Weak | Close in words, no probabilities, and PROV-O covers the same parts better. |
| W3C Decision Incubator "Decision Ontology" (2012) | Abandoned, `example.com` namespace | No | Has questions and answers, but no usable namespace and no use. |

### Probability of an answer

| Candidate | Fit | Why |
|---|---|---|
| DQV `dqv:hasQualityMeasurement`, and SOSA 2023 `sosa:resultQuality` (non-normative) | Awkward | We would mint a "probability" metric, and a distribution over options does not fit. |
| ISO 19156:2023 (OMS) result quality | Partial | Quality of a result, no probability per category. |
| UncertML | No | XML only, and its domain has expired. |
| QUDT uncertainty | No | Numbers with units only, not yes/no or choices. |
| URW3 uncertainty ontology | No | Inactive, no namespace. |

**Decision:** `probability` and `probabilities` stay our own. Smart Data Models
uses `confidence` in a few models with no shared rule; we keep `probability`,
because Clef returns a separate `confidence` value that means something else.

### NGSI-LD and FIWARE

| Candidate | Fit | Why |
|---|---|---|
| Smart Data Models `SMAnalysis` (SocialMedia) | Partial, the closest | One analysis of one entity (`isAnalysisOf`), a type, a value and one `hasConfidence`. No multiple answers, no review. The pattern supports ours; the names are not worth copying. |
| Smart Data Models `MLModel`, `MLProcessing` (MachineLearning) | No, for the record | Describe the model and the job, not results. `MLModel` could be what `model` points to. |
| Smart Data Models `Alert`, `Anomaly`, `AIPrediction`, `DataQualityAssessment` | No | Alerts, anomalies, one domain (laser machines), data quality. `Alert` could be what an `urgent` decision creates (#50). |
| ETSI ISG CIM reports | No model | No report on AI/ML results. GR CIM 017 (digital twins) suggests storing predictions as properties with a confidence and using multi-attribute instances, without names. |
| NGSI-LD 1.8 `JsonProperty` | **Yes, for `answers`** | A raw JSON value whose keys are not expanded, made for structures like our answers. Needs brokers that support it; Orion-LD does not yet (see below). Queries can reach inside it only with the `jsonKeys` parameter, which not every broker has, so `action` and the status stay normal properties. In the simplified (key-values) form it is `{"json": …}`. |
| NGSI-LD `VocabProperty` | Yes, for `reviewStatus` | Values from a fixed vocabulary, as IRIs. |
| NGSI-LD multi-attribute (`datasetId`) | Yes, optional | One instance per model when several models decide on the same entity. |
| FIWARE projects (Cosmos, fiware-ml-supermarket, SEDIMARK, DEMETER) | No | Move data, describe marketplace assets, or use ad-hoc entities without probabilities. |
| Digital Agency 地域サービス・データモデル・ガイドブック β版 (2025) | No | Nothing on AI results. |

### Maintenance, licence and use in Japan

For the candidates we take something from. The others are not used, for the
reasons in the tables above.

| Candidate | Maintained | Adoption | Licence | Use in Japan |
|---|---|---|---|---|
| PROV-O | W3C Recommendation (2013), stable, no active work needed | Wide (research data, public sector catalogues, SOSA builds on it) | W3C document licence | General; no country-specific parts |
| SOSA/SSN | W3C/OGC; 2017 Recommendation, 2023 edition in progress | Wide in IoT; ETSI GR CIM 021 shows it with NGSI-LD | W3C document licence | General; we only document equivalents, so nothing depends on the draft |
| DPV | W3C Community Group, active (2.3, 2026) | EU compliance tools and research | W3C licence (Community Group report) | Written around EU law (GDPR, AI Act). We use only its general terms for human involvement, which fit Japanese practice (人間の判断の介在) as well |
| ISO/IEC 22989 | ISO/IEC JTC 1/SC 42, published 2022 | Basis of later AI standards, including ISO/IEC 42001 | Paid standard; we use only its terms | International standard; terms only |
| NGSI-LD (ETSI GS CIM 009) | ETSI ISG CIM, active (1.9.1, July 2025; `JsonProperty` and `VocabProperty` since 1.8) | FIWARE brokers, and smart city platforms in Japan that use FIWARE, GeonicDB among them | Free to download (ETSI) | Already the format of the entities the bridge reads |
| Smart Data Models `SMAnalysis` | Smart Data Models, one project (aqua3S) | Small | CC BY 4.0 | Not used; only supports the pattern |

### Broker support for the NGSI-LD 1.8 property types

Checked on 2026-10-07: create an entity with a `JsonProperty` (a list of
answers) and a `VocabProperty` (a DPV term), read it back normalized and
simplified, update the `JsonProperty`, and query the `VocabProperty`.

| Broker | `JsonProperty` | `VocabProperty` |
|---|---|---|
| Orion-LD post-1.12.0 (2026-09-25) | **Refused** (400, "Invalid type for attribute") | **Refused** (400) |
| Scorpio 6.0.2 | Works; the simplified form leaves out the `json` wrapper | Works; same in the simplified form |
| Stellio 2.38.0 | Works, but after an update to a list with one item, reading it (normalized form) returns that item as an object instead of a list; the simplified form after an update was not checked | Works |
| GeonicDB | Works | Works |

Using these types means Orion-LD cannot store the entity until it supports
them.

## What regulation and guidelines ask for

None of these defines a record format. The EU AI Act makes logging a duty only
for high-risk systems, and lists fields only for remote biometric
identification. Japan's guideline is non-binding; DS-920 applies to central
government systems. So the table separates two things:

- **Record duty:** a text that asks for this to be logged or recorded.
- **Design choice:** no text asks for it in a record, but a duty to explain,
  to inform or to let a person oversee the decision is much easier to meet
  when the record has it. These fields are our recommendation, not a legal
  requirement.

| Field | Kind | Source | In the draft? |
|---|---|---|---|
| Time of the decision | Record duty | AI Act Art. 12 (high-risk; fields named only for biometrics, 12(3)(a)); ガイドライン 6)① (non-binding); DS-920 6.3 | yes, `decidedAt` |
| Reference to the input | Record duty | AI Act Art. 12(3)(c) (biometrics only); ガイドライン 6)① 入出力 (non-binding) | yes, `refersTo` |
| The output | Record duty | ガイドライン 6)① 入出力 (non-binding); DS-920 6.5 (logs of outputs) | yes, `answers` |
| **Reason for the result** | Record duty (non-binding) and design choice | ガイドライン 6)① 判断根拠 and DS-920 6.5 判断根拠 ask for it in logs; AI Act Art. 86 gives a right to an explanation of the "main elements of the decision" (limited scope), not a record duty | **no: add the matching policy rule** |
| The logic used (model, profile version) | Design choice | GDPR Art. 13–15 and AI Act Art. 86 ask to inform, not to record; ガイドライン 7)① トレーサビリティ; DS-920 checklist 29 (model cards) | yes |
| The final decision | Design choice | AI Act Art. 86 (explanation) | yes, `action`, `finalAction` |
| **Whether a person took part** | Design choice | GDPR Art. 22 (decisions "based solely on automated processing"); AI Act Art. 26(11) and ガイドライン U-7 (tell people AI is used) | **no: add** |
| Who reviewed | Record duty, biometrics only | AI Act Art. 12(3)(d); otherwise design choice for GDPR Art. 22(3) (human intervention) | yes, `reviewedBy` |
| A person's correction | Design choice | AI Act Art. 14(4)(d) (ability to override); ガイドライン 3)② 人間の判断の介在 | yes, `corrections` |
| Contest by the affected person | Design choice | GDPR Art. 22(3); Council of Europe Convention Art. 14 | no; out of scope for now (a review can record it) |
| Retention | Duty, but not a field | AI Act Art. 19, 26(6): at least six months for high-risk systems; ガイドライン 6)①: each organisation decides | not a model field; a deployment setting |
| Probability | Design choice | not named anywhere; helps a person interpret the output (AI Act Art. 14(4)(c)) | yes |

Would a road restriction check be high-risk under the AI Act? Only if it acts
as a safety component in road traffic management (Annex III point 2); a
triage of reports that a person checks is more likely a "preparatory task"
(Art. 6(3)), which must be documented. This is for each deployer to assess,
not for the data model.

## Recommendation for #52

1. Keep the model our own (`Decision`), with PROV-O as its backbone, as
   drafted.
2. Add:
   - `policyRule`: which rule of the profile's policy decided (index, or
     `default`). Pointsman's decision log already stores it (`rule`).
   - `humanInvolvement`: whether and how a person takes part, with values
     taken from DPV (`HumanInvolvementForVerification` for `review`, none for
     `publish` / `auto`).
   - `wasInformedBy`: the decision before this one in a chain
     (`prov:wasInformedBy`).
3. Use NGSI-LD 1.8 `JsonProperty` for `answers` if the brokers support it;
   otherwise a structured property with `@json` in the context, as drafted.
4. In the model notes, list the SOSA equivalents and the candidates above,
   with the reason for each, as the datamodels catalog asks.
5. Name things with ISO/IEC 22989 terms where they differ from ours only in
   wording ("ground truth" for corrections, "AI subject" for the affected
   person, if we ever add it).

## Sources

- PROV-O: https://www.w3.org/TR/prov-o/
- SOSA/SSN: https://www.w3.org/TR/vocab-ssn/ (2017), https://www.w3.org/TR/vocab-ssn-2023/ (draft)
- DPV 2.3: https://w3c-cg.github.io/dpv/2.3/dpv/ and https://w3c-cg.github.io/dpv/2.3/ai/
- AIRO / VAIR: https://w3id.org/airo, https://w3id.org/vair
- DQV: https://www.w3.org/TR/vocab-dqv/
- ISO 19156:2023 / OGC OMS: https://docs.ogc.org/as/20-082r4/20-082r4.html
- ISO/IEC 22989:2022: https://www.iso.org/standard/74296.html (terms checked in the publisher's free preview)
- ML Schema: http://ml-schema.github.io/documentation/ML%20Schema.html
- FAIR4ML: https://rda-fair4ml.github.io/FAIR4ML-schema/release/0.1.0/index.html
- Smart Data Models: https://github.com/smart-data-models (dataModel.SocialMedia, dataModel.MachineLearning, dataModel.Alert, dataModel.PredictiveMaintenance, dataModel.DataQuality)
- ETSI GS CIM 009 V1.9.1 (2025-07; current version, simplified representation in clause 4.5.4, `jsonKeys`): https://www.etsi.org/deliver/etsi_gs/CIM/001_099/009/01.09.01_60/gs_CIM009v010901p.pdf
- ETSI GS CIM 009 V1.8.1 (2024-03; the version that added `JsonProperty` and `VocabProperty`): https://www.etsi.org/deliver/etsi_gs/CIM/001_099/009/01.08.01_60/gs_cim009v010801p.pdf
- ETSI GR CIM 021: https://www.etsi.org/deliver/etsi_gr/CIM/001_099/021/01.01.01_60/gr_CIM021v010101p.pdf
- EU AI Act (Regulation (EU) 2024/1689), Articles 6, 12, 14, 19, 26, 86, Annex III: https://artificialintelligenceact.eu/
- GDPR Articles 13–15, 22: https://gdpr-info.eu/
- AI事業者ガイドライン 第1.2版 (2026-03-31): https://www.meti.go.jp/shingikai/mono_info_service/ai_shakai_jisso/20260331_report.html (本編, checked; the text on logs in 6)① and on traceability in 7)① is the same as in 第1.1版 of 2025-03-28)
- AI推進法 (令和7年法律第53号): https://laws.e-gov.go.jp/law/507AC0000000053 (no record duties)
- Digital Agency DS-920 (2025-05-27): https://www.digital.go.jp/assets/contents/node/basic_page/field_ref_resources/e2a06143-ed29-4f1d-9c31-0f06fca67afc/80419aea/20250527_resources_standard_guidelines_guideline_01.pdf
- Digital Agency 地域サービス・データモデル・ガイドブック β版: https://www.digital.go.jp/assets/contents/node/basic_page/field_ref_resources/fc97ed25-7bbb-4f5c-8ca5-97b344dc36d7/69e02ec6/20250930_policies_development_management_outline_04.pdf
