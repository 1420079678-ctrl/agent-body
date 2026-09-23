#!/usr/bin/env node
/**
 * probe-source-kind.mjs —— 直接问宿主自己的编码器：v3 的**写入路径**接受哪些 source.kind？
 *
 * 判定矩阵：
 *   1. user/message      {kind:'plugin', plugin:'x'}   ← v3 旧写法（对照组，应通过）
 *   2. user/message      {kind:'plugin:x'}             ← v4 要求的形式（问题所在）
 *   3. agent/inbox/spliced  同上两种
 *   4. system/message    {kind:'plugin:x'}             ← 已知 v3 对 system/message 有额外要求
 *
 * 不连任何服务、不写任何会话：只调 encodeCurrentEvent（写路径用的就是它）。
 */

const catalogPath = process.argv[2]
const { sessionFormatCatalog } = await import(catalogPath)

const msg = (source) => ({
  id: 'probe-1', role: 'user', source, content: [{ type: 'text', text: 'probe' }],
})
const cases = [
  ['user/message  {kind:"plugin",plugin:"x"}', { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: msg({ kind: 'plugin', plugin: 'x' }) }],
  ['user/message  {kind:"plugin:x"}        ', { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: msg({ kind: 'plugin:x' }) }],
  ['inbox/spliced {kind:"plugin",plugin:"x"}', { type: 'agent/inbox/spliced', seq: 1, time: 1, data: { inserted: [msg({ kind: 'plugin', plugin: 'x' })] } }],
  ['inbox/spliced {kind:"plugin:x"}        ', { type: 'agent/inbox/spliced', seq: 1, time: 1, data: { inserted: [msg({ kind: 'plugin:x' })] } }],
  ['system/msg    {kind:"plugin",plugin:"x"}', { type: 'system/message', seq: 1, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: { ...msg({ kind: 'plugin', plugin: 'x' }), role: 'system' } } }],
  ['system/msg    {kind:"plugin:x"}        ', { type: 'system/message', seq: 1, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: { ...msg({ kind: 'plugin:x' }), role: 'system' } } }],
]

console.log('宿主当前格式版本:', sessionFormatCatalog.version ?? '(未知)')
console.log('')
for (const [label, event] of cases) {
  try {
    sessionFormatCatalog.encodeCurrentEvent(event)
    console.log(`  通过    ${label}`)
  } catch (error) {
    console.log(`  拒绝    ${label}   → ${error?.message ?? error}`)
  }
}
