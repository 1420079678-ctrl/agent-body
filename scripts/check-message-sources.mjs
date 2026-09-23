#!/usr/bin/env node
/**
 * 门禁：插件写进会话日志的 `source.kind` 必须是**两代通用**的形式。
 *
 * 背景（2026-09-23 实测）：会话格式 v3 的白名单只约束 v2→v3 迁移，原生 v3 写入不校验
 * 普通消息的 kind；v4 的 admission 又明确拒绝 `kind === 'plugin'`。于是
 * `{ kind: 'plugin', plugin: 'X' }` 成了「在能跑的版本上能跑、到 v4 宿主上让整轮失败」的写法：
 *
 *     本轮运行失败  format v4 message requires a producer-owned source kind
 *
 * 本门禁做两件事：
 *   1. FAIL —— 任何插件源码/产物里出现**退役包装** `{ kind: 'plugin', plugin: … }`；
 *   2. FAIL —— 插件里写的 `plugin:<名字>` 与 SDK 的 `injectedSource()` 产出不一致
 *      （parity：两处定义不许漂移，改一处必须改另一处）。
 *
 * 零依赖、不联网、不执行插件代码。
 *
 * Usage: node scripts/check-message-sources.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { injectedSource } from '../packages/organ-sdk/src/index.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.join(repoRoot, 'workspace', 'plugins')

/** 退役包装：任何引号风格 + 任意空白 */
const RETIRED = /kind\s*:\s*(['"])plugin\1\s*,\s*plugin\s*:/g
/** 两代通用形式 */
const PORTABLE = /kind\s*:\s*(['"])plugin:([^'"]+)\1/g

const SCAN_DIRS = ['src', 'lib']
const EXT = new Set(['.ts', '.js', '.mjs', '.cjs'])

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (EXT.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

const retired = []
const portable = []

for (const plugin of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue
  for (const sub of SCAN_DIRS) {
    for (const file of walk(path.join(pluginsRoot, plugin.name, sub))) {
      const text = fs.readFileSync(file, 'utf8')
      const rel = path.relative(repoRoot, file).replaceAll('\\', '/')
      for (const m of text.matchAll(RETIRED)) {
        retired.push(`${rel}:${text.slice(0, m.index).split('\n').length}`)
      }
      for (const m of text.matchAll(PORTABLE)) {
        portable.push({ rel, name: m[2], line: text.slice(0, m.index).split('\n').length })
      }
    }
  }
}

const fail = []
if (retired.length > 0) {
  fail.push(
    `${retired.length} 处仍是退役包装 { kind: 'plugin', plugin: … }` +
      ` —— v4 宿主会以「format v4 message requires a producer-owned source kind」拒绝整轮：\n` +
      retired.map((r) => `  - ${r}`).join('\n'),
  )
}

// parity：树内写法与 SDK 助手必须产出同一个值
const drifted = portable.filter((p) => injectedSource(p.name).kind !== `plugin:${p.name}`)
if (drifted.length > 0) {
  fail.push(
    `${drifted.length} 处与 SDK 的 injectedSource() 不一致（两处定义漂移）：\n` +
      drifted.map((d) => `  - ${d.rel}:${d.line}`).join('\n'),
  )
}

console.log('message sources')
console.log('-------------------------------------------------------------------')
console.log(`  扫描插件目录      ${fs.readdirSync(pluginsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).length} 个`)
console.log(`  两代通用写法      ${portable.length} 处`)
console.log(`  退役包装          ${retired.length} 处`)
console.log('-------------------------------------------------------------------')

if (fail.length > 0) {
  for (const line of fail) console.log(`  FAIL  ${line}`)
  process.exit(1)
}
console.log('  OK    所有插件的消息来源都是两代通用形式，且与 organ-sdk 的 injectedSource() 一致')
