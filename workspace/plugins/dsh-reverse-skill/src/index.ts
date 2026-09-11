/**
 * @dsh-external/dsh-reverse-skill — reverse-skill 精髓移植（逆向 / 破解 / 攻击方法论引擎）
 *
 * 来源：https://github.com/zhaoxuya520/reverse-skill（安全任务技能路由包）
 * 本插件**不复制**它的 48 个 SKILL.md 正文，而是把它真正稀缺的四层能力搬进 DSH，
 * 直接作用于我们的破解/攻击工具链（sec_* / agi_* / vuln_*）：
 *
 *   1. 确定性路由引擎 —— routing.json（44 条 PRIMARY 规则）单一路由事实源，
 *      关键字 must / mustAll / exclude 匹配 + priority 计分裁决，移植自 master-route.ps1。
 *   2. 决策质量层（ADF R1–R51）+ 分析盲区手册（BS R52–R81）—— 置信带、
 *      validated 需 ≥2 条独立证据、负证据、阶段偏差自检、上下文污染、计划死锁重规划。
 *   3. 证据链契约（Evidence→Finding→Path）+ 可复现 hash 校验 —— 与我们的
 *      sec_evidence / sec_findings 同构，补上 reverse-skill 的 hash 固定与图审查。
 *   4. 自进化闭环 —— field-journal 经验回写 + 预加载先例 + 按需懒加载。
 *
 * 工具集（6 个，全确定性、零 token、零外部依赖、零网络）：
 *   rev_route      任务 → PRIMARY 技能 + 置信度 + 依据 + 本机工具绑定（先路由后动手）
 *   rev_playbook   48 个领域技能目录 / 读某技能的 SKILL.md / 读其 references（渐进披露）
 *   rev_doctrine   方法论：adf 决策框架 / blindspot 盲区手册 / evidence 证据契约 /
 *                  role 角色 / timeline 覆盖 / supply-chain / workflow 阶段门
 *   rev_case       案件链：init/scope/evidence/finding/path/timeline/workitem/status/review(hash 校验)
 *   rev_journal    经验库：add/search/index/precedent（脱敏回写，下次同类先检索）
 *   rev_toolindex  工具自举：bootstrap-manifest 能力 → 本机真实路径探测（不猜路径）
 *
 * 形态：toolkit。所有资源挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import {
  existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync, statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

export const name = '@dsh-external/dsh-reverse-skill'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** reverse-skill 仓库根（空 = 自动探测） */
  repoRoot: string
  /** 案件根目录（空 = $DSH_HOME/plugins/dsh-reverse-skill/cases） */
  caseRoot: string
  /** 首轮锚定：首个工具调用前只露入口工具 */
  anchorFirstTurn: boolean
}

export const Config = z.object({
  repoRoot: z.string().default(''),
  caseRoot: z.string().default(''),
  anchorFirstTurn: z.boolean().default(true),
})

const MINE = new Set([
  'rev_route', 'rev_playbook', 'rev_doctrine', 'rev_case', 'rev_journal', 'rev_toolindex',
])
const CORE = 'rev_route'

// ═══════════════════════════ 路径解析 ═══════════════════════════

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 自动探测 reverse-skill 仓库根（含 skills/config/routing.json 才算命中）。 */
export function resolveRepoRoot(configured?: string): string {
  const cands: string[] = []
  if (configured) cands.push(configured)
  if (process.env.REVERSE_SKILL_ROOT) cands.push(process.env.REVERSE_SKILL_ROOT)
  const home = dshHome()
  cands.push(join(dirname(home), 'workspace', 'reverse-skill'))
  cands.push(join(home, '..', 'workspace', 'reverse-skill'))
  cands.push(join(homedir(), 'workspace', 'reverse-skill'))
  cands.push(join(homedir(), 'reverse-skill'))
  for (const c of cands) {
    if (!c) continue
    try {
      if (existsSync(join(resolve(c), 'skills', 'config', 'routing.json'))) return resolve(c)
    } catch { /* 忽略非法路径 */ }
  }
  return ''
}

function skillsRoot(repo: string): string { return join(repo, 'skills') }

function dataRoot(): string {
  return join(dshHome(), 'plugins', 'dsh-reverse-skill')
}

function caseRootOf(config: Config): string {
  return config.caseRoot || join(dataRoot(), 'cases')
}

function journalDirOf(config: Config): string {
  return config.caseRoot ? join(config.caseRoot, '_journal') : join(dataRoot(), 'journal')
}

function nowISO(): string { return new Date().toISOString() }

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function safeRead(p: string): string {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

function listDirNames(p: string): string[] {
  try { return readdirSync(p).sort() } catch { return [] }
}

// ═══════════════════════════ 1. 路由引擎（移植 master-route.ps1） ═══════════════════════════

export interface KwRule { must?: string; mustAll?: string[]; exclude?: string; note?: string }
export interface RouteDef { label: string; skill: string; keywords: KwRule[] }
export interface RoutingCfg { meta: { fallbackId: string }; routes: Record<string, RouteDef>; priority: string[] }

export interface RuleHit { id: string; label: string; must: string; note?: string }
export interface RouteResult {
  primary: string
  label: string
  skill: string
  confidence: 'high' | 'medium' | 'low'
  scores: Record<string, number>
  ruleHits: RuleHit[]
  matchedIds: string[]
  secondary: string[]
  notes: string[]
}

/** 读取 routing.json（唯一路由事实源）。 */
export function loadRouting(repo: string): RoutingCfg | null {
  const p = join(skillsRoot(repo), 'config', 'routing.json')
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) as RoutingCfg
  } catch { return null }
}

function safeMatch(text: string, pattern: string): boolean {
  try { return new RegExp(pattern, 'i').test(text) } catch { return false }
}

/**
 * 纯路由裁决（与 master-route.ps1 语义一一对应）：
 * 逐条关键字规则命中则计入候选；同 id 多次命中累加分；
 * 按 priority 顺序取最高分者为 PRIMARY，并列时 priority 靠前者胜出；
 * 无命中回退 fallbackId。confidence: 只有一个候选路由=high，多候选=medium，回退=low。
 */
export function routeHint(cfg: RoutingCfg, hint: string): RouteResult {
  const t = (hint || '').toLowerCase()
  const scores: Record<string, number> = {}
  const ruleHits: RuleHit[] = []

  for (const id of Object.keys(cfg.routes)) {
    const route = cfg.routes[id]
    for (const kw of route.keywords || []) {
      let hit = false
      if (kw.must && safeMatch(t, kw.must)) hit = true
      if (hit && kw.mustAll) {
        for (const m of kw.mustAll) { if (!safeMatch(t, m)) { hit = false; break } }
      }
      if (hit && kw.exclude && safeMatch(t, kw.exclude)) hit = false
      if (hit) {
        scores[id] = (scores[id] || 0) + 1
        ruleHits.push({ id, label: route.label, must: kw.must || '(mustAll only)', note: kw.note })
      }
    }
  }

  const matchedIds = Object.keys(scores)
  const fallback = cfg.meta?.fallbackId || 'R0'
  let primary = ''
  let maxScore = -1
  for (const p of cfg.priority) {
    if (scores[p] !== undefined && scores[p] > maxScore) { maxScore = scores[p]; primary = p }
  }

  const notes: string[] = []
  let confidence: 'high' | 'medium' | 'low' = 'low'
  if (!primary) {
    primary = fallback
    notes.push(t ? '无强关键字命中 → 回退通用逆向入口；建议改述任务或读 routing.md 全矩阵' : 'hint 为空，请提供任务描述')
  } else {
    confidence = matchedIds.length === 1 ? 'high' : 'medium'
  }
  if (!cfg.routes[primary]) {
    notes.push(`PRIMARY '${primary}' 不在 routes 中，已回退 ${fallback}`)
    primary = fallback
    confidence = 'low'
  }

  const def = cfg.routes[primary]
  return {
    primary,
    label: def?.label || '(unknown)',
    skill: def?.skill || '',
    confidence,
    scores,
    ruleHits,
    matchedIds,
    secondary: matchedIds.filter((x) => x !== primary),
    notes,
  }
}

