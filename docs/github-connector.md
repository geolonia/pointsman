# GitHub connector

The GitHub connector asks Pointsman about pull requests and shows each decision on the pull request as a check run. It is the connector role of the module `@pointsman/github` ([connectors.md](connectors.md)); the same module's fact role reads pull requests for the engine ([profile-format.md](profile-format.md#facts)).

For now it runs in **shadow mode**: it only writes its check runs, with the conclusion `neutral`, so they never block a merge. Pointsman acts on nothing else.

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

Title and body are cut to 300 and 8,000 characters. Pointsman reads every fact from GitHub itself, with its own app (below). The idempotency key covers the profile, this state, the draft flag, the base branch and a count of the pull request's events, so a retry of the same run gets the decision already logged, and each new event (for example finished CI) a new decision.

### Safety

- **Signature.** Every webhook must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the body with the webhook secret); others get 401 before the body is parsed. Bodies over 2 MB get 413, also without a Content-Length (the body is read only up to the limit).
- **Replays.** GitHub signs only the body, so a replayed webhook could carry a new delivery id. Each pull request's object remembers delivery ids and body hashes for 7 days and drops a repeat. And the event is only a hint: the connector reads the pull request again with its own token, so even a replay that got through would only check the current state again.
- **Only its repositories.** Events for other repositories are ignored. Its own check runs' events are ignored too, so a check run does not start the next run.
- **One check run per profile and head.** The record of a check run is written before the check run is created. If a run stops in between, the next run first looks for the check run on GitHub and updates it, instead of creating a second one. Later decisions on the same head update the same check run.
- **Retries.** When GitHub or Pointsman is busy, down or not reached (5xx, 429, a network error or timeout), the run is tried again later (the Durable Object's alarm, a few times with growing delays). When Pointsman refuses (another 4xx) or the app cannot do it (not installed, no permission, a broken key), it is a setting to fix: the error is logged without the token or key, and nothing is shown on the pull request. In both cases the next event of the pull request starts a new run; a redelivery of the same webhook from GitHub's settings is dropped as a replay.
- **Write access only here.** Only the connector has the key of the app that can write, and only in its own Worker. Its tokens are down-scoped to what it needs (read pull requests, write check runs) and to the one repository.
- **Check runs deleted on GitHub** are made again on the next run.

## The two GitHub apps

The part that reads pull-request text (the engine, with its AI questions) never holds a key that can write. So a deployment has two apps, as the design asks:

| App | Used by | Permissions (repository) | Webhook |
| --- | --- | --- | --- |
| Facts (read-only) | the Pointsman Worker, for its GitHub facts (`FACTS_GITHUB: app`) | Read: Metadata, Contents, Pull requests, Checks, Commit statuses, Actions, Custom properties. Organization: Members (read) | none |
| Connector | the connector Worker | Read and write: Checks. Read: Pull requests, Metadata | on: Pull request, Pull request review, Check suite |

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
| `GITHUB_CONNECTOR` | JSON: `{ "repos": ["owner/name", …], "profiles": ["pr-docs-check", …] }` |
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

- **Actions.** Comments, labels, review requests and approvals, each at most once per head with a record written first, switched on per profile action by the deployment (#147). Until then the connector's only action is its check run.
- **Commit statuses.** A `status` event names a commit, not a pull request, so it starts no run; a finished check suite does.
- **One commit in two pull requests** (one branch to two bases) gets a check run from each.
- **Pull requests from forks.** GitHub lists no pull requests on a fork's check suites, so only the pull request's own events start a run.
- **Re-deciding on a timer.** A decision is made again only on the next event.
