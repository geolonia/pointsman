# Design: the next step for a pull request

Status: draft for discussion, 2026-10-21. Nothing here is built.

Pointsman decides what happens next with a pull request in the geolonia
GitHub org: which AI review service reviews it, whether to wait for a free
review or pay for one, whether to ask a person, or whether the change is
small enough to approve without a review. Today the `pr-review-flow` skill
(geolonia/skills) makes this decision with its `review-next` script. This
design moves the decision into two Pointsman profiles. People see Pointsman
as a GitHub App that joins a repository, like CodeRabbit does.

## Why

AI code review is a bottleneck: CodeRabbit has an hourly allowance per
developer, and paid reviews cost money. `review-next` manages that, but:

- It runs inside each person's agent, so results can differ per person
  (plugin version, other skills, personal settings).
- Who decides that a PR needs no review (docs only, a version bump) is not
  clear, and such a PR still needs an approval, so people bypass rulesets.
- Its outcomes are not logged in one place, so nobody can measure how often
  a decision was wrong.

Pointsman gives the same versioned rules for everyone, a log of every
decision, and a review queue for people.

## Pointsman as a GitHub App

Seen from a repository, Pointsman is a bot:

- An org admin installs the **Pointsman app** on selected repositories (or
  all of them). That is how Pointsman "joins" a repo.
- On each PR it shows its decision as a check run **"Pointsman: next step"**
  (for example "Waiting for a free CodeRabbit review, about 12 min"), with a
  link to the decision. A check run gives no notifications, unlike comments.
- It carries out the decision: posts a review command, requests Copilot or a
  person, and, where the team allows it, approves trivial PRs.

Behind the app are two parts, so that the part that reads PR text never
holds write access:

| Part | Does | GitHub access |
| --- | --- | --- |
| Pointsman engine (this repo) | Looks up facts, asks the model, applies the profile, logs the decision | A second, read-only app, used only for facts |
| Executor (small Worker, deployed with the engine) | Receives webhooks, calls the engine, carries out the action, re-decides waiting PRs from a cron | The Pointsman app: `pull_requests: write`, `checks: write` |

The executor carries out only a fixed list of actions, like the label
allow-list in `actions/triage`.

Other ways to run it, and why not first:

| Option | Why not first |
| --- | --- |
| A workflow in each repo, like `actions/triage` | A file in every repo; many runs per PR (statuses, comments, reviews); no secrets on fork PRs; approving with `GITHUB_TOKEN` needs an org setting |
| Only the agent (the skill calls Pointsman over MCP) | Works only while someone's session runs, which is today's problem. Still used during the rollout, and for commands the app cannot post (open question 4) |

### One job of several

Seen more widely, the app is an assistant of the operations team: PR review
routing is its first job, and more can follow (security checks by repo
level, alert triage, repo settings). The team owns the rules; the app applies
them the same way every time and logs each decision. To keep that safe as it
grows:

- Each job is its own profile, with its own list of actions the executor may
  carry out. A new job adds a profile and, only if needed, a permission.
- The app gets the GitHub permissions of the jobs it has, no more.
- Every decision is in the log, so the team can check its work like a new
  colleague's, and correct it through the review queue.

## The decision chain

Two profiles, linked with `requires` ([decision-chains.md](decision-chains.md)):

```mermaid
flowchart LR
    E[PR event or timer] --> R["pr-risk<br/>once per head commit<br/>facts + AI questions"]
    R --> N["pr-next-step<br/>on every event and timer<br/>facts only"]
    N --> X[executor carries out the action]
```

- **`pr-risk`** runs once per head commit (`ref: github:<owner>/<repo>#<n>@<sha>`).
  It classifies the change: `approvable`, `bump`, `normal`, `sensitive` or
  `high`. It is the only profile with AI questions, so the model is asked once
  per push.
- **`pr-next-step`** runs again on PR events and on a timer while a PR waits.
  It reads `pr-risk` and the current review state and returns the action. It
  has no AI questions (`model: none`), so re-running it is cheap.

