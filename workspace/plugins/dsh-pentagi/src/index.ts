/**
 * @dsh-external/dsh-pentagi — PentAGI 多智能体渗透大脑（Pentest AGI Brain）
 *
 * 架构移植自 vxcontrol/pentagi（俄罗斯 VXControl 团队开源，7.2K★）：
 *   - 13 个专业 Agent（Primary/Pentester/Coder/Installer/Assistant +
 *     Searcher/Enricher/Memorist/Generator/Reporter/Adviser/Reflector/Planner）
 *   - Planner 生成阶段化任务图 → Primary 按图推进 → Adviser 在失败时自动换路
 *     → Reflector 复盘 → Memorist 知识沉淀（越用越聪明）→ Reporter 出报告
 *
 * 与 sec-* 攻击插件的关系（配套互补）：
 *   sec-workbench 的 40+ 个 sec_* 工具 = 「手」（单点执行：扫描/利用/爆破/取证）
 *   本插件 = 「脑」（编排/推进/反思/记忆/报告），每一步都绑定到具体 sec_* 工具
 *
 * 工具集（7 个，全确定性、零 token、零外部依赖——pgvector/Neo4j 用本地 JSON+关键词索引替代）：
 *   agi_team    13 角色编组表 + sec_* 工具绑定 + 调用时机（指挥图）
 *   agi_plan    作战计划：目标+意图 → 阶段化任务流（建 flow，含每步工具/参数/判据/备选）
 *   agi_flow    任务流管理：status/list/update/close（推进时回报结果）
 *   agi_next    Next-Best-Action 推进器：读 flow → 下一步该哪个角色用什么工具；失败自动 Adviser 变体
 *   agi_memory  Memorist 知识库：add/search/stats/forget（成功路径沉淀，下次直接复用）
 *   agi_reflect Reflector 复盘：有效/无效模式提炼，可一键写入记忆库
 *   agi_report  Reporter 报告：flow 执行记录 → 标准渗透测试报告落盘
 *
 * 形态：toolkit。规范：所有资源注册挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-pentagi'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** 首轮锚定：首个工具调用前只露作战入口（省首轮 prefill） */
  anchorFirstTurn: boolean
  /** 报告输出目录（空 = DSH 插件数据目录 reports 子目录） */
  outDir: string
}

export const Config = z.object({
  anchorFirstTurn: z.boolean().default(true),
  outDir: z.string().default(''),
})

/** 本插件全部工具名（首轮锚定裁剪集合） */
const MINE = new Set([
  'agi_team', 'agi_plan', 'agi_flow', 'agi_next',
  'agi_memory', 'agi_reflect', 'agi_report',
])
const CORE = 'agi_plan'

// ═══════════════════════════ 数据目录与存储 ═══════════════════════════

function dataRoot(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'plugins', 'dsh-pentagi')
}
function flowsDir(): string { return join(dataRoot(), 'flows') }
function memFile(): string { return join(dataRoot(), 'memory', 'kb.jsonl') }
function reportDir(config: Config): string {
  return config.outDir || join(dataRoot(), 'reports')
}

