---
title: Missing facts
description: What Pointsman does when a fact cannot be looked up, and why it never guesses one.
sidebar: { order: 14 }
---

A *fact* is data that Pointsman looks up itself for a decision, for example
whether a place is in a flood zone. Sometimes a lookup fails: the case has no
location, the data service is slow, or a pull request got a new commit while
Pointsman was reading it. Then the fact is *missing*.

Pointsman never fills in a missing fact with a guess. A guessed value looks
like a real one, and a rule would treat it as true. So the rules see that the
fact is missing, and the profile decides what to do.

## What a missing fact looks like

Every fact has two more fields besides its own:

- `missing` is `true` when the fact has no value.
- `reason` says why, for example `timeout` or `no_location`. The list of
  reasons is in [Fact types](../reference/fact-types.md#missing-reasons).

## Unknown, not false

A rule that compares a missing fact, for example `facts.flood.rank >= 5`, is
neither true nor false: it is *unknown*. So is a comparison with a field that
has no value, for example the distance when `nearest` found nothing. A rule fits only when its condition
is true, so an unknown condition never gives its action. Combined with
`and` and `or`, unknown works as you would expect:

- `false and unknown` is false: one false part is enough.
- `true or unknown` is true: one true part is enough.
- `not unknown` stays unknown.

So a rule never fits because of data that was not there. But a missing fact
can stop an *earlier* rule that blocks something, so that a *later* rule that
allows it fits instead. That is why the next section puts the missing-fact
rule first.

## What a profile does with it

Say what should happen, in a rule that tests `missing`, which is always
known:

```yaml
- when: "facts.flood.missing == true"
  action: review
```

`reason` tells a failed lookup from one that does not apply. For example, a
detour can only be computed for a road section, not for a single point:

```yaml
- when: "facts.walk.missing == true and facts.walk.reason != 'no_location'"
  action: review
```

Where a wrong pass would be costly, put the missing-fact rule first and let it
send the case to a person (`review`) or ask to try again later (`retry`, an
action name some example profiles use), never let it pass. In a rule that
allows something, name every condition as a known value
(`facts.risky.any == false`) instead of counting on an earlier rule; see
the [safety note in the profile format](../profile-format.md#github-pull-requests). See
[Why AI answers can only make a decision stricter](stricter-only.md).

The details, with every type and reason, are in the
[profile format](../profile-format.md#facts).
