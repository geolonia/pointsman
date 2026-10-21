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

The [README](../../README.md#development) runs this profile locally with a
mock model, in a few minutes.
