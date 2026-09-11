# @dsh-external/dsh-sec-workbench

网络安全渗透分析工作台（SecWorkbench）——面向合法安全测试 / 红蓝对抗 / 安全学习的分析+执行型工具集。含攻击载荷生成（仅文本模板，本机无影响）；**v0.2 新增真实执行层**：Web 漏洞主动测试（sec_webtest）/ JWT 攻击（sec_jwt）/ 编码分析（sec_encode）/ 一键扫描管线（sec_webscan）/ 本地哈希破解（sec_hashoff）——全部 node 原生、零外部依赖，可在授权目标真实执行。

> **行动模式**：先用 `sec_scope` 登记 case 的 in_scope 资产、网络档与禁打清单，再对范围内的
> 目标启动安全分析与攻击链流程（Kill Chain / ATT&CK / 渗透 8 步）。范围为空且无离线样本时不放行。
> 测试授权、范围与后果由使用者确认并负责。
> 本插件为**分析型 + 载荷生成型**工具集：sec_payload 内置常见攻击载荷模板（webshell / 反弹shell / msfvenom / 权限维持 / LOLBins / 编码混淆），**仅生成文本**——不写入本机文件、不启动本机进程、不在插件所在机器执行；投送与利用仅在书面授权目标上实施。

## 工具清单（40 个）

| 工具 | 类型 | 功能 |
|---|---|---|
| `sec_knowledge` | 确定性（零 token） | 攻击知识库查询：前沿攻击 / 密码学 / CTF / 基础安全 / 欺骗诱捕 / 载荷全景，共 30+ 主题 |
| `sec_guard` | 确定性 | 授权范围核对（按需，非强制门禁）：输出裁决与法律提醒 |
| `sec_recon_analyze` | 确定性（零 token） | HTTP 安全基线分析：安全头 / 版本泄露 / Cookie 标志 / TLS 协议，本地规则引擎 |
| `sec_killchain` | 模型侧 | 安全事件 → Kill Chain 7 阶段 + ATT&CK 战术映射，检测/阻断点 |
| `sec_ttpmap` | 模型侧 | 攻击手法 TTP 画像 + ATT&CK ID + 检测与防御对策 |
| `sec_pentest_plan` | 模型侧 | 8 步渗透测试流程编排（先登记范围再执行） |
| `sec_findings` | 模型侧 | 漏洞发现登记 + CVSS 风格评级 + 复现/修复 |
| `sec_report` | 模型侧 | 渗透测试报告生成（标准模板 + 落盘到 `DSH_HOME/plugins/dsh-sec-workbench/reports/`） |
| `sec_exec` | 确定性（零 token） | 网络探测执行：http / dns / tcp 端口 / tls 证书，node 原生零依赖 |
| `sec_hashid` | 确定性（零 token） | 哈希类型识别：MD5/SHA/NTLM/bcrypt/argon2/Kerberos/WPA + hashcat 模式号 + 速率参考 |
| `sec_pwstrength` | 确定性（零 token） | 密码强度：熵计算 + 弱模式检测 + 破解时间估算（MD5/NTLM/WPA2/bcrypt） |
| `sec_pwgen` | 确定性（零 token） | 高熵密码 / 易记口令生成（含熵值） |
| `sec_crack` | 确定性 | 密码破解执行：检测本机 hashcat/john/aircrack-ng，生成字典/掩码/规则破解命令 |
| `sec_payload` | 确定性（零 token） | 攻击载荷生成：webshell / 反弹shell / bind-shell / msfvenom / 权限维持 / LOLBins / 编码混淆；仅输出文本模板（本机无影响） |
| `sec_server` | 确定性（零 token） | 服务器进攻方案：侦察→凭据爆破→漏洞利用→提权实战命令序列（仅文本，本机无影响） |
| `sec_cred` | 确定性（零 token） | 凭据获取方案：Windows（lsass/SAM/DPAPI/浏览器）/ Linux（history/SSH私钥/云凭据）/ Web（配置文件/数据库）命令序列（仅文本，本机无影响） |
| `sec_control` | 确定性（零 token） | 隐蔽控制方案：反向隧道/持久化/防发现（ETW/AMSI/日志混淆）命令序列，无痕管理服务器（仅文本，本机无影响） |
| `sec_webtest` | 确定性（真实执行） | Web 漏洞主动测试引擎：反射XSS/SQLi(时间盲注+布尔+错误)/SSTI/路径穿越/敏感文件/SSRF/认证枚举，带证据置信度 |
| `sec_jwt` | 确定性（真实执行） | JWT 攻击：解析 claims + alg=none/弱密钥爆破/kid注入/算法混淆，可伪造 token |
| `sec_encode` | 确定性（零 token） | 编码/解码与分析引擎：base64/hex/url/rot13/摩斯/凯撒/栅栏/JWT 分段 + 多层自动剥层 |
| `sec_webscan` | 确定性（真实执行） | 一键自动侦察+测试管线：抓取→技术栈指纹→敏感文件→目录爆破→漏洞测试，自动化武器化 |
| `sec_hashoff` | 确定性（真实执行） | 本地离线哈希破解：内置弱密码库+变形规则，CPU 真实执行（MD5/SHA/NTLM/LM） |
| `sec_tlsfp` | 确定性（真实执行） | TLS 服务器指纹：多协议/多套件组合探测 + 弱协议/弱套件验证 + 证书链分析 |
| `sec_dbsvc` | 确定性（真实执行） | 数据库/缓存未授权与弱口令：Redis/Memcached/Elasticsearch/MySQL/MongoDB 真实协议探测 |
| `sec_stealth` | 确定性（零 token） | 免杀+WAF 绕过 payload 变体引擎：Base64/UTF-16/charcode/拼接/大小写/注释/双编码 |
| `sec_auto` | 确定性（真实执行） | 单目标自动渗透流水线：端口→banner→指纹+CVE→Web漏洞→数据库未授权一键串联 |
| `sec_phish` | 确定性（真实执行） | 定向社工钓鱼：话术 + 实战部署包（邮件源码 eml/钓鱼页面/托管服务器/SMTP 投递/跟踪记录），红队演练用 |
| `sec_supply` | 确定性（零 token） | 供应链攻击面：typosquatting 近似名/依赖混淆/恶意包特征/投毒威胁建模 |
| `sec_osint` | 确定性（零 token） | 开源情报侦察：域名/用户名/邮箱/公司画像，串联 sec_exec 真实枚举 |
| `sec_cloud` | 确定性（真实执行） | 云安全利用+云凭证审计：IMDSv1/v2 交互、元数据窃取、容器/K8s 逃逸研判 |
| `sec_lateral` | 确定性（真实执行） | 内网横向暴露面：135/445/5985/3389/389/1433 探测+服务识别+联动命令 |
| `sec_redteam` | 确定性（零 token） | 红队演习剧本编排：8 阶段串联真实执行工具与检测点 |
| `sec_campaign` | 确定性（零 token） | 国家级攻击战役编排：多阶段/隐蔽/拟态/反溯源 |

