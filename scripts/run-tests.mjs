#!/usr/bin/env node
/**
 * 跨平台测试入口：不依赖 shell 的 glob 展开。
 *
 * 为什么不用 `node --test "packages/**\/*.test.mjs"`：Windows 上 cmd/pwsh/Git Bash 展开
 * glob 的行为各不相同，一旦有一处不展开，node 会把模式当文件名去找、报 MODULE_NOT_FOUND，
 * 而看起来像「测试失败」。新人第一脚就踩这个坑太亏，所以自己找文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

const files = walk(path.join(repoRoot, 'packages')).sort()
if (files.length === 0) {
  console.error('no *.test.mjs found under packages/')
  process.exit(1)
}

console.log(`running ${files.length} test file(s):`)
for (const f of files) console.log(`  ${path.relative(repoRoot, f)}`)

const r = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  windowsHide: true,
  cwd: repoRoot,
})
process.exit(r.status ?? 1)