function genId(prefix: string): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}-${ymd}-${rand}`
}
function nowISO(): string { return new Date().toISOString() }

// ═══════════════════════════ 类型定义 ═══════════════════════════

export interface StepAlt { tool: string; args: Record<string, string>; why: string }
export interface Step {
  n: number
  phase: string          // RECON/SCOPE/MAP/EXPLOIT/POST/REPORT/LEARN
  role: string           // PentAGI 角色名
  tool: string           // 绑定执行的 DSH 工具（sec_* / agi_* / vuln_* 等）
  args: Record<string, string>
  criteria: string       // 成功判据
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped'
  attempts: number
  result: string
  alts?: StepAlt[]       // Adviser 备选路径
  adviser?: boolean      // 是否 Adviser 生成的变体步
  parentN?: number       // 变体步的父步骤号（用于已试计数）
}
export interface Flow {
  id: string
  target: string
  goal: string
  kind: string           // web/api/db/net/ai/full
  scope: string
  createdAt: string
  updatedAt: string
  closed: boolean
  steps: Step[]
  findings: string[]
}

export interface MemEntry {
  id: string
  ts: string
  title: string
  scenario: string
  tags: string[]
  tech: string[]
  cve: string[]
  pattern: string
  chain: string
  pitfalls: string
  hits: number
}

// ═══════════════════════════ flow 存取 ═══════════════════════════

function loadFlow(id: string): Flow | null {
  const file = join(flowsDir(), `${id}.json`)
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) as Flow } catch { return null }
}
function saveFlow(flow: Flow): void {
  mkdirSync(flowsDir(), { recursive: true })
  flow.updatedAt = nowISO()
  writeFileSync(join(flowsDir(), `${flow.id}.json`), JSON.stringify(flow, null, 2), 'utf8')
}
function listFlowIds(): string[] {
  if (!existsSync(flowsDir())) return []
  return readdirSync(flowsDir()).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort().reverse()
}

// ═══════════════════════════ 计划引擎（Planner） ═══════════════════════════

interface PhaseDef { key: string; name: string }

export const PHASES: PhaseDef[] = [
  { key: 'RECON', name: '①侦察' },
  { key: 'SCOPE', name: '②门禁' },
  { key: 'MAP', name: '③攻击面测绘' },
  { key: 'EXPLOIT', name: '④利用验证' },
  { key: 'POST', name: '⑤后渗透' },
  { key: 'REPORT', name: '⑥报告' },
  { key: 'LEARN', name: '⑦复盘沉淀' },
]

let stepSeq = 0
function mkStep(phase: string, role: string, tool: string, args: Record<string, string>, criteria: string, alts?: StepAlt[]): Step {
  stepSeq += 1
  return { n: stepSeq, phase, role, tool, args, criteria, status: 'pending', attempts: 0, result: '', alts, adviser: false }
}

/**
 * Planner 核心：按 kind 生成阶段化任务图。
 * 每一步绑定本机真实可用的工具；失败路径预置 Adviser 备选（alts）。
 */
export function planSteps(target: string, goal: string, kind: string): Step[] {
  stepSeq = 0
  const steps: Step[] = []

  // ── ① 侦察（Searcher/Enricher）──
  steps.push(mkStep('RECON', 'Searcher', 'sec_osint', { target },
    '拿到域名/IP 资产面、邮箱/子域线索（OSINT 计划即可，不必全部执行）'))
  steps.push(mkStep('RECON', 'Enricher', 'sec_exec', { action: 'crt', target },
    '证书透明度日志给出子域清单', [
    { tool: 'sec_exec', args: { action: 'subdomain', target }, why: 'DNS 爆破枚举子域' },
  ]))
  steps.push(mkStep('RECON', 'Enricher', 'sec_tlsfp', { target },
    'TLS 版本矩阵/弱协议/证书链信息入库'))

  // ── ② 门禁（Primary）──
  steps.push(mkStep('SCOPE', 'Primary', 'sec_scope', { task: goal || `对 ${target} 的渗透测试`, target },
    'scope.md 落盘且 ready_for_act=true；未 ready 则停在门禁补齐范围', [
    { tool: 'sec_guard', args: { target, intent: goal || '渗透测试', authorized: 'true' }, why: '快速授权核对兜底' },
  ]))

  // ── ③ 攻击面测绘（Enricher）——按 kind 分支 ──
  if (kind === 'web' || kind === 'api' || kind === 'full') {
    steps.push(mkStep('MAP', 'Enricher', 'sec_webscan', { target },
      '技术栈指纹+敏感文件+目录爆破+漏洞快测的统一攻击面清单', [
      { tool: 'crawl4ai', args: { url: target }, why: '抓正文与内部链接辅助判断业务面' },
    ]))
    steps.push(mkStep('MAP', 'Enricher', 'vuln_scan', { target },
      'CVE 关联发现清单（含严重度/可用性）'))
  }
  if (kind === 'db' || kind === 'full') {
    steps.push(mkStep('MAP', 'Enricher', 'sec_dbsvc', { target, type: 'auto' },
      '数据库/缓存未授权访问或弱口令结论', [
      { tool: 'sec_exec', args: { action: 'banner', target, ports: '3306,6379,9200,27017,11211' }, why: '先 banner 识别再定向打' },
    ]))
  }
  if (kind === 'net' || kind === 'full') {
    steps.push(mkStep('MAP', 'Enricher', 'sec_lateral', { target },
      '135/445/5985/3389/389 横向暴露面清单', [
      { tool: 'sec_exec', args: { action: 'tcp', target, ports: '21,22,80,443,445,1433,3306,3389,5985,8080' }, why: '全端口概览' },
    ]))
  }
  if (kind === 'ai' || kind === 'full') {
    steps.push(mkStep('MAP', 'Enricher', 'sec_ai_scan', { target },
      'AI 组件指纹/CVE/敏感路径/注入向量统一报告'))
  }
  if (kind === 'net' || kind === 'ai') {
    // net/ai 也补一个 web 面（多数目标都有 web 入口）
    steps.push(mkStep('MAP', 'Enricher', 'sec_webscan', { target },
      'Web 攻击面补充测绘'))
  }

  // ── ③b 二进制逆向（Reverser）——目标/意图含客户端、APK、二进制、固件、签名算法时自动插入 ──
  // 逆向链（dsh-reverse-skill + war-bridge 的 ida 桥）与攻击链在此合流：
  // 先静态还原算法，再把结论交接给攻击链使用。
  if (wantsReverse(target, goal)) {
    steps.push(mkStep('MAP', 'Reverser', 'ida', { action: 'status' },
      'IDA MCP 在线（工具数 >0）；未在线则跑 reverse-skill\\skills\\ida-reverse\\scripts\\start.ps1', [
      { tool: 'rev_route', args: { hint: goal || '二进制静态逆向' }, why: '先路由出 PRIMARY 逆向技能，别凭感觉开工具' },
    ]))
    steps.push(mkStep('MAP', 'Reverser', 'ida', { action: 'open', path: '<样本路径>' },
      '样本打开成功且 hexrays_ready=true，随后 funcs/strings/xrefs 定位关键逻辑'))
    steps.push(mkStep('MAP', 'Reverser', 'ida', { action: 'decompile', addr: '<关键函数地址>' },
      '输出 C 伪代码，还原签名/加密/协议/校验算法；结论登记 rev_case finding（须引用证据）', [
      { tool: 'ida', args: { action: 'eval', code: "print(hex(idc.get_name_ea_simple('main')))" }, why: '符号找不到时用 py_eval 直接定位入口' },
      { tool: 'ida', args: { action: 'funcs', query: '<关键词>' }, why: '按名字过滤快速缩小函数范围' },
    ]))
    steps.push(mkStep('MAP', 'Reverser', 'rev_case', { action: 'evidence', case: '<案件名>', title: '<关键观察>' },
      '静态结论落为不可变证据（含 repro_command）；升 validated 需 ≥2 条独立证据'))
  }

  // ── ④ 利用验证（Pentester/Coder/Generator）——按 kind 分支 ──
  if (kind === 'web' || kind === 'api' || kind === 'full') {
    steps.push(mkStep('EXPLOIT', 'Pentester', 'sec_webtest', { target },
      'SQL 注入/XSS/SSTI/路径穿越等主动验证结论（payload+观测信号）', [
      { tool: 'sec_webtest', args: { target, method: 'POST' }, why: 'POST 注入点重测一遍' },
      { tool: 'sec_jwt', args: { url: target }, why: '若存在 JWT 鉴权则转 JWT 攻击' },
      { tool: 'sec_brute', args: { target: joinUrl(target, 'login'), authtype: 'form' }, why: '登录口弱口令验证' },
    ]))
  }
  if (kind === 'db' || kind === 'full') {
    steps.push(mkStep('EXPLOIT', 'Pentester', 'sec_dbsvc', { target, type: 'auto' },
      '未授权访问实证（PING/STATUS/版本）', [
      { tool: 'sec_brute', args: { target: joinUrl(target, 'auth'), authtype: 'basic' }, why: 'HTTP Basic 凭据爆破兜底' },
    ]))
  }
  if (kind === 'net' || kind === 'full') {
    steps.push(mkStep('EXPLOIT', 'Pentester', 'sec_brute', { target: joinUrl(target, 'service'), authtype: 'form' },
      '暴露服务的凭据强度结论', [
      { tool: 'sec_lateral', args: { target }, why: '横向端口复探确认可达性' },
    ]))
  }
  if (kind === 'ai' || kind === 'full') {
    steps.push(mkStep('EXPLOIT', 'Pentester', 'sec_ai_llm', { target },
      'LLM 组件 CVE 匹配与攻击路径结论', [
      { tool: 'sec_ai_test', args: { target: 'mcp' }, why: 'MCP 投毒/提示注入向量检测' },
    ]))
  }
  // Reverser：逆向结论交接给攻击链（两库合流，供后续利用与报告引用）
  if (wantsReverse(target, goal)) {
    steps.push(mkStep('EXPLOIT', 'Reverser', 'war_case', { action: 'handoff', case: '<案件名>', from: 'rev' },
      '逆向侧证据与结论已交接进攻击链案件库（war_case show 可并排看到两库）', [
      { tool: 'war_memory', args: { action: 'search', query: '<还原出的算法/协议关键词>' }, why: '先查三库是否已有同类打法可复用' },
    ]))
  }
  // Coder：对已确认漏洞生成概念验证载荷（仅文本模板，不落地）
  steps.push(mkStep('EXPLOIT', 'Coder', 'sec_payload', { type: 'webshell' },
    '为已确认漏洞生成 PoC 载荷文本模板（不落地不投递，仅报告引用）', [
    { tool: 'sec_payload', args: { type: 'reverse-shell' }, why: '需要回连演示时改用反弹 shell 模板' },
  ]))
  steps.push(mkStep('EXPLOIT', 'Generator', 'sec_stealth', { payload: '<上一步 PoC 关键片段>' },
    'WAF/免杀变体清单（验证拦截特征时用）'))

  // ── ⑤ 后渗透（可选，Installer/Memorist）──
  steps.push(mkStep('POST', 'Installer', 'sec_toolchain', {},
    '本机所需外部工具（nmap/sqlmap/hashcat…）真实路径确认，缺什么列什么'))
  steps.push(mkStep('POST', 'Memorist', 'sec_evidence', { action: 'add', title: `关键证据汇总 ${target}`, sourceType: 'command', repro: '<复现命令>' },
    '关键观察全部登记为 E-xxx 不可变证据，供报告引用'))

  // ── ⑥ 报告（Reporter）──
  steps.push(mkStep('REPORT', 'Reporter', 'agi_report', { id: '<flow_id>' },
    '标准渗透报告 Markdown 落盘（执行摘要/发现/复现/修复）'))

  // ── ⑦ 复盘沉淀（Reflector/Memorist）──
  steps.push(mkStep('LEARN', 'Reflector', 'agi_reflect', { did: '<本次做了什么>', worked: '<有效模式>', failed: '<无效模式>', improve: '<下次改进>' },
    '结构化复盘产出，save=yes 时写入记忆库'))
  steps.push(mkStep('LEARN', 'Memorist', 'sec_journal', { action: 'write', scenario: '渗透', title: '<一句话经验>', chain: '<执行链路>', patterns: '<可复用模式>' },
    'field-journal 经验回写完成'))

  return steps
}

function joinUrl(base: string, suffix: string): string {
  if (/^https?:\/\//.test(base)) return base.replace(/\/+$/, '') + '/' + suffix
  return base
}

/** 目标/意图是否指向二进制逆向（决定要不要插逆向步骤） */
const RE_HINT = /(apk|android|ios|ipa|客户端|小程序|二进制|binary|\bexe\b|\bdll\b|\.so\b|elf|固件|firmware|签名算法|加密算法|协议逆向|逆向|脱壳|混淆|so 文件|native|jni|反编译)/i
export function wantsReverse(target: string, goal: string): boolean {
  return RE_HINT.test(`${target} ${goal}`)
}

// ═══════════════════════════ 推进引擎（Primary + Adviser） ═══════════════════════════

export interface NextAction {
  done: boolean
  phase?: string
  progress?: string
  role?: string
  tool?: string
  args?: Record<string, string>
  criteria?: string
  adviserNote?: string
  reportHint?: string
}

/** Primary 推进器：返回下一步动作；失败步已被 adviseOnFail 换成备选变体 */
export function nextAction(flow: Flow): NextAction {
  for (const s of flow.steps) {
    if (s.status === 'done' || s.status === 'skipped') continue
    const doneN = flow.steps.filter((x) => x.status === 'done').length
    const phaseIdx = PHASES.findIndex((p) => p.key === s.phase)
    s.status = 'active'
    saveFlow(flow)
    return {
      done: false,
      phase: `${PHASES[phaseIdx >= 0 ? phaseIdx : 0].name}(${phaseIdx + 1}/${PHASES.length})`,
      progress: `${doneN}/${flow.steps.length}`,
      role: s.role,
      tool: s.tool,
      args: s.args,
      criteria: s.criteria,
      adviserNote: s.adviser ? `[Adviser] 前一步失败，切换备选路径：${s.result}` : undefined,
      reportHint: `agi_flow update id=${flow.id} step=${s.n} status=done|failed result="<真实结果>"`,
    }
  }
  return { done: true }
}

/** 步骤失败时的 Adviser 介入：追加备选变体步（每步最多 2 次），无备选则跳过 */
export function adviseOnFail(flow: Flow, stepN: number): string {
  const idx = flow.steps.findIndex((x) => x.n === stepN)
  if (idx < 0) return `步骤 ${stepN} 不存在`
  const s = flow.steps[idx]
  s.attempts += 1
  s.status = 'failed'
  const tried = flow.steps.filter((x) => x.adviser && x.parentN === s.n).length
  if (s.alts && s.alts.length > tried && s.attempts <= 2) {
    const alt = s.alts[tried]
    stepSeq = flow.steps.length
    const v = mkStep(s.phase, s.role === 'Coder' ? 'Generator' : s.role, alt.tool, alt.args, `${s.criteria}（Adviser 换路：${alt.why}）`)
    v.adviser = true
    v.parentN = s.n
    v.result = alt.why
    flow.steps.splice(idx + 1, 0, v)
    renumber(flow)
    saveFlow(flow)
    return `[Adviser] 已插入备选步 #${v.n}：${alt.tool}（${alt.why}）；原步 #${stepN} 记 failed(${s.attempts}/2)`
  }
  s.status = 'skipped'
  saveFlow(flow)
  return `[Adviser] 步骤 #${stepN} 无更多备选，标记 skipped，继续推进下一步`
}

