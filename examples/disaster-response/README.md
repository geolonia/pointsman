# Pointsman for disaster response

During heavy rain, a city gets many reports of closed roads. Someone checks
each report before it goes on the public map, and the urgent ones must not
wait in the queue. Pointsman does the first check on every report, adds
facts from public map data, and sends the unclear and urgent ones to a
person.

Try it: the [FIWARE demo](https://pointsman-demo.geolonia.workers.dev/?lang=en)
runs this chain on prepared reports.

## Profiles

Three profiles form a chain ([decision chains](../../docs/decision-chains.md)):

| Profile | Decides | Actions |
|---|---|---|
| [`road-restriction-check`](../profiles/road-restriction-check.yaml) | What kind of closure is it, does the status match the text, is anyone in danger, is the report clear enough to publish? | `publish`, `urgent`, `review` |
| [`evacuation-access-check`](../profiles/evacuation-access-check.yaml) | For a closure near an evacuation site: are people on foot cut off from it? Runs only after the first check said `urgent` or `review`. | `alert`, `review`, `none` |
| [`road-closure-final`](../profiles/road-closure-final.yaml) | One final result from the two checks. Rules only, no AI. A person's answer on an earlier step counts. | `publish`, `urgent`, `reject`, `review` |

`GET /v1/profiles/road-closure-final/graph` draws the chain as SVG or
exports it as DMN.

## Facts

Rules use facts about the place; the AI never sees them
([facts](../../docs/profile-format.md#facts)):

| Fact | Type | Data |
|---|---|---|
| Flood zone | `inside`, layer `gsi-flood-max` | River flood hazard zones (GSI, Japan) |
| Nearest evacuation site | `nearest`, layer `gsi-shelters-flood` | Designated evacuation sites for floods (GSI, Japan) |
| Way around | `detour`, by car or on foot | Valhalla routing on OpenStreetMap |

The GSI layers cover Japan. With `FACTS_MODE` `mock` (`pnpm dev`) every place
gets fixed answers, so the profiles run anywhere.

## Clients

- [FIWARE bridge](../../bridge/): connects an NGSI-LD context broker to
  Pointsman. It asks Pointsman when a `RoadRestriction` entity changes,
  writes the decision back to the entity, can create `Decision` and `Task`
  entities, and finishes a review when a person answers in the broker.
- The REST API and MCP work as for any profile.

## More

- [FIWARE demo storyboard](../../docs/fiware-demo.md)
- [Decision chains](../../docs/decision-chains.md)