/** 路由 → 我们的攻击/破解工具绑定（reverse-skill 技能 × sec-workbench / pentagi 工具）。 */
const ROUTE_TOOL_MAP: Record<string, string> = {
  R0: 'sec_recon_analyze / sec_exec / sec_toolchain（拿到样本先 triage，别急着深挖）',
  R1: 'sec_toolchain(jadx/apktool) + sec_exec + sec_webscan(签名/接口面) + sec_journal',
  R2: 'sec_toolchain(frida/objection) + sec_webscan + sec_jwt(移动端 token) + sec_journal',
  R3: 'sec_webscan + sec_webtest + sec_exec(抓包/重放) + sec_jwt + sec_encode(前端算法复现)',
  R4: 'sec_exec + sec_encode + sec_knowledge(vm) + sec_journal（DSL VM opcode 还原）',
  R5: 'sec_toolchain(dnSpy/de4dot) + sec_exec + sec_weapon(载荷分析)',
  R6: 'sec_toolchain(ida/idalib-mcp) + sec_exec + sec_knowledge(re) + sec_journal',
  R7: 'sec_toolchain(r2/rabin2) + sec_exec + sec_recon_analyze',
  R8: 'sec_toolchain(binwalk) + sec_exec + sec_webscan(固件 web 面) + sec_dbsvc',
  R9: 'sec_weapon + sec_payload + sec_hashoff + sec_knowledge(malware) + sec_journal',
  R10: 'agi_plan → agi_next → agi_flow → agi_report（多阶段攻击链大脑）+ sec_* 执行',
  R11: 'sec_webscan / sec_brute / sec_crack / sec_toolchain(nmap/nuclei/sqlmap/hashcat) + agi_plan',
  R12: 'sec_webtest(BOLA/IDOR) + sec_jwt + sec_api 面(sec_webscan) + sec_findings',
  R13: 'sec_supply + sec_osint + sec_cve + sec_findings',
  R14: 'sec_ai_scan + sec_ai_test + sec_ai_llm + sec_findings',
  R15: 'sec_toolchain(bindiff) + sec_exec + sec_cve（N-day 定位）',
  R16: 'sec_cve + sec_toolchain + sec_weapon + sec_findings（补丁差分 → N-day 武器化）',
  R17: 'sec_payload + sec_weapon + sec_exec + sec_encode（pwn 链）',
  R18: 'sec_stealth + sec_payload + sec_exec + sec_knowledge（EDR 绕过逆向）',
  R19: 'sec_exec + browser 工具（自动化取证/抓包）',
  R20: 'sec_report + sec_findings（交付物）',
  R21: 'sec_exec + sec_encode + sec_knowledge(protocol)（协议帧还原）',
  R22: 'sec_toolchain(ghidra-mcp) + sec_exec',
  R23: 'sec_cloud + sec_exec + sec_lateral（云/K8s 面）',
  R24: 'sec_lateral + sec_cred + sec_brute + sec_exec（AD/Kerberos）',
  R25: 'sec_evidence + sec_exec + sec_toolchain（取证/时间线/hash 固定）',
  R26: 'sec_exec + sec_webtest + sec_findings（白盒代码审计）',
  R27: 'sec_ttpmap + sec_knowledge + sec_report（检测工程）',
  R28: 'sec_dbsvc + sec_exec + sec_webscan（工控面，被动优先）',
  R29: 'sec_crack + sec_toolchain(hashcat) + sec_exec（握手/PMKID）',
  R30: 'sec_webscan + sec_exec（扩展权限面/MV3 worker）',
  R31: 'sec_exec + sec_toolchain + sec_knowledge（Mach-O）',
  R32: 'sec_webtest + sec_exec + sec_dbsvc（厚客户端本地存储/IPC）',
  R33: 'sec_exec + sec_toolchain + sec_knowledge（Go/Rust 符号还原）',
  R34: 'sec_exec + sec_toolchain（UART/JTAG，只读提取优先）',
  R35: 'sec_dbsvc + sec_brute + sec_cred + sec_exec（库暴露与配置）',
  R36: 'sec_phish + sec_osint + sec_exec（邮件/钓鱼拆解）',
  R37: 'sec_jwt + sec_webtest + sec_findings（SAML/OIDC 错配）',
  R38: 'sec_exec + sec_toolchain（RF/SDR，默认只收）',
  R39: 'sec_report + 图表工具',
  R40: 'sec_findings + sec_evidence + rev_case(review)（证据图审查）',
  R41: 'sec_exec + sec_knowledge + agi_plan（CTF 单入口）',
  R44: 'sec_osint + sec_knowledge + sec_findings（情报关联）',
  R45: 'sec_toolchain(binaryninja) + sec_exec',
}

function renderRoute(res: RouteResult, hint: string): string {
  const L: string[] = []
  L.push(`【rev_route · PRIMARY】${res.primary} — ${res.label}`)
  L.push(`置信度：${res.confidence}　技能文件：skills/${res.skill}`)
  L.push(`依据：${res.ruleHits.filter((h) => h.id === res.primary).map((h) => h.must).join(' | ') || '(兜底路由)'}`)
  if (res.secondary.length) {
    L.push(`次选命中：${res.secondary.map((s) => `${s}(${res.scores[s]})`).join(', ')}`)
  }
  L.push('')
  L.push(`▶ 立即打开：skills/${res.skill}（用 rev_playbook module=... 读正文）`)
  L.push(`▶ 本机工具绑定：${ROUTE_TOOL_MAP[res.primary] || 'sec_* 工具链 + agi_plan 编排'}`)
  L.push(`▶ 记录：rev_case init 建案件 → rev_case evidence 落证 → rev_case finding 出结论`)
  if (res.notes.length) { L.push(''); L.push(...res.notes.map((n) => `⚠ ${n}`)) }
  L.push('')
  L.push(`原始 hint：${hint.slice(0, 200)}`)
  return L.join('\n')
}

/** 路由全表（rev_route 无 hint 时展示）。 */
function renderRouteTable(cfg: RoutingCfg): string {
  const L: string[] = ['【rev_route · 全矩阵】按 priority 顺序（44 条）', '']
  for (const id of cfg.priority) {
    const r = cfg.routes[id]
    if (!r) continue
    L.push(`${id.padEnd(4)} ${r.label}  →  skills/${r.skill}`)
  }
  L.push('')
  L.push('用法：rev_route hint="<你的任务一句话>"')
  return L.join('\n')
}

// ═══════════════════════════ 2. 技能模块（渐进披露） ═══════════════════════════

export interface ModuleInfo { module: string; label: string; hasSkill: boolean; sub: boolean }

/** 列出全部领域技能模块（目录含 SKILL.md 才算模块）。 */
export function listModules(repo: string): ModuleInfo[] {
  const root = skillsRoot(repo)
  const cfg = loadRouting(repo)
  const labelOf = new Map<string, string>()
  if (cfg) for (const id of Object.keys(cfg.routes)) {
    const r = cfg.routes[id]
    const mod = String(r.skill).replace(/\/SKILL\.md$/, '')
    if (mod) labelOf.set(mod, `${r.label} (${id})`)
  }
  const out: ModuleInfo[] = []
  for (const nm of listDirNames(root)) {
    const dir = join(root, nm)
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch { isDir = false }
    if (!isDir) continue
    if (nm === 'scripts' || nm === 'tests' || nm === 'references') continue
    const hasSkill = existsSync(join(dir, 'SKILL.md'))
    if (hasSkill) out.push({ module: nm, label: labelOf.get(nm) || nm, hasSkill, sub: false })
    // 一级子目录里另带 SKILL.md 的算独立子模块（如 reverse-engineering/dsl-vm-reverse）
    for (const sub of listDirNames(dir)) {
      if (existsSync(join(dir, sub, 'SKILL.md'))) {
        const key = `${nm}/${sub}`
        out.push({ module: key, label: labelOf.get(key) || sub, hasSkill: true, sub: true })
      }
    }
  }
  return out
}

