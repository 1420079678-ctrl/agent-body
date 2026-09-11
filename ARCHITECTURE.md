# Agent-Body 系统架构

这套系统的本体不是一组插件，而是**一具身体**：有器官、有神经、有心脏、有反射、有记忆、能自愈、能自训练。
LLM 是它的大脑，操作者的命令是它唯一且最高的运行指令。

> 核心命题：**缺一个器官，功能受影响但不致命、随拆随用。** 神经总线、心脏泵、指令层、反射引擎、解剖器、冲动传导
> 六个内核不依赖任何一个器官，因此拆掉任何插件，架构不塌。

---

## 一、五层生物层级

| 层级 | 是什么 | 本机实测 |
| --- | --- | --- |
| 个体 | 这具身体（当前 DSH 安装） | 1 |
| 系统 | 人体八大系统分组：executive / nervous / immune / sensory / motor / memory / metabolic / endocrine | 8 |
| 器官 | 一个插件（统一 Agent 契约：感知 → 反射 → 效应 → 稳态） | 26（申报 25 + 自主 1） |
| 组织 | 器官内按功能动词聚类：感知 / 检验 / 效应 / 合成 / 记忆 / 调控 / 清除 / 计量 / 基质 | 9 类 |
| 细胞 | 单个能力单元（一个工具） | 256 |

三层都可单独观测：`body_map`（器官与系统）、`body_cell`（细胞与组织）、`body_status`（生命体征）。
未申报的插件会被自动升格为「自主神经器官」——实测 **256/256 项能力全部被认领，0 游离**。

---

## 二、三大内核

### 1. 指令登记（Sovereign Command）

操作者登记的运行指令是这套身体的运行时基线，优先级高于任何器官、反射弧、编排链路与外部服务方。

- 运行指令以最高优先级注入会话上下文（order=1），随每一次心跳泵向全身，每次工具调用都盖服从戳。
- 有常驻条款条款与服从审计（工具输出出现推诿/拒绝话术即记 `obey` 脉冲）。
- 落盘：`$DSH_HOME/plugins/dsh-organism/sovereign.json`；查看/登记：`body_law`。

### 2. 神经总线（事件驱动 + 冲动传导）

- 操作者的每一句命令都是一束**神经冲动**：`agent/pre-step` 自动把它变成冲动下发全身，按意图确定性支配（innervate）
  相应器官，并回一句支配简报——**先传导，再执行**。
- 冲动经 `organism/impulse` 广播全身，任何插件都能接住属于自己的那一支；离线器官自动计算代偿者。
- **突触学习（Hebbian）**：被支配的器官干成了活 → 强化「命令类 → 器官」权重，支配顺序越用越准。
- 去重按（会话 id, 事件序号）持久化到 `innervate.json`，热重载不会重复下发。
- 主要入口：`body_nerve`（send / map / trace / degrade）。

### 3. 心脏泵（循环回路）

- 真起搏器：1s 基准时钟 + 可变间期（危重告警 ×3、疲劳 ×2、长期静默 ÷2）——**心跳会变速**。
- 每一跳把「运行指令 + 本体感觉 + 稳态告警」打成血液包，落盘 `bloodstream.json`，并广播
  `organism/heartbeat`，任何插件都可 `ctx.on('organism/heartbeat', …)` 接上这轮循环。
- **闭环双向**：器官经 `organism/venous` 回血；学到的新知识经 `organism/oxygenated` 肺循环氧合后再泵向全身。
- 查看：`body_heart`。

---

## 三、五条生命机制

