# Pointsman for developer workflow

New issues need a first look: which team, is it urgent, how big is it?
Pointsman answers these questions for every new issue. When it is sure, the
issue gets labels at once; when it is not, a person decides.

## Profile

| Profile | Decides | Actions |
|---|---|---|
| [`issue-triage`](../profiles/issue-triage.yaml) | Which team should handle the issue, does it block work today, how much work does it look like? | `auto`, `review` |

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
