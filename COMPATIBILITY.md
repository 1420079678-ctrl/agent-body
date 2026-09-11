# Compatibility matrix

What is tested, what is merely asserted, and what is known to break. The distinction is the point of this file.

## Runtime

| Component | Supported | Tested in CI | Notes |
| --- | --- | --- | --- |
| Node.js 24.x | ✅ | ✅ | Primary target (`>=24.0.0`) |
| Node.js 22.19+ | ✅ | ✅ | Minimum (`^22.19.0`) |
| Node.js < 22.19 | ❌ | — | Uses `node:test` features and `structuredClone` assumptions |
| Windows (win32-x64) | ✅ | ✅ | Development platform; path and shell quirks are covered by tests |
| Linux (x64) | ✅ | ✅ | CI matrix |
| macOS | ⚠️ untested | ❌ | Expected to work; nobody has run it. **Not claimed as supported.** |
| Python 3.11+ | only for `verify:web-crawl` | ⚠️ | The Python organ is separate; core packages are pure Node |

The core packages (`organ-core`, `organ-sdk`) have **zero runtime dependencies** — no `node_modules` needed to run the
tests or the demo.

## Organ contract

| Contract version | SDK | Host (Harness) | Status |
| --- | --- | --- | --- |
| `^0.1.0` | `@agent-body/organ-sdk@0.1.x` | developer preview (2026‑09) | ✅ current |

There is exactly one supported contract version today. This table will grow **only** when a second host adapter exists
(roadmap M2/M4), because a compatibility matrix with one column is a claim, not information.

## Host adapters

| Adapter | Status | Verified by |
| --- | --- | --- |
| `createMemoryHost()` (reference, in‑repo) | ✅ works | All contract tests, the five‑minute demo |
| DeepSeek Harness | ✅ works (preview) | Live body; parity suite compares against the real kernel |
| Any other runtime | ❌ none yet | — |

**The single biggest risk in this project** is that the organ layer is effectively Harness‑only while Harness is in
developer preview. The HostAdapter boundary is the mitigation; a second adapter is the proof. Until then, treat
"host‑independent" as a design goal, not a verified property. See [`docs/host-adapter.md`](docs/host-adapter.md).

## Benchmark reproducibility

| Input | Reproducible offline? | Depends on |
| --- | --- | --- |
| `corpus/tools.json` (256 tools) | ✅ frozen | — |
| `corpus/trace-*.json` (healings, reflexes, synapses, skills) | ✅ frozen | — |
| `corpus/trace-live-gate.json` | ❌ | A live body at capture time |
| Cold‑start savings (84.71%) | ✅ | Frozen corpus + task set |
| Live savings (74.25%) | ❌ | Run history; committed as a snapshot only |
| Parity suite | ⚠️ | A kernel build **plus** host packages on disk; SKIPs loudly without them |

## Known limitations

| Limitation | Impact | Tracked |
| --- | --- | --- |
| `perOrganCap = 10` truncates large organs by declaration order | 6 of 48 benchmark tasks need a `body_call` hop | roadmap M3 |
| Corpus is one machine's tool set | The denominator is not universal | [`benchmarks/tools/CAPTURE.md`](benchmarks/tools/CAPTURE.md) |
| Attribution falls back to `unknown` on real Chinese PowerShell error text | Healing accuracy is overstated | roadmap M5; a test asserts the *wrong* answer on purpose to keep it visible |
| Parity skips without a kernel build | "Zero‑dependency port is faithful" is unverified in a bare clone | Accepted; CI with a kernel is preferred |
| macOS untested | Not supported, only plausible | — |

## How to report a compatibility problem

Include the exact `npm run check` output and your Node version. If a claim in this file is wrong, that is a bug —
the file is meant to be the honest version, and the roadmap's exit criteria are written so that fixing it is
verifiable.