| 机制 | 做什么 | 关键实现 |
| --- | --- | --- |
| 反射弧 | 确定性逻辑不过大脑，命中即毫秒级执行，零 token | 条件无 eval（always/error/ok/slow:N/hit:/miss:，`&&`/`\|\|` 组合）；三重抑制：重入抑制（只标反射自身发起的调用）+ 冷却 + 限额 |
| 自愈闭环 | 失败 → 归因 → 处方 → **复检** | 归因确定性（tool_missing / arg_error / permission / timeout / network / not_found / conflict / unknown）；只读类处方自动执行，有副作用类留大脑裁决，**arg_error 绝不自动重试**；器官下次成功才闭合伤口，超 5 分钟未愈转 `chronic`；`body_heal` |
| 自训练 | 用就是教，无需手动 | ①突触强化/衰减（半衰期 30 分钟，\|w\|<0.2 修剪）②同一「工具×病因」失败 3 次 → **系统自己写出一条反射**，开火 ≥5 次零贡献自动停用 ③跨器官链路全通且 ≥3 步 → 固化为可重放技能（`body_skill`） |
| 记忆与时间 | 皮层：静默即入睡、睡中巩固、醒来出报告 | 记忆卡五类（坑 / 打法 / 薄弱环节 / 未解 / 事实）；**巩固零模型调用**，纯确定性规则；命令级主动召回注入上下文；稳态告警去重收敛（重复只计数不刷屏，从未自愈者静默） |
| 零驻留 | 上下文不驻留、无损可重建 | 以确定性指针压缩替换有损 LLM 摘要；`zr_compact` 武装压缩、`zr_recall` 按调用 id 逐字还原、`zr_ledger` 量化注意力积分与压缩比、`zr_fast` 异步执行长命令不阻塞 |

---

## 四、器官清单（主要器官）

| 器官 id | 载体插件 | 系统分组 | 职能 | 主要能力 |
| --- | --- | --- | --- | --- |
| organism | `dsh-organism` | nervous / endocrine | 解剖、神经、心脏、指令、反射、自愈、技能 | `body_map` `body_cell` `body_status` `body_heart` `body_law` `body_nerve` `body_call` `body_reflex` `body_heal` `body_skill` `body_organ` `body_pulse` |
| cortex | `dsh-cortex` | nervous / memory | 睡眠、巩固、长期记忆、告警降噪 | `cortex_sleep` `cortex_memory` `cortex_homeo` |
| zero-residence | `dsh-zero-residence` | metabolic | 上下文零驻留、异步效应器 | `zr_compact` `zr_recall` `zr_ledger` `zr_fast` |
| web-crawl | `dsh-web-crawl` | sensory（眼） | 多引擎抓取（静态 → 浏览器 → 托管兜底三级级联） | `webcrawl` `webcrawl_site` `webcrawl_map` `webcrawl_extract` `webcrawl_links` `webcrawl_doc` `webcrawl_http` `webcrawl_status` |
| war-bridge | `dsh-war-bridge` | nervous（联络） | 三链合体：逆向 × 攻击 × 编排 | `ida` `war_status` `war_case` `war_memory` |
| pentagi | `dsh-pentagi` | executive（小脑） | 多智能体编排：侦察→门禁→测绘→利用→后渗透→报告→复盘 | `agi_plan` `agi_next` `agi_flow` `agi_memory` `agi_reflect` `agi_report` `agi_team` |
| sec-workbench | `dsh-sec-workbench` | immune | 攻击与验证工具链 | `sec_*`（路由、范围门禁、证据链、journal、toolchain…） |
| reverse-skill | `dsh-reverse-skill` | immune | 逆向路由与决策质量层 | `rev_route` `rev_case` `rev_journal` `rev_toolindex` |
| vuln-remediator | `dsh-vuln-remediator` | immune | 漏洞修复与虚拟补丁 | `vuln_scan` `vuln_cve` `vuln_sbom` `vuln_priority` `vuln_patch_gen` `vuln_patch_verify` `vuln_remediate` `vuln_plan` |
| office-docs | `dsh-office-docs` | motor（手） | PDF/DOCX/PPTX/XLSX 构建与提取 | `*_pdf` `*_docx` `*_pptx` `*_xlsx` `*_convert` |
| academic-research | `dsh-academic-research` | executive（前额叶） | 学术研究流水线 | `ars_pipeline` `ars_review` `ars_paper_plan` `ars_integrity` `ars_metrics` |
| 其他 | `dsh-mastery-loop` `dsh-mirofish` `dsh-agent-teams*` `dsh-social-card` `dsh-minimal-gray` `dsh-usage` `dsh-observer` … | 各组 | 教学闭环、群体预测、多智能体、卡片设计、预设、计量 | — |

