# Pointsman

Pointsman sets the switches. Your systems ask a question, Pointsman decides
which track it goes on, or calls a human when it is not sure.

Pointsman is a model-agnostic decision service. A client sends a state to
`POST /v1/decide/{profile}`. A decision model (for example Clef or Jev) answers
the profile's typed questions with probabilities, and the profile's policy turns
the answers into an action: `auto`, `review`, or a custom one.

Status: early proof of concept. See the [PoC milestone](https://github.com/geolonia/pointsman/milestone/1).

## Decision profiles

A profile is versioned config: typed questions plus a policy. See
[docs/profile-format.md](docs/profile-format.md) and the examples in
[examples/profiles/](examples/profiles/).

This repository holds only example profiles. Real profiles live in your own
configuration repository.

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
  "model": "mock"
}
```

In every answer, `p` is the probability of `value`. For yes/no questions,
`yes` is the probability of yes.

Decisions are logged with their profile version and model, and can be
corrected: `GET /v1/decisions/{id}`, `POST /v1/decisions/{id}/feedback`. See
[docs/decision-log.md](docs/decision-log.md).

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

## License

MIT. See [LICENSE](LICENSE).
