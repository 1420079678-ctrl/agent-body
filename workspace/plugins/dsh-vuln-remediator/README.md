# @dsh-external/dsh-vuln-remediator

**CVE 漏洞修复与智能补丁工作台（Vuln Remediator）** —— 集「扫描发现 → 动态排序 → 虚拟补丁 → 修复闭环」于一身，对标世界最先进的漏洞修复技术栈，用于授权范围内的漏洞修复 / 护网 / 红蓝对抗 / 企业 SRC 实战训练。

由 dsh-super-injector 生成，toolkit 形态（11→9 工具 + systemPrompt 方法论注入），资源全部挂 `ctx.effect`（热重载/卸载自动清理）。

## 工具清单

| 环节 | 工具 | 类型 | 说明 |
|---|---|---|---|
| 发现 | `vuln_scan` | 确定性·网络 | 目标综合扫描：服务/组件指纹 → 版本 → CVE 关联 → HTTP 安全基线 → 端口探测，输出漏洞发现清单（node 原生，零外部 API） |
| 发现 | `vuln_cve` | 确定性 | CVE 详情 + 在野/KEV + 利用条件 + 虚拟补丁特征（内置高价值企业组件库） |
| 发现 | `vuln_sbom` | 确定性 | SBOM 依赖审计 + **可达性降级**（依赖 → 已公开 CVE → 是否被实际调用） |
| 排序 | `vuln_priority` | 确定性 | **EPSS/VPR 式动态风险评分**：CVSS/利用成熟度/KEV/暴露面/时间衰减/资产关键性 → 0-1 分数 + 优先级标签（加权+逻辑回归模型） |
| 虚拟补丁 | `vuln_patch_gen` | 模型侧+兜底 | CVE/Payload → ModSecurity / nginx / Snort 拦截规则自动生成（不改代码、不重启、网络层止血） |
| 虚拟补丁 | `vuln_patch_verify` | 确定性 | 规则验证：正常/恶意样本匹配测试，判误杀/漏杀 + 置信度 + 是否可下发 |
| 修复 | `vuln_remediate` | 模型侧 | 智能体修复方案：代码级/配置级/网络层 + 影响面 + 回滚 + 沙箱验证清单 |
| 修复 | `vuln_plan` | 确定性 | 修复优先级排期（VPR 排序 + 24h/7d/30d 里程碑） |
| 知识 | `vuln_knowledge` | 确定性 | EPSS / 虚拟补丁方法论 / 可达性 / 修复闭环 / SCA / KEV / 修复三步法 |

闭环：`vuln_scan` 发现 → `vuln_priority` 排序 → `vuln_patch_gen/verify` 虚拟补丁止血 → `vuln_remediate` 根本修复 → `vuln_plan` 排期 → 复扫确认闭环。

## 对标的前沿技术

- **动态优先级**：EPSS / VPR 模型（特征加权 + 逻辑回归 + 时间衰减，替代静态 CVSS）
- **虚拟补丁**：官方补丁空窗期网络层止血（ModSecurity/nginx/Snort），AI 自动从 CVE/Payload 提特征生成规则，防误杀验证后才下发
- **可达性分析**：SBOM + Reachability，漏洞代码不被实际调用则自动降级（供应链安全王牌）
- **Agentic 修复闭环**：Triage（分流排序）→ Remediation（生成修复/规则）→ 沙箱验证 → 人工审批 → 复测确认

## 构建与注入（可重放）

```bash
# 1) 构建（DSH_CHECKOUT 自动探测 harness checkout）
bash scripts/build.sh                # 或 DSH_CHECKOUT=<checkout> bash scripts/build.sh

# 2) 注入（注入器环境内，免重启）
#    dev_inject_plugin <本插件目录>        # host ✓，无 client 声明故跳过 client

# 3) 改动后热重载（免重启生效）
#    dev_reload_package dsh-vuln-remediator
```

产物：`dsh-external-dsh-vuln-remediator-<version>.tgz`

## 回滚

- 卸载注入：`dev_uninject_plugin dsh-vuln-remediator`（卸 loader entry + 清 junction + patch disabled 条目，fiber 全清理）
- 前一版本：构建产物 tgz 为独立的上一提交；需要时用旧 tgz 重新构建注入

## 授权与合规

仅对已获授权的自有资产或书面授权目标执行扫描与修复；授权范围、时间窗口与数据处理方式由使用者确认。
