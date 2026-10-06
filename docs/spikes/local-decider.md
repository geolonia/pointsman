# Spike: local model adapter (Strands Decider 2B)

Issue #15. Question: can a small local decision model, for example Strands
Decider 2B, be used through the same adapter interface (#3)?

**Short answer: yes, with almost no work.** Strands Decider 2B serves the same
request and answer format that Pointsman already sends to Clef-flash
(`{model, state, questions}` in, typed answers with probabilities out).
Pointsman's own request builder and answer check accepted its answers
unchanged. On a small test set its answers were close to Clef-flash's, at
about half the latency on a laptop GPU. What it needs is a host: the Worker
cannot run it, so it would be called over HTTP.

Tried with `strands-decider` 0.1.0 (PyPI), checkpoint
`StrandsAgents/strands-decider-2B-hobson-v19` (Apache-2.0) on the
`Qwen/Qwen3.5-2B-Base` backbone (Apache-2.0), on an Apple M4 Max (36 GB,
`mps`), compared with Clef-flash on Workers AI through the AI Gateway
(`pnpm dev:live`).

## Setup

```sh
python3.12 -m venv .venv && . .venv/bin/activate
pip install strands-decider==0.1.0
strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 --port 8794
# POST http://127.0.0.1:8794/v1/systemone
```

- **Download:** about 4.6 GB on first use (4.55 GB backbone, 90 MB LoRA
  adapter, scoring head and tokenizer), from Hugging Face. Both are
  Apache-2.0, neither is gated.
- **Python packages:** torch, transformers, peft and FastAPI (for `serve`).
- **Memory:** the server process used about 0.6 GB of RAM; the bf16 weights
  (about 4.5 GB) sat in GPU memory (unified memory on the Mac).

## Same interface

`toModelRequest()` builds the request for any profile, and the decider
answers in the format `normalizeAnswers()` already checks:

| Question type | Decider answer | Pointsman |
|---|---|---|
| `noul` | `noul`: P(yes) | value = P(yes) ≥ 0.5, `p`, `yes` |
| `choice` | `choice` + `probabilities` per option | value = top option, `p` |
| `score` | `score` (probability-weighted level) + `probabilities` per level | value = most likely level, `p`, `score` |

It also returns `confidence` per answer, `usage` and `latency_ms`, which
Pointsman ignores. All 16 test requests passed `normalizeAnswers()`.

## Compared with Clef-flash

16 cases: 12 issues for `issue-triage` (11 with an expected team, 1 vague),
4 deploy situations for `deploy-progress` (2 stuck, 2 slow but moving). A small
hand-made set, enough to see whether the decider is usable, not a benchmark.

| | Strands Decider 2B (local) | Clef-flash (Workers AI) |
|---|---|---|
| Expected team, 11 clear issues | 11 / 11 | 11 / 11 |
| Vague issue | frontend, p 0.54 → `review` | frontend, p 0.63 → `review` |
| Stuck deploys (P(yes)) | 0.68, 0.72 → `review` | 0.89, 0.82 → `review` |
| Moving deploys (P(yes)) | 0.14, 0.32 → `continue` | 0.08, 0.37 → `continue` |
| Same value as the other model | team 12/12, urgent 10/12, effort 7/12, stuck 4/4, phase 4/4 | |
| Same action under the profile's policy | 14 / 16 | |
| Median latency (warm) | 240 ms (local GPU) | 433 ms (from Japan, through the gateway) |
| Cost per decision | none (host only) | Workers AI price |

The two different actions: two documentation issues where the decider was
less sure (team p 0.83 and 0.78) than Clef-flash (0.99 and 0.97), so it asked
for a review where Clef-flash decided `auto` (threshold 0.85). Its
probabilities are generally lower for the same answer. Thresholds tuned for
one model do not carry over unchanged to the other; the decision log already
records the model, so accuracy can be measured per model (docs/accuracy.sql).

The effort question (a four-level score) agreed least (7/12): both models
spread probability across neighbouring levels there, which is expected for a
vague question like "how much work".

Not measured: CPU-only speed (a host without a GPU), and quality on a larger
or real data set.

## How it would fit

The Worker cannot load a 2B model, so the decider runs on a host and Pointsman
calls it over HTTP:

- **An HTTP adapter for any System One endpoint**: base URL, model id
  mapping, an API key header, a timeout. It sends `toModelRequest()` as is and
  returns the answers for `normalizeAnswers()`. The same adapter would work for
  other servers that speak this format.
- **Where it helps:**
  - local development and tests with real answers instead of the mock model,
    without a Cloudflare account;
  - data that must not leave a network: Pointsman (or just the model) on
    premises;
  - a fallback model when Workers AI is down (`fallback_models`).
- **What it costs:** a host with a GPU for this latency (or slower on CPU), and
  running that host. No per-decision price.

## Recommendation

- Add an HTTP adapter for System One endpoints as a small issue, with the
  decider as the first target. No change to profiles beyond choosing the
  model id.
- Use it first for local development (`pnpm dev` with a real local model),
  then decide about a hosted instance when a profile needs on-premises
  decisions or an independent fallback.
- Keep Clef-flash as the default for hosted profiles; when a profile switches
  models, check its thresholds against the accuracy of the new model first.
