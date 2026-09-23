# Session format V4 compatibility — plugin-authored message sources

How this repository's organs inject messages, and what changes when the harness moves from session
format V3 to V4. The short version: **one literal is portable for ordinary injected messages, and the
only slot that is not portable is `system/message`.**

> Correction. An earlier revision of this note claimed that *no* literal satisfies both generations. That
> was drawn from the V3 source kind whitelist without checking which code path reads it. It is wrong for
> every slot except `system/message` — see "What was confirmed on a running host" below.

## The two rules

| Generation | Rule | Where |
| --- | --- | --- |
| V3 migration | `SOURCE_KINDS` is a closed set that **contains** `'plugin'`; anything else throws `cannot safely transform unclassified message source` | `packages/session/session-format-v2-to-v3/src/payload.ts` — `assertSource()`, called from `assertEvent(event, 2)` |
| V3 native write/read | structural validation plus canonical payload checks; message sources are **not** classified | same file — `assertV3StructuralRow()` / `assertCanonicalPayload()`, reached from `assertV3Event()` |
| V4 | a message source must be an object with a non-empty string `kind` and **`kind !== 'plugin'`** | `packages/session/session-format-v3-to-v4/src/message-sources.ts` |

`assertEvent()` returns before the source checks when the version is 3, so the whitelist governs
**migration**, not native V3 traffic. What does keep a source requirement on the native V3 path is
`system/message`: `assertSystem()` demands `kind === 'plugin'` and a non-empty `plugin` string.

V4's `producerKind()` defines the intended target shape — third-party producers become `plugin:<their
name>` and drop the `plugin` field, the 24 names in `RELEASED_SAME_NAME_PRODUCERS` keep their own name,
and `@deepseek-ai/dsh-system-prompt` under `role: 'system'` becomes `system-prompt`. V3 *rows* are
rewritten by the migration on read, so history keeps opening either way.

## What was confirmed on a running host

Not inferred from the source — asked of the harness's own current encoder (`encodeCurrentEvent`, the
function the JSONL writer calls) on a 0.1.6 install:

| Slot | `{ kind: 'plugin', plugin: 'x' }` | `{ kind: 'plugin:x' }` |
| --- | --- | --- |
| `user/message` | accepted | **accepted** |
| `agent/inbox/spliced` | accepted | **accepted** |
| `system/message` | accepted | **refused** — `system message requires plugin source` |

Reproduce with `node scripts/probe-source-kind.mjs <path-to-the-installed-format-catalog>`; it builds
each event and calls the encoder, so the answer comes from the host rather than from a reading of it.

## What this repository does about it

The organs inject through `createUserMessage(...)`, `subagents.followup(...)` and `captain.send(...)` —
all ordinary message slots, none of them `system/message`. They now emit the portable form directly, so
they are correct on a V3 host today and already in the shape V4 requires:

```ts
source: { kind: 'plugin:@dsh-external/dsh-organism' }
```

The identity string is carried through unchanged, so the value is exactly what the V3→V4 migration would
have produced for an existing row. `system/message` remains the one slot where a producer has to know
which generation is hosting; no organ here writes that slot.

## Diagnosis for anyone hitting the V4 refusal

Session logs are **multi-frame** zstd (`session.jsonl.zstd`, magic `28 B5 2F FD`). A single-frame
decompressor returns only the first frame, so "not found" from a plain text search means nothing. Walk
the frames instead:

```powershell
node scripts/scan-session-sources.mjs --dir "$env:DSH_HOME/sessions"
```

It counts messages still carrying the retired wrapper and groups them by producer — the name it prints
is the component that has to migrate. On a real 0.1.6 install, one 12,019-row session yielded 85 such
messages across five producers; the migration converts all of them on read, which is why old sessions
open while a *write* under V4 fails.

Reported upstream, including the correction:
<https://github.com/deepseek-ai/deepseek-harness/discussions/7556>.

---

**中文摘要**：本仓库的器官通过 `createUserMessage` / `followup` / `send` 注入消息，都是普通消息槽位，现在
统一写 `{ kind: 'plugin:<包名>' }`——这一形式在 **V3 与 V4 上都可用**（在本机 0.1.6 上用宿主自己的
`encodeCurrentEvent` 实测：`user/message` 与 `agent/inbox/spliced` 接受，`system/message` 拒绝）。V3 那份
`SOURCE_KINDS` 白名单只管 **v2→v3 迁移**，不校验原生 v3 写入。唯一不通用的是 `system/message`（V3 强制要求
旧包装），本仓库没有任何器官写这个槽位。诊断脚本：
`node scripts/scan-session-sources.mjs --dir "$env:DSH_HOME/sessions"`（会话日志是多帧 zstd，普通文本搜索
读到的是假的「没有」）。
