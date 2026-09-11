#!/usr/bin/env node
/**
 * Run every organ's offline regression suite.
 *
 * The suites load each organ's built `lib/`, which imports the host runtime
 * (@deepseek-ai/dsh-*, schemastery). Inside an installed harness that resolves through the
 * organ's linked node_modules; on a bare checkout it does not, so a missing host runtime is
 * reported as SKIP rather than FAIL — an uninstalled host is not a broken organ.
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

const HOST_DEP_RE = /Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/
const HOST_DEP_NAME_RE = /@deepseek-ai\/|schemastery/

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
    if (run.status === 0) status = 'PASS'
    else if (run.error?.code === 'ENOENT') status = 'SKIP'
    else if (outputCaptured && HOST_DEP_RE.test(output) && HOST_DEP_NAME_RE.test(output)) status = 'SKIP'
    else status = 'FAIL'

    const tail = outputCaptured
      ? output.trim().split('\n').slice(-1)[0]?.trim() ?? ''
      : `exit ${run.status} (output not captured in this sandbox)`
    results.push({ name, file, status, elapsed, tail })
  }
}

const width = Math.max(8, ...results.map((r) => `${r.name}/${r.file}`.length))
console.log('\nOrgan regressions\n' + '-'.repeat(width + 34))
for (const r of results) {
  const label = `${r.name}/${r.file}`.padEnd(width)
  const note = r.status === 'PASS' ? '' : `  ${r.tail.slice(0, 90)}`
  console.log(`  ${r.status.padEnd(5)} ${label} ${r.elapsed}s${note}`)
}

const failed = results.filter((r) => r.status === 'FAIL').length
const skipped = results.filter((r) => r.status === 'SKIP').length
const passed = results.filter((r) => r.status === 'PASS').length
console.log('-'.repeat(width + 34))
console.log(`  ${passed} passed · ${failed} failed · ${skipped} skipped (host runtime not installed)\n`)

process.exit(failed > 0 ? 1 : 0)
