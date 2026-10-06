# Pointsman deploy watch

Runs a deploy command (for example `cdk deploy`) and stops it when its
CloudFormation stack is stuck, instead of waiting for the job timeout or for
CloudFormation's own, often much longer, timeouts.

How it decides:

1. **Rule first.** While a watched stack gets new events, the deploy is making
   progress and nothing is asked. Only after `quiet-minutes` without a new
   event is the case unclear.
2. **Pointsman for unclear cases.** The recent stack events (resource, type,
   status, reason) and the quiet time go to a decision profile (default
   [`deploy-progress`](../../examples/profiles/deploy-progress.yaml)). Its
   policy returns `cancel` when the deploy is stuck.
3. **Cancel only when sure.** The deploy is stopped after `consecutive`
   (default 2) `cancel` answers in a row; any other answer starts the count
   again. Then the command's process group is stopped and, for stacks in
   `UPDATE_IN_PROGRESS`, `aws cloudformation cancel-update-stack` runs.

If Pointsman cannot be reached, nothing is cancelled; the deploy keeps
running. The step's exit code is the command's, or 1 after a cancel.

## Example

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions: {}

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    permissions:
      contents: read
      id-token: write   # AWS OIDC
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: aws-actions/configure-aws-credentials@<commit SHA>
        with:
          role-to-assume: ${{ vars.DEPLOY_ROLE_ARN }}
          aws-region: ap-northeast-1
      # Pin to a full commit SHA of geolonia/pointsman.
      - uses: geolonia/pointsman/actions/deploy-watch@<commit SHA>
        with:
          run: npx cdk deploy AppStack --require-approval never
          stacks: AppStack
          url: ${{ vars.POINTSMAN_URL }}
          token: ${{ secrets.POINTSMAN_TOKEN }}
          quiet-minutes: '15'
```

The role needs `cloudformation:DescribeStackEvents`, `DescribeStacks` and,
with `cancel-update: 'true'` (the default), `CancelUpdateStack` for the
watched stacks, besides what the deploy itself needs.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `run` | (required) | The deploy command, run with bash. Set it in the workflow; never build it from event data. |
| `stacks` | (required) | Stack names to watch, comma separated |
| `url`, `token` | (required) | Pointsman Worker URL and API token (secret) |
| `profile` | `deploy-progress` | Profile whose policy returns `cancel` for a stuck deploy |
| `quiet-minutes` | `15` | Minutes without a new stack event before Pointsman is asked |
| `interval-seconds` | `60` | How often the stacks are checked |
| `consecutive` | `2` | `cancel` answers in a row needed to stop the deploy |
| `cancel-update` | `true` | Also cancel stack updates in progress |

Output `result`: `finished` or `cancelled`.

## Notes

- Events from before the command started are ignored, so an old stack does
  not count as quiet.
- A stack that does not exist yet (first deploy) counts as quiet since the
  start until its first event.
- Pointsman calls are logged with `ref: github:<repo>/actions/runs/<run id>`,
  so the decisions can be found and corrected with feedback.
