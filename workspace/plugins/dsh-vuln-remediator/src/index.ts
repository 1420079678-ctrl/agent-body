/**
 * @dsh-external/dsh-vuln-remediator — CVE 漏洞修复与智能补丁工作台（Vuln Remediator）
 *
 * 集「发现 → 排序 → 虚拟补丁 → 修复闭环」于一身，对标世界最先进的漏洞修复技术栈：
 *
 *   发现（扫描）：
 *     vuln_scan        目标综合扫描：服务/组件指纹 → 版本 → CVE 关联 → HTTP 安全基线
 *                      → 端口探测，输出「漏洞发现清单」（node 原生，确定性，零外部 API）
 *     vuln_cve         CVE 详情 + 在野/KEV + 利用条件 + 虚拟补丁特征 查询（内置高价值组件库）
 *     vuln_sbom        SBOM 依赖审计 + 可达性降级（依赖 → 已公开 CVE → 是否被实际调用）
 *
 *   排序（动态风险评分，EPSS/VPR 式）：
 *     vuln_priority    多维度特征（CVSS/利用成熟度/KEV/暴露面/时间衰减/资产关键性）
 *                      → 0-1 动态风险分数 + 优先级标签（本地加权+逻辑回归模型）
 *
 *   虚拟补丁（不改代码、不重启、网络层止血）：
 *     vuln_patch_gen     CVE/Payload → ModSecurity / nginx / Snort 拦截规则自动生成
 *     vuln_patch_verify  规则验证：正常/恶意样本匹配测试，判误杀/漏杀 + 置信度
 *
 *   修复闭环：
 *     vuln_remediate    智能体修复方案（代码级/配置级/网络层 + 影响面 + 回滚 + 沙箱验证清单）
 *     vuln_plan        修复优先级排期（结合资产关键性 + 风险，输出里程碑）
 *
 *   知识：
 *     vuln_knowledge    漏洞修复知识库（EPSS/虚拟补丁/可达性/修复闭环/KEV）
 *
 * 形态：toolkit（9 工具，7 确定性 + 2 模型侧）+ systemPrompt 方法论注入。
 * 规范：所有资源注册挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { connect as netConnect } from 'node:net'

export const name = "@dsh-external/dsh-vuln-remediator"
export const inject = ['tools', 'systemPrompt']

export interface Config {
  anchorFirstTurn: boolean
}

export const Config = z.object({
  anchorFirstTurn: z.boolean().default(true),
})

/** 本插件全部工具名（首轮锚定裁剪集合） */
const MINE = new Set([
  'vuln_scan', 'vuln_cve', 'vuln_sbom', 'vuln_priority',
  'vuln_patch_gen', 'vuln_patch_verify', 'vuln_remediate', 'vuln_plan', 'vuln_knowledge',
])
/** 首轮保留的核心工具（综合扫描，最通用入口） */
const CORE = 'vuln_scan'

/** 系统提示：漏洞修复方法论（注入每个会话） */
const METHOD_SECTION = `# CVE 漏洞修复与智能补丁工作台（Vuln Remediator）

面对「修复漏洞 / 打虚拟补丁 / 漏洞优先级 / 依赖审计」类问题时，你是「漏洞修复工程师」，按以下闭环工作：

1. **发现（Discovery）**：用 vuln_scan 扫目标拿指纹+版本+CVE；用 vuln_cve 查 CVE 明细/KEV/在野；用 vuln_sbom 审依赖并评估「可达性」——漏洞代码不被业务实际调用则自动降级，不再做无用功。
2. **排序（Prioritize）**：用 vuln_priority 对每个漏洞做动态风险评分（CVSS + 利用成熟度 + KEV + 暴露面 + 时间衰减 + 资产关键性），0-1 分数 + 优先级标签；先排序后修复，把资源砸向那 1% 真正致命的漏洞。
3. **虚拟补丁（Virtual Patch）**：官方补丁发布 / 业务不能重启的空窗期，用 vuln_patch_gen 从 CVE/Payload 自动生成 ModSecurity / nginx / Snort 拦截规则（不改代码、不重启、网络层止血），再用 vuln_patch_verify 对正常+恶意样本做防误杀/漏杀校验，验证通过才下发。
4. **修复（Remediate）**：用 vuln_remediate 生成代码级/配置级/网络层修复方案（含影响面 + 回滚 + 沙箱验证清单）；用 vuln_plan 做修复排期与里程碑。
5. **闭环纪律**：每个漏洞必须「可复现 + 可修复 + 可验证」；先虚拟补丁止血，再根本修复，最后回归测试；改代码前保留原始状态并提供回滚。

使用前提：仅对已获授权的自有资产或书面授权目标执行扫描与修复；范围与时间窗口由使用者确认。`

