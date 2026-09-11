/**
 * 代理补丁（本地定制，2026-08-26）：
 * 让 dsh-quant 的网络请求可走本机 HTTP 代理（Clash 127.0.0.1:7890 等）。
 * - 动态读取环境变量 HTTPS_PROXY / HTTP_PROXY（大小写兼容），改 env 即时生效
 * - 有代理 → 用 undici ProxyAgent 作为 fetch dispatcher；无代理 → 原样 fetch
 * - 纯运行时行为，不改变任何业务逻辑，不触碰"零依赖"数值核心
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'

/* eslint-disable @typescript-eslint/no-explicit-any */
let cached: any = null
let cachedUrl = ''

/** 默认代理（本机 Clash；可用 QUANT_DEFAULT_PROXY 覆盖）。env 有 HTTPS_PROXY 时优先。 */
const DEFAULT_PROXY = process.env.QUANT_DEFAULT_PROXY || 'http://127.0.0.1:7890'

function proxyUrl(): string {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    DEFAULT_PROXY
  ).trim()
}

/** 返回当前代理 dispatcher（无代理则 undefined）。 */
export function proxyDispatcher(): any {
  const url = proxyUrl()
  if (!url) {
    cached = null
    cachedUrl = ''
    return undefined
  }
  if (cached && cachedUrl === url) return cached
  cached = new ProxyAgent(url)
  cachedUrl = url
  return cached
}

/**
 * 包装 fetch：走 undici 自带 fetch（与 ProxyAgent 同版本，避免 Node 全局 fetch
 * 与 undici ProxyAgent 的跨版本 dispatcher 不兼容）。有代理则附加 dispatcher。
 */
export async function proxiedFetch(
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
): Promise<Response> {
  const dispatcher = proxyDispatcher()
  if (!dispatcher) return undiciFetch(input, init)
  return undiciFetch(input, { ...(init ?? {}), dispatcher } as Parameters<typeof undiciFetch>[1])
}
/* eslint-enable @typescript-eslint/no-explicit-any */
