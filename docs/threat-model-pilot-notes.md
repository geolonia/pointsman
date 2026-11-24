# Threat-model pilot: lessons from the first run

Date: 2026-10-16. The first draft of [`threat-model.md`](../threat-model.md)
(with `threat-model.yaml` and `threat-model.json`) was produced with the
Alpha-Omega `threat-model` plugin, version 1.2.1 at commit `192fd60`
(https://github.com/alpha-omega-security/threat-model, MIT), in draft-first
mode: the agent wrote version 1 from the public artifacts and collected the
questions for the maintainer in §1.18. The maintainer answered all 24
questions in one batch on 2026-10-16, accepting every proposed answer; the
model's status is now *accepted* and its triage policy stays `strict`.

## Time spent

| Phase | Agent wall time | Notes |
|---|---|---|
| Install the skill, read its references | about 10 min | The `/plugin` commands were not available in the session, so the skills were copied into `.claude/skills/` (not committed). |
| Recon and surface pass (every file in `src/`, `bridge/src/`, `actions/`, `scripts/tokens.mjs`, `template/config-repo/`, the docs) | about 15 min | 5,000 lines of source plus docs. |
| Draft, sidecar, JSON export, validator loop | about 15 min | Three validator rounds; see below. |
| Backtest | included | Synthesized only: the repository has no advisories and no security-labelled or "by design" issues. |
| Maintainer: answer the 24 questions | about 30 min of reading | Answered in one batch on 2026-10-16, every proposed answer accepted. |
| Apply the wave: promote tags, retire §1.18, add two §1.15 entries, `SECURITY.md`, regenerate the companions | about 15 min | One validator round. |
| **Total** | **about 55 min agent time, plus the maintainer's reading** | |

The plan expected one to three hours of agent time; the small codebase and
the thorough docs (every README, `docs/*.md`, `openapi.yaml` and the
source-file header comments) made it faster. Most claims could be tagged
**documented** because the docs already state the contract; the first draft
counted 259 documented, 4 inferred and 62 assumption tags, and after the wave
259 documented and 70 maintainer (0 inferred, 0 assumption), counted as
the validator counts: one per parenthesised tag by its first kind, so a
combined documented-and-maintainer tag counts once as documented.

## What the skill's question bank was missing

The bank (`question-bank.md`) is written for in-process libraries. None of
its 39 questions covers the things that decide this model. The questions
below were written for Pointsman in the bank's own style (a proposed answer
to confirm or correct) and are candidates for a Geolonia extension of the
bank, for hosted services and LLM-in-the-loop systems:

| Area | Pointsman question | Generic form for the extension |
|---|---|---|
| Attacker-controlled input to an LLM prompt | Q7 (prompt injection accepted by design; what still counts as `VALID`) | "We believe steering the model's output through untrusted input is accepted; the contract is the typed output set and the policy. Which outputs would be a vulnerability?" |
| Model output as untrusted input to a policy | Q12 (backend answers are shape-checked data; the server-reported model name is not trusted) | "We believe the model backend is a collaborator whose answers are untrusted data and which is trusted with the input's confidentiality." |
| Client-supplied outbound URL | Q9 (`callback_url`: any public https host, no allow-list, no redirects) | "We believe the service POSTs to any public URL a client names, signs the payload, and refuses private addresses and redirects." |
| Per-client credentials and their scope | Q13, Q17, Q18 (test tokens, no expiry or rate limit, the two scope off-switches) | "We believe credentials have no expiry and no quota, and that these are the only ways to exceed a scope." |
| Public data as facts | Q10, Q11 (bounded lookups; data taken as published) | "We believe external data sources are trusted for content and checked for shape, and that lookups do bounded work for any client geometry." |
| MCP endpoint and OAuth | Q18, Q19 (people get every visible profile; open client registration; what the OAuth library is trusted for) | "We believe dynamic client registration is open and the consent page plus the identity provider are the controls." |
| A separate component family with its own adversary (the bridge) | Q3, Q20, Q21 (one model or a sibling; who can write to the broker) | "We believe whoever can write to the upstream system is the in-scope adversary of the connector, and the upstream system itself is trusted." |
| What an audit log proves | Q14, Q15, Q16 (client-asserted reviewer names; no tamper evidence; `state_hash` is not a pseudonym) | "We believe the log proves what the service saw and did, not that its inputs were true or who the person behind a client was." |
| Deployment shape and multi-tenancy | Q2 (one Worker per integrator; a shared hosted service is unsupported) | "We believe one deployment serves one integrator; a shared instance is out of scope until designed." |
| Request size | Q8 (no engine-side size limit on the state) | "We believe the service sets no body-size limit and leaves it to the platform and the edge." |

The bank's wave-1 items (scope, intended use, configuration support, side
effects) did apply and became Q1–Q6.

## What did not fit a hosted service

- **Length.** The output structure wants 3 to 8 pages. A service with eight
  component families (engine API, facts, callbacks, MCP and OAuth, bridge,
  two Actions, config repository) needs a contract-dimension matrix of
  8 families × 10 dimensions and an input table of 56 rows. The accepted
  model is about 17,700 words (`wc -w`; the first draft was about 19,000)
  and the validator warns about it. For a service, a
  per-family appendix for the matrix and the input table, with the prose
  sections kept short, would read better. The skill has no such option.
- **The dimensions.** Four of the eight required dimensions (recursive
  topology, serialization/reconstruction, reference lifecycle, concurrency)
  are mostly "not applicable" for a stateless request handler. Two
  project-specific dimensions had to be added: `x-prompt-injection` and
  `x-probabilistic-result`. A hosted-service profile of the skill would
  replace the library dimensions with authentication, authorization, outbound
  calls, data retention and rate limits.
- **Roles.** The skill's client / operator / peer split works, but the
  interesting actor here is the *state author*, who holds no credential and
  reaches the service only through a client. The bank has no question for
  "the person behind the data your authenticated client forwards".
