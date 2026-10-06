# Pointsman configuration

Private configuration for a [Pointsman](https://github.com/geolonia/pointsman)
deployment: decision profiles and the deploy config. The engine itself is
pinned in `engine.json` and checked out by the workflows.

| File | Content |
|---|---|
| `profiles/<id>.yaml` | Decision profiles ([format](https://github.com/geolonia/pointsman/blob/main/docs/profile-format.md)) |
| `wrangler.jsonc` | Worker name and Cloudflare resource ids |
| `engine.json` | The engine commit this deployment uses |
| `ai-gateway.json` | AI Gateway settings |
| `.github/workflows/validate.yml` | Checks every pull request (no secrets) |
| `.github/workflows/deploy.yml` | Deploys `main` |

Set-up and how deploys work:
[docs/deployment.md](https://github.com/geolonia/pointsman/blob/main/docs/deployment.md).

Every change to a profile needs a higher `version`; a published version
cannot be changed.
