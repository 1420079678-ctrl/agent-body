<div align="center">

<img src=".github/assets/banner.svg" alt="Agent-Body — 插件即是器官：23 个器官、8 大系统、一颗心脏，省下 82% 提示词 token，0 个慢性伤口" width="100%">

# Agent‑Body

**DeepSeek Harness 的器官化插件层：器官、神经冲动、心跳、反射弧、长期记忆，以及闭环自愈。**

*这里的插件不是一份工具清单，而是一具活着的身体里的器官。*

[![Organs](https://img.shields.io/badge/organs-23-ff69b4)](#器官目录)
[![Schema gating](https://img.shields.io/badge/schema%20gating-节省%2082%25%20token-2ecc71)](#token-经济)
[![Regressions](https://img.shields.io/badge/离线回归-200%2B%20断言-informational)](#自己验证)
[![Node](https://img.shields.io/badge/node-22.19%20%7C%2024-339933)](#快速开始)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[架构文档](ARCHITECTURE.md) · [器官目录](#器官目录) · [自己验证](#自己验证) · [**English**](README.md)

</div>

---

## 为什么做这个

几乎所有 Agent 框架最后都会长成同一个样子：一堆工具、一份越来越长的系统提示词清单，以及一个**会话之间什么都记不住**的 agent。

同一个错误它要犯第二遍才「知道」它存在。它说不清自己哪项能力是坏的。它根本不知道某个依赖的插件已经掉线了——它只是照常调用、然后失败。而你还在一轮轮地为那些从没人调用的工具 schema 付 token。

**Agent‑Body 押的是相反的一注：把插件系统当成一具有机体来对待。**

每个插件都声明自己是一个**器官**——带着能力、感知和反射。其余的一切都是生理活动：一套把你的命令路由到正确器官的神经系统，一颗按节律把状态泵向全身的心脏，一些**完全不消耗模型调用**就能开火的反射弧，以及一条在考虑重试之前先把失败归因清楚的愈合回路。

结果就是：这套系统**用得越多越好**，而且你把某些部分拆掉，它依然站得住。

---

## 它有什么不一样

### 🫀 它有一颗心脏，不是一个循环

真正的起搏器以 1 秒为基准时钟，并**可变间期**——危重告警时快 3 倍、疲劳时快 2 倍、长时间静默时慢 2 倍。每一跳把当前的操作者指令、本体感觉与稳态告警打包成一份血液包，写入 `bloodstream.json`，并以 `organism/heartbeat` 广播出去。任何器官一行代码就能接上这套循环：

```ts
ctx.on('organism/heartbeat', (blood) => { /* 你的器官从此有了脉搏 */ })
```

循环是闭环而不是单向喷灌：器官经 `organism/venous` 回血，新学到的知识先经 `organism/oxygenated` 氧合，再泵向全身。

### 🧠 你的一句话会变成一束神经冲动

你输入一条命令。在模型还没开始推理之前，`agent/pre-step` 就把它转换成冲动，确定性地**支配（innervate）**应该处理它的器官，并广播 `organism/impulse`——告诉每个器官**该用自己哪一个能力**。

然后身体会记住这条路线。被支配的器官真的把活干成了，一条 Hebbian 突触就强化「这类命令 → 那个器官」；干砸了就衰减。支配顺序会自己重排，并持久化在 `synapses.json`。

```
你：  "抓取这个站点并抽取结构化数据"
冲动 → 感官(web-crawl) · 执行(plan) · 免疫(verify)
     → 每个器官都被点名该开哪一项能力
```

### 🩹 自愈是闭环，不是口号

```
失败 → 确定性归因 → 按处方处置 → 复检
```

归因靠的是判定而不是猜：`tool_missing` / `arg_error` / `permission` / `timeout` / `network` / `not_found` / `conflict` / `unknown`。处方表决定怎么处置——只读类自动执行，有副作用的留给大脑裁决，而且 **`arg_error` 绝不自动重试**（参数错了还重试，只会把错误放大）。

伤口只有在**那个器官下次成功**时才会闭合——系统不会自己宣布自己痊愈了。超过 5 分钟仍未闭合的伤口标记为 `chronic`，停止空转。

> 在开发机上实测：**21 个伤口愈合 · 愈合率 100% · 0 个慢性伤口。** 一个 `arg_error` 伤口在真正的修复落地后 3.5 秒闭合。

### 🌱 它会自己训练，也会主动遗忘

三条学习通道持续运行，你不需要专门教它任何东西：

1. **突触学习**——干成就强化「命令类别 → 器官」，干砸就削弱。
2. **反射自生成**——同一个「工具 × 病因」失败 3 次，系统会**自己写出一条反射弧**（`R-auto-<病因>-<工具>`），下次同样失败时自动开火。
3. **链路固化**——任何跨器官链路跑通且 ≥3 步，就被固化成可重放的技能。

遗忘同样是刻意的：突触按 30 分钟半衰期衰减，权重低于 `|w| < 0.2` 且已有样本就修剪；开火 ≥5 次却零贡献的反射退役；连续失败的技能被遗忘。

`body_heal action=rehab` 把器官恢复到健康基线——**损伤清除，智慧保留**：疲劳与伤口归零，已学到的突触、反射、技能一条不动。

### 💤 它会睡觉、巩固、记住

静默 2 分钟进入浅睡，5 分钟进入深睡；深睡中每 2 分钟跑一轮**零模型调用的巩固**——纯确定性规则，把这一天的经历提炼成长期记忆：

| 记忆卡 | 提炼自 |
| --- | --- |
| `pitfall`（坑） | 同一工具连续失败 ≥3 次 |
| `playbook`（打法） | 跨工具成功链路重复 ≥2 次（同工具重复的平凡链路被过滤） |
| `hotspot`（薄弱环节） | 调用 ≥8 次且成功率 <70% |
| `unresolved`（未解） | 最后一次成功之后累计 ≥3 次失败 |
| `fact`（事实） | 操作者明确给出的事实 |

新命令进来会触发确定性召回——标签 > 标题 > 正文，再乘权重——最相关的几张卡被注入上下文。久未使用的卡按 168 小时半衰期衰减，并且是**归档而不是删除**。

### 🪶 零驻留上下文

这套引擎不用有损的 LLM 摘要，而是把常驻内容替换成**确定性指针**——并且每一个被遮蔽的字节都能从会话日志里逐字还原：

| 工具 | 作用 |
| --- | --- |
| `zr_compact` | 武装一次强制压缩，绕过比例阈值 |
| `zr_recall` | 按工具调用 id 或会话序号逐字重建被遮蔽的内容 |
| `zr_ledger` | 量化注意力积分、三段成本分解与压缩比 |
| `zr_fast` | 长命令异步执行，绝不阻塞当前回合 |

### 🧩 器官可以缺，架构不会动

六个内核不依赖任何一个器官：**神经总线 · 心脏泵 · 指令层 · 反射引擎 · 解剖器 · 冲动传导**。

拔掉一个插件，身体照常运转。卸载 `dsh-office-docs` 时立刻被检出——`craft` 器官离线，它的能力**由重叠度最高的器官代偿**，核心完整性依旧全绿。根本没安装的器官会被如实报告为「未安装」而不是「坏掉」——这一条根治了一场每 15 秒刷一次告警的风暴。

<a id="token-经济"></a>

### 📉 把 token 经济当成一等公民

工具 schema 按需显影，由「这一轮到底在干什么」决定：

> **每次请求只暴露 256 项能力中的 49 项**——`10,173` token 而不是 `55,154`，**省下约 82%**，其余能力离一次 `body_call` 之遥。

---

## 五层生物层级

| 层级 | 是什么 | 数量 |
| --- | --- | --- |
| **个体** | 这具身体（正在运行的那套安装） | 1 |
| **系统** | 人体八大系统：执行 / 神经 / 免疫 / 感官 / 运动 / 记忆 / 代谢 / 内分泌 | 8 |
| **器官** | 一个插件，遵守同一份契约：感知 → 反射 → 效应 → 稳态 | 本仓库 **23** 个 |
| **组织** | 器官内部的功能细分：感知 / 检验 / 效应 / 合成 / 记忆 / 调控 / 清除 / 计量 / 基质 | 9 类 |
| **细胞** | 单个能力单元（一个工具） | 运行时统计 |

每一层都可观测：`body_map`（器官与系统）、`body_cell`（细胞与组织）、`body_status`（生命体征）。未申报的插件会被自动升格为**自主神经器官**——开发机上实测 **256/256 项能力全部被认领，0 游离**。

---

## 架构一览

```mermaid
graph TD
    OP([操作者命令]) -->|神经冲动| NERVE["body_nerve · 支配"]
    NERVE --> BUS{{"organism/impulse"}}
    LAW(["操作者指令"]) --> HEART
    HEART[["心脏 · organism/heartbeat"]] --> BUS
    BUS --> ORGANS["器官 · 能力"]
    ORGANS -->|"tools/result"| REFLEX["反射弧 · 零 token"]
    ORGANS -->|失败| HEAL["自愈 · 归因 → 处方 → 复检"]
    ORGANS -->|经历| CORTEX["皮层 · 睡眠 / 巩固 / 记忆"]
    CORTEX -->|"召回"| ORGANS
    HEAL --> VITALS["体征 · vitals.json"]
    VITALS --> HEART
    ORGANS -->|回血| HEART
```

完整细节——三大内核、五项生命机制、事件契约、落盘状态、验证方法——见 **[ARCHITECTURE.md](ARCHITECTURE.md)**。

---

## 器官目录

下表每一项都是 `workspace/plugins/` 下真实存在的插件。其中五个核心器官带完整的**离线回归测试**（见[自己验证](#自己验证)）；其余器官通过各自的重放脚本验证。

| 器官 | 插件 | 系统 | 标志性能力 |
| --- | --- | --- | --- |
| **器官内核** | `dsh-organism` | 神经 · 内分泌 | `body_map` `body_cell` `body_status` `body_heart` `body_law` `body_nerve` `body_call` `body_reflex` `body_heal` `body_skill` `body_organ` `body_pulse` `body_tokens` |
| **皮层** | `dsh-cortex` | 记忆 | `cortex_sleep` `cortex_memory` `cortex_homeo` |
| **零驻留** | `dsh-zero-residence` | 代谢 | `zr_compact` `zr_recall` `zr_ledger` `zr_fast` |
| **网页抓取** | `dsh-web-crawl` | 感官 | `webcrawl` `webcrawl_site` `webcrawl_map` `webcrawl_extract` `webcrawl_doc` `webcrawl_http` `webcrawl_links` `webcrawl_status` |
| **浏览器** | `dsh-browser-ultimate` | 感官 | 真实浏览器引擎（登录态、抗反爬、CDP）+ 正文抽取 |
| **战友桥** | `dsh-war-bridge` | 神经 | `ida`（IDA Pro MCP 直连桥）`war_status` `war_case` `war_memory` |
| **PentAGI** | `dsh-pentagi` | 执行 | `agi_plan` `agi_next` `agi_flow` `agi_memory` `agi_reflect` `agi_report` `agi_team` |
| **安全工作台** | `dsh-sec-workbench` | 免疫 | 49 项 `sec_*` 能力：`sec_route` `sec_scope` `sec_evidence` `sec_webscan` `sec_webtest` `sec_exec` `sec_jwt` `sec_hashoff` `sec_brute` `sec_lateral` `sec_stealth` `sec_journal` `sec_report` … |
| **逆向技能** | `dsh-reverse-skill` | 免疫 | `rev_route`（44 条路由规则）`rev_case` `rev_doctrine` `rev_playbook` `rev_journal` `rev_toolindex` |
| **漏洞修复** | `dsh-vuln-remediator` | 免疫 | `vuln_scan` `vuln_cve` `vuln_sbom` `vuln_priority` `vuln_patch_gen` `vuln_patch_verify` `vuln_remediate` `vuln_plan` `vuln_knowledge` |
| **漏洞日练** | `dsh-vuln-mastery-loop` | 免疫 | 定时日练闭环 + 报告 |
| **量化 OS** | `dsh-quant` | 执行 | 59 项 `quant_*` 能力：数据 / 因子 / 机器学习 / 风控 / 执行，`quant_research_pipeline` `quant_backtest` `quant_walk_forward` `quant_portfolio_optimize` `quant_stress_test` … |
| **精通闭环** | `dsh-mastery-loop` | 内分泌 | `study_orient` `study_deconstruct` `study_model` `study_diagnose` `study_transfer` `study_review` `study_path` |
| **学术研究** | `dsh-academic-research` | 执行 | `ars_pipeline`（10 阶段状态机）`ars_review`（5 席位评审）`ars_paper_plan` `ars_integrity` `ars_metrics` |
| **Office 文档** | `dsh-office-docs` | 运动 | PDF / DOCX / PPTX / XLSX 构建、提取、渲染校验、pandoc 互转 |
| **社交卡** | `dsh-social-card` | 运动 | `social_card_scaffold` `social_card_render` `social_card_validate` `social_card_docs` |
| **Agent 小队** | `dsh-agent-teams-pro` | 执行 | 队长 + 成员、任务依赖、消息传递、实时 Web 面板 |
| **MiroFish** | `dsh-mirofish` | 执行 | `mirofish_status` `mirofish_api`——群体智能预测引擎客户端 |
| **极简灰度** | `dsh-minimal-gray` | 代谢 | 极简 agent 预设、平台自适应 Shell |
| **钉钉桥** | `dsh-dingtalk-bridge` | 神经 | Stream 长连接机器人桥接进 harness |
| **基金扫描** | `dsh-daily-fund-scan` | 执行 | 定时基金池扫描 + 建议报告 |
| **文件芯片** | `dsh-file-chips` | 感官 | 输入框里的附件芯片 |
| *（遗留）* | `dsh-crawl4ai` | 感官 | 保留用于回滚，已被 `dsh-web-crawl` 取代 |

---

## 快速开始

本仓库是**器官层**——不打包宿主。两件事，都是公开的：

```powershell
# 1) 宿主：DeepSeek Harness 本体
git clone https://github.com/deepseek-ai/deepseek-harness.git
#    按该仓库的构建/运行说明装好，记住 checkout 的位置

# 2) 器官：本仓库
git clone https://github.com/1420079678-ctrl/agent-body.git
```

把工具链指向你的宿主 checkout，然后让一个器官上线。每个器官都自带**重放脚本**——它会链接依赖、编译、跑离线回归，并告诉你如何注入：

```powershell
$env:DSH_CHECKOUT = "C:\path\to\deepseek-harness"

pwsh -File agent-body\workspace\plugins\dsh-organism\scripts\replay-organism.ps1
```

重放脚本是幂等的——宿主升级后重跑一次即可恢复该器官。目录里每个器官都是同一套做法（`replay-cortex.ps1`、`replay-web-crawl.ps1` …）。

注入之后，先试这三条命令：

```
body_status                 # 完整体征：器官、疲劳、稳态、架构完整性自检
body_map                    # 解剖图——哪项能力归哪个器官管
body_nerve action=send text="<你的命令>"   # 先看这条命令该由谁办，再执行
```

---

## 自己验证

每个器官都带**离线、确定性**的回归测试——不联网、不调模型，随时可以重跑。

```powershell
npm run verify          # 仓库体检（结构、JSON、链接、密钥卫生）
npm run verify:organs   # 跑遍所有器官的离线回归
```

| 器官 | 命令 | 结果（实测） |
| --- | --- | --- |
| `dsh-organism` | `node scripts/smoke-test.mjs` | **79 通过 / 0 失败**（familyOf、evalCondition、衰减、修剪、token 估算、显影契约） |
| `dsh-cortex` | `node scripts/smoke-test.mjs` | **58 通过 / 0 失败**（分词、记忆卡提炼、降噪） |
| `dsh-war-bridge` | `node scripts/smoke-test.mjs` | 24 项断言，含 IDA 全链路与幂等交接 |
| `dsh-web-crawl` | `python scripts/selftest_local.py` | 46 项离线断言（抽取、魔数路由、级联） |
| `dsh-zero-residence` | `node scripts/smoke-test.mjs` | 指针压缩 + 召回完整性 |

运行时状态同样可观测——体征、伤口、突触、脉冲流都是一等公民数据：

```
body_status      → 器官数 · 能力认领 · 心跳 #31 @15s · 愈合率 100%
body_heal        → 21 个伤口愈合 · 0 个慢性
body_pulse       → 最近的神经冲动、反射开火、稳态告警
```

---

## 仓库结构

```
agent-body/
├─ workspace/
│  └─ plugins/      器官——一个插件一个器官，各自带 src/ + lib/ + 离线回归
├─ scripts/         verify-repo.mjs · run-organ-regressions.mjs
├─ .github/         CI（Windows + Linux 双平台仓库体检）与 issue 模板
├─ ARCHITECTURE.md  完整系统架构
└─ README.md        English
```

运行时状态（体征、突触、记忆卡、脉冲流）都落在你的 harness 数据目录里，永远不进这个仓库。

---

## 路线图

- [ ] 把器官契约发布成独立 SDK，让第三方插件几行代码就能声明器官
- [ ] 一条命令的器官安装器：针对指定宿主 checkout 完成链接、编译与注册
- [ ] 跨身体同步：导出已学到的突触 / 反射 / 技能，导入到另一套安装
- [ ] 睡眠期模型训练：让巩固过程提出新反射供人审阅，而不是直接写入
- [ ] 解剖图 Web 面板：实时器官图、伤口账本、脉冲流

---

## 说明

- **授权**：本项目自有部分为 MIT（[LICENSE](LICENSE)）；移植自上游项目的插件以及宿主本体各自保留其原始许可——见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **本地优先**：harness 的 GUI 绑定 `127.0.0.1`——它能读写文件、能在这台机器上执行命令。不要把它暴露到网络，也不要放在公网反向代理后面。
- **Windows 优先**：本项目在 Windows 11 · Node 24 · PowerShell 7 上开发与实测。若干器官带 Windows 专用加固（隐藏窗口拉起进程、ACL 沙箱兼容）。Linux/macOS 路径存在，但打磨程度较低。
- **本文中的数字都是实测值**，不是愿景。标为「实测」的数字读自真实运行中的安装；器官数与能力数你可以自己用 `body_status` 复现。

<div align="center">

---

**六个内核，二十三个器官，一颗心脏。**

如果你想要的就是这样的插件平台，完整架构都在 [ARCHITECTURE.md](ARCHITECTURE.md)。

</div>
