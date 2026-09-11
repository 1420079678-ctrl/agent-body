#!/usr/bin/env node
/**
 * 从内核源码里**机械抽取**确定性常量表，杜绝手抄漂移。
 *
 * 为什么要有这个脚本：
 *   器官目录、神经支配表、组织规则是「意图路由」的事实源，它们活在
 *   `workspace/plugins/dsh-organism/src/index.ts` 里。基准与 SDK 需要它们，
 *   但**不能靠人手工复制**——手抄的表迟早和内核不一致，届时基准就在测一个
 *   不存在的系统。
 *
 * 做法：
 *   定位 `const NAME: Type = [` 之后的字面量，做括号配对切片，直接 `new Function`
 *   求值（这些字面量本身就是合法 JS，不含 TS 类型标注）。不依赖 tsc、不依赖宿主、不联网。
 *
 * 用法：
 *   node tools/extract-tables.mjs            # 生成 src/tables.generated.json
 *   node tools/extract-tables.mjs --check     # 只校验：与已提交的表是否一致（漂移即 exit 1）
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const repoRoot = path.resolve(pkgRoot, '..', '..')

const DEFAULT_KERNEL = path.join(
  repoRoot,
  'workspace',
  'plugins',
  'dsh-organism',
  'src',
  'index.ts',
)
const OUT_FILE = path.join(pkgRoot, 'src', 'tables.generated.json')

/** 需要抽取的表：名称 → 说明 */
const TABLES = {
  CURATED: '策展器官目录（id/label/group/capabilities/afferent/purpose/source）',
  INNERVATION: '神经支配表（命令意图 → 受支配器官）',
  TISSUE_RULES: '细胞 → 组织 的确定性规则',
  SEED_REFLEXES: '内置种子反射弧',
  ALWAYS_TOOLS: '不参与门控的核心常驻能力',
}

/**
 * 从 `text` 的 `start`（指向一个开括号）开始做括号配对，返回闭合括号的下标。
 * 会跳过字符串、模板串、注释与正则字面量——否则 `[...]` 会被里面的字符骗到。
 */
export function matchBracket(text, start) {
  const open = text[start]
  const close = open === '[' ? ']' : open === '{' ? '}' : open === '(' ? ')' : null
  if (!close) throw new Error(`not an opening bracket at ${start}: ${JSON.stringify(open)}`)
  let depth = 0
  let i = start
  let prevMeaningful = ''
  while (i < text.length) {
    const ch = text[i]
    // 行注释
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl + 1
      continue
    }
    // 块注释
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    // 模板串
    if (ch === '`') {
      i += 1
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i += 1
        i += 1
      }
      i += 1
      prevMeaningful = '`'
      continue
    }
    // 单/双引号串
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1
        i += 1
      }
      i += 1
      prevMeaningful = quote
      continue
    }
    // 正则字面量：只在 `:` `,` `(` `[` `=` `return` 之后出现时才算
    if (ch === '/' && (prevMeaningful === ':' || prevMeaningful === ',' || prevMeaningful === '(' || prevMeaningful === '[' || prevMeaningful === '=')) {
      i += 1
      while (i < text.length && text[i] !== '/') {
        if (text[i] === '\\') i += 1
        if (text[i] === '[') {
          // 字符类里的 `/` 不结束正则
          while (i < text.length && text[i] !== ']') {
            if (text[i] === '\\') i += 1
            i += 1
          }
        }
        i += 1
      }
      i += 1
      while (i < text.length && /[gimsuy]/.test(text[i])) i += 1
      prevMeaningful = '/'
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
    if (!/\s/.test(ch)) prevMeaningful = ch
    i += 1
  }
  throw new Error('unbalanced brackets — reach end of file')
}

/** 定位 `const NAME ... = [` 里那个开括号的下标 */
function findLiteralStart(text, name) {
  const re = new RegExp(`\\b(?:export\\s+)?const\\s+${name}\\s*(?::[^=]*)?=\\s*\\[`)
  const m = re.exec(text)
  if (!m) throw new Error(`table not found in kernel source: ${name}`)
  return m.index + m[0].length - 1
}

/** 抽取单张表 → JS 值 */
export function extractTable(text, name) {
  const start = findLiteralStart(text, name)
  const end = matchBracket(text, start)
  const literal = text.slice(start, end + 1)
  const value = new Function(`return (${literal})`)()
  return value
}

/** 抽取全部表 */
export function extractAll(kernelPath = DEFAULT_KERNEL) {
  const text = fs.readFileSync(kernelPath, 'utf8')
  const out = {}
  for (const name of Object.keys(TABLES)) out[name] = extractTable(text, name)
  return out
}

/** 正则字面量在 JSON 里会退化成 `{}` —— 显式编码，由 kernel 侧 reviver 还原 */
export function encodeRegExp(value) {
  if (value instanceof RegExp) return { $regex: value.source, $flags: value.flags }
  if (Array.isArray(value)) return value.map(encodeRegExp)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = encodeRegExp(v)
    return out
  }
  return value
}

/** 还原 `{$regex,$flags}` → RegExp */
export function decodeRegExp(value) {
  if (value && typeof value === 'object' && typeof value.$regex === 'string') {
    return new RegExp(value.$regex, value.$flags || '')
  }
  if (Array.isArray(value)) return value.map(decodeRegExp)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = decodeRegExp(v)
    return out
  }
  return value
}

function stableStringify(value) {
  return JSON.stringify(encodeRegExp(value), null, 2) + '\n'
}

function main() {
  const kernelPath = process.env.AGENT_BODY_KERNEL
    ? path.resolve(process.env.AGENT_BODY_KERNEL)
    : DEFAULT_KERNEL
  const check = process.argv.includes('--check')

  if (!fs.existsSync(kernelPath)) {
    console.error(`kernel source not found: ${kernelPath}`)
    console.error('set AGENT_BODY_KERNEL=/path/to/dsh-organism/src/index.ts to override')
    process.exit(2)
  }

  const tables = extractAll(kernelPath)
  const payload = {
    $comment:
      'GENERATED FILE — do not edit by hand. Produced by packages/organ-core/tools/extract-tables.mjs ' +
      'from workspace/plugins/dsh-organism/src/index.ts. Run `node tools/extract-tables.mjs` to regenerate, ' +
      '`node tools/extract-tables.mjs --check` to detect drift in CI.',
    source: path.relative(repoRoot, kernelPath).split(path.sep).join('/'),
    tables,
  }

  if (check) {
    if (!fs.existsSync(OUT_FILE)) {
      console.error(`DRIFT: ${path.relative(repoRoot, OUT_FILE)} is missing — run: node tools/extract-tables.mjs`)
      process.exit(1)
    }
    const current = fs.readFileSync(OUT_FILE, 'utf8')
    if (current !== stableStringify(payload)) {
      console.error('DRIFT: extracted kernel tables differ from the committed snapshot.')
      console.error('       The kernel changed. Regenerate with: node packages/organ-core/tools/extract-tables.mjs')
      process.exit(1)
    }
    const counts = Object.entries(tables)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '?'}`)
      .join(' ')
    console.log(`kernel tables in sync with ${payload.source}  (${counts})`)
    process.exit(0)
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, stableStringify(payload))
  const counts = Object.entries(tables)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '?'}`)
    .join(' ')
  console.log(`wrote ${path.relative(repoRoot, OUT_FILE)}  (${counts})`)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
