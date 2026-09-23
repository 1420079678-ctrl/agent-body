# Contributing to DeepSeek Harness — Agent-Body

Thanks for looking. This repository is the **organ layer** for DeepSeek Harness — the organs plus a
dependency-free core (`packages/organ-core`, `packages/organ-sdk`) — not the host itself and not a library. The README
carries the install path (one command, prebuilt tarballs) and a [recorded replay of a real
install](https://1420079678-ctrl.github.io/agent-body/) that runs without installing anything.

## Before you start

```powershell
node --version          # ^22.19.0 || >=24.0.0
npm run check           # the gate CI runs — must be green before you push
```

`npm run check` is dependency-free and runs entirely offline: constant-table drift, organ-catalog drift, the unit and
parity test suites, and the token benchmark against its committed baseline. `npm run verify` is the broader repository
health check (structure, JSON validity, README links, secret hygiene, regression presence) — run both.

**Nothing here needs `npm install`.** The core packages import nothing outside Node built-ins, and that is a rule, not
an accident: `packages/organ-core` and `packages/organ-sdk` must stay dependency-free so a fresh clone can run the
tests and the demo with no network.

## Writing an organ

The full authoring guide is [`docs/ORGAN_SDK.md`](docs/ORGAN_SDK.md). The short version:

```js
import { defineOrgan } from '@agent-body/organ-sdk'

export default defineOrgan({
  id: 'paper_reader', label: '论文阅读（文献）', tier: 'professional', group: 'memory',
  purpose: '把一篇论文拆成可检索的卡片',
  capabilities: ['paper_fetch', 'paper_digest'],
  permissions: ['net:http'],
  sdkVersion: '^0.1.0',
  hooks: { async onToolResult(ctx, e) { /* ... */ } },
})
```

`defineOrgan()` validates at authoring time and throws `OrganContractError` with a field path. Four rules that get
PRs sent back:

- **Capabilities use `organClaims`-style matching**, including `prefix*` wildcards. Never hand-roll `startsWith`.
- **Declare only the permissions you actually use.** An unused `net:http` turns install confirmation into noise.
- **`handles` names the failure causes you own.** Everything else goes to the kernel's remedy table. `arg_error` is
  never auto-retried — that is a caller bug, and retrying amplifies it.
- **A reflex must be deterministic** (no `eval`, no model call) and must not be able to trigger itself.
- **Inject messages with a producer-owned source kind.** `injectedSource('@you/your-organ')` returns
  `{ kind: 'plugin:@you/your-organ' }` — the one shape both session-format generations accept. The retired
  `{ kind: 'plugin', plugin: … }` wrapper stops a whole turn on a format-V4 host
  ([measurements](docs/session-format-v4-compat.md)), and `npm run check:sources` fails the build if it returns.

See [`docs/host-adapter.md`](docs/host-adapter.md) before touching anything host-specific. Organs must not import a
host SDK directly — that boundary is the project's main risk mitigation.

## Organs (plugins)

Every plugin under `workspace/plugins/` is an **organ**. An organ is expected to ship:

```
workspace/plugins/dsh-<name>/
├─ package.json          name @dsh-external/dsh-<name>, version, description, dsh.organ metadata
├─ src/index.ts          TypeScript source
├─ lib/index.js          built output (committed — the host loads lib/, not src/)
├─ scripts/smoke-test.mjs  offline, deterministic regression (no network, no model calls)
└─ README.md             what the organ senses, what it does, how to verify it
```

**A new organ ships with an offline regression** — it is the only way the project can claim "measurably better with
use" without lying, and a PR without one will be asked for it in review.

The current tree is behind that standard: `npm run verify` reports an offline regression for **5 of 23 organs** and
prints the ones missing one. Adding those is the most useful contribution available right now — `dsh-pentagi` and
`dsh-vuln-remediator` are the easiest starting points, since their core paths are deterministic functions that need no
host runtime.

### Adding an organ

1. Scaffold the package (follow an existing organ; `dsh-organism` is the reference implementation).
2. Declare the organ with `defineOrgan()`: id, label, tier, system group, capabilities, permissions, purpose.
3. Run `npm run catalog` so `catalog/organs.json` picks it up — CI fails if the catalog drifts from source.
4. Write `scripts/smoke-test.mjs` — pure functions, zero network, deterministic output, exit code 1 on failure.
5. Add a replay script under `scripts/replay-<organ>.ps1` that links, compiles, runs the regression and injects.
6. Register it in `data/profiles/web/package.json` (profile bundles) so it loads with the harness.
7. Update the organ catalog table in `README.md` **and** `README.zh-CN.md`.

### Changing an organ contract

The organ contract (sense → reflex → effect → homeostasis) is shared by all 26 catalogued organs. Changing how
organs are discovered, how impulses are routed, or how wounds close affects every organ at once —
open an issue first, and update `ARCHITECTURE.md` in the same pull request.

## Numbers, claims, and the benchmark

Anything that looks like a measurement has to survive `npm run bench:check`. Two rules:

- **State the scope with the number.** "84.7% of tool-schema tokens" and "84.7% of the prompt" are different claims;
  only the first one is true. The scopes are defined in [`benchmarks/README.md`](benchmarks/README.md).
- **If a number moves, either explain why or re-baseline.** `npm run bench:baseline` is a deliberate act: the PR must
  say what changed and why the new value is correct. Re-baselining to make CI pass is not a fix.

`benchmarks/results/REPORT.md` is a **deterministic** artifact — no timestamps, no platform names — so it can be
diffed and so CI can assert the working tree stays clean after regeneration. Do not add volatile fields to it.

## House rules

- **Never commit credentials.** `data/` is ignored for a reason; `.credentials.yaml` must never appear
  in a diff. `npm run verify` fails the build if the ignore rules lose that protection.
- **Numbers must be measured.** The README quotes live vitals; if you change one, say where it came from.
- **Windows-first.** Six organs carry Windows hardening (hidden-window spawning, ACL sandbox
  compatibility). Keep `windowsHide: true` on every spawn and never open a visible console window.
- **First-hand evidence.** A bug report without reproduction steps and a real command output is a
  guess. `body_evidence`-style discipline applies to PRs too.
- **One concern per PR.** Split independent changes; keep the diff reviewable.
- **Bilingual docs.** User-facing docs ship in English (`README.md`) and Chinese (`README.zh-CN.md`).
  Update both, or say why one is not affected.

## Commit messages

Conventional-commit prefixes, Chinese or English body — both are accepted:

```
feat(organism): add wound attribution for permission failures
fix(cortex): stop counting heartbeat pulses as wakefulness
docs(arch): document the venous return loop
chore(ci): pin actions to a SHA
```

## Pull requests

Fill in the template. A PR should state what changed, how it was verified (paste the command and its
result), and whether any README/ARCHITECTURE number moved.

## Security

Do not open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the MIT licence in [LICENSE](LICENSE).
