# 宿主适配器（HostAdapter）

## 为什么要这一层

这套器官层今天长在 DeepSeek Harness 上。Harness 仍在开发者预览期，API 会变。
**绑死一个预览版宿主，是这套系统最大的单点风险**——宿主一改，25 个器官一起碎。

解法：器官只依赖 `HostAdapter` 这个接口，不直接依赖任何宿主 SDK。
Harness 只是**第一个**适配器。仓库里已经有一个参考实现：`createMemoryHost()`——内存宿主，
零外部依赖，契约测试与五分钟 demo 都跑在它上面。

**它存在的意义不是测试便利，而是证明「器官层不是 Harness 的附属品」**：只要第二个适配器能跑通同一套契约测试，
这条边界就是真的，而不是嘴上说的。

---

## 接口

### 必须实现（缺一个就不算适配器）

| 方法 | 作用 | 备注 |
| --- | --- | --- |
| `listTools()` | 列出当前可见的工具名 | 供解剖与代偿计算 |
| `getToolSchema(name)` | 取单个工具 schema | 供 token 计量与显影 |
| `executeTool(name, args)` | 执行工具 | **器官唯一的效应器通道** |
| `emit(event, payload)` | 向宿主广播事件 | 心跳、冲动、静脉回血都走它 |
| `on(event, fn)` | 订阅宿主事件 | 返回退订函数 |
| `readState(key)` | 读持久状态 | 跨重启的体征、记忆 |
| `writeState(key, value)` | 写持久状态 | 结构化克隆，不共享引用 |
| `log(level, message, fields)` | 写日志 | 器官不直接碰 stdout |
| `now()` | 当前时间 | 可由测试注入，让时间相关逻辑可复现 |

### 可选实现（有则更好，缺了就降级）

| 方法 | 作用 | 宿主没有时器官应当 |
| --- | --- | --- |
| `registerSystemPromptSection(id, text)` | 往系统提示注入一段 | 跳过注入，功能降级但不报错 |
| `watchTools(fn)` | 工具集变化回调 | 轮询或干脆不重建索引 |
| `spawnTimer(ms, fn)` | 周期任务 | 不自起 timer（**不得**在器官里偷偷 `setInterval`） |

`validateHostAdapter(adapter)` 会逐项检查并给出缺失清单——**在写第二个适配器时先跑它**，别等运行时才发现。

---

## 两条硬约定

### ① `executeTool` 绝不向器官抛异常

失败是正常的一等公民。实现必须把任何异常收成：

```js
{ ok: false, error: { message: string, cause: FailureCause } }
```

`cause` 走内核的确定性归因（`attributeFailure`），于是反射弧与自愈账本能拿到**同一套病因**，
而不是各自去解析错误字符串。参考实现就是这么做的：

```js
try {
  return { ok: true, result: await t(args) }
} catch (e) {
  const message = e?.message ?? String(e)
  return { ok: false, error: { message, cause: attributeFailure(message) } }
}
```

器官里因此**不应该**出现围绕 `executeTool` 的 `try/catch`。

### ② 器官不直接依赖宿主事件名

`agent/pre-step`、`tools/result` 是 Harness 的叫法。器官声明自己**听什么语义**（`signals`），
由适配器把宿主事件映射过来。宿主没有对应信号时，器官要**降级**，不是崩溃。

---

## 契约测试

一致性测试（`packages/organ-core/test/parity.test.mjs`）把移植版与**真实内核**逐项比对：
`familyOf` / `tissueOf` / `organClaims` 覆盖全部 256 个工具名、`innervate` 覆盖 5 条命令、
`evalCondition` 覆盖 27 种组合、`attributeFailure` 覆盖 8 类错误串。

内核需要宿主运行时才能加载。加载不了时测试会**明确 SKIP 并打印原因**——不算通过。
纯离线环境跳过是可接受的；假装通过不是。

---

## 写第二个适配器的步骤

1. `validateHostAdapter(yourAdapter)` —— 先让必选方法齐全。
2. 把 `createMemoryHost()` 的契约测试原样指向你的适配器，跑通。
3. 接真实事件：把宿主的生命周期映射到 `LIFECYCLE_HOOKS`（`onInstall` / `onActivate` / `onImpulse` /
   `onToolResult` / `onFailure` / `onHeartbeat` / `onDeactivate` / `onUninstall`）。
4. **一个器官都不改**，让它同时跑在两个宿主上。改了就说明接口没抽干净——该修的是接口。

第 4 步是真正的验收标准。见 [ROADMAP](../ROADMAP.md) 的 M4。
