# Pointsman for developer workflow

New issues need a first look: which team, is it urgent, how big is it?
Pointsman answers these questions for every new issue. When it is sure, the
issue gets labels at once; when it is not, a person decides.

Pull requests need a next step too. Pointsman can read a pull request from
GitHub itself (its files, checks and commits), so the client only names it
and cannot claim "docs only" or "checks passed".

## Profiles

| Profile | Decides | Actions |
|---|---|---|
| [`issue-triage`](../profiles/issue-triage.yaml) | Which team should handle the issue, does it block work today, how much work does it look like? | `auto`, `review` |
| [`pr-docs-check`](../profiles/pr-docs-check.yaml) | Does a pull request change only documentation, so that a light review is enough? Reads the pull request from GitHub ([GitHub facts](../../docs/profile-format.md#github-pull-requests)). | `light`, `review`, `wait`, `retry`, `done` |
| [`workflow-check`](../profiles/workflow-check.yaml) | Are the GitHub Actions files a pull request changes safe to merge? Pointsman reads and parses them itself ([GitHub workflows](../../docs/profile-format.md#github-workflows)). | `pass`, `fix-…`, `review`, `retry` |

The profile is visible through MCP, so agents can ask it too
([docs/mcp.md](../../docs/mcp.md)).

## Client

- [Issue triage](../../actions/triage/): a GitHub Action that labels new
  issues from the decision, using only the labels you list. When Pointsman is
  not sure, or cannot be reached, the issue gets `needs-triage` instead.

## Try it

Run Pointsman locally with a mock model (see the
[README](../../README.md#development)), then:

```sh
node scripts/tokens.mjs create --client demo --profiles issue-triage --local
export POINTSMAN_TOKEN=pm_…   # the token printed above
curl -s localhost:8787/v1/decide/issue-triage \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state": {"issue": {"title": "Login page is blank"}}}'
```

The mock model gives fixed answers. For real answers, see
[docs/models.md](../../docs/models.md).
