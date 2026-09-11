# Benchmark — what exactly is being measured

The headline claim in this project is a token number. A token number without a stated scope is marketing, so this
document states the scope, the inputs, the failure modes, and the escape hatches. Everything here is reproducible with
`npm run bench`.

## The measurement in one sentence

> Of the prompt tokens spent on **tool‑schema definitions**, what fraction is withheld from a given request because
> schema gating decided those capabilities are not relevant to the current command?

## Scope — what is counted and what is not

| Counted | Not counted |
| --- | --- |
| `name` + `description` + JSON schema of **every tool definition** | system prompt text |
| …for all 256 capabilities in the corpus | conversation history |
| …and the subset actually revealed after gating | tool call results |
| Token estimate: CJK ≈ 1 token/char, otherwise ≈ 4 chars/token | provider tokenizer specifics |

Consequences worth being explicit about:

- **This is not "82% of the prompt".** Tool schemas are one block of the prompt. If a body has a 200k‑token context,
  saving 47k tokens of schemas is a large but partial win.
- The estimator is deterministic and matches the kernel's own estimator exactly (see §5 of the report — the
  cross‑check against the kernel's live ledger comes out at **0.00% deviation**). It is an estimate, not a billing
  figure. Comparisons between strategies are meaningful; absolute values are approximate.

## Two scopes, two numbers, both real

| Scope | Savings | How it is produced |
| --- | --- | --- |
| **Cold start** (headline) | **84.71%** mean, 85.67% median, 75.20% worst | Offline, from the committed corpus + task set. No run history. **Fully reproducible.** |
| **Live body** (snapshot) | **74.25%** | Captured once from a running body with real run history. Needs a live host to reproduce. |

Why they differ: on a cold start, only the current command decides what is revealed. On a live body, recently used and
high‑trust organs stay hot, so the visible set grows and savings shrink. The more history a body has, the closer it
gets to the live figure.

An earlier revision of the README quoted **82%** — a live snapshot taken between these two. It was not wrong, but it
was not reproducible either. Both the headline and the snapshot are now committed as data
(`benchmarks/corpus/trace-live-gate.json`) so anyone can check the arithmetic.

## The inputs

| File | What it is | Reproducible? |
| --- | --- | --- |
| `corpus/tools.json` | 256 tool definitions captured from a live body — plugin tools **and** core agent‑scoped tools | Yes (frozen, sanitized) |
| `corpus/trace-healings.json` | 30 real healing‑ledger wounds | Yes (frozen) |
| `corpus/trace-reflex-stats.json` | Reflex fire/help statistics | Yes (frozen) |
| `corpus/trace-synapses.json` | Learned command→organ weights | Yes (frozen) |
| `corpus/trace-skills.json` | Solidified cross‑organ skills | Yes (frozen) |
| `corpus/trace-live-gate.json` | One live gating snapshot + the kernel's own token ledger | **No** — needs a live host |
| `tasks/intents.json` | 48 representative operator commands with expected capabilities | Yes |
| `baselines/expected.json` | 23 metrics CI compares against | Yes |

The corpus is a **captured** artifact, not a generated one. Its known weakness: it is one machine's tool set. A body
with different plugins will have a different denominator. Re‑capture instructions: [`tools/CAPTURE.md`](tools/CAPTURE.md).

## Why the corpus had to be re‑captured

The first capture produced **229 tools**. `ctx.tools.schemas()` with no argument returns only the **root scope** — the
plugin tools. Core tools (`read`, `write`, `pwsh`, `web_search`, `subagent`, …) live on the **agent scope** and were
missing.

That is not a rounding error. The missing tools are exactly the ones in the always‑visible set, so dropping them
shrinks the denominator *and* zeroes out the floor — inflating the savings ratio. The correct capture path
(`ctx.tools.layers.scoped` → `ctx.tools.schemas(scope)`) is documented and now yields 256.

## Correctness guard — gating must not hide what the task needs

A savings percentage is trivially gamed by hiding more. So every task declares the capabilities it needs, and every
miss is attributed to one of three classes:

| Class | Meaning | Fails the benchmark? |
| --- | --- | --- |
| **bug** | An always‑visible capability was hidden, or the capability has no owning organ | **Yes** |
| **capped** | The owning organ *was* innervated, but the per‑organ cap (10) truncated it | No — reachable via `body_call`, but it costs a hop |
| **unrouted** | The intent did not route to the organ that owns the capability | No — reachable via `body_call` |

Current state: **0 bugs, 6 capped, 0 unrouted**.

Only `bug` fails the run. Treating *capped*/*unrouted* as failures would make the benchmark a permanently red noise
source; treating `bug` as a mere caveat would let gating silently degrade into "hide everything". The distinction is
the whole point.

The 6 capped cases are the honest cost of `perOrganCap = 10` on a 49‑capability organ. Fixing it properly (relevance‑
ordered claim selection instead of declaration order) is a roadmap item, and the benchmark is what will judge it.

## Reproducing

```bash
npm run bench          # regenerate reports (writes REPORT.md)
npm run bench:check    # compare against baselines/expected.json; exit 1 on drift
npm run bench:baseline # deliberately re-baseline (explain why in CHANGELOG)
npm run corpus         # rebuild the frozen corpus from raw captures
```

`bench:check` is part of `npm run check`, which is what CI runs.

## How to read the report

`results/REPORT.md` has five sections: schema gating (the headline), ablation (what each mechanism contributes),
baselines (how much a *dumb* strategy would get — a naive prefix rule gets 88.00% savings while missing 29 expected
capabilities, which is exactly why raw savings is not a quality metric), organ catalog, and the live cross‑check.

Read the baseline table before believing the headline. Saving tokens is easy. Saving tokens without hiding what the
task needs is the actual result.
