# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned

- Publish the organ contract as a standalone SDK
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
