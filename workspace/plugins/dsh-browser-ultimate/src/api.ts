/**
 * bb-browser daemon HTTP 客户端：POST /command 协议。
 * 请求 {"method":"snap","params":{...}} → 成功 {"result":{...}} / 失败 {"error":{...}}
 */
import type { BrowserEngine } from './engine.js'

export class DaemonError extends Error {
  hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.hint = hint
  }
}

export interface CommandResult {
  /** daemon 返回的 result 对象 */
  result: Record<string, any>
  /** 全量响应（含原始字段） */
  raw: any
}

/** 单条命令执行（自动 ensure 引擎 + 带 token 调用） */
export async function daemonCommand(engine: BrowserEngine, method: string, params: Record<string, unknown> = {}, timeoutMs = 35000): Promise<CommandResult> {
  await engine.ensure()
  const r = engine.current()
  if (!r) throw new DaemonError('引擎未启动')

  const res = await fetch(`http://127.0.0.1:${r.info.daemonPort}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${r.info.token}`,
    },
    body: JSON.stringify({ method, ...params }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { error: { message: text.slice(0, 500) } } }

  if (!res.ok || body.error) {
    const err = body.error ?? {}
    throw new DaemonError(
      String(err.message ?? `HTTP ${res.status}`),
      err.hint ? String(err.hint) : undefined,
    )
  }
  return { result: body.result ?? {}, raw: body }
}

/** 结果裁剪（保护 token，长结果截断 + 标记） */
export function trimJson(v: unknown, max = 12000): string {
  let s: string
  try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch { s = String(v) }
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[截断：共 ${s.length} 字符，可用 limit/maxDepth 缩小范围]`
}

/** 从 daemon 响应提取 tab 短 id（多个可能的字段） */
export function extractTab(res: CommandResult, fallback?: string): string | undefined {
  return res.result.tab ?? res.result.tabId ?? res.result.targetId ?? fallback
}
