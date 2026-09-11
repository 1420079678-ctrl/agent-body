# @dsh-external/dsh-reverse-skill

把 [zhaoxuya520/reverse-skill](https://github.com/zhaoxuya520/reverse-skill)（安全任务技能路由包）的**精髓**移植进 DSH，
为我们的破解/攻击工具链（`sec_*` / `agi_*` / `vuln_*`）提供**方法论层 + 证据纪律层**。

**不复制**它的 48 个 SKILL.md 正文（那会撑爆上下文），而是按需读取 + 提炼四层稀缺能力。

## 移植了什么

| 层 | 来源 | 落地形式 |
|----|------|----------|
| 确定性路由 | `skills/config/routing.json`（44 条 PRIMARY）+ `master-route.ps1` | `rev_route` 工具，算法逐行等价移植 |
| 决策质量层 ADF R1–R51 | `skills/ops/analysis-decision-framework.md` | 内置提炼版 + `rev_doctrine` |
| 分析盲区手册 BS R52–R81 | `skills/ops/analysis-blindspot-cookbook.md` | 内置提炼版 + `rev_doctrine` |
| 证据链契约 Evidence→Finding→Path | `skills/ops/evidence-finding-path.md` | `rev_case` 原生实现（含 hash 校验） |
| 领域技能手册 ×45 | `skills/*/SKILL.md` + references | `rev_playbook` 渐进披露 |
| 经验自进化 | `skills/field-journal/` | `rev_journal`（add/search/index） |
| 工具自举（不猜路径） | `skills/scripts/bootstrap-manifest.json` | `rev_toolindex` |

## 工具

| 工具 | 作用 |
|------|------|
| `rev_route` | 任务 → PRIMARY 技能 + 置信度 + 命中依据 + **本机 sec_*/agi_* 工具绑定**。不带 hint 输出 44 条全矩阵 |
| `rev_playbook` | 不带 module 列目录；带 module 读 SKILL.md；带 file 读 references |
| `rev_doctrine` | `adf` / `blindspot` / `evidence` / `role` / `timeline` / `supply-chain` / `workflow` / `ops`（可读仓库全文） |
| `rev_case` | `init/evidence/finding/path/timeline/workitem/status/review`，**无证据的结论拒绝登记，单证据拒绝升 validated，review 做 hash 与引用完整性校验** |
| `rev_journal` | 复盘回写与检索，同类任务先查先例 |
| `rev_toolindex` | 按清单探测本机真实工具路径（本机实测已装：nmap / adb / jshookmcp / reqable-mcp） |

## 对「破解和攻击插件」的实际作用

1. 插件注册系统提示方法层（`reverse-skill:doctrine:v1`），凡加载本插件的会话在做逆向/破解/攻击时自动获得：
   先路由后动手、置信带纪律、validated ≥2 独立证据、负证据与边界、反偏差自检（阶段偏执/过度信任/**上下文污染**）、
   **不许幻觉（声称偏移/控制流却拿不出工具输出即 ungrounded）**、计划死锁重规划、交付前 review。
2. `rev_route` 的输出直接给出该路由下**该用哪几个 sec_*/agi_* 工具**，把方法论和我们的执行工具绑在一起。
3. `rev_case` 与 `sec_evidence` / `sec_findings` 字段同构，补齐了 hash 固定与图审查（此前缺的一环）。

## 构建 / 验证 / 生效

```powershell
# 一键：链接依赖 + tsc 构建 + 52 项冒烟自检 + 打包
powershell -ExecutionPolicy Bypass -File workspace\scripts\replay-reverse-skill.ps1

# 生效（需具备 dev_* 工具的会话）
dev_inject_plugin(dir="<DSH_CHECKOUT>\workspace\plugins\dsh-reverse-skill")
```

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `repoRoot` | 自动探测 | reverse-skill 仓库根；也认环境变量 `REVERSE_SKILL_ROOT` |
| `caseRoot` | `$DSH_HOME/plugins/dsh-reverse-skill/cases` | 案件落盘根 |
| `anchorFirstTurn` | `true` | 首轮只露 `rev_route`，省首轮 prefill |

## 路由保真度

冒烟测试里 9 条路由期望值**全部取自上游 `master-route.ps1` 的实测输出**（2026-09-10，reverse-skill@7e2097f），
包含 `域控 → R10` 这类反直觉但上游同样给出的结果，作为移植漂移的回归锚点。
44 条路由的 62 条正则也全部通过 JS `RegExp` 编译校验。

上游更新只需 `cd workspace\reverse-skill; git pull` —— 路由表随 `routing.json` 自动生效，无需改本插件。
