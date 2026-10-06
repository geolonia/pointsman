# Spike: DMN decision tables for policies

Issue #13. Question: can DMN decision tables replace or extend the threshold
rules in profile policies, evaluated inside a Worker?

**Short answer: they work, but they are not worth it now.** A DMN table
evaluated with feelin gives the same actions as our rules and runs in a
Worker. It costs about a quarter more bundle size, needs its own validation
against the profile, and its editor is a large separate tool. Keep the
threshold rules; reconsider when profiles have many rules over the same
inputs, or when people who already use DMN want to write policies.

Tried with feelin 8.2.0, dmn-moddle 12.2.1 and dmn-js 17.12.3. The table and
the evaluation code are in [dmn-deploy-progress.dmn](dmn-deploy-progress.dmn)
and [dmn-evaluate.js](dmn-evaluate.js).

## What was tried

The policy of the `deploy-progress` example as a DMN decision table (hit
policy FIRST), with a phase condition added to the second rule:

| | stuck.yes | phase.value | action |
|---|---|---|---|
| 1 | `>= 0.9` | `-` | `"cancel"` |
| 2 | `>= 0.6` | `not("rolling_back")` | `"review"` |
| 3 | `-` | `-` | `"continue"` |

The same policy as our rules:

```yaml
rules:
  - when: "stuck.yes >= 0.9"
    action: cancel
  - when: "stuck.yes >= 0.6 and phase.value != 'rolling_back'"
    action: review
default: continue
```

## Results

**Same answers.** For four test cases both gave the same action. The DMN
version also ran in a Worker (`wrangler dev`, workerd): XML parsed with
dmn-moddle, rules evaluated with feelin's `unaryTest`. No `eval`; both
libraries parse FEEL themselves.

**Bundle size** (esbuild, minified):

| | bytes | gzip |
|---|---|---|
| Our rules (`src/policy.ts`) | 4,484 | 1,862 |
| feelin only (table as JSON) | 175,157 | 59,451 |
| feelin + dmn-moddle (table as DMN XML) | 228,553 | 74,405 |
| Pointsman Worker today (wrangler dry run) | 1,600,411 | 296,530 |

DMN in the Worker would add about 25 % to the compressed Worker.

**Speed** (Node.js 24, the same four cases):

| | per decision |
|---|---|
| Our rules (compiled once) | 0.13 µs |
| DMN with feelin | 62 µs |
| Compile our rules | 0.14 ms (once per profile) |
| Parse the DMN XML | 1.1 ms (once per profile) |

feelin parses the FEEL text again on every evaluation. 62 µs is still nothing
next to a model call (seconds), so speed does not decide this.

**Editor.** dmn-js shows and edits the table well (hit policy, typed inputs,
add rule). But: the modeler is 1 MB of minified JavaScript, it is a separate
web page (it edits DMN XML, not our YAML profiles), and its license requires
the bpmn.io watermark to stay visible.

## What would be needed for real use

1. **Validation against the profile.** Our rules are compiled against the
   profile's questions: a wrong question name, a field the question type does
   not have, an unknown option or a type mismatch fails validation. FEEL tests
   in a table are plain text; the same checks would have to be written again
   for FEEL (input expressions to question fields, option names in string
   tests, types).
2. **Input mapping.** FEEL names cannot contain the dot in `stuck.yes`, so the
   answers need a flat context (`stuck_yes`) or nested contexts, and the table
   inputs must use those names.
3. **Where the table lives.** Embedded DMN XML in a YAML profile is hard to
   review in a pull request; a separate `.dmn` file per profile version needs
   its own publish and version handling.
4. **A smaller FEEL.** FEEL has functions, dates, lists and contexts. For
   policies only comparisons, `not(...)`, ranges and `-` are needed; the rest
   should be refused at validation.

## When tables would help

Tables read better than rules when there are many rules over the same few
inputs (for example routing by team × urgency × effort). Today's profiles have
one to three rules, where a line of text is shorter than a table.

## Recommendation

Do not replace the threshold rules. If tables are wanted later, the cheapest
path is a **table view of our own rules** in a profile editor (each rule is a
row, each referenced answer field a column), or an import that turns a DMN
table into our rules once. Both keep one evaluator, one validator, and no
extra code in the Worker.
