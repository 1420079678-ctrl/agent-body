# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private reporting instead:
**Security → Advisories → Report a vulnerability** on this repository (or the contact channel on the
repository profile).

Please include: the affected organ or host path, the exact version/commit, reproduction steps, the
observed impact, and whether the issue is reachable without local access.

Expect an acknowledgement within a few days. Fixes ship as patch releases; credit is given unless you
ask otherwise.

## Supported versions

| Version | Supported |
| --- | --- |
| `master` (current) | ✅ |
| older commits / vendored host snapshots | ❌ — upgrade first |

## Threat model — read this before deploying

This harness is **local-first and single-user by design**:

- The Web GUI binds `127.0.0.1` **without authentication** and can read files, execute commands and
  load plugins on the host machine.
- Exposing the port (`host: 0.0.0.0`), putting it behind a reverse proxy, or port-forwarding it is
  equivalent to handing over the machine's shell. **Do not do it.**
- Credentials live in `data/.credentials.yaml` and never belong in a commit, an issue, or a log. The
  repository's `.gitignore` protects that path, and `npm run verify` fails if the protection is removed.

### In scope

- Sandbox escape from a plugin or tool call to unrestricted host access
- Credential leakage through logs, session files, telemetry or error output
- Command injection through tool arguments, plugin config, or file paths
- Supply-chain issues in the bundled host source or in a vendored dependency
- Windows-specific hardening regressions (visible console windows, ACL sandbox bypass)

### Out of scope

- Anything requiring the GUI to be reachable from another host (see threat model above)
- Missing hardening headers, version disclosure, or similar findings with no demonstrated impact
- Attacks that require the operator to run untrusted code with the harness's own privileges

## Hardening checklist for operators

1. Keep the GUI bound to `127.0.0.1`.
2. Keep `data/` out of backups, screenshots and repositories — it holds live provider keys.
3. Review a new organ's source before injecting it: plugins run with the harness's privileges.
4. Prefer per-provider keys with spending limits over a single all-purpose key.
