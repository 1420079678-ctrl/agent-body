# dsh-cortex — 皮层（睡眠 · 记忆 · 巩固）

给这具身体装上**时间**与**记忆**的器官。

## 为什么需要它

`dsh-organism` 给了身体「器官 + 心跳 + 反射 + 自愈 + 自训练」，但它只有**此刻**：心跳均匀地跳、器官各干各的、经验随会话一起漂走。一个从不睡觉的身体有两处硬伤：

- **学到的留不住** —— 突触长期停在个位数，干过的活没有沉淀成可复用的东西；
- **忘不掉的甩不掉** —— 同一条离线告警每跳刷一次，真异常被噪音淹没。

皮层补的正是生物体区别于机器的这两件事：**静默即入睡、睡中巩固经历、醒来带着记忆**。

## 三大机制

### ⓪ 睡眠周期 Sleep-Wake Cycle

**清醒信号取「会话是否在推进」（`agent/pre-step`），不是「有没有工具在跑」。** 这个判据是实测逼出来的：系统内部的后台工具（如零驻留的维护调用 `zr_fast`）会周期性自触发，若按工具调用计时，`lastActivityAt` 每十几秒被刷新一次，身体**永远睡不着**——而且是静默失败，看起来一切正常。同理，organism 的心跳每 15 秒一跳，也只记入独立的 `beats` 计数、**不参与睡意计算**：心脏自动跳动不代表身体在干活。

静默越久越困：

| 静默时长 | 相位 | 行为 |
|---|---|---|
| < 2 分钟 | ☀️ 清醒 | 正常采集经历 |
| ≥ 2 分钟 | 🌙 浅睡 | 停止采集，等待更深 |
| ≥ 5 分钟 | 😴 深睡 | **执行巩固**（每 2 分钟一轮，有新经历才跑） |

任何活动立刻唤醒，并给上一段睡眠写一份报告（睡了多久、整理出什么）。手动入口：`cortex_sleep action=enter`。

`cortex_sleep action=status` 会显示**最近清醒信号的来源**（如 `session-step`）——睡不着时先看它，就知道是谁在刷活动。

### ① 长期记忆 Long-term Memory

巩固把经历提炼成四类**记忆卡**：

| 类型 | 触发条件 | 价值 |
|---|---|---|
| 坑 `pitfall` | 同一工具连续失败 ≥3 次 | 下次别在同一个地方摔 |
| 打法 `playbook` | 跨工具成功链路重复出现 ≥2 次 | 同类任务直接复用顺序 |
| 薄弱环节 `hotspot` | 调用 ≥8 次且成功率 <70% | 知道哪里该多留一步校验 |
| 未解 `unresolved` | 最后一次成功之后累计 ≥3 次失败 | 死路标记，下次换路径 |
| 事实 `fact` | 手工写入 | 稳定结论 |

记忆卡带权重与使用计数，跨会话持久化（`memory.jsonl`）。**新命令一进来，皮层按关键词主动召回最相关的几张卡注入上下文**——不必等大脑自己想起来（零 token 的确定性打分：标签 > 标题 > 正文，乘权重）。

遗忘也是机制的一部分：久未使用的卡按 168 小时半衰期衰减，权重低于 0.08 自动归档（不物理删除，`cortex_memory action=revive` 可召回）。

### ② 稳态降噪 Homeostatic Noise Control

接住 `organism/heartbeat` 泵来的全身稳态告警，做两件事：

- **窗口内重复**（默认 60 秒）只计数不刷屏；
- **反复出现且从未自愈**（默认 5 次）收敛为「已知稳态偏移」并静默——之后再重复既不计入抑制也不刷屏，把音量还给真正的异常。

纯函数内核 `reduceNoise()`，16 项断言覆盖。

## 工具

| 工具 | 用途 |
|---|---|
| `cortex_sleep` | status 看相位与昼夜节律 / enter 手动入睡并立即巩固 / wake 唤醒 / consolidate 立刻巩固 / history 睡眠史 / **config 查看或运行时调节律参数** |
| `cortex_memory` | search 检索 / add 写入 / list 全览 / stats 记忆画像 / forget 归档 / revive 召回 |
| `cortex_homeo` | status 看收敛情况 / silence·unsilence 手工干预 / clear 清空账本 |