/** 读模块的 SKILL.md 或其 references 下的单个文件。 */
export function readModule(repo: string, module: string, file?: string): { ok: boolean; text: string; rel: string } {
  const base = join(skillsRoot(repo), module)
  const rel = file ? `${module}/${file}` : `${module}/SKILL.md`
  const abs = join(skillsRoot(repo), rel)
  if (!abs.startsWith(skillsRoot(repo))) return { ok: false, text: '路径越界，已拒绝。', rel }
  if (!existsSync(abs)) {
    const refs = listDirNames(join(base, 'references'))
    return {
      ok: false,
      rel,
      text: `未找到 ${rel}。\n该模块可读文件：SKILL.md${refs.length ? `\nreferences/: ${refs.join(', ')}` : '（无 references 目录）'}`,
    }
  }
  return { ok: true, rel, text: safeRead(abs) }
}

function renderCatalog(repo: string): string {
  const mods = listModules(repo)
  const L: string[] = [`【rev_playbook · 领域技能目录】共 ${mods.length} 个模块`, '']
  const groups: Array<[string, ModuleInfo[]]> = [
    ['逆向 / 破解', mods.filter((m) => /reverse|ida|ghidra|radare|binary|dotnet|go-rust|macos|protocol|malware|firmware|hardware|js-|apk|mobile|thick/i.test(m.module + m.label))],
    ['漏洞 / 攻击', mods.filter((m) => /pentest|attack|api-security|pwn|patch-diff|edr|windows-ad|cloud|database|identity|supply|llm-security|email|wifi|radio|ot-ics|code-audit|threat/i.test(m.module + m.label))],
    ['流程 / 交付', mods.filter((m) => /case-review|docs-generator|diagram|browser-automation|ctf-sandbox/i.test(m.module + m.label))],
  ]
  const used = new Set<string>()
  for (const [g, list] of groups) {
    if (!list.length) continue
    L.push(`## ${g}`)
    for (const m of list) { used.add(m.module); L.push(`  ${m.module.padEnd(30)} ${m.label}`) }
    L.push('')
  }
  const rest = mods.filter((m) => !used.has(m.module))
  if (rest.length) {
    L.push('## 其他')
    for (const m of rest) L.push(`  ${m.module.padEnd(30)} ${m.label}`)
    L.push('')
  }
  L.push('用法：rev_playbook module="<模块名>" [file="references/xxx.md"]')
  return L.join('\n')
}

// ═══════════════════════════ 3. 方法论（ADF / BS / 证据契约） ═══════════════════════════

/** 内置提炼版方法论：不必读文件即可获得核心纪律（省 token）。 */
export const DOCTRINE: Record<string, string> = {
  adf: `【ADF 决策质量层 · 逆向/攻击通用纪律】（源自 reverse-skill analysis-decision-framework）

R1  静态结论分置信带 high/medium/low；low 必须安排动态验证后才可 validated。
R2  每个阶段（triage→static→dynamic→synthesis）收尾必须陈述假设并明确：继续 / 换路 / 停止。
R3  未经验证的异常结论必须标注 speculative，不得当事实说。
R4* validated 门槛：candidate 只需 ≥1 条证据；**promoted → validated 需 ≥2 条独立证据**
    （最好 1 静态 + 1 动态）。单条证据不得静默升级——保持 candidate 或记残余风险。
R6  查过且不存在的分支要留负证据（E-negative-evidence），否则等于没查。
R7  明确声明分析边界（scope 限制），避免把「没看」说成「没有」。
R8  可疑 ≠ 恶意：默认中性，除非用户明确要求按恶意样本处置。
R30 动态结论无静态锚点时，结论最高只能到 candidate，标注 E-runtime-only。
R31 阶段偏执自检：长时间只用一类工具 = 偏差信号，换工具或换视角。
R41 所有结论必须能映射 Finding→Evidence，否则标 ungrounded，不得交付。
R43 计划死锁：连续 3 个动作无新证据，或 2 次阶段切换无新证据 → 强制重规划，不要空转。
R44 单一来源高置信是过度信任偏差：跨源交叉验证后再 validated。
R50 多模块耦合的结论要拆成独立工作项再验证。
R51 对抗强度评估：目标是「抗分析对抗」时，先判保护档位再决定静态还是动态为主。`,

  blindspot: `【BS 分析盲区手册】（源自 reverse-skill analysis-blindspot-cookbook）

语言识别（先判语言再选工具，别用 C 的直觉读一切二进制）：
  R52 Rust    _ZN mangling / core:: / panic-unwrap 边 → 用 Rust 符号学
  R53 Golang  runtime.* / go.string.* / newobject → GoReSym 类符号还原，别信类 C 反编译
  R54 C++     标 vtable、解 RTTI、xref 虚函数
  R55 ObjC/Swift  class-dump、objc 运行时
  R56 .NET Native AOT  原生入口且无 _CorExeMain → 别硬套 dnSpy IL 流程

加固/混淆分档（不许越级吹结论）：
  R57 自定义字符串加密  高熵 rdata 无标准解码器 → 熵分析→算法常量→动态解密 dump
  R58 VMP/虚拟化  Tier A 定性+动态；Tier B 实验性 tracer。**不得无证据宣称完整静态脱壳**
  R59 OLLVM 分 P0/P1/P2，P2 直接转动态
  R60 组合混淆  先去平坦化再解谓词，顺序反了白干

注入/代理链（检测向，不做绕过教程）：
  R62 代理 DLL  导出重叠系统 DLL、加载真 DLL、缺转发器
  R63 进程镂空 SUSPENDED+unmap+WPM+resume 特征
  R67 SEH+VEH 双异常链 + 触发故障
  R68 BYOVD  签名驱动 + 漏洞哈希库 + IOCTL

格式/载体：R73 OLE(oleid/olevba/XLM/DDE)　R74 PDF(/JS /OpenAction /Launch)　R75 WASM　R77 ELF(LD_PRELOAD/ptrace/proc)

Agent 自身盲区（**最容易犯**）：
  R78 LLM 幻觉  API/CFG 断言拿不出偏移或工具输出 → 直接判 ungrounded
  R80 上下文污染  与已确认证据/时间线矛盾，或复用已被否的假设 → 重读 timeline+证据，丢弃被污染的摘要
  R81 锚点核验  P2 级想法必须回到 R41 与 case-review 校验`,

  evidence: `【Evidence → Finding → Path 证据契约】（与 sec_evidence / sec_findings 同构）

Evidence（不可变观察，一条一段，落 evidence/E-NNN.md）：
  title / observed_at / source_type(command|screenshot|file|log|memory|network|manual) /
  source_ref / content_hash(文件类必填 sha256) / artifact_path(相对案件根) /
  repro_command(第三方可跑，或标注离线限制) / raw_excerpt(脱敏) / linked_workitem

Finding（结论，落 findings.md）：
  title / severity(critical|high|medium|low|info|n/a_re) /
  category(vuln|misconfig|design|reverse_algo|bypass|other) /
  status(candidate|validated|false_positive|accepted_risk) / evidence_ids[] /
  location(file:line|addr|url|class.method) / impact / confidence / repro_steps / remediation / attack_id

Path（路径，落 paths.md）：path_type(attack|callflow|solve) / start / goal /
  steps[](每步关联 evidence + finding) / residual_risks

硬规则：
  · Finding 必须引用 ≥1 条 Evidence，否则不许登记。
  · status=validated 需 ≥2 条独立证据（R4*），且 confidence 不得为 low。
  · 攻击路径若声称「已拿权限/数据」，必须挂 validated 证据。
  · 先 rev_case review 做 hash + 引用完整性校验，再交付。`,

  role: `【角色编排】（源自 reverse-skill role-map / PentAGI，与 agi_team 对齐）

lead        单一路由负责人：定 PRIMARY、控节奏、做最终裁决（对应 Primary）
specialist  按路由挂专才：RE / web / pwn / 云 / 身份 / 取证 …（对应 Pentester）
adversary   Devil's Advocate：专门反驳结论、找更简单解释（对应 sec_findings 误报三问）
scribe      证据与时间线维护：Evidence 落地、hash 固定、workitem 覆盖（对应 sec_evidence）

纪律：一次任务只有一个 lead；adversary 与 specialist 必须分离（同一个人不能既提结论又否结论）。`,

  timeline: `【时间线与覆盖】（源自 reverse-skill timeline-workitem）

· 每一步动作落 timeline.md（时间 / 动作 / 工具 / 结果 / 证据 id）
· 每个假设开一个 WI-NNN 工作项，状态 open → probing → confirmed|rejected
· 覆盖率自检：所有 WI 要么 confirmed 要么 rejected 且有负证据，**不许留着 open 就收工**
· 计划死锁（ADF R43）时先读 timeline 找「哪一步没产生新证据」`,

  'supply-chain': `【技能/MCP 供应链门闩】（源自 reverse-skill skill-supply-chain）

引入外部技能、MCP、脚本前必须过：
  1) 来源可溯源（官方仓库 + 固定 commit/tag + 校验值）
  2) 不盲装：先读清单与安装脚本，确认它到底执行什么
  3) 权限最小化：不要求超出任务所需的凭据/网络/文件写权限
  4) 固定版本：禁止 latest / 浮动分支作为长期依赖
  5) 本地可复核：脚本落盘可审，不做管道直执行（curl | sh 之类）
  6) 记录进 rev_journal，注明来源与版本`,

  workflow: `【RE 阶段门闩】（源自 re-agent-workflow）

triage → static → dynamic → synthesis，四阶段顺序推进，每阶段结束做 R2 假设裁决。

triage   文件类型/架构/壳/语言/熵/字符串/导入表 —— 决定后续路线（先捡漏：strings / rabin2 -z / ltrace）
static   反编译、CFG、数据流、交叉引用；得出置信带（R1），low 必须转动态
dynamic  Frida/调试器/沙箱/插桩；无静态锚点则结论 ≤ candidate（R30）
synthesis 汇总裁决：Finding 升级（R4*/R41/R44）→ Path 串链 → report → journal 回写

可行性门：目标不可达/样本不可运行 → 记录证据并降级结论，不许脑补。`,

  ops: `【作战契约索引】（reverse-skill ops/ 全集，可用 file 参数读全文）
  evidence-finding-path.md      证据链字段契约（本插件 rev_case 已原生支持）
  role-map.md                   角色 → 技能映射
  timeline-workitem.md          时间线与覆盖
  scope-contract.md             案件范围契约
  analysis-decision-framework.md  ADF R1-R51 全文
  analysis-blindspot-cookbook.md  BS R52-R81 全文
  skill-supply-chain.md         外部技能/MCP 门闩
  sandbox-profile.md            工具对照
  IDENTITY.md                   身份边界

用法：rev_doctrine topic=<adf|blindspot|evidence|role|timeline|supply-chain|workflow|ops> [file]
读取仓库内 ops 全文：rev_doctrine topic=ops file=analysis-decision-framework.md`,
}

