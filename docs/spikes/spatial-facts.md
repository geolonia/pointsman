# Spike: spatial facts for decisions

Issue #60. Question: can Pointsman make better decisions about places by
adding facts from spatial operations (geofencing, nearest features, routing,
geocoding), and should rules use these facts directly?

**Short answer: yes, but put the facts into the rules, not only into the
model's input.** The facts are cheap to compute and exact. When the model
reads them as text, it does react to them, but it also treats any
information about the place as a sign of danger, even when the facts are
reassuring. Rules that read the facts directly give exact, explainable
actions. So the facts belong in the engine: a profile declares them, rules
can refer to them, and the decision log records them. Showing a fact to the
model stays an option for each fact.

Code and data: [spatial/](spatial/) (`facts.mjs` computes the facts,
`run.mjs` runs the experiment; `facts.json`, `results-clef-flash.json` and
`results-clef.json` are the results below).

## The facts

For the road restriction demo (`docs/fiware-demo.md`, profile
`road-restriction-check`), for one report (a Point or a LineString):

| Fact | Source | How |
|---|---|---|
| **Flood zone** (geofencing): inside a river flood hazard zone, and the expected depth | GSI hazard map tiles, 洪水浸水想定区域 (想定最大規模) | read the pixel colour of the raster tile at zoom 17 along the geometry; the colour gives the depth class |
| **Nearest evacuation sites** (nearest features) | GSI 指定緊急避難場所 for floods (`skhb01`), GeoJSON tiles | nearest site and the count within 500 m |
| **Evacuation routes** (routing) | Valhalla on the FOSSGIS public server, OpenStreetMap | walking routes from four places 400 m around to their nearest site: does a route pass the closed section, and how much longer is the way around it? |
| **Car detour** (routing) | the same | for a closed section: the drive between its ends with and without the section |
| **Area** (reverse geocoding) | GSI reverse geocoder | 市区町村 code and 町字 |

Examples from the demo area:

- The closed section on 靖国通り (the "flooded underpass" report) is inside
  the flood zone (1 to 3 m), 227 m from the nearest site (専修大学), and the
  way around is no longer: central Tokyo is a grid.
- A tree on the bridge at 水道橋 makes the drive 439 m longer. The same text
  on a street in the grid nearby: 0 m.

## The experiment

Ten reports: the six prepared reports of the demo at their places, and two
pairs with the same text at places where the facts differ (a deep flood zone
and none; a bridge and a street in the grid). Each report was answered four
times:

1. **plain:** as today, without facts;
2. **again:** the same, to check that the answers repeat;
3. **facts:** with a `place` field in the input: the facts as short
   sentences, for example "Inside a river flood hazard zone (maximum assumed
   rainfall); expected depth 3 to 5 m. Nearest evacuation site for floods:
   …";