export function apply(ctx: Context, config: Config): void {
  // ── 方法论注入系统提示 ────────────────────────────────────────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'vuln-remediator:method:v1',
    order: 92,
    text: METHOD_SECTION,
  }), 'vuln-remediator: method section')

  // ── 工具集 ────────────────────────────────────────────────────────────
  const tools = [
    // ═══ 1. 目标综合扫描（发现，确定性，零外部 API） ═══
    defineTool({
      name: 'vuln_scan',
      description: '目标综合漏洞扫描：服务/组件指纹 → 版本 → CVE 关联 → HTTP 安全基线 → 端口探测，输出漏洞发现清单（含严重度/可用性/修复点）。对授权目标使用，node 原生。',
      parameters: {
        target: { type: 'string', required: true, description: '目标：URL（如 http://1.2.3.4:8080）或 域名/IP（默认 80/443）' },
        ports: { type: 'string', description: '端口探测列表（默认 80,443,8080,8443,3306,6379），可范围如 1-100' },
        timeoutMs: { type: 'integer', description: '单请求超时 ms（默认 8000）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { target: string; ports?: string; timeoutMs?: number }) {
        return await runVulnScan(args)
      },
    }),

    // ═══ 2. CVE 查询（确定性，内置高价值组件库 + KEV） ═══
    defineTool({
      name: 'vuln_cve',
      description: 'CVE 详情查询：CVE编号/产品+版本 → 严重度/类型/在野KEV/利用成熟度/受影响版本/虚拟补丁特征。内置高价值企业组件库，零 token。',
      parameters: {
        cve: { type: 'string', description: 'CVE 编号（如 CVE-2021-44228，支持前缀模糊）' },
        product: { type: 'string', description: '产品名（如 log4j / weblogic / struts2 / fastjson / spring），配合 version' },
        version: { type: 'string', description: '检测到的版本（如 2.14.1 / 10.3.6.0）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { cve?: string; product?: string; version?: string }) {
        return cveLookup(args)
      },
    }),

    // ═══ 3. SBOM 依赖审计 + 可达性降级（确定性） ═══
    defineTool({
      name: 'vuln_sbom',
      description: 'SBOM 依赖审计：输入依赖清单（名称+版本），匹配已公开 CVE，评估漏洞可达性/是否被实际调用并降级。供应链安全王牌。',
      parameters: {
        deps: { type: 'string', required: true, description: '依赖清单 JSON 数组：[{"name":"log4j-core","version":"2.14.1","reachable":true}] 或 逗号分隔 "log4j-core:2.14.1,spring-core:5.3.1"（reachable 缺省按真）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { deps: string }) {
        return sbomAudit(args.deps)
      },
    }),

    // ═══ 4. 动态风险评分（EPSS/VPR 式，确定性模型） ═══
    defineTool({
      name: 'vuln_priority',
      description: '动态风险评分：输入漏洞多维特征（CVSS/利用成熟度/KEV/暴露面/时间衰减/资产关键性），输出 0-1 VPR 分数 + 优先级标签（先排序后修复）。支持单条或批量 JSON。',
      parameters: {
        cvss: { type: 'number', description: 'CVSS 基础分 0-10（单个漏洞时）' },
        maturity: { type: 'string', description: '利用成熟度：unproven | poc | functional | weaponized' },
        kev: { type: 'boolean', description: '是否列入 CISA KEV（在野已知被利用）' },
        exposure: { type: 'string', description: '暴露面：local | remote-auth | remote-noauth | network' },
        days: { type: 'integer', description: '披露至今的天数（时间衰减，默认 0）' },
        asset: { type: 'string', description: '资产关键性：edge | internal | production | core' },
        vulns: { type: 'string', description: '批量风险评分 JSON 数组 [{"cvss":9.8,"maturity":"weaponized","kev":true,"exposure":"remote-noauth","days":10,"asset":"core"}]' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { cvss?: number; maturity?: string; kev?: boolean; exposure?: string; days?: number; asset?: string; vulns?: string }) {
        return priorityScore(args)
      },
    }),

    // ═══ 5. 虚拟补丁规则自动生成（模型侧 + 确定性模板兜底） ═══
    defineTool({
      name: 'vuln_patch_gen',
      description: '虚拟补丁规则自动生成：输入 CVE编号/漏洞描述 + 可选 Payload 特征 → 自动生成 ModSecurity / nginx / Snort 拦截规则（不改代码、不重启、网络层止血）+ 防误杀提示。内置高价值 CVE 特征库，未知 CVE 走模型推导。',
      parameters: {
        cve: { type: 'string', description: 'CVE 编号（如 CVE-2021-44228），有特征库则确定性生成' },
        desc: { type: 'string', description: '漏洞描述 / 利用方式（CVE 不在库内时用模型推导特征）' },
        payload: { type: 'string', description: '已知攻击 Payload 样本/特征（可选，辅助提特征）' },
        product: { type: 'string', description: '受影响产品（如 log4j / weblogic），用于定位特征库' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { cve?: string; desc?: string; payload?: string; product?: string }) {
        return patchGen(args)
      },
    }),

    // ═══ 6. 规则防误杀验证（确定性） ═══
    defineTool({
      name: 'vuln_patch_verify',
      description: '虚拟补丁规则验证：输入生成的规则/正则 + 正常与恶意样本，做匹配测试，输出 误杀/漏杀/置信度 + 是否可下发建议。虚拟补丁闭环的守门员。',
      parameters: {
        regex: { type: 'string', description: '待验证的正则（优先）' },
        rule: { type: 'string', description: 'ModSecurity/nginx/Snort 规则原文，自动提取其中正则' },
        samples: { type: 'string', required: true, description: '样本 JSON 数组：[{"type":"normal"|"attack","data":"..."}] 或 逗号分隔 "attack:${jndi:ldap:...},normal:hello"' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { regex?: string; rule?: string; samples: string }) {
        return patchVerify(args)
      },
    }),

    // ═══ 7. 智能体修复方案（模型侧） ═══
    defineTool({
      name: 'vuln_remediate',
      description: '智能体修复方案：给定漏洞 + 资产上下文 → 生成代码级/配置级/网络层修复方案（含影响面 + 回滚 + 沙箱验证清单）。闭环修复的最后一环。',
      parameters: {
        vuln: { type: 'string', required: true, description: '漏洞描述：CVE/类型/危害' },
        asset: { type: 'string', description: '受影响资产与技术栈：如 "订单服务 Java 8 + Spring Boot 2.7"（可选）' },
        severity: { type: 'string', description: '严重度（可选）：低/中/高/严重' },
        layer: { type: 'string', description: '希望修复的层级（可选）：code | config | network | all（默认 all）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { vuln: string; asset?: string; severity?: string; layer?: string }) {
        return remDialatePrompt(args)
      },
    }),

    // ═══ 8. 修复优先级排期（确定性） ═══
    defineTool({
      name: 'vuln_plan',
      description: '修复优先级排期：输入漏洞清单 + 资产关键性 → 动态风险评分排序 + 修复里程碑 + 窗口建议（如 24h/7d/30d）。输出可执行的修复上线计划。',
      parameters: {
        vulns: { type: 'string', required: true, description: '漏洞清单 JSON 数组：[{"id":"CVE-2021-44228","cvss":9.8,"kev":true,"maturity":"weaponized","exposure":"remote-noauth","days":2,"asset":"core"}]' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { vulns: string }) {
        return remediationPlan(args.vulns)
      },
    }),

    // ═══ 9. 漏洞修复知识库（确定性，零 token） ═══
    defineTool({
      name: 'vuln_knowledge',
      description: '漏洞修复知识库：EPSS 动态评分模型 / 虚拟补丁方法论 / 可达性分析 / 修复闭环 / 依赖审计(SCA) / KEV / 常见修复脚本。零 token。',
      parameters: {
        topic: {
          type: 'string', required: true,
          description: '主题：epss | patch | reachability | loop | sca | kev | remediate',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { topic: string }) {
        return renderVulnKnowledge(args.topic)
      },
    }),
  ]

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `vuln-remediator: ${tool.name}`)
  }

  // ── 首轮锚定：首个工具调用前只露综合扫描（省首轮 prefill） ────────────────
  if (config.anchorFirstTurn) {
    ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
      const assembled = await next()
      const agent = context.agent
      if (!agent || agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call')) return assembled
      return { ...assembled, tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE) }
    })
  }

  ctx.logger?.info?.(`[${name}] vuln-remediator active (${tools.length} tools, anchor=${config.anchorFirstTurn})`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// 一、内置高价值 CVE 组件库 + KEV + 虚拟补丁特征
// ═══════════════════════════════════════════════════════════════════════════════

interface Cve {
  id: string
  name: string
  product: string
  products: string[]       // 小写别名（匹配指纹）
  type: string             // RCE / 反序列化 / SQLi / SSRF ...
  cvss: number
  severity: '严重' | '高'
  maturity: '未证实' | 'POC' | '功能EXP' | '武器化'
  kev: boolean
  affected: string[]       // 版本范围（<=2.15.0 / 2.0..2.15.0 / >=2.0 <2.17.0）
  cwe?: string
  desc: string
  sig?: { tag: string; regex: string; hint: string }
}

const CVE_LIB: Cve[] = [
  {
    id: 'CVE-2021-44228', name: 'Log4Shell', product: 'Apache Log4j',
    products: ['log4j', 'log4j-core', 'log4j-api', 'org.apache.logging.log4j'],
    type: 'JNDI 注入 → RCE', cvss: 10.0, severity: '严重', maturity: '武器化', kev: true,
    affected: ['2.0..2.14.1', '<=2.15.0'],
    cwe: 'CWE-502 反序列化 / CWE-917 表达式注入',
    desc: 'Apache Log4j2 的 JNDI Lookup 未对输入做安全限制，攻击者通过 ${jndi:ldap://...} 触发 JNDI 注入，远程执行任意代码。影响面极广，披露即被大规模利用。',
    sig: { tag: 'JNDI-lookup', regex: '\\$\\{[^}]*jndi:(ldap|ldaps|rmi|dns|iiop|corba)', hint: '匹配请求体/头中的 ${jndi:...} 及其 URL 编码/大小写变体（如 ${${lower:j}ndi:}）' },
  },
  {
    id: 'CVE-2021-45046', name: 'Log4Shell 绕过', product: 'Apache Log4j',
    products: ['log4j', 'log4j-core'],
    type: 'JNDI 注入 → RCE（绕过 2.15 修复）', cvss: 9.0, severity: '严重', maturity: '武器化', kev: true,
    affected: ['2.0..2.14.1', '>=2.15.0 <2.16.0'],
    cwe: 'CWE-917',
    desc: 'Log4j 2.15.0 对 Log4Shell 的修复不完整，特定环境（无默认 deny、存在 JNDI 配置）仍可触发 JNDI 注入。',
    sig: { tag: 'JNDI-lookup(nested)', regex: '\\$\\{(\\$\\{[^}]*\\})[^}]*+(\\$\\{[^}]*\\})*[^}]*jndi:(ldap|ldaps|rmi|dns|iiop)', hint: '匹配嵌套/递归 ${${lower:...}} 的混淆变体' },
  },
  {
    id: 'CVE-2022-22965', name: 'Spring4Shell', product: 'Spring Framework',
    products: ['spring', 'spring-web', 'spring-webmvc', 'spring-beans'],
    type: 'data-binding → RCE', cvss: 9.8, severity: '严重', maturity: '功能EXP', kev: false,
    affected: ['<=5.3.17', '>=5.3.18 <5.3.18'],
    cwe: 'CWE-915 不正确的验证',
    desc: 'Spring MVC 在 JDK 9+ 上通过 data binding 可访问 class/module ClassLoader，构造恶意参数实现远程代码执行（需打包为 WAR 的老式部署）。',
    sig: { tag: 'data-binding-classloader', regex: '(class|module)\\.module\\.classloader|class\\.module\\.classLoader|getClassLoader', hint: '匹配请求参数/头中带 class.module.classLoader 的 Spring 参数绑定特征' },
  },
  {
    id: 'CVE-2020-14882', name: 'WebLogic 控制台 RCE', product: 'Oracle WebLogic',
    products: ['weblogic', 'oracle weblogic', 'wlserver'],
    type: '管理控制台认证绕过 → RCE', cvss: 9.8, severity: '严重', maturity: '功能EXP', kev: true,
    affected: ['10.3.6.0', '12.1.3.0', '12.2.1.3', '12.2.1.4', '14.1.1.0'],
    cwe: 'CWE-306 认证绕过',
    desc: 'WebLogic 管理控制台构造特殊路径可绕过认证，结合 CVE-2020-14883 可执行任意命令。',
    sig: { tag: 'console-path-bypass', regex: '/console/(css/|images/)?console\\.portal|/console.*console\\.portal', hint: '匹配 WebLogic 控制台认证绕过路径特征' },
  },
  {
    id: 'CVE-2017-5638', name: 'Struts2 S2-045', product: 'Apache Struts2',
    products: ['struts2', 'struts', 'struts2-core'],
    type: 'Content-Type → OGNL → RCE', cvss: 10.0, severity: '严重', maturity: '武器化', kev: true,
    affected: ['2.3.5..2.3.31', '2.5..2.5.10'],
    cwe: 'CWE-917',
    desc: 'Struts2 处理 Content-Type 时对 multipart 解析不当，构造 %{...} OGNL 表达式可远程执行代码。',
    sig: { tag: 'ognl-content-type', regex: '%\\{[^}]*\\}|#(context|application|session)\\[|@(java|ognl|org)', hint: '匹配 Content-Type 头中的 %{...} OGNL 表达式（S2-045 经典特征）' },
  },
  {
    id: 'CVE-2020-2551', name: 'WebLogic IIOP 反序列化', product: 'Oracle WebLogic',
    products: ['weblogic', 'wlserver'],
    type: 'IIOP 反序列化 → RCE', cvss: 7.5, severity: '高', maturity: '功能EXP', kev: false,
    affected: ['10.3.6.0', '12.1.3.0', '12.2.1.3', '12.2.1.4'],
    cwe: 'CWE-502',
    desc: 'WebLogic IIOP 协议反序列化 gadget chain 远程执行代码，常与 CVE-2020-14882 组合利用。',
    sig: { tag: 'iiop-deserialize', regex: '\\xac\\xed\\x00\\x05|t3\\s+.*\\x7f|BAD_OPCODE', hint: '匹配 T3/IIOP 协议字节序列或 Java 序列化魔数 ed 00 05' },
  },
  {
    id: 'CVE-2022-26134', name: 'Confluence OGNL RCE', product: 'Atlassian Confluence',
    products: ['confluence', 'atlassian confluence'],
    type: 'OGNL 注入 → RCE', cvss: 9.8, severity: '严重', maturity: '武器化', kev: true,
    affected: ['7.4.0..7.4.16', '7.13.0..7.13.6', '7.14.0..7.14.2', '7.15.0..7.15.1'],
    cwe: 'CWE-917',
    desc: 'Confluence Server/Data Center 的 OGNL 表达式注入，未授权攻击者可远程执行代码。',
    sig: { tag: 'ognl-query', regex: 'ispreview\\b[^&]*\\$\\{|\\$\\{[^}]*%\\{', hint: '匹配 URI/查询中的 ${...%{...#{...}} OGNL 注入特征（含 ispreview 参数）' },
  },
  {
    id: 'CVE-2021-26855', name: 'Exchange ProxyLogon', product: 'Microsoft Exchange',
    products: ['exchange', 'ms exchange', 'exchange server'],
    type: 'SSRF + 认证绕过 → RCE', cvss: 9.8, severity: '严重', maturity: '武器化', kev: true,
    affected: ['2013', '2016', '2019'],
    cwe: 'CWE-918 SSRF',
    desc: 'Exchange Server 多个组件缺陷，未授权访问 + 服务端请求伪造组合，攻击者可接管整个邮件服务器。',
    sig: { tag: 'proxy-rewrite-url', regex: '/ecp/.*(X-Rewrite-Url|__VIEWSTATE)|X-Rewrite-Url:\\s*(https?|//|\\[)', hint: '匹配 /ecp/、/owa/ 等端点配合 X-Rewrite-Url 头（ProxyShell/ProxyLogon 特征）' },
  },
  {
    id: 'CVE-2020-1948', name: 'fastjson 反序列化', product: 'Alibaba fastjson',
    products: ['fastjson', 'com.alibaba.fastjson'],
    type: 'AutoType 反序列化 → RCE', cvss: 9.8, severity: '严重', maturity: '功能EXP', kev: false,
    affected: ['<=1.2.24', '<=1.2.47'],
    cwe: 'CWE-502',
    desc: 'fastjson 处理 AutoType 时对 @type 白名单绕过，构造 JSON 触发反序列化远程代码执行。国内电子厂/互联网后端大量使用。',
    sig: { tag: 'autotype-json', regex: '\\{\\s*"@type"\\s*:\\s*"\\S+\\$\\$|"@type"\\s*:\\s*"[^"]+', hint: '匹配 JSON 中的 "@type" 反序列化特征（常见 1.2.47 绕过链）' },
  },
  {
    id: 'CVE-2019-2725', name: 'WebLogic wls9-async RCE', product: 'Oracle WebLogic',
    products: ['weblogic', 'wlserver'],
    type: 'XMLDecoder 反序列化 → RCE', cvss: 9.8, severity: '严重', maturity: '武器化', kev: true,
    affected: ['10.3.6.0', '12.1.3.0'],
    cwe: 'CWE-502',
    desc: 'WebLogic wls9-async 组件 XMLDecoder 反序列化，攻击者可远程执行任意代码，护网/实战高频目标。',
    sig: { tag: 'xml-decoder', regex: '/_async/|java\\.process|ProcessBuilder|Runtime\\.getRuntime\\(\\)', hint: '匹配 /_async/ 路径或 XMLDecoder 中 java.lang.ProcessBuilder 特征' },
  },
  {
    id: 'CVE-2023-46604', name: 'Apache ActiveMQ RCE', product: 'Apache ActiveMQ',
    products: ['activemq', 'apache activemq'],
    type: 'OpenWire 协议 → RCE', cvss: 10.0, severity: '严重', maturity: '武器化', kev: true,
    affected: ['5.18.0..5.18.2', '5.17.0..5.17.5', '5.16.0..5.16.6'],
    cwe: 'CWE-502',
    desc: 'ActiveMQ OpenWire 协议存在反序列化远程代码执行，无需认证即可利用，2023 年被大量利用。',
    sig: { tag: 'openwire-deserialize', regex: 'org\\.apache\\.activemq\\.openwire', hint: '匹配 OpenWire 协议中可触发反序列化的类名/异常特征' },
  },
  {
    id: 'CVE-2021-34527', name: 'PrintNightmare', product: 'Windows Print Spooler',
    products: ['windows', 'print spooler', 'spoolsv'],
    type: '本地提权/RCE', cvss: 8.8, severity: '高', maturity: '武器化', kev: true,
    affected: ['Windows Server 2008+', 'Windows 10/11'],
    cwe: 'CWE-269 权限管理',
    desc: 'Windows Print Spooler 服务权限处理不当，攻击者可远程代码执行或本地权限提升。',
    sig: { tag: 'spooler-dll', regex: '(spoolsv|Print Spooler)|RpcAddPrinterDriver', hint: '匹配 Print Spooler 相关特征（服务名/利用命令，配合 DLL 加载检测）' },
  },
]

// ═══════════════════════════════════════════════════════════════════════════════
// 二、CVE 查询 / 版本范围匹配
// ═══════════════════════════════════════════════════════════════════════════════

function cveLookup(args: { cve?: string; product?: string; version?: string }): string {
  if (args.cve) {
    const cid = args.cve.trim().toUpperCase()
    const found = CVE_LIB.filter((c) => c.id.toUpperCase().includes(cid))
    if (found.length === 0) return `⚠️ 内置库未收录「${args.cve}」。可用 vuln_patch_gen 走模型推导虚拟补丁，或用 vuln_knowledge 学习方法论。`
    return found.map((c) => renderCveDetail(c)).join('\n---\n')
  }
  if (args.product) {
    const p = args.product.trim().toLowerCase()
    const filtered = CVE_LIB.filter((c) => c.products.some((x) => p.includes(x) || x.includes(p)))
    if (filtered.length === 0) return `⚠️ 未找到产品「${args.product}」的库内条目。部分产品：${[...new Set(CVE_LIB.map((c) => c.product))].join(' / ')}`
    if (args.version) {
      const v = args.version.trim()
      const hit = filtered.filter((c) => c.affected.some((r) => versionInRange(v, r)))
      if (hit.length > 0) return `⚠️ 命中版本 ${args.product} ${args.version}（受影响）：\n` + hit.map((c) => renderCveDetail(c)).join('\n---\n')
      return `✅ 产品 ${args.product} ${args.version} 不在下列受影响区间：\n${filtered.map((c) => `  ${c.id} ${c.name} (${c.affected.join(' / ')})`).join('\n')}`
    }
    return filtered.map((c) => renderCveDetail(c)).join('\n---\n')
  }
  return ' 提供 cve 编号 或 product+version。示例：vuln_cve {cve:"CVE-2021-44228"} 或 {product:"log4j",version:"2.14.1"}'
}

function renderCveDetail(c: Cve): string {
  return [
    `# ${c.id} · ${c.name}（${c.product}）`,
    `- 类型：${c.type}｜严重度：**${c.severity}**｜CVSS：${c.cvss.toFixed(1)}｜${c.cwe ?? ''}`,
    `- 利用成熟度：${c.maturity}｜在野/KEV：${c.kev ? '✅ 是（CISA KEV）' : '否'}｜受影响：${c.affected.join(' / ')}`,
    `- 描述：${c.desc}`,
    c.sig ? `- 虚拟补丁特征：（tag=${c.sig.tag}）\`${c.sig.regex}\`\n  ${c.sig.hint}\n  用 vuln_patch_gen 生成规则 / vuln_patch_verify 验证。` : '',
  ].filter(Boolean).join('\n')
}

function versionInRange(version: string, range: string): boolean {
  const v = parseVer(version)
  if (v == null) return false
  const r = range.trim()
  let m = r.match(/^<=\s*([\w.+-]+)$/)
  if (m) return cmpVer(v, parseVer(m[1])!) <= 0
  m = r.match(/^<\s*([\w.+-]+)$/)
  if (m) return cmpVer(v, parseVer(m[1])!) < 0
  m = r.match(/^>=\s*([\w.+-]+)$/)
  if (m) return cmpVer(v, parseVer(m[1])!) >= 0
  m = r.match(/^>\s*([\w.+-]+)$/)
  if (m) return cmpVer(v, parseVer(m[1])!) > 0
  m = r.match(/^([\w.+-]+)\.\.([\w.+-]+)$/)
  if (m) return cmpVer(v, parseVer(m[1])!) >= 0 && cmpVer(v, parseVer(m[2])!) <= 0
  m = r.match(/^([\w.+-]+)\s*<\s*([\w.+-]+)$/)
  if (m) return cmpVer(v, parseVer(m[1])!) >= 0 && cmpVer(v, parseVer(m[2])!) < 0
  if (r === '*' || r === 'all') return true
  return false
}

function parseVer(s: string): number[] | null {
  const m = String(s).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  return [parseInt(m[1]), parseInt(m[2] || '0'), parseInt(m[3] || '0')]
}

function cmpVer(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

// ═══════════════════════════════════════════════════════════════════════════════
// 三、动态风险评分（EPSS/VPR 式：加权 + 逻辑回归 + 时间衰减）
// ═══════════════════════════════════════════════════════════════════════════════

interface RiskF {
  cvss: number
  maturity: number
  kev: number
  exposure: number
  asset: number
  days: number
}

interface RiskTuple { score: number; label: string; reasons: string[]; maturity: number; kev: number; exposure: number; days: number }

function normalizeF(inp: { cvss?: number; maturity?: string; kev?: boolean; exposure?: string; days?: number; asset?: string }): RiskF | null {
  const maturityMap: Record<string, number> = { unproven: 0, poc: 0.35, functional: 0.7, weaponized: 1 }
  const exposureMap: Record<string, number> = { local: 0.2, 'remote-auth': 0.5, 'remote-noauth': 0.85, network: 1 }
  const assetMap: Record<string, number> = { edge: 0.3, internal: 0.55, production: 0.85, core: 1 }
  const cvss = inp.cvss ?? 0
  const maturity = maturityMap[(inp.maturity ?? 'poc').toLowerCase()] ?? 0.35
  const kev = inp.kev ? 1 : 0
  const exposure = exposureMap[(inp.exposure ?? 'remote-noauth').toLowerCase()] ?? 0.85
  const asset = assetMap[(inp.asset ?? 'internal').toLowerCase()] ?? 0.55
  const days = Math.max(0, inp.days ?? 0)
  return { cvss, maturity, kev, exposure, asset, days }
}

function riskScore(f: RiskF): RiskTuple {
  // 权重（EPSS 式特征加权）
  const w = { cvss: 0.26, maturity: 0.24, kev: 0.22, exposure: 0.14, asset: 0.14 }
  const cvssN = Math.min(f.cvss, 10) / 10
  const base = w.cvss * cvssN + w.maturity * f.maturity + w.kev * f.kev + w.exposure * f.exposure + w.asset * f.asset
  // 时间衰减：刚爆发权重最高，随披露时间下降（最多降 45%）
  const decay = 1 - Math.min(f.days / 365, 0.82)
  // 逻辑回归（logit），sigmoid 输出 0-1
  const logit = 2.1 * base + 1.25 * f.kev - 1.55
  const p = 1 / (1 + Math.exp(-logit))
  const score = p * (0.62 + 0.38 * decay)
  const label = score >= 0.75 ? '严重·立即处置' : score >= 0.55 ? '高·近日处置' : score >= 0.30 ? '中·计划处置' : '低·持续观察'
  const reasons: string[] = []
  if (f.cvss >= 9) reasons.push('CVSS 极高（远程无鉴权、影响大）')
  if (f.maturity >= 0.7) reasons.push('利用代码成熟（功能EXP/武器化）')
  if (f.kev) reasons.push('在野/KEV 已知被利用')
  if (f.exposure >= 0.85) reasons.push('远程无鉴权暴露')
  if (f.asset >= 0.85) reasons.push('核心生产资产')
  if (f.days > 0 && f.days < 14) reasons.push(`刚披露 ${f.days} 天，处于高危窗口`)
  return { score, label, reasons, maturity: f.maturity, kev: f.kev, exposure: f.exposure, days: f.days }
}

function maturityLabel(m: number): string {
  return m >= 1 ? '武器化' : m >= 0.7 ? '功能EXP' : m >= 0.35 ? 'POC' : '未证实'
}

function priorityScore(args: { cvss?: number; maturity?: string; kev?: boolean; exposure?: string; days?: number; asset?: string; vulns?: string }): string {
  // 批量
  if (args.vulns) {
    let list: any[]
    try { list = JSON.parse(args.vulns) } catch { return '❌ vulns 不是合法 JSON 数组' }
    if (!Array.isArray(list)) return '❌ vulns 需为数组'
    const rows = list.map((it, i) => {
      const f = normalizeF(it)
      if (!f) return null
      const r = riskScore(f)
      return { n: i + 1, id: it.id ?? ('#' + (i + 1)), score: r.score, label: r.label }
    }).filter((x): x is NonNullable<typeof x> => !!x)
    if (rows.length === 0) return '❌ 无有效条目'
    const table = rows.map((r) => `| ${r.n} | ${r.id} | ${r.score.toFixed(3)} | ${r.label} |`).join('\n')
    const top = [...rows].sort((a, b) => b.score - a.score).slice(0, 5)
    return `# 动态风险评分（批量 · EPSS 式）
| # | 漏洞 | VPR | 优先级 |
|---|---|---|---|
${table}
最高风险 Top5：${top.map((r) => `${r.id}(${r.score.toFixed(3)})`).join(' > ')}
> 分数=0-1；≥0.75 立即、≥0.55 近日、≥0.30 计划、<0.30 观察。用 vuln_plan 一键排期。`
  }

  // 单条
  const f = normalizeF(args)
  if (!f) return '❌ 缺少有效特征。'
  const r = riskScore(f)
  return `# 动态风险评分（EPSS/VPR 式）
- **VPR 分数：${r.score.toFixed(3)}**（0-1）
- **优先级：${r.label}**
- 特征：CVSS=${f.cvss}｜成熟度=${maturityLabel(f.maturity)}｜KEV=${f.kev ? '是' : '否'}｜暴露=${f.exposure}｜资产=${f.asset}｜披露${f.days}天
- 加成因素：${r.reasons.length ? r.reasons.join('；') : '（常规）'}
> 先排序后修复：对 score 高的漏洞优先布防/修复。`
}

// ═══════════════════════════════════════════════════════════════════════════════
// 四、虚拟补丁规则自动生成（确定性特征库 + 模型推导兜底）
// ═══════════════════════════════════════════════════════════════════════════════

function patchGen(args: { cve?: string; desc?: string; payload?: string; product?: string }): string {
  let entry: Cve | undefined
  if (args.cve) {
    const cid = args.cve.trim().toUpperCase()
    entry = CVE_LIB.find((c) => c.id.toUpperCase() === cid)
    if (!entry) entry = CVE_LIB.find((c) => c.id.toUpperCase().includes(cid))
  }
  if (!entry && args.product) {
    const p = args.product.trim().toLowerCase()
    entry = CVE_LIB.find((c) => c.products.some((x) => p.includes(x) || x.includes(p)))
  }

  if (entry && entry.sig) return renderPatchRules(entry, args)

  // 不在特征库：模型推导路径（返回结构化引导）
  return patchGenPrompt(args)
}

function renderPatchRules(c: Cve, args: { desc?: string; payload?: string }): string {
  const sig = c.sig!
  const id = c.id
  const prod = c.product
  const regex = sig.regex
  const modsec = [
    `SecRule ARGS|REQUEST_HEADERS|REQUEST_URI|REQUEST_COOKIES "@rx ${regex}" \\`,
    `  "id:${9700000 + (parseInt(c.id.split('-')[1] ?? '0') % 10000)}","phase:1","deny","status:403", \\`,
    `  "msg:'${id} ${c.name} 虚拟补丁阻断 (${sig.tag})'","tag:'vuln-${c.id}'","logdata:'%{MATCHED_VAR}'"`,
  ].join('\n')
  const nginx = [
    `# nginx: 拦截 ${id}（${c.name}）`,
    `if ( $request_uri ~* "${regex}" ) { return 403; }`,
    `# 更精确地拦某一参数/头：`,
    `# if ( $query_string ~* "${regex}" ) { return 403; }`,
    `# if ( $http_user_agent ~* "${regex}" ) { return 403; }`,
    `# 注：nginx if 内不宜用复杂正则，生产建议 openresty/nginx+lua 或把规则下发到 WAF`,
  ].join('\n')
  const snort = [
    `alert tcp any any -> any any (msg:"${id} ${c.name} 虚拟补丁阻断 (${sig.tag})"; \\`,
    `  flow:to_server,established; \\`,
    `  content:"${regex.replace(/\\|"|\n/g, '')}"; nocase; \\`,
    `  sid:${20240000 + (parseInt(c.id.split('-')[1] ?? '0') % 10000)}; rev:1;)`,
  ].join('\n')

  return `# 🧷 虚拟补丁：${id} · ${c.name}（${prod}）
> 特征/tag：${sig.tag}｜说明：${sig.hint}
> 生成方：${c.kev ? 'CISA KEV 在野利用' : '内置高价值组件特征库'}，成熟度 ${c.maturity}，CVSS ${c.cvss.toFixed(1)}

**ModSecurity（WAF / 旁路镜像 DPI）**
\`\`\`apache
${modsec}
\`\`\`

**nginx（临时止血，reload 即生效）**
\`\`\`nginx
${nginx}
\`\`\`

**Snort（网络层 IDS/IPS）**
\`\`\`snort
${snort}
\`\`\`

**防误杀清单（下发前务必跑 vuln_patch_verify）**
- 用正常业务流量样本 + 恶意样本各做一次匹配测试，确认零误杀、能拦恶意
- 若误杀正常请求 → 收紧为正则匹配特定参数/请求头，或用 ModSecurity 相位+响应体上下文
- 建议先以「日志模式」（无 deny）观察 24h，再转拦截模式
${args.payload ? `> 你提供的 Payload：\`${args.payload.slice(0, 200)}\`` : ''}`
}

function patchGenPrompt(args: { cve?: string; desc?: string; payload?: string; product?: string }): string {
  return `【虚拟补丁生成 · vuln_patch_gen】${args.cve ? `CVE：${args.cve}` : ''}${args.product ? `｜产品：${args.product}` : ''}
漏洞描述：${args.desc || '（未提供，请结合 CVE 通告/特征分析）'}
${args.payload ? `已知 Payload 样本：\`${args.payload.slice(0, 300)}\`` : ''}

按以下步骤生成虚拟补丁（不改代码、不重启、网络层拦截）：
1. **特征提取**：从漏洞描述/Payload 中提取流量层面唯一特征 —— ① 特定 Header 值 ② 特定请求方法/路径 ③ 特定 Body/URL 参数模式 ④ 字节序列/T3/协议指纹。给出可控、低误杀的正则表达式。
2. **规则生成**：输出三份规则 ——
   - ModSecurity（SecRule @rx + deny/status:403）
   - nginx（$request_uri/$query_string/$http_* 正则拦截 + return 403）
   - Snort（content 匹配 + sid/msg，ocase 按需）
3. **防误杀设计**：标注该规则可能误杀哪些正常业务场景（大小写、编码、参数位置），并给出收紧建议（限定参数名/请求方法/更精确正则）。
4. **验证建议**：提示用 vuln_patch_verify 对正常+恶意样本做匹配测试，确认零误杀后再下发。
要求：正则必须是可执行的正则源码；误杀分析要具体到字段；若为复杂反序列化/协议类漏洞，说明应在哪一负载段匹配。`
}

// ═══════════════════════════════════════════════════════════════════════════════
// 五、规则防误杀验证（确定性：正则匹配测试）
// ═══════════════════════════════════════════════════════════════════════════════

function extractRegex(rule: string): string {
  const m = rule.match(/@rx\s+["']?([^"'\n]+)/i)
  if (m && m[1]) return m[1].trim()
  const m2 = rule.match(/content:\s*"([^"]+)"/i)
  if (m2 && m2[1]) return m2[1].trim()
  return rule.trim()
}

function patchVerify(args: { regex?: string; rule?: string; samples: string }): string {
  const regexSrc = (args.regex || extractRegex(args.rule || '')).trim()
  if (!regexSrc) return '❌ 未提供可验证的正则（传 regex，或传含 @rx/SecRule 的 rule）。'
  let re: RegExp
  try { re = new RegExp(regexSrc, 'i') } catch (e) { return `❌ 正则非法：${String(e)}` }

  // 解析样本
  let samples: { type: string; data: string }[] = []
  const s = args.samples.trim()
  if (s.startsWith('[')) {
    try { samples = JSON.parse(s) } catch { return '❌ samples JSON 非法' }
  } else {
    samples = s.split(',').map((x) => {
      const idx = x.indexOf(':')
      return idx >= 0 ? { type: x.slice(0, idx).trim(), data: x.slice(idx + 1).trim() } : { type: 'attack', data: x.trim() }
    })
  }
  if (samples.length === 0) return '❌ 无样本'

  let tp = 0, fp = 0, tn = 0, fn = 0
  const rows: string[] = []
  for (const smp of samples) {
    const t = (smp.type || '').toLowerCase()
    // 反向判定：凡类型未明确为"正常"的样本按恶意保守处理（安全工具默认从严）
    const isAttack = !/normal|benign|good|clean|safe|合法|正常|放行/i.test(t)
    const hit = re.test(smp.data)
    if (isAttack) hit ? tp++ : fn++
    else hit ? fp++ : tn++
    const verdict = isAttack ? (hit ? 'TP 命中✅' : 'FN 漏杀❌') : (hit ? 'FP 误杀❌' : 'TN 放行✅')
    rows.push(`| ${isAttack ? '恶意' : '正常'} | ${JSON.stringify(smp.data.slice(0, 60))} | ${verdict} |`)
  }
  const attackTotal = tp + fn
  const normalTotal = tn + fp
  const recall = attackTotal > 0 ? tp / attackTotal : 1
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1
  const scoreImg = fp > 0 ? `⚠️ 存在误杀（${fp} 个正常样本被拦）` : fn > 0 ? `⚠️ 存在漏杀（${fn} 个恶意样本放行）` : '✅ 零误杀零漏杀'
  const verdict = fp > 0 ? '建议：收紧正则后重测（限定参数/请求方法/更精确），避免误伤业务' : fn > 0 ? '建议：正则不够宽，补特征或换 payload 段匹配' : '✅ 可下发（建议先日志模式观察 24h 再转拦截）'
  return `# 🔬 虚拟补丁规则验证
待验证正则：\`${regexSrc}\`
样本：${samples.length} 个（恶意 ${attackTotal} / 正常 ${normalTotal}）

| 类型 | 数据 | 判定 |
|---|---|---|
${rows.join('\n')}

召回率(拦恶意) ${(recall * 100).toFixed(0)}%｜精确率(不误伤) ${(precision * 100).toFixed(0)}%｜${scoreImg}
${verdict}

> 结论：${fp === 0 && fn === 0 ? '达标，可下发' : '未达标，调整后重测'}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// 六、SBOM 依赖审计 + 可达性降级（确定性）
// ═══════════════════════════════════════════════════════════════════════════════

function sbomAudit(depsInput: string): string {
  let deps: { name: string; version?: string; reachable?: boolean }[] = []
  const d = depsInput.trim()
  if (d.startsWith('[')) {
    try { deps = JSON.parse(d) } catch { return '❌ deps JSON 非法' }
  } else {
    deps = d.split(/[,;]/).map((x) => {
      const p = x.trim().split(':')
      return { name: p[0], version: p[1] }
    })
  }
  if (deps.length === 0) return '❌ 无依赖'

  const rows: string[] = []
  let critical = 0, high = 0
  for (const dep of deps) {
    const name = dep.name.trim().toLowerCase()
    const match = CVE_LIB.filter((c) => c.products.some((x) => name.includes(x) || x.includes(name)))
    if (match.length === 0) {
      rows.push(`| ${dep.name} ${dep.version ?? ''} | 无库内匹配 | - | - | 持续更新 | 关注 |`)
      continue
    }
    const hitDeps = dep.version ? match.filter((c) => c.affected.some((r) => versionInRange(dep.version!, r))) : match
    if (hitDeps.length === 0) {
      rows.push(`| ${dep.name} ${dep.version ?? ''} | 无命中 | - | - | 持续更新 | 关注 |`)
      continue
    }
    for (const c of hitDeps) {
      const reachable = dep.reachable !== false
      // 可达性降级：不可达 → 风险降级（-1.5）
      const effective = reachable ? c.cvss : c.cvss - 1.5
      const effSev = effective >= 9 ? '严重' : effective >= 7 ? '高' : effective >= 4 ? '中' : '低'
      if (effSev === '严重') critical++
      else if (effSev === '高') high++
      rows.push(`| ${dep.name} ${dep.version ?? ''} | ${c.id} ${c.name} | ${reachable ? '✅可达' : '⬇不可达降级'} | ${effSev} (原${c.severity}) | 临时缓解→升级 | ${c.type} |`)
    }
  }
  return `# 📦 SBOM 依赖审计 + 可达性分析
${deps.length} 个依赖，${critical} 个严重 / ${high} 个高危

| 依赖(版本) | 匹配 CVE | 可达性 | 处置严重度 | 处置动作 | 漏洞类型 |
|---|---|---|---|---|---|
${rows.join('\n')}

> 可达性 = 漏洞代码是否被业务实际调用：不可达自动降级，避免安全团队做无用功；用 vuln_priority 量化、vuln_patch_gen 打虚拟补丁、vuln_remediate 出修复方案。`
}

// ═══════════════════════════════════════════════════════════════════════════════
// 七、修复优先级排期（确定性：评分排序 + 里程碑 + 窗口）
// ═══════════════════════════════════════════════════════════════════════════════

function remediationPlan(vulnsInput: string): string {
  let list: any[]
  try { list = JSON.parse(vulnsInput) } catch { return '❌ vulns JSON 非法' }
  if (!Array.isArray(list)) return '❌ vulns 需为数组'
  const scored = list.map((it, i) => {
    const f = normalizeF(it)
    const root = it.id ?? ('#' + (i + 1))
    if (!f) return { id: root, score: 0, label: '未知' }
    const r = riskScore(f)
    return { id: root, score: r.score, label: r.label }
  }).sort((a, b) => b.score - a.score)

  const rows = scored.map((r, idx) => {
    const window = r.score >= 0.75 ? '24h 内' : r.score >= 0.55 ? '7 天内' : r.score >= 0.30 ? '30 天内' : '列入观察'
    return `| ${idx + 1} | ${r.id} | ${r.score.toFixed(3)} | ${r.label} | ${window} |`
  }).join('\n')
  const top = scored.slice(0, 3)
  return `# 🗓️ 漏洞修复排期（VPR 排序）
| 序 | 漏洞 | VPR | 优先级 | 处置窗口 |
|---|---|---|---|---|
${rows}

**里程碑**
1. ✅ 24h 内（虚拟补丁止血）：${top.filter((r) => r.score >= 0.75).map((r) => r.id).join('、') || '无'} — 用 vuln_patch_gen 生成规则 + vuln_patch_verify 验证后下发，再排根本修复
2. 🛡️ 7 天内（根本修复 + 回归）：${top.filter((r) => r.score >= 0.55).map((r) => r.id).join('、') || '无'} — 升级/打官方补丁/配置加固，沙箱验证
3. 📅 30 天内（加固扫描）：全部 ≥0.30 漏洞，纳入常规修补；用 vuln_scan 复扫确认闭环

> 原则：先虚拟补丁止血，再根本修复，最后回归验证；每单必须带回滚方案。用 vuln_remediate 生成修复方案。`
}

// ═══════════════════════════════════════════════════════════════════════════════
// 八、智能体修复方案（模型侧）
// ═══════════════════════════════════════════════════════════════════════════════

function remDialatePrompt(args: { vuln: string; asset?: string; severity?: string; layer?: string }): string {
  const layer = args.layer || 'all'
  return `【智能体修复 · vuln_remediate】漏洞：${args.vuln}${args.asset ? `｜资产/技术栈：${args.asset}` : ''}${args.severity ? `｜严重度：${args.severity}` : ''}｜修复层级：${layer}
按以下结构输出可落地的修复方案：
1. **临时缓解（先止血，生产可快速做）**：网络层虚拟补丁（WAF/ModSecurity 规则、nginx 拦截）+ 配置层（禁用相关功能/最小权限/关闭 debug）+ 说明操作与影响
2. **根本修复（治本，纳入代码/版本升级）**：针对漏洞给出具体修复 ——
   - 代码级：修复后的代码片段（安全编码：输入校验/白名单/参数化/升级依赖），标注改动文件
   - 配置级：加固配置项（禁用反序列化、限制 JNDI、关闭 debug、更新 TLS）
   - 依赖级：升级到哪个安全版本，给出 before/after
3. **影响面评估**：升级/修复可能影响的业务（兼容性、API、性能、回归点），逐条列风险
4. **回滚方案**：如何快速恢复原状态（备份点、配置回滚、灰度/蓝绿、功能开关）
5. **沙箱验证清单**：隔离环境验证修复是否拦截攻击 Payload + 正常流量 100% 畅通的测试用例
6. **验证与复测**：上线后如何复测确认漏洞已闭环
要求：面向「开发+运维」可执行；所有修改附影响与回滚；能给出代码片段的一定给出。`
}

// ═══════════════════════════════════════════════════════════════════════════════
// 九、知识库（确定性渲染，紧凑卡片）
// ═══════════════════════════════════════════════════════════════════════════════

const VULN_KB: Record<string, string> = {
  epss: `# 📈 EPSS / VPR 动态风险评分模型
- **问题**：传统 CVSS 静态、无法反映真实风险；需预测"漏洞被利用的真实概率"。
- **EPSS**（Exploit Prediction Scoring System）：0-1 概率，预测未来 30 天被利用概率。
- **VPR**（Vuln Priority Rating）：0-1 动态分数，决定修复优先级。
- **特征工程**（多维）：CVSS+严重级别 / 利用代码成熟度(未证实→POC→功能EXP→武器化) / 历史在野利用(KEV) / 暴露面(本地·远程需鉴权·远程无鉴权) / 时间衰减(披露时长) / 资产关键性(业务上下文)。
- **模型**：梯度提升树(XGBoost/LightGBM) 或 逻辑回归，叠加 LSTM/Transformer 处理时间序列；LLM 从非结构化通告自动填字段；以"人类实际修复顺序"作 RL 奖励信号做个性化。
- **实战**：用 vuln_priority 对每个漏洞算分 → 排序后修复。分数=0-1；≥0.75 立即、≥0.55 近日、≥0.30 计划、<0.30 观察。
- 结合：vuln_scan 发现 → vuln_priority 排序 → vuln_patch_gen 虚拟补丁 → vuln_remediate 根本修复`,

  patch: `# 🧷 虚拟补丁（Virtual Patching）方法论
- **核心理念**：不改代码、不重启，在网络层拦截攻击——"补丁追不上漏洞"的最强实战技术。
- **适用**：官方补丁未发布 / 业务无法重启的空窗期 / 0day 爆发（24-48h 武器化窗口内止血）。
- **闭环**：① 漏洞特征提取（研究人员 24h 内分析 Payload，提流量唯一特征：Header 值/T3 字节序/恶意 Body 模式）→ ② 规则生成（LLM 或代码生成模型，输入漏洞描述+Payload → 正则/设备规则）→ ③ 流量检测拦截（旁路镜像/WAF DPI 匹配即 TCP Reset，合法放行）。
- **防误杀**：引入"正常业务流量日志"做负样本，规则生成后自动正则匹配测试，确保不误杀；可多维生成 L3/L4 与 L7（精确到参数名/请求方法）。
- **工具**：ModSecurity / nginx+lua / Snort / Suricata / 云 WAF（如 0day 小时级自动修复）。
- **实战**：用 vuln_patch_gen 自动生成规则 + vuln_patch_verify 验证（零误杀才下发，先日志模式观察再拦截）。`,

  reachability: `# 🔗 可达性分析（Reachability Analysis）——供应链安全王牌
- **问题**：SAST/SCA 误报率高；扫描发现大量 CVE，但很多漏洞的代码路径根本不被业务实际调用。
- **办法**：深度解析代码依赖关系（SBOM），判断漏洞代码是否被实际调用。漏洞存在但路径不可达 → **自动降级**，团队不做无用功。
- **关键**：静态匹配算「有可能」，可达性算「真正利用得上」。达到 "Execution-bound" —— 只在代码真被执行时才告警。
- **落地**：SBOM(软件物料清单) + 函数级调用链 + 运行时插桩/沙箱执行确认。工具：OWASP SBOM-VEX-Taint-Analysis、CycloneDX/SPDX + 调用图分析。
- **实战**：用 vuln_sbom 审依赖 + 标记 reachable（是否被实际调用），不可达自动降级，风险评分相应下调。`,

  loop: `# 🔁 漏洞修复闭环（Agentic Triage & Remediation）
- **Triage Agent（分流）**：面对海量扫描结果，AI 结合威胁情报(KEV/在野 EXP) + 资产重要性，过滤掉 95% 无效告警，精准锁定那 1% 真正致命风险。
- **Zero-Day Agent（零日）**：全天候监控全球新披露漏洞；0day 爆发瞬间扫描企业所有代码库/运行环境，定位受影响组件，几分钟内生成经过验证的修复方案。
- **Remediation Agent（修复）**：AI 自动写修复代码或 WAF 规则 → 直接在仓库发起 Pull Request。
- **沙箱验证**：隔离环境自动测试生成的虚拟补丁是否拦截攻击 Payload + 不误杀正常流量，通过后才推给人类审批。
- **闭环**：发现 → 分流排序 → 虚拟补丁止血 → 根本修复(PR) → 沙箱回归 → 人工审批 → 复测确认。每一步可验证、可回滚。
- **实战**：vuln_scan → vuln_priority → vuln_patch_gen/verify → vuln_remediate → vuln_plan 排期 → 复扫闭环。`,

  sca: `# 📦 依赖审计（SCA / Software Composition Analysis）
- **为何**：开源组件漏洞占比超 60%；第三方依赖是最大的隐藏攻击面（供应链投毒、已知 CVE 暴露）。
- **流程**：采集依赖清单(SBOM) → 匹配已知 CVE/恶意包库 → 判断可达性 → 出修复建议。
- **成熟度工具**：Syft/Trivy/OWASP Dependency-Check/Grype/Snyk；SBOM 格式 SPDX/CycloneDX。
- **投毒识别**：typosquatting（近似名）、依赖混淆(内网劫持)、恶意版本更新、密钥泄露。
- **修复**：升级到安全版本（锁定确切版本）、用最小可用依赖、私有镜像仓库+签名校验、CI 集成 SCA 阻断。
- **实战**：用 vuln_sbom 审依赖清单 → 匹配 CVE + 可达性降级 → 出处置动作。`,

  kev: `# 🚨 CISA KEV（已知被利用漏洞目录 Known Exploited Vulnerabilities）
- **定义**：CISA 维护的"已知被攻击者利用"漏洞目录，权威在野利用信号。
- **为何关键**：KEV 里的漏洞几乎都是"真实在野被攻击"的高危项；纳入后风险权重显著拉升。
- **使用**：① 优先级——KEV 漏洞强制优先处置（BOD 22-01：联邦机构限时修复）；② 核对自己资产是否受影响；③ 应急——KEV + 高危 = 立即虚拟补丁。
- **常见 KEV**：Log4Shell(CVE-2021-44228)、Exchange ProxyLogon(CVE-2021-26855)、WebLogic(CVE-2020-14882)、Struts2 S2-045(CVE-2017-5638)、Confluence(CVE-2022-26134)、PrintNightmare(CVE-2021-34527)。
- **实战**：内置库已标注 KEV，自动并入 vuln_priority 评分（权重上调）；用 vuln_cve 查某 CVE 是否 KEV。`,

  remediate: `# 🔧 修复方法论（三层修复 + 闭环验证）
- **三层修复**：① 临时缓解（虚拟补丁/配置加固，网络层快速止血）② 根本修复（代码安全编码/依赖升级到安全版本）③ 验证复测（回归测试 + 复扫确认）。
- **代码级**：输入白名单校验/参数化查询/输出编码/禁止危险函数/依赖升级；给出修改前后 diff。
- **配置级**：限制危险功能（如禁用反序列化、JNDI 过滤、关闭 debug、最小权限、最小暴露面）。
- **影响面**：升级/修复的兼容性、API、性能、回归点评估，逐条列风险。
- **回滚**：备份点、配置回滚、灰度/蓝绿、功能开关——每一单必须带回滚方案。
- **沙箱验证**：隔离地恢复攻击 Payload + 正常流量各测一遍，确认"拦截攻击 + 正常 100% 畅通"。
- **实战**：用 vuln_remediate 出完整方案（含影响+回滚+沙箱验证），vuln_plan 排期。`,
}

function renderVulnKnowledge(topic: string): string {
  const t = topic.trim().toLowerCase()
  if (VULN_KB[t]) return VULN_KB[t]
  const avail = Object.keys(VULN_KB).join(' / ')
  return `⚠️ 未知主题「${topic}」。可用主题：${avail}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// 十、目标综合扫描（node 原生：fetch + net，确定性，零外部 API）
// ═══════════════════════════════════════════════════════════════════════════════

async function runVulnScan(args: { target: string; ports?: string; timeoutMs?: number }): Promise<string> {
  const target = (args.target || '').trim()
  if (!target) return '❌ 未提供目标。'
  const timeout = args.timeoutMs ?? 8000
  let url = target
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url
  let host = ''
  try { host = new URL(url).hostname } catch { return `❌ 目标 URL 非法：${target}` }

  const out: string[] = []
  out.push(`# 🔍 目标综合漏洞扫描：${target}`)
  out.push(`> ⚠️ 请确认目标在授权范围内；本扫描为最小影响原则（信息收集 + 指纹 + 基线）。`)

  // ── HTTP 探测 + 指纹提取 ──
  const comps: { name: string; version?: string; source: string }[] = []
  const baseline: string[] = []
  let httpCode = 0
  let serverHeader = ''
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) })
    httpCode = res.status
    serverHeader = res.headers.get('server') || ''
    const powered = res.headers.get('x-powered-by') || ''
    const body = await res.text().catch(() => '')
    const gen = body.match(/<meta[^>]+generator[^>]+content=["']?([^"'>]+)/i)
    const srv = fingerprintServer(serverHeader)
    if (serverHeader) comps.push({ name: srv.name, version: srv.version, source: 'server头' })
    if (powered) comps.push({ name: powered.trim().split('/')[0], version: powered.match(/\d+[\w.+-]*/)?.[0], source: 'x-powered-by' })
    if (gen) comps.push({ name: gen[1].trim().split(' ')[0], version: gen[1].trim().match(/\d+[\w.+-]*/)?.[0], source: 'meta-generator' })
    out.push(`HTTP 状态：${httpCode} ${res.statusText}`)
    out.push(`Server：${serverHeader || '（未暴露）'}｜X-Powered-By：${powered || '无'}`)
    baseline.push(...compactBaseline(res, url, serverHeader))
  } catch (e) {
    out.push(`⚠️ HTTP 探测失败（${String(e)}）—— 可能非 Web 或靶机未起 Web。继续端口探测。`)
  }

  // ── 组件 → CVE 关联 ──
  const cveHits: { comp: string; c: Cve }[] = []
  for (const comp of comps) {
    const p = comp.name.toLowerCase()
    const matched = CVE_LIB.filter((c) => c.products.some((x) => p.includes(x) || x.includes(p)))
    for (const c of matched) {
      if (comp.version) {
        if (c.affected.some((r) => versionInRange(comp.version!, r))) cveHits.push({ comp: `${comp.name} ${comp.version}`, c })
      } else {
        cveHits.push({ comp: comp.name, c })
      }
    }
  }

  // ── 端口探测（可选，有界并发） ──
  const ports = (args.ports || '80,443,8080,8443,3306,6379').split(',').map((x) => x.trim()).filter(Boolean)
  const portRows: string[] = []
  await Promise.all(ports.map(async (p) => {
    const [rs, re] = p.includes('-') ? p.split('-').map(Number) : [Number(p), Number(p)]
    const start = isNaN(rs) ? Number(p) : rs
    const end = isNaN(re) ? start : re
    for (let pt = start; pt <= end && pt <= 65535; pt++) {
      const open = await probePort(host, pt, Math.min(timeout, 3000))
      if (open) portRows.push(`| ${pt} | 开放 |`)
    }
  }))
  portRows.sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]))
  if (portRows.length) out.push(`\n**端口探测（${host}）：**\n| 端口 | 状态 |\n|---|---|\n${portRows.join('\n')}`)

  // ── 汇总 ──
  const vulnTable = cveHits.length
    ? cveHits.map((h, i) => {
      const s = h.c.kev ? '严重(KEV)' : h.c.severity
      return `| ${i + 1} | ${h.comp} | ${h.c.id} ${h.c.name} | ${s} | ${h.c.maturity} | ${h.c.type} |`
    }).join('\n')
    : '| - | （未识别到库内 CVE） | - | - | - | - |'

  out.push(`\n**CVE 漏洞发现清单：**\n| # | 组件(版本) | CVE | 严重度 | 成熟度 | 类型 |\n|---|---|---|---|---|---|\n${vulnTable}`)
  out.push(`\n**HTTP 安全基线：**\n${baseline.join('\n') || '（未获取到响应头）'}`)
  out.push(`\n> 建议：用 vuln_cve 查明细 → vuln_priority 动态评分 → vuln_patch_gen 打虚拟补丁 → vuln_remediate 出修复方案 → 修复后用 vuln_scan 复扫闭环。`)

  return out.join('\n')
}

function fingerprintServer(server: string): { name: string; version?: string } {
  const s = server.toLowerCase()
  const known: [string, string][] = [
    ['nginx', 'nginx'], ['apache', 'apache'], ['iis', 'iis'], ['tomcat', 'tomcat'],
    ['weblogic', 'weblogic'], ['websphere', 'websphere'], ['jetty', 'jetty'], ['wildfly', 'wildfly'],
    ['gunicorn', 'gunicorn'], ['openresty', 'openresty'], ['caddy', 'caddy'], ['express', 'express'],
  ]
  for (const [k, name] of known) if (s.includes(k)) return { name, version: server.match(/(\d+[\w.+-]*)/)?.[0] }
  return { name: server.split('/')[0] || server.split(' ')[0], version: server.match(/(\d+[\w.+-]*)/)?.[0] }
}

function compactBaseline(res: Response, url: string, server: string): string[] {
  const out: string[] = []
  const csp = res.headers.get('content-security-policy')
  if (!csp) out.push("| CSP | 风险 | 缺失内容安全策略, XSS 影响面大 | 配置 default-src 'self' |")
  else if (/unsafe-inline|unsafe-eval/.test(csp)) out.push('| CSP | 警告 | 含 unsafe-inline/eval | 移除, 用 nonce/hash 白名单 |')
  if (!res.headers.get('strict-transport-security')) out.push('| HSTS | 警告 | 缺失, 存在 SSL 剥离 | max-age=31536000; includeSubDomains |')
  if (!res.headers.get('x-content-type-options')) out.push('| X-Content-Type-Options | 警告 | 缺失, MIME 嗅探 | nosniff |')
  if (!res.headers.get('x-frame-options') && !(csp && /frame-ancestors/.test(csp))) out.push('| X-Frame-Options | 警告 | 缺失, 点击劫持 | DENY 或 frame-ancestors |')
  if (/^\d+(\.\d+)+/.test(server)) out.push('| Server 版本泄露 | 警告 | 暴露版本号 | 隐藏版本(如 nginx server_tokens off) |')
  if (url.startsWith('http://')) out.push('| 传输协议 | 风险 | HTTP 明文传输 | 启用 HTTPS + HSTS |')
  const sc = res.headers.get('set-cookie')
  if (sc) {
    if (!/httponly/i.test(sc)) out.push('| 会话Cookie HttpOnly | 风险 | 未设 HttpOnly, 可被 XSS 窃取 | 会话 Cookie 必设 |')
    if (!/secure/i.test(sc)) out.push('| 会话Cookie Secure | 警告 | 未设 Secure | HTTPS 下必须 |')
    if (!/samesite/i.test(sc)) out.push('| 会话Cookie SameSite | 警告 | 未设, CSRF 风险 | SameSite=Lax/Strict |')
  }
  return out.length ? [`| 检查项 | 状态 | 详情 | 修复 |\n|---|---|---|---|\n${out.join('\n')}`] : ['| 检查项 | 状态 | 详情 | 修复 |\n|---|---|---|---|\n| 基线 | ✅ | 主要安全头齐全 | 保持 |']
}

function probePort(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port, timeout })
    const done = (ok: boolean) => { try { sock.destroy() } catch { /* noop */ } resolve(ok) }
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.setTimeout(timeout)
  })
}
