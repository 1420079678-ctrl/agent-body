/**
 * 路径与平台工具：数据目录、Chrome 可执行文件探测、端口探测。
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录（node_modules 所在层级） */
export const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

/** bb-browser daemon 入口（npm 包 dist） */
export function daemonJsPath(): string {
  return join(pluginRoot, 'node_modules', 'bb-browser', 'dist', 'daemon.js')
}

/** Chrome 可执行文件探测（对齐 bb-browser cdp-discovery 的 win32/darwin/linux 路径表） */
export function findChromeExecutable(): string | null {
  const p = platform()
  if (p === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
    return candidates.find((c) => existsSync(c)) ?? null
  }
  if (p === 'linux') {
    for (const c of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
      try {
        const resolved = execFileSync('which', [c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (resolved && existsSync(resolved)) return resolved
      } catch { /* next */ }
    }
    return null
  }
  if (p === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ...(localAppData ? [
        join(localAppData, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
        join(localAppData, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
        join(localAppData, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      ] : []),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]
    return candidates.find((c) => existsSync(c)) ?? null
  }
  return null
}

/** 默认数据目录：<DSH_HOME>/plugins/dsh-browser-ultimate */
export function defaultDataDir(baseDir: string): string {
  if (baseDir && baseDir !== process.cwd()) return join(baseDir, 'plugins', 'dsh-browser-ultimate')
  return join(homedir(), '.dsh-browser-ultimate')
}

/**
 * 端口是否被占用（TCP 连接级探测）。
 * 不能用 HTTP 特定路径（如 /json/version）探测：CDP 端口上该路径 200，
 * 但 daemon 端口上会 404/401 —— 404 会被误判为"空闲"，导致选中已被占用的
 * 端口，daemon 启动时 EADDRINUSE。TCP connect 对任意服务都正确。
 */
export async function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return await new Promise((resolve) => {
    const sock = connect({ host, port })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.once('timeout', () => done(false))
  })
}

/** 挑一个可用端口（从 base 开始，最多试 30 个） */
export async function pickFreePort(base: number, host = '127.0.0.1'): Promise<number> {
  for (let i = 0; i < 30; i++) {
    const port = base + i
    if (!(await canConnect(host, port, 800))) return port
  }
  return base + 30
}
