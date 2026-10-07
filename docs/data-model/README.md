# Decision data model (draft)

A `Decision` NGSI-LD data model for [datamodels.jp](https://datamodels.jp):
one automated decision about one entity, with the model's answers and their
probabilities, the action, the rule that gave it, and the check by a person.
Issue #52; the standards it builds on are compared in
[../decision-model-standards.md](../decision-model-standards.md) (#51).

The files use the layout of the
[geolonia/datamodels](https://github.com/geolonia/datamodels) catalog, so the
folder `decision/` can move to `models/decision/` there unchanged. Until then:

- **Not published.** The URLs in the files (`https://datamodels.jp/ns/decision/`,
  the context and schema URLs) do not resolve yet. The subject name and the
  namespace need the datamodels group's agreement before real data uses them.
- **Needs NGSI-LD 1.8 types.** `answers` and `corrections` are `JsonProperty`,
  `humanInvolvement` a `VocabProperty`. The catalog tools support them from
  geolonia/datamodels#163 on. Orion-LD does not accept these types yet; see
  the broker table in the standards survey.
- **Validate** by copying `decision/` into `models/` of a datamodels checkout
  (with #163) and running `npm run validate:models` and `npm test` there.
- **Licence:** as in the catalog: machine-readable files CC0 1.0, prose
  (`notes.yaml`, `README.md`) CC BY 4.0 (see `Decision/LICENSE.md`; the
  `LICENSE-CONTENT.md` it names is at the root of geolonia/datamodels).

| File | What |
|---|---|
| [decision/subject.yaml](decision/subject.yaml) | The subject: name, version, description |
| [decision/context.jsonld](decision/context.jsonld) | Terms: PROV-O for provenance, DPV for human involvement, the rest in `https://datamodels.jp/ns/decision/` |
| [decision/Decision/schema.json](decision/Decision/schema.json) | JSON Schema (key-values values) with NGSI-LD types and IRIs |
| [decision/Decision/catalog.yaml](decision/Decision/catalog.yaml) | Japanese and English descriptions |
| [decision/Decision/notes.yaml](decision/Decision/notes.yaml) | The standards it rests on, the candidates considered, open points |
| [decision/Decision/examples/](decision/Decision/examples/) | Key-values and normalized example (the catalog's shared scenario: heavy rain in Chiyoda, the flooded underpass on 靖国通り) |
