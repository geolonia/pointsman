---
title: Review pull requests with Pointsman
description: Let Pointsman decide what each pull request needs, from a check run to an approval on facts alone, step by step.
sidebar: { order: 30 }
---

Pointsman can decide what a pull request needs next: a light review, a
person, a fix, or an approval. The GitHub connector asks a profile for each
new commit and shows the decision on the pull request. This guide takes a
deployment from "only shows" to "approves", one step at a time.

You need a deployment of Pointsman ([Deploy Pointsman](../deployment.md))
with the module `@pointsman/github`, and the GitHub connector set up with
its two GitHub apps ([GitHub connector](../github-connector.md#setting-it-up)).

## 1. Start in shadow mode

By default the connector only writes a check run with the decision, with the
conclusion `neutral`, so it never blocks a merge. Leave it like this for a
while and compare its decisions with what people do. The check run says
which action it would take and why.

## 2. Choose the profiles

The connector asks the profiles listed in `GITHUB_CONNECTOR`. Start from the
examples ([developer workflow](../../examples/developer-workflow/README.md)):

- `pr-docs-check`: does a pull request change only documentation, so that a
  light review is enough?
- `workflow-check`: are the GitHub Actions files it changes safe to merge?

Your own profiles live in your configuration repository. Their rules read
GitHub facts, such as the changed files, the checks and who pushed
([fact types](../reference/fact-types.md)).

## 3. Switch on actions

Map a profile's decision actions to what the connector does, in
`GITHUB_CONNECTOR`. An action that is not mapped stays a check run only.
Here the action `light` adds a label:

```json
{
  "repos": ["owner/name"],
  "profiles": ["pr-docs-check"],
  "actions": {
    "pr-docs-check": {
      "light": { "do": "label", "labels": ["docs-only"] }
    }
  }
}
```

The connector can comment, add labels, request reviewers, approve, and keep
an approval. It does each at most once per commit, and nothing while a
person still checks the decision ([Actions](../github-connector.md#actions)).
So do not map an action that a person checks first (by default `review`):
nothing would happen until the person is done.

## 4. Let Pointsman approve

Map an action to `approve` only when the profile's rules can carry it:

- **Permissions.** An app's approval counts toward the required approvals
  only when the connector app has Contents and Pull requests with read and
  write ([the two apps](../github-connector.md#the-two-github-apps)).
  Without them the approval is shown but does not count. The connector's
  check run is always `neutral`, so it cannot replace an approval as a
  required check.
- **Dismiss stale approvals.** Turn on "Dismiss stale pull request approvals
  when new commits are pushed" in the branch's ruleset (the branch's
  protection settings on GitHub). The connector also
  dismisses its own older approvals, but only on its next run.
- **Code owners.** An app cannot be a code owner: where `CODEOWNERS` (the
  file that names who must review which files) covers
  a changed file and the ruleset requires a code owner's review, a person
  must still approve.
- **Forks** are never approved.
- **Approvals that stay.** A later decision on the same commit withdraws the
  approval, unless it maps to `approve` or `keep_approval`. Use the fact
  `github_app_approval` and `keep_approval` so that, for example, a review
  by an AI review service after the approval does not take it away
  ([when the approval stays](../github-connector.md#when-the-approval-stays)).

## 5. Release and dependency pull requests on facts alone

Some pull requests need no AI answer at all:

- a release pull request that only moves version fields and adds to the
  changelog (`github_release`);
- a Dependabot pull request that only bumps npm development dependencies by
  a patch step (`github_bump`; a step counts as `patch` only from version
  1.0.0 on, a 0.x patch step counts as `minor`).

Pair either fact with `github_pr` (author, signatures, who pushed), because
neither says who made the change. To make the dependency case common, group
Dependabot's development patch bumps into their own pull requests. A
dependency goes to the first group it matches, so this group comes first,
and everything else goes into a second pull request that gets a normal
review:

```yaml
# .github/dependabot.yml
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      npm-dev-patch:
        dependency-type: development
        update-types: [patch]
      npm:
        update-types: [minor, patch]
```

If an AI review service also reviews these pull requests, its review changes
what the profile sees. Let it skip them. For CodeRabbit, give release pull
requests a title that starts with `Release 0.` and ignore that title in the
repository's `.coderabbit.yaml` (the keyword matches anywhere in the title,
so do not use just `Release`; from version 1.0, use `Release 1.`). This
skips every pull request whose title contains the keyword, not only release
pull requests: an author can put it into another title to avoid the AI
review. The profile's rules still decide; only the AI review is lost for
that pull request. The setting:

```yaml
reviews:
  auto_review:
    ignore_title_keywords: ["Release 0."]
```

## Where to go next

- [GitHub connector](../github-connector.md): every action, setting and
  limit.
- [Fact types](../reference/fact-types.md): the fields of every GitHub fact.
- [How a decision is made](../explanation/decision-model.md#ai-answers-only-make-a-decision-stricter):
  why AI answers alone never let a pull request pass.
