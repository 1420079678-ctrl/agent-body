# 怎么捕获一份新的工具语料

基准的输入是**一台真实运行的 agent-body 上的工具定义全集**。语料进仓库后就能离线复跑，
但捕获本身必须在活体上做。这份文档记录真实用过的捕获路径，避免别人猜。

## 为什么不能用 `ctx.tools.schemas()`

第一次捕获得到的是 **229 项**——只有插件工具。
`ctx.tools.schemas()` 不带参数时返回**根作用域**，而核心工具（`read` / `write` / `edit` /
`pwsh` / `web_search` / `subagent` / `todo_write` / `glob` / `grep` / `read_image` / `skill` …）
挂在 **agent 作用域**上，看不到。

这个差别不是细节：漏掉 27 个核心工具会让分母偏小，而它们又在常驻集里（永不门控），
于是「门控前」被低估、「门控后」地板算成 0，**收益被系统性高估**。

## 正确路径

```js
// 在宿主里跑（或做成一个 staging 工具）
const keys = [...ctx.tools.layers.scoped.keys()]   // 每个作用域键就是一个 agent
const byName = new Map()
for (const scope of keys) {
  for (const t of ctx.tools.schemas(scope)) {
    if (t?.name && !byName.has(t.name)) byName.set(t.name, t)
  }
}
// 再并上根作用域的插件工具
for (const t of ctx.tools.schemas()) if (t?.name && !byName.has(t.name)) byName.set(t.name, t)
```

写出的结构与 `benchmarks/corpus/raw/captured-all-tools.json` 一致：
`[{ name, description, parameters }]`。

> 本仓库实际用的就是这个路径，见 `benchmarks/tools/dump-scope-schemas.md` 里的 staging 工具源码。
> 若宿主改了这个 API，捕获会失败——那本身就是需要修的信号，不要退回用 229 项的旧语料。

## 活体装配快照（另一个输入）

`benchmarks/corpus/raw/live-gate.json` 记录**捕获那一刻**真实的按需显影结果（哪 64 项可见、
内核账本报了多少 token）。它有两个用途：

1. 复现「活体口径」的数字（含近期活动与历史信任，不只是冷启动意图）
2. **反向校验估算器**：用仓库里的估算器重算这 64 项，应当落在内核账本报出的数值附近。
   两边对不上，说明语料或估算器有问题——这比收益数字好看重要得多。

取法：调用 `body_tokens action=gate`，把显影依据与显影清单抄进 JSON。

## 整理与脱敏

```bash
node benchmarks/tools/prepare-corpus.mjs
```

它会：补全 `corpus/tools.json`、固化运行轨迹 fixture（伤口账本 / 反射统计 / 突触 / 技能）、
把本机路径与用户名替换成占位符。**提交前检查一遍 `git diff`**：
语料里不该出现你的用户名、绝对路径或任何凭据。