function renderDoctrine(topic: string, file?: string): string {
  if (topic === 'ops' && file) return '' // 由调用方读文件
  const key = topic || 'adf'
  const text = DOCTRINE[key]
  if (!text) {
    return `未知方法论主题「${topic}」。可用：${Object.keys(DOCTRINE).join(' / ')}\n（也可 rev_doctrine topic=ops file=<doc>.md 读仓库全文）`
  }
  return text
}

// ═══════════════════════════ 4. 案件链（Evidence→Finding→Path） ═══════════════════════════

function caseDir(config: Config, caseName: string): string {
  return join(caseRootOf(config), caseName)
}

function ensureCase(config: Config, caseName: string): string {
  const dir = caseDir(config, caseName)
  mkdirSync(join(dir, 'evidence'), { recursive: true })
  return dir
}

function listCaseNames(config: Config): string[] {
  const root = caseRootOf(config)
  try {
    return readdirSync(root).filter((n) => {
      try { return statSync(join(root, n)).isDirectory() && existsSync(join(root, n, 'scope.md')) } catch { return false }
    }).sort()
  } catch { return [] }
}

function nextSeq(dir: string, prefix: string, ext = '.md'): number {
  let max = 0
  for (const f of listDirNames(dir)) {
    const m = f.match(new RegExp(`^${prefix}-(\\d+)${ext.replace('.', '\\.')}$`))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

function pad3(n: number): string { return String(n).padStart(3, '0') }

export interface CaseArgs {
  action: string
  case?: string
  title?: string
  target?: string
  intent?: string
  scope?: string
  id?: string
  severity?: string
  category?: string
  status?: string
  evidenceIds?: string
  location?: string
  impact?: string
  confidence?: string
  remediation?: string
  reproCommand?: string
  sourceType?: string
  sourceRef?: string
  artifactPath?: string
  rawExcerpt?: string
  workitem?: string
  pathType?: string
  start?: string
  goal?: string
  steps?: string
  residualRisks?: string
  note?: string
}

function isInside(root: string, p: string): boolean {
  const a = resolve(root).toLowerCase()
  const b = resolve(p).toLowerCase()
  return b === a || b.startsWith(a.endsWith('\\') || a.endsWith('/') ? a : a + (process.platform === 'win32' ? '\\' : '/'))
}

export function caseAction(config: Config, a: CaseArgs): string {
  const act = (a.action || 'status').toLowerCase()
  const repo = resolveRepoRoot(config.repoRoot)

  if (act === 'list') {
    const names = listCaseNames(config)
    if (!names.length) return `【rev_case】暂无案件（根目录：${caseRootOf(config)}）`
    return ['【rev_case · 案件列表】', ...names.map((n) => `  ${n}`), '', `根目录：${caseRootOf(config)}`].join('\n')
  }

  if (act === 'init') {
    if (!a.case) return '【rev_case】init 需要 case（案件名）。'
    const dir = ensureCase(config, a.case)
    const scopeFile = join(dir, 'scope.md')
    if (existsSync(scopeFile)) return `【rev_case】案件 ${a.case} 已存在：${dir}`
    const md = [
      `# Scope — ${a.case}`,
      '',
      `- created: ${nowISO()}`,
      `- target: ${a.target || '(待填)'}`,
      `- intent: ${a.intent || '(待填)'}`,
      `- scope: ${a.scope || '(待填)'}`,
      `- case_root: ${dir}`,
      '',
      '## 工作项（WI）',
      '',
      '| WI | 假设 | 状态 | 证据 |',
      '|----|------|------|------|',
      '| WI-001 | (首个待验证假设) | open | — |',
      '',
      '## 阶段',
      '',
      'triage → static → dynamic → synthesis',
    ].join('\n')
    writeFileSync(scopeFile, md, 'utf8')
    writeFileSync(join(dir, 'timeline.md'), `# Timeline — ${a.case}\n\n| 时间 | 动作 | 工具 | 结果 | 证据 |\n|------|------|------|------|------|\n`, 'utf8')
    writeFileSync(join(dir, 'findings.md'), `# Findings — ${a.case}\n\n`, 'utf8')
    writeFileSync(join(dir, 'paths.md'), `# Paths — ${a.case}\n\n`, 'utf8')
    return `【rev_case · 已建案件】📁 ${dir}\n\n下一步：rev_case action=evidence case=${a.case} title=... reproCommand=...`
  }

  const cname = a.case
  if (!cname) return `【rev_case】action=${act} 需要 case。`
  const dir = caseDir(config, cname)
  if (!existsSync(dir)) return `【rev_case】案件 ${cname} 不存在（先 action=init）。可用：${listCaseNames(config).join(', ') || '(无)'}`

  if (act === 'evidence') {
    const n = nextSeq(join(dir, 'evidence'), 'E')
    const id = a.id || `E-${pad3(n)}`
    let hash = 'n/a'
    let artifact = 'n/a'
    if (a.artifactPath) {
      const abs = isAbsolute(a.artifactPath) ? a.artifactPath : join(dir, a.artifactPath)
      if (!isInside(dir, abs)) return '【rev_case】artifactPath 越界，已拒绝。'
      if (existsSync(abs) && statSync(abs).isFile()) {
        hash = sha256File(abs)
        artifact = a.artifactPath
      } else {
        hash = 'n/a (文件不存在)'
      }
    }
    const md = [
      `### ${id}`,
      `- title: ${a.title || '(未填)'}`,
      `- observed_at: ${nowISO()}`,
      `- source_type: ${a.sourceType || 'manual'}`,
      `- source_ref: ${a.sourceRef || 'n/a'}`,
      `- content_hash: ${hash}`,
      `- artifact_path: ${artifact}`,
      `- repro_command: |`,
      `    ${(a.reproCommand || 'n/a').replace(/\n/g, '\n    ')}`,
      `- raw_excerpt: |`,
      `    ${(a.rawExcerpt || 'n/a').replace(/\n/g, '\n    ')}`,
      `- linked_workitem: ${a.workitem || 'n/a'}`,
      `- supersedes: none`,
      '',
    ].join('\n')
    writeFileSync(join(dir, 'evidence', `${id}.md`), md, 'utf8')
    appendFileSync(join(dir, 'timeline.md'), `| ${nowISO()} | evidence ${id} | rev_case | ${(a.title || '').slice(0, 60)} | ${id} |\n`, 'utf8')
    const h = hash.startsWith('n/a') ? '' : `　hash=${hash.slice(0, 16)}…`
    return `【rev_case · 证据已落】${id}　${a.title || ''}${h}\n📄 ${join(dir, 'evidence', `${id}.md`)}`
  }

  if (act === 'finding') {
    if (!a.evidenceIds) return '【rev_case】finding 必须给 evidenceIds（≥1 条），无证据不得登记结论。'
    const ids = a.evidenceIds.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
    const missing = ids.filter((id) => !existsSync(join(dir, 'evidence', `${id}.md`)))
    if (missing.length) return `【rev_case】拒绝登记：以下证据不存在 → ${missing.join(', ')}（先 action=evidence 落地）`
    const conf = a.confidence || 'medium'
    const st = a.status || 'candidate'
    if (st === 'validated' && ids.length < 2) {
      return `【rev_case】拒绝升级 validated（ADF R4*）：需 ≥2 条独立证据，当前 ${ids.length} 条。\n保持 status=candidate，或补第二条独立证据（建议 1 静态 + 1 动态）。`
    }
    if (st === 'validated' && conf === 'low') {
      return '【rev_case】拒绝：status=validated 时 confidence 不得为 low（先提高置信或记残余风险）。'
    }
    const n = nextSeq(dir, 'F')
    const md = [
      `### F-${pad3(n)}`,
      `- title: ${a.title || '(未填)'}`,
      `- severity: ${a.severity || 'info'}`,
      `- category: ${a.category || 'other'}`,
      `- status: ${st}`,
      `- evidence_ids: [${ids.join(', ')}]`,
      `- location: ${a.location || 'n/a'}`,
      `- impact: ${a.impact || 'n/a'}`,
      `- confidence: ${conf}`,
      `- repro_steps:`,
      `  1. ${(a.reproCommand || 'n/a').slice(0, 200)}`,
      `- remediation: ${a.remediation || 'n/a'}`,
      `- optional_attack: `,
      '',
    ].join('\n')
    appendFileSync(join(dir, 'findings.md'), md + '\n', 'utf8')
    return `【rev_case · 结论已登记】F-${pad3(n)}「${a.title || ''}」status=${st} evidence=[${ids.join(', ')}]\n📄 ${join(dir, 'findings.md')}`
  }

  if (act === 'path') {
    if (!a.steps) return '【rev_case】path 需要 steps（每行一步，可用 ; 或换行分隔）。'
    const n = nextSeq(dir, 'P')
    const steps = a.steps.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)
    const md = [
      `### P-${pad3(n)}`,
      `- title: ${a.title || '(未填)'}`,
      `- path_type: ${a.pathType || 'attack'}`,
      `- start: ${a.start || 'n/a'}`,
      `- goal: ${a.goal || 'n/a'}`,
      `- steps:`,
      ...steps.map((s, i) => `  ${i + 1}. ${s}`),
      `- residual_risks: ${a.residualRisks || 'n/a'}`,
      '',
    ].join('\n')
    appendFileSync(join(dir, 'paths.md'), md + '\n', 'utf8')
    return `【rev_case · 路径已登记】P-${pad3(n)}（${steps.length} 步）\n📄 ${join(dir, 'paths.md')}`
  }

  if (act === 'timeline' || act === 'workitem') {
    if (!a.note) return `【rev_case】${act} 需要 note。`
    const line = act === 'timeline'
      ? `| ${nowISO()} | ${a.note} | - | - | ${a.workitem || '-'} |\n`
      : `| ${a.id || 'WI-?'} | ${a.note} | ${a.status || 'open'} | ${a.evidenceIds || '-'} |\n`
    appendFileSync(join(dir, act === 'timeline' ? 'timeline.md' : 'scope.md'), line, 'utf8')
    return `【rev_case】已追加到 ${act === 'timeline' ? 'timeline.md' : 'scope.md'}：${a.note}`
  }

  if (act === 'status') {
    const ev = listDirNames(join(dir, 'evidence')).filter((f) => f.endsWith('.md'))
    const findings = safeRead(join(dir, 'findings.md'))
    const fCount = (findings.match(/^### F-/gm) || []).length
    const validated = (findings.match(/status: validated/g) || []).length
    const tl = safeRead(join(dir, 'timeline.md')).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 时间') && !l.startsWith('|----')).length
    return [
      `【rev_case · ${cname}】`,
      `  证据：${ev.length} 条　结论：${fCount} 条（validated ${validated}）　时间线：${tl} 条`,
      `  目录：${dir}`,
      '',
      '下一步：rev_case action=review 做 hash + 引用完整性校验',
    ].join('\n')
  }

  if (act === 'review') {
    const problems: string[] = []
    // 1) 证据引用完整性
    const findings = safeRead(join(dir, 'findings.md'))
    const blocks = findings.split(/^### /m).slice(1)
    let fIdx = 0
    for (const b of blocks) {
      fIdx++
      const evLine = (b.match(/- evidence_ids: \[(.*?)\]/) || [])[1] || ''
      const ids = evLine.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      if (!ids.length) problems.push(`F#${fIdx} 未引用任何证据（违反 MUST）`)
      for (const id of ids) {
        if (!existsSync(join(dir, 'evidence', `${id}.md`))) problems.push(`F#${fIdx} 引用的 ${id} 不存在`)
      }
      const st = (b.match(/- status: (\S+)/) || [])[1]
      if (st === 'validated' && ids.length < 2) problems.push(`F#${fIdx} status=validated 但只有 ${ids.length} 条证据（ADF R4* 需 ≥2）`)
    }
    // 2) artifact hash 校验
    let checked = 0
    const evFiles = listDirNames(join(dir, 'evidence')).filter((f) => f.endsWith('.md'))
    for (const f of evFiles) {
      const txt = safeRead(join(dir, 'evidence', f))
      const ap = (txt.match(/- artifact_path: (.+)/) || [])[1]?.trim()
      const ch = (txt.match(/- content_hash: (.+)/) || [])[1]?.trim()
      if (!ap || ap === 'n/a' || !ch || ch.startsWith('n/a')) continue
      const abs = isAbsolute(ap) ? ap : join(dir, ap)
      if (!existsSync(abs)) { problems.push(`${f} 记录的 artifact 不存在：${ap}`); continue }
      const actual = sha256File(abs)
      checked++
      if (actual !== ch) problems.push(`${f} hash 不匹配：记录 ${ch.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`)
    }
    // 3) 未闭合工作项
    const scope = safeRead(join(dir, 'scope.md'))
    const open = (scope.match(/\| WI-\d+ \|.*?\| open \|/g) || []).length
    if (open) problems.push(`${open} 个工作项仍为 open（覆盖率未闭合，ADF 要求确认或带负证据否决）`)

    const head = `【rev_case · review】${cname}　证据 ${evFiles.length} 条　hash 校验 ${checked} 个`
    if (!problems.length) return `${head}\n✅ 通过：证据引用完整、hash 一致、工作项已闭合。`
    return [head, `❌ 发现 ${problems.length} 个问题：`, ...problems.map((p) => `  · ${p}`)].join('\n')
  }

  return `【rev_case】未知 action「${act}」。可用：list/init/evidence/finding/path/timeline/workitem/status/review`
}

// ═══════════════════════════ 5. 经验库（field-journal 自进化） ═══════════════════════════

interface JEntry { file: string; title: string; text: string }

function journalEntries(config: Config): JEntry[] {
  const dir = journalDirOf(config)
  const out: JEntry[] = []
  for (const f of listDirNames(dir)) {
    if (!f.endsWith('.md')) continue
    const text = safeRead(join(dir, f))
    const title = (text.match(/^#\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, '')
    out.push({ file: f, title, text })
  }
  return out
}

export function journalAction(config: Config, action: string, args: Record<string, string | undefined>): string {
  const dir = journalDirOf(config)
  const act = (action || 'index').toLowerCase()

  if (act === 'add') {
    const title = args.title
    if (!title) return '【rev_journal】add 需要 title。'
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60)
    const file = `${stamp}_${safe}.md`
    const md = [
      `# ${title}`,
      ``,
      `- date: ${stamp}`,
      `- route: ${args.route || 'n/a'}`,
      `- tags: ${args.tags || ''}`,
      ``,
      `## 场景`,
      args.scenario || 'n/a',
      ``,
      `## 有效链路`,
      args.chain || 'n/a',
      ``,
      `## 关键证据（≤3 条，脱敏）`,
      args.evidence || 'n/a',
      ``,
      `## 踩坑 / 无效路径`,
      args.pitfalls || 'n/a',
      ``,
      `## 可复用模式（一句话）`,
      args.pattern || 'n/a',
      ``,
    ].join('\n')
    writeFileSync(join(dir, file), md, 'utf8')
    return `【rev_journal · 已回写】🧠 ${file}\n下次同类任务先 rev_journal action=search query=...`
  }

  if (act === 'search') {
    const q = (args.query || '').toLowerCase()
    if (!q) return '【rev_journal】search 需要 query。'
    const words = q.split(/[\s,，;；]+/).filter(Boolean)
    const scored = journalEntries(config).map((e) => {
      const low = (e.title + '\n' + e.text).toLowerCase()
      let score = 0
      for (const w of words) if (low.includes(w)) score += 1
      if (low.includes(q)) score += 2
      return { e, score }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
    if (!scored.length) return `【rev_journal】「${args.query}」无命中（库共 ${journalEntries(config).length} 条）。`
    const L = [`【rev_journal · 命中 ${scored.length} 条】`, '']
    for (const { e, score } of scored.slice(0, Number(args.limit) || 5)) {
      const pattern = (e.text.match(/## 可复用模式（一句话）\n([\s\S]*?)(\n##|$)/) || [])[1]?.trim() || '—'
      L.push(`◆ ${e.title}（score=${score}）`)
      L.push(`   模式：${pattern.slice(0, 200)}`)
      L.push(`   文件：${e.file}`)
    }
    return L.join('\n')
  }

  if (act === 'index' || act === 'precedent') {
    const es = journalEntries(config)
    if (!es.length) return `【rev_journal】空库（${dir}）。任务完成后 rev_journal action=add 沉淀经验。`
    return ['【rev_journal · 索引】共 ' + es.length + ' 条', ...es.map((e) => `  ${e.title}  (${e.file})`), '', `目录：${dir}`].join('\n')
  }

  return `【rev_journal】未知 action「${act}」。可用：add/search/index`
}

/** 懒加载先例：任务开始前查库（供 rev_route 自动附带）。 */
export function journalPrelude(config: Config, hint: string): string {
  const q = (hint || '').toLowerCase()
  if (!q) return ''
  const words = q.split(/[\s,，;；]+/).filter((w) => w.length >= 2)
  const es = journalEntries(config)
  const hits = es.filter((e) => {
    const low = (e.title + '\n' + e.text).toLowerCase()
    return words.some((w) => low.includes(w))
  }).slice(0, 3)
  if (!hits.length) return ''
  return ['', `🧠 经验库先例命中 ${hits.length} 条（先复用，别重造轮子）：`, ...hits.map((h) => `  · ${h.title}`)].join('\n')
}

// ═══════════════════════════ 6. 工具自举（不猜路径） ═══════════════════════════

interface Capability {
  name: string
  bootstrapKind?: string
  docsUrl?: string
  canAutoInstall?: boolean
  verifyCommand?: string
  manualInstallHint?: string
  installDir?: string
  pinnedVersion?: string
  pipPackage?: string
  /** MCP server 名：注册型能力（remote-http-mcp / local-http-mcp）以它判定是否已登记到客户端 */
  mcpNames?: string[]
  /** 本地 MCP 服务的监听端口：以端口是否在监听判定服务型能力 */
  servicePort?: number
}

let cachedRegPath: string | null = null

/**
 * 注册表里的当前用户 PATH。
 * DSH 服务进程持有的是它启动时的环境块，装机时新写进用户 PATH 的目录对运行中的
 * 服务不可见 —— 只读 process.env.PATH 会把刚装好的工具一律报成「缺」。
 * 读不到注册表时静默退化为空串，不影响原有 PATH 探测。
 */
function windowsUserPath(): string {
  if (process.platform !== 'win32') return ''
  if (cachedRegPath !== null) return cachedRegPath
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    })
    const m = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
    cachedRegPath = m ? expandVars(m[1].trim()) : ''
  } catch { cachedRegPath = '' }
  return cachedRegPath
}

/** 在 PATH 中查找可执行文件（不 spawn 进程，纯 fs，快且无副作用）。 */
export function whichSync(cmd: string, extraDirs: string[] = []): string | null {
  const win = process.platform === 'win32'
  const exts = win
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  const regPath = windowsUserPath()
  const dirs = [
    ...(process.env.PATH || '').split(win ? ';' : ':'),
    ...(regPath ? regPath.split(';') : []),
    ...extraDirs,
    // 工具包常把可执行文件放在 installDir 的子目录下，只查根目录会漏判：
    //   bin/     —— jadx、radare2 等多数 CLI
    //   support/ —— Ghidra 的 analyzeHeadless
    ...extraDirs.map((d) => join(d, 'bin')),
    ...extraDirs.map((d) => join(d, 'support')),
  ].filter(Boolean)
  const hasExt = /\.[a-z0-9]+$/i.test(cmd)
  for (const d of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const p = join(d, cmd + ext)
      try { if (existsSync(p) && statSync(p).isFile()) return p } catch { /* 跳过非法项 */ }
    }
  }
  return null
}

/**
 * 本地 MCP 服务型能力（local-http-mcp）以端口是否在监听为准，例如 Burp 的
 * MCP 扩展监听 9876。netstat 是同步且毫秒级的，适合放在这条探测路径上。
 */
function serviceListening(port: number): boolean {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out)
  } catch { return false }
}

/**
 * 注册型能力（remote-http-mcp / local-http-mcp）没有本地可执行文件，
 * 以 MCP 客户端配置里是否登记为准 —— Claude Code 的 ~/.claude/mcp.json、
 * Codex 的 ~/.codex/config.toml。命中返回「配置文件#server 名」，否则 null。
 */
function mcpRegistered(names: string[] | undefined): string | null {
  if (!names || !names.length) return null
  const home = homedir()
  const files = [
    join(home, '.claude', 'mcp.json'),
    join(home, '.codex', 'config.toml'),
  ]
  for (const f of files) {
    try {
      if (!existsSync(f)) continue
      const txt = readFileSync(f, 'utf8')
      const hit = names.find((n) => txt.includes(n))
      if (hit) return `${f}#${hit}`
    } catch { /* 配置不可读就跳过 */ }
  }
  return null
}

function expandVars(p: string): string {
  return p
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || homedir())
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/\$HOME/g, homedir())
}

export function loadManifest(repo: string): Capability[] {
  const p = join(skillsRoot(repo), 'scripts', 'bootstrap-manifest.json')
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as { capabilities?: Capability[] }
    return j.capabilities || []
  } catch { return [] }
}