按器官调度而不是背工具名：`body_call organ=<器官> tool=<能力>`；器官离线时自动找能力重叠最高且仍在线的器官**代偿**，
`body_nerve action=degrade` 可查看脱器官降级全景。

---

## 五、信号契约（事件总线）

| 事件 | 含义 | 接它的器官 |
| --- | --- | --- |
| `tools/result` | 每次工具结果（成功/失败、输出、耗时） | 体征、反射、皮层经历记录、自愈归因 |
| `tools/post-execute` | 执行收尾观测（时延） | 体征、皮层 |
| `tools/change` | 器官（工具集）增减 | 解剖器自动发现 |
| `agent/pre-step` | 每轮步进前（waterfall，需 `await next()`） | 冲动下发、记忆召回、组织注入 |
| `organism/heartbeat` | 心跳泵出的血液包 | 任何想接上循环的插件 |
| `organism/venous` | 器官回血 | 心脏 |
| `organism/oxygenated` | 肺循环氧合后的新知识 | 心脏 → 全身 |
| `organism/impulse` | 神经冲动广播 | 各器官按支配应答 |
| `subagent/start` / `subagent/end` / `goal/changed` | 子代理与目标生命周期 | 体征、编排 |

---

## 六、数据落盘

| 数据 | 位置 |
| --- | --- |
| 器官申报 / 反射 / 指令 / 血液 / 脉冲 | `$DSH_HOME/plugins/dsh-organism/{organs,reflexes,sovereign,bloodstream}.json`、`pulse.jsonl` |
| 体征跨重启持久化 | `$DSH_HOME/plugins/dsh-organism/vitals.json`（器官 + 细胞两层，10s 节流） |
| 皮层记忆与状态 | `$DSH_HOME/plugins/dsh-cortex/{memory.jsonl,state.json}` |
| 零驻留账本与作业句柄 | `$DSH_HOME/data/zero-residence/` |
| 学术 / 渗透 / 抓取等器官数据 | `$DSH_HOME/plugins/<器官>/{flows,memory,reports,reviews,evidence}` |

**设计原则**：复原则只清疲劳与伤口，不动已学到的突触 / 反射 / 技能——**损伤清除，智慧保留**。

---

## 七、验证口径

- 每个器官自带**离线确定性回归**（不依赖外网，可随时重跑）：本机实测
  `dsh-organism/scripts/smoke-test.mjs` **79 项通过 / 0 失败**、
  `dsh-cortex/scripts/smoke-test.mjs` **58 项通过 / 0 失败**、
  `dsh-war-bridge/scripts/smoke-test.mjs`（24 项）、`dsh-web-crawl/scripts/selftest_local.py`（46 项）、
  `dsh-zero-residence/scripts/smoke-test.mjs`。
- 升级/重装后的重放脚本统一在 `scripts/replay-*.ps1`（junction + 编译 + 回归 + 注入）。
- 实测口径示例：拆掉 `dsh-office-docs` 后立即检出 `craft` 器官离线并给出代偿，核心六件套全绿；
  自愈路径下 arg_error 伤口 3.5s 复检闭合；心跳变速 4→8 次/分；空闲 25 秒皮层活动计数 +4（证明心跳通道贯通）。

---

## 八、目录约定

```
<DSH_CHECKOUT>\
├─ app\          DSH 实现源码与构建产物（宿主本体）
├─ data\         DSH_HOME：settings.yaml / profiles / sessions（含凭据，不入库）
├─ workspace\
│  └─ plugins\   器官源码（每个插件一个器官，入库）
├─ scripts\      重放 / 冒烟 / 运维脚本
└─ token-econ\   token 经济学分析脚本与报告
```
