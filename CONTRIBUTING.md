# Contributing to DeepSeek Harness — Agent-Body

Thanks for looking. This repository is a **complete harness install** (host source + data home +
workspace + organs), not a library, so the workflow is a little different from a normal npm package.

## Before you start

```powershell
node --version          # ^22.19.0 || >=24.0.0
npm run verify          # repository health check — must be green before you push
```

`npm run verify` is dependency-free and safe to run anywhere. It checks structure, JSON validity,
README links, secret-hygiene rules in `.gitignore`, and that every organ's regression suite exists.

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

**The regression is not optional.** A new organ without an offline regression will be asked for one
in review — it is the only way the project can claim "measurably better with use" without lying.

### Adding an organ

1. Scaffold the package (follow an existing organ; `dsh-organism` is the reference implementation).
2. Declare the organ: id, label, system group, capabilities, purpose.
3. Write `scripts/smoke-test.mjs` — pure functions, zero network, deterministic output, exit code 1 on failure.
4. Add a replay script under `scripts/replay-<organ>.ps1` that links, compiles, runs the regression and injects.
5. Register it in `data/profiles/web/package.json` (profile bundles) so it loads with the harness.
6. Update the organ catalog table in `README.md` **and** `README.zh-CN.md`.

### Changing an organ contract

The organ contract (sense → reflex → effect → homeostasis) is shared by all 26 organs. Changing how
organs are discovered, how impulses are routed, or how wounds close affects every organ at once —
open an issue first, and update `ARCHITECTURE.md` in the same pull request.

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
