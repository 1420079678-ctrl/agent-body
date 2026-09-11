/**
 * 引擎管理：真实 Chrome（CDP 调试端口）+ bb-browser daemon（HTTP 19824）生命周期。
 *
 * 设计要点：
 * - 插件运行在 DSH web 服务器进程内（无命令沙箱），可自由 spawn Chrome/daemon、写数据目录。
 * - 所有 spawn 均 windowsHide: true（用户硬性要求：禁止弹终端窗口）。
 * - Chrome 使用独立 user-data-dir（登录态隔离/持久），--remote-debugging-port 暴露 CDP。
 * - daemon 由 npm 包 bb-browser 提供，env 设 BB_BROWSER_HOME=dataDir（绕开 ~/.bb-browser）。
 * - engine.json 持久化 {chromePid, daemonPid, cdpPort, daemonPort, token}，重启复用。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { daemonJsPath, findChromeExecutable, pickFreePort } from './paths.js'

export interface EngineConfig {
  dataDir: string
  cdpPort: number
  daemonPort: number
  chromePath: string | null
  windowSize: string
  logFile: string
}

export interface EngineInfo {
  chromePid: number
  daemonPid: number
  cdpPort: number
  daemonPort: number
  token: string
  ts: number
}

export interface EngineStatus {
  ready: boolean
  chromeAlive: boolean
  daemonAlive: boolean
  cdpPort: number
  daemonPort: number
  chromePath: string | null
  browser: string | null
  tabs: unknown[]
  detail: string
}

function log(cfg: EngineConfig, line: string): void {
  try {
    const ts = new Date().toISOString()
    appendFileSync(cfg.logFile, `[${ts}] ${line}\n`)
    const size = statSync(cfg.logFile).size
    if (size > 1024 * 1024) { // 日志滚轮：>1MB 截半
      const cur = readFileSync(cfg.logFile, 'utf8')
      writeFileSync(cfg.logFile, cur.slice(Math.floor(size / 2)))
    }
  } catch { /* log 失败不阻塞 */ }
}

function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function killTree(pid: number): void {
  if (!isAlive(pid)) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch { /* ignore */ }
}

interface Running {
  chrome: ChildProcess | null
  daemon: ChildProcess | null
  info: EngineInfo
}

export class BrowserEngine {
  private cfg: EngineConfig
  private running: Running | null = null
  private starting: Promise<void> | null = null
  private disposing = false

  constructor(cfg: EngineConfig) {
    this.cfg = cfg
    mkdirSync(cfg.dataDir, { recursive: true })
  }

  private engineJsonPath(): string {
    return join(this.cfg.dataDir, 'engine.json')
  }

  private readEngineJson(): EngineInfo | null {
    try {
      const raw = readFileSync(this.engineJsonPath(), 'utf8')
      const info = JSON.parse(raw) as EngineInfo
      if (info && typeof info.daemonPort === 'number' && typeof info.token === 'string') return info
    } catch { /* none */ }
    return null
  }

  private writeEngineJson(info: EngineInfo): void {
    try { writeFileSync(this.engineJsonPath(), JSON.stringify(info)) } catch { /* ignore */ }
  }

