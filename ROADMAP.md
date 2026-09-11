# Roadmap

**Theme for the next six months: stop adding organs, start being trustworthy.**

The organ count is not the bottleneck. Twenty-five organs exist; the thing that keeps people from building on this is
that the numbers were not reproducible, the contract was implicit, and every organ depended on one preview‑stage host.
This roadmap fixes those, in that order.

Every milestone has an exit criterion that can be **checked by running a command**, not by reading a claim. `npm run
check` is the gate for all of them.

---

## M1 — Freeze and make it measurable (September 2026) ← *current*

**No new organs.** Work only on reproducibility, the contract, and the numbers.

| Deliverable | Exit criterion |
| --- | --- |
| Reproducible token benchmark | `npm run bench:check` exits 0 on a clean clone; headline scope stated in one sentence |
| Every prompt claim has a stated scope | No percentage in any README without its denominator and its cold‑start/live scope |
| Organs listed, versioned, permissioned | `catalog/organs.json` validates and CI fails if it drifts from source |
| Organ contract written down | `defineOrgan()` rejects an invalid declaration at authoring time, with a test proving it |
| HostAdapter interface + reference in‑memory host | Tests and the demo run with **zero** host packages installed |
| Dependency‑free core | `packages/organ-core` imports nothing outside Node built‑ins |

Status: **done.** Benchmark reproduces at 84.71% cold‑start / 74.25% live with 0 correctness bugs; the ported core is
verified against the real kernel by a parity suite (5 tests, exact agreement on `familyOf`/`tissueOf` over all 256 tool
names, `innervate` over 5 commands, `evalCondition` over 27 combinations, `attributeFailure` over 8 error strings).

---

## M2 — Make the contract installable (October 2026)

Ship the organ SDK as something a stranger can install and use in five minutes, against a **pinned** host version.

- Publish `@agent-body/organ-core` and `@agent-body/organ-sdk` (currently vendored as relative imports).
- An organ template that `npx` can scaffold, with a test, a manifest, and a CI file already wired.
- `organ add <spec>` resolves a catalog entry, shows its **permission diff**, and requires an explicit confirmation for
  high‑risk permissions (`exec:process`, `host:inject`, `net:listen`, `secrets:read`).
- Compatibility matrix: which organ contract version works with which host version, tested — not asserted.

**Exit:** a third party writes an organ in a repository that has never seen this one, installs it, and its own CI goes
green. Verified by doing exactly that once, in a throwaway repo, and writing down what broke.

**Known risk:** the host is in developer preview and its API moves. Mitigation is the HostAdapter boundary — if the
second adapter (a non‑Harness one, even a toy) can run the contract tests, the boundary is real rather than
aspirational.

---

## M3 — Close the gating gap (November 2026)

The benchmark currently reports 6 capabilities that need a second hop through `body_call`. That is a documented cost,
not a solved problem. Fix it, and let the benchmark decide whether the fix was real:

- Replace declaration‑order truncation in the per‑organ cap with **relevance‑ordered** claim selection.
- Target: `capped + unrouted` drops to ≤2 of 48 tasks **without** the mean savings falling more than 1 point.
- Add a regression task set for the long tail (non‑English commands, ambiguous intent, multi‑intent sentences).
- Report a savings/recall curve rather than one number, so readers can pick their own point on it.

**Exit:** the report's gap table shrinks for a stated reason, and the ablation section explains which mechanism paid for
it.

---

## M4 — Second host, second life (December 2026)

Prove the organ layer is not a Harness attachment.

- A second HostAdapter against a different agent runtime (or a minimal standalone harness).
- The same organs, unmodified, loading on both, with contract tests running against both in CI.
- All hard dependencies on host‑specific event names (`agent/pre-step`, `tools/result`) routed through the adapter with
  capability detection and documented degradation. Where a host lacks a signal, the organ must degrade, not crash.

**Exit:** an organ's own test suite passes against two hosts without conditional code in the organ.

---

## M5 — Self‑healing, measured (January 2027)

Self‑healing is the most‑claimed and least‑measured feature. Make it falsifiable.

- Replay every wound in the healing ledger (`corpus/trace-healings.json`) and score attribution accuracy against a
  hand‑labelled truth set.
- Publish the confusion matrix, including the known blind spot: real Chinese PowerShell error text still falls through
  to `unknown` — a test currently asserts the *wrong* answer to keep it visible.
- Fix the `unknown` bucket, then move that test to assert the right answer.
- Add a "does it get better with use" measurement: reflex credit assignment and synapse pruning need an A/B, not an
  anecdote.

**Exit:** attribution accuracy is a number with a denominator, and the roadmap can say plainly where it is still weak.

---

## M6 — Community and the boring parts (February 2027)

- Two reference organs written by someone who is not the maintainer.
- Plugin‑author documentation that starts from "here is a thing you want to add" rather than from the architecture.
- Templates: issues, PRs, security reports, a good‑first‑issue label with real scoped work.
- A written deprecation policy for the organ contract.

**Exit:** an outside contributor lands a change that touches only their own organ directory, and CI is what told them
it was safe.

---

## What is explicitly *not* on this roadmap

- **More organs.** The count is not the problem, and every new organ makes the benchmark denominator less meaningful.
- **A marketplace.** Not before third parties can install a permissioned organ safely (M2) and it can run on more than
  one host (M4).
- **An LLM‑based router.** Routing is deterministic today and that is a feature: same command, same organs, no tokens,
  and it can be unit‑tested. Swapping in a model would make the system harder to verify while making the demo look
  smarter.

## How to disagree with this roadmap

Open an issue with a number. The project has committed to the benchmark precisely so that disagreements can be settled
by measurement rather than by assertion. If a milestone's exit criterion is badly chosen, the fix is a better
criterion — not a softer one.
