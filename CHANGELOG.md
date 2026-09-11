# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Reproducible token benchmark** (`benchmarks/`) — a frozen 256-capability corpus, a 48-command task set with
  expected capabilities, an ablation table, and `npm run bench:check` comparing against a committed baseline. The
  headline claim now states its scope (tool-schema tokens only) and its cold-start/live split
  (84.71% / 74.25%). `benchmarks/README.md` defines the measurement.
- **Organ SDK** (`packages/organ-sdk`) — `defineOrgan()` / `defineReflex()` as an authoring surface that validates at
  declaration time and throws `OrganContractError` with a field path. See `docs/ORGAN_SDK.md`.
- **Organ core** (`packages/organ-core`) — the dependency-free core: pre-extracted kernel constant tables, gating,
  manifest contract, failure attribution, and a reference in-memory host. Imports nothing outside Node built-ins.
- **Organ catalog** (`catalog/organs.json`) — 25 curated organs with tiers, permissions, risk levels, failure
  handling and fallback organs. Generated from source, drift-checked in CI.
- **Five-minute demo** (`examples/quickstart/run.mjs`) — `npm run demo` runs command → impulse → dispatch → execute →
  failure attribution → reflex fire against the real corpus, with nothing installed.
- **`ROADMAP.md`** — six months, six milestones, each with an exit criterion that a command can check.
- **`COMPATIBILITY.md`** and **`docs/host-adapter.md`** — the support matrix and the host-independence boundary,
  including what is tested versus merely asserted.
- **CI gate** — `repo-check` now runs constant-table drift, catalog drift, the unit and parity suites, the benchmark
  baseline, the demo, and a clean-working-tree assertion.

### Fixed

- **`zero_residence` was missing from the curated catalog**, so 4 shipped capabilities (`zr_compact`, `zr_fast`,
  `zr_ledger`, `zr_recall`) showed up as unclaimed and the benchmark reported coverage of **252/256** — an unexplained
  gap sitting next to a 256/256 claim elsewhere. The organ that reads your session logs and spawns subprocesses was
  also, therefore, the one whose permissions nobody could look up. It is now curated like its siblings, with
  `fs:read` + `exec:process` declared. Coverage is **256/256**.
- **`dsh-zero-residence`: session lookup by substring returned the wrong session.** With both `session-a` and
  `session-a-extra` present, which one won depended on filesystem ordering, so `computeLedger('session-a')` could read
  the wrong log and report `T = 0` instead of `T = 2`. Resolution is now exact-match first, then shortest-substring,
  then most-recent. Its regression suite went from 13 passed / 3 failed to **16 / 0**.
- **`dsh-war-bridge`: a skip was recorded as a failed assertion**, so a missing sample PE turned the whole suite red —
  and `process.exit()` racing an in-flight `AbortSignal.timeout` tripped a libuv assertion
  (`UV_HANDLE_CLOSING`) that turned a green run into exit code 1. Both fixed; the summary now reports skips separately.
- **`run-organ-regressions.mjs` reported a useless skip reason** (the last line of a Node crash is always the version
  banner). It now extracts the actual cause, and a missing Python dependency is a SKIP rather than a FAIL. A bare
  clone reports `0 passed · 0 failed · 5 skipped` with reasons and exits 0.
- **`host-adapter.mjs`: `executeTool` leaked exceptions** to the organ and left the failure unattributed. It now
  returns `{ ok: false, error: { message, cause } }` with deterministic attribution.
- **`gating.mjs`: `measureGate` threw `TypeError` without an explicit counter**, despite documenting a default.
- **`benchmarks/results/REPORT.md` was not deterministic** (embedded timestamp and platform), so `bench:check` dirtied
  the working tree on every run and could never be a real CI diff.
- **README numbers were wrong or unrunnable**: the organism regression was quoted as 79 (actually 179), and
  `verify:organs` was presented as working on a bare clone when it cannot resolve the host runtime.

### Changed

- **Organ count is stated as 26 curated organs** (23 shipped as installable packages), matching `catalog/organs.json`
  instead of the previously inconsistent badge/table values.
- **Benchmark baseline re-baselined** for two intentionally changed metrics: `catalog.organs` 25 → 26 and
  `catalog.defaultInstall` 14 → 15, both consequences of curating `zero_residence`. The gating metrics are unchanged
  (84.71% mean), which is the point of tracking them separately.