4. **reworded:** with the facts, and the `danger` question reworded to count
   them ("From the report and the facts about the place: are people in
   danger …").

The profile's rules made the action. Clef-flash and Clef, on Workers AI.

### Results: `danger.yes`

| Report | Clef-flash: plain → facts → reworded | Clef: plain → facts → reworded |
|---|---|---|
| flooded-underpass | 0.43 → 0.40 → 0.60 | 0.06 → 0.10 → 0.60 |
| car-trapped | 0.96 → 0.95 → 0.87 | 0.98 → 0.98 → 0.94 |
| status-contradicts | 0.04 → 0.17 → 0.32 | 0.03 → 0.06 → 0.30 |
| water-pipe-works | 0.02 → 0.07 → 0.30 | 0.01 → 0.05 → 0.61 |
| vague | 0.19 → 0.51 → 0.69 | 0.04 → 0.25 → 0.32 |
| fallen-tree | 0.17 → 0.53 → 0.74 | 0.06 → 0.15 → 0.77 |
| water rising, **3 to 5 m zone** | 0.64 → **0.77** → 0.92 | 0.07 → **0.46** → 0.94 |
| water rising, **no flood zone** | 0.64 → **0.70** → 0.76 | 0.07 → **0.18** → 0.66 |
| tree on road, **bridge** (+439 m) | 0.58 → **0.72** → 0.84 | 0.11 → **0.18** → 0.85 |
| tree on road, **grid** (+0 m) | 0.58 → **0.46** → 0.55 | 0.11 → **0.12** → 0.63 |

The repeated run gave the same answers for every report (both models).

### What this shows

- **The models read the facts.** In each pair the dangerous place gets the
  higher `danger` (Clef: 0.46 against 0.18 for the flood zone). The grid
  street even goes down with Clef-flash ("cars can go around it").
- **But facts raise `danger` in most reports.** Reports where nothing in the
  facts is alarming go up too: "vague" from 0.19 to 0.51 (Clef-flash), the
  report outside any flood zone from 0.64 to 0.70. The model seems to take
  "there is information about the place" as a sign of danger. The exceptions
  are few: "car-trapped" (already near 1) and the grid street with
  Clef-flash went down a little.
- **Rewording the question makes it worse.** With the question asking for the
  facts, almost every report goes up: water pipe works (one lane closed for
  roadworks) from 0.01 to 0.61 (Clef), the grid street to 0.63. The difference between the two places of a
  pair gets smaller, not bigger.
- **Actions changed, mostly for the wrong reason.** With facts, Clef-flash
  made both "water rising" reports `urgent`, also the one outside any flood
  zone. With the reworded question, "fallen tree" (crews already on the way)
  became `urgent` with both models, and Clef sent the water pipe works to
  `review`.
- **The two models disagree a lot without facts** ("water rising": 0.64 and
  0.07), so thresholds tuned for one model do not fit the other. Facts in the
  input would need their own tuning against labelled reports and feedback.

Rules on the facts do what was meant. Two examples, checked against the same
results:

- **Facts and an answer together:** `flood zone 3 m or deeper and
  danger.yes >= 0.4` → `urgent`. The fact part is exact; the answer part
  still depends on the model. Only the "water rising, 3 to 5 m zone" report
  (both models, without the reworded question).
- **Facts only:** `car detour >= 300 m, or an evacuation route cut (way
  around >= 200 m)` → at least `review`. No model involved: only the bridge.

## Other findings

- **Time:** 1.6 to 6 s per report for all facts, almost all of it the routing
  calls (up to 10, one after the other, on a public server). The flood zone
  is one or two cached tiles, the evacuation sites one cached tile of about
  35 km. In parallel and with a routing server of our own it should take well
  under a second (not measured). Fine for the bridge (notifications are asynchronous); for a
  synchronous `decide` call, facts need a time limit.
- **Dense cities:** in central Tokyo, evacuation sites are close together
  (most places have several within 500 m), so one closed street almost never
  cuts the way to a site: 1 of 40 routes passed a closed section, and the way
  around was not longer. Evacuation routes matter more where sites are far
  apart, for example along rivers and in the countryside. The car detour
  mattered more here (bridges).
- **Geocoding** works for addresses (千代田区九段南1-2-1 → block level, 0.1 s)
  but not for names: "水道橋駅" first finds a 水道橋 in Chiba, "桜田門" finds
  places named 桜田 in Hokkaido. A lookup must be limited to the city's area,
  and an unsure match should lead to `review`, not to a guessed place.
  For Japanese addresses, Geolonia's own normalize-japanese-addresses is the
  better tool.
- **Routing quirk:** Valhalla drops every road that touches a closed area, so
  a route cannot start on the closed road itself. The spike closes a small
  box in the middle of the section and starts at its ends. For a long
  section this is too little: a route can leave the closed road after the box
  and come back to it, so the detour is too short. A real provider has to
  close the whole section and start just outside it.
- **No flood tile** means no published flood zone there, not "safe": the
  maps cover the rivers that have been assessed. `inside: false` should be
  read as "not inside a published zone".
- **Flood colours:** the depth classes are matched to the MLIT hazard map
  palette (水害ハザードマップ作成の手引き). The tiles do not come with a
  machine-readable legend; all colours in the demo area matched the palette.
  Older data uses one colour for 0.5 to 3 m, so treat the classes as ranks.

## Data and licences

| Source | Licence and terms | Note |
|---|---|---|
| GSI hazard map tiles (重ねるハザードマップ) | to confirm: the portal's own terms, original data 国土交通省 and prefectures | attribution; data is updated when river plans change |
| GSI 指定緊急避難場所 | 国土地理院コンテンツ利用規約; data from the municipalities | attribution; check the date of the data |
| OpenStreetMap through Valhalla | ODbL | attribution; the FOSSGIS server is for light use only, not for a service: run our own (Valhalla or OSRM) |
| GSI geocoder APIs | no service level; for light use | for a service, use our own tools |

For FIWARE users, the evacuation sites could also be `EvacuationShelter`
entities in their broker, found with an NGSI-LD geo-query
(`georel=near;maxDistance==500`). Then the city's own data is used, and the
bridge can add it to the input. That is the same fact from another source.

## Where the lookups belong

**In the engine**, as declared facts, with sources as adapters (like model
adapters). Reasons:

- Rules can use them, and a profile is checked when it is published (a typo
  in a fact name fails validation, as for questions).
- Every client gets them: the FIWARE bridge, the API, the MCP server.
- The decision log can record each fact, its value and its source, and the
  `Decision` entity can link them (`prov:used`).

The bridge stays simple: it passes the entity, and the profile reads the
location with an input path, as for every other attribute. A bridge-only
version (lookups before calling Pointsman) would be quicker to build but
would work only for FIWARE, and the rules could not see the facts.

### A sketch for the profile format

```yaml
facts:
  - name: flood
    type: inside            # the value of a layer at the place
    layer: gsi-flood-max    # configured per deployment (source, licence, attribution)
    at: $.location.value
  - name: detour
    type: detour            # extra driving metres when the section is closed
    at: $.location.value
  - name: shelter
    type: nearest
    layer: gsi-shelters-flood
    at: $.location.value
    show_model: true        # also add "Nearest evacuation site: …" to the model's input

policy:
  rules:
    - when: "facts.flood.depth_rank >= 5 and danger.yes >= 0.4"
      action: urgent
    - when: "facts.detour.extra_m >= 300"
      action: review
```

- Each fact type has typed fields (`inside` and `depth_rank`; `extra_m`;
  `distance_m` and `name`), so rules are checked like answers today.
- **A failed lookup is not a guess:** rules that need a missing fact are
  skipped and the decision records why; a profile can say that a missing
  fact means `review`.
- Layers and providers are deployment settings (in pointsman-config), not
  part of the profile, so a city can use its own data.
- Facts are cached per place and layer for a short time; each has a time
  limit.

## Next steps (proposed issues)

1. **Engine:** `facts` in the profile format, fact references in rules, facts
   in the decision log and the `Decision` model (`prov:used`). With a mock
   provider first, like the mock model.
2. **Providers:** flood zone tiles and evacuation sites (both GSI, cached);
   routing on a server of our own; geocoding limited to an area.
3. **Second demo:** the chain from #50: `urgent` → "does this cut the way to
   an evacuation site?" → an `Alert` for the site's staff, with the facts
   shown on the map.
