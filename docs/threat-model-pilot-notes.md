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
