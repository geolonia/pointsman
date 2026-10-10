# Pointsman

Pointsman sets the switches. Your systems ask a question, Pointsman decides
which track it goes on, or calls a human when it is not sure.

Website: https://geolonia.github.io/pointsman/

Status: early proof of concept. See the [PoC milestone](https://github.com/geolonia/pointsman/milestone/1).

## What it does, in plain words

Many systems receive things that someone must look at first. A resident
reports a closed road. A new issue arrives. A deployment seems stuck. Often
the case is clear, and the system can act at once. Sometimes it is not
clear, and a person should check it. Pointsman makes this first call, and it
keeps a record of every call.

An example from the [demo](https://pointsman-demo.geolonia.workers.dev): a
resident reports "a fallen tree blocks the road". Pointsman does three
things:

1. **It asks fixed questions.** What kind of closure is it? Could someone be
   in danger? Is the report clear? An AI answers each question and says how
   sure it is, for example "danger: yes, 85 %".
2. **People's rules decide.** People write the rules, for example "danger
   70 % or more: urgent" or "clear and consistent: publish". If no rule
   fits, a person checks the report. The AI does not decide alone. The rules
   can also use facts from public data, for example whether the place is in
   a flood zone.
3. **It answers with an action, and keeps a record.** Here the action is
   `urgent`. Pointsman saves the questions, the answers, the rule that it
   used, and the versions of everything.

When a person checks a case, they can correct the answers. Pointsman keeps
the corrections. So you can see how often the AI was right.

Pointsman works with different AI models and with different systems. One
use of Pointsman, with its questions and rules, is called a **profile**.
Other systems ask Pointsman over the web (an API). There are ready-made
clients: for AI agents, for GitHub, and for FIWARE smart-city data
platforms (the [bridge](bridge/)).

### Words used here

| Word | Meaning |
|---|---|
| Profile | One use of Pointsman: its questions and rules. Each change gets a new version number. |
| Question | Something the AI answers: yes or no, one choice from a list, or a score. Each answer comes with a probability (how sure the AI is). |
| Model | The AI that answers the questions. You can change it. Pointsman saves which model answered. |
| Rule | A condition that people write, for example "danger 70 % or more". The first rule that fits gives the action. If none fits, the default action applies. All rules of a profile together are its **policy**. |
| Action | The result, for example `publish`, `urgent` or `review`. |
| Review | The action "a person checks it". The person gives the final action and can correct the answers. |
| Facts | Data about a place that the rules can use, for example flood zones. Pointsman reads them from public data. The AI does not guess them. |
| FIWARE | Open-source software for smart-city data platforms. It uses NGSI-LD, an open standard for this kind of data (made by ETSI, a European standards body). The [bridge](bridge/) connects such a platform to Pointsman. |

## How a request looks

A client sends a state to `POST /v1/decide/{profile}`. The model answers the
profile's questions with probabilities, and the profile's policy turns the
answers into an action: `auto`, `review`, or a custom one.

## Decision profiles

A profile is versioned config: typed questions plus a policy. See
[docs/profile-format.md](docs/profile-format.md) and the examples in
[examples/profiles/](examples/profiles/).

This repository holds only example profiles. Real profiles live in your own
private configuration repository; see [docs/deployment.md](docs/deployment.md)
and the template in [template/config-repo](template/config-repo/).

## API

Described in [openapi.yaml](openapi.yaml).

```sh
curl -s localhost:8787/v1/decide/issue-triage \
  -H "authorization: Bearer $POINTSMAN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state": {"issue": {"title": "Login page is blank", "body": "Since this morning."}}}'
```

```json
{
  "decision_id": "8c0f…",
  "answers": {
    "team": { "type": "choice", "value": "backend", "p": 0.9, "probabilities": { "backend": 0.9, "frontend": 0.05, "docs": 0.05 } },
    "urgent": { "type": "noul", "value": false, "p": 0.8, "yes": 0.2 },
    "effort": { "type": "score", "value": 0, "p": 0.7, "score": 0.6, "probabilities": { "0": 0.7, "1": 0.1, "2": 0.1, "3": 0.1 } }
  },
  "action": "auto",
  "profile": "issue-triage",
  "profile_version": 1,
  "model": "mock",
  "created_at": "2026-10-07T04:12:30.512Z",
  "rule": 0
}
```

In every answer, `p` is the probability of `value`. For yes/no questions,
`yes` is the probability of yes. `rule` is the index of the policy rule that
gave the action (`null` when the default applied).

Decisions are logged with their profile version and model, and can be
corrected: `GET /v1/decisions/{id}`, `POST /v1/decisions/{id}/feedback`. See
[docs/decision-log.md](docs/decision-log.md).

Decisions with action `review` wait for a person: `GET /v1/reviews`,
`POST /v1/reviews/{id}/resolve`; the final answer is sent, signed, to the
decision's `callback_url`. See [docs/reviews.md](docs/reviews.md).

## Clients

- [MCP](docs/mcp.md): `/mcp` with `list_profiles`, `decide` and
  `get_decision`, so agents can ask a profile instead of deciding themselves.
- [GitHub issue triage](actions/triage/): a GitHub Action that labels new
  issues from a Pointsman decision, or asks for a human review.
- [Deploy watch](actions/deploy-watch/): a GitHub Action that stops a
  CloudFormation deploy when Pointsman judges it stuck.
- [FIWARE bridge](bridge/): connects an NGSI-LD context broker to Pointsman.
  Pointsman itself knows nothing about FIWARE; the bridge subscribes to
  entities, asks Pointsman, and writes the decisions back to the broker as
  data. [Why a bridge](bridge/README.md#why-a-bridge) explains the role.

## API tokens

Every request needs `Authorization: Bearer <token>`. Each client gets its own
token, which can be limited to some profiles. Only a SHA-256 hash of each token
is stored (KV namespace `TOKENS`); the token is shown once when it is created.

```sh
node scripts/tokens.mjs create --client github-triage --profiles issue-triage --local
node scripts/tokens.mjs list --local
node scripts/tokens.mjs revoke --hash <hash from list> --local
```

Use `--remote` (and `--config <your wrangler config>`) for a deployed Worker.
After a revoke, KV can take up to about 60 seconds to stop the token
everywhere.

## Development

Requires Node.js 24 and pnpm 12. The Worker runs on Cloudflare Workers.

```sh
pnpm install
pnpm db:migrate:local     # create the local decision log (D1)
pnpm dev                  # local Worker on :8787, example profiles, mock model
pnpm test                 # script tests and Worker tests (in workerd)
pnpm check                # typecheck, tests, profile validation, dry-run deploy
node scripts/validate-profiles.mjs path/to/profiles  # validate your own
```

`wrangler.jsonc` in this repository is for development only: it serves the
example profiles built into the Worker (`PROFILE_SOURCE=bundled`) and answers
every question with a mock model (`MODEL_MODE=mock`). A real deployment uses
its own configuration with `PROFILE_SOURCE=kv`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Every commit needs a sign-off
(`git commit -s`, [DCO](https://developercertificate.org/)).

## License

MIT. See [LICENSE](LICENSE).