export interface ToolRow { name: string; found: string | null; auto: boolean; hint: string }

export function scanTools(repo: string, want?: string): ToolRow[] {
  const caps = loadManifest(repo)
  const rows: ToolRow[] = []
  for (const c of caps) {
    if (want && !c.name.toLowerCase().includes(want.toLowerCase())) continue
    const extra: string[] = []
    if (c.installDir) extra.push(expandVars(c.installDir))
    const cmd = c.verifyCommand || c.name
    let found = whichSync(cmd, extra)
    // 没有独立可执行文件的能力（词表/数据集，如 SecLists）退化为目录存在性检查。
    if (!found && !c.verifyCommand) {
      const dirHit = extra.find((d) => {
        try { return existsSync(d) && statSync(d).isDirectory() } catch { return false }
      })
      if (dirHit) found = dirHit
    }
    // 注册型能力（MCP server，如 xquik 远程服务）：以客户端配置里是否登记为准。
    if (!found && c.mcpNames?.length) {
      const reg = mcpRegistered(c.mcpNames)
      if (reg) found = reg
    }
    // 本地服务型能力（local-http-mcp，如 Burp MCP 扩展）：以端口是否在监听为准。
    if (!found && typeof c.servicePort === 'number' && serviceListening(c.servicePort)) {
      found = `127.0.0.1:${c.servicePort} LISTENING`
    }
    rows.push({
      name: c.name,
      found,
      auto: !!c.canAutoInstall,
      hint: found ? '' : (c.manualInstallHint || `${c.bootstrapKind || 'manual'}${c.docsUrl ? ` — ${c.docsUrl}` : ''}`),
    })
  }
  return rows
}

