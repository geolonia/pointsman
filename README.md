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

## Development

Requires Node.js 24 and npm.

```sh
npm ci
npm test                      # validator tests
npm run validate:profiles     # validate the example profiles
node scripts/validate-profiles.mjs path/to/profiles   # validate your own
```

## License

MIT. See [LICENSE](LICENSE).