- **The auto-promotion assertion became a mechanism test.** `buildAnatomy` was asserted to produce an `auto:` organ
  against the real corpus, which made "the corpus happens to contain a free-floating capability" look like an
  invariant — it went red the moment the catalog covered everything. The mechanism is now tested with synthetic
  input, and the corpus test asserts only what it should: no unclaimed capabilities.
- **`npm run check` is the single gate**; `Makefile` targets forward to it so there is only one definition of "green".
- Reflex routing gained six intent rules (privilege-escalation, market data, background jobs, snapshots, image
  reading, document conversion) driven by the benchmark's unrouted list.

### Planned

- Publish `organ-core` / `organ-sdk` to npm (they are vendored as relative imports today)
- A second host adapter, so "host-independent" is verified rather than asserted
- Relevance-ordered claim selection to close the 6 remaining capped-capability cases
- Cross-body sync: export learned synapses / reflexes / skills into another install
- Sleep-time reflex proposals instead of direct self-authoring
- Web panel for the anatomy (organ map, wound ledger, pulse stream)

## [0.1.0] — 2026-09-11

First public snapshot of the Agent-Body architecture: the plugin platform turned into an organism.

### Added

- **`dsh-organism`** — the organ kernel. 13 capabilities: anatomy (`body_map`), cells and tissues
  (`body_cell`), vitals (`body_status`), heartbeat (`body_heart`), command sovereignty (`body_law`),
  nerve impulses (`body_nerve`), organ-addressed dispatch (`body_call`), reflex arcs (`body_reflex`),
  the self-healing ledger (`body_heal`), learned skills (`body_skill`), organ declaration (`body_organ`),
  proprioception (`body_pulse`) and the token ledger (`body_tokens`).
- **`dsh-cortex`** — time and memory. Sleep phases driven by real conversation progress, zero-model-call
  consolidation into five memory-card kinds, command-level recall, and homeostasis alert de-noising.
- **`dsh-zero-residence`** — deterministic pointer compression instead of lossy summarisation, verbatim
  recall of masked content, an attention ledger, and a non-blocking async executor.
- **`dsh-war-bridge`** — reverse-engineering × offensive × orchestration chains joined: IDA Pro MCP
  bridge, whole-team status, evidence-only cross-case handoff, three-library memory search.
- **`dsh-web-crawl`** — multi-engine crawler: `trafilatura` extraction, Patchright anti-detection
  rendering, hosted-reader fallback with a circuit breaker, markitdown document parsing, vendored
  dependencies (replaces `dsh-crawl4ai`, which no longer runs on this host).
- **`ARCHITECTURE.md`** — the system architecture: five biological layers, three kernels, five life
  mechanisms, event contracts, on-disk state and verification methodology.
- Repository skeleton: MIT licence, contributing guide, code of conduct, security policy, editor config,
  git attributes, issue/PR templates, Dependabot, and a deterministic repository check in CI.

### Changed

- **`dsh-pentagi`** — planning steps now detect reverse-engineering intent and insert a five-step
  Reverser flow; the team table gained a Reverser role.
- **`dsh-sec-workbench`** — `sec_toolchain` gained a `paths` field (%VAR% templates plus common install
  locations) so tools outside `PATH` are detected instead of reported missing.
- **`dsh-reverse-skill`** — routing, evidence chain and field-journal improvements.
- **`dsh-quant`, `dsh-agent-teams-pro`** — supersede earlier investment/agent-team plugins.

### Fixed

- Uninstalled organs are reported as *not installed* rather than *broken*, which eliminated a phantom-organ
  warning every 15 seconds.
- Argument-error wounds are attributed before not-found cases, so a 404 is no longer swallowed as
  "tool missing".
- Reflex re-entrancy suppression now marks only reflex-initiated calls, so reflex arcs no longer fire on
  their own effector path.

### Measured

- 26 organs · 256 capabilities · 256/256 claimed, zero orphans
- Tool-schema gating: 49 of 256 capabilities per request — 10,173 instead of 55,154 tokens (~82% saved)
- Self-healing: 21 wounds closed, 100% heal rate, 0 chronic; one `arg_error` wound closed in 3.5s
- Self-training: 3 synapses, 1 self-authored reflex, 1 crystallised skill
- Offline regressions: `dsh-organism` 79/79, `dsh-cortex` 58/58

[Unreleased]: https://github.com/1420079678-ctrl/agent-body/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/1420079678-ctrl/agent-body/releases/tag/v0.1.0
