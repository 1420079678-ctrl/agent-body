/**
 * @dsh-external/dsh-dingtalk-bridge — 钉钉线上桥连服务（hybrid 形态）。
 *
 * 原理：钉钉 Stream 模式。本机无需公网 IP/端口映射——
 *   1. GET  https://oapi.dingtalk.com/gettoken?appkey=..&appsecret=..  → access_token
 *   2. POST https://api.dingtalk.com/v1.0/gateway/connections/open      → { endpoint, ticket }
 *   3. WebSocket(endpoint?ticket=..) 长连接（钉钉主动推消息，自动重连+心跳）
 *   4. 收到机器人消息 EVENT（topic=/v1.0/im/bot/messages/get）→ 调 DSH LLM → 回复
 * 回复走消息自带的 sessionWebhook（POST 回去即达，有效期由钉钉管理）。
 *
 * 零运行时依赖：Node ≥21 内置全局 fetch + WebSocket 实现协议，不装 npm 包。
 *
 * 配置（可在 Web 面板或 profile 配置里填）：
 *   clientId / clientSecret —— 钉钉企业内部应用的 AppKey / AppSecret
 *   也支持环境变量 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET（优先于配置空值）
 */
import type { Context } from 'cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from 'schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

type AppContext = Context & {
  llm: LlmService
  webServer: {
    register(opts: {
      kind: 'prefix'
      path: string
      handler(req: { method?: string; url?: string }, res: {
        writeHead(code: number, headers?: Record<string, string>): void
        end(body?: string): void
      }): Promise<void> | void
    }): () => void
  }
}

export const name = '@dsh-external/dsh-dingtalk-bridge'
export const inject = ['llm', 'webServer']

export interface Config {
  /** 钉钉企业内部应用 AppKey */
  clientId: string
  /** 钉钉企业内部应用 AppSecret（敏感，也可用环境变量 DINGTALK_CLIENT_SECRET） */
  clientSecret: string
  /** 启动即自动连接钉钉（默认 true） */
  autoStart: boolean
  /** LLM provider 路由（留空 = 自动探测第一个可用 provider） */
  provider: string
  /** LLM model（留空 = 自动探测 provider 的首个模型） */
  model: string
  /** 机器人 persona / 系统提示词 */
  systemPrompt: string
  /** 单条回复最大 token（控制成本） */
  maxTokens: number
  /** 每会话保留的历史轮数（1 轮 = 一问一答） */
  historyPerChat: number
  /** 群聊只响应 @机器人 的消息（单聊始终响应） */
  onlyAtMention: boolean
  /** 回复加前缀（如「DSH：」，留空不加） */
  replyPrefix: string
  /** 日志文件（空 = DSH_HOME/super-injector/dsh-dingtalk-bridge.log） */
  logFile: string
}

export const Config = z.object({
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  autoStart: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default(''),
  systemPrompt: z.string().default(
    '你是运行在用户本机 DeepSeek Harness（DSH）上的智能助手，通过钉钉机器人与你对话。' +
    '回答简洁、直接、用中文，能用要点就用要点。不知道的不要编造。'
  ),
  maxTokens: z.number().min(64).max(4096).default(512),
  historyPerChat: z.number().min(0).max(20).default(6),
  onlyAtMention: z.boolean().default(true),
  replyPrefix: z.string().default(''),
  logFile: z.string().default(''),
})

/* ── 钉钉 Stream 协议类型 ─────────────────────────────────────────── */

interface RobotMessageBase {
  conversationId: string
  chatbotCorpId: string
  chatbotUserId: string
  msgId: string
  senderNick: string
  isAdmin: boolean
  senderStaffId: string
  sessionWebhookExpiredTime: number
  createAt: number
  senderCorpId: string
  conversationType: string
  senderId: string
  sessionWebhook: string
  robotCode: string
  msgtype: string
  /** 群聊时是否 @ 了机器人 */
  isInAtList?: boolean
}

interface RobotTextMessage extends RobotMessageBase {
  msgtype: 'text'
  text: { content: string }
}

type RobotMessage = RobotTextMessage

interface DownStream {
  specVersion: string
  type: 'SYSTEM' | 'EVENT' | 'CALLBACK'
  headers: {
    topic: string
    messageId?: string
    eventId?: string
    contentType?: string
    [k: string]: unknown
  }
  data: string
}

/* ── 钉钉 Stream 客户端（零依赖实现） ──────────────────────────────── */

type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'disabled'

interface BridgeState {
  status: Status
  detail: string
  connectedAt: number | null
  msgIn: number
  msgOut: number
  llmCalls: number
  lastError: string
  history: Array<{ at: string; direction: 'in' | 'out'; from: string; text: string }>
}

