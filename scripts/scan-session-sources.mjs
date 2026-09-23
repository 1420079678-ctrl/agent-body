#!/usr/bin/env node
/**
 * scan-session-sources.mjs —— 在**多帧 zstd** 的 session.jsonl.zstd 里找出
 * 仍然是退役包装 `{"kind":"plugin"}` 的消息源（v4 格式的 admission 会拒绝它）。
 *
 * 为什么不能直接 zstd -d / Select-String：
 *   DSH 的会话日志是多帧 zstd（每帧一段 JSONL），常见的单帧解压器只解第一帧，
 *   后面的行根本读不到 —— 于是「没找到」是假的。
 *
 * 用法：
 *   node scan-session-sources.mjs <path-to-session.jsonl.zstd> [more files...]
 *   node scan-session-sources.mjs --dir "$env:DSH_HOME/sessions"
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 扫描出所有 zstd 帧的起始偏移（复刻 DSH 自己的 scanZstdFrames 思路） */
function frameOffsets(buf) {
  const offsets = []
  let index = buf.indexOf(MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buf.indexOf(MAGIC, index + MAGIC.length)
  }
  return offsets
}

/** 解出该文件全部帧拼接后的 JSONL 文本；返回 { text, frames, failed } */
function decodeAll(buf) {
  const offsets = frameOffsets(buf)
  if (offsets.length === 0) return { text: '', frames: 0, failed: 1 }
  if (offsets[0] !== 0) return { text: '', frames: offsets.length, failed: 1 }
  const parts = []
  let failed = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    // 该帧的数据到下一帧魔数为止（最后一帧到文件尾）；多给一点尾巴让解压器自己收尾
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // 尾帧截断/损坏是真实的（会话被中断），单独计数而不是当成 0 行
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start)).toString('utf8'))
      } catch { failed += 1 }
    }
  }
  return { text: parts.join(''), frames: offsets.length, failed }
}

/** 递归收集会话日志 */
function collect(target, into) {
  const stat = fs.statSync(target)
  if (stat.isFile()) { into.push(target); return }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) collect(full, into)
    else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) into.push(full)
  }
}

const args = process.argv.slice(2)
const files = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--dir') { collect(args[i + 1], files); i += 1 } else files.push(args[i])
}
if (files.length === 0) {
  console.error('用法: node scan-session-sources.mjs <file...> | --dir <sessions-dir>')
  process.exit(2)
}

let scanned = 0, totalRows = 0, retired = 0, missingSource = 0, broken = 0
const producers = new Map()
const samples = []

for (const file of files) {
  let buf
  try { buf = fs.readFileSync(file) } catch { broken += 1; continue }
  const { text, frames, failed } = decodeAll(buf)
  if (failed > 0 || text.length === 0) { broken += 1; continue }
  scanned += 1
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let row
    try { row = JSON.parse(trimmed) } catch { continue }
    totalRows += 1
    const data = row?.data
    if (!data || typeof data !== 'object') continue
    // 与 assertV4SourceRowAdmission 同一批「声明的消息槽」
    let messages = []
    if (row.type === 'user/message') messages = [data]
    else if (['system/message', 'assistant/message', 'tool/result'].includes(row.type)) messages = [data.message]
    else if (row.type === 'agent/inbox/spliced') messages = data.inserted
    else if (row.type === 'session/title-llm-request') messages = data.messages
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const source = message.source
      const kind = source && typeof source === 'object' ? source.kind : undefined
      if (kind === 'plugin') {
        retired += 1
        const producer = typeof source.plugin === 'string' ? source.plugin : '<no plugin field>'
        producers.set(producer, (producers.get(producer) ?? 0) + 1)
        if (samples.length < 8) samples.push({ file: path.basename(file), row: row.type, source })
      } else if (kind === undefined) {
        missingSource += 1
      }
    }
  }
}

console.log(`扫描文件        ${scanned} 个（跳过/损坏 ${broken}）`)
console.log(`可解析行        ${totalRows}`)
console.log(`退役包装 kind=plugin 的消息   ${retired}   ← v4 admission 会拒绝这些`)
console.log(`缺 source/kind 的消息         ${missingSource}`)
if (producers.size > 0) {
  console.log('\n按生产方统计（需要迁移的那个就是它）：')
  for (const [name, count] of [...producers.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(6)}  ${name}`)
  }
  console.log('\n样例：')
  for (const sample of samples) console.log(`  ${sample.file} [${sample.row}] ${JSON.stringify(sample.source)}`)
} else if (retired === 0) {
  console.log('\n没有发现 kind=plugin —— 这些日志在 v4 admission 下不会因这条规则被拒。')
}
