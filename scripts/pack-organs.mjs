#!/usr/bin/env node
/**
 * 打「自足器官」的发行包（release tarball），从仓库**可复现**地构建。
 *
 * 为什么需要它：仓库只提交了三个器官的 `lib/`，其余七个只有 `src/`。直接用
 * `npm pack` 打那七个，`files: [lib, cordis.patch.yml]` 里的 `lib` 不存在，npm 会静默略过 ——
 * 打出来的包 `main` 指向一个不存在的文件，装上去根本起不来。真实发生过一次（2026-09-23）。
 *
 * 所以本脚本：为每个器官在**临时目录**里组装一个待发布的包（清单 + patch + README +
 * 已提交的 lib，或现场用 tsc 构建的 lib），再从那里 `npm pack`，产物落到 `--out`。
 * 仓库工作区全程不被写入。
 *
 * tsc 从哪来：仓库本身零依赖，所以按顺序找
 *   ① `--tsc <path>` ② 环境变量 `AGENT_BODY_TSC` ③ PATH 上的 `tsc`
 * 全都没有时，只为「仓库已提交 lib」的器官打包，并对缺 lib 的给出明确失败清单（不静默降级）。
 *
 * Usage:
 *   node scripts/pack-organs.mjs --out dist-tarballs [--tsc C:\path\to\tsc.cmd]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.join(repoRoot, 'workspace', 'plugins')

/** README 里对外承诺「一条命令安装」的那十个自足器官 */
const SELF_CONTAINED = [
  'dsh-organism', 'dsh-cortex', 'dsh-zero-residence', 'dsh-mastery-loop', 'dsh-social-card',
  'dsh-academic-research', 'dsh-pentagi', 'dsh-vuln-remediator', 'dsh-reverse-skill', 'dsh-office-docs',
]

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const outDir = path.resolve(repoRoot, arg('--out', 'dist-tarballs'))
const tscArg = arg('--tsc', process.env.AGENT_BODY_TSC ?? '')

function resolveTsc() {
  if (tscArg && fs.existsSync(tscArg)) return tscArg
  const probe = spawnSync('tsc', ['--version'], { encoding: 'utf8', shell: true, windowsHide: true })
  return probe.status === 0 ? 'tsc' : undefined
}

const tsc = resolveTsc()
fs.mkdirSync(outDir, { recursive: true })
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-body-pack-'))

const packed = []
const skipped = []

for (const organ of SELF_CONTAINED) {
  const src = path.join(pluginsRoot, organ)
  const dst = path.join(stage, organ)
  fs.mkdirSync(dst, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'README.md']) {
    const from = path.join(src, file)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, file))
  }

  const committedLib = path.join(src, 'lib', 'index.js')
  if (fs.existsSync(committedLib)) {
    fs.cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true })
  } else if (tsc !== undefined) {
    const args = [
      '-p', path.join(src, 'tsconfig.json'),
      '--outDir', path.join(dst, 'lib'),
      '--declarationDir', path.join(dst, 'lib', 'types'),
    ]
    // 公开快照没有 node_modules，缺 @types/node 会让 tsc 直接放弃；有的话顺手指过去。
    const appTypes = path.join(repoRoot, 'node_modules', '@types')
    if (fs.existsSync(appTypes)) args.push('--typeRoots', appTypes)
    spawnSync(tsc, args, { cwd: src, encoding: 'utf8', stdio: 'pipe', shell: /\.cmd$/.test(tsc), windowsHide: true })
  }

  if (!fs.existsSync(path.join(dst, 'lib', 'index.js'))) {
    skipped.push(organ)
    continue
  }

  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--silent'], {
    cwd: dst, encoding: 'utf8', shell: true, windowsHide: true,
  })
  const name = (pack.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop()
  if (!name || !fs.existsSync(path.join(dst, name))) {
    skipped.push(`${organ}（npm pack 未产出）`)
    continue
  }
  fs.copyFileSync(path.join(dst, name), path.join(outDir, name))
  packed.push(name)
}

fs.rmSync(stage, { recursive: true, force: true })

console.log(`打包目录  ${path.relative(repoRoot, outDir)}`)
console.log('-------------------------------------------------------------------')
for (const name of packed) {
  const bytes = fs.statSync(path.join(outDir, name)).size
  console.log(`  OK    ${name}  (${Math.round(bytes / 1024)} KB)`)
}
for (const organ of skipped) console.log(`  FAIL  ${organ} —— 没有 lib 且无法构建（--tsc 指定编译器后重试）`)
console.log('-------------------------------------------------------------------')
console.log(`  ${packed.length} 个发行包，${skipped.length} 个未产出`)
if (skipped.length > 0) process.exit(1)
