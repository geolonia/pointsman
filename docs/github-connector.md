# GitHub connector

The GitHub connector asks Pointsman about pull requests and shows each decision on the pull request as a check run. It is the connector role of the module `@pointsman/github` ([connectors.md](connectors.md)); the same module's fact role reads pull requests for the engine ([profile-format.md](profile-format.md#facts)).

By default it runs in **shadow mode**: it only writes its check runs, with the conclusion `neutral`, so they never block a merge. A deployment can switch on [actions](#actions) for chosen decisions: a comment, labels, a review request or an approval. The check runs stay `neutral`.

## How it works

1. GitHub sends a webhook for an event of a pull request (opened, new commits, ready for review, edited, a review, a finished check suite).
2. The connector checks the webhook's signature, then hands the event to the pull request's own object (a Durable Object), one per pull request.
3. That object runs the work for its pull request, one run at a time, 20 seconds after the event: a burst of events (several check suites finishing) becomes one run.
4. A run reads the pull request again from GitHub, asks Pointsman with each configured profile, and writes one check run per profile and head commit, `Pointsman: <profile>`.

What it sends to Pointsman: `POST /v1/decide/<profile>` with its own token, and

```json
{
  "state": { "pull_request": { "repo": "owner/name", "number": 7, "head": "<commit>", "title": "…", "body": "…" } },
  "ref": "github:owner/name#7@<commit>"
}
```

Title and body are cut to 300 and 8,000 characters. Pointsman reads every fact from GitHub itself, with its own app (below). The idempotency key covers the profile, this state, the draft flag, the base branch and a count of the pull request's runs, so every run asks anew (a retry too): an action never rests on an older answer, and each new event (for example finished CI) gets a new decision.

### Safety

- **Signature.** Every webhook must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the body with the webhook secret); others get 401 before the body is parsed. Bodies over 2 MB get 413, also without a Content-Length (the body is read only up to the limit).
- **Replays.** GitHub signs only the body, so a replayed webhook could carry a new delivery id. Each pull request's object remembers delivery ids and body hashes for 7 days and drops a repeat. And the event is only a hint: the connector reads the pull request again with its own token, so even a replay that got through would only check the current state again.
- **Only its repositories.** Events for other repositories are ignored. Its own check runs' events are ignored too, so a check run does not start the next run.
- **One check run per profile and head.** The record of a check run is written before the check run is created. If a run stops in between, the next run first looks for the check run on GitHub and updates it, instead of creating a second one. Later decisions on the same head update the same check run.
- **Retries.** When GitHub or Pointsman is busy, down or not reached (5xx, 429, a network error or timeout), the run is tried again later (the Durable Object's alarm, a few times with growing delays). When Pointsman refuses (another 4xx) or the app cannot do it (not installed, no permission, a broken key), it is a setting to fix: the error is logged without the token or key, and nothing is shown on the pull request. In both cases the next event of the pull request starts a new run; a redelivery of the same webhook from GitHub's settings is dropped as a replay.
- **Write access only here.** Only the connector has the key of the app that can write, and only in its own Worker. Its tokens are down-scoped to what it needs (read pull requests, write check runs; write pull requests only when actions are switched on) and to the one repository.
- **Check runs deleted on GitHub** are made again on the next run.

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

This is the whole list: a deployment can switch actions on, never add one. A decision action that is not mapped gets only its check run, as in shadow mode, and the check run says which action was done or why not.

Rules for every action:

- **At most once per head commit**, per profile and kind. The record is written before the action and closed after it. A new commit starts again.
- **A stop in between:** a record left open is settled by its trace on GitHub (the comment or approval with its marker, the labels, the requested reviewers). Without a trace, the action may be done again only after 10 minutes; the connector looks again then, also without a new event.
- **A person first:** while a person still checks the decision (the profile's `people_check`, `review: pending`), nothing is done.
- **Refused by GitHub** (no permission, a reviewer who cannot be asked): shown on the check run and logged, and not tried again for that commit. Busy or down: tried again later.
- **One record per profile and kind:** two decision actions of one profile mapped to the same kind (for example two `label` actions) are done only once per commit, whichever comes first.

For `approve` also:

- Only on the commit that was decided on: the pull request is read again right before, and nothing is done if its head changed, it is a draft or it was closed. The approval names that commit (`commit_id`).
- Never for a pull request from a fork.
- After a push, the connector dismisses its own approvals of older commits, on every run. It dismisses only approvals it recorded giving, never someone else's review.
- When a later decision on the same commit no longer approves (CI failed, a fact changed, a person must check it), its approval of that commit is withdrawn; a later approving decision may approve again.
- If an old approval cannot be dismissed, it approves nothing in that run.
- **Required:** the branch's ruleset (or branch protection) must have "Dismiss stale pull request approvals when new commits are pushed" on. Otherwise an approval of an older commit counts for merging until the connector's next run dismisses it.
- **Code owners:** an app cannot be a code owner (`CODEOWNERS` names users, teams and email addresses). Where the ruleset requires a code owner's review and `CODEOWNERS` covers a changed file, a person must still approve; the app's approval can still count toward the required number of approvals.

Actions need the connector app's permission **Pull requests: Read and write**. With only read, the token cannot write pull requests and every action fails (shown on the check run).

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
| `diff` | Adds the pull request's unified diff to the state as `diff`, cut to this many characters (1,000 to 100,000), with `diff_truncated`. GitHub gives no diff for very large pull requests: then `diff` is empty and `diff_truncated` is true. The head is read again after the diff; a push in between means the run is tried again. The diff goes to the profile's model like the rest of the state, and to the decision log only where the profile keeps the state (`log.store_state`). It is text the author wrote: like the title, it can only make AI answers stricter in a careful profile. |
| `recheck` | While the decision's action is one of `actions`, asks again after `minutes` (5 to 120) without a new event, at most `max` times per head commit (default 12). For decisions that wait, for example for a free review. A recheck is a run: every profile is asked again, except kept ones. With `once_per_head`, the `actions` must also be in `rerun`. |

Without `runs`, every profile is asked on every run with the title and the description, as before.

## The two GitHub apps

The part that reads pull-request text (the engine, with its AI questions) never holds a key that can write. So a deployment has two apps, as the design asks:

| App | Used by | Permissions (repository) | Webhook |
| --- | --- | --- | --- |
| Facts (read-only) | the Pointsman Worker, for its GitHub facts (`FACTS_GITHUB: app`) | Read: Metadata, Contents, Pull requests, Checks, Commit statuses, Actions, Custom properties. Organization: Members (read) | none |
| Connector | the connector Worker | Read and write: Checks. Read: Pull requests (read and write for [actions](#actions)), Metadata | on: Pull request, Pull request review, Check suite |

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
| `GITHUB_CONNECTOR` | JSON: `{ "repos": ["owner/name", …], "profiles": ["pr-docs-check", …] }`, optionally `"actions"` ([Actions](#actions)) and `"runs"` ([Chains](#chains)) |
| `POINTSMAN_URL` | Pointsman's base URL (https) |
| `POINTSMAN_TOKEN` | Secret: a Pointsman API token for the connector's client, limited to its profiles |
| `PULL_REQUESTS` | The Durable Object binding (class `PullRequest`) |

The Pointsman Worker, for facts through the facts app: `FACTS_GITHUB: "app"`, `FACTS_GITHUB_APP_ID`, and the secret `FACTS_GITHUB_APP_PRIVATE_KEY`.

## Setting it up

1. Create the two apps (GitHub: your organization's Settings → Developer settings → GitHub Apps → New GitHub App), with the permissions above, "Only on this account". The facts app has no webhook ("Active" off). The connector app's webhook URL is `https://<connector Worker>/webhook`, with a secret made by `openssl rand -hex 32`.
2. Generate a private key for each app, and install each app on the repositories.
3. Make a Pointsman token for the connector: `node scripts/tokens.mjs create --client github-connector --profiles pr-docs-check,workflow-check --remote`.
4. Put the secrets in with `wrangler secret put <NAME>` (for the connector: `--config connectors/github/wrangler.jsonc`). Paste them only into wrangler, never into a file or a chat.
5. Deploy the connector Worker with `wrangler deploy --config connectors/github/wrangler.jsonc`, then the Pointsman Worker with `FACTS_GITHUB: "app"`.
6. Open or update a pull request: the check runs `Pointsman: <profile>` appear with the conclusion `neutral`.

## Not yet

- **Check-run conclusions** other than `neutral` (for example `failure` for a decision that should block): the design leaves them open.
- **Paid reviews and review-service commands** (the design's `pay`, `coderabbit-approve`, `copilot`): not in the list of actions.
- **Commit statuses.** A `status` event names a commit, not a pull request, so it starts no run; a finished check suite does.
- **One commit in two pull requests** (one branch to two bases) gets a check run from each.
- **Pull requests from forks.** GitHub lists no pull requests on a fork's check suites, so only the pull request's own events start a run.
- **Re-deciding on a timer** only for profiles with `recheck` ([Chains](#chains)); others are decided again on the next event.