A new push gives a new `ref`, so both run again.

## Actions

| Action | The executor does | Was in `review-next` |
| --- | --- | --- |
| `done` | Nothing (merged, closed, or already reviewed) | `done` |
| `wait-ready` | Nothing; the author marks the PR ready once | `wait-ready` |
| `in-progress` | Nothing; decide again in 5 min | `in-progress` |
| `retry` | Nothing; a fact could not be read; decide again in 5 min | new (was `error` or an unknown state) |
| `approve` | Approve the head commit as the Pointsman app (see [Approval](#approval-and-rulesets)) | new; replaces `skip` |
| `coderabbit-approve` | Post `@coderabbitai approve` | `approve` |
| `request-review` | Post `@coderabbitai review` | `review` |
| `check` | Post `@coderabbitai rate limit` (free) | `check` |
| `wait` | Nothing; decide again when the wait ends | `wait` |
| `queue` | Nothing; too large to pay for, waits for a free review | `queue` |
| `pay` | Post `@coderabbitai review --use-credits` | `pay` (automatic) |
| `pay-ask` | Ask the author; pay only on a yes | `pay` with `confirm` |
| `use-copilot` | Add the CodeRabbit ignore line, request Copilot | `use-copilot` |
| `copilot` | Request a Copilot review | `copilot` |
| `fleet` | As `use-copilot`, with the "Same change as" line | `fleet` |
| `restore-coderabbit` | Remove the ignore line | `restore-coderabbit` |
| `security-review` | Run the full-repository security review and request code owners (see [Security levels](#repository-security-levels)) | new |
| `split` | Ask the author to split the PR | new |
| `ask-person` | Request a review from a person | `human` |

Names chosen on purpose:

- `approve` (an approval by the Pointsman app) and `coderabbit-approve`
  (asking CodeRabbit to approve) are different things.
- `review` is a reserved action in Pointsman ("a person decides", the default
  of `people_check`), so posting `@coderabbitai review` is `request-review`.
  Both profiles set `people_check` explicitly.

Pointsman has no `retryAt`: rules cannot compute times. The executor takes
the wait from the decision's facts (`facts.queue.wait_minutes`) and decides
again after that, at most 10 minutes later, as `review-next` does today.

## Inputs: facts and AI questions

Rules can read only AI answers, facts and earlier decisions, not the request
state ([profile-format.md](profile-format.md#policy-conditions)). So the
review state must come in as facts. That needs new fact types: **Pointsman
reads GitHub itself**, with its read-only app. The executor sends only the
repository, the PR number and the head commit it was told about. A caller
cannot claim "docs only" or "CI is green"; Pointsman looks it up.

All GitHub facts of one decision come from one snapshot, read once at the
start (PR, files, reviews, statuses, checks, comments), so they describe the
same moment. The snapshot records its head commit; if it differs from the
commit in the request, every GitHub fact is missing and the rules return
`retry`.

Proposed facts (names and fields are a sketch):

| Fact | Fields (examples) | From |
| --- | --- | --- |
| `pr` | `open`, `merged`, `draft`, `wip_title`, `files`, `changed_lines`, `author_member`, `author_dependabot`, `all_commits_by_author`, `fork` | GitHub PR |
| `repo` | `approve_allowed`, `handles_personal_data`, `visibility`, `archived` | repository custom properties |
| `risky` | `any`, `count` for the risky path list | changed paths |
| `approvable_paths` | `all` for the list of paths that may be approved; false for an empty diff | changed paths |
| `sensitive_paths` | `any` for persistence, logging, API, auth and infrastructure paths | changed paths |
| `bump` | `version_only`, `semver`, `dev_only`, `registry_changed` | manifest and lockfile diff |
| `ci` | `green`, `pending`: required checks only, without Pointsman's own check run | checks and statuses on the head |
| `changes_requested` | `any` (CodeRabbit, Copilot or a person) | reviews |
| `coderabbit` | `installed`, `ignored`, `reviewed_head`, `in_progress`, `approved_head`, `rebase_only`, `changes_requested`, `unresolved_threads`, `outside_diff_findings`, `billable_files`, `price_stated` | statuses, reviews, comments |
| `copilot` | `requested`, `reviewed_head`, `approved_head`, `reviews` | reviews, requested reviewers |
| `fleet` | `claimed`, `same`, `approved` | the PR named in "Same change as", only in repos where the read app is installed |
| `budget` | `available`, `wait_minutes`, `allowance_per_hour`, `observed_minutes_ago`, `taken_by_other_pr` | CodeRabbit's rate limit replies |
| `queue` | `ahead`, `wait_minutes` (the wait plus the PRs ahead) | Pointsman's log: the author's other waiting PRs |
| `spend` | `per_pr_usd_after`, `per_5h_usd_after`, `paid_for_head` | Pointsman's log (see [Ledger](#the-spend-ledger)) |

Path lists are fact settings in the profile, like a fact's `layer` today, so
changing them is a profile change with a new version. The list of paths that
may be approved is **narrower** than `review-next`'s trivial list, because an
approval is a stronger outcome than skipping CodeRabbit: it excludes
lockfiles, `*.txt`, and files that instruct agents (`AGENTS.md`,
`CLAUDE.md`, `.claude/**`, `**/SKILL.md`, prompt files).

AI questions, in `pr-risk` only:

| Question | Type | Use |
| --- | --- | --- |
| `matches_title` | `noul` | Does the diff do what the title and description say? |
| `changes_behaviour` | `noul` | Does a docs or config change alter something that runs (a command people copy, a script, CI)? |
| `personal_data` | `noul` | Does the change store, log or return personal data (names, emails, addresses, locations)? |

### Two safety rules

**A missing fact never leads to `approve` or `pay`.** In Pointsman a rule
with a missing fact never matches. That protects positive conditions
(`facts.ci.green == true`) but not negative ones: a missing `risky` fact
would just skip the `high` rule. So:

- The first rule of each profile catches missing facts: `pr-risk` returns
  `high`, `pr-next-step` returns `retry`.
- Rules that lead to `approvable`, `bump`, `approve` or `pay` write every
  condition as a positive, known value (`facts.risky.any == false`, not
  `not facts.risky.any`).
- Tests cover each fact missing.

**AI answers can only make a decision stricter.** The PR title, description
and diff are written by the author and can try to steer the model. Every
rule that leads to `approvable` or `bump` needs the facts to be true *and*
the AI answers to be harmless; an AI answer alone never makes a change
approvable. If the model is tricked, the worst case is the same as having no
AI questions, so the real protection is the facts. The thresholds (lines,
probabilities) are public in the profile; they are not a secret and do not
need to be.

## Repository security levels

Repository custom properties become facts (`facts.repo.*`), so Pointsman can
treat repos differently by their security or privacy level. Rulesets already
target repos this way (`security-suite`, `issue-routing`).

- `approve_allowed` (for example a property `pointsman-approve: true`): the
  app approves only in repos that opted in.
- `handles_personal_data` (a property planned by Geolonia's operations team):
  in these repos, a PR that touches `sensitive_paths`, or where the model
  sees personal data, is `sensitive`. It gets a full-repository security
  review (an agent that reads the threat model, not only the diff) and needs
  a code owner's approval. Pointsman never approves there. A PR over the
  size limit gets `split` first.
- Other properties (public or private, production or not) can be added the
  same way, as one fact type that reads all properties.

The same engine could later decide other security questions (alerts, repo
settings), as separate profiles. That is out of scope here.

## Rules

### `pr-risk`

First match wins:

1. Any fact missing: `high` (the strictest class: CodeRabbit, no automatic payment).
2. `high`: `facts.risky.any == true`, or `facts.pr.changed_lines > 800`.
3. `sensitive`: `facts.repo.handles_personal_data == true`, and
   `facts.sensitive_paths.any == true` or `personal_data.yes >= 0.3`.
4. `approvable`: `facts.repo.approve_allowed == true`,
   `facts.repo.handles_personal_data == false`, `facts.risky.any == false`,
   `facts.approvable_paths.all == true`, `facts.pr.changed_lines <= 40`,
   `facts.pr.author_member == true`, `facts.pr.fork == false`,
   `matches_title.yes >= 0.8`, `changes_behaviour.yes < 0.2`,
   `personal_data.yes < 0.2`.
5. `bump`: `facts.repo.approve_allowed == true`,
   `facts.pr.author_dependabot == true`,
   `facts.pr.all_commits_by_author == true` (nobody else pushed to the
   branch), `facts.bump.version_only == true`, `facts.bump.semver == 'patch'`,
   `facts.bump.dev_only == true`, `facts.bump.registry_changed == false`,
   `facts.risky.any == false` (GitHub Actions bumps touch
   `.github/workflows/**`, so they stay `high`).
6. Default `normal`.

### `pr-next-step`

Rules 1 to 13 keep the order of `review-next` today (SKILL.md section 5),
with the policy.json and caps values written into the rules:

1. Any fact missing, or the snapshot is of another head commit: `retry`.
2. Not open: `done`.
3. Draft or `WIP` in the title: `wait-ready`.
4. CodeRabbit review running, or Copilot requested: `in-progress`.
5. `pr-risk` is `sensitive`: `security-review` (or `split` when too large).
6. Fleet claim holds, the head is not approved yet, no ignore line: `fleet`.
   Claim fails and the ignore line is there: `restore-coderabbit`.
7. CodeRabbit ignored or not installed: Copilot approved the head: `done`;
   Copilot reviewed `maxReviews` times: `ask-person`; Copilot reviewed the
   head: `done`; else `copilot`.
8. CodeRabbit reviewed the head: not approved, no unresolved threads, no
   findings outside the diff: `coderabbit-approve`. Approved and `high`, with
   a second Copilot review on for high risk: `copilot`. Else `done`.
9. Approved before, `rebase_only`, not `high`: `coderabbit-approve`.
10. `approvable` or `bump`, CodeRabbit not involved yet,
    `facts.changes_requested.any == false`, `facts.ci.green == true`:
    `approve`. CI still pending: `in-progress`.
11. Budget unknown, or the free review went to another PR: `check`.
12. A free review and no PR of the author ahead: `request-review`.
13. Wait known and within the limit (15 min for up to 5 billable files,
    60 min above): `wait`.
14. Wait known and over the limit, up to 4 billable files, the org can pay,
    price stated by CodeRabbit for this head, not `high`,
    `spend.per_pr_usd_after` and `spend.per_5h_usd_after` within the caps,
    not `paid_for_head`: `pay`.
15. Wait known and over the limit, up to 4 billable files, the org can pay:
    `pay-ask`.
16. Wait known: `queue`. Default: `check`.

Not yet placed: the Copilot-instead settings (`insteadWhenLimited`,
`insteadAfterMin`, `trivialApprover`) and the guards around them (Copilot
reviewed too often, CodeRabbit's open change request). They are personal in
`caps.json` today; in a shared profile each becomes one team setting, or is
dropped (open question 3).

`review-next.test.mjs` has the cases for all of these. They become the
profiles' test cases. That needs a test harness with mock GitHub facts and
earlier decisions: test tokens cannot send `decisions`, and the mock facts
cover only the spatial types today.

## Fact provider notes

- New fact types with GitHub as the source. Each fact has 3 s today; one
  shared snapshot per decision keeps that possible. A GitHub rate limit or
  timeout makes the facts missing (`error` or `timeout`).
- `queue` and `spend` read Pointsman's own log (other decisions of
  `pr-next-step`, across clients). That is new: facts read external data
  today.
- `budget` comes from CodeRabbit's replies to `@coderabbitai rate limit`,
  which are per developer. Pointsman reads the latest reply for the PR's
  author on any PR, not only this one.

## Approval and rulesets

- The executor approves as the Pointsman app, with `commit_id` set to the
  head commit Pointsman decided on. Right before approving, it reads the head
  again and stops if it changed.
- A push after the approval must remove it. Rulesets must dismiss stale
  approvals on push, and the executor also dismisses its own approval on
  every `synchronize` event.
- To verify in a sandbox repo: does an app approval count for "required
  approvals" and for "approval of the most recent push"? Is an approval
  posted on an older `commit_id` just after a push dismissed or ignored? Code
  owner review would still need a person, since CODEOWNERS lists users and
  teams.
- `approve` only in opted-in repos, never in repos that handle personal
  data, never on fork PRs or PRs by people outside the org.
- A compromised member account could open docs PRs that the app approves.
  Limits: the narrow path list, the line limit, and the log shows every
  approval by author.
- Whether a bot may approve at all is a team and security decision (open
  question 1).

### Confirmed approvals (rollout step 5)

While people still confirm approvals, `approve` is in `people_check`. Two
Pointsman behaviours matter here: a newer decision for the same `ref`
supersedes the open review, and once a person resolved it, new decisions
for that `ref` are refused (`409 resolved_by_person`). So the executor does
not re-decide a PR while its approval waits for a person, and treats a `409`
as "a person decided". The person's answer reaches the executor through the
callback, which then approves.

## The spend ledger

Today each person has a ledger in a secret gist (`caps.json` and payments),
and a hook records each payment.

Proposal: **Pointsman's decision log is the ledger.** Every `pay` decision
counts at its price, also when it was not carried out (totals can only
overestimate, as today). `spend.paid_for_head` stops a second payment for the
same commit. The caps are rules in the profile: the same for everyone,
changed by a PR to the profile. CodeRabbit's monthly spending cap stays the
last limit. The gist is retired at the end of the rollout.

Payments people post by hand are not in the log. CodeRabbit's monthly cap
still holds; a fact that reads paid review comments on GitHub could close the
gap later.

## Rollout

1. **Team answers** the open questions below, at least 1, 3 and 4.
2. **Build** the GitHub facts, the two profiles, the test harness and the
   executor (without write actions at first).
3. **Replay** `pr-risk` with a test token over the last 30 days of merged PRs
   in a few repos. For each PR it calls `approvable` or `bump`, check whether
   a review found a real problem. That estimates how often `approve` would
   have been wrong, before anything acts on it.
4. **Shadow, 2 to 3 weeks.** The app is installed in a few repos and only
   writes its check run. `review-next` runs as today and also calls
   `pr-next-step`, sending its own action in the state (`log.store_state`
   with only repo, PR, head and that action). A weekly query lists agreement
   and every difference; each difference is explained and fixed in the
   profile or in `review-next`. Continue when the differences are understood
   and no `approve` was given where a review later found a real problem.
5. **Pointsman decides, people confirm approvals.** The executor carries out
   the actions; `review-next` becomes a thin client that prints Pointsman's
   action. `approve` needs a person's yes (see above). The log shows how
   often people said no.
6. **The app approves on its own** in opted-in repos, then more repos. The
   decide code and the gist ledger are removed from the skill.

## Open questions for the team

1. May a bot approve PRs? In which repos, and on which branches?
2. What may be approved: docs only up to 40 lines? Dependabot patch bumps of
   dev dependencies only, or more?
3. Caps and Copilot settings: one team setting in the profile, or per person
   as today? Who reviews changes to them?
4. Does CodeRabbit act on commands posted by another app, and whose allowance
   does it use? Does `--use-credits` work from an app? If not, review commands
   stay with the author's session (Pointsman decides, the skill posts).
5. Can an app request a Copilot review through the API?
6. Who answers `ask-person` and `security-review`: code owners, a rotation, or
   the author's choice?
7. Where do the profiles, path lists and repo properties live: here as
   examples, or in the private deployment config?
8. Which repos join the shadow phase?

## What this does not fix

- CodeRabbit's allowance itself: Pointsman spends it better, it does not make
  it larger.
- Review quality: an approval of a small change says it is small and low
  risk, not that it is correct.
- Work pushed after ready: still a counted review each time.
