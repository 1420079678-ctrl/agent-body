/**
 * @dsh-external/dsh-browser-ultimate 引擎冒烟测试
 *
 * 验证真实链路：启动 Chrome(CDP) → 启动 bb-browser daemon → open → eval → stop。
 * 需要本机已装 Chrome/Edge/Brave（或设置 CHROME_PATH 环境变量指定）。
 *
 * 运行：node smoke-test.mjs
 * 通过输出：SMOKE TEST PASS (n/n)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserEngine } from './lib/engine.js'
import { daemonCommand } from './lib/api.js'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-browser-ultimate-smoke-'))
const logFile = join(dataDir, 'engine.log')

const engine = new BrowserEngine({
  dataDir,
  cdpPort: 19322,
  daemonPort: 19824,
  chromePath: process.env.CHROME_PATH ?? null,
  windowSize: '1280,800',
  logFile,
})

let passed = 0
let failed = 0
const results = []

function check(name, ok, detail = '') {
  if (ok) { passed++; results.push(`  ✓ ${name}`) } else { failed++; results.push(`  ✗ ${name} ${detail}`) }
}

try {
  // 1. 引擎启动（Chrome + daemon）
  const st = await engine.ensure()
  check('engine.ensure ready', st.ready, `detail=${st.detail}`)
  check('chrome alive', st.chromeAlive, `path=${st.chromePath}`)
  check('daemon alive', st.daemonAlive)
  check('browser version detected', !!st.browser, `browser=${st.browser}`)
  console.log(`[1/5] engine ready: browser=${st.browser} cdp=${st.cdpPort} daemon=${st.daemonPort}`)

  // 2. status 幂等（重复 ensure 复用）
  const st2 = await engine.ensure()
  check('ensure idempotent (same ports)', st2.cdpPort === st.cdpPort && st2.daemonPort === st.daemonPort)

  // 3. open + tab_list
  const open = await daemonCommand(engine, 'open', { url: 'https://example.com' }, 40000)
  const tab = open.result.tab
  check('open example.com returns tab', !!tab, `tab=${tab}`)
  await new Promise((r) => setTimeout(r, 1200))
  const list = await daemonCommand(engine, 'tab_list', {}, 10000)
  const tabs = list.result.tabs ?? []
  check('tab_list non-empty', tabs.length > 0, `count=${tabs.length}`)

  // 4. eval（页面上下文执行 JS）
  const ev = await daemonCommand(engine, 'eval', {
    script: '(function (a) { return { title: document.title, url: location.href, ready: document.readyState }; })',
    args: {}, tab,
  }, 20000)
  const r = ev.result.result
  check('eval returns page info', !!r && typeof r.title === 'string' && r.url.includes('example.com'), `title=${r?.title}`)

  // 5. stop 清理
  await engine.stop()
  const after = await engine.status()
  check('stop kills chrome', !after.chromeAlive)
  check('stop kills daemon', !after.daemonAlive)
  console.log('[5/5] engine stopped')
} catch (e) {
  failed++
  results.push(`  ✗ 异常终止: ${(e).message}`)
  try { await engine.stop() } catch { /* ignore */ }
} finally {
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('--- smoke results ---')
console.log(results.join('\n'))
const total = passed + failed
console.log(total > 0 ? `SMOKE TEST ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${total})` : 'SMOKE TEST FAIL (0 项执行)')
process.exit(failed === 0 ? 0 : 1)
