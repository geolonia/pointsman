# Changelog

Pointsman follows [semantic versioning](https://semver.org/). Before 1.0, a
minor release (0.x) may change the API, the profile format or the decision
log; the notes say how. Each release is a tag on `main`; its version is in
`package.json`, `openapi.yaml` (`info.version`) and `src/version.ts` (also
the MCP server's version), and, while the fact modules are released with
the engine, in each `packages/*/package.json` and module definition (a test
checks they agree). A deployment pins
the engine by commit in its config repository: to use a release, set
`ref` in `engine.json` to the commit of its tag
(`git rev-parse 'v<version>^{commit}'`, for example `v0.2.0`, which also
works for annotated tags).

## 0.14.2 (2026-10-24)

A fix for the token script (#202), and the documentation site at https://pointsman.net (#168, #169, #203).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.14.2`. No migration, no new secrets, no new permissions. Nothing changes in the engine or the connectors.

What changed:

- **`tokens.mjs rotate --keep-old`** printed a revoke command without `--config` and with `scripts/tokens.mjs` as the path. Run as printed in a config repository, it used the default configuration (and could revoke in another KV namespace, so the old token stayed valid) and a path that does not exist there. It now prints the path it was started with, `--local` or `--remote`, and `--config` as given, quoted for the shell.
- **Documentation site:** https://pointsman.net, with the docs under `/docs/` in English and Japanese (Starlight), a reference generated from the code (the engine version is added when the site is built, so a release changes no committed page), an AI and agents page with `llms.txt` and `llms-full.txt`, and an "About this site" page. The old address `geolonia.github.io/pointsman/` redirects there, keeping the path.

## 0.14.1 (2026-10-23)

The decision comment's train shows where the pull request really is (#200).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.14.1`. No migration, no new secrets, no new permissions.
- **For every deployment with the connector:** each run on an open, non-draft pull request now makes one GraphQL read (the review decision and the last 100 reviews), with or without the comment, because check runs draw the line too. A second one only in runs that approve or dismiss.

What changed:

- **Approved** comes from GitHub's own review decision (`reviewDecision`, what the merge box shows under the repository's rules): the train is at "approved" only when it is `APPROVED`, so an approval counts exactly where the ruleset counts it (also an AI review service's), and a drive-by approval never does. `CHANGES_REQUESTED`, `REVIEW_REQUIRED` and no review rule at all never show it. The caption says "approved by Pointsman on this commit" when the app's own latest review approves the head, "approved on this commit" when someone's does, else "approved".
- **Reviewed:** any review of the current head by someone other than the author (dismissed and pending ones don't count).
- **Merged and closed:** on `closed`, the comment gets one last update, without asking Pointsman: the train at "merged", or "closed without merging". A reopen runs as usual. The connector accepts `closed` events only when the comment is on.
- **Filled stations:** the train's station and every station before it are filled.
- **No names or review text** in the comment.
- **Fail safe:** if the reviews can't be read (an error, a rate limit, a push in between), the run goes on and the train stays where the last read put it on this head, else at "ready". After the app dismissed its own approval, a failed read never shows "approved".

## 0.14.0 (2026-10-23)

The GitHub connector can show its decisions inside the pull request: one comment, railway style (#195, #196).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.14.0`. No migration, no new secrets.
- The decision comment is off unless `GITHUB_CONNECTOR` sets `"comment": { "profiles": [...] }` (1 to 10 profiles, all from `profiles`). Keys of `"signals"` must be profiles in `profiles`; the config check refuses anything else. It needs the connector app's **Pull requests: Read and write**; the tokens ask for it only when the comment or an action is on.
- **For every deployment:** check-run titles now start with the signal, for example `🟢 approve` or `🔴 review (shadow)`. The action word, `(shadow)` and `external_id` stay, and the details now show the line and the switch.

What changed:

- **The decision comment:** one comment per pull request, updated in place, never a new one per decision. A table with each chosen profile's signal (always with a word), decision and rule; a track with stations (draft, ready, reviewed, approved, merged) and `▲` under the station where the pull request is (draft, ready, or approved while the app's own approval of the commit stands); and per profile a set of points: the facts read or missing, the AI answers, the track taken (`action ← rule N`, or the default) and the one not taken. It is found again only by its marker together with the app's own bot login; a person's or another app's comment with the marker is never touched. At most one write per run, only when the text changed. When nothing is left to show, an existing comment changes to a short neutral text.
- **Signals:** `GITHUB_CONNECTOR` → `"signals"` maps a profile's actions to red, yellow or green, optionally with a word (1 to 40 letters, digits, spaces and `, . ' ( ) -`). Defaults: `review` and `ask-person` red; `wait`, `in-progress`, `queue` and `retry` yellow; `approve`, `pass` and `done` green; any other action yellow "decided: <action>"; a decision a person still checks red.
- **Text art:** every rail starts at column 0 and is only box characters up to where its text starts (names, rules and reasons come after the rails), no emoji inside the art, at most 60 columns. In a font that draws box characters two columns wide the rails stay consistent; labels indented with spaces may drift.
- **No pull-request text** in the comment: profile and action names are checked names, fact reasons are reduced to plain characters, everything sits in code blocks. Test decisions and invalid answers never put anything in it (an approval they withdraw removes its row).
- Failures never stop the run or the actions: a refused write (for example no permission) is noted on the check runs and not tried again until the text changes; a busy or rate-limited GitHub (5xx, 429, a rate-limit 403) is tried again on the next run.
- The check-run summary now cleans the engine's fact reasons the same way, and fact names of 65 to 100 characters are counted (cut) instead of left out.

## 0.13.1 (2026-10-23)

The GitHub connector checks the engine's answer before it acts, and never acts on a test decision (#193).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.13.1`. No migration, no new secrets, no new permissions.

What changed:

- **The engine's answer is checked** once, for both the HTTP adapter and the service binding: `decision_id` (a UUID), `action` (an action name), `profile` and `ref` (the ones asked for), `profile_version`, `rule`, and `facts`, `review` and `test` when present must have the right shape. A decision kept for `once_per_head` is checked again before it is reused. An answer that does not fit is an invalid answer.
- **Test decisions are never acted on:** a decision with `test: true` (made with a test token) does nothing.
- **For an invalid answer or a test decision** the connector does nothing (no approve, `keep_approval`, comment, label or reviewer request), keeps nothing, sends nothing on through `requires` and schedules no recheck. In a profile that maps `approve`, an approval of the head commit is withdrawn, as for any decision that does not keep it. For a test decision the check run also says to use a token made without `--test`. The check run is neutral and says `invalid answer: nothing done` or `test decision: nothing done`; the log names the field, never its value. It is not retried; the next event asks again.
- A 2xx body that is not JSON (HTTP) or not an object (binding) used to be retried; it is now an invalid answer.

## 0.13.0 (2026-10-23)

The GitHub connector can keep its approval when a later decision says so, and a fact tells a profile whether the app already approved the head (#191).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.13.0`. No migration, no new secrets, no new permissions.
- The fact and `keep_approval` are opt-in. The last two changes below apply to every connector that maps `approve`: its own approvals are matched by the app's bot login (taken from the installation answer's `app_slug`), and a withdraw that fails now holds back that run's action.

What changed:

- **`github_app_approval`** (module `@pointsman/github`): `approved_head` (the app's latest deciding review is an approval of the current head; a dismissed one never counts), `approved_any`, `reviews`. Settings: `app` (the app's slug, required) and `bot_id` (its bot account id, recommended: without it, an app that later takes a deleted app's slug would match). Another bot, a person or a pending review never counts; unreadable reviews make the fact missing, and a push while they are read makes it `stale`. `approved_any`: the app's latest deciding review is an approval, on any commit.
- **`keep_approval`** (connector action kind): a later decision on the same head mapped to it keeps the app's approval and approves nothing. It is allowed only in a profile that also maps `approve`. Any other later action withdraws the approval, and so does a decision a person still checks. Give the keep rule the approve rule's other conditions (CI and so on). See *When the approval stays* in `docs/github-connector.md`.
- **The connector's own approvals** now count only reviews by the app's own bot (`<slug>[bot]`, the slug from the installation), not any bot's review with the marker.
- **Withdrawing is more careful:** a run that stopped after approving is matched to its review on GitHub before withdrawing, so the approval is dismissed rather than forgotten. A withdraw that fails, or whose lookup fails, is shown on the check run, the decision's own action waits (`skipped`), and the record stays open so the next run tries again.

## 0.12.0 (2026-10-23)

An internal call between the GitHub connector and the engine (#188): where both run in the same deployment, the connector no longer needs a token.

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.12.0`. No migration. Nothing changes unless you opt in.
- **To use the internal call on Cloudflare:** set `INTERNAL_CLIENT` on the engine (the client name and its profiles, for example `{"client":"github-connector","profiles":["pr-docs-check","workflow-check"]}`; use the name of the connector's current token so its decision history carries on), deploy the engine, then give the connector a service binding `POINTSMAN` to the engine Worker with `entrypoint: "InternalEngine"`, remove `POINTSMAN_URL` and deploy the connector. Once decisions arrive, revoke the connector's token (`tokens.mjs revoke --hash <hash>`) and delete its secret (`wrangler secret delete POINTSMAN_TOKEN`). See *Internal call* in `docs/github-connector.md`.

What changed:

- **Engine client port:** the connector reaches the engine through one interface (`decide`), with two adapters: HTTP with a token (the default, any runtime) and a Cloudflare service binding. An in-process adapter (connector and engine in one process) fits the same interface and is planned.
- **`InternalEngine`** (the engine Worker's RPC entrypoint): no URL, so only Workers in the same account with a binding can call it. Every internal call runs as `INTERNAL_CLIENT`, never as a test token, and goes through the same checks as the HTTP route after the token: profile scope (a profile outside it is refused the same way), idempotency per client, the decision log under that client, decision-log facts limited to its own decisions. Trust is account-wide: anyone who can deploy Workers in the account can decide as that client. See *Internal calls* in `docs/adapters.md`.
- **Fail loud:** the connector answers 500 when neither the binding nor URL and token are set, or when the binding and `POINTSMAN_URL` are both set; the engine refuses internal calls (`not_configured`) without `INTERNAL_CLIENT`. A `POINTSMAN_TOKEN` left next to the binding logs a warning until it is deleted.
- A 2xx answer from the engine whose body is not JSON is now retried instead of only logged.

## 0.11.0 (2026-10-23)

`github_bump` checks the lockfile's own version steps and every workspace (#186). The fields stay the same; the fact now passes less often.

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.11.0`. No migration, no new secrets, no new permissions.
- A bump pull request may now take up to 51 more GitHub requests (the head tree and each `package.json` the pull request does not change), only when everything else already says dev only. They share the existing 5-second limit for GitHub reads; in a repository with close to 50 `package.json` files they may not fit, and the fact is then missing.

What changed:

- **`semver`** is the largest step over every version a lockfile changes too, transitive ones included: each removed version is paired with the added version of the same package at the same place. A package added or removed without a counterpart, more than one version of a package on one side, a downgrade or pre-release, a change of `lockfileVersion`, `overrides`, `settings` or another unknown section, or a version line the patch does not place gives `none`. npm v1 and v2 lockfiles give `none`.
- **`dev_only`** reads every `package.json` at the head commit: false when any of them has a bumped package, or a package the lockfile changes, in `dependencies`, `optionalDependencies` or `peerDependencies`, or bundles it. Where the lockfile marks dev packages (`package-lock.json`, pnpm v6), every changed package must carry the mark. pnpm v9 has no marks, so only the changed package and the one above it are checked. The fact is missing when the tree is truncated, has more than 50 `package.json` files, or one is over 512 KB.

## 0.10.0 (2026-10-23)

A new fact type for dependency bumps (#180), and CodeRabbit skips release PRs (#181).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.10.0`. No migration, no new secrets, no new permissions.
- The engine now also reads `https://registry.npmjs.org/` (publish times, without the GitHub token) when a profile uses `github_bump`.

What changed:

- **`github_bump`** (module `@pointsman/github`): whether a pull request only bumps npm dependency versions, as a Dependabot pull request does, in `package.json`, `pnpm-lock.yaml` or `package-lock.json` (a changed `.npmrc` counts as a registry change). Fields: `applies`, `only_manifests`, `version_only`, `semver` (`major`, `minor`, `patch` or `none`; 0.x versions shifted one place, as npm's caret does), `dev_only`, `registry_changed`, `manifest_lines` and `release_age_days` (the youngest new release, transitive ones included). Anything it cannot read makes the fact missing; anything it does not understand gives the stricter value. See *Fact types* in `docs/profile-format.md`.
- **`github_pr.all_commits_verified`** on a Dependabot pull request now also requires every commit to be authored by `dependabot[bot]` and signed by GitHub, so a person's commit on a Dependabot branch fails it.
- **CodeRabbit** skips pull requests whose title contains `Release 0.` (this repository's `.coderabbit.yaml`), so a profile can approve release PRs on facts alone.

## 0.9.2 (2026-10-23)

A fix for the connector's `once_per_head` (#178).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.9.2`. No migration, no new secrets, no new permissions.

What changed:

- CodeRabbit writes its summary into the pull request's description. The connector now leaves that block out of the description it sends. So CodeRabbit's edit no longer asks a `once_per_head` profile again on the same commit (one model call less), and CodeRabbit's text no longer reaches the model.
- Only whole blocks are left out. Without a block, the description is sent exactly as the author wrote it.

## 0.9.1 (2026-10-23)

A fix for the connector's `diff` on private repositories (#175).

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.9.1`. No migration, no new secrets.
- If a profile uses `diff` on a private repository, give the connector app **Contents: Read-only**. Without it, the profile is asked without the diff.

What changed:

- GitHub gives a private repository's diff only to a token that may read its contents. With a profile that uses `diff`, the connector's token now also asks for `contents: read` (never more than the app has).
- A diff GitHub refuses (403, 404) no longer ends the run: the profile gets an empty diff with `diff_truncated: true`, the later profiles are still asked, and a `once_per_head` decision made so is not kept. A 403 for a rate limit is tried again later. The head is read again after the diff either way.

## 0.9.0 (2026-10-23)

Chains of profiles in the GitHub connector, and a fact for release pull
requests (#171, for #149): the connector can run a profile that builds on
another (for example a risk class with AI questions, then a next step with
rules only), and `github_release` says whether a pull request only moves a
version.

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.9.0` as usual. A module pinned with a version (`…@0.8.0`) must be pinned to `0.9.0`, or the build stops.
- No database migration and no new secrets. Without `runs` in `GITHUB_CONNECTOR`, the connector works as before.

What changed:

- GitHub connector: optional `runs` in `GITHUB_CONNECTOR`, by profile ([docs/github-connector.md](docs/github-connector.md#chains)):
  - `requires` sends the decision of an earlier profile of the same run as `decisions`.
  - `skip_drafts`: the profile is not asked for drafts.
  - `once_per_head` reuses a decision until the commit, title, description or settings change. `rerun` lists actions after which it is asked again. A decision is kept only after its action and check run are done.
  - `diff` adds the pull request's diff to the state, cut to a limit (`diff_truncated`).
  - `recheck` asks again after some minutes while the decision waits, at most `max` times per commit. With `once_per_head`, the waiting actions must also be in `rerun`.
- `github_release` in `@pointsman/github` ([docs/profile-format.md](docs/profile-format.md#github-pull-requests)): whether a pull request only moves a version, with `version_only`, `from`, `to` and `level`.
  - Changed files may only be the changelog (lines added), lines in `version_files` that set the version (in a `package.json` only its `"version"` line), and lines in `version_text_files` that name it. The same version pair everywhere, going up.
  - `version_files` is required. The fact says nothing about who made the change: use it with `github_pr`.

## 0.8.0 (2026-10-23)

Facts for AI review services and from the decision log (#148, from #165,
#166 and #167): Copilot's and CodeRabbit's state on a pull request, the
pull request author's CodeRabbit budget, the author's waiting pull requests,
and the spend on paid reviews. Facts can now read the engine's own decision
log, read only and limited to the asking client.

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.8.0` as usual. A module pinned with a version (`…@0.7.0`) must be pinned to `0.8.0`, or the build stops.
- Apply the database migration `0008_log_facts.sql` (an index for facts that read the log).
- To use the CodeRabbit facts: add `@pointsman/coderabbit` to `modules.facts` and set `FACTS_CODERABBIT: on`. It reads GitHub with the GitHub module's settings (`FACTS_GITHUB` `token` or `app`), so no new secrets. The GitHub permissions are the same as before.
- A fact module that gives `null` in a field its type does not allow now makes that fact missing (`error`). The modules in this repository did not.

What changed:

- `github_copilot` (#165): `requested`, `reviewed_head`, `approved_head`, `reviews`, from Copilot's own bot account only. The GitHub snapshot also reads reviews, conversation comments, the head's status history, and review requests and threads (one GraphQL query, read only); other modules can share it.
- `@pointsman/coderabbit` (#166), type `coderabbit`: whether CodeRabbit runs, reviewed or approved the head, `rebase_only`, open threads, findings outside the diff, billable files. Only CodeRabbit's own account counts; text someone else edited makes the fact missing ([docs/profile-format.md](docs/profile-format.md#coderabbit-reviews)).
- Facts from the decision log (#167): a lookup gets the decision's context with a read-only view of the client's own decisions of profiles its token may use (none for a test token, [docs/modules.md](docs/modules.md#facts-from-the-decision-log)). New types `coderabbit_budget` (counted by the pull request's author, never by whoever posts a command), `coderabbit_queue` and `coderabbit_spend` (pay decisions count as reservations).
- The engine refuses `null` in a fact field unless the type's case rules allow it, so a blocking rule never silently fails to match.

## 0.7.0 (2026-10-22)

The GitHub connector can act on decisions (#147, from #162): a comment,
labels, a review request or an approval, each only where a deployment maps a
profile's decision action to it. Without that mapping the connector stays in
shadow mode and writes only its neutral check runs.

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.7.0` as usual. A module pinned with a version (`…@0.6.0`) must be pinned to `0.7.0`, or the build stops.
- The connector now asks Pointsman anew on every run, also when a run is tried again after an error (before, a retry got the decision already logged). In shadow mode too: a few more decisions in the log when GitHub or Pointsman was busy.
- Nothing else is required. To switch actions on: an `"actions"` map in `GITHUB_CONNECTOR`, the connector app's permission Pull requests: Read and write, and for `approve` a ruleset that dismisses stale approvals ([docs/github-connector.md](docs/github-connector.md#actions)).
- No database migration.

What changed (#162, [docs/github-connector.md](docs/github-connector.md#actions)):

- `GITHUB_CONNECTOR` takes an optional `"actions"` map: per profile, a decision action to one of `comment`, `label`, `request_reviewer`, `approve`. Without it nothing changes (shadow mode).
- Each action at most once per head commit, with a record written before it and a trace check after a stop; nothing while a person checks the decision; refused actions are shown on the check run and not repeated for that commit.
- `approve` only on the decided commit (read again right before), never for drafts or forks; the connector dismisses its own approvals of older commits after a push, and withdraws one when a later decision on the same commit no longer approves. The ruleset must dismiss stale approvals.
- With actions on, the connector's token asks for pull requests: write (the app must have it).

## 0.6.0 (2026-10-22)

Connectors as modules (#149): the FIWARE bridge and a new GitHub connector
are modules, like the fact modules. A connector runs inside the Pointsman
Worker or in its own Worker, and reaches the engine only through its public
API with its own token. The GitHub connector shows decisions about pull
requests as check runs (shadow mode). From #159 and #160.

For deployments:

- Move `ref` in `engine.json` to the commit of `v0.6.0` as usual. A module pinned with a version (`…@0.5.0`) must be pinned to `0.6.0`, or the build stops.
- `@pointsman/facts-github` is now `@pointsman/github`; the old name still works in `engine.json`. New decisions record the new name in `versions.modules`, older ones keep the old name.
- With `FACTS_GITHUB: app`, the facts ask GitHub for a read-only token with only the permissions they use (of those the app has). Nothing to change; a facts app with write permissions now gets a read-only token anyway.
- To run the FIWARE bridge inside the Pointsman Worker: `"connectors": ["@pointsman/fiware"]` in `engine.json` and its settings on the Pointsman Worker ([bridge/README.md](bridge/README.md#run-it)).
- To run the GitHub connector: a second Worker from [connectors/github/wrangler.jsonc](connectors/github/wrangler.jsonc), and two GitHub Apps ([docs/github-connector.md](docs/github-connector.md#setting-it-up)).
- No database migration.

Connectors as modules (#149, #118):

- A module can have the role "connector" besides "facts" ([docs/connectors.md](docs/connectors.md)). A connector brings cases in and carries results out, only through the public API with its own token, and lists the actions it can carry out. The interface is in `@pointsman/module-api` (`connector.ts`).
- The FIWARE bridge is the module `@pointsman/fiware` (`packages/fiware`). It runs inside the Pointsman Worker (`/connectors/fiware/notify` and `/reviews`, when listed in `engine.json` `"modules": { "connectors": [...] }`) or in its own Worker (`bridge/`, as before). Behaviour and settings are unchanged; inside the Pointsman Worker it needs no `POINTSMAN_URL`. `bridge/src/bridge.ts` still exports the bridge for Workers that build it from that path.
- The bridge compares its secret without `crypto.subtle.timingSafeEqual` (Cloudflare only); still in constant time.
- `engine.json` with `"modules"` but without `"connectors"` chooses no connector; config repositories need no change.

GitHub connector (#147), in shadow mode ([docs/github-connector.md](docs/github-connector.md)):

- The module `@pointsman/facts-github` is now `@pointsman/github`, with two roles: facts, and a connector. `engine.json` still accepts the old name. Decisions record the module under its new name in `versions`.
- The connector runs in its own Worker ([connectors/github](connectors/github)) with a GitHub App that can write check runs. It takes pull-request webhooks (signature checked, replays dropped), runs one pull request at a time (a Durable Object per pull request), asks Pointsman with the configured profiles and shows each decision as a `neutral` check run, created once per profile and head commit with a record written first. It does nothing else on GitHub yet.
- GitHub facts with an app (`FACTS_GITHUB: app`) now ask for a down-scoped token: only the permissions the facts use, as read only. Use a separate read-only app for the facts; an app can read checks on private repositories, a fine-grained token cannot.

## 0.5.0 (2026-10-22)

Fact modules (#145) and a core without Cloudflare (#153): the engine no
longer has its fact providers built in. GSI, Valhalla and GitHub are
modules (packages in this repository), and each deployment chooses the
modules it uses. Profiles, fact names and settings stay the same;
decisions gain a `versions` field.

### Added

- Fact modules (#154, #155): see [docs/modules.md](docs/modules.md). The
  packages `@pointsman/module-api` (the interface and the capabilities
  `inside`, `nearest`, `detour`), `@pointsman/facts-gsi`,
  `@pointsman/facts-valhalla` and `@pointsman/facts-github`.
- `engine.json` `"modules": { "facts": [...] }` chooses the modules, with
  an optional `@version` that must match. The build bundles only those;
  the profile validator, test cases and explanations use the same list.
  Without `modules`, every module is chosen (as before).
- Each decision records `versions`: the engine version and the modules
  that answer its facts (migration `0007_versions.sql`, `Versions` in
  `openapi.yaml`). Decisions made before have none.
- A fact field can be declared a probability (0 to 1); the engine refuses
  values outside.
- `pnpm check:core` (part of `pnpm typecheck`): the core compiles without
  Cloudflare's types (#153). The adapter boundaries and what each adapter
  must guarantee: [docs/adapters.md](docs/adapters.md).

### Changed

- The fact part of `schema/profile-v1.schema.json` is generated from the
  modules. A setting of another fact type now says so (`"layer" is not a
  setting of this fact type`) instead of `must NOT be valid`.
- A `FACTS_*` setting that no chosen module reads is a config error. Each
  module sees only its own settings.
- A profile version whose facts no chosen module answers fails before the
  model is asked (a config error), instead of after it.
- Detours are answered by `@pointsman/facts-valhalla`; the GSI provider no
  longer forwards them. With `FACTS_MODE: gsi` and no
  `FACTS_ROUTING_URL`, detours are unavailable, as before.
- The decision logic moved from `src/app.ts` to `src/decide.ts`, and the
  Cloudflare stores to their own files (`log-d1.ts`, `auth-kv.ts`,
  `profiles/store-kv.ts`) (#153).

### For deployments

- Move `ref` in `engine.json` to the commit of `v0.5.0` as usual. Without
  `"modules"`, nothing else changes.
- Optional: add `"modules"` to `engine.json` to bundle only what your
  profiles need. Then also remove the `FACTS_*` settings and secrets of the
  modules you leave out, or the engine refuses every request (a config
  error). The scripts read `engine.json` from the config repository's
  root, so the workflows need no change. The config repository template
  lists all three modules.
- The deploy applies migration `0007_versions.sql` as usual.

## 0.4.0 (2026-10-22)

Facts from GitHub (#135, #141): Pointsman reads a pull request itself, so
rules can use its state (draft, changed files, required checks, signed
commits, who pushed, code owners, repository properties, changed GitHub
Actions files). The client names only the pull request, `{ repo, number,
head }`; it cannot claim "docs only" or "the checks passed". Off unless a
deployment turns it on.

### Added

- GitHub fact types `github_pr`, `github_paths`, `github_checks` and
  `github_property` (#135): see
  [GitHub pull requests](docs/profile-format.md#github-pull-requests). All
  facts of a decision come from one read of the pull request; when its head
  commit is not the `head` the client sent, every GitHub fact is missing.
- `github_pr` fields `pushed_by_author` (who pushed the commits, from the
  repository's activity list, up to 500 entries, #142) and
  `author_sole_code_owner` (by the base branch's `CODEOWNERS`, with bounded
  work, #143).
- GitHub fact type `github_workflows` (#141): reads and parses the GitHub
  Actions files a pull request changes and counts known unsafe patterns
  (pwn requests, untrusted input in scripts, write permissions, unpinned
  actions, persisted credentials and more): see
  [GitHub workflows](docs/profile-format.md#github-workflows).
- Settings `FACTS_GITHUB` (`off`, `mock`, `token`, `app`),
  `FACTS_GITHUB_TOKEN`, `FACTS_GITHUB_APP_ID`,
  `FACTS_GITHUB_APP_PRIVATE_KEY` and `FACTS_GITHUB_IGNORE_CHECK`. Read
  permissions only; the token and the key are never logged.
- Example profiles `pr-docs-check` (is a light review enough?, #135, #140)
  and `workflow-check` (are the workflow changes safe?, #141), with test
  cases.
- Explanations (`explain_profile`) and test cases cover GitHub facts.
- Threat model: GitHub as a fact source (#138, #144).

### Changed

- Facts can be missing for two more reasons: `no_pr` (no pull request at
  the fact's path) and `stale` (GitHub has another head commit), also in
  the API (`Fact.reason` in `openapi.yaml`): clients that check the reason
  must accept them. Rules that test `facts.<name>.reason` may want to
  handle them.
- `FACTS_MODE` and `FACTS_GITHUB` are separate: `FACTS_MODE: mock` does
  not answer GitHub facts, and `FACTS_GITHUB: mock` does not answer
  spatial ones.
- Config repository template: AGENTS.md says how to make and revoke a
  short-lived replay token; `actions/setup-node` 7.1.0; Dependabot also
  watches the template's workflows (#136).

### For existing deployments

Move `ref` in `engine.json` to the commit of `v0.4.0` as usual. Nothing
changes until `FACTS_GITHUB` is set. To turn GitHub facts on, set the
secret first, then the setting: with `FACTS_GITHUB: "token"` and no
`FACTS_GITHUB_TOKEN`, the engine refuses every request (a config error).
It also refuses every request when another `FACTS_GITHUB_*` setting does
not fit `FACTS_GITHUB` (for example `FACTS_GITHUB_TOKEN` without
`"token"`), or `FACTS_GITHUB` has another value than `off`, `mock`,
`token` or `app`. See [docs/deployment.md](docs/deployment.md), step 7.

## 0.3.0 (2026-10-21)

Tools for writing and changing profiles, with an AI assistant or by hand
(#128): put a profile into plain sentences, run example cases against it,
and try a changed policy on the decisions already made. The guide
[docs/authoring.md](docs/authoring.md) puts them together.

### Added

- Explain a profile as plain sentences, in English or Japanese, for the
  people who approve it: `GET /v1/profiles/{id}/explain` (JSON, or Markdown
  with `?format=text`), the MCP tool `explain_profile`, and
  `scripts/explain-profile.mjs` for a draft file. The rules are read with the
  engine's own parser (#129).
- Test cases: examples with the action a person expects, in their own
  files (`cases/<id>.yaml`). Cases with answers check the rules without a
  model; cases with a real request are answered by a deployed profile's
  model and facts (`--url`, test token), and the rules of the file are
  applied. `scripts/test-profile.mjs`; the examples have cases in
  `examples/cases/`, run by CI (#131).
- Replay a changed policy on the newest logged decisions of a version:
  how many actions would change, how many decisions would go to a person,
  and how often the new rules give the answer a person gave. No model is
  called; only the policy may change. `POST /v1/profiles/{id}/replay`, the
  MCP tool `replay_profile`, and `scripts/replay-profile.mjs` for a draft
  file (#132).
- Authoring guide [docs/authoring.md](docs/authoring.md), and
  `AGENTS.md` / `CLAUDE.md` in the config repository template, so an AI
  assistant in a config repository follows the same steps (#133).
- Website: a FAQ (#124), and a shorter menu (#127). Examples by use case:
  `examples/README.md` and one README per topic, with a section on the
  website (#126).

### Changed

- Test tokens may also read `GET /v1/profiles/{id}/explain` (it reads no
  decisions). A replay needs a token that is not a test token, and that may
  use the profile and every profile it requires.
- Error codes: `invalid_policy` (400) and `not_policy_only` (409), from
  the replay.
- MCP lists two more tools, `explain_profile` and `replay_profile`.
- `DecisionLog` has a new method, `recent` (only matters for code that
  implements its own decision log).

### For existing deployments

The config repository template has new files. A config repository made from
an older template does not get them by moving `engine.json`; copy them from
`template/config-repo/` when wanted, after `engine.json` points to 0.3.0
(the new workflow step runs a script that 0.2.0 does not have):

- `.github/workflows/validate.yml`: the step that runs `cases/` when the
  folder exists.
- `AGENTS.md` and `CLAUDE.md`: the steps for an AI assistant.

Every token that is not a test token can now replay the profiles in its
scope. A replay lists up to 50 changed decisions of a profile from every
client, with their ids and refs, as the review queue does. A token already
sees the decisions of the profiles in its scope, but check that each token's
scope is what you want.

## 0.2.0 (2026-10-21)

### Added

- API tokens can expire: `scripts/tokens.mjs create|rotate --expires <when>`
  (a duration such as `90d`, or a date). The Worker refuses an expired token
  like an unknown one (401), and KV deletes the key then. `rotate` asks for
  `--expires` or `--no-expiry` when the old token had an expiry; `list`
  shows the expiry. The README has a rotation procedure without downtime
  (#121).
- Detour facts name the date of the routing data in `source`, like the GSI
  facts: `… routed with Valhalla (routing data 2026-10-17 時点)`, from the
  routing server's `GET /status` (`tileset_last_modified`), kept for a day.
  `日付不明` when the server cannot say or answers more than a second after
  the routes; a failed `/status` is asked again after five minutes. It is one
  more call to the routing server (with its API key), about once a day per
  Worker instance (#120).
- Example profile `road-restriction-check` v4 looks up the way around by
  car (`drive`) for a closed section, as context: no rule reads it (#122).

### Changed

- The `source` text of detour facts is longer (the date is added). Code
  that compares it with the old fixed text must match the start instead.
- Dependencies: wrangler 4.149, zod 4.6.6, @cloudflare/vitest-plugin 1.4,
  @cloudflare/workers-oauth-provider 1.2.3; actions/setup-node 7.1.0.

## 0.1.0 (2026-10-21)

The first release: what the proof of concept and the FIWARE demo built.

### Decisions

- `POST /v1/decide/{profile}`: typed questions (yes/no, choice, score)
  answered by a model, with probabilities; a policy of rules turns the
  answers into one action. A small condition language, checked when a
  profile is loaded, never run as code.
- Profiles in YAML with a JSON Schema, validated in CI, published
  write-once per version from a private config repository (template
  included).
- Facts from public data in the rules: river flood zones and the nearest
  evacuation site (GSI), the way around a closed road by car or on foot
  (Valhalla on OpenStreetMap). The model never sees them; each fact names
  its source, and `facts.<fact>.reason` says why one is missing.
- Decision chains: a profile `requires` earlier decisions about the same
  `ref`, read from the decision log by id. A final decision can be rules
  only. A person's answer on an earlier step counts, and a final decision a
  person resolved is never replaced. An optional earlier step that was based
  on an older version of another step in the same request is left out.
- `GET /v1/profiles/{id}/graph`: the chain as JSON, SVG (a left-to-right
  flow) or DMN 1.3 with DMNDI for DMN tools.

### People in the loop

- A review queue for decisions below the thresholds, resolved through the
  API (`POST /v1/reviews/{id}/resolve`) or the FIWARE bridge; the final
  answer is sent, signed, to the request's `callback_url` if it gave one.
- Feedback and corrections next to the answers; accuracy per profile
  version and `GET /v1/stats/{profile}`.

### Access

- Per-client API tokens, limited to profiles; test tokens check profiles
  without logging decisions.
- MCP server: `list_profiles`, `decide` and `get_decision` for API tokens;
  people log in with GitHub and can also correct decisions
  (`submit_feedback`).
- OpenAPI description of the REST API.

### Models

- Cloudflare Workers AI (`clef-flash`, `clef`), optionally through AI
  Gateway, with fallback models; an HTTP adapter for your own model server
  (for example a local Strands Decider); a mock model for development.

### Integrations

- FIWARE bridge (`bridge/`): NGSI-LD notifications in, decisions written
  back to the entity, with `Decision` and `Task` entities (datamodels.jp
  models), reviews resolved in the broker or by work orders from other
  apps, chains of routes, and an optional queue for reliable delivery.
- GitHub Actions: issue triage (`actions/triage`) and a deploy watch that
  stops stuck CloudFormation deploys (`actions/deploy-watch`).

### Security

- Threat model (`threat-model.md`) from the Alpha-Omega pilot, and
  `SECURITY.md` for reporting.
