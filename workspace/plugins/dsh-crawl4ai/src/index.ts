/**
 * @dsh-external/dsh-crawl4ai — DSH 世界级网页爬取工具包（v0.2）。
 *
 * 在 crawl4ai 0.9.x（67K+ star 的开源 LLM 友好爬虫）之上封装一个常驻 Python
 * worker（行协议 JSON-RPC over stdio），复用浏览器实例规避每次冷启动开销，
 * 并提供五个模型工具 + 可选 WebFetchProvider：
 *
 *   - `crawl4ai`        单页智能抓取（静态 HTTP 自适应 → 可升浏览器渲染 + 正文净化）
 *   - `crawl4ai_crawl`  整站深爬（BFS，同域，max_depth/max_pages 上限）
 *   - `crawl4ai_map`    站点地图（发现站内链接，不下载正文）
 *   - `crawl4ai_extract`CSS 选择器结构化提取（schema → JSON，本地免费）
 *   - `crawl4ai_links`  单页链接清单
 *
 * 设计取舍（吸收业界先进爬取技术优点、规避其缺点）：
 *   - 常驻 worker 复用浏览器（规避 crawl4ai 冷启动慢）；静态页 HTTP 优先、
 *     失败升浏览器（吸收 AdaptiveCrawler 与 Firecrawl 分级）；Pruning 内容过滤
 *     净化正文（吸收 Trafilatura/readability）；深爬/地图带保守上限（防失控）；
 *     结构化提取用本地 CSS 而非 LLM（规避 API key 与成本）；代理/UA 可配
 *     （吸收 Firecrawl 反爬）；WebFetchProvider 显式 opt-in（不破坏现有 http
 *     provider 的单 provider 选择语义）。
 *
 * @module @dsh-external/dsh-crawl4ai
 */

import type { Context } from '@deepseek-ai/cordis'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult, WebFetchBody } from '@deepseek-ai/dsh-web'

export const name = '@dsh-external/dsh-crawl4ai'
export const inject: string[] = ['tools']

export interface Config {
  /** Path to the Python interpreter with crawl4ai installed. Defaults to `python`. */
  pythonPath: string
  /** Per-request tool timeout in seconds. Default 60. */
  timeoutSeconds: number
  /** Idle shutdown delay in ms (worker exits after this long without a request). Default 5 min. */
  idleShutdownMs: number
  /** Default max_pages bound for deep-crawl and site-map tools. */
  defaultMaxPages: number
  /** Proxy URL for the browser (e.g. http://user:pass@host:port). Empty = system default. */
  proxy: string
  /** Register a `crawl4ai` WebFetchProvider so `web_fetch` can route through it. */
  registerAsFetchProvider: boolean
}

export const Config = z.object({
  pythonPath: z.string().default('python'),
  timeoutSeconds: z.number().min(5).default(60),
  idleShutdownMs: z.number().min(10_000).default(300_000),
  defaultMaxPages: z.number().min(1).default(50),
  proxy: z.string().default(''),
  registerAsFetchProvider: z.boolean().default(false),
})

// The Python worker is compiled alongside this JS (build.sh copies it to lib/).
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = join(PLUGIN_DIR, '_crawl4ai_worker.py')

// ═══════════════════════════════════════════════════════════════════════════
// 常驻 worker（Node 侧生命周期管理）
// ═══════════════════════════════════════════════════════════════════════════

