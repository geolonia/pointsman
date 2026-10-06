# Pointsman issue triage

A GitHub Action that asks a Pointsman decision profile about every new issue
and labels it:

- Pointsman is sure (action `auto`): the labels you mapped to its answers.
- Pointsman is not sure (any other action, usually `review`): only a review
  label (`needs-triage`), so a person decides.
- Pointsman cannot be reached or fails: the review label, and the step fails
  so the problem is visible.

Only labels you list in `labels` are ever applied. The issue text is sent to
Pointsman as JSON data; it is never used in a shell command.

## Example workflow

`.github/workflows/triage.yml`, with the repository variable `POINTSMAN_URL`
and the secret `POINTSMAN_TOKEN` (an API token for the profile, see
[docs/deployment.md](../../docs/deployment.md)):

```yaml
name: Triage

on:
  issues:
    types: [opened, reopened]

permissions: {}

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      issues: write
    steps:
      # Pinned to a full commit SHA; update it to a later commit to get changes.
      - uses: geolonia/pointsman/actions/triage@0b569edc13966977a476b70b02c1c51cff191964 # main 2026-10-06
        with:
          url: ${{ vars.POINTSMAN_URL }}
          token: ${{ secrets.POINTSMAN_TOKEN }}
          profile: issue-triage
          labels: |
            team=backend: team/backend
            team=frontend: team/frontend
            team=docs: documentation
            urgent=true: urgent
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `url` | (required) | Base URL of the Pointsman Worker |
| `token` | (required) | Pointsman API token; store it as a secret |
| `profile` | `issue-triage` | Decision profile id |
| `labels` | (required) | Allow-list, one per line: `<question>=<value>: <label>`. Values are options (`choice`), `true`/`false` (`noul`), or levels (`score`, `0` = lowest). Lines starting with `#` are ignored. |
| `review-label` | `needs-triage` | Added when Pointsman asks for a review or fails |
| `github-token` | `${{ github.token }}` | Token used to add labels (needs `issues: write`) |

## Outputs

| Output | Meaning |
|---|---|
| `decision-id` | The Pointsman decision id (for feedback: `POST /v1/decisions/{id}/feedback`) |
| `action` | `auto`, `review`, another profile action, or `error` |

The job summary shows the answers, their probabilities and the labels added.
GitHub creates labels that do not exist yet.