const TOPIC_ROBOT = '/v1.0/im/bot/messages/get'
const API_BASE = 'https://api.dingtalk.com'
const OAPI_BASE = 'https://oapi.dingtalk.com'

class DingTalkStreamClient {
  private socket: WebSocket | null = null
  private userDisconnect = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private isAlive = true
  private accessToken = ''
  private onEvent: ((msg: DownStream) => void) | null = null
  private onStatus: ((s: Status, detail: string) => void) | null = null

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  setHandlers(handlers: {
    onEvent(msg: DownStream): void
    onStatus(s: Status, detail: string): void
  }): void {
    this.onEvent = handlers.onEvent
    this.onStatus = handlers.onStatus
  }

  private emitStatus(s: Status, detail: string): void {
    this.onStatus?.(s, detail)
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    this.userDisconnect = false
    this.emitStatus('connecting', '获取 access_token…')
    try {
      const tokenRes = await fetch(
        `${OAPI_BASE}/gettoken?appkey=${encodeURIComponent(this.clientId)}&appsecret=${encodeURIComponent(this.clientSecret)}`,
        { signal: AbortSignal.timeout(15000) },
      )
      const tokenBody = await tokenRes.json() as { access_token?: string; errmsg?: string; errcode?: number }
      if (!tokenRes.ok || !tokenBody.access_token) {
        throw new Error(`gettoken 失败: ${tokenBody.errmsg ?? tokenRes.status} (errcode=${tokenBody.errcode ?? '?'})`)
      }
      this.accessToken = tokenBody.access_token

      this.emitStatus('connecting', '打开长连接…')
      const openRes = await fetch(`${API_BASE}/v1.0/gateway/connections/open`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'access-token': this.accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          ua: 'dsh-dingtalk-bridge/0.0.1',
          subscriptions: [{ type: 'EVENT', topic: TOPIC_ROBOT }],
        }),
        signal: AbortSignal.timeout(15000),
      })
      const openBody = await openRes.json() as { endpoint?: string; ticket?: string; message?: string }
      if (!openRes.ok || !openBody.endpoint || !openBody.ticket) {
        throw new Error(`connections/open 失败: ${openBody.message ?? openRes.status}`)
      }
      const wsUrl = `${openBody.endpoint}?ticket=${openBody.ticket}`
      this.openSocket(wsUrl)
    } catch (e) {
      this.emitStatus('error', String(e instanceof Error ? e.message : e))
      this.scheduleReconnect()
    }
  }

  private openSocket(url: string): void {
    try {
      const ws = new WebSocket(url)
      this.socket = ws
      ws.onopen = () => {
        this.reconnectDelay = 1000
        this.emitStatus('connected', '长连接已建立')
        this.startHeartbeat()
      }
      ws.onmessage = (ev) => this.onDownStream(String(ev.data))
      ws.onclose = (e) => {
        this.stopHeartbeat()
        this.emitStatus('reconnecting', `连接关闭 code=${(e as { code?: number } | null)?.code ?? '?'} reason=${((e as { reason?: string } | null)?.reason ?? '').slice(0, 60)} userDisconnect=${this.userDisconnect}`)
        if (!this.userDisconnect) this.scheduleReconnect()
      }
      ws.onerror = () => { /* close 事件会兜底重连 */ }
    } catch (e) {
      this.emitStatus('error', 'WebSocket 创建失败: ' + String(e))
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.userDisconnect || this.reconnectTimer) return
    this.emitStatus('reconnecting', `${this.reconnectDelay / 1000}s 后重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.userDisconnect) void this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
  }

  private startHeartbeat(): void {
    // 不做主动发送（空帧会被钉钉服务端断开，实测 16s 断连）。
    // 只做存活监控：isAlive 由任何下行数据刷新；30s 无数据视为死链，主动关闭触发重连。
    this.stopHeartbeat()
    this.isAlive = true
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAlive) {
        try { this.socket?.close() } catch { /* 忽略 */ }
        return
      }
      this.isAlive = false
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  private onDownStream(raw: string): void {
    this.isAlive = true
    if (raw === '') return // 空帧（保活信号）
    let msg: DownStream
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'SYSTEM') {
      if (msg.headers.topic === 'ping') {
        // 服务端 ping → 回 pong
        this.send({ code: 200, headers: msg.headers, message: 'OK', data: msg.data })
      }
      return
    }
    if (msg.type === 'EVENT') {
      this.onEvent?.(msg)
      // ack：告诉钉钉已收到
      this.send({
        code: 200,
        headers: { contentType: 'application/json', messageId: msg.headers.messageId ?? '' },
        message: 'OK',
        data: JSON.stringify({ status: 'SUCCESS' }),
      })
    }
  }

  private send(payload: unknown): void {
    const ws = this.socket
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(payload)) } catch { /* 忽略 */ }
    }
  }

  disconnect(): void {
    this.userDisconnect = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.stopHeartbeat()
    try { this.socket?.close() } catch { /* 忽略 */ }
    this.socket = null
    this.emitStatus('idle', '已手动断开')
  }
}

/* ── 插件主逻辑 ───────────────────────────────────────────────────── */

export function apply(ctx: AppContext, config: Config): void {
  const SHORT = 'dsh-dingtalk-bridge'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')

  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* 日志失败静默 */ }
  }

  const clientId = config.clientId || process.env.DINGTALK_CLIENT_ID || ''
  const clientSecret = config.clientSecret || process.env.DINGTALK_CLIENT_SECRET || ''

  const state: BridgeState = {
    status: clientId && clientSecret ? 'idle' : 'disabled',
    detail: clientId && clientSecret ? '待连接' : '未配置 AppKey/AppSecret',
    connectedAt: null,
    msgIn: 0,
    msgOut: 0,
    llmCalls: 0,
    lastError: '',
    history: [],
  }

  const pushHistory = (direction: 'in' | 'out', from: string, text: string): void => {
    state.history.push({ at: new Date().toISOString(), direction, from, text: text.slice(0, 200) })
    if (state.history.length > 60) state.history.splice(0, state.history.length - 60)
  }

  /* 会话记忆：conversationId → 最近 N 轮消息 */
  const memories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>()
  const remember = (cid: string, role: 'user' | 'assistant', content: string): void => {
    const arr = memories.get(cid) ?? []
    arr.push({ role, content: content.slice(0, 2000) })
    while (arr.length > config.historyPerChat * 2) arr.shift()
    memories.set(cid, arr)
  }

  /* LLM 路由：配置优先，否则自动探测 */
  let cachedRoute: { provider: string; model: string } | null = null
  async function resolveRoute(): Promise<{ provider: string; model: string }> {
    if (cachedRoute) return cachedRoute
    if (config.provider && config.model) {
      cachedRoute = { provider: config.provider, model: config.model }
      return cachedRoute
    }
    const providers = ctx.llm.listProviders()
    if (providers.length === 0) throw new Error('没有可用的 LLM provider')
    let provider = config.provider || providers[0].id
    let model = config.model
    if (!model) {
      const models = await ctx.llm.listModels(provider)
      if (models.length === 0) throw new Error(`provider ${provider} 没有可用模型`)
      model = models[0].id
    }
    cachedRoute = { provider, model }
    log(`LLM 路由: ${provider} / ${model}`)
    return cachedRoute
  }

  /** 调 LLM 生成回复（纯文本，无工具） */
  async function chatOnce(cid: string, userText: string): Promise<string> {
    const route = await resolveRoute()
    state.llmCalls += 1
    const history = memories.get(cid) ?? []
    const messages = history.map((m) =>
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: m.content }] })
    )
    // 用 provider 的 role 语义：最后一条用户消息 + 系统提示
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: config.systemPrompt,
      maxTokens: config.maxTokens,
      temperature: 0.3,
      messages: [
        ...messages.slice(0, -1).map((m) => ({ ...m, role: 'user' as const })),
        ...(history.length > 0 ? [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: userText }] })] : []),
      ],
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    const trimmed = text.trim()
    if (!trimmed) throw new Error('LLM 返回空回复')
    return trimmed
  }

  /** 回复钉钉：POST 到 sessionWebhook（stream 消息自带，带 access_token） */
  async function reply(msg: RobotMessage, content: string): Promise<void> {
    const text = config.replyPrefix ? config.replyPrefix + content : content
    const url = `${msg.sessionWebhook}?access_token=${encodeURIComponent(await getAccessToken())}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 2000) } }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`回复失败 HTTP ${res.status}: ${body.slice(0, 100)}`)
    }
    state.msgOut += 1
    pushHistory('out', '机器人', text.slice(0, 200))
  }

  /** 缓存 access_token（钉钉 token 有效期 7200s，这里简单 1h 缓存） */
  let tokenCache: { token: string; expiresAt: number } | null = null
  async function getAccessToken(): Promise<string> {
    if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token
    const res = await fetch(
      `${OAPI_BASE}/gettoken?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`,
      { signal: AbortSignal.timeout(15000) },
    )
    const body = await res.json() as { access_token?: string }
    if (!body.access_token) throw new Error('刷新 access_token 失败')
    tokenCache = { token: body.access_token, expiresAt: Date.now() + 3600_000 }
    return body.access_token
  }

  /** 命令处理（/help /status /clear） */
  function handleCommand(text: string): string | null {
    const t = text.trim()
    if (t === '/help' || t === '帮助') {
      return '可用命令：\n/status 查看服务状态\n/clear 清空本会话记忆\n/help 本帮助\n直接发消息即可与 DSH 对话。'
    }
    if (t === '/status') {
      return `DSH 钉钉桥连状态：\n连接：${state.status}（${state.detail}）\n已收消息：${state.msgIn}\n已回复：${state.msgOut}\nLLM 调用：${state.llmCalls}`
    }
    return null
  }

  /** 消息处理主流程 */
  async function handleRobotMessage(msg: RobotMessage): Promise<void> {
    state.msgIn += 1
    pushHistory('in', msg.senderNick || msg.senderId, msg.text?.content ?? '')

    const text = msg.text?.content ?? ''
    if (!text) return
    const trimmed = text.trim()

    // 群聊过滤：只响应 @机器人
    if (config.onlyAtMention && msg.conversationType === 'group') {
      const atRobot = msg.isInAtList === true || /@[^\s]{0,20}/.test(trimmed)
      if (!atRobot) return
    }

    // 命令
    const cmd = handleCommand(trimmed.replace(/@[^\s]+/g, '').trim())
    if (cmd !== null) {
      await reply(msg, cmd)
      return
    }

    // 超长消息截断
    const userText = trimmed.slice(0, 2000)
    remember(msg.conversationId, 'user', userText)
    try {
      const answer = await chatOnce(msg.conversationId, userText)
      remember(msg.conversationId, 'assistant', answer)
      await reply(msg, answer)
    } catch (e) {
      const errText = String(e instanceof Error ? e.message : e).slice(0, 200)
      state.lastError = errText
      log('LLM/reply error: ' + errText)
      await reply(msg, '⚠️ 处理出错：' + errText).catch(() => {})
    }
  }

  /* 连接管理与状态 */
  const client = new DingTalkStreamClient(clientId, clientSecret)
  client.setHandlers({
    onEvent: (down) => {
      if (down.headers.topic !== TOPIC_ROBOT) return
      try {
        const msg = JSON.parse(down.data) as RobotMessage
        void handleRobotMessage(msg).catch((e) => log('handle error: ' + String(e)))
      } catch (e) {
        log('parse event error: ' + String(e))
      }
    },
    onStatus: (s, detail) => {
      state.status = s
      state.detail = detail
      if (s === 'connected') state.connectedAt = Date.now()
      if (s === 'error') state.lastError = detail
      log(`status: ${s} — ${detail}`)
    },
  })

  function start(): void {
    if (!clientId || !clientSecret) {
      state.status = 'disabled'
      state.detail = '未配置 AppKey/AppSecret（配置或环境变量 DINGTALK_CLIENT_ID/SECRET）'
      return
    }
    void client.connect()
  }

  /* ═══ Web API（面板调用） ═══ */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dingtalk-bridge/api',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const method = url.pathname.replace('/dingtalk-bridge/api', '').replace(/^\/+/, '') || 'status'
      const writeJson = (code: number, body: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method === 'GET' && method === 'status') {
          writeJson(200, {
            ok: true,
            state: {
              status: state.status,
              detail: state.detail,
              connectedAt: state.connectedAt,
              msgIn: state.msgIn,
              msgOut: state.msgOut,
              llmCalls: state.llmCalls,
              lastError: state.lastError,
              history: state.history.slice(-30),
            },
          })
          return
        }
        if (req.method === 'POST') {
          if (method === 'connect') { start(); writeJson(200, { ok: true }); return }
          if (method === 'disconnect') { client.disconnect(); writeJson(200, { ok: true }); return }
          if (method === 'test') {
            // 面板自检：仅验证 gettoken 链路（不经过机器人）
            const tk = await getAccessToken()
            writeJson(200, { ok: true, gotToken: !!tk })
            return
          }
        }
        writeJson(404, { ok: false, error: 'unknown method: ' + method })
      } catch (e) {
        writeJson(500, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
    },
  }), 'dsh-dingtalk-bridge: /dingtalk-bridge/api routes')

  /* 生命周期 */
  ctx.effect(() => {
    if (config.autoStart) start()
    return () => {
      client.disconnect()
      memories.clear()
    }
  }, 'dsh-dingtalk-bridge: lifecycle')

  ctx.logger?.info?.('[' + name + '] 钉钉桥连服务就绪：' + (clientId && clientSecret ? '凭据已配置' : '未配置凭据'))
  log('plugin loaded, clientId=' + (clientId ? clientId.slice(0, 6) + '…' : '(空)'))
}
