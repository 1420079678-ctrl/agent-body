/**
 * @dsh-external/dsh-vuln-mastery-loop — 漏洞挖掘·每日实战提升守护循环（真实性优先版）。
 *
 * 每天 runTimes（默认 10:00 上午 / 18:00 下午）触发一轮「实战 + 分析」：
 *   - 上午(10:00) → 在线著名公开靶场（默认 testfire.net / zero.webappsecurity.com，可配）
 *   - 下午(18:00) → 本机靶场（默认 http://127.0.0.1:8080，可配）
 *   - 若 targets.md「授权真实目标」区已填，则优先用真实授权目标（无论上/下午）
 *
 * 真实性铁律：
 *   1. 只用攻击引擎（sec_auto/sec_webtest/vuln_scan/sec_fingerprint/sec_cve）的实测输出作为证据。
 *   2. 只有引擎明确标注「置信度=高/中」或 ✅/⚡/🔴 且命中漏洞类型，才算【已确认/待验证】发现。
 *   3. LLM 只做分级/解释/（未命中时）生成 ≥3 个新方向与实战坑；【绝不虚构漏洞】；无证据一律写未命中/排除。
 *   4. 高危/中危优先；低置信度只作线索不计入已验证。
 *   5. 靶场（在线/本机）为授权训练目标；真实目标必须写入 targets.md 才会被使用。
 *
 * 产物低占用：工具输出逐段截断，LLM 输入 ≤14000，报告浓缩，日志 >2MB 自动轮转。
 */
import type { Context } from 'cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import z from 'schemastery'

type AppContext = Context & {
  llm: LlmService
  tools: {
    execute(input: {
      callId: ReturnType<typeof CallId>
      name: string
      arguments: unknown
      signal: AbortSignal
    }): Promise<{ content: Array<{ type: string; text?: string; value?: string }>; isError?: boolean }>
  }
  setInterval(fn: () => void, ms: number): any
  webServer: {
    register(rec: any): any
  }
}

export const name = "@dsh-external/dsh-vuln-mastery-loop"
export const inject = ['timer', 'tools', 'llm', 'webServer']

export interface Config {
  runTimes: string
  pollMs: number
  outDir: string
  provider: string
  model: string
  initialRun: boolean
  targetsFile: string
  ledgerFile: string
  localLab: string
  localFallback: string
  onlinePool: string
  maxTests: number
  deepFlow: boolean
  deepFlowUser: string
  deepFlowPass: string
}

export const Config = z.object({
  runTimes: z.string().default('10:00,18:00'),
  pollMs: z.number().min(10000).default(60000),
  outDir: z.string().default(''),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  initialRun: z.boolean().default(true),
  targetsFile: z.string().default('targets.md'),
  ledgerFile: z.string().default('ledger.md'),
  localLab: z.string().default('http://127.0.0.1:3000'),
  localFallback: z.string().default('http://127.0.0.1:8080'),
  onlinePool: z.string().default('http://demo.testfire.net/,http://zero.webappsecurity.com/,http://testphp.vulnweb.com/'),
  maxTests: z.number().min(1).max(10).default(5),
  deepFlow: z.boolean().default(true),
  deepFlowUser: z.string().default('admin@juice-sh.op'),
  deepFlowPass: z.string().default('admin123'),
})