## 配置（schemastery，可在 profile 里覆写）

```yaml
sleepAfterMs: 120000       # 静默多久算浅睡
deepAfterMs: 300000        # 静默多久算深睡（深睡才巩固）
autoSleep: true            # 关掉则只能手动 enter
consolidateGapMs: 120000   # 深睡中两轮巩固的最小间隔
tickMs: 3000               # 相位巡检周期
memoryRecall: true         # 命令级主动召回
recallLimit: 3             # 每次最多召回几张
memoryHalfLifeMs: 604800000  # 记忆衰减半衰期（7 天）
archiveBelow: 0.08         # 权重低于此值归档
bufferMax: 400             # 经历环形缓冲上限
noiseWindowMs: 60000       # 告警去重窗口
noiseConvergeAt: 5         # 重复几次收敛为「已知稳态偏移」
```

## 数据

```
$DSH_HOME/plugins/dsh-cortex/
├── memory.jsonl    # 长期记忆（一行一张卡）
└── state.json      # 相位 / 昼夜节律 / 告警账本 / 睡眠报告 / 统计
```

## 与 organism 的分工

- **organism 侧根治**：申报器官的来源插件不在时标 `installed=false`，判为「未安装」而非「离线」——告警只报「装了却坏了」的，不再每跳刷一个永远好不了的僵尸告警。
- **cortex 侧兜底**：即使 organism 真的发出告警，皮层也会去重、收敛、静默。

两层互补：一层不产生噪音，一层即使有噪音也不让它变噪音。

## 构建与重放

```powershell
& <DSH_CHECKOUT>\workspace\plugins\dsh-cortex\scripts\replay-cortex.ps1
# junction 依赖 → tsc 编译 → 58 项离线确定性回归
```

注入：`dev_inject_plugin dir=<DSH_CHECKOUT>\workspace\plugins\dsh-cortex`
已注入后改代码：`dev_reload_package dsh-cortex`（**只编译不重载 = 跑的还是旧代码**）

已 `dev_install_package` 进 profile bundles，**随 DSH 重启自动上线**。

## 实测口径（2026-09-11）

| 机制 | 验证方式 | 结果 |
|---|---|---|
| **自动入睡 → 深睡 → 自动巩固** | 节律临时压到 6s/15s，真静默 36 秒全程采样 | `awake → light(12.9s) → deep(18.9s)`，深睡中自动巩固（次数 1→2），零人工干预 |
| **醒来报告** | 下次会话活动唤醒后看 history | `12:20:52 最深 deep 时长 32 秒 扫描 4 段经历` |
| **心跳不干扰睡眠** | 同期观察心跳计数与相位 | 心跳 1→2（通道在），相位保持 deep、静默时长持续增长到 40s |
| **遗忘归档** | 半衰期临时压到 1 秒 + 关召回 16 秒后巩固 | 真实触发 `归档遗忘：1`，`cortex_memory action=revive` 可召回 |
| **降噪收敛** | 造真实告警（内脏感觉连续失败 3 次），逐 11 秒采样 | count 爬到 6 时 `silenced=True`，此后彻底安静 |
| **降噪抑制** | 默认 60 秒窗口下重复告警 | 抑制计数 2→4→7→9，窗口内重复只计数不刷屏 |
| **命令级召回** | 写入记忆卡后发下一条命令 | 输入里出现《皮层记忆》注入，召回计数 +1，卡权重 2.00→2.20 |

58 项离线确定性回归另覆盖纯内核（`tokens`/`normalizeNote`/`cardId`/`extractPatterns`/`reduceNoise`）。

## 设计约束

- **零外部依赖**，全部副作用挂 `ctx.effect`（热重载/卸载自动清理）。
- **巩固零模型调用**：全是确定性规则，不烧 token。
- 皮层绝不阻断主流程：所有信号钩子内 `try/catch` 兜底，异常不上抛。
- 供单测的纯内核：`tokens` / `normalizeNote` / `cardId` / `extractPatterns` / `reduceNoise`。
