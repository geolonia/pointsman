# GitHub connector

The GitHub connector asks Pointsman about pull requests and shows each decision on the pull request as a check run. It is the connector role of the module `@pointsman/github` ([connectors.md](connectors.md)); the same module's fact role reads pull requests for the engine ([profile-format.md](profile-format.md#facts)).

By default it runs in **shadow mode**: it only writes its check runs, with the conclusion `neutral`, so they never block a merge. A deployment can switch on [actions](#actions) for chosen decisions: a comment, labels, a review request or an approval; and [the decision comment](#the-decision-comment), one comment per pull request that shows the latest decisions. Where a decision waits for a person, it can let them [answer inside the pull request](#answering-in-the-pull-request). The check runs stay `neutral`.

## How it works

1. GitHub sends a webhook for an event of a pull request (opened, new commits, ready for review, edited, a review, a finished check suite). The connector's own check suites start no run, and neither do its own approvals and their dismissal: the run that made them reads the reviews again afterwards and draws the decision comment from them. A person's dismissal of its approval, and other apps' reviews, start a run.
2. The connector checks the webhook's signature, then hands the event to the pull request's own object (a Durable Object), one per pull request.
3. That object runs the work for its pull request, one run at a time, 20 seconds after the event: a burst of events (several check suites finishing) becomes one run.
4. A run reads the pull request again from GitHub, asks Pointsman with each configured profile, and writes one check run per profile and head commit, `Pointsman: <profile>`. Its title is the decision's [signal](#signals) and action, for example `🟢 approve` or `🔴 review (shadow)` (`(shadow)`: no action is mapped for it); its details show the [line and the switch](#the-decision-comment).

What it sends to Pointsman: `POST /v1/decide/<profile>` with its own token (or the same call as an [internal call](#internal-call), without a token), and

```json
{
  "state": { "pull_request": { "repo": "owner/name", "number": 7, "head": "<commit>", "title": "…", "body": "…" } },
  "ref": "github:owner/name#7@<commit>"
}
```

Title and body are cut to 300 and 8,000 characters. The body is the description as the author wrote it: CodeRabbit's summary blocks (between its `auto-generated comment: release notes by coderabbit.ai` start and end markers, whole blocks only) are left out, so a bot's edit neither reaches the model nor counts as a new description for `once_per_head`. Other bots' text in the description is not left out. Pointsman reads every fact from GitHub itself, with its own app (below). The idempotency key covers the profile, this state, the draft flag, the base branch and a count of the pull request's runs, so every run asks anew (a retry too): an action never rests on an older answer, and each new event (for example finished CI) gets a new decision. The one exception is a decision a person checks: it is kept for its head commit and read back on later runs, as long as nothing it rests on changes ([Asking a person](#asking-a-person)).

### Safety

- **Signature.** Every webhook must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the body with the webhook secret); others get 401 before the body is parsed. Bodies over 2 MB get 413, also without a Content-Length (the body is read only up to the limit).
- **Replays.** GitHub signs only the body, so a replayed webhook could carry a new delivery id. Each pull request's object remembers delivery ids and body hashes for 7 days and drops a repeat. And the event is only a hint: the connector reads the pull request again with its own token, so even a replay that got through would only check the current state again.
- **Only its repositories.** Events for other repositories are ignored. Its own check runs' events are ignored too, so a check run does not start the next run.
- **One check run per profile and head.** The record of a check run is written before the check run is created. If a run stops in between, the next run first looks for the check run on GitHub and updates it, instead of creating a second one. Later decisions on the same head update the same check run.
- **Retries.** When GitHub or Pointsman is busy, down or not reached (5xx, 429, a network error or timeout), the run is tried again later (the Durable Object's alarm, a few times with growing delays). When Pointsman refuses (another 4xx) or the app cannot do it (not installed, no permission, a broken key), it is a setting to fix: the error is logged without the token or key, and nothing is shown on the pull request. In both cases the next event of the pull request starts a new run; a redelivery of the same webhook from GitHub's settings is dropped as a replay.
- **The engine's answer is checked.** Before anything is done with a decision, whichever way it came ([How it reaches Pointsman](#how-it-reaches-pointsman)), the connector checks the fields it reads: `decision_id` (a decision id), `action` (an action name: lower-case letters, digits, `_` and `-`, at most 64 characters), `profile` (the profile it asked), `ref` (the ref it sent), `profile_version`, `rule`, and when they are there `facts` (fact names and their `missing` and `reason`), `review` (`pending`, or `resolved` with a person's answer in `final_action`, an action name, when it is read back; any other status is not acted on) and `test`. Other fields are not looked at. An answer that fails the check is logged (the field, never its value), shown on the check run as `invalid answer: nothing done`, and not tried again until the next event or recheck; nothing is done for it, nothing is kept or sent on to other profiles, and an approval of the head commit is withdrawn.
- **No test decisions.** A decision with `test: true` (made with a test token, so not logged) is never acted on: no action, no `keep_approval` (an approval of the head commit is withdrawn), not kept and not sent on. Its check run is titled `test decision: nothing done`. Give the connector a token that is not a test token.
- **Write access only here.** Only the connector has the key of the app that can write, and only in its own Worker. Its tokens are down-scoped to what it needs (read pull requests, write check runs; write pull requests only when actions or the decision comment are switched on) and to the one repository.
- **Check runs deleted on GitHub** are made again on the next run.

## How it reaches Pointsman

The connector reaches Pointsman in one of two ways; the deployment chooses by its settings ([adapters.md](adapters.md#engine-client-a-connectors-way-to-the-engine)).

- **HTTPS with a token** (the default; any setup): `POINTSMAN_URL` and the secret `POINTSMAN_TOKEN`, a Pointsman API token for the connector's client. The token has its profiles, can expire, and is rotated with `scripts/tokens.mjs`.
- **Internal call** (when the engine Worker is in the same Cloudflare account): a service binding named `POINTSMAN` to the engine Worker's entrypoint `InternalEngine`. No token, no URL.

With the binding there, the connector makes internal calls. Without it, it needs `POINTSMAN_URL` and `POINTSMAN_TOKEN`. Without either, or with the binding and `POINTSMAN_URL` both set, the connector answers 500 and logs which setting is wrong. A `POINTSMAN_TOKEN` left next to the binding is not used; the connector logs a warning until it is deleted.

### Internal call

The connector Worker's config:

```jsonc
"services": [{ "binding": "POINTSMAN", "service": "<engine Worker name>", "entrypoint": "InternalEngine" }]
```

The engine Worker's config names the client the calls are made as, and its profiles:

```jsonc
"vars": {
  "INTERNAL_CLIENT": "{\"client\":\"github-connector\",\"profiles\":[\"pr-docs-check\",\"workflow-check\"]}"
}
```

Use the client name the connector's token has today: its decisions are logged under the same client, so idempotency, chains and facts from the decision log go on where they left off. The profiles are those in `GITHUB_CONNECTOR` (`"*"` is not allowed).

Why no token is needed: `InternalEngine` has no URL. Only a Worker in the same Cloudflare account with a binding to it can call it, and the engine, not the caller, says who the caller is (`INTERNAL_CLIENT`). After that, each call runs the same code as its HTTP route after the token check (`decide`, `get`, `resolve` and `close`: `POST /v1/decide`, `GET /v1/decisions/{id}`, `POST /v1/reviews/{id}/resolve` and `/close`): the same profile scope, idempotency and decision log ([adapters.md](adapters.md#internal-calls)). Edge rules on the engine's `/v1/` paths (a firewall, rate limits) do not see internal calls.

What that means: anyone who can deploy a Worker in this Cloudflare account can bind `InternalEngine` and act as the `INTERNAL_CLIENT` client, with its profiles, without a token and without an expiry: decide, read decisions, resolve reviews, and close the reviews of that client's decisions. Every bound Worker is the same client (one decision history, one idempotency space). It cannot be revoked per caller, and revoking the old token does not stop it: to turn internal calls off, remove `INTERNAL_CLIENT` from the engine's config and deploy.

To switch an existing deployment from the token to the internal call:

1. Deploy the engine Worker with `INTERNAL_CLIENT` (the client name and profiles of the connector's token).
2. In the connector's config, remove `POINTSMAN_URL`, add the `services` binding, and deploy the connector.
3. Check that new check runs appear (the connector's log shows a warning while `POINTSMAN_TOKEN` is still set). Then find the token's hash, revoke the token and delete the secret:

   ```sh
   node engine/scripts/tokens.mjs list --remote --config wrangler.jsonc
   node engine/scripts/tokens.mjs revoke --hash <hash of the github-connector token> --remote --config wrangler.jsonc
   wrangler secret delete POINTSMAN_TOKEN --config github-connector.jsonc
   ```

   These are the paths in a config repository (`engine/` is the engine checkout, `github-connector.jsonc` the connector's config). In this repository: `node scripts/tokens.mjs` and `--config connectors/github/wrangler.jsonc`.

To go back, set `POINTSMAN_URL` and a new token, and remove the binding.

## Actions

The connector carries out an action only where the deployment maps a profile's decision action to one, in `GITHUB_CONNECTOR`:

```json
{
  "repos": ["owner/name"],
  "profiles": ["pr-docs-check"],
  "actions": {
    "pr-docs-check": {
      "light": { "do": "label", "labels": ["docs-only"] },
      "review": { "do": "request_reviewer", "reviewers": ["octocat"] }
    }
  }
}
```

| `do` | Settings | What it does |
| --- | --- | --- |
| `comment` | `text` (1 to 1,000 characters, fixed) | Writes the text as a comment, with the decision id. Never text from the pull request. |
| `label` | `labels` (1 to 10) | Adds the labels. GitHub creates a label that does not exist yet, so check the names. |
| `request_reviewer` | `reviewers` (1 to 10 GitHub logins) | Asks them for a review. |
| `approve` | none | Approves the head commit the decision was made on. |
| `keep_approval` | none | Does nothing on GitHub: the app's approval of the head commit, if it gave one, is not withdrawn. For a decision that says "already approved". Only in a profile that also maps an action to `approve`. |
| `copilot_review` | none | Asks Copilot for a review of the pull request ([below](#copilot-reviews)). |

This is the whole list: a deployment can switch actions on, never add one. A decision action that is not mapped gets only its check run, as in shadow mode, and the check run says which action was done or why not.

Rules for every action:

- **At most once per head commit**, per profile and kind. The record is written before the action and closed after it. A new commit starts again.
- **A stop in between:** a record left open is settled by its trace on GitHub (the comment or approval with its marker, the labels, the requested reviewers). Without a trace, the action may be done again only after 10 minutes; the connector looks again then, also without a new event.
- **A person first:** while a person still checks the decision (the profile's `people_check`, `review: pending`), nothing is done. Once they answered, their answer is the action ([Asking a person](#asking-a-person)).
- **Refused by GitHub** (no permission, a reviewer who cannot be asked): shown on the check run and logged, and not tried again for that commit. Busy or down: tried again later.
- **One record per profile and kind:** two decision actions of one profile mapped to the same kind (for example two `label` actions) are done only once per commit, whichever comes first.

For `approve` also:

- Only on the commit that was decided on: the pull request is read again right before, and nothing is done if its head changed, it is a draft or it was closed. The approval names that commit (`commit_id`).
- Never for a pull request from a fork.
- After a push, the connector dismisses its own approvals of older commits, on every run. It dismisses only approvals it recorded giving, never someone else's review.
- When a later decision on the same commit no longer approves (CI failed, a fact changed, a person must check it), its approval of that commit is withdrawn; a later approving decision may approve again. See [When the approval stays](#when-the-approval-stays).
- If an old approval cannot be dismissed, it approves nothing in that run.
- The reviews are read up to 1,000. A recorded approval that is not among them is read by its id before the connector takes it as gone; if that read fails, the record stays and the next run tries again.
- **Required:** the branch's ruleset (or branch protection) must have "Dismiss stale pull request approvals when new commits are pushed" on. Otherwise an approval of an older commit counts for merging until the connector's next run dismisses it.
- Its own approvals are reviews by its own bot account (`<app slug>[bot]`, the slug from GitHub's answer for the app's installation) with its marker. Another app's review with the same marker is never taken for its own.
- **Code owners:** an app cannot be a code owner (`CODEOWNERS` names users, teams and email addresses). Where the ruleset requires a code owner's review and `CODEOWNERS` covers a changed file, a person must still approve; the app's approval can still count toward the required number of approvals (with the app's "Contents: write" permission, see below).

### Copilot reviews

For `copilot_review` also:

- **One Copilot review per commit, whoever asked.** Before asking, the connector reads the pull request: if Copilot is already requested, or already reviewed the head commit (asked by a person or another profile), it asks nothing and the action counts as done. It knows Copilot by its account id, not its name.
- **Checked:** GitHub can accept the request and still not add Copilot (for example when Copilot code review is not on for the repository). The connector counts it as done only when GitHub's answer lists Copilot. Otherwise it is refused: shown on the check run, not tried again for that commit.
- Never for a pull request from a fork, so an outsider's pushes do not use your Copilot allowance, and never for a closed one.
- **Only for the commit decided on:** the pull request is read again right before; if its head moved, nothing is asked.
- **Unclear:** when the connector cannot read whether Copilot was already asked (also when the pull request has more than 1,000 reviews), it asks nothing and looks again 10 minutes later.
- **Cost:** each Copilot review uses Copilot premium requests, billed as GitHub decides for a request made by an app. The connector asks at most once per commit; how many commits get a review is up to the profile. Use `skip_drafts` ([Chains](#chains)) and a rule on [`github_copilot`](profile-format.md#github-pull-requests) (for example its `reviews` count) to limit it, and keep a Copilot budget in the organization.
- Copilot reads the pull request's code and text. Map `copilot_review` only where your organization allows Copilot code review for these repositories. The connector never reads what Copilot writes.
- Not yet tried with a GitHub App (only with `github-actions[bot]`): check the first request when you switch it on.

### When the approval stays

The connector approves at most once per head commit. Each later decision on that commit either keeps the approval or withdraws it (dismisses the review):

| Later decision on the same commit | The approval |
| --- | --- |
| An action mapped to `approve` | stays (no second approval: already done for this commit) |
| An action mapped to `keep_approval` | stays |
| Any other action, mapped or not (`ask-person`, `review`, `pay`, `split`, `wait` …) | withdrawn |
| Any decision a person still checks (`review: pending`), also one mapped to `approve` or `keep_approval` | withdrawn |
| A person's answer to that decision ([Asking a person](#asking-a-person)) | as for the action they answered |
| A test decision (`test: true`), or an answer that is not a valid decision ([Safety](#safety)) | withdrawn |
| A new head commit (a push) | the approval of the older commit is dismissed, whatever the decision |

When unsure, the approval goes: only the two kinds above keep it. An edit of the title or description gives a new decision on the same commit; if the risk class changes, that decision is no longer `approve` or `keep_approval`, so the approval is withdrawn.

Why `keep_approval` is needed: an approval changes what the profile sees. For example, CodeRabbit reviews after Pointsman approved, and the rule that approves requires that CodeRabbit has not reviewed. The next decision is then not `approve` any more, although nothing that matters changed. With the fact [`github_app_approval`](profile-format.md#github-pull-requests), the profile can see that the app already approved this commit, and answer with its own action for that, mapped to `keep_approval`. Place that rule before the rule that approves, and after every rule that blocks (missing facts, failed checks, changes requested). It must require everything the approving rule requires, except the facts that the approval itself changes (here: that CodeRabbit has not reviewed yet). Otherwise a failed check on the same commit would keep the approval:

```yaml
facts:
  - { name: pointsman, type: github_app_approval, at: $.pull_request, app: <the connector app's slug>, bot_id: <its bot's account id> }
rules:
  - when: "facts.pointsman.missing == true or facts.ci.missing == true"
    action: retry
  - when: "facts.ci.failed == true"
    action: ask-person
  # … the other rules that block
  - when: "facts.pointsman.approved_head == true and (decisions.risk.outcome == 'approvable' or decisions.risk.outcome == 'release' or decisions.risk.outcome == 'bump') and facts.coderabbit.changes_requested == false and facts.ci.green == true"
    action: done
  # … then the rule that approves
```

and in `GITHUB_CONNECTOR`:

```json
"actions": { "pr-next-step": { "approve": { "do": "approve" }, "done": { "do": "keep_approval" } } }
```

The connector cannot tell which rule gave the action. Map `keep_approval` only to an action that the profile gives when its approval should stand, as in the rule above. If the profile also gives that action in other cases (for example a merged pull request), those keep the approval too; then give the "already approved" rule an action of its own (for example `approved`) and map that one.

A profile with `once_per_head` ([Chains](#chains)) is not asked again on the same commit, so its later decisions neither keep nor withdraw anything. Such a profile cannot map `approve` or `keep_approval` (a config error): a failed check or a change request on the same commit would not withdraw the approval.

Actions need the connector app's permission **Pull requests: Read and write**. With only read, the token cannot write pull requests and every action fails (shown on the check run). For its approval to count toward a ruleset's required approvals, the app also needs **Contents: Read and write**: GitHub counts approvals only from reviewers with write access (tested on #174, 2026-10-23). The connector's tokens ask for contents only to read a diff (`contents: read`, [Chains](#chains)) or who pushed a commit ([Answering in the pull request](#answering-in-the-pull-request)), never to write.

## Asking a person

When a decision needs a person (`review: pending`, the profile's `people_check`), the connector keeps that decision as the question for its head commit, together with what it rests on: the title, the description, the base branch, the draft flag, the profile's settings and mapped actions, and what the decisions it requires say (their action and rule, and a person's answer to them, if any; not their ids, since a required profile is decided anew on every run). Later runs on the same head do not ask Pointsman again for that profile while none of that changes: they read the decision back (`GET /v1/decisions/{id}`, or `get` as an [internal call](#internal-call)). So Pointsman's review queue holds one question per pull request, profile and head commit, however many events come in.

- **Where a person answers:** in Pointsman's review queue (`POST /v1/reviews/{id}/resolve`, [reviews.md](reviews.md)), or inside the pull request where the deployment switched that on ([Answering in the pull request](#answering-in-the-pull-request)). The connector sees an answer given in the queue on the next event of the pull request. A [recheck](#chains) reads it too, but only for a profile whose `recheck.actions` lists the action that asks the person, and each read counts toward `recheck.max`.
- **Who can answer:** anyone with a Pointsman token whose profiles include the profile (or a Worker bound to `InternalEngine`), not only the connector's own client. Such an answer can lead to the mapped action, `approve` too, without the checks of an answer given in the pull request. List `people_answers` in a profile that is asked this way, so only the answers you mean can be given ([profile-format.md](profile-format.md#people-check-and-answers)).
- **The answer is the action.** It goes through the same [actions](#actions) table and rules as a decision's own action: only a mapped action is done, at most once per head commit, and `approve` only on the commit the question was about. The answer stands while nothing it rests on changes: it is not read again, and the profile is not asked again.
- **When what it rests on changes** (an edit of the title or description, another base, the draft flag, a settings change, a required decision made anew with another action, or answered): the open question is closed in Pointsman and the profile is asked anew, so an action never rests on an older answer. An answer already given to the older question is not acted on.
- **What is shown:** while the question is open, the check run's title ends in `: a person checks first`, and its details say it waits for a person. Once answered, the title is the answer with `: a person's answer`; the decision comment shows the answer in the column "Decision" with "a person" in the column "Set by", and its details show why the rules asked a person, with the answer below. Who answered is shown only for an answer given in the pull request: "answered by <login>", without `@`, so nobody is mentioned. An answer given in the queue names nobody.
- **Not acted on:** an answer that is not an action name, or a decision read back that is not the one kept (`invalid answer: nothing done`); a read that Pointsman refuses, for example 403 (`answer could not be read: nothing done`). The question stays.
- **A push, the pull request closed, or the profile taken out of the settings:** the connector closes the open questions concerned in Pointsman (`POST /v1/reviews/{id}/close`, or `close` as an internal call). A late answer to a closed question is refused (`409 not_pending`) and never acted on. A close that fails (Pointsman busy, down, or older than the connector) never holds up the run: it is logged and tried again on later runs, at most once every 5 minutes, for at most 10 tries or a day. A question that was closed in Pointsman some other way, or that is gone, is asked anew once.
- **Engine version:** the connector needs an engine with `GET /v1/decisions/{id}` and `POST /v1/reviews/{id}/close`, and for answers in the pull request the resolve route (for internal calls: `InternalEngine.get`, `close` and `resolve`). Deploy the engine first: with an older engine over the internal call, every answer is refused ("Pointsman could not be reached; answer again").
- **A new profile version** is not noticed while a question is open: the connector does not know the profile's versions, so the question stays on the version it was asked with until it is answered or something above changes.

## Answering in the pull request

A person can answer an open question ([Asking a person](#asking-a-person)) inside the pull request: with a button on the check run, or, where the deployment switches it on, with a comment. Both are off by default. A deployment switches them on in `GITHUB_CONNECTOR`:

```json
"answers": {
  "profiles": { "pr-next-step": ["approve", "reject"] },
  "command": false
}
```

- `profiles`: the profiles that may be answered in the pull request, each with the answers offered (1 to 10 action names, not `review`). Each answer must also be in the profile's `people_answers`: Pointsman refuses any other answer, and the check run says so. List `people_answers` in the profile, so only the answers you mean can be given ([profile-format.md](profile-format.md#people-check-and-answers)). The connector cannot see `people_answers`: an answer listed here but not there still gets a button (and a command), which Pointsman then refuses. An answer that is mapped to no [action](#actions), for example `reject`, only answers the question.
- **Buttons:** a profile with at most 3 answers, each at most 20 characters, gets one button per answer on its check run while its question is open. With more answers, or a longer name, it gets no buttons, and the command must be on (else the setting is refused).
- `command`: the comment command `/pointsman <answer> <commit> <question>`; off unless `true`.

**The buttons.** Each button's label is the answer; its description is "Pointsman: answer <answer>". Its identifier is the answer's place and the first 8 characters of the decision id, for example `1-3f2a9c01`: nothing from the pull request. A click counts only on the connector's own check run of the current head, and only for the question that check run shows. Once the question is answered, the head moves or the pull request closes, the connector removes the buttons: it updates the check run with an empty list of buttons (that this removes them is to verify on GitHub: its docs do not say).

**The command.** A comment counts only when the whole comment, trimmed, is exactly one line `/pointsman <answer> <commit> <question>`, for example `/pointsman approve 3f2a9c01b7d4 8e1f0c2a`: lower case, one space between the parts, `<answer>` one of the answers offered for an open question, `<commit>` the first 12 characters of the head commit the question is about, and `<question>` the first 8 characters of the question's decision id. The commit binds the answer to what the person looked at: a command is taken only for the question about the commit it names, so a command written for an older commit does not answer the question about a newer one, also when it arrives late or out of order. Two commits can start with the same 12 characters (an author can make such a pair on purpose), so the connector keeps the last 100 heads of the pull request, and a command whose 12 characters start more than one of them is refused (the check run says so): answer with a button, which is bound to its check run and decision, not to a prefix. The question binds the answer to the question the person read: the same commit can get a new question (the author changed the description, so the profile decided again), and a command for the earlier question does not answer the new one. It is refused, and the check run says to copy the command from the open question; so is a command without the question. A command for a commit with no open question does nothing (it is only logged), and so does a comment without the commit. A comment with any other text, a quote (`>`), a code block or upper case is not a command and does nothing, and so does an edit or the deletion of a comment (an answer given stays given). While a question is open, the [decision comment](#the-decision-comment) and the check run list the exact commands, with the commit and the question.

**Who may answer.** Checked with GitHub every time an answer comes in; nothing is kept from one answer to the next. People are compared by their account id, not their login (a login can be renamed).

- A person: GitHub sends the event for a `User`, never a bot, an app or a deleted account (`ghost`).
- With write access to the repository: GitHub's collaborator permission is `write` or `admin` (maintain counts as write).
- Not the author of the pull request.
- Not the person who pushed the head commit: the newest push to the head branch in the repository's activity must have pushed this commit, and its pusher is refused. When this cannot be read, the answer is refused. Only that newest push is looked at: someone who pushed earlier commits of the pull request may answer.

GitHub answering "not found" for a person's permission counts as no write access.

**What else is checked.** The pull request is still open, it is not from a fork, and its head is the commit the question is about. The question is still open: the connector's own record says so, and so does Pointsman when the connector reads it back. Then the connector resolves the question as `github:<login> (<account id>)`, without `correct`, so the answer adds no feedback on the model's answers ([reviews.md](reviews.md)). Pointsman resolves a question once: if someone answered first (in the review queue, or another person at the same moment), that answer stands, and the connector acts on it instead.

**What follows.** The answer goes through the same [actions](#actions) table and rules as any decision: only a mapped action is done, at most once per head commit, and `approve` only on the commit the question was about. The check run's title becomes the answer with ": answered by <login>", and the decision comment shows "answered by <login>" in the column "Set by" and in its details, without `@`.

**When an answer is not taken.** Nothing is resolved. The connector logs why, with the decision id and never the login, and adds a short fixed line to the check run, for example "An answer was not taken: the author of the pull request cannot answer." It writes no reply comment, so many comments cannot make it write many comments. When GitHub or Pointsman cannot be read, the answer is refused too ("answer again"): it is not tried again on its own. A second answer to a question that is answered already, a click on an older head's check run, and a command that no open question offers do nothing.

**Limits.** Per pull request and clock hour (a fixed window, from :00 to :59): at most 3 answers from one account, at most 30 answers that call GitHub (a read of the pull request, or a note on the check run for an answer that is bound to no open question), and at most 10 that pass the checks of the pull request (open, head, author, fork) and so cost a permission lookup. So someone without write access cannot use up the lookups before a person who may answer. An answer refused because GitHub or Pointsman failed ("answer again") does not count toward the person's 3. The first answer over any cap in the hour adds a line to the check run; more add nothing. A known limit: many accounts together (30 answers from 10 or more accounts) can use up the hour's reads, and then nobody can answer in the pull request until the next hour; the review queue still works. At most 5 answers wait at a time; more are dropped. GitHub's rate limit is shared with the rest of the connector. A taken answer starts a run of the pull request, which may ask Pointsman about its other profiles. The answer is acted on only if what the question rests on did not change between the question and the answer (an edit of the title in between closes the question on the next run, and the answer is not acted on).

**Not answered in the pull request:**

- A pull request from a fork: the connector's token reads only the one repository, so who pushed to the fork's branch is not known, and the answer is refused.
- A GitHub review: an approval or a change request does not answer the question.
- Code owners: who may answer is decided by write access only.

**Personal data.** Who answered (the login and the account id) is kept in the decision log as `resolved_by`, for as long as the log keeps its decisions; the operator decides how long. It is shown by `GET /v1/decisions/{id}` and `replay`, sent to a callback if a client set one, and shown as "answered by <login>" in the pull request.

**Switching it on.** In the connector app's settings on GitHub:

- For the buttons: "Checks: Read and write" (the connector has it already), "Contents: Read", and subscribe to the event "Check run". The connector reads a person's permission with "Metadata: Read", and who pushed the head from the repository's activity, which GitHub lists only with "Contents: Read" (GitHub's [permissions for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)). With answers on, the connector's tokens ask for `contents: read`; they never ask to write contents.
- For the command as well: "Issues: Read", and subscribe to the event "Issue comment".
- In the repository's ruleset, keep "Dismiss stale pull request approvals when new commits are pushed" and "Require approval of the most recent reviewable push". Switch answers on only where everyone with write access may approve the pull requests in question.

## The decision comment

One comment per pull request shows the latest decision of each chosen profile, railway style. It is off by default; a deployment switches it on in `GITHUB_CONNECTOR`, with the profiles it shows:

```json
{
  "repos": ["owner/name"],
  "profiles": ["pr-risk", "pr-next-step"],
  "comment": { "profiles": ["pr-risk", "pr-next-step"] },
  "signals": {
    "pr-risk": { "approvable": { "signal": "green", "text": "low risk" }, "release": "green", "risky": "red", "incomplete": "yellow" },
    "pr-next-step": { "approve": "green", "done": "green", "ask-person": "red", "wait": "yellow", "queue": "yellow" }
  }
}
```

The comment for that pull request, when `pr-risk` decided `approvable` by its rule 3 and `pr-next-step` decided `ask-person` by its rule 8:

````markdown
<!-- pointsman decision-comment -->
### 🚦 Pointsman

| Profile | Signal | Decision | Set by |
| --- | --- | --- | --- |
| `pr-risk` | 🟢 low risk | `approvable` | rule 3 |
| `pr-next-step` | 🔴 needs a person | `ask-person` | rule 8 |

```text
 draft       ready      reviewed    approved     merged
━━━●━━━┿━━━┿━━━●━━━┿━━━┿━━━○━━━┿━━━┿━━━○━━━┿━━━┿━━━○━━━
               ▲ ready for review
```

<details><summary><code>pr-risk</code>: why <code>approvable</code></summary>

```text
pr-risk @ 1a2b3c4
┃ facts  ✓ 1 read
┃ AI     matches_title: yes
┃
┡━━━┿━━━┿━━━ approvable  ← rule 3
│
└───┼───┼─── later rules and the default: not taken
```

</details>

<details><summary><code>pr-next-step</code>: why <code>ask-person</code></summary>

```text
pr-next-step @ 1a2b3c4
┃ facts  ✕ 1 of 3 missing: ci (timeout)
┃ AI     – none asked
┃
┡━━━┿━━━┿━━━ ask-person  ← rule 8
│
└───┼───┼─── later rules and the default: not taken
```

</details>

<sub>For commit 1a2b3c4. One comment, updated when a decision changes; the check runs `Pointsman: <profile>` have the decision ids.</sub>
````

The check run `Pointsman: pr-next-step` of the same decision is titled `🔴 ask-person (shadow)` (or `🔴 ask-person` with an action mapped), and has the line and its switch as details.

What it shows:

- **Signal**: one per profile, always with a word next to the colour (screen readers read the word). See [Signals](#signals).
- **Line**: the pull request's progress. The station names sit above the rail; the train (`▲`) stands under its station, and that station and the ones before it are filled (`●`: passed), the ones ahead empty (`○`). Passed means the train went by, not that each step happened: a pull request opened ready for review never was a draft, and one merged without a review still has `reviewed` and `approved` filled. The train's station comes from GitHub, read on each run:
  - `merged`: the pull request was merged. `closed without merging` under the line, no train and nothing filled: it was closed without a merge.
  - `draft`: it is a draft (its reviews are not read).
  - `approved`: GitHub's own review decision (GraphQL `reviewDecision`) is `APPROVED`: what the merge box shows under the repository's rules (branch protection or rulesets). The rules decide whose approvals count, how many are needed and whether a new commit dismisses them, so a bot's approval (CodeRabbit's, say) counts where the rules count it, and a drive-by approval in a public repository never does. `CHANGES_REQUESTED` and `REVIEW_REQUIRED` are never `approved`. A repository with no review rule gets no decision from GitHub (`null`): the train is then never at `approved`, only at `reviewed`. The caption says `approved by Pointsman on this commit` when the connector's own latest review is an approval of the current head; `approved on this commit` when someone else's is; else only `approved` (the rules keep an approval of an older commit after a push).
  - `reviewed`: someone other than the author reviewed the current head commit (a comment, a change request or an approval; a review that was dismissed does not count).
  - `ready`: none of these.

  The comment shows no reviewer and nothing of a review's text. The review decision and the newest 100 reviews come from one GraphQL query (a read; the token's **Pull requests: Read** is enough), once per run that draws the line, with or without the comment, and again after the run approved or dismissed an approval; not for a draft or a closed pull request. When it cannot be read (an HTTP error, GraphQL errors such as a rate limit, or a push since the pull request was read), the run goes on (logged): the train stays where the last read put it on this head commit, else at `ready`; after the connector dismissed its own approval, never at `approved`. A check run's line is drawn when that check run is written: if a later profile of the same run approves, an earlier profile's check run still shows the line before that approval until the next run, while the comment shows `approved`.
- **Switch**: why the decision took its track, from the decision itself. The track passes the facts (how many were read, which are missing, with the engine's reason) and the AI answers' values (yes/no, the chosen option, a level; not the probabilities), then reaches the points. Rules are checked in order and the first that matches sets the action: the rule's points send the train onto the heavy track (`━`) with its action and rule, and the light track (`─`) is the one not taken. With no rule matched, the rules' track is the light one and the train goes on to the default. Only these two tracks are drawn: the decision does not say which actions the other rules or the default would give. A line says when a person still checks the decision. The same as the check run shows; no fact values, no text of the pull request.
- **Drawing**: so it lines up in every monospace font, names, rules and reasons only come at the end of a line, after the rails; the drawing has no emoji (the signals are in the table); every rail line is only box characters up to its text, all of a kind that a Japanese font may draw two columns wide, so such a font only widens the drawing. In such a font, the station names and the train (after spaces) can stand slightly off their stations; the filled station on the rail is always right. No line is wider than 60 columns, so it does not wrap on a phone: a long list goes on more lines, and a name that is still too long is cut with `…` (the table has a profile's and an action's name in full, the check run's summary a fact's).

Rules:

- **One comment, updated in place**, never a new one per decision. The connector finds it by its first line, the hidden marker `<!-- pointsman decision-comment -->`, and only among comments by its own bot account (`<app slug>[bot]`, as for [its approvals](#actions)). A person's or another app's comment with the same marker is never read or edited. If the comment was deleted, the next change writes a new one.
- **Only when it changed**: the comment holds no decision ids or times, so a new decision with the same action, rule, facts and answers changes nothing and makes no comment write. At most one write per run (the update, or the first comment).
- **Recorded before the write**, like the actions: a run that stops while writing leaves the record open, and the next run writes it again (it finds the comment by its marker first, so there is never a second one).
- **Closed** (merged or not): with the comment on, the connector also takes the pull request's `closed` event. It does not ask Pointsman, writes no check run and reads no reviews: it updates the comment once, with the line at `merged` or `closed without merging` and the decisions it showed last (of the commit they were made on). Later events for the closed pull request change nothing, so they make no write. A write that fails because GitHub is busy is tried again by the run itself (no later event would come). Without a comment yet, none is written. Reopened, the pull request is run as usual again.
- **A new head commit** starts with no decisions shown; profiles not asked on it (a draft with `skip_drafts`) are left out until they decide.
- **Test decisions and invalid answers** ([Safety](#safety)) never put anything in the comment: it keeps the profile's last real decision on this commit. One exception: when such an answer made the connector withdraw the profile's approval of this commit ([When the approval stays](#when-the-approval-stays)), that profile's row is removed (its last decision no longer stands), and the reviews are read again: the train goes where GitHub's state puts it now (`reviewed`, or still `approved` when other approvals count). If that read fails, the train is not at `approved`.
- **Nothing left to show** (every row removed, or no profile has decided on a new commit yet, for example a draft with `skip_drafts`): an existing comment is updated to a short neutral text, "No decision to show for commit `<commit>`", with the line; it is not deleted, so the pull request keeps one comment in one place. Without a comment yet, none is written.
- **Failures** never stop the run or the actions. Refused by GitHub (no permission): logged, noted on the run's check runs, and not tried again until the comment's text changes. Busy or rate limited: noted on the check runs, and the next run writes it.
- **Nothing from the pull request**: the comment never shows the title, the description or the diff. Profile and action names are checked names; the engine's fact reasons are cut to 40 characters of letters, digits and plain punctuation; an AI answer's option is shown only when it is a plain name; and all of it is in code blocks. So text in the pull request cannot add markdown, HTML, links or mentions to the comment.

`comment.profiles`: 1 to 10 profiles of `profiles`, shown in the order of `profiles`. The comment needs the connector app's permission **Pull requests: Read and write** (comments on a pull request are issue comments); the connector's tokens then ask for it, still only for the one repository.

### Signals

Each decision gets a signal: red (a person or a review is needed), yellow (waiting) or green (go). A deployment sets them per profile and action in `signals`: either the colour (`"red"`), or the colour and the word shown next to it (`{ "signal": "red", "text": "look at the code" }`; 1 to 40 letters, digits, spaces and `, . ' ( ) -`, so no link or emoji code). The signals are used in the comment and in every check run's title, also without the comment.

Without one, these defaults apply:

| Action | Signal |
| --- | --- |
| `review`, `ask-person` | 🔴 needs a person |
| `wait`, `in-progress`, `queue`, `retry` | 🟡 waiting |
| `approve`, `pass`, `done` | 🟢 go |
| any other | 🟡 decided: `<action>` |
| any decision a person still checks (`review: pending`) | 🔴 a person checks first |

## Chains

Profiles can build on each other ([decision-chains.md](decision-chains.md)): for example a first profile sorts the pull request into a risk class with AI questions, and a second one, rules only, decides the next step from that class and the review state. The connector runs such a chain when `GITHUB_CONNECTOR` has `runs`, by profile:

```json
{
  "repos": ["owner/name"],
  "profiles": ["pr-risk", "pr-next-step"],
  "runs": {
    "pr-risk": { "skip_drafts": true, "once_per_head": { "rerun": ["incomplete"] }, "diff": 30000 },
    "pr-next-step": { "requires": { "risk": "pr-risk" }, "recheck": { "actions": ["wait", "queue"], "minutes": 10, "max": 12 } }
  }
}
```

| Key | What it does |
| --- | --- |
| `requires` | Sends the decision of an earlier profile of the same run as `decisions`, by the name in the profile's `requires`. Only a profile listed before this one. When the earlier profile was not asked (a draft with `skip_drafts`), nothing is sent for it, so that requirement should be `optional` in the profile. |
| `skip_drafts` | Not asked while the pull request is a draft (no model calls for work in progress). |
| `once_per_head` | Asked once per head commit, title, description, base branch, draft state, required decisions, `runs` settings and `actions` of the profile; the next runs reuse that decision (also for `requires`) without asking again. `rerun`: actions after which it is asked again on the next run, for example the action of a rule for missing facts. A decision is kept only once its check run is written and its action done (or none is mapped), and never while a person checks it. A new version of the profile applies from the next commit or edit. Facts that change without a new commit (checks, reviews) are not read again for a kept decision, so use it for profiles whose answer rests on the commit. |
| `diff` | Adds the pull request's unified diff to the state as `diff`, cut to this many characters (1,000 to 100,000), with `diff_truncated`. GitHub gives no diff for very large pull requests, and for a private repository only to a token that may read its contents (the app's **Contents: Read-only**; the connector then asks for it): without one, `diff` is empty and `diff_truncated` is true, the run goes on, and a `once_per_head` decision made so is not kept. A profile that reads `diff` must treat `diff_truncated: true` as "not known" and be strict: an empty diff does not mean no change. The head is read again after the diff; a push in between means the run is tried again. The diff goes to the profile's model like the rest of the state, and to the decision log only where the profile keeps the state (`log.store_state`). It is text the author wrote: like the title, it can only make AI answers stricter in a careful profile. |
| `recheck` | While the decision's action is one of `actions`, asks again after `minutes` (5 to 120) without a new event, at most `max` times per head commit (default 12). For decisions that wait, for example for a free review. A recheck is a run: every profile is asked again, except kept ones. With `once_per_head`, the `actions` must also be in `rerun`. |

Without `runs`, every profile is asked on every run with the title and the description, as before.

## The two GitHub apps

The part that reads pull-request text (the engine, with its AI questions) never holds a key that can write. So a deployment has two apps, as the design asks:

| App | Used by | Permissions (repository) | Webhook |
| --- | --- | --- | --- |
| Facts (read-only) | the Pointsman Worker, for its GitHub facts (`FACTS_GITHUB: app`) | Read: Metadata, Contents, Pull requests, Checks, Commit statuses, Actions, Custom properties. Organization: Members (read) | none |
| Connector | the connector Worker | Read and write: Checks. Read: Pull requests (read and write for [actions](#actions) and [the decision comment](#the-decision-comment)), Metadata; Contents read for a profile with `diff` in a private repository ([Chains](#chains)) and for answers in the pull request; Contents read and write for an approval that counts ([Actions](#actions)); Issues read for the comment command ([Answering in the pull request](#answering-in-the-pull-request)) | on: Pull request, Pull request review, Check suite; Check run for the buttons, Issue comment for the command |

Notes:

- The facts' tokens are down-scoped too: the engine asks GitHub for a token with only the permissions the facts use (those above), and only as `read`. So even a facts app with more or write permissions gives the engine a token that only reads what it needs.
- A GitHub App can read the checks of private repositories. A fine-grained personal access token cannot (it has no Checks permission), so with a token the fact `github_checks` is `unavailable` on private repositories.
- Members (organization) is needed only to count teams in CODEOWNERS (`author_sole_code_owner`); Custom properties only for `github_property`; Actions only for `github_checks` (required workflows).
- Install both apps only on the repositories the connector handles.

## Settings

The connector Worker ([connectors/github/wrangler.jsonc](../connectors/github/wrangler.jsonc)):

| Name | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | The connector app's id (a number) |
| `GITHUB_APP_PRIVATE_KEY` | Secret: the connector app's private key (PEM, as GitHub gives it) |
| `GITHUB_WEBHOOK_SECRET` | Secret: the webhook secret set in the app (at least 20 characters) |
| `GITHUB_CONNECTOR` | JSON: `{ "repos": ["owner/name", …], "profiles": ["pr-docs-check", …] }`, optionally `"actions"` ([Actions](#actions)), `"runs"` ([Chains](#chains)), `"comment"` ([The decision comment](#the-decision-comment)), `"signals"` ([Signals](#signals)) and `"answers"` ([Answering in the pull request](#answering-in-the-pull-request)) |
| `POINTSMAN_URL` | Pointsman's base URL (https). Not with `POINTSMAN` |
| `POINTSMAN_TOKEN` | Secret: a Pointsman API token for the connector's client, limited to its profiles. Not needed with `POINTSMAN` |
| `POINTSMAN` | Instead of the two above: a service binding to the engine Worker's entrypoint `InternalEngine` ([Internal call](#internal-call)) |
| `PULL_REQUESTS` | The Durable Object binding (class `PullRequest`) |

The Pointsman Worker, for facts through the facts app: `FACTS_GITHUB: "app"`, `FACTS_GITHUB_APP_ID`, and the secret `FACTS_GITHUB_APP_PRIVATE_KEY`. For the internal call: `INTERNAL_CLIENT`, JSON `{"client": "github-connector", "profiles": ["pr-docs-check", …]}`.

## Setting it up

1. Create the two apps (GitHub: your organization's Settings → Developer settings → GitHub Apps → New GitHub App), with the permissions above, "Only on this account". The facts app has no webhook ("Active" off). The connector app's webhook URL is `https://<connector Worker>/webhook`, with a secret made by `openssl rand -hex 32`.
2. Generate a private key for each app, and install each app on the repositories.
3. Make a Pointsman token for the connector: `node scripts/tokens.mjs create --client github-connector --profiles pr-docs-check,workflow-check --remote`. Or, with the engine Worker in the same account, use an [internal call](#internal-call) instead: no token.
4. Put the secrets in with `wrangler secret put <NAME>` (for the connector: `--config connectors/github/wrangler.jsonc`). Paste them only into wrangler, never into a file or a chat.
5. Deploy the connector Worker with `wrangler deploy --config connectors/github/wrangler.jsonc`, then the Pointsman Worker with `FACTS_GITHUB: "app"`.
6. Open or update a pull request: the check runs `Pointsman: <profile>` appear with the conclusion `neutral`.

## Not yet

- **Check-run conclusions** other than `neutral` (for example `failure` for a decision that should block): the design leaves them open.
- **Paid reviews and CodeRabbit commands** (the design's `pay`, `coderabbit-approve`, `check`, `request-review`): not in the list of actions. CodeRabbit ignores commands from a GitHub App (pointsman#220), so a person or an agent posts them. Copilot reviews are [`copilot_review`](#copilot-reviews).
- **Commit statuses.** A `status` event names a commit, not a pull request, so it starts no run; a finished check suite does.
- **One commit in two pull requests** (one branch to two bases) gets a check run from each.
- **Pull requests from forks.** GitHub lists no pull requests on a fork's check suites, so only the pull request's own events start a run.
- **Re-deciding on a timer** only for profiles with `recheck` ([Chains](#chains)); others are decided again on the next event.
- **Answering inside the pull request** from a fork, by code owners, or with a GitHub review ([Answering in the pull request](#answering-in-the-pull-request)).
