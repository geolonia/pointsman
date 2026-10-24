---
title: How a decision is made
description: How Pointsman makes a decision from questions, facts, rules and people, what it does when data is missing, and how the parts fit together.
sidebar: { order: 10 }
---

Pointsman decides which way a case goes. A *case* is anything a system wants
decided: a report of a closed road, a new issue, a pull request. Each kind of
case has a *profile*: the questions to ask, the facts to look up and the rules
that turn the answers into an action. A profile is versioned, so every
decision can say which rules made it.

## How a decision is made

<svg class="diagram" viewBox="0 0 460 496" role="img" aria-label="How a decision is made: a case comes in; an AI answers questions and facts are looked up at the same time; the rules give an action, or a person reviews; everything is recorded in the decision log." xmlns="http://www.w3.org/2000/svg">
<!-- Grid: viewBox 460 wide; boxes 210 x 64; column centres 115, 230, 345; rows every 100 from y 16. Drawn by a script with the same shapes in each language. -->
<title>How a decision is made: a case comes in; an AI answers questions and facts are looked up at the same time; the rules give an action, or a person reviews; everything is recorded in the decision log.</title>
<defs><marker id="decision-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>
<path class="line" d="M230 80 V98 H115 V114" marker-end="url(#decision-arrow)"/>
<path class="line" d="M230 98 H345 V114" marker-end="url(#decision-arrow)"/>
<path class="line" d="M115 180 V198 H230 V214" marker-end="url(#decision-arrow)"/>
<path class="line" d="M345 180 V198 H230"/>
<path class="line" d="M230 280 V298 H115 V314" marker-end="url(#decision-arrow)"/>
<path class="line" d="M230 298 H345 V314" marker-end="url(#decision-arrow)"/>
<path class="line" d="M115 380 V398 H230 V414" marker-end="url(#decision-arrow)"/>
<path class="line" d="M345 380 V398 H230"/>
<rect class="box" x="125" y="16" width="210" height="64" rx="8"/>
<text class="title" x="230" y="40" text-anchor="middle">① Case</text>
<text class="small" x="230" y="58" text-anchor="middle">A system sends what</text>
<text class="small" x="230" y="73" text-anchor="middle">it wants decided</text>
<rect class="box" x="10" y="116" width="210" height="64" rx="8"/>
<text class="title" x="115" y="140" text-anchor="middle">② Questions</text>
<text class="small" x="115" y="158" text-anchor="middle">An AI answers, with</text>
<text class="small" x="115" y="173" text-anchor="middle">a probability</text>
<rect class="box" x="240" y="116" width="210" height="64" rx="8"/>
<text class="title" x="345" y="140" text-anchor="middle">② Facts</text>
<text class="small" x="345" y="158" text-anchor="middle">Looked up in data,</text>
<text class="small" x="345" y="173" text-anchor="middle">never guessed</text>
<rect class="box go" x="125" y="216" width="210" height="64" rx="8"/>
<text class="title" x="230" y="240" text-anchor="middle">③ Rules</text>
<text class="small" x="230" y="258" text-anchor="middle">Written by people:</text>
<text class="small" x="230" y="273" text-anchor="middle">the first that fits wins</text>
<rect class="box" x="10" y="316" width="210" height="64" rx="8"/>
<text class="title" x="115" y="340" text-anchor="middle">④ Action</text>
<text class="small" x="115" y="358" text-anchor="middle">The system acts, for</text>
<text class="small" x="115" y="373" text-anchor="middle">example publish</text>
<rect class="box person" x="240" y="316" width="210" height="64" rx="8"/>
<text class="title" x="345" y="340" text-anchor="middle">④ Review</text>
<text class="small" x="345" y="358" text-anchor="middle">A person checks it</text>
<text class="small" x="345" y="373" text-anchor="middle">and gives the action</text>
<rect class="box" x="125" y="416" width="210" height="64" rx="8"/>
<text class="title" x="230" y="440" text-anchor="middle">⑤ Decision log</text>
<text class="small" x="230" y="458" text-anchor="middle">Everything is recorded,</text>
<text class="small" x="230" y="473" text-anchor="middle">with the profile version</text>
</svg>

1. **A case comes in.** A system sends it to Pointsman over the HTTP API, or
   an AI agent sends it over MCP (the Model Context Protocol, which AI agents
   use to call tools). A *connector*, a part that links another system to
   Pointsman, can also bring it in, for example from a FIWARE smart-city
   data platform.
2. **Questions and facts, at the same time.**
   - An AI model answers the profile's *questions*: yes or no, one choice
     from a list, or a score. Each answer comes with a probability: how sure
     the model is, from 0 to 1.
   - Pointsman looks up the profile's *facts* in data, for example whether
     the place is in a flood zone or how many files a pull request changes.
     The AI does not see or guess facts.
3. **Rules decide.** People write the rules, for example "danger 70 % or
   more: urgent". Pointsman checks them in order; the first rule whose
   condition is true (the first that *fits*) gives the action. When no rule
   fits, the profile's default action applies. An action is a name the
   profile chooses, such as `auto`, `urgent` or `review`.
