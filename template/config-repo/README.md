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
cannot be changed. The validation workflow checks this on every pull request
(`check-profile-versions.mjs`: changes are compared by profile id, comments
and formatting do not count, new and deleted profiles pass).

Protect `main` (Settings → Rules or Branches): require a pull request, and
require the status check **Validate profiles and config**. Otherwise a pull
request with an invalid profile or a missing version bump can still be merged,
and the deploy stops after the merge.