- **The validator's code-citation check** treats `'/v1/*'` in Hono's route
  string as the start of a block comment, so `src/app.ts:<line>` citations
  between line 77 and the next `*/` in the file were rejected as "comment
  text" (lines 89, 264, 269 and 271); those four are cited in words. Lines
  further down (365, 394, 401) resolve and are cited numerically. Worth an
  upstream issue.
- **The backtest** needs a history of reports. Pointsman has none, so the
  backtest routed 16 synthesized cases (routing table in the ignored
  `.threat-model/backtest.md`). It still found one useful thing: the "silence
  floor" (a disclaimer that rests on nothing being promised never closes a
  security-critical report) applied to the state-size and rate-limit
  disclaimers in the pre-acceptance backtest, where both cases escalated for
  a ruling. After the maintainer answered Q8 and Q17 (2026-10), both
  disclaimers rest on a maintainer ruling, and the re-run routes both cases
  to `BY-DESIGN: property-disclaimed`, closed.
- **Status vocabulary.** The skill expects an accepted model to have zero
  inferred and assumption tags. Here the maintainer accepted every proposed
  answer in one batch, so the model reached *accepted* in one wave; a larger
  project would more likely end at "accepted with a short list of
  assumptions applied under `relaxed`".
- **The repository's secret scanner** (betterleaks, rule `generic-password`)
  flagged the §1.2 component-family row for the MCP endpoint as a password
  literal: the word "login" followed by two backticked file names in
  parentheses. The row was reworded to "GitHub OAuth" with the file names
  joined by "and". The scanner also reads every commit of the pull request,
  so the branch was squashed to one commit before the check passed. A threat
  model names credentials and login flows all the time; expect a false
  positive or two and reword rather than suppress.
- **The JSON export** needs hand completion: the exporter labelled every
  `trust_boundaries` entry `inferred` (it cannot read §1.4's tags) and gave
  the bridge the wrong boundary text, and before the wave it could not place
  three open questions. The `description`, `environment` and
  `trust_boundaries` fields are set by a small script after each export.

## The questions of the first draft and their answers

All 24 were answered on 2026-10-16 with the proposed answer; the ratified
claims carry *(maintainer, 2026-10)* in `threat-model.md`, and §1.18 is now
marked not applicable. The list is kept here as the record of what was
asked, since the skill deletes answered questions from the model.

**Wave 1 — scope, configuration, side effects**

- Q1 Roles: the state author is the untrusted surface, token holders are
  trusted for their profiles, the operator is trusted. Proposed: yes.
- Q2 One Worker per integrator; a shared hosted Pointsman is unsupported.
  Proposed: yes.
- Q3 One model with eight families; demo, examples, site, spikes, tests out.
  Proposed: yes.
- Q4 `mock`, `bundled`, plain-http model server are dev-only; dropping
  `global_fetch_strictly_public` is unsupported. Proposed: yes.
- Q5 Side effects: only the listed outbound hosts, no spawning, no env reads,
  writes only D1, `OAUTH_KV` and the tile cache. Proposed: yes.
- Q6 The bridge follows redirects from the broker and Pointsman (the engine
  does not). Proposed: record it; hardening candidate.

**Wave 2 — state, model, facts**

- Q7 Prompt injection is accepted by design; the typed answer set and the
  policy are the contract. Proposed: yes.
- Q8 No engine-side size limit on `state`. Proposed: disclaim; edge limits.
- Q9 `callback_url`: any public https host, signed payload, no allow-list.
  Proposed: yes.
- Q10 Fact lookup bounds are the guarantee (correctness-only). Proposed: yes.
- Q11 GSI and Valhalla are trusted data; shape and legend checked, not truth.
  Proposed: yes.
- Q12 The model backend is trusted with the state; its answers are data; the
  HTTP server's model name is ignored. Proposed: yes.

**Wave 3 — tokens, people, the log**

- Q13 A client acting on a `test: true` decision is the client's fault.
  Proposed: yes.
- Q14 `by` and `resolved_by` are client-asserted by design. Proposed: yes.
- Q15 The log proves what the engine saw and did, not truth or identity; no
  tamper evidence (correctness-only). Proposed: yes.
- Q16 `state_hash` is not a pseudonymisation. Proposed: yes, document it.
- Q17 No token expiry, no per-token rate limit; disclaimed, expiry a
  hardening candidate. Proposed: disclaim.
- Q18 The only scope off-switches are `--profiles '*'` and OAuth people.
  Proposed: yes.

**Wave 4 — MCP, bridge, Actions, meta**

- Q19 Open client registration is intended; the OAuth library's contract is
  relied on. Proposed: yes.
- Q20 The bridge's adversary is whoever can write to the broker tenant; the
  broker is trusted. Proposed: yes.
- Q21 Bridge outputs are closed-set except Task names, fact sources and
  pass-through review fields. Proposed: yes.
- Q22 Action inputs `run`, `stacks`, `labels` are trusted; a steered deploy
  cancel is a correctness issue. Proposed: yes.
- Q23 Bind to commit `e1d3591`; add `SECURITY.md` linking the model.
  Proposed: yes.
- Q24 Keep `strict` until waves 1 and 2 are answered. Proposed: strict.

## Candidate issues (not in the model)

The model describes Pointsman as it is. These came up while reading and
belong in issues, not in the threat model:

1. ~~`SECURITY.md` with the private reporting channel and a link to the model
   (Q23).~~ Done in this PR.
2. The bridge's outbound `fetch` to the broker and Pointsman follows
   redirects; the engine's calls use `redirect: 'manual'` (Q6). Hardening.
3. A size limit on `state` in the engine (Q8), or a documented decision not
   to have one.
4. Token expiry or rotation (Q17). Hardening.
5. ~~Once Q7 and Q9 are ratified, add `KNF-STEERED-ANSWER` and
   `KNF-CALLBACK-TO-PUBLIC-HOST` to §1.15.~~ Done in this PR.
6. Upstream to Alpha-Omega: the citation checker's block-comment heuristic
   trips on `'/v1/*'` route strings; a hosted-service dimension set and a
   per-family appendix option for long matrices.
7. For `geolonia/skills`: the question-bank extension in the table above.
8. Amend the model for the `github_workflows` fact (pointsman#141) and the
   `yaml` parser it brings in. It was merged after the commit the model was
   bound to before `v0.5.0`, and the re-binding to `v0.5.0` only records it
   as not covered (§1.16). Lesson for re-bindings: list every commit between
   the old and the new binding (`git log <old>..<new>`), not only the pull
   requests that prompted the re-binding.

## Amendment of 2026-10-23: `github_bump`, the internal call and the GitHub connector

The model was amended for `github_bump` (pointsman#180, #186: v0.10.0 and
v0.11.0, a new outbound host `registry.npmjs.org` and more GitHub reads)
and the internal call (pointsman#188, v0.12.0: `InternalEngine`, a new
entry point without a token), and re-bound from `v0.5.0` to `v0.12.0`. The
GitHub connector Worker, which both changes touch, joined as the family
`connector-github` within the same amendment: the procedure has no rule
that a new family needs its own revision, and the connector was the only
way to describe the internal call's caller and what `github_bump` gates
downstream (an automatic approval).

- **Time**: about 2 hours of agent time, most of it reading the connector
  (about 1,300 lines) and re-checking every citation after the move of
  `packages/facts-github` to `packages/github` and of the bridge to
  `packages/fiware`.
- **Questions**: four, Q28 to Q31, one wave, each with a proposed answer.
  The maintainer answered all four on 2026-10-23 as proposed (Q28 to Q31
  below), so the claims carry *(maintainer, 2026-10)* and the model is
  *accepted* again:
  - Q28: disclaim the connector's trust in the engine's answer
    (`D-CONNECTOR-TRUSTS-ENGINE`); checking `test` and the decision's
    shape is a hardening candidate.
  - Q29: disclaim the reach of the connector app's key
    (`D-CONNECTOR-KEY-REACH`); the key stays only in the connector Worker.
  - Q30: disclaim trust in the npm registry (`D-NPM-REGISTRY-TRUSTED`);
    integrators pair `github_bump` with `github_pr` and an age margin.
  - Q31: disclaim a person's review behind an approval
    (`D-APPROVAL-ON-FACTS`) and prompt injection through the pull request
    for the connector; the integrator's rules are the control. From the Geolonia
  question bank: Q46 (acting on test results, Q28), Q48 (trusted for
  content, checked for shape, Q30), Q51 (a connector as its own family),
  Q52 (settings outside the repository: the ruleset that dismisses stale
  approvals, `R-CONNECTOR-APPROVE`), Q54 (a steered answer inside the
  output set, Q31) and Q110 (binding).
- **What the bank lacked**: a question for *a component that writes to the
  same platform it reads from*: "We believe the connector's key is the
  boundary: down-scoped tokens limit what the code asks for, not what a
  leaked key can do. Proposed: disclaim; keep the key in one Worker." (Q29
  here.) And one for *an entry point without a credential whose boundary is
  the hosting account*: "We believe a caller that the platform
  authenticates (a service binding, an internal network) is trusted as the
  account is; the service names the client itself. Proposed: a property
  for who the service says the caller is, a disclaimer for who may call."
- **Re-binding lesson, again**: nine releases (`v0.6.0` to `v0.12.0`) landed
  within a day. The validator caught the moved files (its citation
  check fails on a path that no longer exists), but not a line that moved
  inside an unmoved file; a small script compared every cited line at the
  old binding with the new tree and found 22 to fix; the self-review found
  four more that were cited in words ("lines 318 and 320 of `src/app.ts`"),
  which the script did not see, and two bridge citations that were already
  wrong before. Everything between the
  bindings that this amendment does not cover is listed in §1.16 as a
  `MODEL-GAP`.
- **Length**: the model grew from about 23,700 to about 31,000 words. The
  connector alone needed ten matrix rows, eight input rows and five
  properties.

Candidate issues kept out of the model:

1. Connector: check the engine's answer (its shape, and refuse
   `test: true`) before acting on it (Q28, recorded as a hardening
   candidate by the maintainer on 2026-10-23).
2. Connector: `ownApprovals` takes any bot's approving review that starts
   with the connector's marker; only reviews whose ids the connector
   recorded are dismissed, but while an action record is open, another
   bot's review with the same marker would be taken as the connector's
   trace. Match the app's own bot account as `findComment` does for
   comments. Hardening.
3. `packages/github/src/provider.ts` header still says the file "only
   sends GET requests" (plus the token POST); the GraphQL queries of
   `github_copilot` and the CodeRabbit module are a POST too
   (docs/profile-format.md already says so). Comment fix.
4. Amend the model for the items §1.16 lists as not covered:
   `github_workflows`, `github_release`, `github_copilot`, the CodeRabbit
   module, facts from the decision log, and connectors inside the engine
   Worker.

## Amendment of 2026-10-24: `v0.14.2` and the list of what was not covered

The model was re-bound from `v0.12.0` to `v0.14.2` (`a5cf423`) and amended
for every commit in between (`git log ef2f822..a5cf423`: pointsman#191,
#193, #195, #196, #199, #200, #202, the documentation site #168, #169,
#203, and four releases) and for the six items §1.16 listed as not
covered. §1.16 now lists none; what the connector's documentation calls
"Not yet" stays a condition that changes the model.

- **Time**: about 2.5 hours of agent time. Most of it went into the
  connector (the decision comment alone is 350 lines, and what text can
  reach it had to be traced field by field) and the CodeRabbit module
  (about 1,000 lines of parsing a bot's own words).
- **The comment question** (§1.16 named "text from the pull request in a
  comment" as a model change): no pull-request text reaches the decision
  comment or the check runs. Everything in them comes from the checked
  engine answer, the head commit id, GitHub's review decision and the
  settings; names are checked by pattern, reasons cleaned, answers shown
  only in known shapes, drawings fenced. What does reach every reader of
  the pull request is the decision itself, AI answers included (Q32).
- **Earlier candidate issues**: 1 (check the engine's answer) shipped in
  #193; 2 (any bot's approval taken as the connector's own) in #191; 3
  (the provider's header comment) in #191; 4 (the gaps) in this amendment.
- **Questions**: one wave of four, Q32 to Q35. The maintainer answered
  all four on 2026-10-24 as proposed, so the claims carry *(maintainer,
  2026-10)* and the model is *accepted* again:
  - Q32: disclaim that check runs and the decision comment show the
    decision and the AI answers to the pull request's readers
    (`D-CONNECTOR-SHOWS-DECISION`); the integrator chooses where.
  - Q33: disclaim the runs the connector's own review events start and the
    approve-and-withdraw cycle (`D-CONNECTOR-OWN-REVIEW-EVENTS`); ignoring
    those events is a hardening candidate (pointsman#213).
  - Q34: the operational state of 2026-10-23 holds at `v0.14.2`.
  - Q35: the CodeRabbit spend and queue are a cost guide, correctness only
    (`D-LOG-FACTS-NOT-ATOMIC`).
  From the Geolonia question bank: Q54 (steering, and what the author sees
  of it, Q32), Q51 and Q107 (a connector that writes to another system,
  Q33), Q52 and Q110 (state outside the repository; binding, Q34), Q49
  (what the log proves, Q35).
- **What the bank lacked**: a question for *a service that shows its
  verdict to the party it judges*: "We believe the decision (and the AI's
  answers) shown on the pull request or ticket it is about gives the author
  an oracle to tune their text against. Proposed: disclaim, and let the
  integrator choose where the verdict is shown." (Q32 here.) And one for
  *facts that read the service's own log*: "We believe a fact that reads
  earlier decisions sees only the asking client's, read only, and not as a
  snapshot; limits computed from it (spend, queues) can be passed by
  concurrent decisions. Proposed: a property for whose log, a disclaimer
  for atomicity."
- **Re-binding**: the citation script of the last amendment (every cited
  `file:line` at the old binding compared with the new tree) moved 26
  citations; one was ambiguous and was fixed by hand. The documentation
  changed after the tag (#205 to #210), but the cited documents are the
  same files, so citations by heading still hold.
- **Validator**: the exporter needs "Proposed answer:" and "Lands in:" at
  the start of a line in §1.18, or it leaves the JSON field empty; a
  combined tag must start with the documented part ("documented, …;
  maintainer, 2026-10"), else the detail check fails. The JSON folds
  assumption claims into `inferred` (§1.19).
- **Length**: about 31,000 to about 38,600 words. The plugin's 3 to 8
  pages are out of reach for a service with nine GitHub fact types, a
  review-service module and a connector; a per-family appendix would help.

Candidate issues kept out of the model, filed on 2026-10-24 with the label
`threat-model`:

1. Connector settings: `approve` or `keep_approval` in a profile with
   `once_per_head` is documented as wrong (docs/github-connector.md "When
   the approval stays") but not refused (`runsOf` in
   `packages/github/src/connector/settings.ts:150`). Refuse it at startup.
   Hardening, Priority: Middle (pointsman#212).
2. Connector: its own review events (`pull_request_review` submitted or
   dismissed by its own bot) start a run each
   (`packages/github/src/connector/webhook.ts:70`), unlike its own check
   suites; ignore them (the Q33 hardening candidate). Hardening, Priority:
   Low (pointsman#213).
3. CodeRabbit budget: `observationsLogged`
   (`packages/coderabbit/src/budget.ts:128`) reads budget readings from
   earlier decisions under any fact name with the right fields, while
   docs/modules.md "Facts from the decision log" says they are read back
   "of the same profile and fact name". Same client and profile either
   way, so not a leak; align the code or the text. Priority: Low
   (pointsman#214).
4. CodeRabbit `ignored`: the summary pattern in `ignoredBy`
   (`packages/coderabbit/src/coderabbit.ts:30`) runs from a start marker
   without an end marker to the end of the description, so an author can
   hide an `@coderabbitai ignore` line from the fact by putting a lone
   start marker before it; the connector's `authorText` keeps such text.
   The effect is a profile that waits for a review CodeRabbit may not do.
   Priority: Low (pointsman#215).

## Amendment of 2026-10-25: asking a person inside the pull request

The model was amended for pointsman#147 (part 1, pointsman#221, merged
after `v0.15.0`; part 2, pointsman#222, open), without re-binding.

- **Binding**: the plugin binds a model only to a release tag or a merged
  commit, never to an unmerged branch, so the binding stays at `v0.14.2`
  and every new claim says "since pointsman#221" or "since pointsman#222".
  Re-bind at the next release tag. `v0.15.0` (pointsman#216, #217) was
  never bound; §1.16 lists it as not covered.
- **Citations**: the validator resolves `file:line` in the working tree,
  not at the bound tag, so a model that keeps an older binding still has
  to move its citations with the tree. The script that compares each cited
  line at the tag with the tree moved 42 citations (two cited in words).
- **Threat review first**: the questions (Q36 to Q42) were asked on the
  issue before the code was written, with build rules and where each
  finding would land. The amendment then had mostly documented claims to
  write, and the maintainer's answers became *(maintainer, 2026-10)* tags.
  Worth repeating for any feature that adds an entry point.
- **Code moving during the amendment**: the code changed twice while the
  model was written (the command went from 7 to 12 characters of the
  commit; the caps moved before any GitHub write). Re-read the final
  commit before the sidecar is generated.
- **Question**: one new, Q43 (is a 12-character commit in the command
  enough, given that a second commit with the same prefix costs about
  2^48 SHA-1 tries). The proposed answer was to accept the limit; the
  maintainer chose a code change the same day instead (`ca11f53`: the
  connector keeps the pull request's last 100 heads and refuses a command
  whose 12 characters start more than one of them). The disclaimer now
  states only what the list does not cover, and the model is *accepted*
  again with no assumption tag.
- **What the bank lacked**: a question for *an approval given on a
  person's word inside the tool it approves in*: "We believe an answer
  given in the pull request (a button, a comment command) counts only from
  a person with write access who is neither the author nor the last
  pusher, checked at answer time and bound to one commit. Proposed: a
  property for who and what, disclaimers for the time between the check
  and the action, for other ways to give the same answer, and for how
  much of the commit the answer names."
- **Validator**: passes (90 checks, one length warning: about 44,700
  words).

Candidate issues kept out of the model (not filed):

1. Re-bind the model at the next release and cover `v0.15.0`
   (pointsman#216, #217).

The command's 12-character binding (Q43) was a candidate too; it was
fixed in pointsman#222 before the amendment was finished.

## Re-binding of 2026-10-25: `v0.16.0`

The model was re-bound from `v0.14.2` to `v0.16.0` (`8eea43d`), which
released pointsman#221 and #222, and amended for `v0.15.0` (pointsman#216,
#217), which had never been bound.

- **Released claims**: about 90 "since pointsman#221" and "since
  pointsman#222" markers in the prose (about 30 in the sidecar) now name the
  release, `v0.16.0`, by script; the header no longer says they hold only
  for a commit that has the code. The mermaid label and the quoted marker
  in §1.1 were left as they were.
- **pointsman#216**: the settings now refuse `approve` or `keep_approval`
  in a profile with `once_per_head`, so `P-CONNECTOR-APPROVE-HEAD` lost
  that narrowing and §1.14 lost its misuse pattern; review events about
  the connector's own reviews, sent by its own bot, start no run, so
  `D-CONNECTOR-OWN-REVIEW-EVENTS` (Q33) now covers only what is left: an
  event before the run recorded the review, a review older than the 50 it
  keeps, a failed read of the bot's login. Both were hardening candidates
  of earlier amendments (pointsman#212, #213).
- **pointsman#217**: `ignored` leaves out only whole CodeRabbit summary
  blocks (candidate pointsman#215); docs/modules.md now says the budget
  readings are found by their fields under any fact name (candidate
  pointsman#214, a documentation fix). A misuse pattern was added for
  renaming a CodeRabbit fact, which resets what is read by name.
- **Citations**: all 135 unique `file:line` citations checked at the tag;
  between the merge of pointsman#222 and the tag only version strings
  moved, so none had to move. Re-running the "Search:" commands found one
  more `console.error` in `answers.ts` (35 in the connector, not 34),
  added by the Q43 fix after the count was made.
- **JSON**: the hand completion now sets the boundary texts from fixed
  strings and asserts each added phrase once, because the earlier script
  appended to the previous export's text and so could repeat it on every
  run.
- **Questions**: none; the code left nothing open.
- **Validator**: passes (90 checks, one length warning).

## Amendment for `copilot_review` (pointsman#220, 2026-10-25)

- **Scope**: only the connector's action `copilot_review`. The CodeRabbit
  commands and paid reviews of pointsman#220 were not built: a sandbox test
  showed that CodeRabbit ignores commands from a GitHub App.
- **Threat review first**, on the issue, before the code (as for
  pointsman#147); its four questions (Q44 to Q47: forks, one review per
  head, no cap, no repository list) were answered the same day as proposed,
  as clickable options.
- **What it adds**: a wider `P-CONNECTOR-ACTIONS-MAPPED`, two disclaimers
  (cost and what Copilot reads), one obligation, one misuse pattern.
- **Question bank**: the cost of an outside AI service that the project
  triggers, billed to someone else, is not in the bank as such; it fitted
  section A (hosted service) as a cost question.
- **Citations**: the new import in `github.ts` moved every line of that
  file; a script compared each cited line at `origin/main` with the tree
  and rewrote the line numbers (16 citations).
- **JSON**: exported with the plugin's exporter; `description`,
  `trust_boundaries` and `environment` were taken from the previous JSON
  (hand completed), `commit` kept at `8eea43d` until the next release.
- **Validator**: passes (90 checks, one length warning).

## Re-binding to `v0.17.0` (2026-10-25)

- **What moved**: the binding to `v0.17.0` (`b08aaf3`, pointsman#226), the
  six "since pointsman#220" markers in the prose (and those in the YAML and
  JSON) now carry `v0.17.0`, the status and §1.16 no longer list
  `copilot_review` as unreleased, and the JSON's `commit` is the bound
  commit.
- **Code**: between the merge of pointsman#225 (`e472f85`) and the tag
  only version numbers and the changelog changed, so no citation moved;
  the counts in §1.5 (29 fetch calls, 35 log lines in the connector) were
  run again and are the same.
- **Questions**: none.
- **Validator**: passes (90 checks, one length warning).

## Re-binding to `v0.17.1` (2026-10-26)

- **What it covers**: pointsman#229, the hardening after a CodeRabbit
  Security Deep Scan of `6656b47`, released as `v0.17.1` (`f783c0b`,
  pointsman#230). It fixes seven findings published as low-severity
  advisories (GHSA-hmc8-qxw6-ffmm, GHSA-p2pc-wjm2-vw8v,
  GHSA-ccgv-4369-cf3f, GHSA-58v7-78v8-74q8, GHSA-h9xp-cmqm-4cx3,
  GHSA-vf58-574r-q9cg, GHSA-h4jj-2x7q-m6fv; affected up to `v0.17.0`,
  patched in `v0.17.1`) and one filed as an issue (pointsman#228).
- **First external reports**: these were the first reports from an
  outside tool triaged against the model. Each was routed by hand against
  the model as bound to `v0.17.0`, and the result is a new table in §1.17,
  "Reports triaged against this model". Six are `VALID` against a claimed
  property (`P-FACT-LOOKUP-BOUNDED` twice, `P-FACTS-NEVER-GUESSED`,
  `P-SERVICE-ACCOUNT-ONLY`, `P-CONNECTOR-APPROVE-HEAD`,
  `P-BRIDGE-SAFE-TO-REPEAT`). One is a `MODEL-GAP`: the claims for the two
  Actions said nothing about `review: {status: pending}`, so the Actions
  acting on an answer a person still checks matched no claim. The issue is
  `OUT-OF-MODEL: trusted-input` (the operator names the questions) and was
  hardened anyway. No advisory routes to a closing disposition, so the
  model did not hide any of them.
- **What the routing showed**: the claims held up as a triage tool; each
  finding named the property it broke. Two wordings were too narrow:
  `P-BRIDGE-SAFE-TO-REPEAT` covered a recorded resolution that disagrees,
  not a 409 for a review that has none, and the Actions' claims did not
  mention `people_check`. Both are now explicit.
- **What changed**: eight wider properties (each new part marked "since
  pointsman#229 (`v0.17.1`)"), the §1.7 and §1.8 rows they rest on, the
  matrix row for the facts' resource complexity, one misuse pattern (an
  answer named like a field of the bridge's result), §1.16, and the §1.1
  backtest note, which no longer says the repository has no advisories.
  One new obligation, `R-PEOPLE-CHECK-PENDING` (Q48); no disclaimer or
  known non-finding changed.
- **Citations**: 19 cited lines in 5 changed files moved; a script
  compared each cited line at `v0.17.0` with the tag and rewrote the
  numbers, and the two lines that #229 rewrote were placed by hand. The
  validator flagged only 9 of the 19 (those that now land on a comment or
  a brace); the other 10 pointed at other code and passed. Map citations
  by content on every re-binding, not by the validator's list. Citations
  written in words ("at line 179 of `github.ts`", "lines 38 and 225") must
  be mapped too: neither the validator nor the script sees them, and two in
  `P-CONNECTOR-ACTIONS-MAPPED` were still at the `v0.17.0` numbers until the
  review of pointsman#231 found them (now lines 181 and 330). The other
  four such citations, in `src/app.ts`, did not move.
- **Counts**: the connector has one more `console.error` (36, 20 in
  `pull-request.ts`); the fetch count is still 29.
- **Questions**: two, from the routing, answered by the maintainer on
  2026-10-26. Q48: hold every engine client to `review: {status: pending}`
  by an obligation; yes, added in this re-binding as
  `R-PEOPLE-CHECK-PENDING` (§1.13), which closes the `MODEL-GAP` of
  GHSA-h4jj-2x7q-m6fv. The GitHub connector and both Actions meet it; the
  FIWARE bridge meets it unless a route's `reviewActions` leaves out an
  action of `people_check`. Q49: make the eight reports the backtest's
  historical corpus; yes, at the next amendment, which re-runs the
  backtest with them and reports the fail-safe figure.
- **Validator**: passes (90 checks, one length warning).

## Re-binding to `v0.17.2` (2026-10-26)

- **What it covers**: pointsman#232 (`81a271f`), released as `v0.17.2`
  (`b1ad3e6`, pointsman#233, which changed only versions and the
  changelog). In the FIWARE bridge an answer with
  `review: {status: pending}` now always counts as checked by a person;
  a route's `reviewActions` only adds actions to check. A route with
  `task` opens a Task for a pending review even when `task.actions`
  leaves the action out, and a work order resolves a pending result
  whose action is not in `reviewActions`.
- **What changed**: `R-PEOPLE-CHECK-PENDING` (§1.13) now lists the bridge
  as meeting it on every route; before, it met it unless `reviewActions`
  left out an action of `people_check`. Also `P-BRIDGE-SAFE-TO-REPEAT`,
  the §1.7 row for work orders, the §1.8 row for the bridge's result,
  §1.1 and §1.16. Each new part is marked "since pointsman#232
  (`v0.17.2`)". No property, disclaimer or misuse pattern was added or
  removed; the confidence counts are unchanged (460 / 83 / 0 / 0).
- **Citations**: 7 cited lines in `packages/fiware/src/bridge.ts` were
  affected: 5 moved (316, 318, 617, 1058, 1064) and 2 were rewritten by
  #232 (883, 887, the old `isChecked`) and placed by meaning. Before the
  update the validator flagged only 4 of the 7; 316, 887 and 1064 still
  resolved to other code. The four citations written in words are in
  `src/app.ts` and `github.ts`, which #232 did not change. No line of
  `bridge/README.md` is cited by number, and #232 changed none of the
  README text the model quotes.
- **Counts**: the fetch count (29) and the log lines (7 in `bridge.ts`, 36
  in the connector) are unchanged.
- **Backtest**: not run again; Q49 waits for the next amendment.
- **Questions**: none in the model.
- **Validator**: passes (90 checks, one length warning).

## Re-binding to `v0.18.0` (2026-10-26)

- **What it covers**: pointsman#235 (`93c235f`) and #236 (`c986869`),
  released as `v0.18.0` (`9dec36e`, pointsman#237, which changed only
  versions and the changelog). #235: the triage and deploy-watch Actions
  never act on an answer for a test token (the triage `action` output is
  `test`); the decide request refuses a `ref` with control characters,
  line separators or direction marks, and `replay-profile.mjs` shows them
  escaped; profile validation's check for circles of `requires` visits
  each profile once; `github_release` also reads a changed `package.json`
  at the head; `github_checks` fails for two required workflows with the
  same path from another repository or ref. #236: people on MCP are
  recorded as `github:<account id>`, and an OAuth grant without the id is
  refused and cannot be refreshed; the GitHub connector's command is
  `/pointsman <answer> <commit> <question>`, and an answer counts only
  while the current `answers.profiles` offer it; `copilot_review` with
  more than 1,000 reviews is recorded as failed for the commit; a
  repeated decide request gets the review as it is now; the FIWARE bridge
  writes a retry after a person's answer as resolved and skips a
  superseded one; `paid_for_head` counts an edited command from its last
  edit, and only when its author made it; `rebase_only` compares line
  numbers and follows hunks through the base's own change.
- **What changed**: the properties `P-OAUTH-ORG-MEMBERSHIP`,
  `P-CHAIN-INPUTS-FROM-LOG`, `P-FACTS-NEVER-GUESSED`,
  `P-FACT-LOOKUP-BOUNDED`, `P-GITHUB-REQUIRED-CHECKS`,
  `P-CONNECTOR-ACTIONS-MAPPED`, `P-CONNECTOR-ANSWER-BOUND`,
  `P-CONNECTOR-COMMAND-EXACT`, `P-BRIDGE-SAFE-TO-REPEAT`,
  `P-TRIAGE-ALLOWLIST` and `P-WATCH-FAILSAFE`; the disclaimers
  `D-REVIEWER-IDENTITY` and `D-COMMAND-SHORT-COMMIT`, which is narrower:
  a command now also names the question by 8 characters of its decision
  id, which the engine draws at random; the obligations
  `R-IGNORE-TEST-DECISIONS`, `R-PEOPLE-CHECK-PENDING` and
  `R-RELEASE-PAIR`; the §1.2 commenter, the §1.6 `answers` row, the §1.7
  rows for `ref`, `Idempotency-Key`, `/mcp`, the OAuth token routes, the
  CodeRabbit reads, the comment command and both Actions' answers, the
  §1.8 rows for the decision, the bridge's result, check runs, the
  decision comment, review requests, the triage labels and the Actions'
  outputs, the §1.10 roles and the threat about answers; §1.1 and §1.16.
  Each new part is marked "since pointsman#235 (`v0.18.0`)" or "since
  pointsman#236 (`v0.18.0`)"; where #236 replaced a behaviour, the old one
  is named "up to `v0.17.2`". One misuse pattern was added (a test token
  in the triage or deploy-watch Action); no property, disclaimer or
  obligation was added or removed. The confidence counts are now 463 / 83
  / 0 / 0 (three new documented tags: the commenter's edits,
  `P-CHAIN-INPUTS-FROM-LOG` and `R-IGNORE-TEST-DECISIONS`).
- **Not in the model**: profile validation's check for circles and
  `replay-profile.mjs` are operator tools on trusted input; the model
  claims nothing about them, so only the `ref` row names the escaping.
- **Citations**: 55 cited lines were affected, in 14 files (`provider.ts`
  of the GitHub module 11, `answers.ts` 10, `bridge.ts` 6, `github.ts` 6,
  `decide.ts` 4, `webhook.ts` 4 and 8 more). 50 moved and were mapped by
  content with the script; 5 were rewritten by #235 or #236 and placed
  by meaning: `triage.mjs:74` (now 75), `bridge.ts:656` (now 669),
  `bridge.ts:887` (now 906), `webhook.ts:140` (the command pattern, now
  142) and `src/mcp.ts:26` (now 32, the people's line). Before the
  update the validator flagged 10 of them; the others still resolved to
  other code. Of the citations written in words, the two in
  `packages/github/src/connector/github.ts` moved (181 to 189, 330 to
  338); those in `src/app.ts` did not.
- **Counts**: the fetch count is unchanged (29). The connector's log
  lines are now 39 (36 before: two more in `answers.ts`, one in
  `pull-request.ts`); the bridge's are unchanged (7 in `bridge.ts`).
  `P-SECRETS-NOT-LOGGED` still gave the count of `v0.14.2` (34 hits); it
  now gives 58 at `v0.18.0`.
- **Candidate issue, kept out of the model**: docs/github-connector.md
  "The decision comment" still says the comment holds no decision ids.
  With the command on, an open question's command now holds the first 8
  characters of its decision id, so a new decision on the same head also
  changes the comment. The model's §1.8 row says so.
- **Backtest**: not run again; Q49 waits for the next amendment.
- **Questions**: none in the model.
- **Validator**: passes (90 checks, one length warning).

## Amendment for callbacks (pointsman#243, #271, 2026-11-19)

- **Why**: the review of 2026-11 found that a signed callback did not name
  the client, so one client could make the engine sign a callback that
  looks like another client's (#271), and that a cron batch used one time
  for every claim, signature and next retry (#243).
- **Changed**: `P-CALLBACK-SIGNED`, `R-VERIFY-CALLBACK`, the §1.8 row and
  the matrix row for the callbacks; the new disclaimer
  `D-CALLBACK-SHARED-SECRET` (one secret for every client and receiver);
  one misuse pattern; §1.1 and §1.16. The callback-execution row and
  `D-CALLBACK-ANY-PUBLIC-HOST` stay as they were.
- **How**: by hand, before the code is released, so it re-binds at the
  next release. The YAML and JSON were edited by hand for the changed
  entries, and the prose SHA-256 and the counts were updated by a short
  script. The plugin's validator was not run in this session.
- **Backtest**: not run; Q49 still waits.
- **Questions**: none.
- **Candidate issue kept out of the model**: a key per client (for example
  `HMAC(CALLBACK_SECRET, client)`), so that one receiver cannot sign
  callbacks for another.

## Amendment for github_pr per field (pointsman#250, #262, #307, 2026-11-20)

- **Why**: the review of 2026-11 found that one failing extra read (a
  deleted team in `CODEOWNERS`, a 5xx from the activity list) made the
  whole `github_pr` fact missing, with the misleading reason `unavailable`
  for the team (#250), and that the facts read a 403 secondary rate limit
  without headers as `unavailable` (#262).
- **Changed**: `P-FACTS-NEVER-GUESSED` (prose, YAML and JSON), the matrix
  row for the GitHub facts' serialization, the §1.7 rows for the GitHub
  reads, the activity list and `CODEOWNERS`, the GitHub bounds (at most 20
  teams), §1.1 and §1.16. After CodeRabbit's review, a failed
  `CODEOWNERS` or team read gives `author_sole_code_owner` no value, not
  false, so a rule that matches on false cannot match a read that failed. The code
  citations into `packages/github/src/provider.ts` and
  `packages/github/src/connector/github.ts` were mapped line by line to
  the new code by a short script; the one cited line that changed (the
  membership read's 302 and 403 check) was re-cited by hand, and so was
  the cursor citation, which pointed at a blank line before this change.
- **Not run**: the plugin's validator and the backtest (Q49 still waits).
  The prose SHA-256 in the YAML was updated by a short script; the
  confidence counts do not change (no claim was added or re-tagged).
- **Questions**: none.

## Amendment for GSI outside Japan and PNG tiles (pointsman#248, #261, #309, 2026-11-20)

- **Why**: the review of 2026-11 found that a GSI fact for a place outside
  Japan read the missing tile as "not in a zone" or "no site" (#248), and
  that the PNG decoder did not check the tile size or the colour key of
  greyscale and RGB images (#261).
- **Changed**: `P-FACTS-NEVER-GUESSED` (prose, YAML and JSON), the §1.7
  row for the tile fetch, the matrix row for the facts' serialization,
  §1.1 and §1.16. The citations into `packages/facts-gsi/src/provider.ts`
  were mapped line by line by a short script and checked by hand.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for policy inputs (pointsman#256, #255, #272, #313, 2026-11-20)

- **Why**: the review of 2026-11 found that the model's probability maps
  were not checked for completeness or their sum (#272), that a probability
  option an older decision lacks read as 0 (#256), and that names such as
  `__proto__` or `constructor` broke the answer and fact maps (#255).
- **Changed**: `P-ANSWER-SHAPE` and `P-CHAIN-INPUTS-FROM-LOG` (prose, YAML
  and JSON), each with one new documented claim, so the
  counts are 466 documented in §1.1 and 549 in the JSON; the matrix row for
  the API's numeric domain; §1.1 and §1.16. The citation into
  `src/policy.ts` was mapped by a short script and checked by hand.
- **Not run**: the plugin's validator and the backtest (Q49 still waits).
- **Questions**: none.

## Amendment for connector reads (pointsman#251, #252, #319, 2026-11-20)

- **Why**: the review of 2026-11 found that the GitHub connector read a
  list answer that is not a list as empty and stopped at 1,000 comments
  without saying so, which could post a second comment (#251), and read a
  pull request without a `state` as closed (#252).
- **Changed**: the matrix rows for the connector's serialization and
  resource complexity (prose, YAML), §1.1 and §1.16. The citations into
  `packages/github/src/connector/github.ts` and `pull-request.ts` were
  mapped line by line by a short script: 16 of them moved, and the lines
  they point at did not change.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for the FIWARE bridge (pointsman#244, #245, #260, #323, 2026-11-20)

- **Why**: the review of 2026-11 found that the bridge took a `207` to the
  first result write as success (#244), had no time limit on its calls
  (#245), hashed inputs with several instances as `null`, and dropped an
  unknown `?route=` silently (#260).
- **Changed**: the matrix rows for the bridge's recursive topology,
  serialization and resource complexity (prose, YAML), §1.1 and §1.16. The
  citations into `packages/fiware/src/bridge.ts` were mapped line by line
  by a short script, and five that pointed at the wrong line already on
  main (found by the self-review) were set to the line their sentence
  describes.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for error handling (pointsman#247, #257, #258, #274, #324, 2026-11-20)

- **Why**: the review of 2026-11 found that MCP tool errors reached the
  caller as text and were not logged (#247), two login errors ended as JSON
  in the browser (#257), fact lookups started before the adapter check and
  the 502 waited for them (#258), and the Workers AI call had no time limit
  without AI Gateway and kept the binding's message (#274).
- **Changed**: the matrix rows for the engine API's resource complexity and
  MCP's failure atomicity (prose, YAML), `P-STATE-NOT-STORED`, §1.1 and
  §1.16. The citations into `src/decide.ts`, `src/oauth.ts` and
  `src/models/workers-ai.ts` were mapped line by line by a short script;
  seven into `src/decide.ts` that pointed at the wrong line already on
  main were set to the line their sentence describes.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for the Actions (pointsman#253, #254, #273, #325, 2026-11-20)

- **Why**: the review of 2026-11 found that the triage Action lost the
  Pointsman error and its `action` output when the review label failed too
  (#253), that deploy-watch asked the model before CloudFormation started
  (a long asset build; found for a first deploy, and by the self-review
  also for an update) and
  waited forever on a command it could not start (#254), and that a round
  it could not read did not start the cancel count again, so
  `P-WATCH-FAILSAFE` ("in a row") was not true (#273).
- **Changed**: `P-WATCH-FAILSAFE`, the matrix rows for both Actions'
  failure atomicity (prose, YAML), §1.1 and §1.16; the citations into both
  Actions moved to their lines.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for profile loading and size limits (pointsman#249, #259, #326, 2026-11-20)

- **Why**: the review of 2026-11 found six ways of reading a set of
  profiles, with `build-profiles` skipping subfolders and duplicate ids
  (#249), and inputs that broke at platform limits: D1's 100 bound
  parameters in `GET /v1/reviews`, the argument size for the KV index in
  `publish-profiles`, the 1024 bytes of KV metadata in `tokens.mjs`, and a
  revoke that reported success for a hash no token had (#259).
- **Changed**: the §1.6 rows for `GET /v1/reviews` and `scripts/tokens.mjs`,
  §1.1 and §1.16; the citations into `src/log-d1.ts` and
  `scripts/tokens.mjs` moved to their lines.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for the config check and the linter (pointsman#266, #276, #328, 2026-11-23)

- **Why**: the review of 2026-11 found that nothing checked the
  `global_fetch_strictly_public` flag that `P-OUTBOUND-PUBLIC-ONLY` rests
  on, so a config without it lost the property silently (#276), and that
  the repository had no linter (#266).
- **Changed**: `P-OUTBOUND-PUBLIC-ONLY` and `R-PRIVATE-CONFIG` name the new
  check in `scripts/check-config.mjs`; §1.1 and §1.16; the citations into
  `packages/github/src/bump.ts` moved to their lines, and the one for the
  peers pass now points to `steps.ts`, where the linter's fix for an import
  cycle moved it.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for the INTERNAL_CLIENT name (pointsman#275, 2026-11-23)

- **Why**: the security review of 2026-11 found that nothing stopped a
  token from having the client name of `INTERNAL_CLIENT`. Its holder would
  share the internal client's decisions: close its reviews, chain on its
  decisions and read them through log facts.
- **Changed**: the §1.6 row for `scripts/tokens.mjs`, `R-INTERNAL-CALL`
  and the misuse pattern on `INTERNAL_CLIENT` (prose, YAML, JSON); §1.1
  and §1.16; the citation into `scripts/tokens.mjs` moved to its line.
  The name is not reserved in the engine (an `internal:` prefix would
  change the client of every logged decision and pending review), because
  the documented move to internal calls keeps the token's name for the
  internal client until the token is revoked; `list` marks that token.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for small fixes in the engine and modules (pointsman#268, 2026-11-23)

- **Why**: the review of 2026-11 listed small fixes (#268). The engine and
  module half changed what some rows say: the connector tells a fork by
  repository id, `INTERNAL_CLIENT` profile ids follow the profile schema,
  the test-token messages name everything such a token may do, and
  `cancel-update` is on for `true`, `True` or `TRUE`.
- **Changed**: the §1.6 rows for test tokens and `cancel-update`, the §1.7
  rows for `INTERNAL_CLIENT` and the connector's GitHub reads, the README
  quote in `P-TEST-TOKEN-ISOLATED` (it now says test tokens may also
  explain a profile, as the README already did); §1.1 and §1.16; every
  citation into the changed files, moved by a script from the diff and
  checked line by line against the old text.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## Amendment for performance (pointsman#263, 2026-11-23)

- **Why**: the review of 2026-11 found three small performance issues
  (#263). One changes the model: the GitHub connector now keeps its
  installation tokens in memory between runs, as the facts already did.
- **Changed**: the runtime assumption in §1.5, the state outside the engine
  (tokens held in memory, dropped on a 401), `P-CONNECTOR-TOKEN-SCOPED`,
  the connector's concurrency row, the `global-state` effect (YAML) and the
  connector's `touches` (JSON);
  §1.1 and §1.16; the citations into `packages/github/src/provider.ts` and
  `packages/github/src/connector/github.ts`, moved by a script from the
  diff and checked line by line against the old text.
- **Not run**: the plugin's validator and the backtest (Q49 still waits);
  the confidence counts do not change.
- **Questions**: none.

## The review's threat-model suggestions (2026-11-24)

- **Why**: the security review of 2026-11 listed nine threat-model updates.
  Most were applied by the amendments that fixed their findings: the base
  branch (pointsman#270, #339), callbacks (#281), complete answer maps
  (#313), deploy-watch (#325), outbound fetches (#328), the
  `INTERNAL_CLIENT` name (#330).
- **Changed here**: `P-TEST-TOKEN-ISOLATED` lists `explain`;
  `P-MCP-VISIBILITY`'s search names all six tools; the logging counts
  match the code (they had drifted since `v0.18.0`, and the GitHub facts
  log one `console.warn` since #307); §1.2 says which engine version the
  maintainer's deployment runs.
- **Still open**: the re-binding to a release, and the backtest with the
  advisories that Q49 promised.
- **Questions**: none.

## Amendment for the FIWARE bridge's 207 (pointsman#347, #348, 2026-11-24)

- **Why**: since pointsman#323 a `207` to the bridge's first result write
  was a failure, but one a retry could not fix, so a queue message was
  acked and direct mode answered `200`: the result was lost while the
  inputs stayed the same (#347).
- **Changed**: the matrix row for the bridge's recursive topology (prose,
  YAML): a `207` to any of the bridge's attribute writes is tried again
  (the queue's back-off, then the dead-letter queue; `502` in direct mode),
  a retry finishes a write a `207` left half done, and a work order writes
  the Decision's `reviewStatus` last.
- **Not run**: the plugin's validator and the backtest (Q49 still waited).
- **Questions**: none.

## Re-binding to `v0.24.1` (2026-11-25)

- **What it covers**: the amendments of 2026-11-07 to 2026-11-24 (images,
  value facts, and the sixteen for the review of 2026-11), released in
  `v0.20.0` to `v0.24.1`. Every claim marked "not yet released" or "after
  `v0.18.0`" now names its release; where the marker named an issue, the
  release is that of the pull request that closed it. A short script read
  the release of each pull request from `git tag --contains` on its merge
  commit.
- **Citations**: all 223 resolve at `59ba61e`. Between `v0.18.0` and
  `v0.24.1` every commit that changed a cited file also amended the model,
  except the release commits (one version line each, no line moves) and
  pointsman#298 (MCP tool annotations and structured results, which no
  claim describes; the three `src/mcp.ts` citations were checked by hand).
  The validator found two citations on comment lines; they now point at
  the code.
- **Backtest (Q49)**: the first run with a historical corpus: the seven
  advisories, #228, and the review's issues #243 to #277 that report a
  defect (without #246 and #263 to #268, and without #270, fixed in
  `v0.19.0`), plus #347: 35 items. Three fresh
  subagents routed the 35 items in parallel against the model before each
  fix and against the model now, with a written brief; I read their
  tables and checked the disagreements against the model. Figures are in
  §1.1 "Backtest note". What it found:
  - precedence rule 5 ("control of a trusted input") lacked the
    "attacker" that §1.17's table has, and the hand triage of
    pointsman#228 had used that gap to close a real defect; read the same
    way, it would have closed #255, #259 and #275;
  - many fixes of the review were stated only in matrix rows or §1.7
    cells, so a regression would have routed to `MODEL-GAP` or even a
    close; three fixed defects (#259, #275, #276) still closed at
    `v0.24.1` before Q53;
  - `KNF-CALLBACK-DUPLICATE` could close a duplicate from an expired
    lease, which `P-CALLBACK-SIGNED` claims never happens, and the callback
    entries did not mention the client check of #271;
  - #272's remainder (a score's value against its level) was neither
    claimed nor disclaimed.
- **Questions**: four, answered in one batch on 2026-11-25 as proposed
  (Q52 to Q55, §1.18). Each changed the model: rule 5 and the #228 row;
  nine properties and the new `P-MODEL-CALL-BOUNDED`; the two callback
  entries and the known non-finding; `D-MODEL-ACCURACY`.
- **Also fixed**: two provenance tags the validator could not read, the
  confidence counts (they had drifted to 473 / 85 over the amendments of
  2026-11, and are 477 / 84 after this re-binding), the MCP SDK version in
  §1.9, a section number in an amendment note, and the provenance of two
  bridge rows that gained 2026-11 clauses.
- **Run**: the plugin's validator at `192fd60` (90 passed, the length
  warning only) and its exporter. The JSON had not been regenerated since
  `v0.18.0`; its hand completion was rebuilt (§1.19).
- **Not done**: no recon or surface pass over areas no amendment touched;
  the 16 synthesized backtest cases were not routed again; the re-routing
  against this model after Q52 to Q55 was done by hand, not by a fresh
  agent.
- **Lesson for the question bank**: a backtest with a real corpus finds
  what amendments written one fix at a time miss: claims placed in the
  matrix instead of the property a triager reads, and a precedence rule
  whose wording differs from its definition. Run it at each re-binding,
  not only at the first draft.

## Files

- `threat-model.md` — the prose model (canonical).
- `threat-model.yaml` — the sidecar (`threat-model-sidecar/v2`), bound to the
  prose by SHA-256.
- `threat-model.json` — the flat export (`schema.json`, spec 1).
- `.threat-model/backtest.md` — producer-side routing table, ignored by git
  and not in the repository, as the skill asks; only the aggregate figures in
  §1.1 are published.
- The skill itself lives in `.claude/skills/` in the working tree and is not
  committed; reinstall it with `/plugin marketplace add
  alpha-omega-security/threat-model` and `/plugin install
  threat-model@threat-model`, or copy the `skills/` folder from the plugin
  repository.

To re-validate after a change (needs Python with PyYAML and a checkout of the
plugin repository):

```bash
python tests/harness/validate_model.py threat-model.md threat-model.yaml --json-report threat-model.json --source-root .
```
