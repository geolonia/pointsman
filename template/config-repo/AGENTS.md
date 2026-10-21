# AGENTS.md

This is a private configuration repository for a
[Pointsman](https://github.com/geolonia/pointsman) deployment: decision
profiles in `profiles/`, their test cases in `cases/`, and the deploy config.

## Writing or changing a profile

Follow the authoring guide: `engine/docs/authoring.md` once the engine is
checked out (see below), or
[docs/authoring.md](https://github.com/geolonia/pointsman/blob/main/docs/authoring.md).
In short:

1. Ask what the decision is for: what comes in, the actions, what a wrong
   action costs, when a person must look.
2. Write the person's real examples as test cases in `cases/<id>.yaml`
   before the rules.
3. Draft `profiles/<id>.yaml`. Start careful: what is uncertain goes to a
   person.
4. Validate, explain, test. Show the person the explanation, not the YAML.
5. For a change to the rules of a published profile, replay it on past
   decisions.
6. Open a pull request with the explanation and the results. A person
   merges.

The checks decide whether a profile is right, and the person decides what
it should do. Do not change an expected action, a threshold or `people_check`
to make a check pass without the person's say. Do not invent facts
providers, layers, models or actions. Never put tokens, secrets or personal
data into profiles, cases, pull requests or the chat; the person sets
`POINTSMAN_TOKEN` in their own shell.

## Commands

The engine is checked out at the pinned commit (once; `engine/` is ignored):

```sh
git clone https://github.com/geolonia/pointsman engine
git -C engine checkout "$(jq -r .ref engine.json)" && pnpm --dir engine install
```

```sh
node engine/scripts/validate-profiles.mjs profiles
node engine/scripts/explain-profile.mjs profiles/<id>.yaml          # --lang ja
node engine/scripts/test-profile.mjs cases --profiles profiles
node engine/scripts/replay-profile.mjs profiles/<id>.yaml --url <pointsman url>
```

Every change to a profile needs a higher `version`.