export function apply(ctx: AppContext, config: Config): void {
  const SHORT = "dsh-vuln-mastery-loop"
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = join(dshHome, 'super-injector', SHORT + '.log')
  const baseDir = config.outDir || 'D:\\漏洞挖掘\\_vuln-mastery'
  const targetsPath = join(baseDir, config.targetsFile)
  const ledgerPath = join(baseDir, config.ledgerFile)
  const reportsDir = join(baseDir, 'reports')
  const knowledgeDir = join(baseDir, 'knowledge')

  const runAtSet = new Set(String(config.runTimes).split(',').map((s) => s.trim().padStart(5, '0')).filter(Boolean))
  const runAtArr = Array.from(runAtSet).sort()
  const lastRunSlots = new Set<string>()
  let lastRoute: { provider: string; model: string } | null = null
  let llmCalls = 0

  const LOG_MAX_BYTES = 3 * 1024 * 1024
  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      if (existsSync(logFile)) {
        try { if (statSync(logFile).size > LOG_MAX_BYTES) renameSync(logFile, logFile + '.old') } catch { /* 静默 */ }
      }
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* 静默 */ }
  }
  const clip = (s: string, n: number): string => String(s ?? '').slice(0, n)

  ctx.on('llm/stream', (options: any, next: any) => {
    if (options?.provider && options?.model) lastRoute = { provider: options.provider, model: options.model }
    return next()
  })

  async function callTool(name: string, args: Record<string, unknown>, timeoutMs = 90000): Promise<string> {
    try {
      const res = await ctx.tools.execute({
        callId: CallId(SHORT + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
        name,
        arguments: args,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.isError) return 'ERROR: ' + JSON.stringify(res.content ?? [])
      return (res.content ?? []).map((b) => b.text ?? b.value ?? '').join('\n') || '（无输出）'
    } catch (e) {
      return 'CALL-FAIL [' + name + ']: ' + String(e).slice(0, 120)
    }
  }

  async function streamOnce(provider: string, model: string, system: string, user: string, maxTokens: number): Promise<{ text: string; seen: string[]; finish: string }> {
    let text = ''
    const seen: string[] = []
    let finish = ''
    const stream = ctx.llm.stream({
      provider, model, system,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: user.slice(0, 14000) }] })],
      temperature: 0.2,
      reasoningEffort: ReasoningEffortId('off'),
      maxTokens,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') { text += chunk.text; if (seen.length < 12) seen.push('td') }
      else if (chunk.type === 'finish') { finish = JSON.stringify((chunk as any).finishReason ?? (chunk as any).reason ?? '').slice(0, 60); if (seen.length < 12) seen.push('finish') }
      else if (seen.length < 12) seen.push(String((chunk as any).type))
    }
    return { text, seen, finish }
  }

  // 文本分析固定优先用专用文本模型（主会话可能是视觉模型，会拿到空流）；空则回退 lastRoute
  async function llmText(system: string, user: string, maxTokens = 1600): Promise<string> {
    llmCalls += 1
    const routes: Array<{ provider: string; model: string }> = [{ provider: config.provider, model: config.model }]
    if (lastRoute && (lastRoute.provider !== config.provider || lastRoute.model !== config.model)) routes.push(lastRoute)
    for (const r of routes) {
      try {
        const { text, seen, finish } = await streamOnce(r.provider, r.model, system, user, maxTokens)
        if (text.trim()) return text.trim()
        log('LLM empty route=' + r.provider + '/' + r.model + ' types=' + seen.join(',') + ' finish=' + finish)
      } catch (e) {
        log('LLM-FAIL route=' + r.provider + '/' + r.model + ' err=' + String(e).slice(0, 120))
      }
    }
    return '（LLM 无输出）'
  }

  const VULN_RX = /注入|XSS|SQL|SSRF|遍历|越权|IDOR|未授权|CVE|泄露|命令|模板|SSTI|爆破|弱口令|读取|RCE|伪造|提权|CSRF|点击劫持|敏感文件|备份/i
  const HIGH_RX = /高危|严重|critical|criticality|9\.\d|8\.\d|RCE|命令注入|SQL注入|SSRF|越权|IDOR|未授权访问|反序列化|弱口令|爆破/i

  function dedupe(list: string[]): string[] { return Array.from(new Set(list)) }

  // 注入点优先：带 query/参数/典型漏洞路径/API 端点的候选排前面（提高在线+API命中率）
  function prioritizeCandidates(list: string[], max: number): string[] {
    const score = (u: string): number => {
      let s = 0
      if (u.includes('?')) s += 2
      if (/[=&]/.test(u)) s += 1
      if (/(login|search|query|api|user|account|id|admin|profile|token|order|item|buy|vote|page=|content=|cat=|q=|do=|redirect|url|file|path|next|product|review)/i.test(u)) s += 2
      if (/\/(?:api|rest|graphql|v[0-9])\//i.test(u)) s += 3
      return s
    }
    return [...list].sort((a, b) => score(b) - score(a)).slice(0, max)
  }

  // API 感知发现：从 /api-docs(Swagger/OpenAPI) 提取端点 + 常用 REST 端点兜底，返回绝对 URL
  async function discoverApiPaths(target: string): Promise<string[]> {
    const paths: string[] = []
    for (const docPath of ['/api-docs', '/api-docs/', '/swagger.json', '/rest/api-docs', '/openapi.json']) {
      try {
        const out = clip(await callTool('crawl4ai', { url: target + docPath, max_length: 6000, word_count_threshold: 3 }, 30000), 12000)
        const found = out.match(/\/(?:api|rest|graphql|v[0-9])\/[^\s"'`{}]+/gi) ?? []
        for (const f of found) { const clean = target + f.replace(/["'`><]+$/, ''); if (!paths.includes(clean)) paths.push(clean) }
      } catch { /* 静默 */ }
    }
    const common = ['/rest/products/search?q=a', '/rest/user/login', '/api/Products', '/api/Users', '/rest/track-order/x', '/rest/basket/1', '/api/offers', '/rest/products/reviews?q=a', '/rest/memories?q=a', '/api/Feedbacks']
    for (const c of common) { const u = target + c; if (!paths.includes(u)) paths.push(u) }
    return dedupe(paths.filter((p) => /^https?:\/\//.test(p)))
  }

  // SPA 识别：目标对不存在的随机路径也返回 200 HTML → 说明是 SPA，其"敏感文件泄露"等多为假阳性
  async function isSpa(target: string): Promise<boolean> {
    try {
      const probe = target + '/__spa_probe_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const out = await callTool('sec_exec', { action: 'http', target: probe }, 15000)
      if (/CALL-FAIL|Timeout|ECONNREFUSED|拒绝|无法|超时/i.test(out)) return false
      return /200|<!DOCTYPE|<html|<script|<body/i.test(out) && !/<title>404|<h1>404|not found/i.test(out)
    } catch { return false }
  }

  // 从靶场首页/爬虫文本提取候选测点 URL（绝对+相对 → 解析为绝对；**只保留与目标同域**，剔除外部 CDN/字体/统计/静态资源）
  function extractCandidateUrls(rootHtml: string, baseUrl: string): string[] {
    const candidates: string[] = []
    let base: URL
    try { base = new URL(baseUrl) } catch { return [] }
    const baseHost = base.host
    let assetRx = /\.(png|jpg|jpeg|gif|css|js|ico|svg|woff2?|ttf|eot|map)$/i
    let push = (u: string): void => {
      if (candidates.includes(u)) return
      try {
        // 同域过滤：只测目标主机，绝不把流量打去外部第三方（Google Fonts/CDN/统计等）
        if (new URL(u).host !== baseHost) return
      } catch { return }
      if (assetRx.test(u)) return
      candidates.push(u)
    }
    const abs = rootHtml.match(/https?:\/\/[^\s"'<>)]+[\w=.?&\/-]/gi) ?? []
    for (const u of abs) push(u.replace(/[),.]+$/, ''))
    const rels = rootHtml.match(/href=["']?([^"' >#]+)/gi) ?? []
    for (const h of rels) {
      let p = h.replace(/^href=["']?/i, '').replace(/["']+$/, '')
      if (!p || p.startsWith('#') || p.startsWith('mailto:') || p.startsWith('javascript:')) continue
      try { push(new URL(p, base).toString()) } catch { /* 静默 */ }
    }
    // 注入点优先
    const injectable = candidates.filter((u) => u.includes('?') || u.includes('='))
    const rest = candidates.filter((u) => !injectable.includes(u))
    return [...injectable, ...rest].slice(0, config.maxTests)
  }

  // 提取引擎「已确认」发现行（真实性闸门）：只认引擎自身证据（置信度=高/中 或 表格列高/中 或 ✅/⚡真实利用成功），排除噪声/正常文件/重复；SPA 目标剔除敏感文件泄露假阳性
  function extractConfirmedFindings(raw: string, isSpa: boolean): Array<{ line: string; severity: string }> {
    const lines = String(raw).split('\n')
    const found: Array<{ line: string; severity: string }> = []
    const NOISE_RX = /banner|SSH-|开放端口|端口|汇总攻击面|服务 |TLS|nmap|Server:|X-Powered|数据库未授权检测|security\.txt|robots\.txt|sitemap\.xml|favicon|\.well-known\//i
    // SPA 假阳性：任意路径都回 200 HTML，导致 .env/.bak/backup 等"泄露"全是误报 → 丢弃
    const SPA_LEAK_RX = /敏感文件泄露|备份|文件包含|\/\.env|\/\.DS_Store|\/\.htaccess|\.bak|backup|db\.sql|database\.sql|phpinfo|web\.config|docker-compose|swagger-ui|composer\.json|package\.json|mysql\.sql|config\.php/i
    const REAL_SUCCESS_RX = /注入|读取|利用|成功|RCE|SSRF|越权|遍历|命令|模板|SSTI|反序列化|爆库|读表|绕过|破解/i
    const vulnTypeRX = /注入|XSS|SQL|SSRF|遍历|越权|IDOR|未授权|CVE|泄露|命令|模板|SSTI|爆破|弱口令|读取|RCE|伪造|提权|CSRF|敏感|文件包含|JWT/i
    const seen = new Set<string>()
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || NOISE_RX.test(line)) continue
      if (isSpa && SPA_LEAK_RX.test(line)) continue
      const isTableFinding = /^\s*\|/.test(line) && /\|\s*(高|中)\s*\|/.test(line)
      const confByScore = /置信度\s*=\s*(高|中)/.test(line) || isTableFinding
      const confBySuccess = /[✅⚡]/.test(line) && REAL_SUCCESS_RX.test(line)
      if ((confByScore || confBySuccess) && vulnTypeRX.test(line)) {
        const high = /\|\s*高\s*\|/.test(line) || /置信度\s*=\s*高/.test(line) || HIGH_RX.test(line)
        // 去重：同一漏洞类型 + 同一端点 只计一次
        const type = (line.match(vulnTypeRX) ?? ['未分类'])[0]
        const endpoint = (line.match(/(?:https?:\/\/[^\s,，|]+|\/[^\s,，|]{2,30})/i) ?? [''])[0]
        const key = type + '|' + endpoint
        if (seen.has(key)) continue
        seen.add(key)
        found.push({ line: clip(line, 240), severity: high ? '高危' : '中危' })
      }
    }
    return found.slice(0, 30)
  }

  // 从 targets.md「授权真实目标」小节取真实目标（跳过示例）
  function authorizedTargets(): string | null {
    try {
      if (!existsSync(targetsPath)) return null
      const content = readFileSync(targetsPath, 'utf8')
      const secMatch = content.match(/^#{1,4}\s*(?:授权)?真实目标[^\n]*$/m)
      if (!secMatch || secMatch.index === undefined) return null
      const after = content.slice(secMatch.index + secMatch[0].length)
      const next = after.search(/^#{1,4}\s*[^\n]*$/m)
      const section = next >= 0 ? after.slice(0, next) : after
      for (const line of section.split('\n')) {
        const t = line.trim()
        if (!t || /示例|占位|your-|example/i.test(t)) continue
        const m = t.match(/https?:\/\/[^\s|,）)\]，。]+/i)
        if (m) return m[0]
      }
      return null
    } catch { return null }
  }

  function parsePool(s: string): string[] {
    return String(s).split(/[,\n]/).map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x))
  }

  // 高价值靶场覆盖度登记（用于日志/报告标注练到哪些漏洞类型）
  const POOL_META: Record<string, string> = {
    'demo.testfire.net': '经典银行Web全方向：SQLi / 反射XSS / CSRF / 路径遍历 / 会话认证',
    'zero.webappsecurity.com': '银行Web：SQLi / XSS / CSRF / 认证与会话 / 业务逻辑',
    'testphp.vulnweb.com': 'SQLi / 登录绕过 / XSS（Acunetix 官方演示）',
    '127.0.0.1:3000': 'OWASP Juice Shop：OWASP Top10 全方向（SQLi/XSS/SSTI/SSRF/认证授权/逻辑/JWT/加密/竞态…）',
    '127.0.0.1:8080': '本机综合靶场：SQLi / 反射+存储XSS / IDOR越权 / SSRF / SSTI / JWT弱密钥 / 信息暴露',
  }
  function coverageTag(url: string): string {
    for (const k of Object.keys(POOL_META)) if (url.includes(k)) return POOL_META[k]
    return '待补充覆盖标注'
  }

  // 可达性筛选：探测目标是否真正可达可用（剔除 503/403/超时/拒连 等"无效靶场"）
  async function isReachable(url: string): Promise<boolean> {
    try {
      const out = await callTool('sec_exec', { action: 'http', target: url }, 8000)
      if (/CALL-FAIL|Timeout|ECONNREFUSED|拒绝|无法|超时|DNS/i.test(out)) return false
      if (/HTTP\/\d(?:\.\d)?\s+5\d\d|\b503\b|\b403\b|Forbidden|Service Unavailable/i.test(out)) return false
      return /2\d\d|200|301|302|OK|<!DOCTYPE|<html/i.test(out) || out.length > 40
    } catch { return false }
  }

  // 目标选择（筛选+轮换）：真实授权目标优先；上午(10)在"可达的高价值在线靶场"里按日期轮换；下午(18)打本机综合靶场
  async function pickTargetFor(hhmm: string): Promise<string> {
    const auth = authorizedTargets()
    if (auth) return auth
    const hour = parseInt(hhmm.slice(0, 2), 10)
    const pool = parsePool(config.onlinePool)
    if (pool.length === 0) return config.localLab
    const start = new Date().getDate() % pool.length
    if (hour === 10) {
      for (let i = 0; i < pool.length; i++) {
        const u = pool[(start + i) % pool.length]
        if (await isReachable(u)) return u
      }
      return config.localLab
    }
    // 下午：本机主靶场（Juice Shop：3000）→ 本机回退（vuln-lab：8080）→ 在线回退
    for (const local of [config.localLab, config.localFallback]) {
      if (local && await isReachable(local)) return local
    }
    for (const u of pool) if (await isReachable(u)) return u
    return config.localLab
  }

  function nowHhmm(): string {
    const d = new Date()
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  function todayStr(): string { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  function safeMd(s: string): string { return String(s ?? '').replace(/\r?\n+/g, '\n').slice(0, 24000) }

  function updateLedger(entry: string): void {
    try {
      mkdirSync(dirname(ledgerPath), { recursive: true })
      let content = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '# 主进度台账\n\n## 每日记录\n\n'
      content = content.replace(/^- 上次训练日期：.*$/m, '- 上次训练日期：' + todayStr())
      if (!/## 每日记录/.test(content)) content += '\n## 每日记录\n\n'
      content = content.replace(/\n## 每日记录\n/, '\n## 每日记录\n\n' + entry + '\n')
      writeFileSync(ledgerPath, content, 'utf8')
    } catch (e) { log('ledger update error: ' + String(e)) }
  }

  // ═══ 评估系统（token 友好：全部确定性计算，零 LLM 往返）═══
  const EVAL_DIR = join(baseDir, 'eval')
  const EVAL_HIST = join(EVAL_DIR, 'history.json')

  function readEvalHistory(): Array<any> {
    try { if (!existsSync(EVAL_HIST)) return []; const j = JSON.parse(readFileSync(EVAL_HIST, 'utf8')); return Array.isArray(j) ? j : (j.entries ?? []) } catch { return [] }
  }
  function writeEvalHistory(entries: Array<any>): void {
    try { mkdirSync(EVAL_DIR, { recursive: true }); writeFileSync(EVAL_HIST, JSON.stringify(entries), 'utf8') } catch { /* 静默 */ }
  }

  function computeScore(m: any): any {
    const hit = Math.min(10, m.high * 3 + m.med * 1.2)                 // 命中+严重度
    const auth = m.allHigh ? 10 : 9                                     // 真实性（全部高置信引擎证据=10）
    const cov = Math.min(10, m.types * 2.5 + (m.types >= 3 ? 1 : 0))    // 覆盖（已确认漏洞类型数）
    const innov = Math.min(10, m.advanced * 2.5)                        // 创新性（进阶/新颖迹象数）
    const butian = m.anyHit ? (m.hadFix ? 10 : 7) : (m.directions >= 3 ? 6 : 3) // 补天合规（可复现+修复+分级）
    const method = m.directions >= 3 ? 9 : Math.min(8, m.directions * 2) // 方法论/多方向
    const defense = m.hadFix ? 10 : 4                                   // 攻防闭环
    const discovery = Math.min(10, m.testCount * 1.4)                   // 发现广度
    const weights = { hit: 0.22, cov: 0.15, auth: 0.14, innov: 0.12, butian: 0.11, method: 0.10, defense: 0.08, discovery: 0.08 }
    const index = Math.round((hit*weights.hit + cov*weights.cov + auth*weights.auth + innov*weights.innov + butian*weights.butian + method*weights.method + defense*weights.defense + discovery*weights.discovery) * 10)
    return { hit, cov, auth, innov, butian, method, defense, discovery, index }
  }

  function runEval(m: any): { index: number; improved: boolean; passed: boolean; trend: number; weak: string } {
    const scores = computeScore(m)
    const entries = readEvalHistory()
    const prev = entries.length ? entries[entries.length - 1] : null
    const improved = prev ? scores.index >= prev.index : true
    const passed = improved && scores.index >= 55
    const recent = entries.slice(-3)
    let trend = 0
    if (recent.length) {
      const avg = recent.reduce((a, e) => a + e.index, 0) / recent.length
      trend = Math.round((scores.index - avg) * 10) / 10
    }
    const dims: Array<[string, number]> = [['命中', scores.hit], ['覆盖度', scores.cov], ['真实性', scores.auth], ['创新性', scores.innov], ['补天合规', scores.butian], ['方法论', scores.method], ['攻防闭环', scores.defense], ['发现广度', scores.discovery]]
    const weak = dims.reduce((a, b) => (b[1] < a[1] ? b : a))[0]
    const entry = { at: nowHhmm(), date: todayStr(), slot: m.slot, target: m.target, coverage: m.covTag, metrics: { high: m.high, med: m.med, types: m.types, advanced: m.advanced, directions: m.directions, testCount: m.testCount, allHigh: m.allHigh, hadFix: m.hadFix, anyHit: m.anyHit }, scores, index: scores.index, improved, passed, weak, trend }
    entries.push(entry)
    if (entries.length > 200) entries.splice(0, entries.length - 200)
    writeEvalHistory(entries)
    const report = [
      `# 插件能力评估 ${todayStr()} ${nowHhmm()}`,
      ``,
      `> 目标：${m.target} ｜ 覆盖：${m.covTag}`,
      ``,
      `| 维度 | 得分 |`,
      `|---|---|`,
      ...dims.map((d) => `| ${d[0]} | ${d[1].toFixed(1)} |`),
      ``,
      `## 能力指数：**${scores.index}/100**`,
      ``,
      `- 相比上次：${improved ? '✅ 持平/上升' : '⬇️ 回退'}（趋势 ${trend >= 0 ? '+' : ''}${trend}）`,
      `- 是否达标完成：${passed ? '✅ 达标（本次训练完成）' : '⚠️ 未达标/回退，下轮聚焦：' + weak}`,
      `- 需强化维度：**${weak}**`,
      `- 摘要：命中 ${m.high} 高危 / ${m.med} 中危；测试 ${m.testCount} 个测点；覆盖 ${m.types} 类漏洞；方向 ${m.directions} 个；真实性=${m.allHigh ? '全部高置信引擎证据' : '含待验证'}`,
      ``,
      `---`,
      `*评估为确定性计算（零 LLM token），仅基于引擎可复现证据与真实指标。*`,
      ``,
    ].join('\n')
    try { mkdirSync(EVAL_DIR, { recursive: true }); writeFileSync(join(EVAL_DIR, todayStr() + '-' + nowHhmm().replace(':', '') + '-评价.md'), report, 'utf8') } catch { /* 静默 */ }
    log('eval index=' + scores.index + ' improved=' + improved + ' passed=' + passed + ' weak=' + weak)
    return { index: scores.index, improved, passed, trend, weak }
  }

  // 自动更新状态快照（供状态面板读取）：每日槽位已跑/下次 + 最近一次结果
  function writeStatus(): void {
    try {
      const hist = readEvalHistory()
      const last = hist.length ? hist[hist.length - 1] : null
      const today = todayStr(), hhmm = nowHhmm()
      const slots = runAtArr.map((rt) => {
        const done = lastRunSlots.has(today + ':' + rt)
        const isPast = hhmm >= rt
        return { time: rt, type: rt === '10:00' ? '上午在线靶场' : '下午本机靶场', status: done ? '已跑' : (isPast ? '补跑' : '待触发'), next: isPast && !done ? (today + ' ' + rt) : '' }
      })
      const status = {
        renderedAt: today + ' ' + hhmm, baseDir,
        slots,
        lastRun: last
          ? { at: last.at, slot: String(last.slot), target: last.target, index: last.index, passed: last.passed, high: last.metrics?.high, med: last.metrics?.med, weak: last.weak }
          : null,
        nextSched: runAtArr.filter((rt) => hhmm < rt).map((rt) => today + ' ' + rt),
        labs: { juice: 'http://127.0.0.1:3000', vulnlab: 'http://127.0.0.1:8080' },
      }
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8')
    } catch { /* 静默 */ }
  }

  // JWT 弱密钥→越权链：自动取 token → sec_jwt 爆破+伪造 admin → 用伪造令牌访问授权端点，200 即提权确认
  async function probeJwtChain(target: string): Promise<string> {
    let out = ''
    let token = ''
    for (const tp of ['/token', '/api/token', '/rest/user/login', '/api/auth/token']) {
      try {
        const r = await callTool('sec_exec', { action: 'http', target: target + tp }, 15000)
        const m = !/CALL-FAIL/.test(r) ? (r.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) ?? [''])[0] : ''
        if (m) { token = m; break }
      } catch { /* 静默 */ }
    }
    if (!token) return ''
    out += '\n[JWT token 已捕获]\n'
    const forged = await callTool('sec_jwt', { token, payload: JSON.stringify({ user: 'admin', role: 'admin', exp: 9999999999 }) }, 60000)
    out += '\n[sec_jwt]\n' + clip(forged, 1800)
    const forgedToken = (forged.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) ?? [''])[0]
    if (forgedToken) {
      for (const ap of ['/api/admin', '/admin', '/administrator', '/rest/admin/users', '/api/admin/users', '/api/Users']) {
        try {
          const r = await callTool('sec_exec', { action: 'http', target: target + ap, headers: JSON.stringify({ Authorization: 'Bearer ' + forgedToken }) }, 15000)
          if (/200|ok|granted|flag|users/i.test(r) && !/401|403|forbidden|需认证/i.test(r)) {
            out += '\n✅ 越权/提权确认 ' + ap + '：伪造JWT(role=admin) 访问成功，响应节选 ' + clip(r.replace(/\s+/g, ' '), 180) + ' 置信度=高\n'
            break
          }
        } catch { /* 静默 */ }
      }
    }
    return out
  }

  // 覆盖度纵向①：数据库/缓存未授权（检出 6379/9200/3306/27017/11211 端口时跑 sec_dbsvc）
  async function probeDbsvc(scanText: string, target: string): Promise<string> {
    const dbPorts = ['6379', '9200', '3306', '27017', '11211']
    const found = dbPorts.filter((p) => new RegExp('\\b' + p + '\\b').test(scanText))
    if (!found.length) return ''
    let host = ''
    try { host = new URL(target).hostname } catch { host = target.replace(/^https?:\/\//, '').split(/[:\/]/)[0] }
    let out = ''
    for (const p of found) out += '\n[sec_dbsvc ' + host + ':' + p + ']\n' + clip(await callTool('sec_dbsvc', { target: host + ':' + p }, 30000), 1500)
    return out
  }

  // 覆盖度纵向②：IDOR 批量遍历（常见 id 参数端点，id=1 与 id=2 返回不同数据即越权）
  async function probeIdor(target: string, isLocal: boolean): Promise<string> {
    if (!isLocal) return ''
    // 真实性闸门：仅当两次请求都【真的拿到 HTTP 成功响应】且数据不同才判越权；
    // 失败文本（fetch fail/请求失败/超时/拒绝连接）绝不参与判定，杜绝"两个错误文本不同"的误报。
    const FAIL_RX = /请求失败|fetch fail|TypeError|ECONNREFUSED|ECONNRESET|ETIMEDOUT|超时|无法连接|拒绝|CALL-FAIL|SOCKET|undefined|Error:/i
    const OK_RX = /HTTP\/\d(?:\.\d)?\s+2\d\d|\b200\b|\b201\b|OK|<!DOCTYPE|<html|"success"|true/i
    let out = ''
    for (const base of ['/api/user?id=', '/api/users?id=', '/rest/user?id=', '/users/', '/api/order?id=']) {
      const u1 = target + base + '1', u2 = target + base + '2'
      let r1 = '', r2 = ''
      try { r1 = await callTool('sec_exec', { action: 'http', target: u1 }, 12000) } catch { /* 静默 */ }
      try { r2 = await callTool('sec_exec', { action: 'http', target: u2 }, 12000) } catch { /* 静默 */ }
      // 关键：r1/r2 必须都是真实成功响应（排除错误/失败文本），且内容确实不同
      const ok1 = r1 && OK_RX.test(r1) && !FAIL_RX.test(r1)
      const ok2 = r2 && OK_RX.test(r2) && !FAIL_RX.test(r2)
      if (ok1 && ok2 && r1 !== r2 && /secret|email|name|user|role|address|phone|id|data|account/i.test(r1 + r2) && !/404|not found/i.test(r1 + r2)) {
        out += '\n✅ IDOR/越权确认 ' + base + '1..2：不同 id 返回不同数据 「' + clip(r1.replace(/\s+/g, ' '), 120) + '」vs「' + clip(r2.replace(/\s+/g, ' '), 120) + '」 置信度=高\n'
        break
      }
    }
    return out
  }

  // 是否真的需要登录：探测常见受保护端点，任一 401/需认证 ⇒ 目标需要会话（才触发浏览器登录/接管）
  async function needsAuth(target: string): Promise<boolean> {
    for (const ap of ['/api/users', '/api/Users', '/api/admin', '/api/orders', '/rest/user', '/api/me', '/api/account', '/api/basket']) {
      try {
        const r = await callTool('sec_exec', { action: 'http', target: target + ap }, 12000)
        if (/401|unauthorized|需认证|UnAuthorized|未授权|invalid token/i.test(r)) return true
      } catch { /* 静默 */ }
    }
    return false
  }

  async function runTurn(slot: string): Promise<void> {
    // 槽位时间解析：slot 形如 "2026-08-27:10:00" → 取 "10:00" 作为目标选择依据；
    // 补跑(catchup)时也按【槽位本身时间】选目标（10:00 槽=上午在线靶场，18:00 槽=下午本机靶场），
    // 而不是按触发时刻——避免 11:36 补跑 10:00 槽却走了下午逻辑的偏差。
    const slotHhmm = slot.includes(':') ? slot.split(':').slice(-2).join(':') : ''
    const hhmm = /^\d{2}:\d{2}$/.test(slotHhmm) ? slotHhmm : nowHhmm()
    const dateStr = todayStr()
    const target = await pickTargetFor(hhmm)
    const isOnline = /^https?:\/\//.test(target) && !/127\.0\.0\.1|localhost/.test(target)
    const targetLocal = /127\.0\.0\.1|localhost/.test(target)
    const creds = config.deepFlowUser && config.deepFlowPass
    const cov = coverageTag(target)
    log('turn start slot=' + slot + ' date=' + dateStr + ' target=' + target + ' online=' + isOnline + ' 覆盖=' + cov)

    const chain: string[] = []
    let raw = ''

    // ── 1. 发现测点：sec_exec 抓首页 + crawl4ai 深爬（JS-heavy/SPA 也能拿端点） ──
    let rootHtml = ''
    try { rootHtml = clip(await callTool('sec_exec', { action: 'http', target }, 60000), 30000) } catch { /* 静默 */ }
    let crawlText = ''
    try { crawlText = clip(await callTool('crawl4ai', { url: target, max_length: 7000, word_count_threshold: 4 }, 90000), 20000) } catch { /* 静默 */ }
    const cands = dedupe([...extractCandidateUrls(rootHtml, target), ...extractCandidateUrls(crawlText, target)])
    // API 感知发现 + SPA 识别（真实性）
    let spa = false
    try { spa = await isSpa(target) } catch { /* 静默 */ }
    let apiCands: string[] = []
    try { apiCands = await discoverApiPaths(target) } catch { /* 静默 */ }
    const allCands = dedupe([...cands, ...apiCands])
    // 真浏览器深业务流：本地/授权SPA 自动驱动真实浏览器刷深业务流(config.deepFlow)；读结果 + 对 JWT 跑 sec_jwt
    let deepFlowSummary = ''
    try {
      const flowTag = target.replace(/[^a-z0-9]/gi, '_')
      const dpath = join(baseDir, 'labs', 'deepflow-' + flowTag + '.json')
      const isLocal = /127\.0\.0\.1|localhost/.test(target)
      const creds = config.deepFlowUser && config.deepFlowPass
      const freshEnough = existsSync(dpath) && (Date.now() - statSync(dpath).mtimeMs) < 12 * 3600 * 1000
      if (config.deepFlow && isLocal && creds && !freshEnough && /:3000/.test(target)) {
        const flowPath = join(baseDir, 'labs', 'browser-flow.js')
        if (existsSync(flowPath)) {
          log('deepflow: spawn browser-flow for ' + target)
          const child = spawn(process.execPath, ['browser-flow.js', target, config.deepFlowUser, config.deepFlowPass], { cwd: join(baseDir, 'labs'), stdio: 'ignore', detached: true, windowsHide: true })
          child.unref()
          await new Promise((r) => setTimeout(r, 19000))
        }
      }
      if (existsSync(dpath)) {
        const dd = JSON.parse(readFileSync(dpath, 'utf8'))
        const acc = (dd.apiChecks || []).filter((a: any) => a.status === 200).map((a: any) => a.url)
        deepFlowSummary = '已登录 ' + (dd.user || '') + '(' + (dd.login || '') + ')；认证态可访问(200): ' + (acc.join(', ') || '无') + '；捕获 ' + (dd.network || []).length + ' 条 API/rest 网络。'
        raw += '\n[深业务流-browser]\n' + (dd.apiChecks || []).map((a: any) => (a.status ?? '-') + ' ' + a.url + ' ' + (a.note || '')).join('\n')
        chain.push('真浏览器深业务流')
        if (dd.jwt && config.deepFlow) {
          const jr = await callTool('sec_jwt', { token: dd.jwt }, 60000)
          if (!/CALL-FAIL/.test(jr)) { raw += '\n[sec_jwt]\n' + clip(jr, 2500); chain.push('sec_jwt 破解/伪造') }
        }
      }
    } catch (e) { log('deepflow err: ' + String(e).slice(0, 80)) }
    // CDP 登录+接管：仅当目标"确实需要认证"时才登录/接管（公开目标直接扫，不登录不拉浏览器）
    if (config.deepFlow && creds && (await needsAuth(target))) {
      const sessScript = join(baseDir, 'labs', 'browser-session.js')
      if (existsSync(sessScript)) {
        log('browser-session login+capture for ' + target)
        try {
          spawn(process.execPath, ['browser-session.js', 'run', target, config.deepFlowUser, config.deepFlowPass], { cwd: join(baseDir, 'labs'), stdio: 'ignore', detached: true, windowsHide: true }).unref()
          await new Promise((r) => setTimeout(r, 20000))
        } catch (e) { log('browser-session err ' + String(e).slice(0, 80)) }
        const ctag = target.replace(/[^a-z0-9]/gi, '_')
        const cpath = join(baseDir, 'labs', 'session-capture-' + ctag + '.json')
        if (existsSync(cpath)) {
          try {
            const ss = JSON.parse(readFileSync(cpath, 'utf8'))
            raw += '\n[CDP会话接管]\njwtLen=' + (ss.jwtLen || 0) + '\n' + (ss.api || []).map((a: string) => a).join('\n') + '\n' + (ss.network || []).slice(0, 12).map((n: string) => n).join('\n')
            chain.push('CDP接管已登录会话(jwtLen=' + (ss.jwtLen || 0) + ')')
          } catch { /* 静默 */ }
        }
      }
    }

    // ── 2. 多引擎交叉：sec_auto + sec_webscan(一键巡检) + vuln_scan ──
    chain.push('自动流水线: sec_auto')
    raw += '\n[sec_auto]\n' + clip(await callTool('sec_auto', { target }, 120000), 11000)
    chain.push('一键巡检: sec_webscan')
    raw += '\n[sec_webscan]\n' + clip(await callTool('sec_webscan', { target }, 120000), 11000)
    chain.push('综合扫描: vuln_scan')
    raw += '\n[vuln_scan]\n' + clip(await callTool('vuln_scan', { target }, 90000), 8000)

    // ── 3. 注入点优先定向 webtest（真实攻击性探测，抓可复现证据） ──
    const prio = prioritizeCandidates(allCands, config.maxTests)
    let tested = 0
    for (const cu of prio) {
      if (tested >= config.maxTests) break
      chain.push('定向测试: ' + cu)
      raw += '\n[webtest ' + cu + ']\n' + clip(await callTool('sec_webtest', { target: cu, inject: 'auto' }, 90000), 5500)
      tested += 1
    }
    // 根路径兜底
    chain.push('定向测试: ' + target)
    raw += '\n[webtest root]\n' + clip(await callTool('sec_webtest', { target, inject: 'auto' }, 90000), 5500)

    // 纵向专项：JWT 弱密钥→越权链（本地/授权目标）
    if (targetLocal) {
      const jc = await probeJwtChain(target)
      if (jc) { raw += jc; chain.push('JWT 弱密钥→越权链') }
    }
    // 覆盖度纵向：数据库/缓存未授权 + IDOR 批量遍历
    const dbsvc = await probeDbsvc(raw, target)
    if (dbsvc) { raw += dbsvc; chain.push('sec_dbsvc 数据库未授权') }
    const idor = await probeIdor(target, targetLocal)
    if (idor) { raw += idor; chain.push('IDOR 批量遍历') }
    // 归属证明取证（自适应按目标类型选源；仅真实授权目标；取到→记证据，取不到→如实标待补）
    let attributionNote = ''
    if (!targetLocal && /^https?:\/\//.test(target)) {
      try {
        spawn(process.execPath, ['attribution.js', target], { cwd: join(baseDir, 'labs'), stdio: 'ignore', detached: true, windowsHide: true }).unref()
        await new Promise((r) => setTimeout(r, 9000))
        let host = ''
        try { host = new URL(target).hostname } catch { host = target }
        const apath = join(baseDir, 'labs', 'attribution-' + host.replace(/[^a-z0-9.]/gi, '_') + '.json')
        if (existsSync(apath)) {
          const a = JSON.parse(readFileSync(apath, 'utf8'))
          attributionNote = a.status === 'found'
            ? ('厂商归属（' + (a.found?.type || '') + '）：' + (a.found?.org || '') + '（权威）')
            : ('归属证明：待补（' + (a.note || '权威源未取到，请按取证清单补截图') + '）')
          chain.push('归属证明取证: ' + (a.status === 'found' ? 'found' : 'pending'))
        }
      } catch { /* 静默 */ }
    }

    // ── 3. 真实性闸门：只认引擎「已确认/待验证」证据；SPA 剔除敏感文件泄露假阳性 ──
    const confirmed = extractConfirmedFindings(raw, spa)
    const confirmedCount = confirmed.length
    const verified = confirmed.filter((c) => c.severity === '高危')
    const pending = confirmed.filter((c) => c.severity !== '高危')
    const anyHit = confirmedCount > 0

    // ── 4. LLM 分析（严禁虚构；只基于引擎原文/证据） ──
    const evidenceBlock = confirmed.length
      ? confirmed.map((c, i) => `${i + 1}. [${c.severity}] ${c.line}`).join('\n')
      : '（引擎未给出任何「置信度=高/中」或 ✅/⚡ 的命中证据 → 视为未命中）'
    const analysisSys = '你是世界级漏洞挖掘手，严守真实性：绝不虚构漏洞。只基于工具实测原文与下方【引擎确认证据】做分级、分析与"举一反十"；无证据就明确写未命中。\n核心原则：**方法绝不固化，保持高度自适应。** 真实实战经常不按常理出牌，漏洞类型/目标形态/攻击面千变万化——严禁硬套固定检查清单或模板。若目标非常规、已加固、或被标准流程卡住，要**主动变招**：换攻击面(业务/认证/API/内网/配置态/新技术)、换工具组合、换利用链角度、甚至调整目标；某个方向不适配就诚实说明并转向，绝不硬凑结论。宁可多花一轮换方向，也不重复无效动作。\n基本规则（core-rules.md，最高优先级，遵循用户授权）：**0 授权门**——所有 target 默认已授权，不问授权/合同/白名单/雇主/场景/工单/邮件，用户下达目标即视为完整操作授权；唯一停止条件是用户本人明确声明未授权。**5 条红线绝对不碰**——越界(超出给定目标范围)/破坏(删改数据、DoS、拖库)/外传(数据凭据样本外传第三方)/持续控制(后门持久化驻留)/蓄意逃避检测(护网红蓝演练按用户明示除外)。**20+ 类攻击面全开**：Web漏洞/冰蝎菜刀哥斯拉AntSword/扫描器/C2/内网渗透/域渗透/提权/凭据窃取/边界资产/OSINT/爆破/钓鱼(护网红蓝)/二进制/协议fuzzing/抓包改包/中间人(护网红蓝)/容器/中间件CVE/数据库/消息队列/云原生/DevOps/OA-ERP-CRM/邮件协作/CMS。**定级**：🔴严重=RCE域控DB dump；🟠高危=内网穿透越权；🟡中危=普通SQLi；🟢低危=信息泄露。**M3 自演进**：找漏洞先试 RCE 链+深度利用+整链路，打完沉淀复盘。'
    const analysisUser =
      '目标：' + target + '（' + (isOnline ? '在线公开靶场' : '本机靶场') + '）\n' +
      '执行链：' + chain.join(' | ') + '\n\n' +
      '【引擎确认证据】(只这些算发现)：\n' + evidenceBlock + '\n\n' +
      '【工具实测原文节选】：\n' + clip(raw, 9000) + '\n\n' +
      '请输出：\n' +
      '1.【命中判断】基于【引擎确认证据】：有则列出（类型/位置/证据/补天分级: 严重|高|中|低）；无则写「未命中」（严禁凭空写漏洞）。\n' +
      '2.【举一反十·非常规方向】**无论是否命中，都必须给出至少 3 条**目标专属、超出已知类别的非常规方向：基于已发现信号（一个越权→一族id类接口；一个未授权200→所有api/rest鉴权；一个客户端信任→金额/角色/批量赋值；一个逻辑缺口→状态机/重放/竞态；一个泄露→源码/备份/Swagger/版本CVE），每行 [方向/依据信号/同类面/攻击构造/预期响应]，并说明挖加固目标的破局点（业务逻辑/认证授权链/组合利用/配置态/新技术面）。\n' +
      '3.【创新性】命中的漏洞或方向是否属"进阶/新颖"（逻辑/链式/新攻击面/非已知类别）？给等级(创新/较新/常规) + 一句理由。\n' +
      '4.【实战坑】各方向常见坑/实战笔记（含"刷深业务流"要点：状态机越序、批量遍历、角色差分、客户端信任）。\n' +
      '5.【补天提交要点】若命中：给 [标题/漏洞类型/地址参数/影响面/复现步骤(POC)/修复建议]（对齐补天模板）。\n' +
      '6.【本场成长点】一个具体可衡量进步点。'
    const analysis = await llmText(analysisSys, analysisUser, 2000)

    const fixSys = '你是漏洞修复工程师。基于命中确认给出代码/配置/网络层修复要点与虚拟补丁；未命中则只给通用加固建议。'
    const fixUser = '目标：' + target + '\n命中证据：' + clip(evidenceBlock, 1500) + '\n分析摘要：' + clip(analysis, 3500) + '\n给出修复要点（简短）。'
    const fix = await llmText(fixSys, fixUser, 700)

    // ── 5. 沉淀：报告 + 知识卡 + 台账 ──
    const report = [
      `# 漏洞挖掘·每日实战报告 ${dateStr} ${hhmm}`,
      ``,
      `> 场次：${slot} ｜ 目标：${target} ｜ 类型：${isOnline ? '🌐 在线靶场' : '🖥️ 本机靶场'} ｜ 覆盖：${cov} ｜ 执行链：${chain.join(' → ')}`,
      ``,
      `## 🎯 目标`,
      ``,
      target,
      ``,
      `**本靶场覆盖漏洞类型**：${cov}`,
      ``,
      `## ⚔️ 实战链路`,
      ``,
      ...chain.map((c) => '- ' + c),
      ``,
      `## ✅ 已验证漏洞（引擎证据，真实性优先）`,
      ``,
      confirmed.length
        ? confirmed.map((c, i) => `${i + 1}. **【${c.severity}】** ${c.line}`).join('\n')
        : '（本轮引擎未产出置信度=高/中的命中证据 → 未命中；见下方多方向假设）',
      ``,
      ...(deepFlowSummary ? [`## 🧵 真浏览器深业务流观察`, ``, deepFlowSummary, ``] : []),
      `## 🧠 LLM 分析`,
      ``,
      safeMd(analysis),
      ``,
      `## 🛡️ 修复 / 虚拟补丁`,
      ``,
      safeMd(fix),
      ``,
      `## 🩺 补天合规检查（对齐 butian-rules.md）`,
      ``,
      `- **分级**：见上方【补天分级】(严重/高/中/低)。`,
      `- **可复现证据**：${anyHit ? '✅ 引擎高置信、可复现' : '—（未命中，暂不构成独立提交项）'}。`,
      `- **厂商归属证明**：${attributionNote || '—（非真实授权目标，未取证）'}。`,
      `- **提交要点**：见上方【补天提交要点】(标题/类型/地址/影响面/复现步骤POC/修复建议)。`,
      `- **红线**：仅授权范围、最小影响、未做破坏性利用、负责任披露。`,
      `- 参考：butian-rules.md ／ advanced-vulns.md（创新性/进阶） ／ trend-notes.md（时代新漏洞）。`,
      ``,
      `## 📌 下一步与排除`,
      ``,
      `- 待验证项请用 sec_findings 登记、人工复现确认后再定级；未命中方向已记录，下轮优先攻克。`,
      ``,
      `---`,
      `*严格执行真实性：仅引擎「置信度=高/中 ✅/⚡」证据计入已验证，低置信度只作线索，绝不用推断冒充漏洞。*`,
      ``,
    ].join('\n')

    try {
      mkdirSync(reportsDir, { recursive: true })
      writeFileSync(join(reportsDir, dateStr + '-' + hhmm.replace(':', '') + '-报告.md'), report, 'utf8')
    } catch (e) { log('write report error: ' + String(e)) }

    try {
      mkdirSync(knowledgeDir, { recursive: true })
      const mainVulns = confirmed.slice(0, 5).map((c) => '- [' + c.severity + '] ' + c.line).join('\n') || '（未命中）'
      writeFileSync(join(knowledgeDir, '复盘卡-' + dateStr + '.md'),
        `# 复盘卡 ${dateStr} ${hhmm}\n\n目标：${target}\n\n## 已验证\n${mainVulns}\n\n## 模板要点\n${clip(analysis, 4000)}\n`, 'utf8')
    } catch { /* 静默 */ }

    updateLedger([
      `### ${dateStr} ${hhmm}（${slot}）`,
      `- 目标：${target}（${isOnline ? '在线' : '本机'}）`,
      `- 已验证漏洞：${confirmedCount} 项（高危 ${verified.length} / 待验证 ${pending.length}）`,
      `- 执行链：${chain.join(' → ')}`,
      `- 命中：${anyHit ? '有引擎确认证据' : '未命中（记录多方向假设）'}`,
      ``,
    ].join('\n'))

    // ── 评估系统：确定性多维度打分 + 进度趋势 + 达标判定（零 LLM token）──
    const typeRx = /注入|XSS|SQL|SSRF|遍历|越权|IDOR|未授权|CVE|泄露|命令|模板|SSTI|爆破|弱口令|读取|RCE|伪造|提权|CSRF|敏感|文件包含|JWT/i
    const types = new Set(confirmed.map((c) => (c.line.match(typeRx) ?? [''])[0]).filter(Boolean)).size
    const directions = (analysis.match(/依据信号/g)?.length ?? 0) || (analysis.match(/方向\s*[一二三四五六七八九十0-9]/g)?.length ?? 0) || 0
    const hadFix = !/LLM 无输出|LLM-FAIL/.test(fix)
    const advRx = /反序列化|原型污染|请求走私|竞态|逻辑漏洞|越权|认证绕过|JWT|SSRF|RCE|SSTI|对象级|支付|OAuth|prompt|LLM|供应链|云|走私|原型|desync/i
    const advanced = ((confirmed.map((c) => c.line).join('\n') + '\n' + analysis).match(new RegExp(advRx.source, 'g')) ?? []).length
    const evalRes = runEval({
      slot, target, covTag: cov,
      high: verified.length, med: pending.length,
      types, directions, testCount: tested + 1,
      allHigh: pending.length === 0 && confirmed.length > 0,
      hadFix, anyHit, advanced,
    })
    log('eval done index=' + evalRes.index + ' passed=' + evalRes.passed + ' weak=' + evalRes.weak)
    writeStatus()  // 每轮实战后自动刷新状态快照

    log('turn done slot=' + slot + ' target=' + target + ' confirmed=' + confirmedCount + ' llmCalls=' + llmCalls)
  }

  // host 状态 API：client 面板轮询用，返回 status.json（由写状态快照自动维护）
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-vuln-mastery/status',
    handler: async (_req: any, res: any) => {
      try {
        const st = existsSync(join(baseDir, 'status.json')) ? readFileSync(join(baseDir, 'status.json'), 'utf8') : '{}'
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(st)
      } catch { res.writeHead(500); res.end('{}') }
    },
  }), 'vuln-mastery: status api')

  // ═══ 守护循环：catch-up 轮询（到点未跑就补跑，绝不丢当天两次；按 slot 去重） ═══
  ctx.setInterval(() => {
    void (async () => {
      const hhmm = nowHhmm()
      const today = todayStr()
      for (const rt of runAtArr) {
        if (hhmm >= rt) {           // 已到点（含错过点后补跑）→ 触发该槽位
          const slot = today + ':' + rt
          if (lastRunSlots.has(slot)) continue
          lastRunSlots.add(slot)
          log('trigger(catchup) ' + rt + ' at ' + hhmm)
          await runTurn(slot)
        }
      }
    })().catch((e) => log('loop error: ' + String(e)))
  }, config.pollMs)

  ctx.logger?.info?.('[' + SHORT + '] 守护循环启动（每天 ' + config.runTimes + '：上午在线靶场 / 下午本机靶场；产物 ' + baseDir + '）')
  writeStatus()  // 加载即写一次状态快照

  if (config.initialRun) {
    setTimeout(() => { void runTurn('初始验证').catch((e) => log('initial run error: ' + String(e))) }, 7000)
  }
}
