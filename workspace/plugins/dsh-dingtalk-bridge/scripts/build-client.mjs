#!/usr/bin/env node
/**
 * build-client.mjs — 客户端 bundle 构建器（免 tsdown / 免依赖）。
 *
 * 读取 src/client/index.ts（以「TS 兼容的 JS 写法」编写，无 TS 运行时语法），
 * 做最小变换（ESM export → CJS），套上 ModuleLoader banner，写出 lib/client.js。
 *
 * banner 格式与 tsdown 产物一致：window.__ModuleLoader__.load({ id, factory })
 * —— 注入器以此识别「合法 client bundle」。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'client', 'index.ts')
const OUT = join(ROOT, 'lib', 'client.js')

let code = readFileSync(SRC, 'utf8')

// 1) 去掉类型 import（运行时不需要）
code = code.replace(/^import\s+type\s+.*$/gm, '')

// 2) ESM → CJS 最小变换
code = code.replace(/export\s+const\s+inject\s*=\s*(\[[^\]]*\])/, 'module.exports.inject = $1')
code = code.replace(/export\s+function\s+apply/, 'function apply')
code += '\nmodule.exports.apply = apply\n'

// 3) ModuleLoader banner 包裹（含 CJS 沙箱）
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const bundle = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
${code}
return module.exports; } });
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, bundle, 'utf8')
console.log(`[build-client] ${pkg.name} → lib/client.js (${bundle.length} bytes)`)
