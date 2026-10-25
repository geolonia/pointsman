# Fact modules

Facts are looked up by **fact modules**, not by the engine itself. The engine knows only the module interface and a few shared fact types; each deployment chooses the modules it needs. This keeps the engine small and lets another deployment use other data sources, without changing the engine.

Three roles (#145):

| Role | What it does | Examples |
| --- | --- | --- |
| Engine | Takes a case, asks the model, applies the rules, logs the decision | `src/decide.ts`, `src/policy.ts`, the decision log |
| Fact module | Looks something up during a decision, inside the engine | GSI flood zones and shelters, Valhalla detours, GitHub pull requests |
| Connector | Brings cases in and carries results out, through the public API | the FIWARE bridge (`@pointsman/fiware`), `actions/triage` |

Connectors are described in [connectors.md](connectors.md). A module can have both roles. This page is about fact modules.

## Modules in this repository

| Module | Answers | Settings |
| --- | --- | --- |
| `@pointsman/facts-gsi` | `inside` and `nearest` for the layers `gsi-flood-max` and `gsi-shelters-flood` (Japan) | `FACTS_MODE` |
| `@pointsman/facts-valhalla` | `detour`, from a Valhalla routing server | `FACTS_MODE`, `FACTS_ROUTING_URL`, `FACTS_ROUTING_API_KEY` |
| `@pointsman/coderabbit` | `coderabbit`, read through the GitHub module's snapshot | `FACTS_CODERABBIT`, and the GitHub module's `FACTS_GITHUB` settings |
| `@pointsman/github` | `github_pr`, `github_paths`, `github_checks`, `github_property`, `github_workflows`, `github_copilot`, `github_app_approval`, `github_release`, `github_bump`; also a connector ([github-connector.md](github-connector.md)) | `FACTS_GITHUB`, `FACTS_GITHUB_TOKEN`, `FACTS_GITHUB_APP_ID`, `FACTS_GITHUB_APP_PRIVATE_KEY`, `FACTS_GITHUB_IGNORE_CHECK` |

The settings and the facts are described in [profile-format.md](profile-format.md#facts). Each module is a package in this repository (pnpm workspace): `packages/facts-*`, with `src/definition.ts`, `src/index.ts` (the entry) and its provider. The interface and the capabilities are the package `@pointsman/module-api` (`packages/module-api`). The packages are not published to npm; the engine bundles them from this repository. For now they are released with the engine and have its version. The scripts load the definitions as TypeScript through pnpm's links to `packages/`, so the engine checkout needs pnpm's default layout (`pnpm install`, not a hoisted or copied install).

## Choosing modules

A deployment lists its modules in `engine.json`, next to the engine version:

```json
{
  "repository": "geolonia/pointsman",
  "ref": "<engine commit>",
  "modules": {
    "facts": ["@pointsman/facts-gsi", "@pointsman/facts-valhalla", "@pointsman/github@0.17.0"]
  }
}
```

- A version after `@` is checked against the module in the engine; a different one fails the build and the validation.
- Without `modules`, every module in this repository is chosen (as before modules existed). An empty list chooses none: then profiles cannot have facts.
- `pnpm build` writes `generated/modules.ts` from the list, so the Worker bundles only these modules' providers. The bundled example profiles (`PROFILE_SOURCE: bundled`) are those the chosen modules can answer.
- The profile validator, the test cases and `explain-profile` use the same list. A profile is valid only together with the modules it uses: a fact type or setting no chosen module answers is an error.
- Each module reads only the settings it lists; a `FACTS_*` setting that no chosen module reads stops the Worker (a config error), so a module left out of the list is noticed.
- Removing a module: published profile versions keep working only with their modules. A decision with a profile version whose facts no chosen module answers fails (a config error, before the model is asked), so publish new versions without those facts first.

The scripts read `engine.json` from the current directory, else from where pnpm was started, so in a config repository `node engine/scripts/validate-profiles.mjs profiles` and `pnpm --dir engine build`, both run from its root, use its `engine.json`. `POINTSMAN_ENGINE_JSON` names another file.

## Capabilities and module types

Fact types come in two kinds.

**Capabilities** are a small set of shared types with fixed fields, defined by the engine in `packages/module-api/src/capabilities.ts`: `inside`, `nearest` and `detour`. A profile asks for `detour` and gets `extra_m`, whatever module answers. The deployment chooses the module, as it chooses layers. A new capability is a pull request to this repository, reviewed like code (decided 2026-10-22, #145).

- Each capability is answered by one chosen module. `inside` and `nearest` can be shared by layers: each module names its layers, and each layer is answered by one module. A layer that no module names goes to the type's only module, if there is just one (its mock answers any layer; its real provider refuses an unknown one as `unavailable`).
- A module that implements a capability is named after its service, for example `facts-valhalla`; another routing service would be another module.

**Module types** are the module's own. They are named after their source (`github_pr`), or get the publisher's namespace (`<publisher>/<type>`, for example `example/confidence`), so no module takes a generic name by accident. Two chosen modules cannot define the same type.

## The module interface

A module has two parts (`packages/module-api/src/api.ts`):

- **Its definition** (`FactModule`): name, version, roles, the capabilities it answers, its own fact types, the missing reasons it can give, and the settings it reads. The definition is data and small pure functions, readable under Node.js (the validator reads it), so it uses only TypeScript syntax Node can strip.
- **Its entry** (`FactModuleEntry`): the definition plus `create(env, runtime)`, which reads the module's settings and returns a provider, `undefined` when the module is off, or throws `ConfigError` for settings that do not fit together. `runtime` gives a shared cache when the runtime has one ([adapters.md](adapters.md#cache)).

A fact type (`FactTypeDef`) declares:

| Part | What it is |
| --- | --- |
| `fields` | Each field's kind (`number`, `string`, `boolean`). `display: true` for text for people and maps, which rules cannot use. `probability: true` for a number from 0 to 1. |
| `input` | How `at` is read from the request state (for example a GeoJSON geometry, or a pull request), and the missing reason when it is not there (`no_location`, `no_pr`). |
| `settings`, `required` | The fact's own keys in a profile, as JSON Schema, and the ones it needs. The profile schema is built from them. |
| `query` | The query the provider gets. |
| `timeoutMs` | How long a lookup may take. |
| `mock` | The values of the mock provider (`FACTS_MODE: mock`, `FACTS_GITHUB: mock`). |
| `words` | Sentences in English and Japanese for [explanations](profile-format.md#explain). |
| `cases` | What a [test case](profile-format.md#test-cases) may give for the fact. |

The provider has one function, `lookup(query, signal, scope)`. It returns field values and a source, or throws. A value that could not be read makes the whole fact missing, never a guess: throw `FactUnavailableError`, or `FactMissingError` with a reason the module declares (for example `stale`); any other error is recorded as `error`.

### Facts with a probability

A field can hold a probability or a confidence, for example a geocoder's confidence or a classifier's score. Declare it with `probability: true`; the engine then refuses a value outside 0 to 1, and rules test it like any number (`facts.place.confidence >= 0.9`). The line between facts and AI questions is not "certain or probable": it is who computes the value (code or a chosen service, or a language model) and who controls its input.

### Values and missing facts

Every field has a value, or the whole fact is missing. A field may be
`null` only where the type's `cases` allow it: a field in `nullable`, or,
for types whose first field says whether something was found, an
`optional` field or one whose `absent` value is `null` when nothing was
found. The engine refuses any other `null` and records the fact as missing
(`error`). This matters for safety: a rule with a field that has no value
never matches, so a module that gave `null` could make a blocking rule
silently not match.

A value that does not apply is still a value: Copilot that never reviewed
gives `reviews: 0`, not a missing fact.

### Facts from reviews and comments

Anyone can write a comment, and a login can look like a service's. A fact
read from reviews, comments or commit statuses accepts only the real
author: the service's bot account, by login and account id (GraphQL
leaves out the `[bot]` of the login; both forms are the same account).
Text about one head commit counts only when it is tied to that commit.
CodeRabbit's billable count must name the commit, and, when the push time
is known, must also be edited after the push. Reviews and commit statuses
belong to a commit already. `@pointsman/github`
reads reviews, comments, the head's status history, review threads and
review requests into the decision's snapshot; another module can read the
same snapshot (`snapshotOf`, with the GitHub module's settings from
`githubAuthFrom`), so all GitHub-based facts of a decision describe the
same moment and read GitHub once.

### Facts from the decision log

A fact can also read the engine's own decision log, for example how many
of an author's pull requests wait, or how much was spent in a time window.
The engine gives each lookup a context (the fourth argument of `lookup`,
`DecisionContext` in `packages/module-api/src/api.ts`): the client, the
profile being decided, the time, and `log.recent({ profiles, since,
limit })`. That log is read only and limited the same way as everything
else a client sees:

- only decisions of the client that asks (its token), never another
  client's;
- only of profiles its token may use; others are left out silently;
- never discarded decisions;
- at most 1,000 decisions per read (`MAX_LOG_READ`). A fact that needs all
  of them must be missing when a read is full.

A test token's decisions are not logged, and it reads none: its lookups
get no context, and such facts are missing (`@pointsman/coderabbit` gives
`no_log`). A fact reads the log as it is at the moment of the read, not as
a snapshot from the start of the decision: the decision itself is not in
it yet; another decision logged in between may or may not be seen; and two
decisions made at the same time can both miss each other.

What earlier decisions are found by is up to the module. The CodeRabbit
facts write the pull request and its author into their own values (display
fields, not for rules), and read them back from the client's decisions of
the same profile: the queue's history and the spend under the same fact
name; the budget readings (the queue's too) by their fields under any fact
name (so a profile that
renames its budget fact keeps the readings it logged, though not which
reviews other pull requests took, `taken_by_other_pr`, which is read by
fact name).

### Not yet

- Showing a fact to the model (`show_model` per fact, #145): the model does not see facts ([profile-format.md](profile-format.md#facts)).
- Modules from outside this repository. A module from npm would have to ship JavaScript (Node does not strip types inside `node_modules`), and the catalog in `scripts/lib/modules.mjs` lists only this repository's packages. Until someone outside contributes one, modules live here.

## Versions in the decision log

Each decision records the engine version and the modules that answered its facts, with their versions:

```json
"versions": { "engine": "0.17.0", "modules": { "@pointsman/github": "0.17.0" } }
```

Decisions made before modules have no `versions`.

## Trust

A fact module runs inside the Worker, next to its secrets: a module from someone else needs a review before a deployment chooses it. A connector uses only the public API; in its own Worker it is safer to accept, inside the engine Worker it needs the same review ([connectors.md](connectors.md#trust)).