  /** daemon HTTP 状态探测（Bearer token） */
  private async daemonStatus(info: EngineInfo): Promise<{ ok: boolean; data?: any }> {
    try {
      const res = await fetch(`http://127.0.0.1:${info.daemonPort}/status`, {
        headers: { Authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(2500),
      })
      if (!res.ok) return { ok: false }
      return { ok: true, data: await res.json() }
    } catch {
      return { ok: false }
    }
  }

  /** Chrome CDP 就绪探测 */
  private async chromeReady(port: number): Promise<string | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return null
      const j = (await res.json()) as { Browser?: string }
      return j.Browser ?? 'unknown'
    } catch { return null }
  }

  /** 优雅停旧 daemon（用旧 token），失败则杀进程树 */
  private async stopOldDaemon(info: EngineInfo): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${info.daemonPort}/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(2500),
      })
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800))
    if (info.daemonPid && isAlive(info.daemonPid)) killTree(info.daemonPid)
  }

  /** 启动引擎（幂等，并发安全） */
  async ensure(): Promise<EngineStatus> {
    if (this.starting) {
      await this.starting
      return this.status()
    }
    this.starting = this.doEnsure().finally(() => { this.starting = null })
    await this.starting
    return this.status()
  }

  private async doEnsure(): Promise<void> {
    // 1. 已有 daemon 且健康 → 复用（连带校验 Chrome CDP）
    const prev = this.readEngineJson()
    if (prev) {
      const st = await this.daemonStatus(prev)
      if (st.ok && st.data?.running && st.data.cdpConnected !== false) {
        const chromeVer = await this.chromeReady(prev.cdpPort)
        if (chromeVer) {
          this.running = { chrome: null, daemon: null, info: prev }
          return
        }
      }
      // daemon 活着但 Chrome 挂了 → 重启 Chrome 并让 daemon 重连（杀 daemon 走全新建）
      if (prev.daemonPid && isAlive(prev.daemonPid)) {
        log(this.cfg, `engine: daemon alive but chrome down, recycling`)
        await this.stopOldDaemon(prev)
      }
      if (prev.chromePid && isAlive(prev.chromePid)) killTree(prev.chromePid)
    }

    // 2. 全新启动
    const chromePath = this.cfg.chromePath ?? findChromeExecutable()
    if (!chromePath) {
      throw new Error('未找到 Chrome/Edge/Brave 可执行文件，请安装 Chrome 或在配置中指定 chromePath')
    }

    const cdpPort = await pickFreePort(this.cfg.cdpPort)
    const daemonPort = await pickFreePort(this.cfg.daemonPort)
    const token = randomBytes(16).toString('hex')
    const userDataDir = join(this.cfg.dataDir, 'chrome-data')

    // 2a. 启动 Chrome（有头模式=完整 GUI API，反爬不免疫问题最小；独立 profile）
    log(this.cfg, `engine: launching chrome ${chromePath} cdp=${cdpPort} profile=${userDataDir}`)
    const chromeArgs = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${this.cfg.windowSize}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=Translate,MediaRouter',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      'about:blank',
    ]
    const chrome = spawn(chromePath, chromeArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    chrome.stderr?.on('data', (d: Buffer) => log(this.cfg, `[chrome] ${d.toString().trim().slice(0, 400)}`))
    chrome.on('exit', (code, sig) => {
      log(this.cfg, `[chrome] exited code=${code} sig=${sig}`)
      if (this.running?.chrome === chrome) this.running.chrome = null
    })

    // 等 CDP（首次冷启动可能较慢）
    const chromeDeadline = Date.now() + 30000
    let chromeVer: string | null = null
    while (Date.now() < chromeDeadline) {
      chromeVer = await this.chromeReady(cdpPort)
      if (chromeVer) break
      if (chrome.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!chromeVer) {
      log(this.cfg, `engine: chrome CDP not ready, exiting=${chrome.exitCode}`)
      killTree(chrome.pid ?? 0)
      throw new Error(`Chrome 未能在 30s 内就绪（exit=${chrome.exitCode}）。请检查 chromePath 配置。`)
    }
    log(this.cfg, `engine: chrome CDP ready: ${chromeVer}`)

    // 2b. 启动 daemon（bb-browser daemon，连我们的 Chrome）
    const daemonJs = daemonJsPath()
    if (!existsSync(daemonJs)) {
      killTree(chrome.pid ?? 0)
      throw new Error(`缺少 bb-browser daemon 入口: ${daemonJs}（请确认 npm install 完成）`)
    }
    log(this.cfg, `engine: launching daemon ${daemonJs} port=${daemonPort} cdp=${cdpPort}`)
    const daemon = spawn(process.execPath, [
      daemonJs,
      '--cdp-host', '127.0.0.1',
      '--cdp-port', String(cdpPort),
      '--port', String(daemonPort),
      '--token', token,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        BB_BROWSER_HOME: this.cfg.dataDir,
        BB_BROWSER_CDP_URL: `http://127.0.0.1:${cdpPort}`,
      },
    })
    daemon.stderr?.on('data', (d: Buffer) => log(this.cfg, `[daemon] ${d.toString().trim().slice(0, 400)}`))
    daemon.on('exit', (code, sig) => {
      log(this.cfg, `[daemon] exited code=${code} sig=${sig}`)
      if (this.running?.daemon === daemon) this.running.daemon = null
    })

    const info: EngineInfo = { chromePid: chrome.pid ?? 0, daemonPid: daemon.pid ?? 0, cdpPort, daemonPort, token, ts: Date.now() }

    // 等 daemon HTTP 就绪
    const daemonDeadline = Date.now() + 20000
    let daemonOk = false
    while (Date.now() < daemonDeadline) {
      const st = await this.daemonStatus(info)
      if (st.ok && st.data?.running && st.data.cdpConnected !== false) { daemonOk = true; break }
      if (daemon.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 400))
    }
    if (!daemonOk) {
      log(this.cfg, `engine: daemon not ready, exiting=${daemon.exitCode}`)
      killTree(daemon.pid ?? 0)
      killTree(chrome.pid ?? 0)
      throw new Error(`bb-browser daemon 未能在 20s 内就绪（exit=${daemon.exitCode}）。详见日志 ${this.cfg.logFile}`)
    }

    this.running = { chrome, daemon, info }
    this.writeEngineJson(info)
    log(this.cfg, `engine: ready cdp=${cdpPort} daemon=${daemonPort}`)
  }

  /** 当前引擎（未启动返回 null） */
  current(): Running | null {
    return this.running
  }

  /** 状态（不含启动） */
  async status(): Promise<EngineStatus> {
    const r = this.running
    if (!r) {
      const prev = this.readEngineJson()
      const base: EngineStatus = {
        ready: false, chromeAlive: false, daemonAlive: false,
        cdpPort: this.cfg.cdpPort, daemonPort: this.cfg.daemonPort,
        chromePath: this.cfg.chromePath ?? findChromeExecutable(),
        browser: null, tabs: [], detail: '引擎未启动',
      }
      if (prev) {
        base.chromeAlive = isAlive(prev.chromePid)
        base.daemonAlive = isAlive(prev.daemonPid)
        base.detail = `上次实例 cdp=${prev.cdpPort} daemon=${prev.daemonPort} chromeAlive=${base.chromeAlive} daemonAlive=${base.daemonAlive}`
      }
      return base
    }
    const st = await this.daemonStatus(r.info)
    const chromeAlive = isAlive(r.info.chromePid)
    const daemonAlive = isAlive(r.info.daemonPid)
    const chromeVer = await this.chromeReady(r.info.cdpPort)
    const browser = chromeVer ?? (st.data?.cdpConnected ? 'connected' : null)
    return {
      ready: st.ok && st.data?.running && st.data.cdpConnected !== false,
      chromeAlive, daemonAlive,
      cdpPort: r.info.cdpPort, daemonPort: r.info.daemonPort,
      chromePath: this.cfg.chromePath ?? findChromeExecutable(),
      browser,
      tabs: st.data?.tabs ?? [],
      detail: st.ok ? `uptime=${st.data?.uptime ?? '?'}s seq=${st.data?.currentSeq ?? '?'}` : 'daemon 无响应',
    }
  }

  /** 停止引擎（Chrome + daemon + 清 engine.json） */
  async stop(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    try {
      const r = this.running
      if (r) {
        log(this.cfg, 'engine: stopping')
        await this.stopOldDaemon(r.info)
        if (isAlive(r.info.chromePid)) killTree(r.info.chromePid)
        this.running = null
      } else {
        const prev = this.readEngineJson()
        if (prev) {
          await this.stopOldDaemon(prev)
          if (isAlive(prev.chromePid)) killTree(prev.chromePid)
        }
      }
    } finally {
      try { rmSync(this.engineJsonPath(), { force: true }) } catch { /* ignore */ }
      this.disposing = false
    }
  }

  get logFile(): string {
    return this.cfg.logFile
  }
}
