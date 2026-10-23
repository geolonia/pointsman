# Security policy

## Reporting a vulnerability

Report security problems privately, in one of two ways:

- GitHub's private vulnerability reporting for this repository:
  https://github.com/geolonia/pointsman/security/advisories/new
- Email to security@pointsman.net.

Do not open a public issue for a security problem, and do not paste API
tokens, real profiles or decision data into a report.

## How reports are handled

This repository has a threat model, [`threat-model.md`](threat-model.md),
that states what Pointsman promises, what it deliberately does not promise,
and what the integrator and the clients own. A report is triaged against it:

- A report that violates a property the model claims (§1.11) is a valid
  finding and is fixed.
- A report about something the model states it does not provide (§1.12),
  about code it marks out of scope (§1.3), or about an adversary it excludes
  (§1.10) is answered by citing the section that says so.
- A report that fits none of the model's dispositions (§1.17) means the
  model is incomplete, and the model is revised.

The model is bound to a commit (see its §1.1 header) and is revised when one
of the conditions in its §1.16 happens. `threat-model.yaml` and
`threat-model.json` are machine-readable companions derived from it; the
prose is authoritative.

## Supported versions

Pointsman is before 1.0, and only the latest release gets fixes. Fixes land
on `main` and go out in the next release (see [CHANGELOG.md](CHANGELOG.md)); a
deployment pins the engine commit in its config repository (see
[docs/deployment.md](docs/deployment.md)) and picks up a fix by moving that
pin to the release.