function renderToolIndex(repo: string, want?: string): string {
  const rows = scanTools(repo, want)
  if (!rows.length) return `【rev_toolindex】无匹配能力（仓库清单缺失或 want「${want}」无命中）。\n仓库：${repo || '(未探测到 reverse-skill)'}`
  const have = rows.filter((r) => r.found)
  const miss = rows.filter((r) => !r.found)
  const L = [`【rev_toolindex】能力 ${rows.length} 项：已装 ${have.length} / 缺 ${miss.length}`, '']
  L.push('## 已就绪（真实路径，直接用）')
  if (!have.length) L.push('  (无)')
  for (const r of have) L.push(`  ✓ ${r.name.padEnd(18)} ${r.found}`)
  L.push('')
  L.push('## 缺失（不要猜路径，按提示装）')
  if (!miss.length) L.push('  (无)')
  for (const r of miss) L.push(`  ✗ ${r.name.padEnd(18)} ${r.auto ? '[可自动]' : '[手动]'} ${r.hint.slice(0, 140)}`)
  L.push('')
  L.push('自举脚本：skills/scripts/bootstrap-reverse.ps1（Windows）/ bootstrap-reverse.sh（Unix）——仅清单内能力，禁止假装可自举。')
  return L.join('\n')
}

// ═══════════════════════════ 系统提示方法层 ═══════════════════════════

