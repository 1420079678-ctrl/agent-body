# Session format V4 compatibility — plugin-authored message sources

A compatibility note for anyone running these organs on a harness newer than the one they were written
against. It is short because the finding is binary: there is **no source literal that both generations
accept**.

## What changed

Injected messages carry a `source` object that identifies their producer. The two format generations
disagree about its `kind`:

| Generation | Rule | Consequence |
| --- | --- | --- |
| V3 (`packages/session/session-format-v2-to-v3/src/payload.ts`) | `SOURCE_KINDS` is a closed set that **includes** `'plugin'`; anything else throws `SessionFormatUnsupportedMigrationError('cannot safely transform unclassified message source')` | `{ kind: 'plugin', plugin: 'X' }` is the only accepted form |
| V4 (`packages/session/session-format-v3-to-v4/src/message-sources.ts`) | a message source must be an object with a non-empty string `kind` and **`kind !== 'plugin'`** | `{ kind: 'plugin:X' }` is the accepted form; the retired wrapper is refused on both read and write |

So `{ kind: 'plugin', plugin: 'X' }` is required by V3 and refused by V4, while `{ kind: 'plugin:X' }`
is required by V4 and refused by V3. A producer that hardcodes either literal cannot serve both.

`producerKind()` in `session-format-v3-to-v4/src/sources.ts` defines the intended mapping — third-party
producers become `plugin:<their name>` and drop the `plugin` field; the 24 names in
`RELEASED_SAME_NAME_PRODUCERS` keep their own name; `@deepseek-ai/dsh-system-prompt` under
`role: 'system'` becomes `system-prompt`. V3 *rows* are rewritten by the migration, which is why old
sessions still open and why this only surfaces on a write under V4.

## How it reaches a user

A third-party organ that injects a message through `agent.inject` / `agent.steer`, or returns one from a
step hook, supplies the `source` itself. On a V4 host that write is refused and the turn fails with:

```
本轮运行失败  format v4 message requires a producer-owned source kind
```

The organs in this repository construct `{ kind: 'plugin', plugin: '@dsh-external/dsh-<organ>' }`
(`dsh-organism`, `dsh-cortex`, `dsh-agent-teams`), so they are in the affected population. Nothing is
broken on the generation they were written for — the point of this note is that the upgrade changes the
contract, and no in-repo change can satisfy both generations without knowing which one is hosting.

## Diagnosis

Session logs are **multi-frame** zstd (`session.jsonl.zstd`, magic `28 B5 2F FD`). A single-frame
decompressor reads only the first frame, so "not found" from a plain text search is meaningless. Walk
the frames instead:

```powershell
node scripts/scan-session-sources.mjs --dir "$env:DSH_HOME/sessions"
```

It reports how many messages still carry the retired wrapper and groups them by producer — the name it
prints is the component that has to migrate. On a real 0.1.6 install, one session (12,019 rows) yielded
85 such messages across five first-party producers, all of which the migration converts on read.

## Options

1. **Stay on the generation you target.** The retired literal remains correct for V3 hosts, and the
   migration converts history, so nothing needs to change until the host moves.
2. **Emit the version-correct source.** Write `plugin:<organ>` on a V4 host and the wrapper on a V3
   host. This needs the host to expose its session format version — the source is hand-built today, and
   the composed result is what `producerKind()` would have produced anyway.
3. **Ask the host for it.** The durable fix is a producer-side helper (a session-scoped
   `injectedSource(name)`) so producers stop hardcoding either literal. Until one exists, every
   out-of-tree injector has to branch on the version or accept breakage on upgrade.

Reported upstream with source citations and the measurement above:
<https://github.com/deepseek-ai/deepseek-harness/discussions/7556>.

---

**中文摘要**：会话格式 V3 的白名单只接受 `{kind:'plugin', plugin:'X'}`，V4 又明确拒绝 `'plugin'`、要求
`plugin:<名字>`——两个版本**没有共同可用的字面量**。本仓库的器官（organism / cortex / agent-teams）都按 V3
写法注入消息，因此在 V4 宿主上写入会被拒、报「本轮运行失败」。诊断用
`node scripts/scan-session-sources.mjs --dir "$env:DSH_HOME/sessions"`（会话日志是多帧 zstd，普通文本搜索
读到的是假的「没有」）。已带源码出处与实测数据上报官方，见上方链接。
