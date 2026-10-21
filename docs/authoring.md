# Writing a profile, with an AI assistant

A profile holds decisions that a person should make on purpose: which
questions to ask, which facts to use, what to do with the answers, and when a
person must look. The YAML itself is the easy part. This guide is a way of
working where an AI assistant drafts the profile, Pointsman's own tools check
it, and a person approves what it says.

It is written for both: the person who owns the decision, and the assistant
(for example Claude Code in the config repository) that helps them. The
assistant follows the steps; it does not decide whether a profile is good.
The checks do that, and the person does.

| Who | Does |
|---|---|
| The person | Says what the decision is for, gives real examples with the right action, reads the profile as sentences, approves the pull request |
| The assistant | Asks, drafts the profile and the test cases, runs the checks, explains the results, opens the pull request |
| Pointsman's tools | Validate the profile, put it into sentences ([explain](profile-format.md#explain)), run the examples ([test cases](profile-format.md#test-cases)), try a changed policy on past decisions ([replay](profile-format.md#replay)) |

The tools give the same answer to everyone, whatever assistant or settings
are used. When the assistant and a tool disagree, the tool is right.

## Commands

In a config repository, the engine is checked out next to the profiles (once,
at the pinned commit; `engine/` is in `.gitignore`):

```sh
git clone https://github.com/geolonia/pointsman engine
git -C engine checkout "$(jq -r .ref engine.json)" && pnpm --dir engine install
```

| Step | Command |
|---|---|
| Validate | `node engine/scripts/validate-profiles.mjs profiles` |
| Explain | `node engine/scripts/explain-profile.mjs profiles/<id>.yaml` (`--lang ja`) |
| Test cases | `node engine/scripts/test-profile.mjs cases --profiles profiles` |
| Test cases on real requests | `POINTSMAN_TOKEN=<test token> node engine/scripts/test-profile.mjs cases --profiles profiles --url <pointsman url>` |
| Replay | `POINTSMAN_TOKEN=<token> node engine/scripts/replay-profile.mjs profiles/<id>.yaml --url <pointsman url>` |

The assistant runs these itself and shows the output. It never asks for a
token in the chat: the person sets `POINTSMAN_TOKEN` in their own shell.

## 1. Understand the decision

Before any YAML, the assistant asks, and writes the answers down in plain
words (they go into the pull request later):

- **What comes in?** An example of the request, as the client sends it
  (a road report, an issue, a deploy event). Which parts matter?
- **What can happen?** The actions, and who or what acts on each one.
- **What does a wrong action cost?** Acting when it should have waited, and
  waiting when it should have acted. The more a wrong action costs, the more
  of those cases go to a person.
- **When must a person look?** Always for some kinds of case, or only when
  the AI is unsure?
- **Facts about a place?** If the request has a location, which public facts
  matter (flood zones, shelters, detours; see
  [Facts](profile-format.md#facts) for what exists). The assistant does not
  invent layers or providers.
- **Earlier decisions?** Does this decision build on another one
  ([decision chains](decision-chains.md))?

## 2. Collect examples first

Before drafting the rules, the person gives real examples with the action
they expect: at least one per action, and the hard ones in between. The
assistant writes them as [test cases](profile-format.md#test-cases) in
`cases/<id>.yaml`.

- Cases with **answers** describe what the AI would answer; they check the
  rules alone. Write these for every rule and every boundary ("danger 0.69 is
  not urgent, 0.7 is").
- Cases with a **state** keep real requests; they need a deployed profile and
  a test token, so they run after the first version is published.
- Real requests can hold personal data. Shorten them to what the decision
  needs, and remove names, phone numbers and addresses that are not part of
  the decision.

Examples first, because they are the person's own words for what "right"
means. Rules written before them tend to fit the rules' author, not the
cases.

## 3. Draft the profile

The assistant drafts `profiles/<id>.yaml` following
[profile-format.md](profile-format.md). Rules of thumb:

- **Few questions, each with a fixed answer type** (yes/no, a choice, a
  score). Each question asks one thing, in words the model can answer from
  the request alone. Yes/no questions say what yes and no mean.
- **The AI answers; the rules decide.** Put what is known for sure into
  rules and facts, not into a question.
- **Danger first.** Rules are checked in order, and the first one that
  matches wins: put the rules for urgent cases at the top.
- **Missing facts.** A rule that reads a fact does not match when the fact is
  missing. Decide what should happen then, and write a rule for it
  (`facts.<name>.missing == true`).
- **Start careful.** The default action, and anything uncertain, goes to a
  person (`review`). Lower a threshold later, with a replay that shows what
  it changes (step 6).
- **Who checks what.** `people_check` lists the actions a person checks
  before they count; `people_answers` the answers they may give.
- **Version.** A new profile starts at 1; every change to a published
  profile needs a higher version.

## 4. Check, and read it as sentences

```sh
node engine/scripts/validate-profiles.mjs profiles
node engine/scripts/explain-profile.mjs profiles/<id>.yaml
node engine/scripts/test-profile.mjs cases --profiles profiles
```

- An invalid profile is fixed before anything else; the tools refuse to
  explain or test it.
- The assistant shows the person the explanation, not the YAML. The person
  reads each rule ("If the probability that "danger" is yes is at least 70 %,
  the action is urgent.") and says whether it is what they mean.
- Every test case passes. A failing case means the rules or the example are
  wrong; the person decides which. The assistant never changes an expected
  action to make a case pass without the person saying so.

## 5. Publish carefully

The pull request goes to the config repository like any other change; the
validation workflow runs the same checks, and a person merges. Its
description holds:

- what the decision is for (from step 1),
- the explanation (`explain-profile.mjs` output),
- the test results, and the replay for a change (step 6),
- what was not checked (for example: no real requests yet).

A new profile can run for a while with every action checked by a person
(`people_check` with all actions, or a default of `review` and careful
thresholds). The decisions it logs, with the people's answers, are what the
next version is measured against.

## 6. Change a published profile

For a change to the rules only (thresholds, order, actions), replay it on the
decisions already made:

```sh
POINTSMAN_TOKEN=<token> node engine/scripts/replay-profile.mjs profiles/<id>.yaml --url <pointsman url>
```

The replay says how many actions would change, from what to what, how many
decisions would go to a person now and with the change, and how often the
new rules give the answer a person gave. The person looks at the listed
changed decisions before approving. A change that sends fewer decisions to a
person but often disagrees with what people answered is not ready.

When the questions or facts change, a replay cannot help (the logged answers
are for the old questions). Then: test cases with answers, test cases with
real requests through the deployed model once the new questions are
published, and a careful start as in step 5.

## What the assistant does not do

- Decide on its own whether a profile is good: the checks and the person do.
- Change an expected action, a threshold or a `people_check` to make a check
  pass, without the person's say.
- Invent facts providers, layers, models or actions that the engine does not
  have.
- Put tokens, secrets or personal data into profiles, cases, pull requests or
  the chat.
- Merge its own pull request.