const METHOD_SECTION = `# 逆向 / 破解 / 攻击方法论（reverse-skill 精髓，已移植）

1. **先路由后动手**：拿到破解/逆向/渗透任务，先用 \`rev_route\` 定 PRIMARY 技能（44 条规则，单一路由事实源），
   别凭感觉直接开工具。路由产物给的是「该用什么方法论」，工具仍用我们的 sec_*/agi_*。
2. **置信带纪律（ADF R1）**：静态反编译结论必须标 high/medium/low；low 必须安排动态验证才可升 validated。
3. **证据链闭环（Evidence→Finding→Path）**：关键观察用 \`rev_case action=evidence\` 落地（含 repro_command /
   content_hash / artifact_path）；结论走 \`rev_case action=finding\`。**没有证据 ID 的结论不许登记**。
4. **validated 门槛（ADF R4*）**：candidate 只需 1 条证据；升 validated 需 **≥2 条独立证据**（最好 1 静态 + 1 动态）。
   单条证据不得静默升级——保持 candidate 或记残余风险。
5. **负证据与边界（ADF R6/R7）**：查过且不存在要留负证据；明确声明分析边界，别把「没看」说成「没有」。
6. **反偏差自检**：阶段偏执（只用一类工具，R31）、单一来源高置信（R44）、
   **上下文污染**（与已确认证据矛盾或复用已被否的假设，R80）——发现即回读 timeline 与证据，丢弃被污染的摘要。
7. **不许幻觉（R78）**：声称某 API/控制流/偏移却拿不出工具输出 → 直接判 ungrounded，不得交付。
8. **计划死锁即重规划（R43）**：连续 3 个动作无新证据，或 2 次阶段切换无新证据 → 换路，不要空转。
9. **阶段门闩**：triage → static → dynamic → synthesis，每阶段收尾用 R2 陈述假设并明确继续/换路/停止。
10. **工具不猜路径**：需要 jadx/frida/ida/ghidra/r2/hashcat 等外部工具时，先 \`rev_toolindex\` 探测本机真实路径；
    缺什么按清单装什么，禁止假设路径存在。
11. **经验自进化**：任务收尾用 \`rev_journal action=add\` 脱敏回写（有效链路/踩坑/可复用模式），
    下次同类任务先 \`rev_journal action=search\` 检索复用。
12. **决策边界才给菜单**：只有存在两个以上实质不同、有证据支撑的分支时才给 3-6 个编号选项；
    若下一步由证据唯一决定，直接继续做，不要为凑菜单重复输出已知上下文。
13. **交付前自检**：\`rev_case action=review\` 做证据引用完整性 + artifact hash 校验 + 工作项闭合检查，通过再交付。`

// ═══════════════════════════ 插件入口 ═══════════════════════════

