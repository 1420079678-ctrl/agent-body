#!/usr/bin/env node
/**
 * Run every organ's offline regression suite.
 *
 * The suites load each organ's built `lib/`, which imports the host runtime
 * (@deepseek-ai/dsh-*, schemastery). Inside an installed harness that resolves through the
 * organ's linked node_modules; on a bare checkout it does not, so a missing host runtime is
 * reported as SKIP rather than FAIL — an uninstalled host is not a broken organ.
 *
 * The same applies to a Python suite whose optional dependency is not installed: missing
 * tooling is a SKIP, a failing assertion is a FAIL. Conflating the two is how a red build
 * teaches people to ignore red builds.
 *
 * Usage: node scripts/run-organ-regressions.mjs [organ ...]
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = path.join(repoRoot, 'workspace', 'plugins')
const filter = process.argv.slice(2).filter(Boolean)

/**
 * 把「跑不起来」与「跑起来但挂了」分开。
 *
 * 返回 null 表示这不是环境问题，应当按真实退出码计。
 * 返回字符串则是可读的跳过原因——**原因必须有用**：以前这里打印输出的最后一行，
 * 而 Node 的模块解析崩溃最后一行永远是「Node.js v24.19.0」，等于什么都没说。
 */
function skipReason(output) {
  const py = output.match(/ModuleNotFoundError: No module named '([^']+)'/)
  if (py) return `缺少 Python 依赖 ${py[1]}`
  const pkg = output.match(/Cannot find package '([^']+)'/)
  if (pkg) return `缺少宿主运行时 ${pkg[1]}`
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(output)) return '缺少宿主运行时（模块解析失败）'
  if (/Cannot find (module|type definition)/.test(output)) return '缺少宿主运行时（类型/模块缺失）'
  return null
}

const results = []

for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const name = entry.name
  if (filter.length > 0 && !filter.includes(name)) continue

  const dir = path.join(pluginsDir, name)
  const scriptsDir = path.join(dir, 'scripts')
  if (!fs.existsSync(scriptsDir)) continue

  for (const file of fs.readdirSync(scriptsDir)) {
    const isNode = file === 'smoke-test.mjs' || file === 'selftest.mjs'
    const isPython = /^selftest.*\.py$/.test(file)
    if (!isNode && !isPython) continue

    const script = path.join(scriptsDir, file)
    const runner = isPython ? 'python' : process.execPath
    const started = Date.now()
    let run = spawnSync(runner, [script], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5 * 60 * 1000,
    })
    // Confined Windows sandboxes forbid piped stdio between processes (EPERM). Fall back to
    // inherited stdio: the suite still runs, we just cannot read its output to classify a SKIP.
    let outputCaptured = true
    if (run.error && (run.error.code === 'EPERM' || run.error.code === 'EACCES')) {
      outputCaptured = false
      run = spawnSync(runner, [script], {
        cwd: dir,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 5 * 60 * 1000,
      })
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`

    let status
    let note = ''
    if (run.status === 0) {
      status = 'PASS'
    } else if (run.error?.code === 'ENOENT') {
      status = 'SKIP'
      note = `运行时不存在：${path.basename(runner)}`
    } else {
      const reason = outputCaptured ? skipReason(output) : null
      if (reason) {
        status = 'SKIP'
        note = reason
      } else {
        status = 'FAIL'
        note = outputCaptured
          ? output.trim().split('\n').filter(Boolean).slice(-1)[0]?.trim() ?? `exit ${run.status}`
          : `exit ${run.status} (output not captured in this sandbox)`
      }
    }
    results.push({ name, file, status, elapsed, note })
  }
}

const width = Math.max(8, ...results.map((r) => `${r.name}/${r.file}`.length))
console.log('\nOrgan regressions\n' + '-'.repeat(width + 34))
for (const r of results) {
  const label = `${r.name}/${r.file}`.padEnd(width)
  console.log(`  ${r.status.padEnd(5)} ${label} ${r.elapsed}s${r.note ? `  ${r.note.slice(0, 100)}` : ''}`)
}

const failed = results.filter((r) => r.status === 'FAIL').length
const skipped = results.filter((r) => r.status === 'SKIP').length
const passed = results.filter((r) => r.status === 'PASS').length
const reasons = [...new Set(results.filter((r) => r.status === 'SKIP').map((r) => r.note))]
console.log('-'.repeat(width + 34))
console.log(`  ${passed} passed · ${failed} failed · ${skipped} skipped`)
for (const reason of reasons) console.log(`    · ${reason}`)
if (passed === 0) {
  console.log(
    '\n  没有可跑的回归：这些套件需要宿主运行时（@deepseek-ai/dsh-*）。' +
      '\n  在已安装 harness 的环境里跑，或对着器官的 src/ 读它自己的断言。',
  )
}
console.log('')

// 用 exitCode 而不是 process.exit()：让事件循环自然排空，避免在途 async 句柄被强杀
// 触发 libuv 断言（Windows 上表现为「全绿却退出码 1」）。
process.exitCode = failed > 0 ? 1 : 0
