#!/usr/bin/env node
/**
 * 生成 catalog/organs.json —— 机器可读的器官目录。
 *
 * 产物用途：安装器读它决定默认装哪些；评审读它看谁要什么权限；
 * 基准读它统计分级覆盖。所以它必须是**校验通过**的，不能是手写的善意声明。
 *
 * 用法：node catalog/build.mjs [--check]
 *   --check：不写文件，只校验现有 organs.json 与源码一致（CI 用）
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { ORGAN_TIERS, TIER_POLICY, defaultInstallSet, validateOrganManifest } from '../packages/organ-core/src/index.mjs'
import { buildOrganManifests } from './organs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outFile = path.join(here, 'organs.json')

const manifests = buildOrganManifests().sort((a, b) => (a.id < b.id ? -1 : 1))

// ① 逐个校验契约
const results = manifests.map((m) => ({ id: m.id, ...validateOrganManifest(m) }))
const invalid = results.filter((r) => !r.ok)
if (invalid.length > 0) {
  console.error(`✗ ${invalid.length} 个器官不符合契约：`)
  for (const r of invalid) {
    console.error(`  ${r.id}:`)
    for (const e of r.errors) console.error(`    - ${e.path}: ${e.message}`)
  }
  process.exit(1)
}

// ② 分级卫生：专业/实验级器官不得出现在默认安装集里
const defaultSet = defaultInstallSet(manifests)
const leaked = manifests.filter((m) => TIER_POLICY[m.tier].defaultInstall === false && defaultSet.includes(m.id))
if (leaked.length > 0) {
  console.error(`✗ 非默认分级器官混进了默认安装集：${leaked.map((m) => m.id).join(', ')}`)
  process.exit(1)
}

const doc = {
  $comment:
    '器官目录：分级 + 权限声明 + 失败处置承诺。由 node catalog/build.mjs 从内核源码与 catalog/organs.mjs 生成，请勿手改。',
  schemaVersion: '0.1.0',
  tiers: ORGAN_TIERS.map((t) => ({ id: t, ...TIER_POLICY[t] })),
  organs: manifests,
  defaultInstall: defaultSet,
  stats: {
    organs: manifests.length,
    capabilities: manifests.reduce((s, m) => s + m.capabilities.length, 0),
    byTier: Object.fromEntries(
      ORGAN_TIERS.map((t) => [t, manifests.filter((m) => m.tier === t).length]),
    ),
    highRiskOrgans: manifests.filter((m) => m.permissions.some((p) => p.startsWith('exec:') || p.startsWith('net:listen') || p.startsWith('secrets:') || p.startsWith('host:'))).map((m) => m.id),
  },
}

const serialized = JSON.stringify(doc, null, 2) + '\n'

if (process.argv.includes('--check')) {
  if (!fs.existsSync(outFile)) {
    console.error('✗ catalog/organs.json 不存在 —— 运行 node catalog/build.mjs')
    process.exit(1)
  }
  if (fs.readFileSync(outFile, 'utf8') !== serialized) {
    console.error('✗ catalog/organs.json 与源码不一致 —— 运行 node catalog/build.mjs 重新生成')
    process.exit(1)
  }
  console.log(`✓ 器官目录与源码一致（${manifests.length} 个器官，默认安装 ${defaultSet.length} 个）`)
} else {
  fs.writeFileSync(outFile, serialized)
  console.log(
    `wrote catalog/organs.json  (organs=${manifests.length} default=${defaultSet.length} ` +
      `byTier=${JSON.stringify(doc.stats.byTier)})`,
  )
}
