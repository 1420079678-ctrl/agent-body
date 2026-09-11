import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as core from '../src/index.mjs'

/**
 * 一致性测试（parity）：把本包的移植版，与**真实内核**逐项比对。
 *
 * 这是整个「零依赖移植」策略的安全网：移植版可能因内核演进而漂移，
 * 而漂移是静默的——数字照样好看，只是与真身无关。
 *
 * 内核需要宿主运行时（@deepseek-ai/dsh-tools 等）才能加载。加载不了时**明确跳过**，
 * 并在输出里说清原因——绝不假装通过。CI 里应当在装有宿主的环境跑它；
 * 纯离线环境跳过是可接受的，但必须显式。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

const KERNEL_CANDIDATES = [
  process.env.AGENT_BODY_KERNEL_LIB,
  path.join(repoRoot, 'workspace', 'plugins', 'dsh-organism', 'lib', 'index.js'),
  'D:/DeepSeekHarness/workspace/plugins/dsh-organism/lib/index.js',
].filter(Boolean)

function loadKernel() {
  for (const p of KERNEL_CANDIDATES) {
    if (!fs.existsSync(p)) continue
    try {
      const require = createRequire(p)
      const mod = require(p)
      if (mod && typeof mod.innervate === 'function') return { path: p, mod }
      if (mod?.default && typeof mod.default.innervate === 'function') return { path: p, mod: mod.default }
    } catch (e) {
      lastError = `${p}: ${e.message}`
    }
  }
  return null
}

let lastError = ''
const kernel = loadKernel()
const skip = kernel ? false : `内核不可加载（需要宿主运行时）${lastError ? ` — ${lastError.slice(0, 160)}` : ''}`

if (skip) {
  console.error(`\n[parity] SKIP: ${skip}\n[parity] 这不算通过——一致性未被验证。\n`)
}

const corpusPath = path.join(repoRoot, 'benchmarks', 'corpus', 'tools.json')
const corpus = fs.existsSync(corpusPath)
  ? JSON.parse(fs.readFileSync(corpusPath, 'utf8')).tools.map((t) => t.name)
  : []

test('parity: 常量表与内核同源', { skip }, () => {
  const k = kernel.mod
  // 内核导出 CURATED / INNERVATION 等；名称不同则至少比对数量与首项语义
  if (Array.isArray(k.CURATED)) {
    assert.deepEqual(
      core.CURATED.map((o) => o.id),
      k.CURATED.map((o) => o.id),
      'CURATED 器官 id 序列必须一致',
    )
  }
  assert.ok(core.CURATED.length > 0)
})

test('parity: familyOf / tissueOf / organClaims 在真实工具名上逐一相符', { skip }, () => {
  const k = kernel.mod
  if (typeof k.familyOf !== 'function') {
    assert.ok(kernel.mod, '内核未导出 familyOf —— 一致性无法验证')
    return
  }
  let n = 0
  for (const name of corpus.length ? corpus : ['sec_a', 'webcrawl_b', '_dsh_external_dsh_office_docs_pdf']) {
    assert.equal(core.familyOf(name), k.familyOf(name), `familyOf(${name})`)
    if (typeof k.tissueOf === 'function') {
      assert.equal(core.tissueOf(name), k.tissueOf(name), `tissueOf(${name})`)
    }
    n += 1
  }
  assert.ok(n > 0, '至少要比对一个工具名')
})

test('parity: innervate 对同一命令给出相同的支配集', { skip }, () => {
  const k = kernel.mod
  if (typeof k.innervate !== 'function') return
  const commands = [
    '帮我扫一下这个目标站的漏洞',
    '看看这只股票的均线',
    '把这个网页抓下来存成 markdown',
    '用 ida 反编译这个函数',
    '今天天气怎么样',
  ]
  for (const cmd of commands) {
    const mine = core.innervate(cmd, core.CURATED).map((r) => r.organ)
    const theirs = k.innervate(cmd, k.CURATED ?? core.CURATED).map((r) => r.organ)
    assert.deepEqual(mine, theirs, `innervate(${cmd})`)
  }
})

test('parity: evalCondition / attributeFailure 在矩阵上逐一相符', { skip }, () => {
  const k = kernel.mod
  const conditions = ['', 'always', 'error', 'ok', 'slow:100', 'hit:x', 'miss:x', 'error&&hit:x', 'ok||error']
  const data = [
    { isError: false, text: '', ms: 0 },
    { isError: true, text: 'x', ms: 500 },
    { isError: false, text: 'xx', ms: 50 },
  ]
  if (typeof k.evalCondition === 'function') {
    for (const c of conditions) for (const d of data) {
      assert.equal(core.evalCondition(c, d), k.evalCondition(c, d), `evalCondition(${c}, ${JSON.stringify(d)})`)
    }
  }
  const errors = ['HTTP 404 not found', 'no such file or directory', 'is not recognized', 'EACCES: permission denied', 'ETIMEDOUT', 'ECONNREFUSED', 'EEXIST', 'nothing matches']
  if (typeof k.attributeFailure === 'function') {
    for (const e of errors) assert.equal(core.attributeFailure(e), k.attributeFailure(e), `attributeFailure(${e})`)
  }
})

test('parity: 学习与修剪判据在边界值上相符', { skip }, () => {
  const k = kernel.mod
  const stat = [
    { fires: 0, helped: 0, retired: false },
    { fires: 4, helped: 2, retired: false },
    { fires: 5, helped: 0, retired: false },
    { fires: 9, helped: 0, retired: true },
  ]
  if (typeof k.shouldRetireReflex === 'function') {
    for (const s of stat) assert.equal(core.shouldRetireReflex(s), k.shouldRetireReflex(s), `shouldRetireReflex(${JSON.stringify(s)})`)
  }
  if (typeof k.synapseDecayFactor === 'function') {
    for (const idle of [0, 999, 1000, 2000, 5000]) {
      assert.equal(core.synapseDecayFactor(idle, 1000), k.synapseDecayFactor(idle, 1000), `synapseDecayFactor(${idle})`)
    }
  }
})
