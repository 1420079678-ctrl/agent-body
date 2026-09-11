# dsh-agent-teams-pro（Deep Research Edition）

DeepSeek Harness 的 **DeerFlow 深度研究版多智能体团队**插件：把字节跳动 [DeerFlow](https://github.com/bytedance/deer-flow)（GitHub 热榜第一的多智能体深度研究框架）的**专业角色编组 + 分阶段研究流水线**，移植进 DeepSeek Harness 本地的 `dsh-agent-teams` 编排引擎，合成一个"超级智能体团队"。

一句话：**原 `dsh-agent-teams` 是"手"（编排引擎），DeerFlow 是"脑"（深度研究协议），本插件把两者合成一个更强的整体。**

## 它是什么

- **引擎（来自旧的 dsh-agent-teams）**：队长/成员/任务依赖/邮箱通信/Web 活动面板，全部复用——`agent_teams_create` / `add_member` / `create_task` / `claim_task` / `update_task` / `send_message` / `status` / `delete`，驱动 durable 可续聊子代理协作。
- **Deep Research 协议（来自 DeerFlow）**：
  - **8 个专业角色**：coordinator、planner、researcher、searcher、synthesizer、reviewer、reporter、implementer——每个自带 persona + 阶段 + 成功判据 + 交付物，加入即生效。
  - **分阶段流水线**：`recon → plan → research → synthesize → review → report`，每阶段有明确依赖和成功判据，research 可按子问题扇出并行。
  - **证据纪律**：成员产出必须带可验证来源 URL 或可复现命令；reviewer 负责拒绝无出处结论。浅尝或未引用的工作是失败任务，即使总结很长。

## 用起来

对助手说一句自然语言即可启动一个深度研究团队：

> 用 AgentTeams 深度研究一下当前主流开源 AI Agent 框架的选型与差异

队长会按 DeerFlow 协议执行：`deerflow_plan` 生成计划 → 按角色拉成员 → 沿流水线拆任务并声明依赖 → 逐任务唤醒成员 → 轮询收集 → 审查引用 → 落盘报告 → 删除团队。

## 新工具

| 工具 | 作用 |
|---|---|
| `deerflow_plan` | 一键生成带依赖的分阶段深度研究计划 + 推荐角色编组 + 各阶段成功判据 |
| `deerflow_members` | 返回推荐的 Deep Research 角色编组（阶段/工具提示/成功判据） |
| `agent_teams_*` | 原 AgentTeams 编排引擎全部工具（不变） |

`agent_teams_add_member` 的 `role` 传入 DeerFlow 角色名（planner/researcher/searcher/synthesizer/reviewer/reporter/implementer/coordinator）时，自动使用该角色的深度研究 persona；传其它角色名则退回通用 worker persona。

## 装配 & 重放

- 源码位于 `workspace/plugins/dsh-agent-teams-pro`；经 profile bundle 装配（`dsh-agent-teams-pro` 替换原 `dsh-agent-teams`）。
- 升级后重跑幂等脚本 `workspace/scripts/replay-agent-teams-pro.ps1`（构建 host lib → patch profile → 建 junction），再重启 web 服务器。

## 用起来的完整工作流（DeerFlow 深度研究协议）

```
用户请求 → 队长(deerflow_plan) → 建团队
  → 拉成员(searcher/planner/researcher/synthesizer/reviewer/reporter)
  → 拆任务 recon→plan→research(fan-out)→synthesize→review→report
  → 逐任务 claim + send_message 唤醒
  → 收集 + 审查(引用/证据) + 综合
  → 落盘 report + agent_teams_delete
```

## License

MIT
