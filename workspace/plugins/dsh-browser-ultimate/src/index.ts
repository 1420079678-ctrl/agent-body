/**
 * @dsh-external/dsh-browser-ultimate — 无敌浏览器控制插件
 *
 * 综合两大能力：
 *  A. bb-browser（坏孩子浏览器）引擎：控制「你的真实 Chrome」（CDP），登录态天然可用、
 *     反爬免疫（它就是用户）、36 平台 103 站点适配器、network 抓包、eval、多标签。
 *  B. crawl4ai 式内容提取管线：正文净化（Readability 打分器）、整站 BFS 深爬、
 *     CSS 结构化提取、链接清单——全部跑在真实浏览器里（登录态下抓取）。
 *
 * 架构：插件(DSH web 进程内) → spawn 真实 Chrome(--remote-debugging-port)
 *       → spawn bb-browser daemon(HTTP 127.0.0.1:19824, Bearer token)
 *       → 工具经 POST /command 分发。
 * 生命周期：engine.json 持久化，重启复用；ctx.effect dispose 时优雅停机。
 *
 * 高性能铁律：schema 精简（短句），详解放 tool result。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { BrowserEngine } from './engine.js'
import { daemonCommand, DaemonError, trimJson, extractTab } from './api.js'
import { EXTRACT_CONTENT_JS, EXTRACT_LINKS_JS, EXTRACT_CSS_JS, FETCH_JS, deepCrawl, resolveShotPath } from './extract.js'
import { BUILTIN_ADAPTERS, findBuiltin } from './adapters.js'
import { findChromeExecutable, defaultDataDir } from './paths.js'

export const name = '@dsh-external/dsh-browser-ultimate'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  dataDir: string
  cdpPort: number
  daemonPort: number
  chromePath: string
  windowSize: string
  timeoutMs: number
}

export const Config = z.object({
  dataDir: z.string().default(''),
  cdpPort: z.number().default(9222),
  daemonPort: z.number().default(19824),
  chromePath: z.string().default(''),
  windowSize: z.string().default('1920,1080'),
  timeoutMs: z.number().default(35000),
})

const TOOL_NAMES = [
  '_dsh_external_dsh_browser_ultimate_status',
  '_dsh_external_dsh_browser_ultimate_open',
  '_dsh_external_dsh_browser_ultimate_snap',
  '_dsh_external_dsh_browser_ultimate_act',
  '_dsh_external_dsh_browser_ultimate_eval',
  '_dsh_external_dsh_browser_ultimate_fetch',
  '_dsh_external_dsh_browser_ultimate_debug',
  '_dsh_external_dsh_browser_ultimate_shot',
  '_dsh_external_dsh_browser_ultimate_crawl',
  '_dsh_external_dsh_browser_ultimate_links',
  '_dsh_external_dsh_browser_ultimate_extract',
  '_dsh_external_dsh_browser_ultimate_deepcrawl',
  '_dsh_external_dsh_browser_ultimate_site',
]
const CORE_TOOL = '_dsh_external_dsh_browser_ultimate_status'

export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir || defaultDataDir(process.env.DSH_HOME || process.cwd())
  const engine = new BrowserEngine({
    dataDir,
    cdpPort: config.cdpPort,
    daemonPort: config.daemonPort,
    chromePath: config.chromePath || null,
    windowSize: config.windowSize,
    logFile: `${dataDir}/engine.log`,
  })

  /** 自动解析当前激活 tab（未指定时） */
  async function autoTab(tab?: string): Promise<string> {
    if (tab) return tab
    const res = await daemonCommand(engine, 'tab_list', {}, 15000)
    const tabs: Array<{ tab: string; active?: boolean; url?: string; title?: string }> = res.result.tabs ?? []
    const active = tabs.find((t) => t.active) ?? tabs[0]
    if (!active) throw new DaemonError('没有可用标签页，请先 browser_open 打开一个页面', '用 _dsh_external_dsh_browser_ultimate_open 打开 URL 后再试')
    return active.tab
  }

  /** 统一错误处理 */
  function wrap(fn: (args: any) => Promise<string>): (args: any) => Promise<string> {
    return async (args: any) => {
      try {
        return await fn(args)
      } catch (e) {
        if (e instanceof DaemonError) {
          return `错误：${e.message}${e.hint ? `\n提示：${e.hint}` : ''}`
        }
        return `错误：${(e as Error).message}`
      }
    }
  }

  /** 打开 URL（可选等待），返回 tab/url/title */
  async function openUrl(url: string, tab?: string, waitMs?: number): Promise<string> {
    const open = await daemonCommand(engine, 'open', tab ? { url, tab } : { url }, config.timeoutMs)
    const newTab = extractTab(open, tab)
    const wait = waitMs ?? 1000
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const list = await daemonCommand(engine, 'tab_list', {}, 10000)
    const tabs: Array<{ tab: string; url?: string; title?: string }> = list.result.tabs ?? []
    const found = tabs.find((t) => t.tab === newTab) ?? tabs.find((t) => t.url === url)
    const title = found?.title ?? open.result.title ?? ''
    const finalUrl = found?.url ?? url
    return trimJson({ tab: newTab, url: finalUrl, title })
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1. status —— 引擎健康/启动/停止
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[0],
    description: '浏览器引擎状态：启动/停止/重启真实 Chrome + bb-browser daemon，返回标签页与浏览器版本。首次使用前调用一次',
    parameters: {
      action: { type: 'string', description: 'status(默认)/start/stop/restart' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(args: { action?: string }) {
      const action = args.action ?? 'status'
      if (action === 'stop') {
        await engine.stop()
        return '引擎已停止（Chrome + daemon 已关闭，登录态保留在 profile 中）'
      }
      if (action === 'restart') {
        await engine.stop()
        await engine.ensure()
      } else if (action === 'start') {
        await engine.ensure()
      }
      const st = await engine.status()
      const chrome = st.chromePath ?? '(未检测到，请安装 Chrome 或配置 chromePath)'
      const tabs = (st.tabs ?? []) as Array<{ url?: string; title?: string; tab?: string }>
      return trimJson({
        ready: st.ready,
        browser: st.browser,
        chromeAlive: st.chromeAlive,
        daemonAlive: st.daemonAlive,
        cdpPort: st.cdpPort,
        daemonPort: st.daemonPort,
        chromePath: chrome,
        detail: st.detail,
        tabCount: tabs.length,
        tabs: tabs.slice(0, 20).map((t) => ({ tab: t.tab, title: t.title?.slice(0, 60), url: t.url?.slice(0, 120) })),
        loginProfile: `${dataDir}/chrome-data（登录态持久化于此）`,
        logFile: engine.logFile,
      })
    },
  })), 'dsh-browser-ultimate: status')

  // ═══════════════════════════════════════════════════════════════════════
  // 2. open —— 打开 URL（新标签或当前标签导航）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[1],
    description: '在真实浏览器打开 URL：默认新标签页；action=goto 在当前标签导航；waitMs 渲染等待',
    parameters: {
      url: { type: 'string', required: true, description: 'URL' },
      tab: { type: 'string', description: '标签短 id（goto 时必填，或自动取当前激活标签）' },
      action: { type: 'string', description: 'new(默认)/goto' },
      waitMs: { type: 'number', description: '打开后等待毫秒（SPA 渲染），默认 1000' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { url: string; tab?: string; action?: string; waitMs?: number }) => {
      if (!args.url) throw new DaemonError('缺少 url 参数')
      let url = args.url
      if (!/^https?:/.test(url)) url = 'https://' + url
      if (args.action === 'goto') {
        const tab = await autoTab(args.tab)
        const res = await daemonCommand(engine, 'goto', { url, tab }, config.timeoutMs)
        if (args.waitMs) await new Promise((r) => setTimeout(r, args.waitMs))
        const list = await daemonCommand(engine, 'tab_list', {}, 10000)
        const t = (list.result.tabs ?? []).find((x: any) => x.tab === tab)
        return trimJson({ tab, url, title: t?.title ?? '' })
      }
      return await openUrl(url, undefined, args.waitMs)
    }),
  })), 'dsh-browser-ultimate: open')

  // ═══════════════════════════════════════════════════════════════════════
  // 3. snap —— 可访问性树快照（交互元素带 ref 编号）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[2],
    description: '页面快照（可访问性树，交互元素带 ref 编号供 click/fill 使用）。自动取当前激活标签',
    parameters: {
      tab: { type: 'string', description: '标签短 id' },
      interactive: { type: 'boolean', description: '只显示交互元素' },
      compact: { type: 'boolean', description: '压缩空结构节点' },
      maxDepth: { type: 'number', description: '限制树深度' },
      selector: { type: 'string', description: 'CSS 选择器限定快照范围' },
      limit: { type: 'number', description: '输出字符上限，默认 12000' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { tab?: string; interactive?: boolean; compact?: boolean; maxDepth?: number; selector?: string; limit?: number }) => {
      const tab = await autoTab(args.tab)
      const params: Record<string, unknown> = { tab }
      if (args.interactive !== undefined) params.interactive = args.interactive
      if (args.compact !== undefined) params.compact = args.compact
      if (args.maxDepth !== undefined) params.maxDepth = args.maxDepth
      if (args.selector !== undefined) params.selector = args.selector
      const res = await daemonCommand(engine, 'snap', params, 30000)
      const snap = res.result.snapshotData ?? res.result
      const title = res.result.title ?? ''
      const url = res.result.url ?? ''
      const body = typeof snap === 'string' ? snap : trimJson(snap)
      return `标题: ${title}\nURL: ${url}\n${body.slice(0, args.limit ?? 12000)}`
    }),
  })), 'dsh-browser-ultimate: snap')

  // ═══════════════════════════════════════════════════════════════════════
  // 4. act —— 交互（click/fill/type/press/scroll/select/hover/check/uncheck）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[3],
    description: '页面交互：click/hover/fill/type(不清空追加)/press(按键)/scroll/select/check/uncheck。元素用 snap 的 ref 编号',
    parameters: {
      action: { type: 'string', required: true, description: 'click|hover|fill|type|press|scroll|select|check|uncheck' },
      ref: { type: 'string', description: 'snap 返回的元素 ref（click/hover/fill/type/select/check/uncheck 需要）' },
      text: { type: 'string', description: 'fill/type 的文本' },
      key: { type: 'string', description: 'press 的按键，如 Enter / Tab / Control+a' },
      value: { type: 'string', description: 'select 的选项值' },
      direction: { type: 'string', description: 'scroll 方向 up/down/left/right' },
      pixels: { type: 'number', description: 'scroll 距离，默认 300' },
      tab: { type: 'string', description: '标签短 id' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { action: string; ref?: string; text?: string; key?: string; value?: string; direction?: string; pixels?: number; tab?: string }) => {
      const action = args.action
      const needsRef = ['click', 'hover', 'fill', 'type', 'select', 'check', 'uncheck'].includes(action)
      if (needsRef && !args.ref) throw new DaemonError(`${action} 需要 ref 参数（先 browser_snap 获取）`)
      const tab = await autoTab(args.tab)
      const params: Record<string, unknown> = { tab }
      if (args.ref !== undefined) params.ref = args.ref
      if (args.text !== undefined) params.text = args.text
      if (args.key !== undefined) params.key = args.key
      if (args.value !== undefined) params.value = args.value
      if (args.direction !== undefined) params.direction = args.direction
      if (args.pixels !== undefined) params.pixels = args.pixels
      const res = await daemonCommand(engine, action, params, 30000)
      return trimJson({ ok: true, tab: res.result.tab, seq: res.result.seq, value: res.result.value })
    }),
  })), 'dsh-browser-ultimate: act')

  // ═══════════════════════════════════════════════════════════════════════
  // 5. eval —— 页面内执行 JS
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[4],
    description: '在页面上下文执行 JS（真实浏览器，可读 DOM/调用页面函数），返回可序列化结果。args 为 JSON 字符串，脚本写成函数表达式接收第一个参数',
    parameters: {
      script: { type: 'string', required: true, description: 'JS 函数表达式，如 (a)=>{return document.title} 或 (a)=>{return a.x+1}' },
      tab: { type: 'string', description: '标签短 id' },
      domain: { type: 'string', description: '按域名路由（自动找匹配标签或新建），与 tab 二选一' },
      args: { type: 'string', description: 'JSON 字符串，作为脚本第一个参数传入' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { script: string; tab?: string; domain?: string; args?: string }) => {
      if (!args.script) throw new DaemonError('缺少 script 参数')
      const params: Record<string, unknown> = { script: args.script }
      if (args.tab) params.tab = args.tab
      if (args.domain) params.domain = args.domain
      if (args.args) {
        try { params.args = JSON.parse(args.args) } catch { throw new DaemonError('args 不是合法 JSON') }
      }
      const res = await daemonCommand(engine, 'eval', params, config.timeoutMs)
      return trimJson({ result: res.result.result, tab: res.result.tab })
    }),
  })), 'dsh-browser-ultimate: eval')

  // ═══════════════════════════════════════════════════════════════════════
  // 6. fetch —— 带登录态的 fetch
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[5],
    description: '带登录态 fetch：在页面上下文用浏览器 Cookie 请求接口（credentials include）。跨域读取受 CORS 限制，同源最稳',
    parameters: {
      url: { type: 'string', required: true, description: '请求 URL' },
      method: { type: 'string', description: 'GET(默认)/POST/PUT/DELETE' },
      headers: { type: 'string', description: '请求头 JSON 字符串' },
      body: { type: 'string', description: '请求体（JSON 字符串或原始文本）' },
      tab: { type: 'string', description: '使用哪个标签页的上下文（默认当前激活标签）' },
      maxLen: { type: 'number', description: '响应文本截断长度，默认 200000' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { url: string; method?: string; headers?: string; body?: string; tab?: string; maxLen?: number }) => {
      if (!args.url) throw new DaemonError('缺少 url 参数')
      let headers: Record<string, string> = {}
      if (args.headers) { try { headers = JSON.parse(args.headers) } catch { throw new DaemonError('headers 不是合法 JSON') } }
      const tab = await autoTab(args.tab)
      const res = await daemonCommand(engine, 'eval', {
        script: FETCH_JS,
        args: { url: args.url, method: args.method ?? 'GET', headers, body: args.body },
        tab,
      }, config.timeoutMs)
      const r = res.result.result as any
      if (r?.text && args.maxLen && r.text.length > args.maxLen) r.text = r.text.slice(0, args.maxLen) + '…'
      return trimJson(r, 20000)
    }),
  })), 'dsh-browser-ultimate: fetch')

  // ═══════════════════════════════════════════════════════════════════════
  // 7. debug —— network/console/errors/cookies/source/trace
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[6],
    description: '调试观察：network(抓包)/console/errors/cookies/source grep/trace 时间线',
    parameters: {
      kind: { type: 'string', required: true, description: 'network|console|errors|cookies|source|trace' },
      action: { type: 'string', description: 'network: requests(默认)/route/unroute/clear；console/errors: get(默认)/clear；source: grep；trace: start/stop/status/events/body' },
      tab: { type: 'string', description: '标签短 id' },
      filter: { type: 'string', description: 'URL/文本子串过滤' },
      since: { type: 'string', description: '增量游标：last_action 或 seq 号' },
      method: { type: 'string', description: 'HTTP 方法过滤' },
      status: { type: 'string', description: '状态码过滤：4xx/5xx/200' },
      limit: { type: 'number', description: '结果条数上限' },
      withBody: { type: 'boolean', description: 'network 是否带请求/响应体' },
      excludeStatic: { type: 'boolean', description: '过滤静态资源' },
      pattern: { type: 'string', description: 'source grep 的模式' },
      requestId: { type: 'string', description: 'trace body 的请求 id' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { kind: string; action?: string; tab?: string; filter?: string; since?: string; method?: string; status?: string; limit?: number; withBody?: boolean; excludeStatic?: boolean; pattern?: string; requestId?: string }) => {
      const kind = args.kind
      const method = kind === 'source' ? 'source' : kind
      const params: Record<string, unknown> = {}
      if (args.action !== undefined) params.action = args.action
      if (args.filter !== undefined) params.filter = args.filter
      if (args.since !== undefined) params.since = args.since
      if (args.method !== undefined) params.method = args.method
      if (args.status !== undefined) params.status = args.status
      if (args.limit !== undefined) params.limit = args.limit
      if (args.withBody !== undefined) params.withBody = args.withBody
      if (args.excludeStatic !== undefined) params.excludeStatic = args.excludeStatic
      if (args.pattern !== undefined) params.pattern = args.pattern
      if (args.requestId !== undefined) params.requestId = args.requestId
      if (kind !== 'trace') {
        const tab = await autoTab(args.tab)
        params.tab = tab
      } else if (args.tab) {
        params.tab = args.tab
      }
      const res = await daemonCommand(engine, method, params, 30000)
      return trimJson(res.result, 16000)
    }),
  })), 'dsh-browser-ultimate: debug')

  // ═══════════════════════════════════════════════════════════════════════
  // 8. shot —— 截图
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[7],
    description: '页面截图保存为 PNG，返回文件路径',
    parameters: {
      tab: { type: 'string', description: '标签短 id' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { tab?: string }) => {
      const tab = await autoTab(args.tab)
      const res = await daemonCommand(engine, 'screenshot', { tab }, 30000)
      const pinix = res.result.path as string
      const file = resolveShotPath(pinix, dataDir)
      return trimJson({ file, tab: res.result.tab, note: '可直接用 read_image 工具查看' })
    }),
  })), 'dsh-browser-ultimate: shot')

  // ═══════════════════════════════════════════════════════════════════════
  // 9. crawl —— 正文净化抓取（crawl4ai 式，跑在真实浏览器）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[8],
    description: '抓取并净化正文（Readability 打分器）：给 URL 或当前标签页，返回 标题/作者/正文/字数。登录态下可抓登录后内容',
    parameters: {
      url: { type: 'string', description: '目标 URL（不传则用当前激活标签页）' },
      tab: { type: 'string', description: '标签短 id（url 未传时）' },
      maxLength: { type: 'number', description: '正文截断字符数，默认 20000' },
      waitMs: { type: 'number', description: '打开后等待毫秒，默认 1500' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { url?: string; tab?: string; maxLength?: number; waitMs?: number }) => {
      let tab: string
      if (args.url) {
        const open = await daemonCommand(engine, 'open', { url: /^https?:/.test(args.url) ? args.url : 'https://' + args.url }, config.timeoutMs)
        tab = extractTab(open)!
        await new Promise((r) => setTimeout(r, args.waitMs ?? 1500))
      } else {
        tab = await autoTab(args.tab)
      }
      const res = await daemonCommand(engine, 'eval', {
        script: EXTRACT_CONTENT_JS,
        args: { maxLength: args.maxLength ?? 20000 },
        tab,
      }, config.timeoutMs)
      return trimJson(res.result.result, 25000)
    }),
  })), 'dsh-browser-ultimate: crawl')

  // ═══════════════════════════════════════════════════════════════════════
  // 10. links —— 页面链接清单
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[9],
    description: '提取页面链接：内部链接（同源）+ 可选外部链接，去重并带锚文本',
    parameters: {
      url: { type: 'string', description: '目标 URL（不传则用当前激活标签页）' },
      tab: { type: 'string', description: '标签短 id' },
      includeExternal: { type: 'boolean', description: '是否包含外部链接，默认 false' },
      maxInternal: { type: 'number', description: '内部链接上限，默认 200' },
      maxExternal: { type: 'number', description: '外部链接上限，默认 20' },
      waitMs: { type: 'number', description: '打开后等待毫秒' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { url?: string; tab?: string; includeExternal?: boolean; maxInternal?: number; maxExternal?: number; waitMs?: number }) => {
      let tab: string
      if (args.url) {
        const open = await daemonCommand(engine, 'open', { url: /^https?:/.test(args.url) ? args.url : 'https://' + args.url }, config.timeoutMs)
        tab = extractTab(open)!
        await new Promise((r) => setTimeout(r, args.waitMs ?? 1000))
      } else {
        tab = await autoTab(args.tab)
      }
      const res = await daemonCommand(engine, 'eval', {
        script: EXTRACT_LINKS_JS,
        args: { maxInternal: args.maxInternal ?? 200, maxExternal: args.includeExternal ? (args.maxExternal ?? 20) : 0 },
        tab,
      }, config.timeoutMs)
      return trimJson(res.result.result, 16000)
    }),
  })), 'dsh-browser-ultimate: links')

  // ═══════════════════════════════════════════════════════════════════════
  // 11. extract —— CSS 结构化提取
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[10],
    description: 'CSS 结构化提取为 JSON：schema={baseSelector,fields:[{name,selector,type:text|html|attr|list|nested,attr?,fields?}]}',
    parameters: {
      schema: { type: 'string', required: true, description: '提取 schema 的 JSON 字符串' },
      url: { type: 'string', description: '目标 URL（不传则用当前激活标签页）' },
      tab: { type: 'string', description: '标签短 id' },
      waitMs: { type: 'number', description: '打开后等待毫秒' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { schema: string; url?: string; tab?: string; waitMs?: number }) => {
      let schema: any
      try { schema = JSON.parse(args.schema) } catch { throw new DaemonError('schema 不是合法 JSON') }
      let tab: string
      if (args.url) {
        const open = await daemonCommand(engine, 'open', { url: /^https?:/.test(args.url) ? args.url : 'https://' + args.url }, config.timeoutMs)
        tab = extractTab(open)!
        await new Promise((r) => setTimeout(r, args.waitMs ?? 1000))
      } else {
        tab = await autoTab(args.tab)
      }
      const res = await daemonCommand(engine, 'eval', {
        script: EXTRACT_CSS_JS,
        args: { schema },
        tab,
      }, config.timeoutMs)
      return trimJson(res.result.result, 20000)
    }),
  })), 'dsh-browser-ultimate: extract')

  // ═══════════════════════════════════════════════════════════════════════
  // 12. deepcrawl —— 整站 BFS 深爬（登录态）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[11],
    description: '整站 BFS 深爬（真实浏览器+登录态）：逐页抓 标题/字数/正文摘要，同源约束',
    parameters: {
      url: { type: 'string', required: true, description: '起始 URL' },
      maxPages: { type: 'number', description: '页数上限，默认 20（≤100）' },
      maxDepth: { type: 'number', description: 'BFS 深度，默认 2' },
      summaryLen: { type: 'number', description: '每页摘要长度，默认 500' },
      sameOriginOnly: { type: 'boolean', description: '仅同源，默认 true' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { url: string; maxPages?: number; maxDepth?: number; summaryLen?: number; sameOriginOnly?: boolean }) => {
      const { pages, visited } = await deepCrawl(engine, args.url, {
        maxPages: args.maxPages ?? 20,
        maxDepth: args.maxDepth ?? 2,
        summaryLen: args.summaryLen ?? 500,
        sameOriginOnly: args.sameOriginOnly ?? true,
      })
      return trimJson({ visited, crawled: pages.length, pages }, 30000)
    }),
  })), 'dsh-browser-ultimate: deepcrawl')

  // ═══════════════════════════════════════════════════════════════════════
  // 13. site —— 站点适配器（内置 4 个 + 社区 adapter）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAMES[12],
    description: '站点适配器：内置 wikipedia/summary、zhihu/hot、bilibili/video、github/search（真实登录态）；action=update 拉取社区适配器；action=run 走 daemon',
    parameters: {
      action: { type: 'string', required: true, description: 'list|info|run|update' },
      site: { type: 'string', description: 'adapter 名（如 zhihu/hot）' },
      args: { type: 'string', description: 'run 时的参数 JSON 字符串' },
      tab: { type: 'string', description: '指定标签页' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    execute: wrap(async (args: { action: string; site?: string; args?: string; tab?: string }) => {
      const action = args.action
      if (action === 'update') {
        const res = await daemonCommand(engine, 'site_update', {}, 60000)
        const sites = res.result.sites ?? res.result.adapters ?? res.result.updated ?? []
        return trimJson({ updated: Array.isArray(sites) ? sites.length : sites, hint: 'site list 查看社区适配器' }, 8000)
      }
      if (action === 'list') {
        const builtin = BUILTIN_ADAPTERS.map((a) => ({ name: a.name, description: a.description, builtin: true }))
        let community: any[] = []
        try {
          const res = await daemonCommand(engine, 'site_list', {}, 15000)
          community = (res.result.sites ?? res.result.adapters ?? []).map((s: any) => ({ name: s.name, description: s.description, builtin: false }))
        } catch { /* daemon 无社区 adapter 时忽略 */ }
        return trimJson({ builtin, community }, 10000)
      }
      if (action === 'info') {
        const name = args.site ?? ''
        const b = findBuiltin(name)
        if (b) return trimJson({ name: b.name, description: b.description, domain: b.domain, args: b.args, example: b.example, builtin: true })
        const res = await daemonCommand(engine, 'site_info', { siteName: name }, 15000)
        return trimJson(res.result, 8000)
      }
      if (action === 'run') {
        const name = args.site ?? ''
        let siteArgs: Record<string, string> = {}
        if (args.args) { try { siteArgs = JSON.parse(args.args) } catch { throw new DaemonError('args 不是合法 JSON') } }
        const b = findBuiltin(name)
        if (b) {
          const result = await b.run(engine, siteArgs)
          return trimJson(result, 16000)
        }
        const params: Record<string, unknown> = { siteName: name }
        if (args.tab) params.tab = args.tab
        if (Object.keys(siteArgs).length) params.siteArgs = siteArgs
        const res = await daemonCommand(engine, 'site_run', params, config.timeoutMs)
        return trimJson(res.result, 16000)
      }
      throw new DaemonError(`未知 action: ${action}（list|info|run|update）`)
    }),
  })), 'dsh-browser-ultimate: site')

  // ── 首轮锚定：会话无工具调用前只暴露 status ─────────────────────────────
  ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
    const assembled = await next()
    const agent = context.agent
    if (!agent || agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call')) return assembled
    const MINE = new Set(TOOL_NAMES)
    return {
      ...assembled,
      tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE_TOOL),
    }
  })

  // ── 插件卸载时停机引擎 ──────────────────────────────────────────────────
  ctx.effect(() => {
    const engineRef = engine
    return () => {
      engineRef.stop().catch(() => {})
    }
  }, 'dsh-browser-ultimate: engine lifecycle')
}
