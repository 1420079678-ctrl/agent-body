# 写一个器官（Organ SDK）

本文是器官作者的入口。目标：读完这一篇，你能写出一份**当场就能校验、跑起来不会静默失效**的器官。

```bash
npm run demo        # 先看一遍真实链路：命令 → 冲动 → 支配 → 执行 → 归因 → 反射
```

---

## 0. 什么是器官

一个插件就是**一个器官**：它声明自己管哪些能力、感知哪些信号、自己兜得住哪些失败。
其余都是一具身体的生理机能——神经路由、心脏泵血、反射弧、自愈账本由内核提供，**不在你的器官里重写**。

层级：**细胞**（一个工具）→ **组织**（器官内按职能聚成 9 类）→ **器官**（你的插件）→ **系统**（八大系统）→ **个体**。

你只需要回答四个问题：**管什么**（capabilities）、**碰什么**（permissions）、**听什么**（signals）、**兜什么**（handles）。

---

## 1. 最小骨架

```js
import { defineOrgan } from '@agent-body/organ-sdk'

export default defineOrgan({
  id: 'paper_reader',            // 必填，稳定标识，用小写下划线
  label: '论文阅读（文献）',       // 必填，人类可读
  tier: 'professional',          // 必填：core | general | professional | experimental
  group: 'memory',               // 必填：八大系统之一
  purpose: '把一篇论文拆成可检索的卡片',   // 必填，一句话
  capabilities: ['paper_fetch', 'paper_digest'],  // 必填，你管辖的工具名
  permissions: ['net:http'],     // 必填，可以为空数组——空的含义是「我不碰外部资源」
  sdkVersion: '^0.1.0',          // 必填，契约版本

  signals: ['tools/result'],     // 可选：你要听哪些宿主事件
  handles: ['network', 'timeout'],  // 可选：这些病因你自己处置，不上报自愈账本
  fallback: ['hippocampus'],     // 可选：你掉线时谁代偿

  hooks: {
    async onActivate(ctx) { /* 注册能力、订阅信号 */ },
    async onToolResult(ctx, e) { /* 观测 */ },
    async onFailure(ctx, e) { /* e.cause 已带确定性归因 */ },
    async onHeartbeat(ctx, blood) { /* 心跳泵来的血液包 */ },
  },
})
```

`defineOrgan` 会**当场校验**，不合规立刻抛 `OrganContractError`，错误信息带字段路径。

> 为什么要在声明时抛错：写错器官 id 或漏掉 `capabilities`，运行时表现为「什么都没发生」——
> 那是最难查的一类问题。宁可让你在写代码时就撞墙。

---

## 2. 四个问题，逐个说清

### 管什么 —— capabilities

写工具名，**支持前缀通配** `prefix*`：

```js
capabilities: ['paper_*', 'digest_one']
```

通配是精确前缀，不会误伤相邻家族：`sec_*` 不会匹配 `sec2_x`，`body_*` 不会匹配 `bodyguard`。
认领判定统一走 `organClaims(organ, toolName)`——**不要自己写字符串 `startsWith`**，那是最常见的漂移来源。

每一项能力都必须被某个器官认领。没人认领的工具会被自动升格成一个**自主器官**（`auto:<家族>`），
所以解剖永远不会有游离能力——但自主器官没有意图规则，只能经 `body_call` 取回。

### 碰什么 —— permissions

权限是**可枚举、有风险等级、要在安装时展示**的（这是本项目的硬性要求，不是可选礼仪）：

| 权限 | 含义 | 风险 |
| --- | --- | --- |
| `fs:read` | 读文件 | low |
| `fs:write` | 写文件 | medium |
| `net:http` | 出站 HTTP(S) | medium |
| `llm:call` | 调用模型（按 token 计费） | medium |
| `exec:process` | 执行子进程 | **high** |
| `net:listen` | 入站监听 | **high** |
| `secrets:read` | 读凭据（只读，不得外发） | **high** |
| `host:inject` | 运行时改变自身结构 | **high** |

`defineOrgan` 会算出 `riskLevel` 与 `requiresConfirmation`。**声明了权限就要真的用到**——
声明 `net:http` 却只读本地文件，会让安装确认变成噪音，最终所有人都闭眼点「同意」。

### 听什么 —— signals

宿主事件。常用：