4. **An action, or a person.** The action goes back to the system, which
   acts on it. When the action is `review` (or another action the profile
   lists for people to check), a person checks the case first,
   gives the final action and can correct the AI's answers.
5. **Everything is recorded** in the [decision log](#the-decision-log),
   with the corrections, which show how often the AI was right.

## Why it is split this way

- **The AI answers, people decide.** The model only answers narrow
  questions. What follows from the answers is written in rules that people
  can read, test and change. So the model can be replaced without changing
  what the profile does, and a person can always see why a decision was
  made. Some decisions need no AI answer at all: a profile can approve a
  release pull request on facts alone, when it changes only version fields
  and the changelog and other facts check who made it (see `github_release`
  in the [profile format](../profile-format.md#github-pull-requests)).
- **Probabilities, not only answers.** A rule can ask how sure the model is,
  for example `team.p >= 0.85` (`p` is the probability of the answer to the
  question `team`). When the model is not sure, the rules send the
  case to a person instead of guessing.
- **Facts are looked up, not guessed.** Things that can be measured, like a
  distance or the files of a pull request, come from data. When a fact cannot
  be looked up, it is missing, never made up; see
  [Missing facts](#missing-facts).
- **One record for each decision.** Because the log keeps the profile version
  and the model, you can later ask what a changed rule would have decided,
  and how often it would have agreed with people.

## Missing facts

A lookup can fail: the case has no location, the data service is slow, or a
pull request got a new commit while Pointsman was reading it. Then the fact
is *missing*. Pointsman never fills it in with a guess: a guessed value looks
like a real one, and a rule would treat it as true.

Every fact has two more fields besides its own: `missing` is `true` when the
fact has no value, and `reason` says why, for example `timeout` or
`no_location` (the reasons are listed under
[Fact types](../reference/fact-types.md#missing-reasons)).

A rule that compares a missing fact, or a field without a value, is neither
true nor false: it is *unknown*, and a rule fits only when its condition is
true. `false and unknown` is false, `true or unknown` is true, and
`not unknown` stays unknown. So a rule never fits because of data that was
not there. But a missing fact can stop an *earlier* rule that blocks
something, so that a *later* rule that allows it fits instead. That is why a
profile tests `missing` first, which is always known:

```yaml
- when: "facts.flood.missing == true"
  action: review
```

`reason` tells a failed lookup from one that does not apply: a detour can
only be computed for a road section, so
`facts.walk.missing == true and facts.walk.reason != 'no_location'` sends
only a real failure to a person. In a rule that allows something, name every
condition as a known value (`facts.risky.any == false`) instead of counting
on an earlier rule. The details are in the
[profile format](../profile-format.md#facts).

## AI answers only make a decision stricter

Some cases are written by the very person the decision is about: a pull
request's title and description come from its author, a report from whoever
sent it. That person can write text meant to steer the AI, for example "this
change is safe". This is called *prompt injection*, and no model is fully
safe from it.

So in a profile whose input comes from outsiders, the profile's author
follows a rule: an AI answer may only make the decision stricter. It can
send a case to a person or ask for a fix, but it is never the reason a case
passes. What must be true for a pass is checked with facts, values that
Pointsman works out itself and the author of the case cannot set directly.
Pointsman does not enforce this rule: a profile that passes or approves on
AI answers alone can be steered by whoever writes the case. The example
profile
[`workflow-check`](../../examples/profiles/workflow-check.yaml), shortened:

```yaml
policy:
  rules:
    - when: "facts.wf.missing == true"
      action: retry
    # ...
    - when: "touches_secrets.yes >= 0.3"
      action: review
    - when: >-
        facts.wf.unparsed == 0 and facts.wf.privileged == 0
        and facts.wf.injection == 0 and facts.wf.unpinned == 0
        and touches_secrets.yes < 0.3
      action: pass
  default: review
```

The AI question `touches_secrets` reads the pull request's text. It appears
in a rule that sends the case to a person, and in the pass rule only as one
more condition. A text that fools the AI can at most remove that extra
condition; the facts still have to allow the pass. When the facts cannot be
read, the first rule gives `retry` (try again later), never `pass`.

Before you publish such a profile, read its rules as sentences
(`node scripts/explain-profile.mjs <file>`) and check that:

1. every rule that lets a case pass names the facts it relies on;
2. AI answers appear only in rules with a stricter action, or as an extra
   condition in a pass rule;
3. a missing fact leads to a person or to `retry`, never to a pass.

## People: reviews and corrections

A profile lists the actions a person checks before they count (by default
`review`). Such a decision waits in the review queue; a person gives the
final action and can correct the AI's answers. The client can pass a
`callback_url` to receive the final answer, signed, when the person is done.
Corrections are kept as feedback, so you can measure how often a profile was
right. Details: [reviews and callbacks](../reviews.md).

## The decision log

Every decision is stored before it is returned: if the log cannot be
written, the client gets an error and no decision, so nobody acts on a
decision that is not recorded. The log keeps the answers, the facts, the
rule, the model, the versions of the engine and its modules, and the profile
version, which says which questions were asked. The request itself is kept
only as a hash, unless the profile asks to keep it. A *test token*'s
decisions are not logged. Some facts read the log too, for example how many
of an author's pull requests wait for a review; they see only the asking
client's own decisions. Details: [decision log](../decision-log.md).

## Decision chains

A decision can build on earlier ones: a report is checked first, more checks
run, and a final decision reads all of them (`requires` in the profile). The
earlier decisions are named by id and read from the log, so a client cannot
make up their results. Details: [decision chains](../decision-chains.md).

## How Pointsman is built

Pointsman is one engine with parts around it. Each deployment chooses the
parts it needs, so a city's road-closure service and a team's pull-request
checks run the same engine with different modules.

<svg class="diagram" viewBox="0 0 460 396" role="img" aria-label="The parts of Pointsman: other systems talk to connectors; connectors use the engine through its API; the engine asks fact modules for facts and runs on a platform through adapters." xmlns="http://www.w3.org/2000/svg">
<!-- Grid: viewBox 460 wide; boxes 210 x 64; column centres 115, 230, 345; rows every 100 from y 16. Drawn by a script with the same shapes in each language. -->
<title>The parts of Pointsman: other systems talk to connectors; connectors use the engine through its API; the engine asks fact modules for facts and runs on a platform through adapters.</title>
<defs><marker id="roles-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>
<path class="line" d="M230 82 V114" marker-end="url(#roles-arrow)" marker-start="url(#roles-arrow)"/>
<path class="line" d="M230 182 V214" marker-end="url(#roles-arrow)" marker-start="url(#roles-arrow)"/>
<path class="line" d="M230 280 V298 H115 V314" marker-end="url(#roles-arrow)"/>
<path class="line" d="M230 298 H345 V314" marker-end="url(#roles-arrow)"/>
<rect class="box" x="125" y="16" width="210" height="64" rx="8"/>
<text class="title" x="230" y="40" text-anchor="middle">Other systems</text>
<text class="small" x="230" y="58" text-anchor="middle">For example a FIWARE</text>
<text class="small" x="230" y="73" text-anchor="middle">platform or GitHub</text>
<rect class="box" x="125" y="116" width="210" height="64" rx="8"/>
<text class="title" x="230" y="140" text-anchor="middle">Connectors</text>
<text class="small" x="230" y="158" text-anchor="middle">Bring cases in and</text>
<text class="small" x="230" y="173" text-anchor="middle">carry results out</text>
<rect class="box go" x="125" y="216" width="210" height="64" rx="8"/>
<text class="title" x="230" y="240" text-anchor="middle">Engine</text>
<text class="small" x="230" y="258" text-anchor="middle">Questions, rules</text>
<text class="small" x="230" y="273" text-anchor="middle">and the decision log</text>
<rect class="box" x="10" y="316" width="210" height="64" rx="8"/>
<text class="title" x="115" y="340" text-anchor="middle">Fact modules</text>
<text class="small" x="115" y="358" text-anchor="middle">Look up facts, for</text>
<text class="small" x="115" y="373" text-anchor="middle">example flood zones</text>
<rect class="box" x="240" y="316" width="210" height="64" rx="8"/>
<text class="title" x="345" y="340" text-anchor="middle">Adapters</text>
<text class="small" x="345" y="358" text-anchor="middle">Run the engine on a</text>
<text class="small" x="345" y="373" text-anchor="middle">platform: log, models</text>
</svg>

- **Engine.** Takes a case, asks the AI model the profile's questions, gets
  the facts, applies the rules and writes the decision log.
- **AI models** answer the questions. A profile names a model and fallbacks;
  they can be swapped without changing the rules
  ([models](../models.md)).
- **Fact modules** look up facts: flood zones and shelters
  (`@pointsman/facts-gsi`), the way around a closed road
  (`@pointsman/facts-valhalla`), the state of a pull request
  (`@pointsman/github`) or its AI reviews (`@pointsman/coderabbit`). They are
  packages in this repository, built into the engine; a deployment lists the
  ones it uses ([fact modules](../modules.md)).
- **Connectors** connect another system: they bring its cases in and carry
  the results back, for example to a FIWARE platform (`@pointsman/fiware`)
  or to a pull request (`@pointsman/github`). They use the same public API
  as any other client ([connectors](../connectors.md)). The FIWARE connector,
  its actions and settings are described in the
  [FIWARE bridge](../../bridge/README.md), and the demo it runs in the
  [FIWARE demo storyboard](../fiware-demo.md).
- **Adapters** connect the engine to the platform it runs on: where the log
  and the profiles are stored, which AI service answers, how requests come
  in. Today that is Cloudflare Workers, Cloudflare's service for running
  code on its servers; the engine core uses no Cloudflare-specific code
  ([adapters](../adapters.md)).

One package can have more than one role: `@pointsman/github` looks up facts
and is a connector. Keeping the parts apart keeps the engine small: a new
data source or a new system is a new module, not a change to the engine, and
another platform needs other adapters while the profiles stay the same.

## Where to go next

- [Your first profile](../tutorials/first-profile.md) shows all of this on
  your own computer.
- [Profile format](../profile-format.md) has every field.
- [Security](security.md) says what Pointsman protects, and against whom.