export function apply(ctx: Context, config: Config): void {
  // ── 方法论注入系统提示 ──
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'reverse-skill:doctrine:v1',
    order: 91,
    text: METHOD_SECTION,
  }), 'reverse-skill: doctrine section')

  const repoOf = (): string => resolveRepoRoot(config.repoRoot)

  const tools = [
    // ═══ 1. rev_route ═══
    defineTool({
      name: 'rev_route',
      description: 'reverse-skill 确定性路由：任务一句话 → PRIMARY 技能 + 置信度 + 命中依据 + 本机 sec_*/agi_* 工具绑定。破解/逆向/渗透任务的第一步，先路由后动手。不带 hint 时输出 44 条全矩阵。',
      parameters: {
        hint: { type: 'string', description: '任务描述（越具体越准，如「js 前端签名逆向 + 加密参数还原」）' },
        preload: { type: 'string', description: 'yes = 自动附带经验库先例（默认 yes）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { hint?: string; preload?: string }) {
        try {
          const repo = repoOf()
          if (!repo) return '【rev_route】未找到 reverse-skill 仓库。请设置配置项 repoRoot 或环境变量 REVERSE_SKILL_ROOT。'
          const cfg = loadRouting(repo)
          if (!cfg) return `【rev_route】routing.json 缺失或非法：${join(skillsRoot(repo), 'config', 'routing.json')}`
          const hint = (args.hint || '').trim()
          if (!hint) return renderRouteTable(cfg)
          const res = routeHint(cfg, hint)
          let out = renderRoute(res, hint)
          if ((args.preload || 'yes').toLowerCase() !== 'no') out += journalPrelude(config, hint)
          return out
        } catch (e) { return `【rev_route · 失败】${String(e)}` }
      },
    }),

    // ═══ 2. rev_playbook ═══
    defineTool({
      name: 'rev_playbook',
      description: '读取 reverse-skill 的 48 个领域技能：不带 module 列出目录；带 module 读该技能的 SKILL.md；带 file 读其 references 下的具体文档（如 references/recon-pipeline.md）。按需加载，不占上下文。',
      parameters: {
        module: { type: 'string', description: '模块名（如 js-reverse / apk-reverse / pentest-tools / pwn-chain）' },
        file: { type: 'string', description: '模块内文件（缺省 SKILL.md，可填 references/xxx.md）' },
        list: { type: 'string', description: 'references = 只列该模块可读文件清单' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { module?: string; file?: string; list?: string }) {
        try {
          const repo = repoOf()
          if (!repo) return '【rev_playbook】未找到 reverse-skill 仓库（设置 repoRoot 或 REVERSE_SKILL_ROOT）。'
          if (!args.module) return renderCatalog(repo)
          const dir = join(skillsRoot(repo), args.module)
          if (!existsSync(dir)) {
            const mods = listModules(repo).map((m) => m.module)
            return `【rev_playbook】模块「${args.module}」不存在。可用：${mods.join(', ')}`
          }
          if ((args.list || '').toLowerCase() === 'references') {
            const refs = listDirNames(join(dir, 'references'))
            return [`【rev_playbook · ${args.module}】可读文件：`, '  SKILL.md', ...refs.map((r) => `  references/${r}`)].join('\n')
          }
          const r = readModule(repo, args.module, args.file)
          if (!r.ok) return `【rev_playbook】${r.text}`
          const head = `【rev_playbook · ${r.rel}】${r.text.length} 字符`
          const body = r.text.length > 14000 ? r.text.slice(0, 14000) + `\n\n…（截断，共 ${r.text.length} 字符；需要全文用 read 工具读文件）` : r.text
          return `${head}\n\n${body}`
        } catch (e) { return `【rev_playbook · 失败】${String(e)}` }
      },
    }),

    // ═══ 3. rev_doctrine ═══
    defineTool({
      name: 'rev_doctrine',
      description: 'reverse-skill 方法论核心：adf 决策质量层 R1-R51（置信带/validated 门槛/负证据/偏差自检/死锁重规划）、blindspot 分析盲区 R52-R81（语言识别/混淆分档/LLM 幻觉/上下文污染）、evidence 证据契约、role 角色、timeline 覆盖、supply-chain 门闩、workflow 阶段门、ops 索引。',
      parameters: {
        topic: { type: 'string', description: 'adf | blindspot | evidence | role | timeline | supply-chain | workflow | ops（默认 adf）' },
        file: { type: 'string', description: 'topic=ops 时读仓库 ops/ 下全文，如 analysis-decision-framework.md' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { topic?: string; file?: string }) {
        try {
          const topic = (args.topic || 'adf').toLowerCase()
          if (topic === 'ops' && args.file) {
            const repo = repoOf()
            if (!repo) return '【rev_doctrine】未找到 reverse-skill 仓库。'
            if (!/^[\w.-]+\.md$/.test(args.file)) return '【rev_doctrine】file 只接受 ops/ 下的 md 文件名。'
            const p = join(skillsRoot(repo), 'ops', args.file)
            if (!existsSync(p)) {
              const names = listDirNames(join(skillsRoot(repo), 'ops')).filter((f) => f.endsWith('.md'))
              return `【rev_doctrine】ops/${args.file} 不存在。可用：${names.join(', ')}`
            }
            const txt = safeRead(p)
            return `【rev_doctrine · ops/${args.file}】${txt.length} 字符\n\n${txt.length > 16000 ? txt.slice(0, 16000) + '\n\n…（截断）' : txt}`
          }
          return renderDoctrine(topic, args.file)
        } catch (e) { return `【rev_doctrine · 失败】${String(e)}` }
      },
    }),

    // ═══ 4. rev_case ═══
    defineTool({
      name: 'rev_case',
      description: '落地证据链：init 建案件 / evidence 落不可变证据（自动 sha256 固定）/ finding 登记结论（强制引用证据，validated 需 ≥2 条独立证据）/ path 登记攻击或调用路径 / timeline / workitem / status / review（引用完整性 + hash 校验 + 工作项闭合）。无证据的结论会被拒绝登记。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | init | evidence | finding | path | timeline | workitem | status | review' },
        case: { type: 'string', description: '案件名（除 list 外必填）' },
        title: { type: 'string', description: '标题（evidence/finding/path）' },
        target: { type: 'string', description: '目标（init）' },
        intent: { type: 'string', description: '意图（init）' },
        scope: { type: 'string', description: '范围（init）' },
        id: { type: 'string', description: '指定编号（evidence/workitem），缺省自动 E-001 递增' },
        evidenceIds: { type: 'string', description: '关联证据 id，逗号分隔（finding 必填）' },
        severity: { type: 'string', description: 'critical|high|medium|low|info|n/a_re（finding）' },
        category: { type: 'string', description: 'vuln|misconfig|design|reverse_algo|bypass|other（finding）' },
        status: { type: 'string', description: 'candidate|validated|false_positive|accepted_risk（finding）或 open|probing|confirmed|rejected（workitem）' },
        confidence: { type: 'string', description: 'high|medium|low（finding）' },
        location: { type: 'string', description: 'file:line | addr | url | class.method（finding）' },
        impact: { type: 'string', description: '影响（finding）' },
        remediation: { type: 'string', description: '修复建议（finding）' },
        reproCommand: { type: 'string', description: '可复现命令（evidence/finding）' },
        sourceType: { type: 'string', description: 'command|screenshot|file|log|memory|network|manual（evidence）' },
        sourceRef: { type: 'string', description: '来源引用（evidence）' },
        artifactPath: { type: 'string', description: '证据文件路径（相对案件根；自动记录 sha256）（evidence）' },
        rawExcerpt: { type: 'string', description: '脱敏摘录（evidence）' },
        workitem: { type: 'string', description: '关联工作项 WI-NNN' },
        pathType: { type: 'string', description: 'attack|callflow|solve（path）' },
        start: { type: 'string', description: '起点（path）' },
        goal: { type: 'string', description: '终点（path）' },
        steps: { type: 'string', description: '步骤，用 ; 或换行分隔（path）' },
        residualRisks: { type: 'string', description: '残余风险（path）' },
        note: { type: 'string', description: '内容（timeline/workitem）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: CaseArgs) {
        try { return caseAction(config, args) } catch (e) { return `【rev_case · 失败】${String(e)}` }
      },
    }),

    // ═══ 5. rev_journal ═══
    defineTool({
      name: 'rev_journal',
      description: '复盘自进化：add 脱敏回写经验（场景/有效链路/关键证据/踩坑/可复用模式），search 检索历史先例（同类任务先查再动手），index 列全部条目。让每次破解/攻击都比上次快。',
      parameters: {
        action: { type: 'string', required: true, description: 'add | search | index' },
        title: { type: 'string', description: '条目标题（add）' },
        scenario: { type: 'string', description: '场景描述（add）' },
        chain: { type: 'string', description: '有效链路（add）' },
        pattern: { type: 'string', description: '可复用模式一句话（add）' },
        pitfalls: { type: 'string', description: '踩坑/无效路径（add）' },
        evidence: { type: 'string', description: '关键证据 id + 命令（≤3 条，脱敏）（add）' },
        tags: { type: 'string', description: '标签（add）' },
        route: { type: 'string', description: '当时的路由 id（add）' },
        query: { type: 'string', description: '检索词（search）' },
        limit: { type: 'string', description: '返回条数（search，默认 5）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: Record<string, string | undefined> & { action: string }) {
        try { return journalAction(config, args.action, args) } catch (e) { return `【rev_journal · 失败】${String(e)}` }
      },
    }),

    // ═══ 6. rev_toolindex ═══
    defineTool({
      name: 'rev_toolindex',
      description: '按 reverse-skill bootstrap-manifest 清单探测本机逆向/渗透工具（jadx/apktool/frida/ida/ghidra/r2/binwalk/yara/pwntools/hashcat/nmap 等）的真实安装路径：已装给路径直接用，缺的给安装提示（区分可自动/需手动，商业工具只给指引）。禁止假设路径存在。',
      parameters: {
        want: { type: 'string', description: '只查含该关键字的工具（可选，如 frida / jadx）' },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(args: { want?: string }) {
        try {
          const repo = repoOf()
          if (!repo) return '【rev_toolindex】未找到 reverse-skill 仓库（设置 repoRoot 或 REVERSE_SKILL_ROOT）。'
          return renderToolIndex(repo, args.want)
        } catch (e) { return `【rev_toolindex · 失败】${String(e)}` }
      },
    }),
  ]

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `reverse-skill: ${tool.name}`)
  }

  // ── 首轮锚定：只露路由入口 ──
  if (config.anchorFirstTurn) {
    ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
      const assembled = await next()
      const agent = context.agent
      if (!agent || agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call')) return assembled
      return { ...assembled, tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE) }
    })
  }

  ctx.logger?.info?.(`[${name}] reverse-skill doctrine active (${tools.length} tools, repo=${resolveRepoRoot(config.repoRoot) || 'NOT FOUND'})`)
}