| 信号 | 什么时候给你 | 你能拿它做什么 |
| --- | --- | --- |
| `tools/result` | 任一工具调用结束后 | 观测、喂反射、记经验 |
| `agent/pre-step` | 每一轮用户输入进来 | 注入上下文（注意这是 waterfall，必须 `await next()`） |
| `tools/change` | 工具集变化（插件增删） | 重建你自己的索引 |
| `organism/impulse` | 操作者命令被转成神经冲动 | 认领属于你的那一支 |
| `organism/heartbeat` | 每一跳 | 接上全身循环 |

### 兜什么 —— handles

失败是正常的一等公民。内核已经做了**确定性归因**，八类病因：

`tool_missing` / `arg_error` / `permission` / `timeout` / `network` / `not_found` / `conflict` / `unknown`

`handles` 里的病因**由你处置**，不上报自愈账本。不写就交给内核处方表。
一条硬规则：**`arg_error` 永远不自动重试**——那是调用方的锅，重试只会放大错误。

---

## 3. 反射弧：不过大脑的强逻辑

```js
import { defineReflex } from '@agent-body/organ-sdk'

const r = defineReflex({
  id: 'R-paper-cache-miss',
  name: '论文抓取 404 → 换镜像重试一次',
  triggerTool: 'paper_fetch',
  triggerOn: 'error',
  condition: 'error&&hit:404',          // 确定性条件，无 eval
  actionTool: 'paper_fetch',
  actionArgs: { url: '${text}', via: 'mirror' },  // ${tool} ${error} ${text} ${organ}
  cooldownMs: 5000,
  maxFires: 3,
})
```

条件语法：`always` / `error` / `ok` / `slow:<ms>` / `hit:<子串>` / `miss:<子串>`，用 `&&`、`||` 组合。

反射跑在零 token 的路径上，所以**必须**是确定性的。三条抑制保证它不会变成死循环：重入抑制（反射自己发起的调用不再触发反射）、
冷却、开火限额。

**学习与遗忘是成对的**：反射开火 ≥5 次且从未帮上忙，会被自动停用；同一「工具 × 病因」失败累计 3 次，
系统会自己长出一条反射。你不需要手动教它——用就是教。

---

## 4. 稳态要求（写器官的底线）

任何器官都必须满足：

- **可导出**：突触权重、反射统计、伤口账本、技能、信任度都能序列化成 JSON。
- **可重置**：能回到健康基线而**不丢已学到的经验**（清损伤、留记忆）。
- **可解释**：每个权重、每道伤口都要能说出「为什么是它」（`ruleIndex` / `cause` / `evidence`）。
- **可回滚**：任何自动处置都在账本里留 before/after。

---

## 5. 本地验证（不用装宿主）

```bash
npm test            # 全部单元 + 一致性测试
npm run demo        # 端到端跑一遍链路
npm run check       # 提交前总闸
```

写自己的器官测试时，直接用参考内存宿主，**零依赖**：

```js
import { createMemoryHost, validateOrganManifest } from '@agent-body/organ-core'
import myOrgan from './index.mjs'

const host = createMemoryHost({ tools: { paper_fetch: async () => ({ ok: true }) } })
// executeTool 绝不向器官抛异常，失败一律收成 { ok:false, error:{ message, cause } }
const r = await host.executeTool('paper_fetch', {})
```

---

## 6. 常见坑

| 坑 | 现象 | 正解 |
| --- | --- | --- |
| 自己写 `startsWith` 判能力 | 与内核认领规则悄悄漂移 | 一律用 `organClaims` |
| 在器官里 `try/catch` 每个工具调用 | 归因信息丢失、反射拿不到病因 | 适配器已兜住，直接看 `ok`/`error.cause` |
| `agent/pre-step` 里短路不 `await next()` | 丢掉宿主装配的上下文消息 | 必须 `await next()`，返回值保留 `kind:'enter'` |
| 从 `payload.messages` 取操作者输入 | 第 2 步之后里面只有工具结果 | 扫 `session.snapshotEvents()` 里 `source.kind==='user'` 的事件 |
| 工具可见性当成全局 | 核心工具挂在 agent 作用域，`schemas()` 看不到 | 需要时带 scope 取 |
| 反射动作调用自己的触发工具 | 自触发假阳性 | 触发模式用 `!` 排除自己，或依赖重入抑制 |
| 声明了用不到的权限 | 安装确认变噪音，用户闭眼同意 | 权限表与真实行为对齐 |

---

## 7. 提交前

```bash
npm run check    # 常量表 + 器官目录 + 全部测试 + 基准比对，任一漂移即失败
```

CI 会跑同一件事。如果你改了内核常量表，跑 `npm run tables` 重新抽取；如果新增了器官，
跑 `npm run catalog` 重新生成目录——两处都有 `--check` 模式保证不会忘记。
