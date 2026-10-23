---
title: The decision model
description: How Pointsman makes a decision from questions, facts, rules and people, and why it is split this way.
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
     The AI does not see or guess them.
3. **Rules decide.** People write the rules, for example "danger 70 % or
   more: urgent". Pointsman checks them in order; the first rule whose
   condition is true (the first that *fits*) gives the action. When no rule
   fits, the profile's default action applies. An action is a name the
   profile chooses, such as `auto`, `urgent` or `review`.
4. **An action, or a person.** The action goes back to the system, which
   acts on it. When the action is `review` (or another action the profile
   lists for people to check), a person checks the case first,
   gives the final action and can correct the AI's answers.
5. **Everything is recorded.** The decision log keeps the answers, the
   facts, the rule that fit, the model, and the profile version, which says
   which questions were asked.
   The corrections show how often the AI was right.

## Why it is split this way

- **The AI answers, people decide.** The model only answers narrow
  questions. What follows from the answers is written in rules that people
  can read, test and change. So the model can be replaced without changing
  what the profile does, and a person can always see why a decision was
  made.
- **Probabilities, not only answers.** A rule can ask how sure the model is,
  for example `team.p >= 0.85` (`p` is the probability of the answer to the
  question `team`). When the model is not sure, the rules send the
  case to a person instead of guessing.
- **Facts are looked up, not guessed.** Things that can be measured, like a
  distance or the files of a pull request, come from data. When a fact cannot
  be looked up, it is missing, never made up; see
  [Missing facts](missing-facts.md).
- **One record for each decision.** Because the log keeps the profile version
  and the model, you can later ask what a changed rule would have decided,
  and how often it would have agreed with people.

## Where to go next

- [Profiles at a glance](../reference/profiles.md) shows what a profile looks like.
- [Why AI answers can only make a decision stricter](stricter-only.md)
  explains why, when outsiders write the input, an AI answer may send a case
  to a person but never let it pass.
- [How Pointsman is built](architecture.md) shows the engine, modules,
  connectors and adapters.
