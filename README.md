<div align="center">

<img src=".github/assets/banner.svg" alt="Agent-Body — plugins as organs: 26 curated organs across 8 systems, one heartbeat, 84.7% of tool-schema tokens gated away, 0 chronic wounds" width="100%">

# Agent‑Body

**An organ‑based plugin layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): organs, nerve impulses, a heartbeat, reflex arcs, long‑term memory, and closed‑loop self‑healing.**

*Plugins here are not a tool list. They are organs in a living system.*

[![Organs](https://img.shields.io/badge/catalog-26%20organs-ff69b4)](#organ-catalog)
[![Plugins](https://img.shields.io/badge/plugins-23%20in%20this%20repo-blue)](#organ-catalog)
[![Schema gating](https://img.shields.io/badge/schema%20gating-84.7%25%20tool--schema%20tokens%20gated-2ecc71)](#token-economy)
[![Benchmark](https://img.shields.io/badge/benchmark-reproducible%20in--repo-blueviolet)](benchmarks/results/REPORT.md)
[![Regressions](https://img.shields.io/badge/offline%20regressions-200%2B%20assertions-informational)](#verify-it-yourself)
[![Node](https://img.shields.io/badge/node-22.19%20%7C%2024-339933)](#quick-start)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/1420079678-ctrl/agent-body?style=flat&logo=github&label=%E2%AD%90%20stars)](https://github.com/1420079678-ctrl/agent-body/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/1420079678-ctrl/agent-body)](https://github.com/1420079678-ctrl/agent-body/issues)

[Architecture](ARCHITECTURE.md) · [Organ Catalog](catalog/organs.json) · [Benchmark](benchmarks/results/REPORT.md) · [Roadmap](ROADMAP.md) · [**中文文档**](README.zh-CN.md)

[Official DSH discussion — **Show Your Plugins!**](https://github.com/deepseek-ai/deepseek-harness/discussions/7555) · the channel the harness `CONTRIBUTING` points plugin authors to

**v0.1.1** · MIT · Windows-first (Node 22.19 / 24) · **26 organs in the catalog, realised by 23 plugin packages in this repository** · [release notes](https://github.com/1420079678-ctrl/agent-body/releases/tag/v0.1.1)

**Contents** · [Why this exists](#why-this-exists) · [What makes it different](#what-makes-it-different) · [The five biological layers](#the-five-biological-layers) · [Architecture at a glance](#architecture-at-a-glance) · [Organ catalog](#organ-catalog) · [Quick start](#quick-start) · [Write your own organ](#write-your-own-organ) · [Verify it yourself](#verify-it-yourself) · [When not to use this](#when-not-to-use-this) · [FAQ](#faq) · [Repository layout](#repository-layout) · [Contributing](#contributing) · [Roadmap](#roadmap)

</div>

---

## Why this exists

Every agent framework eventually becomes the same thing: a pile of tools, a growing list in the system prompt, and an
agent that forgets everything between sessions.

It re-reads the same failure twice before learning it exists. It cannot tell you which of its own capabilities are
broken. It has no idea that a plugin it depends on went offline — it just calls it and fails. And you keep paying tokens
for tool schemas nobody calls.

**Agent‑Body takes the opposite bet: treat the plugin system as an organism.**

Every plugin declares itself an *organ* — with capabilities, senses, and reflexes. Everything else is physiology: a
nervous system that routes your commands to the right organ, a heart that pumps state through the whole body on a
rhythm, reflex arcs that fire without a single model call, and a healing loop that attributes every failure before it
even thinks about retrying.

The result is a system that gets **measurably better the more you use it**, and that stays standing when you rip parts
of it out.

---

## What makes it different

### 🫀 It has a heartbeat, not a loop

A real pacemaker runs at a 1s base clock with a **variable interval** — 3× faster on critical alerts, 2× on fatigue,
2× slower when the body has been silent for a long while. Every beat packages the current operator directives, the
body's proprioception and the homeostasis warnings into a blood packet, writes it to `bloodstream.json`, and broadcasts
it as `organism/heartbeat`. Any organ can hook the circulation with one line:

```ts
ctx.on('organism/heartbeat', (blood) => { /* your organ now has a pulse */ })
```

Circulation is a loop, not a firehose: organs return blood through `organism/venous`, and newly learned knowledge is
oxygenated (`organism/oxygenated`) before it is pumped system‑wide.

### 🧠 Your sentence becomes a nerve impulse

You type a command. Before the model even reasons about it, `agent/pre-step` converts it into an impulse, deterministically
*innervates* the organs that should handle it, and broadcasts on `organism/impulse` — telling each organ **which of its
capabilities to use**.

Then the body learns the route. When an innervated organ actually delivers, a Hebbian synapse strengthens
"this kind of command → that organ"; when it fails, the weight decays. Dispatch order reorders itself from experience,
persisted in `synapses.json`.

```
you:  "抓取这个站点并抽取结构化数据"
impulse → sensory(web-crawl) · executive(plan) · immune(verify)
        → each organ told which capability to fire
```

### 🩹 Self‑healing is a closed loop, not a slogan

```
failure → deterministic attribution → prescription → RE‑CHECK
```

Attribution is not guessing: `tool_missing` / `arg_error` / `permission` / `timeout` / `network` / `not_found` /
`conflict` / `unknown`. The prescription table decides the response — read‑only remedies execute automatically,
side‑effecting ones wait for the brain to rule, and **`arg_error` is never auto‑retried** (retrying a wrong argument
just amplifies the mistake).

The wound only closes when **that organ next succeeds** — the system does not declare itself healed. Anything still open
after 5 minutes is marked `chronic` and stops spinning.

> Measured on the development install: **21 wounds healed · 100% heal rate · 0 chronic.** An `arg_error` wound closed
> 3.5s after the underlying fix landed.

### 🌱 It trains itself — and forgets on purpose

Three learning channels run continuously, none of them requiring you to teach anything:

1. **Synaptic learning** — success reinforces "command class → organ", failure weakens it.
2. **Reflex self‑authoring** — the same tool × cause failing 3 times makes the system **write its own reflex arc**
   (`R-auto-<cause>-<tool>`), which then fires automatically on the next occurrence.
3. **Chain crystallization** — any cross‑organ chain that completes with ≥3 steps is fixed into a replayable skill.

Forgetting is equally deliberate: synapses decay on a 30‑minute half‑life and get pruned below `|w| < 0.2`; reflexes
that fired ≥5 times with zero contribution are retired; skills that keep failing are forgotten.

`body_heal action=rehab` restores an organ to its healthy baseline — **damage cleared, wisdom kept**: fatigue and wounds
reset, learned synapses, reflexes and skills untouched.

### 💤 It sleeps, consolidates, and remembers

Idle for 2 minutes → light sleep. 5 minutes → deep sleep, and every 2 minutes of deep sleep runs a **consolidation
pass with zero model calls** — pure deterministic rules mining the experiences of the day into long‑term memory:

| Card | Mined from |
| --- | --- |
| `pitfall` | same tool failing ≥3 times in a row |
| `playbook` | a cross‑tool success chain repeating ≥2 times (trivial same‑tool repeats filtered out) |
| `hotspot` | ≥8 calls with <70% success rate |
| `unresolved` | ≥3 failures accumulated after the last success |
| `fact` | explicit operator facts |

New commands trigger deterministic recall — tags > title > body, multiplied by weight — and the most relevant cards are
injected into context. Unused cards decay on a 168‑hour half‑life and **archive instead of being deleted**.

### 🪶 Zero‑residence context

Instead of lossy LLM summarization, the engine replaces resident content with **deterministic pointers** — and every
masked byte stays recoverable verbatim from the session log:

| Tool | Purpose |
| --- | --- |
| `zr_compact` | arm a forced compaction that bypasses the ratio threshold |
| `zr_recall` | rebuild masked content verbatim, by tool call id or session seq |
| `zr_ledger` | quantify the attention integral, the three‑segment cost split, and the compression ratio |
| `zr_fast` | run long commands asynchronously and never block the turn |

### 🧩 Organs are optional — the architecture is not

Six kernels depend on no single organ: **nerve bus · heart pump · directive layer · reflex engine · dissector ·
impulse conduction**.

Unplug a plugin and the body keeps running. Uninstalling `dsh-office-docs` was detected immediately — the `craft` organ
went offline and its capability was **compensated by the closest overlapping organ**, core integrity still green. An
organ that is not installed at all is reported as *not installed*, not as *broken* — which eliminated a 15‑second
warning storm from a phantom organ.

<a id="token-economy"></a>

### 📉 Token economy as a first‑class concern

Tool schemas are shown on demand, gated by what the current turn is actually about.

**Scope of every number below: the tool‑schema block of the prompt only** — the `name` + `description` +
JSON‑schema of every tool definition. Not the system prompt, not conversation history, not tool results.

> **84.7% of tool‑schema tokens gated away** — `55,154` → `8,433` on average across 48 representative commands
> (median 85.7%, worst case 75.2%), out of **256 capability definitions**. Everything else stays one `body_call` away.

That number is produced by the benchmark in this repository and is **reproducible on your machine**:

```bash
npm run bench          # regenerate benchmarks/results/REPORT.md
npm run bench:check    # exit non‑zero if it drifts from the committed baseline
```

Two honest caveats, because the headline is easy to over‑read:

- **Cold‑start scope.** The figure above assumes the body has no recent activity — only the current command decides
  what is revealed. On a body with real run history, recently‑used and high‑trust organs stay hot, the visible set
  grows, and savings drop: **74%** in the live snapshot committed at `benchmarks/corpus/trace-live-gate.json`
  (64 of 256 capabilities visible). Historical README revisions quoted **82%** — a single live snapshot between the
  two. Both extremes are real; always quote the scope with the number.
- **10 of 48 commands need a second hop.** A per‑organ cap of 10 capabilities means large organs (the attack organ
  has 49) get truncated, and a few intents do not route to the organ that owns the capability. Those resolve through
  `body_call`, but they are **not** free. The benchmark classifies every miss as *bug* / *capped* / *unrouted* and
  lists them individually in [`benchmarks/results/REPORT.md`](benchmarks/results/REPORT.md).

---

## The five biological layers

| Layer | What it is | Count |
| --- | --- | --- |
| **Individual** | this body (the running install) | 1 |
| **System** | eight body systems: executive / nervous / immune / sensory / motor / memory / metabolic / endocrine | 8 |
| **Organ** | a plugin, obeying one contract: sense → reflex → effect → homeostasis | **26 curated** in [`catalog/organs.json`](catalog/organs.json), **23** shipped as installable packages |
| **Tissue** | functional clustering inside an organ: sensing / inspection / effect / synthesis / memory / regulation / clearance / metering / matrix | 9 classes |
| **Cell** | a single capability unit (one tool) | counted at runtime |

Every layer is observable: `body_map` (organs + systems), `body_cell` (cells + tissues), `body_status` (vitals).
Undeclared plugins are auto‑promoted to *autonomic organs* — on the development install, **256/256 capabilities were
claimed, zero orphans**.

---

## Architecture at a glance

```mermaid
graph TD
    OP([Operator command]) -->|nerve impulse| NERVE["body_nerve · innervation"]
    NERVE --> BUS{{"organism/impulse"}}
    LAW(["Operator directives"]) --> HEART
    HEART[["Heart · organism/heartbeat"]] --> BUS
    BUS --> ORGANS["organs · capabilities"]
    ORGANS -->|"tools/result"| REFLEX["Reflex arcs · zero tokens"]
    ORGANS -->|failure| HEAL["Self-healing · attribute → prescribe → re-check"]
    ORGANS -->|experience| CORTEX["Cortex · sleep / consolidate / memory"]
    CORTEX -->|"recall"| ORGANS
    HEAL --> VITALS["Vitals · vitals.json"]
    VITALS --> HEART
    ORGANS -->|venous| HEART
```

Full detail — three kernels, five life mechanisms, event contracts, on‑disk state, verification methodology — lives in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Organ catalog

Every entry below is a real plugin under `workspace/plugins/`. Five core organs ship a full **offline regression suite**
(see [Verify it yourself](#verify-it-yourself)); the remaining organs are exercised through their replay scripts.

| Organ | Plugin | System | Signature capabilities |
| --- | --- | --- | --- |
| **Organism kernel** | `dsh-organism` | nervous · endocrine | `body_map` `body_cell` `body_status` `body_heart` `body_law` `body_nerve` `body_call` `body_reflex` `body_heal` `body_skill` `body_organ` `body_pulse` `body_tokens` |
| **Cortex** | `dsh-cortex` | memory | `cortex_sleep` `cortex_memory` `cortex_homeo` |
| **Zero‑residence** | `dsh-zero-residence` | metabolic | `zr_compact` `zr_recall` `zr_ledger` `zr_fast` |
| **Web crawl** | `dsh-web-crawl` | sensory | `webcrawl` `webcrawl_site` `webcrawl_map` `webcrawl_extract` `webcrawl_doc` `webcrawl_http` `webcrawl_links` `webcrawl_status` |
| **Browser ultimate** | `dsh-browser-ultimate` | sensory | real browser engine (logged‑in sessions, anti‑bot resilience, CDP) + readability‑style extraction |
| **War bridge** | `dsh-war-bridge` | nervous | `ida` (IDA Pro MCP bridge) `war_status` `war_case` `war_memory` |
| **PentAGI** | `dsh-pentagi` | executive | `agi_plan` `agi_next` `agi_flow` `agi_memory` `agi_reflect` `agi_report` `agi_team` |
| **Sec workbench** | `dsh-sec-workbench` | immune | 49 `sec_*` capabilities: `sec_route` `sec_scope` `sec_evidence` `sec_webscan` `sec_webtest` `sec_exec` `sec_jwt` `sec_hashoff` `sec_brute` `sec_lateral` `sec_stealth` `sec_journal` `sec_report` … |
| **Reverse skill** | `dsh-reverse-skill` | immune | `rev_route` (44 routing rules) `rev_case` `rev_doctrine` `rev_playbook` `rev_journal` `rev_toolindex` |
| **Vuln remediator** | `dsh-vuln-remediator` | immune | `vuln_scan` `vuln_cve` `vuln_sbom` `vuln_priority` `vuln_patch_gen` `vuln_patch_verify` `vuln_remediate` `vuln_plan` `vuln_knowledge` |
| **Vuln daily loop** | `dsh-vuln-mastery-loop` | immune | scheduled daily practice loop with reporting |
| **Quant OS** | `dsh-quant` | executive | 59 `quant_*` capabilities: data / alpha / ML / risk / execution, `quant_research_pipeline` `quant_backtest` `quant_walk_forward` `quant_portfolio_optimize` `quant_stress_test` … |
| **Mastery loop** | `dsh-mastery-loop` | endocrine | `study_orient` `study_deconstruct` `study_model` `study_diagnose` `study_transfer` `study_review` `study_path` |
| **Academic research** | `dsh-academic-research` | executive | `ars_pipeline` (10‑stage state machine) `ars_review` (5‑seat panel) `ars_paper_plan` `ars_integrity` `ars_metrics` |
| **Office docs** | `dsh-office-docs` | motor | PDF / DOCX / PPTX / XLSX build, extract, render‑verify, pandoc convert |
| **Social card** | `dsh-social-card` | motor | `social_card_scaffold` `social_card_render` `social_card_validate` `social_card_docs` |
| **Agent teams** | `dsh-agent-teams-pro` | executive | captain + members, task dependencies, messaging, live web panel |
| **MiroFish** | `dsh-mirofish` | executive | `mirofish_status` `mirofish_api` — swarm‑intelligence prediction engine client |
| **Minimal gray** | `dsh-minimal-gray` | metabolic | minimal agent preset, platform‑adaptive shell |
| **DingTalk bridge** | `dsh-dingtalk-bridge` | nervous | Stream long‑connection bot bridge into the harness |
| **Fund scan** | `dsh-daily-fund-scan` | executive | scheduled fund pool scan + advice report |
| **File chips** | `dsh-file-chips` | sensory | attachment chips in the composer |
| *(legacy)* | `dsh-crawl4ai` | sensory | kept for rollback; superseded by `dsh-web-crawl` |

---

## Quick start

### See it work first — no install, no host, no API key

```bash
git clone https://github.com/1420079678-ctrl/agent-body && cd agent-body
npm run demo      # command → impulse → dispatch → execute → attribute → reflex fires
npm run check     # constant tables + catalog + message sources + 30 tests + benchmark, all offline
```

There is nothing to install. The core packages import nothing outside Node built‑ins, so the demo runs a real
end‑to‑end chain against the committed 256‑capability corpus on a fresh clone.

Then read [`benchmarks/results/REPORT.md`](benchmarks/results/REPORT.md) to see how the token claim was measured, and
[`ROADMAP.md`](ROADMAP.md) to see what is deliberately *not* being built next.

### Install an organ in one command

The self‑contained organs ship a **prebuilt tarball** on the release page — no clone, no build step. The package declares
`dsh.bundle`, so installing it also appends it to `dsh.profile.bundles` and the next start mounts it:

```powershell
dsh plugin --profile web add https://github.com/1420079678-ctrl/agent-body/releases/download/v0.1.1/dsh-external-dsh-organism-0.1.1.tgz
```

Ten organs ship this way — the ones that need no external toolchain. Append the tarball name to the release URL:

| organ | tarball | what it adds |
| --- | --- | --- |
| `dsh-organism` | `dsh-external-dsh-organism-0.1.1.tgz` | the body kernel: anatomy, vitals, heartbeat pump, nerve impulses, reflex arcs, self-healing ledger, on-demand schema gating |
| `dsh-cortex` | `dsh-external-dsh-cortex-0.1.1.tgz` | sleep phases, deterministic consolidation, long-term memory, alert de-noising |
| `dsh-zero-residence` | `dsh-external-dsh-zero-residence-0.1.0.tgz` | zero-residence context: evict, keep a pointer, rebuild the payload verbatim on demand |
| `dsh-mastery-loop` | `dsh-external-dsh-mastery-loop-0.0.1.tgz` | subject-agnostic mastery tutor: orient → deconstruct → model → diagnose → transfer → review |
| `dsh-social-card` | `dsh-external-dsh-social-card-0.0.1.tgz` | social cards: image sets, 21:9 + 1:1 cover pairs, Live Photo plates |
| `dsh-academic-research` | `dsh-external-dsh-academic-research-0.0.1.tgz` | research pipeline: 10-stage state machine, five-seat review panel, integrity protocol |
| `dsh-pentagi` | `dsh-external-dsh-pentagi-0.0.1.tgz` | multi-agent penetration brain: 13 roles, seven-phase flow, adviser re-routing, knowledge base |
| `dsh-vuln-remediator` | `dsh-external-dsh-vuln-remediator-0.0.1.tgz` | vulnerability remediation: discovery, risk scoring, virtual patches, fix plans |
| `dsh-reverse-skill` | `dsh-external-dsh-reverse-skill-0.1.0.tgz` | reverse-engineering workflow: routing, confidence bands, evidence chain, validated gate |
| `dsh-office-docs` | `dsh-external-dsh-office-docs-0.0.1.tgz` | Office documents: build and extract PDF, DOCX, PPTX, XLSX; render pages; convert formats |

Install the body kernel plus the memory organ:

```powershell
$rel = "https://github.com/1420079678-ctrl/agent-body/releases/download/v0.1.1"
dsh plugin --profile web add "$rel/dsh-external-dsh-organism-0.1.1.tgz"
dsh plugin --profile web add "$rel/dsh-external-dsh-cortex-0.1.1.tgz"
```

The rest of the catalog needs a host-side toolchain (a compiler, a browser, or external binaries) and is installed with its
replay script instead — see the catalog section below.

### Or work from source

This repository is the **organ layer** — it does not vendor the host. Two pieces, both public:

```powershell
# 1) the host: DeepSeek Harness itself
git clone https://github.com/deepseek-ai/deepseek-harness.git
#    follow that repository's build/run instructions; note where the checkout lives

# 2) the organs: this repository
git clone https://github.com/1420079678-ctrl/agent-body.git
```

Point the tooling at your host checkout, then bring an organ online. Each organ ships a **replay script** that links its
dependencies, compiles it, runs its offline regression, and tells you how to inject it:

```powershell
$env:DSH_CHECKOUT = "C:\path\to\deepseek-harness"

pwsh -File agent-body\workspace\plugins\dsh-organism\scripts\replay-organism.ps1
```

Replay scripts are idempotent — re-run them after a host upgrade to restore the organ. The same shape works for every
organ in the catalog (`replay-cortex.ps1`, `replay-web-crawl.ps1`, …).

Once injected, the first three commands to try:

```
body_status                 # full vitals: organs, fatigue, homeostasis, integrity self-check
body_map                    # the anatomy — which organ owns which capability
body_nerve action=send text="<your command>"   # route a command before executing it
```

---

## Verify it yourself

Everything below runs offline and deterministically — **no network, no model, no API key, nothing installed**.

```bash
npm run check     # the gate CI runs: constant tables + catalog + tests + benchmark, all in one
npm run demo      # five-minute end-to-end: command → impulse → dispatch → execute → attribute → reflex
npm run bench     # regenerate the token benchmark (writes benchmarks/results/REPORT.md)
```

`npm run check` is the honest one. It fails if the zero-dependency core drifts from the real kernel's constant tables,
if the organ catalog drifts from source, if any test fails, or if the benchmark moves off its committed baseline.
**All of it runs on a fresh clone with no `npm install`.**

### Organ regressions need the host runtime

```bash
npm run verify          # repository health check (structure, JSON, links, secret hygiene)
npm run verify:organs   # run every organ's offline regression
```

Each organ's suite loads its built `lib/`, which imports the host runtime (`@deepseek-ai/dsh-*`). On a bare clone that
does not resolve, so the runner reports **SKIP with the reason** — never a silent pass:

```
SKIP  dsh-organism/smoke-test.mjs      缺少宿主运行时 @deepseek-ai/dsh-tools
SKIP  dsh-web-crawl/selftest_local.py  缺少 Python 依赖 trafilatura
```

Inside an installed harness the same command runs them for real. Measured there:

| Organ | Command | Result (measured) |
| --- | --- | --- |
| `dsh-organism` | `node scripts/smoke-test.mjs` | **179 passed / 0 failed** (familyOf, evalCondition, decay, pruning, token estimation, gating contract) |
| `dsh-cortex` | `node scripts/smoke-test.mjs` | **58 passed / 0 failed** (tokenization, card mining, noise reduction) |
| `dsh-zero-residence` | `node scripts/smoke-test.mjs` | **16 passed / 0 failed** (pointer manifest, ledger math, exact-ID recall) |
| `dsh-war-bridge` | `node scripts/smoke-test.mjs` | **17 passed / 0 failed / 1 skipped** (the IDA chain skips without a sample PE) |
| `dsh-web-crawl` | `python scripts/selftest_local.py` | 46 offline assertions (extraction, magic‑byte routing, cascade) |

Two of these were red when this table was first written, and the failures were real:

- `dsh-zero-residence` reported **13 passed / 3 failed**. Root cause: session lookup matched by *substring* and returned
  whichever directory the filesystem happened to yield first, so `computeLedger('session-a')` could read
  `session-a-extra`'s log and report `T = 0` instead of `T = 2`. Fixed with exact-match-first resolution.
- `dsh-war-bridge` reported FAIL whenever no sample PE was present, because "skip" was recorded as a failed assertion —
  and `process.exit()` racing an in-flight `AbortSignal.timeout` tripped a libuv assertion that turned a green run into
  exit code 1. Both are fixed; a skip now says so.

The core packages are covered by `npm test`: **30 assertions, 0 failures**, including a **parity suite** that compares
the dependency-free port against the real kernel — exact agreement on `familyOf`/`tissueOf` across all 256 tool names,
`innervate` across 5 commands, `evalCondition` across 27 combinations, and `attributeFailure` across 8 error strings.
When no kernel build is present, parity **skips loudly** rather than passing quietly.

Runtime state is observable too — vitals, wounds, synapses and the pulse stream are all first‑class data:

```
body_status      → organs · capabilities claimed · heartbeat #31 @15s · heal rate 100%
body_heal        → 21 wounds healed · 0 chronic
body_pulse       → last nerve impulses, reflex fires, homeostasis alerts
```

---

## Write your own organ

An organ is a declaration plus optional hooks. The SDK validates it where you write it and throws with a field path,
instead of failing silently at runtime:

```js
import { defineOrgan, injectedSource } from './packages/organ-sdk/src/index.mjs'

export default defineOrgan({
  id: 'paper_reader',
  label: 'Paper reading (literature)',
  tier: 'professional',
  group: 'memory',
  purpose: 'turn one paper into searchable cards',
  capabilities: ['paper_fetch', 'paper_digest'],
  permissions: ['net:http'],
  signals: ['tools/result'],
  handles: ['network', 'timeout'],
  fallback: ['hippocampus'],
})
```

Two rules that save a debugging session:

- **Inject with a producer-owned source kind.** `injectedSource('@you/paper-reader')` returns
  `{ kind: 'plugin:@you/paper-reader' }` — the one shape both session-format generations accept. The retired
  `{ kind: 'plugin', plugin: ... }` wrapper stops a whole turn on a format-V4 host; the measurements are in
  [`docs/session-format-v4-compat.md`](docs/session-format-v4-compat.md).
- **Declare what you handle.** An organ that says it handles `timeout` gets that failure routed to it; one that stays
  silent gets a compensating neighbour through `fallback` instead.

What your change has to pass:

```bash
npm run check            # constants + catalog + message sources + tests + benchmark
npm run verify           # structure, JSON, links, secret hygiene
```

The full contract is in [`docs/ORGAN_SDK.md`](docs/ORGAN_SDK.md), and wiring an organ into a real host is in
[`docs/host-adapter.md`](docs/host-adapter.md).

---

## When not to use this

Being straight about this is cheaper for both of us:

- **You do not run DeepSeek Harness.** This is a plugin layer for one specific host, not a standalone agent framework.
- **You want a frozen third-party API.** The host's session format changed once already and broke every plugin that
  wrote to it; this repository tracks that host, so it moves when the host moves.
- **You need a supported product with an SLA.** v0.1.1 is a working release with reproducible gates, and the catalog is
  curated against one development install — expect rough edges outside the paths that install exercises.
- **You need Linux/macOS parity today.** Several organs carry Windows-specific hardening (hidden-window spawning, ACL
  sandbox compatibility). CI exercises the zero-dependency core on Linux; the organs less so.

---

## FAQ

**Do I need the host to try it?** No. `npm run demo` runs a real command → impulse → dispatch → execute → attribute →
reflex chain against the committed corpus with nothing installed and no API key.

**Does any of it call the network or a model?** Not in the part you can verify: `npm run check` installs nothing and
calls nothing. Model calls only happen where an organ asks the host to reason.

**What happens if I delete an organ?** Capability is lost, the body is not: the nervous system, heartbeat pump,
directive layer, reflex engine, anatomist and impulse dispatch depend on no single organ, and `body_call` compensates
with the online organ whose capability overlaps most. `body_organ action=integrity` prints that self-check.

**Why do the organ numbers differ between places?** There are two things: **26 organ identities in the catalog** (the
anatomy, across 8 systems) and **23 plugin packages in this repository** that implement them. Both numbers are labelled
wherever they appear.

**How is the 84.7% token figure measured?** It is tool-schema tokens only — the sum of every tool definition's name,
description and parameters against what the first turn can see after gating — on 48 representative commands, in the
cold-start setting (intent decides the visible set, no local history). That is the lower bound and the only
independently reproducible setting. The live setting, with history, measures 74.25%. Both are in
[`benchmarks/results/REPORT.md`](benchmarks/results/REPORT.md).

---

## Contributing

The most useful contribution right now is **another organ** — the contract is small enough to read in one sitting.

1. On a fresh clone, `npm run demo` and `npm run check`. If those are not green, that is a bug report worth filing on
   its own.
2. Copy the closest organ under `workspace/plugins/`, declare yours with `defineOrgan`, and add its entry to
   `catalog/organs.json` — the catalog is generated, and `npm run check:catalog` fails on drift rather than letting the
   two diverge.
3. Ship an **offline regression** with it. Only **5 of the 23 organs have one today** — `npm run verify` prints the
   list of the 18 that do not — and `npm run verify:organs` reports SKIP with a reason rather than passing quietly when
   the host runtime is absent. Writing those tests, or an organ that brings its own, is the most useful contribution
   right now.
4. Open a PR describing what the organ does, which system it belongs to, and the exact commands you ran.

Questions and discussions are welcome in the harness's
[**Show Your Plugins!**](https://github.com/deepseek-ai/deepseek-harness/discussions/7555) thread or as an issue here.

---

## Repository layout

```
agent-body/
├─ packages/
│  ├─ organ-core/   zero-dependency organ core: constant tables, gating, contract, host adapter
│  └─ organ-sdk/    defineOrgan() / defineReflex() — the authoring surface
├─ benchmarks/      reproducible token benchmark + frozen corpus + CI baseline
├─ catalog/         organs.json — tiers, permissions, failure handling (generated, drift-checked)
├─ examples/        the five-minute quickstart demo
├─ docs/            organ SDK guide · host adapter guide
├─ workspace/
│  └─ plugins/      the organs — one plugin per organ, each with src/ + lib/ (offline regression where one exists)
├─ scripts/         verify-repo.mjs · run-organ-regressions.mjs · run-tests.mjs
├─ .github/         CI (repo-check on Windows + Linux) and issue templates
├─ ARCHITECTURE.md  full system architecture
├─ ROADMAP.md       what the next six months are for
└─ README.zh-CN.md  中文文档
```

Runtime state (vitals, synapses, memory cards, pulse stream) lives in your harness data home, never in this repository.

---

## Roadmap

- [ ] Publish the organ contract as a standalone SDK so third‑party plugins can declare organs in a few lines
- [ ] One‑command organ installer that links, builds and registers every organ against a given host checkout
- [ ] Cross‑body sync: export learned synapses / reflexes / skills and import them into another install
- [ ] Sleep‑time model training: let consolidation propose new reflexes for review instead of authoring them directly
- [ ] Web panel for the anatomy: live organ map, wound ledger, pulse stream

---

## Notes

- **Licensing.** MIT for this project's own work ([LICENSE](LICENSE)). Plugins ported from upstream projects and the
  host itself keep their own terms — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Local‑first.** The harness GUI binds `127.0.0.1` — it can read files and execute commands on the machine it runs on.
  Do not expose it to a network or put it behind a public reverse proxy.
- **Windows‑first.** Developed and measured on Windows 11 · Node 24 · PowerShell 7. Several organs ship
  Windows‑specific hardening (hidden‑window spawning, ACL sandbox compatibility). Linux/macOS paths exist but are less
  exercised.
- **Numbers here are measured**, not aspirational. Figures marked *measured* were read from a live install; runtime
  counts (organs, capabilities) are yours to reproduce with `body_status`.

<div align="center">

---

****Six kernels. 26 cataloged organs across 8 systems, realised by 23 plugins. One heartbeat.**

If that's the kind of plugin platform you want, the architecture is all in [ARCHITECTURE.md](ARCHITECTURE.md).

⭐ **If this body has a pulse for you, [star this repo](https://github.com/1420079678-ctrl/agent-body/stargazers)** — it costs
nothing and is the single easiest way to help others find the project.

**Community.** Discussed in the [LINUX DO](https://linux.do/) community — a friendly Chinese-speaking
developer forum where this project was shared and where questions get answered.

<img src="https://api.star-history.com/svg?repos=1420079678-ctrl/agent-body&type=Date" alt="Star history chart" width="100%">

</div>
