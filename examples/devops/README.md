# Pointsman for DevOps

A deploy that hangs can block a pipeline for an hour or more before a
timeout stops it. A simple rule catches most cases: while the stack gets new
events, the deploy is moving. Pointsman is asked only when the stack has been
quiet for a while, and the deploy is stopped only when it is clearly stuck.

## Profile

| Profile | Decides | Actions |
|---|---|---|
| [`deploy-progress`](../profiles/deploy-progress.yaml) | From the recent stack events and the quiet time: is the deploy stuck, and which phase is it in? | `cancel`, `review`, `continue` |

## Client

- [Deploy watch](../../actions/deploy-watch/): a GitHub Action that runs a
  deploy command (for example `cdk deploy`), watches its CloudFormation
  stacks, and stops the deploy after two `cancel` answers in a row (you can
  change the count). If Pointsman cannot be reached, nothing is cancelled.

## Try it

Run Pointsman locally (see the [README](../../README.md#development)) and
send recent stack events to `POST /v1/decide/deploy-progress`, or point the
action at your own deployment.