type PendingCall = {
  resolve: (data: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** 行协议请求/响应 id（worker 端 echo 回传）。 */
let requestSeq = 0

/**
 * 管理 crawl4ai Python worker 子进程：状态机 idle/spawning/ready/dead，
 * 请求队列按 id 匹配响应，超时兜底，崩溃后下次调用自动重建，空闲超时回收。
 */
class CrawlWorker {
  private child: ChildProcess | null = null
  private rl: Interface | null = null
  private pending = new Map<string, PendingCall>()
  private state: 'idle' | 'spawning' | 'ready' | 'dead' = 'idle'
  private readonly pythonPath: string
  private readonly timeoutMs: number
  private readonly idleShutdownMs: number
  private idleTimer: NodeJS.Timeout | null = null
  private disposed = false
  /** 冷启动标志：spawn 后首个请求（含浏览器预热）超时放宽 3 倍，避免误杀。 */
  private coldStart = true
  /** 最近一次 spawn 的 stderr 尾巴（诊断用，随失败信息一并抛出）。 */
  private spawnErrTail = ''
  /** spawn 代数：代际守卫，防止旧 worker 的 close/error/line 晚到污染新 worker。 */
  private gen = 0

  constructor(pythonPath: string, timeoutMs: number, idleShutdownMs: number) {
    this.pythonPath = pythonPath
    this.timeoutMs = timeoutMs
    this.idleShutdownMs = idleShutdownMs
  }

  /**
   * 发起一次请求；worker 未就绪时先拉起。超时后强制回收 worker（挂起请求状态不可信）。
   * @param signal - 调用方取消信号：中止即强杀 worker 进程树（python + chromium 连带）并立刻拒绝——停止必须停止。
   */
  async call(cmd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.disposed) throw new Error('crawl4ai worker is disposed')
    if (signal?.aborted) throw new Error(`crawl4ai ${cmd} aborted before start`)
    await this.ensureReady(signal)
    if (signal?.aborted) {
      // 竞态兜底：abort 落在 spawn 完成/握手完成与监听器挂载之间时，此处立即终止。
      this.killWorker()
      throw new Error(`crawl4ai ${cmd} aborted during startup`)
    }
    this.armIdleTimer()
    const id = String(++requestSeq)
    const effectiveTimeout = this.coldStart ? this.timeoutMs * 3 : this.timeoutMs
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      // 用户停止：摘除本请求 → 强杀进程树（taskkill /T /F，chromium 不残留）→ 立即拒绝。
      const onAbort = (): void => {
        this.pending.delete(id)
        this.killWorker()
        cleanup()
        reject(new Error(`crawl4ai ${cmd} aborted by caller (worker tree terminated)`))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const note = this.coldStart ? ' (cold start: browser warm-up may exceed the base timeout)' : ''
        this.killWorker()
        cleanup()
        reject(new Error(`crawl4ai ${cmd} timed out after ${effectiveTimeout}ms${note}`))
      }, effectiveTimeout)
      this.pending.set(id, {
        resolve: (data) => { cleanup(); resolve(data) },
        reject: (error) => { cleanup(); reject(error) },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.child?.stdin?.write(JSON.stringify({ id, cmd, args }) + '\n')
    })
  }

  /** 强制回收 worker 进程树（Windows 下连带子进程，避免 chromium 残留）。 */
  private killWorker(): void {
    const child = this.child
    this.child = null
    this.rl = null
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error('crawl4ai worker recycled'))
    }
    this.pending.clear()
    if (child && !child.killed) {
      if (process.platform === 'win32' && child.pid) {
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.unref()
        } catch { child.kill() }
      } else {
        child.kill('SIGKILL')
      }
    }
    this.state = 'idle'
    this.coldStart = true
  }

  /** 确保 worker 进程就绪（首次 spawn 并等待 hello 握手）；signal 中止时终止等待并回收进程。 */
  private async ensureReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('crawl4ai worker startup aborted before spawn')
    if (this.state === 'ready') return
    if (this.state === 'dead') {
      // 崩溃重建：允许一次 spawn 重试，避免自旋。
      this.state = 'idle'
    }
    if (this.state === 'spawning') {
      // 并发调用共享同一次 spawn：等待 ready 信号。
      await this.waitForReady(signal)
      return
    }
    this.state = 'spawning'
    await this.spawn(signal)
    await this.waitForReady(signal)
  }

  private waitForReady(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 30_000 // 启动上限：防 worker 静默挂起时无限轮询
      const check = () => {
        if (signal?.aborted) { this.killWorker(); reject(new Error('crawl4ai worker startup aborted')); return }
        if (this.state === 'ready') resolve()
        else if (this.state === 'dead') reject(new Error('crawl4ai worker failed to start' + (this.spawnErrTail ? ': ' + this.spawnErrTail : '')))
        else if (Date.now() > deadline) { this.killWorker(); reject(new Error('crawl4ai worker startup timed out after 30s' + (this.spawnErrTail ? ': ' + this.spawnErrTail : ''))) }
        else setTimeout(check, 50)
      }
      check()
    })
  }

  /** spawn 并等待 hello 握手；signal 中止时杀掉子进程并立刻拒绝（不等握手）。 */
  private spawn(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonPath, [WORKER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'], // stderr 捕获尾部用于诊断；worker 正常日志已抑制
        shell: false,
        windowsHide: true,
      })
      this.child = child
      const gen = ++this.gen
      let settled = false
      const done = (fail: Error | null): void => {
        if (settled) return
        settled = true
        clearTimeout(handshakeTimer)
        signal?.removeEventListener('abort', onAbort)
        if (fail) reject(fail)
        else resolve()
      }
      const onAbort = (): void => {
        done(new Error('crawl4ai worker startup aborted'))
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      // stderr 尾巴采集（环形，最多 8 块）：python 启动失败时把原因带进错误消息。
      this.spawnErrTail = ''
      const errChunks: Buffer[] = []
      child.stderr?.on('data', (c: Buffer) => {
        errChunks.push(c)
        if (errChunks.length > 8) errChunks.shift()
        this.spawnErrTail = Buffer.concat(errChunks).toString('utf8').trim().slice(-600)
      })
      // 握手兜底：python 起来但迟迟不发 hello 时强杀并拒绝（默认 30s）。
      const handshakeTimer = setTimeout(() => {
        done(new Error('crawl4ai worker startup handshake timed out after 30s' + (this.spawnErrTail ? ': ' + this.spawnErrTail : ' (no stderr)')))
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      }, 30_000)

      const rl = createInterface({ input: child.stdout! })
      this.rl = rl
      rl.on('line', (line) => {
        if (this.child !== child) return // 代际守卫：旧 worker 晚到的行不污染新 worker
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          return // 非协议行（crawl4ai 的进度日志）静默忽略
        }
        const id = msg.id === null || msg.id === undefined ? null : String(msg.id)
        if (id === null) {
          // 握手/再见帧
          if (msg.ok === true && msg.data && (msg.data as Record<string, unknown>).hello === true) {
            done(null)
            this.state = 'ready'
          }
          return
        }
        const call = this.pending.get(id)
        if (!call) return
        this.pending.delete(id)
        clearTimeout(call.timer)
        this.coldStart = false // 首个请求已走完（含浏览器预热），后续按基准超时
        if (msg.ok === true) call.resolve((msg.data ?? {}) as Record<string, unknown>)
        else call.reject(new Error(String(msg.error ?? 'crawl4ai worker error')))
      })

      child.on('error', (err) => {
        done(new Error(`crawl4ai spawn failed: ${err.message}`))
        if (this.child === child) this.die()
      })

      child.on('close', () => {
        if (this.child !== child) return // 代际守卫：旧 worker 晚到的 close 不污染新 worker
        this.rl = null
        this.die()
        done(new Error('crawl4ai worker exited before ready' + (this.spawnErrTail ? ': ' + this.spawnErrTail : ' (no stderr)')))
      })
    })
  }

  private die(): void {
    const wasReady = this.state === 'ready'
    this.state = 'dead'
    this.child = null
    this.rl = null
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error('crawl4ai worker exited'))
    }
    this.pending.clear()
    if (wasReady && !this.disposed) {
      // 崩了之后允许重建；spawn 重试在 ensureReady 里处理。
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.shutdown()
    }, this.idleShutdownMs)
  }

  /** 优雅关闭：通知 worker 退出并回收进程。 */
  async shutdown(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    const child = this.child
    if (child && this.state === 'ready') {
      try {
        child.stdin?.write(JSON.stringify({ id: 'shutdown', cmd: 'shutdown', args: {} }) + '\n')
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { child.kill(); resolve() }, 2000)
          child.once('close', () => { clearTimeout(t); resolve() })
        })
      } catch { child.kill() }
    } else if (child) {
      child.kill()
    }
    this.child = null
    this.rl = null
    this.state = 'idle'
  }

  dispose(): void {
    this.disposed = true
    this.killWorker() // 同步强杀进程树：reload/卸载时异步优雅关闭来不及跑完会泄漏进程
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function truncateUrl(url: string, max: number): string {
  return url.length <= max ? url : url.slice(0, max - 3) + '...'
}

export function apply(ctx: Context, config: Config): void {
  const worker = new CrawlWorker(config.pythonPath, config.timeoutSeconds * 1000, config.idleShutdownMs)
  // cordis 标准 fiber 清理：reload/卸载时执行 yield 后的 cleanup（ctx.on('dispose') 不触发）
  ctx.effect(function* () {
    yield () => worker.dispose()
  }, 'dsh-crawl4ai.worker')

  const baseArgs = (extra: Record<string, unknown>) => ({
    user_agent: UA,
    ...(config.proxy ? { proxy: config.proxy } : {}),
    ...extra,
  })

  ctx.tools.register(defineTool({
    name: 'crawl4ai',
    description:
      'Crawl one web page with crawl4ai (LLM-friendly crawler) and return clean Markdown plus ' +
      'stats. Uses a persistent browser (JavaScript-heavy sites, SPAs OK) with content filtering ' +
      'that strips navigation and boilerplate. Returns { url, success, status_code, markdown, ' +
      'chars, word_count, title, internal_links, external_links, error }.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL to crawl (http/https).' },
      browser: { type: 'boolean', default: true, description: 'Use the browser (default true); disable for fast static-HTML-only fetch.' },
      cache: { type: 'boolean', default: true, description: 'Reuse crawl4ai\'s cache when present.' },
      max_length: { type: 'integer', default: 50000, description: 'Max markdown chars returned; truncated past this.' },
      word_count_threshold: { type: 'integer', default: 10, description: 'Drop content blocks below this word count (boilerplate removal).' },
      css_selector: { type: 'string', description: 'Optional: only crawl content matching this CSS selector.' },
      exclude_tags: { type: 'array', items: { type: 'string' }, description: 'Optional: strip these tags (e.g. ["nav","footer","aside"]).' },
      wait_for_ms: { type: 'integer', description: 'Optional: wait this many ms for dynamic content before extracting.' },
      js_code: { type: 'string', description: 'Optional: JavaScript to run after page load (e.g. same-origin fetch POST). Result is appended to the page text.' },
      timeout: { type: 'integer', default: 60000, description: 'Per-request timeout ms (max 300000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, success: { type: 'boolean' }, status_code: { type: 'integer' },
          markdown: { type: 'string' }, chars: { type: 'integer' }, word_count: { type: 'integer' },
          title: { type: 'string' }, internal_links: { type: 'integer' }, external_links: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: Record<string, unknown>) => {
        const v = value as Record<string, unknown>
        if (v.success === false) {
          return [{ type: 'text', text: `crawl4ai failed for ${String(v.url)}: ${String(v.error ?? '(no error)')}` }]
        }
        return [{
          type: 'text',
          text: `Crawled ${String(v.url)}${v.title ? ` — ${String(v.title)}` : ''}: ${Number(v.chars ?? 0).toLocaleString()} chars, ${Number(v.word_count ?? 0).toLocaleString()} words, ${Number(v.internal_links ?? 0)} internal links`,
        }]
      },
    },
    timeoutMs: Math.max(config.timeoutSeconds * 1000, 90_000),
    execute: (args, exec) => worker.call('crawl', baseArgs(args as Record<string, unknown>), exec.signal) as never,
    presentCall: args => ({ card: 'generic', title: `Crawl ${truncateUrl(String((args as Record<string, unknown>).url), 60)}`, kind: 'other', rawInput: String((args as Record<string, unknown>).url) }),
  }))

  ctx.tools.register(defineTool({
    name: 'crawl4ai_http',
    description:
      'Raw HTTP request through the crawl4ai browser network stack (Playwright APIRequestContext, ' +
      'ignores TLS certificate errors). Supports GET/POST/PUT/DELETE with custom headers and JSON ' +
      'body. Returns { url, success, status, headers, body, error }. Use when a target has an ' +
      'invalid/expired certificate or blocks non-browser clients.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL.' },
      method: { type: 'string', default: 'GET', description: 'HTTP method: GET/POST/PUT/DELETE/PATCH/HEAD.' },
      headers: { type: 'object', additionalProperties: true, description: 'Optional request headers (object).' },
      body: { type: 'string', description: 'Optional request body (JSON string for POST/PUT).' },
      timeout: { type: 'integer', default: 25000, description: 'Timeout ms.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, success: { type: 'boolean' }, status: { type: 'integer' },
          headers: { type: 'object', additionalProperties: true }, body: { type: 'string' }, error: { type: 'string' },
        },
      },
      render: (_args, value: Record<string, unknown>) => {
        const v = value as Record<string, unknown>
        if (v.success === false) return [{ type: 'text', text: `crawl4ai_http failed: ${String(v.error)}` }]
        const body = String((v.body as string) ?? '')
        return [{
          type: 'text',
          text: `HTTP ${String(v.status)} ${String(v.url)} — ${body.length} chars body\n${body.slice(0, 1500)}`,
        }]
      },
    },
    timeoutMs: Math.max(config.timeoutSeconds * 1000, 60_000),
    execute: (args, exec) => worker.call('http', args as Record<string, unknown>, exec.signal) as never,
    presentCall: args => ({ card: 'generic', title: `HTTP ${String((args as Record<string, unknown>).method ?? 'GET')} ${truncateUrl(String((args as Record<string, unknown>).url), 60)}`, kind: 'other', rawInput: String((args as Record<string, unknown>).url) }),
  }))

  ctx.tools.register(defineTool({
    name: 'crawl4ai_crawl',
    description:
      'Deep-crawl a website (breadth-first, same domain) and return Markdown for each page. ' +
      'Use for multi-page research: docs, blogs, site-wide content. Bounded by max_depth and ' +
      'max_pages to stay predictable. Returns { url, pages_crawled, pages: [{ url, title, ' +
      'status_code, markdown, chars }], error }.',
    parameters: {
      url: { type: 'string', required: true, description: 'Seed URL.' },
      max_depth: { type: 'integer', default: 2, description: 'BFS depth limit (default 2).' },
      max_pages: { type: 'integer', default: 20, description: `Total page cap (default ${config.defaultMaxPages} max).` },
      max_length: { type: 'integer', default: 20000, description: 'Max markdown chars per page.' },
      timeout: { type: 'integer', default: 120000, description: 'Whole-crawl timeout ms (max 300000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, success: { type: 'boolean' }, pages_crawled: { type: 'integer' },
          pages: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' },
        },
      },
      render: (_args, value: Record<string, unknown>) => {
        const v = value as Record<string, unknown>
        if (v.success === false) return [{ type: 'text', text: `crawl4ai_crawl failed: ${String(v.error)}` }]
        return [{ type: 'text', text: `Deep-crawled ${String(v.url)}: ${String(v.pages_crawled)} pages` }]
      },
    },
    timeoutMs: Math.max(config.timeoutSeconds * 1000, 150_000),
    execute: (args, exec) => worker.call('crawl_site', baseArgs(args as Record<string, unknown>), exec.signal) as never,
    presentCall: args => ({ card: 'generic', title: `Crawl site ${truncateUrl(String((args as Record<string, unknown>).url), 50)}`, kind: 'other', rawInput: String((args as Record<string, unknown>).url) }),
  }))

  ctx.tools.register(defineTool({
    name: 'crawl4ai_map',
    description:
      'Map a website: discover its internal links (site map) without downloading full page text. ' +
      'Use before a deep crawl to choose seeds, or to inventory a site. Returns ' +
      '{ url, pages_seen, pages: [{ from, ok, links: [{ href, text }] }], error }.',
    parameters: {
      url: { type: 'string', required: true, description: 'Seed URL.' },
      max_pages: { type: 'integer', default: 100, description: 'Page discovery cap.' },
      timeout: { type: 'integer', default: 120000, description: 'Whole-map timeout ms (max 300000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, success: { type: 'boolean' }, pages_seen: { type: 'integer' },
          pages: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' },
        },
      },
      render: (_args, value: Record<string, unknown>) => {
        const v = value as Record<string, unknown>
        if (v.success === false) return [{ type: 'text', text: `crawl4ai_map failed: ${String(v.error)}` }]
        return [{ type: 'text', text: `Mapped ${String(v.url)}: ${String(v.pages_seen)} pages discovered` }]
      },
    },
    timeoutMs: Math.max(config.timeoutSeconds * 1000, 150_000),
    execute: (args, exec) => worker.call('map_site', baseArgs(args as Record<string, unknown>), exec.signal) as never,
    presentCall: args => ({ card: 'generic', title: `Map ${truncateUrl(String((args as Record<string, unknown>).url), 50)}`, kind: 'other', rawInput: String((args as Record<string, unknown>).url) }),
  }))

  ctx.tools.register(defineTool({
    name: 'crawl4ai_extract',
    description:
      'Extract structured data from a page with CSS selectors — no LLM needed, free and fast. ' +
      'Pass a JSON schema of the crawl4ai 0.9 form: { "name": "...", "baseSelector": "css", ' +
      '"fields": [{ "name": "field", "selector": "css-or-text()", "type": "text|list|nested|..." }] }. ' +
      'Returns { url, success, data (parsed JSON), error }.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL to extract from.' },
      schema: { type: 'object', additionalProperties: true, required: true, description: 'Extraction schema (see description).' },
      timeout: { type: 'integer', default: 60000, description: 'Per-request timeout ms (max 300000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, error: { type: 'string' },
        },
      },
      render: (_args, value: Record<string, unknown>) => {
        const v = value as Record<string, unknown>
        if (v.success === false) return [{ type: 'text', text: `crawl4ai_extract failed: ${String(v.error)}` }]
        return [{ type: 'text', text: `Extracted structured data from ${String(v.url)}` }]
      },
    },
    timeoutMs: Math.max(config.timeoutSeconds * 1000, 90_000),
    execute: (args, exec) => worker.call('extract', baseArgs(args as Record<string, unknown>), exec.signal) as never,
    presentCall: args => ({ card: 'generic', title: `Extract from ${truncateUrl(String((args as Record<string, unknown>).url), 50)}`, kind: 'other', rawInput: String((args as Record<string, unknown>).url) }),
  }))

  ctx.tools.register(defineTool({
    name: 'crawl4ai_links',
    description:
      'List the outbound links of one page (internal + external with anchor text). Cheaper than ' +
      'a full crawl when you only need to discover where a page points. Returns ' +
      '{ url, links: [{ href, text, kind }], error }.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL to inspect.' },
      timeout: { type: 'integer', default: 60000, description: 'Per-request timeout ms (max 300000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, success: { type: 'boolean' },
          links: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' },
        },
      },
      render: (_args, value: Record<string, unknown>) => {
        const v = value as Record<string, unknown>
        if (v.success === false) return [{ type: 'text', text: `crawl4ai_links failed: ${String(v.error)}` }]
        const links = (v.links as unknown[] | undefined) ?? []
        return [{ type: 'text', text: `${String(v.url)}: ${links.length} outbound links` }]
      },
    },
    timeoutMs: Math.max(config.timeoutSeconds * 1000, 90_000),
    execute: (args, exec) => worker.call('links', baseArgs(args as Record<string, unknown>), exec.signal) as never,
    presentCall: args => ({ card: 'generic', title: `Links of ${truncateUrl(String((args as Record<string, unknown>).url), 50)}`, kind: 'other', rawInput: String((args as Record<string, unknown>).url) }),
  }))

  // ═════════════════════════════════════════════════════════════════════════
  // 可选 WebFetchProvider：让内置 web_fetch / web_search 源抓取获得渲染+净化能力。
  // 显式 opt-in：config.registerAsFetchProvider 或环境变量 DSH_CRAWL4AI_FETCH_PROVIDER=1
  // （env 方式无需改 cordis.yml；两者都要求 web 侧把 fetchProvider 配成 'crawl4ai'，
  // 即 DSH_WEB_FETCH_PROVIDER=crawl4ai，避免与 http provider 造成 AMBIGUOUS）。
  const registerFetch = config.registerAsFetchProvider || process.env.DSH_CRAWL4AI_FETCH_PROVIDER === '1'
  if (registerFetch) {
    const web = ctx.get('web')
    if (!web) {
      ctx.logger?.warn?.(`[${name}] registerAsFetchProvider=true but no 'web' service; skipping provider registration`)
    } else {
      const provider: WebFetchProvider = {
        id: 'crawl4ai',
        available: () => true, // worker 拉起成功与否由 fetch 实际调用兜底
        fetch: async (request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> => {
          if (signal?.aborted) throw new Error('web fetch aborted')
          const data = await worker.call('crawl', {
            url: request.url,
            browser: true,
            cache: true,
            user_agent: UA,
            ...(config.proxy ? { proxy: config.proxy } : {}),
          }, signal)
          const body: WebFetchBody = {
            kind: 'text',
            content: String(data.markdown ?? ''),
          }
          return {
            url: String(data.url ?? request.url),
            statusCode: Number(data.status_code ?? 200),
            body,
            truncated: false,
          }
        },
      }
      web.registerFetchProvider(provider)
      ctx.logger?.info?.(`[${name}] crawl4ai WebFetchProvider registered (id=crawl4ai); set DSH_WEB_FETCH_PROVIDER=crawl4ai to route web_fetch through it`)
    }
  }

  ctx.logger?.info?.(`[${name}] 5 crawl4ai tools registered (python=${config.pythonPath}, timeout=${config.timeoutSeconds}s, idle=${config.idleShutdownMs}ms)`)
}