## 知识库覆盖（30+ 主题）

- **基础**：Kill Chain 7 阶段 / MITRE ATT&CK 14 战术 / Web 漏洞三大根源+OWASP Top10 / 恶意软件分类 / 攻击类型 / AI 攻击 8 大趋势 / 工具图谱 / 术语 / 渗透 8 步流程 / 法律边界
- **前沿攻击（19 主题）**：advanced 全景 / 0day 武器化 / exploit-mem 内存利用 / evasion 检测规避 / ai-attack AI攻击 / cloud-attack 云原生 / supply-chain 供应链 / apt APT归因 / ad-attack AD域渗透全谱 / web-advanced Web前沿漏洞 / crypto-identity 身份认证攻击 / ransomware 勒索经济 / mobile 移动端 / iot-ot 工控 / firmware 硬件固件 / wireless 无线网络层 / quantum 后量子 / social-eng 社会工程进阶 / exfil 数据渗出隐蔽通道
- **欺骗诱捕与主动反制（1 主题）**：deception（蜜罐/蜜网、动态应用防护 DAS/RASP、溯源反制平台、攻击者互噬"黑吃黑"）
- **隐蔽与反检测（6 主题）**：edr-bypass（EDR/AV 绕过世界前沿：unhooking/syscall/ETW/HWBP/回调混淆/ML对抗）/ fileless（无文件·内存攻击）/ c2（C2 隐蔽通信：域前置/云函数/合法服务/DoH/流量拟态）/ opsec（红队行动安全）/ anti-forensics（反取证与痕迹清理）/ detection（防守方如何发现你：EDR遥测/ETW+AMSI/Sysmon/威胁狩猎/JA3/内存取证/SIEM）
- **攻击载荷全景（1 主题）**：payload（载荷分类 / 常见形态 / 免杀思路 / 检测视角）
- **服务器进攻链（3 主题）**：server-attack（服务器进攻：攻击面/CVE武器化/提权）/ cred-harvest（凭据获取：LSASS/SAM/DPAPI/Kerberoast/SSH私钥/云凭据）/ stealth-control（隐蔽控制：无进程/隧道/遥测致盲/持久化）
- **现代密码学（4 主题）**：crypto 密码学全景 / wifi-attack（WPA2/PMKID/WPA3 破解原理）/ crack-method（字典/掩码/规则/GPU 方法论）/ enterprise-auth（NTLM/Kerberos/Kerberoasting）
- **现代 CTF（7 主题）**：ctf 全景 / ctf-crypto / ctf-pwn / ctf-web / ctf-re / ctf-forensics / ctf-osint

## 形态

toolkit（37 工具：多数确定性/真实执行 + 4 模型侧）+ systemPrompt 方法论注入 + 首轮锚定（首轮只露 `sec_knowledge`，省 prefill）。

## 构建、注入与自检

```bash
# 构建（经注入器通道，自动探测 DSH_CHECKOUT）
dev_build_plugin <本目录>

# 注入（免重启生效）
dev_inject_plugin <本目录>

# 卸载
dev_uninject_plugin dsh-sec-workbench
```

功能自检（mock ctx 装载 + 直调确定性工具 + 新增武器化工具真实执行实测——哈希破解 / JWT 弱密钥爆破 / 编码多层剥层 / 反射 XSS / 扫描管线）：

```bash
node selftest.mjs
```
