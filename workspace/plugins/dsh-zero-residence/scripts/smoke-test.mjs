// Offline regression: synthetic sessions only, never reads the operator's history.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zr-test-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed++; console.log(`PASS ${label}`) }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`) }
}
try {
  const { apply, buildPointerManifest, computeLedger } = await import('../lib/index.js')
  const payload = 'synthetic payload 中文🙂\n'.repeat(500)
  const result = (id, text) => ({ type: 'tool/result', seq: 2, data: {
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: id, content: text }] },
  } })
  const events = [
    { type: 'system/message', seq: 0, data: { text: 'fixture system' } },
    { type: 'user/message', seq: 1, data: { message: { role: 'user', content: [{ type: 'text', text: 'fixture task' }] } } },
    result('call-10', 'wrong prefix match'),
    result('other-id', 'a narrative mention of call-1 is not its identity'),
    result('call-1', payload),
    { type: 'request/header', seq: 3, data: { header: { tools: [] } } },
    { type: 'request/header', seq: 4, data: { header: { tools: [] } } },
  ]
  function session(id, items, compressed = false) {
    const dir = path.join(home, 'sessions', '2026', id)
    fs.mkdirSync(dir, { recursive: true })
    const data = compressed
      ? Buffer.concat(items.map(e => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n'))))
      : items.map(e => JSON.stringify(e) + '\n').join('')
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl' + (compressed ? '.zstd' : '')), data)
  }
  session('session-a', events)
  session('session-b', [result('call-1', 'second session payload')])
  session('session-a-extra', [result('call-1', 'similar session name payload')])
  session('session-zstd', events, true)
  const messages = events.flatMap(e => e.data?.message ? [e.data.message] : [])
  const manifest = buildPointerManifest(messages, 120)
  await check('pointer manifest retains all message entries', () => assert.equal(manifest.entries, messages.length))
  await check('tool payloads use pointers', () => assert.equal(manifest.pointerOnly, 3))
  await check('large payload compression exceeds 5x', () => assert.ok(manifest.shadowedTokens / manifest.manifestTokens > 5))
  await check('manifest carries reconstruction key', () => assert.ok(manifest.text.includes('key=call-1')))
  await check('manifest excludes full payload', () => assert.ok(!manifest.text.includes(payload)))
  await check('empty input remains valid', () => assert.equal(buildPointerManifest([], 120).entries, 0))
  await check('plain JSONL ledger counts requests', () => assert.match(computeLedger('session-a'), /T = 2/))
  await check('concatenated zstd ledger matches plain ledger', () => {
    assert.equal(computeLedger('session-zstd').replaceAll('session-zstd', 'session-a'), computeLedger('session-a'))
  })
  await check('missing session is explicit', () => assert.match(computeLedger('session-missing'), /未找到会话日志/))
  const registered = new Map()
  apply({ effect: fn => fn(), tools: { register: tool => { registered.set(tool.name, tool) } },
    logger: { info() {}, warn() {} } },
  { engine: false, narrativeHeadChars: 120, jobDir: '', thresholdRatio: 0.15, retainTokens: 40000 })
  const recall = args => registered.get('zr_recall').execute(args)
  await check('recall matches exact call ID and restores complete payload', async () => {
    const text = await recall({ key: 'call-1', session: 'session-a', maxChars: 100000 })
    assert.match(text, /来源: session-a\//)
    assert.equal(JSON.parse(text.split('\n\n')[1]).message.content[0].content, payload)
  })
  await check('recall respects session selection', async () => {
    assert.match(await recall({ key: 'call-1', session: 'session-b' }), /second session payload/)
  })
  await check('similar session names remain distinct', async () => {
    assert.match(await recall({ key: 'call-1', session: 'session-a-extra' }), /similar session name payload/)
  })
  await check('missing scoped session never falls back to another session', async () => {
    assert.match(await recall({ key: 'call-1', session: 'session-missing' }), /未在持久日志中找到/)
  })
  await check('recall does not match a partial call ID', async () => {
    assert.match(await recall({ key: 'call-', session: 'session-a' }), /未在持久日志中找到/)
  })
  await check('recall rejects empty keys', async () => {
    assert.match(await recall({ key: '', session: 'session-a' }), /未在持久日志中找到/)
  })
  await check('unscoped recall still works', async () => {
    assert.match(await recall({ key: 'other-id' }), /narrative mention/)
  })
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`\n${passed} passed / ${failed} failed (isolated synthetic sessions)`)
process.exitCode = failed ? 1 : 0