function renumber(flow: Flow): void {
  flow.steps.forEach((s, i) => { s.n = i + 1 })
}

// ═══════════════════════════ 记忆引擎（Memorist） ═══════════════════════════

export function memAdd(e: Omit<MemEntry, 'id' | 'ts' | 'hits'>): MemEntry {
  mkdirSync(join(dataRoot(), 'memory'), { recursive: true })
  const entry: MemEntry = { ...e, id: genId('MEM'), ts: nowISO(), hits: 0 }
  appendFileSync(memFile(), JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export function memAll(): MemEntry[] {
  if (!existsSync(memFile())) return []
  const lines = readFileSync(memFile(), 'utf8').split('\n').filter(Boolean)
  const out: MemEntry[] = []
  for (const l of lines) { try { out.push(JSON.parse(l) as MemEntry) } catch { /* skip bad line */ } }
  return out
}

export function memSearch(query: string, limit = 5): Array<MemEntry & { score: number }> {
  const terms = query.toLowerCase().split(/[\s,，、;；|]+/).filter(Boolean)
  const scored = memAll().map((e) => {
    const hay = [e.title, e.scenario, e.pattern, e.chain, e.pitfalls, ...e.tags, ...e.tech, ...e.cve].join(' ').toLowerCase()
    let score = 0
    for (const t of terms) {
      if (hay.includes(t)) score += 2
      else if (t.length > 3 && hay.includes(t.slice(0, Math.ceil(t.length * 0.7)))) score += 1
    }
    score += Math.min(e.hits, 3)
    return { ...e, score }
  }).filter((e) => e.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

function memRewrite(all: MemEntry[]): void {
  mkdirSync(join(dataRoot(), 'memory'), { recursive: true })
  writeFileSync(memFile(), all.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
}

export function memBumpHits(id: string): void {
  const all = memAll()
  const e = all.find((x) => x.id === id)
  if (!e) return
  e.hits += 1
  memRewrite(all)
}

// ═══════════════════════════ 渲染助手 ═══════════════════════════

function fmtArgs(args: Record<string, string>): string {
  return Object.entries(args).filter(([, v]) => v !== '').map(([k, v]) => `${k}="${v}"`).join(' ')
}

function nextBlock(flow: Flow, a: NextAction): string {
  if (a.done) {
    return `【PentAGI · ${flow.id}】✅ 全部步骤完成（共 ${flow.steps.length} 步）
收尾三连：agi_reflect 复盘（save=yes 写记忆库）→ sec_journal 回写 → agi_report 出正式报告`
  }
  return [
    `【PentAGI · Next-Best-Action】${flow.id}`,
    `目标：${flow.target} ｜ 意图：${flow.goal} ｜ 类型：${flow.kind}`,
    `阶段：${a.phase} ｜ 进度：${a.progress}`,
    ``,
    `▶ 角色【${a.role}】调用工具：${a.tool}`,
    `   参数：${fmtArgs(a.args || {})}`,
    `   成功判据：${a.criteria}`,
    ...(a.adviserNote ? [`🧭 ${a.adviserNote}`] : []),
    ``,
    `↩ 执行完回报：${a.reportHint}`,
  ].join('\n')
}

// ═══════════════════════════ 系统提示方法论 ═══════════════════════════

const METHOD_SECTION = `# PentAGI 多智能体渗透大脑（dsh-pentagi）

> 移植自 vxcontrol/pentagi（俄罗斯 VXControl 开源）：13 专业 Agent 协同的渗透测试系统。
> 定位：**sec-* 攻击插件是「手」，本插件是「脑」**——编排/推进/反思/记忆/报告。

## 13 角色编组（与工具绑定）
**General 组**：Primary(主指挥·agi_plan/agi_next)、Planner(agi_plan)、Pentester(sec_webtest/sec_dbsvc/sec_brute/sec_lateral/sec_auto)、Coder(sec_payload)、Installer(sec_toolchain)、Assistant(对话中的你)
**Limited 组**：Searcher(sec_osint/web_search/crawl4ai)、Enricher(sec_fingerprint/sec_cve/sec_tlsfp/vuln_scan)、Memorist(agi_memory/sec_evidence/sec_journal)、Generator(sec_stealth/sec_encode)、Reporter(agi_report/sec_report)、Adviser(失败自动介入·agi_next 内置)、Reflector(agi_reflect)

## 标准闭环（每次渗透任务）
1. **立项**：\`agi_plan\`（target/goal/kind）→ 自动建 flow 并给出第一步。
2. **推进**：\`agi_next\` 取下一步 → 以对应角色身份调绑定工具执行 → \`agi_flow update\` 回报 done|failed+真实结果。
3. **失败即 Adviser**：步骤标 failed 自动插入备选路径步（每步≤2 次），不空转不硬磕。
4. **记忆**：成功路径 \`agi_memory add\` 沉淀；同类目标开打前先 \`agi_memory search\` 复用——越用越聪明。
5. **收尾**：\`agi_reflect\` 复盘 → sec_journal 回写 → \`agi_report\` 出标准报告。

铁律：每步有成功判据，回报必须带真实结果；结论必须有证据（sec_evidence）；授权边界由 sec_scope 门禁把关。`

// ═══════════════════════════ 插件入口 ═══════════════════════════

export function apply(ctx: Context, config: Config): void {
  // ── 方法论注入系统提示 ──
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'pentagi:method:v1',
    order: 89,
    text: METHOD_SECTION,
  }), 'pentagi: method section')

  const tools = [

    // ═══ 1. agi_team — 13 角色编组表（确定性） ═══
    defineTool({
      name: 'agi_team',
      description: 'PentAGI 13 角色编组表：每个 AI Agent 角色的职责、绑定的本机 sec_*/agi_* 工具、输入输出与调用时机。开工前看一眼当「指挥图」。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute() {
        const rows: Array<[string, string, string]> = [
          ['Primary', '主指挥：拆解目标、按图推进、裁决阶段切换', 'agi_plan / agi_next ⇄ agi_flow'],
          ['Planner', '作战规划：生成阶段化任务图（含备选路径）', 'agi_plan'],
          ['Pentester', '攻击执行：漏洞验证/利用/爆破/横向', 'sec_webtest sec_dbsvc sec_brute sec_lateral sec_auto sec_load'],
          ['Coder', '代码/PoC 编写：载荷文本模板（不落地）', 'sec_payload sec_stealth sec_encode'],
          ['Installer', '环境与工具链准备', 'sec_toolchain'],
          ['Searcher', '信息搜索：OSINT/子域/证书透明度', 'sec_osint sec_exec(crt/subdomain) web_search crawl4ai'],
          ['Enricher', '数据丰富：指纹/CVE/TLS/端口', 'sec_fingerprint sec_cve sec_tlsfp vuln_scan vuln_sbom'],
          ['Reverser', '二进制逆向：反编译/协议还原/签名算法/脱壳（目标含客户端/APK/固件时自动编入）', 'ida(war-bridge) rev_route rev_case rev_playbook rev_journal'],
          ['Memorist', '知识沉淀与检索（越用越聪明）', 'agi_memory sec_evidence sec_journal'],
          ['Generator', '变体生成：免杀/WAF 绕过/编码变形', 'sec_stealth sec_encode'],
          ['Reporter', '报告产出：标准渗透报告落盘', 'agi_report sec_report'],
          ['Adviser', '导师：步骤失败自动介入换备选路径（内置 agi_next）', 'adviseOnFail'],
          ['Reflector', '自我反思：复盘有效/无效模式', 'agi_reflect'],
        ]
        return [
          '【PentAGI · 13 角色编组表】（sec_* = 手，本插件 = 脑）',
          '',
          ...rows.map(([r, d, t]) => `◆ ${r.padEnd(10)} ${d}\n   └ 绑定: ${t}`),
          '',
          'General 组跑长流程；Limited 组做专项。',
          '标准闭环：agi_plan 立项 → agi_next 推进（agi_flow 回报）→ agi_reflect 复盘 → agi_memory 沉淀 → agi_report 交卷。',
        ].join('\n')
      },
    }),

    // ═══ 2. agi_plan — 作战计划（Planner，确定性规则引擎） ═══
    defineTool({
      name: 'agi_plan',
      description: 'PentAGI 作战计划：目标+意图 → 建 flow 任务流（侦察→门禁→测绘→利用→后渗透→报告→复盘），每步绑定角色/sec_*工具/参数/成功判据/Adviser 备选，并直接给出第一步。渗透任务的唯一正确入口。',
      parameters: {
        target: { type: 'string', description: '目标资产：URL / 域名 / IP' },
        goal: { type: 'string', description: '意图一句话（如 OWASP 风险评估 / 拿后台 / 演练内网横向）' },
        kind: { type: 'string', description: '类型：web(默认)/api/db/net/ai/full' },
        scope: { type: 'string', description: '授权范围描述（可选，传入 sec_scope 门禁）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { target?: string; goal?: string; kind?: string; scope?: string }) {
        try {
          if (!args.target) return '【agi_plan】需要 target（目标 URL/域名/IP）。'
          const kind = (args.kind || 'web').toLowerCase()
          if (!['web', 'api', 'db', 'net', 'ai', 'full'].includes(kind)) return `【agi_plan】kind 仅支持 web/api/db/net/ai/full，收到 ${kind}`
          const flow: Flow = {
            id: genId('F'),
            target: args.target,
            goal: args.goal || `对 ${args.target} 的渗透测试`,
            kind,
            scope: args.scope || '由 sec_scope 登记的范围（未登记则仅限离线样本）',
            createdAt: nowISO(),
            updatedAt: nowISO(),
            closed: false,
            steps: planSteps(args.target, args.goal || '', kind),
            findings: [],
          }
          saveFlow(flow)
          const byPhase = new Map<string, number>()
          flow.steps.forEach((s) => byPhase.set(s.phase, (byPhase.get(s.phase) || 0) + 1))
          const overview = PHASES.map((p) => `${p.name}:${byPhase.get(p.key) || 0}步`).join(' ')
          const first = nextAction(flow)
          return [
            `【agi_plan · 作战计划已建立】${flow.id}`,
            `目标：${flow.target} ｜ 意图：${flow.goal} ｜ 类型：${kind} ｜ 共 ${flow.steps.length} 步`,
            `结构：${overview}`,
            ``,
            nextBlock(flow, first),
          ].join('\n')
        } catch (e) { return `【agi_plan · 失败】${String(e)}` }
      },
    }),

    // ═══ 3. agi_flow — 任务流管理 ═══
    defineTool({
      name: 'agi_flow',
      description: 'PentAGI 任务流管理：list(列表)/status(查看全流程)/update(回报步骤结果 done|failed|skipped，失败自动触发 Adviser 备选)/close(结项)。agi_next 推进后必须用它回报真实结果。',
      parameters: {
        action: { type: 'string', description: 'list / status / update / close' },
        id: { type: 'string', description: 'flow id（如 F-20260826-AB12）' },
        step: { type: 'number', description: '步骤号（action=update）' },
        status: { type: 'string', description: 'done / failed / skipped（action=update）' },
        result: { type: 'string', description: '真实执行结果摘要（action=update 必填）' },
        finding: { type: 'string', description: '顺带登记一条发现（可选，action=update）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { action?: string; id?: string; step?: number; status?: string; result?: string; finding?: string }) {
        try {
          const act = args.action || 'list'
          if (act === 'list') {
            const ids = listFlowIds()
            if (!ids.length) return '【agi_flow】暂无 flow。用 agi_plan 立项。'
            return ['【agi_flow · 列表】', ...ids.map((id) => {
              const f = loadFlow(id)
              if (!f) return `◆ ${id}（读取失败）`
              const done = f.steps.filter((s) => s.status === 'done').length
              return `◆ ${f.id}${f.closed ? '[closed]' : ''} ${f.target} (${f.kind}) 进度 ${done}/${f.steps.length} 发现${f.findings.length}条`
            })].join('\n')
          }
          if (!args.id) return '【agi_flow】需要 id。'
          const flow = loadFlow(args.id)
          if (!flow) return `【agi_flow】flow ${args.id} 不存在。`
          if (act === 'status') {
            return [`【agi_flow · ${flow.id}】${flow.closed ? '(closed)' : ''} 目标:${flow.target} 类型:${flow.kind}`,
              `意图：${flow.goal}`,
              `发现(${flow.findings.length})：${flow.findings.map((f) => `\n  ⚠ ${f}`).join('') || '无'}`,
              '',
              ...flow.steps.map((s) => `${icon(s.status)} #${s.n} [${s.phase}] ${s.role} → ${s.tool} ${statusZh(s.status)}${s.attempts ? `(尝试${s.attempts})` : ''}${s.adviser ? '[Adviser]' : ''}\n   判据: ${s.criteria}${s.result ? `\n   结果: ${s.result}` : ''}`),
            ].join('\n')
          }
          if (act === 'close') {
            flow.closed = true
            saveFlow(flow)
            return `【agi_flow】${flow.id} 已结项。收尾三连：agi_reflect 复盘 → agi_memory/sec_journal 沉淀 → agi_report 出报告。`
          }
          if (act === 'update') {
            const s = flow.steps.find((x) => x.n === args.step)
            if (!s) return `【agi_flow】步骤 #${args.step} 不存在（共 ${flow.steps.length} 步）。`
            const st = (args.status || '').toLowerCase()
            if (!['done', 'failed', 'skipped'].includes(st)) return '【agi_flow】status 仅支持 done/failed/skipped。'
            s.result = args.result || ''
            if (args.finding) flow.findings.push(args.finding)
            if (st === 'done') {
              s.status = 'done'
              saveFlow(flow)
              return `【agi_flow】#${s.n} ✓ done。继续 agi_next 推进。`
            }
            if (st === 'skipped') {
              s.status = 'skipped'
              saveFlow(flow)
              return `【agi_flow】#${s.n} ⊘ skipped。继续 agi_next 推进。`
            }
            const msg = adviseOnFail(flow, args.step as number)
            return `【agi_flow】#${s.n} ✗ failed（${args.result || '无结果说明'}）\n${msg}\n继续 agi_next 取新动作。`
          }
          return `【agi_flow】未知 action=${act}（支持 list/status/update/close）`
        } catch (e) { return `【agi_flow · 失败】${String(e)}` }
      },
    }),

    // ═══ 4. agi_next — 推进器（Primary） ═══
    defineTool({
      name: 'agi_next',
      description: 'PentAGI Next-Best-Action 推进器：读 flow 当前状态 → 返回下一步该哪个角色用什么工具带什么参数（含成功判据与回报格式）。失败步已被 Adviser 自动换成备选路径。每做完一步就调它。',
      parameters: {
        id: { type: 'string', description: 'flow id' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { id?: string }) {
        try {
          if (!args.id) return '【agi_next】需要 id。'
          const flow = loadFlow(args.id)
          if (!flow) return `【agi_next】flow ${args.id} 不存在。`
          if (flow.closed) return `【agi_next】${flow.id} 已结项。`
          return nextBlock(flow, nextAction(flow))
        } catch (e) { return `【agi_next · 失败】${String(e)}` }
      },
    }),

    // ═══ 5. agi_memory — Memorist 知识库 ═══
    defineTool({
      name: 'agi_memory',
      description: 'Memorist 知识库（pgvector+Neo4j 的零依赖本地替代）：add(沉淀成功攻击路径)/search(检索历史经验)/stats/forget。同类目标开打前先 search——直接复用上次可行打法。',
      parameters: {
        action: { type: 'string', description: 'add / search / stats / forget' },
        title: { type: 'string', description: '条目标题（add）' },
        scenario: { type: 'string', description: '场景：web/db/net/ai/redteam（add）' },
        tags: { type: 'string', description: '标签，逗号分隔（add）' },
        tech: { type: 'string', description: '涉及技术栈，逗号分隔（add）' },
        cve: { type: 'string', description: '相关 CVE，逗号分隔（add）' },
        pattern: { type: 'string', description: '可复用打法/命令片段（add）' },
        chain: { type: 'string', description: '完整执行链路（add）' },
        pitfalls: { type: 'string', description: '踩坑记录（add）' },
        query: { type: 'string', description: '检索关键词（search）' },
        limit: { type: 'number', description: '返回条数上限（search，默认5）' },
        entryId: { type: 'string', description: '要删除的记忆 id（forget）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: any) {
        try {
          const act = args.action || 'stats'
          if (act === 'add') {
            if (!args.title) return '【agi_memory】add 需要 title。'
            const split = (s: string): string[] => (s || '').split(/[,，;；]+/).map((x) => x.trim()).filter(Boolean)
            const e = memAdd({
              title: args.title, scenario: args.scenario || 'general',
              tags: split(args.tags), tech: split(args.tech), cve: split(args.cve),
              pattern: args.pattern || '', chain: args.chain || '', pitfalls: args.pitfalls || '',
            })
            return `【agi_memory · 已沉淀】🧠 ${e.id}「${e.title}」— 下次同类目标 agi_memory search 即可复用`
          }
          if (act === 'search') {
            if (!args.query) return '【agi_memory】search 需要 query。'
            const hits = memSearch(String(args.query), Number(args.limit) || 5)
            hits.forEach((h) => memBumpHits(h.id))
            if (!hits.length) return `【agi_memory · 检索】「${args.query}」无命中（库共 ${memAll().length} 条）。`
            return [`【agi_memory · 命中 ${hits.length} 条】`, '',
              ...hits.map((h) => `◆ ${h.id}「${h.title}」(${h.ts.slice(0, 10)}) 场景:${h.scenario}${h.tech.length ? ' 技术:' + h.tech.join('/') : ''}${h.cve.length ? ' CVE:' + h.cve.join(',') : ''}\n   打法: ${h.pattern || '—'}\n   链路: ${h.chain || '—'}${h.pitfalls ? `\n   坑: ${h.pitfalls}` : ''}`),
            ].join('\n')
          }
          if (act === 'forget') {
            if (!args.entryId) return '【agi_memory】forget 需要 entryId。'
            const all = memAll()
            const kept = all.filter((x) => x.id !== args.entryId)
            if (kept.length === all.length) return `【agi_memory】${args.entryId} 不存在。`
            memRewrite(kept)
            return `【agi_memory】已删除 ${args.entryId}（剩 ${kept.length} 条）`
          }
          const all = memAll()
          const byScenario = new Map<string, number>()
          all.forEach((e) => byScenario.set(e.scenario, (byScenario.get(e.scenario) || 0) + 1))
          return [`【agi_memory · 库存】共 ${all.length} 条`,
            ...[...byScenario.entries()].map(([k, v]) => `  ${k}: ${v} 条`),
            all.length ? `最近：${all.slice(-3).map((e) => e.title).join(' / ')}` : '空库——首次任务完成后记得 add 沉淀。',
          ].join('\n')
        } catch (e) { return `【agi_memory · 失败】${String(e)}` }
      },
    }),

    // ═══ 6. agi_reflect — Reflector 复盘 ═══
    defineTool({
      name: 'agi_reflect',
      description: 'Reflector 自我反思：对本轮行动做结构化复盘（做了什么/有效模式/无效模式/下次改进），save=yes 时把有效模式一键写入记忆库。每个 flow 收尾必做。',
      parameters: {
        did: { type: 'string', description: '本轮做了什么（一段话）' },
        worked: { type: 'string', description: '有效的模式/工具组合' },
        failed: { type: 'string', description: '无效的模式/踩坑' },
        improve: { type: 'string', description: '下次改进点' },
        save: { type: 'string', description: 'yes = 同时写入 agi_memory' },
        scenario: { type: 'string', description: '场景分类（save=yes 时用，默认 web）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { did?: string; worked?: string; failed?: string; improve?: string; save?: string; scenario?: string }) {
        try {
          if (!args.did) return '【agi_reflect】需要 did（本轮行动概述）。'
          const review = [
            `【agi_reflect · 复盘】`,
            `行动：${args.did}`,
            `✅ 有效：${args.worked || '—'}`,
            `❌ 无效：${args.failed || '—'}`,
            `🔧 改进：${args.improve || '—'}`,
          ]
          if ((args.save || '').toLowerCase() === 'yes' && args.worked) {
            const e = memAdd({
              title: (args.improve || args.did).slice(0, 40),
              scenario: args.scenario || 'web',
              tags: ['reflect'], tech: [], cve: [],
              pattern: args.worked, chain: args.did, pitfalls: args.failed || '',
            })
            review.push(`🧠 有效模式已写入记忆库：${e.id}`)
          }
          return review.join('\n')
        } catch (e) { return `【agi_reflect · 失败】${String(e)}` }
      },
    }),

    // ═══ 7. agi_report — Reporter 报告 ═══
    defineTool({
      name: 'agi_report',
      description: 'Reporter 报告：读取 flow 全部执行记录与发现 → 生成标准渗透测试报告 Markdown（执行摘要/过程/发现明细/修复建议/附录）并落盘 reports/ 目录。',
      parameters: {
        id: { type: 'string', description: 'flow id' },
        author: { type: 'string', description: '作者署名（可选）' },
        extras: { type: 'string', description: '补充正文（自由文本，可选）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { id?: string; author?: string; extras?: string }) {
        try {
          if (!args.id) return '【agi_report】需要 id。'
          const flow = loadFlow(args.id)
          if (!flow) return `【agi_report】flow ${args.id} 不存在。`
          const date = flow.createdAt.slice(0, 10)
          const md = [
            `# 渗透测试报告 — ${flow.target}`,
            ``,
            `- **Flow**: ${flow.id}（${flow.kind} 类）`,
            `- **意图**: ${flow.goal}`,
            `- **授权依据**: ${flow.scope}`,
            `- **日期**: ${date}${args.author ? ` ｜ **作者**: ${args.author}` : ''}`,
            `- **数据来源**: PentAGI 多智能体任务流（${flow.steps.length} 步，自动记录）`,
            ``,
            `## 1. 执行摘要`,
            flow.findings.length
              ? `本次测试在 ${flow.target} 上共形成 **${flow.findings.length}** 条发现：\n${flow.findings.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
              : `本次测试未形成正式登记的发现（详见过程记录）。`,
            ``,
            `## 2. 执行过程（七阶段任务流）`,
            ``,
            `| # | 阶段 | 角色 | 工具 | 状态 | 结果 |`,
            `|---|------|------|------|------|------|`,
            ...flow.steps.map((s) => `| ${s.n} | ${s.phase} | ${s.role}${s.adviser ? '(A)' : ''} | \`${s.tool}\` | ${statusZh(s.status)} | ${(s.result || '—').replace(/\|/g, '\\|').slice(0, 120)} |`),
            ``,
            `## 3. 发现明细与修复建议`,
            flow.findings.length
              ? flow.findings.map((f, i) => `### 3.${i + 1} ${(f.split('：')[0] || f).slice(0, 60)}\n\n- 描述：${f}\n- 修复：待结合漏洞类别细化（可调 vuln_remediate 生成方案）`).join('\n\n')
              : `（无登记发现）`,
            ``,
            `## 4. 附录`,
            args.extras ? args.extras : '',
            ``,
            `> 本报告由 dsh-pentagi（PentAGI 架构移植）依据任务流自动汇编；证据引用请配合 sec_evidence 清单。`,
          ].filter((l) => l !== '').join('\n')
          const out = reportDir(config)
          mkdirSync(out, { recursive: true })
          const file = join(out, `pentagi-${flow.id}.md`)
          writeFileSync(file, md, 'utf8')
          return `【agi_report · 已生成】📄 ${file}\n\n${md.slice(0, 900)}${md.length > 900 ? '\n…（完整内容见文件）' : ''}`
        } catch (e) { return `【agi_report · 失败】${String(e)}` }
      },
    }),
  ]

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `pentagi: ${tool.name}`)
  }

  // ── 首轮锚定：首个工具调用前只露作战入口（省首轮 prefill） ──
  if (config.anchorFirstTurn) {
    ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
      const assembled = await next()
      const agent = context.agent
      if (!agent || agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call')) return assembled
      return { ...assembled, tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE) }
    })
  }

  ctx.logger?.info?.(`[${name}] pentagi brain active (${tools.length} tools, anchor=${config.anchorFirstTurn})`)
}

function icon(status: string): string {
  return status === 'done' ? '✓' : status === 'failed' ? '✗' : status === 'skipped' ? '⊘' : status === 'active' ? '▶' : '·'
}
function statusZh(status: string): string {
  return status === 'done' ? '完成' : status === 'failed' ? '失败' : status === 'skipped' ? '跳过' : status === 'active' ? '进行中' : '待执行'
}
