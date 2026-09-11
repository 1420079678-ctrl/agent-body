import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALWAYS_TOOLS, buildAnatomy, measureGate, organAlive, schemaTokens, workingSet } from '../src/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const corpusPath = path.join(repoRoot, 'benchmarks', 'corpus', 'tools.json')

function loadCorpus() {
  if (!fs.existsSync(corpusPath)) return null
  const raw = JSON.parse(fs.readFileSync(corpusPath, 'utf8'))
  return raw.tools ?? raw
}

const corpus = loadCorpus()

test('buildAnatomy: 每个工具都被某个器官认领，不留游离能力', { skip: !corpus && 'corpus missing' }, () => {
  const tools = corpus.map((t) => t.name)
  const organs = buildAnatomy(tools)
  const claimed = new Set()
  for (const o of organs) {
    for (const t of tools) {
      if (o.capabilities.some((c) => (c.endsWith('*') ? t.startsWith(c.slice(0, -1)) : c === t))) claimed.add(t)
    }
  }
  const unclaimed = tools.filter((t) => !claimed.has(t))
  assert.deepEqual(unclaimed, [], `未被认领的工具: ${unclaimed.join(', ')}`)
  assert.ok(organs.some((o) => o.id.startsWith('auto:')), '应当存在自主升格的器官')
})

test('workingSet: 常驻集永不隐藏，意图决定显影', { skip: !corpus && 'corpus missing' }, () => {
  const tools = corpus.map((t) => t.name)
  const organs = buildAnatomy(tools)

  const scan = workingSet({ command: '帮我扫一下这个目标站的漏洞', tools, organs })
  assert.ok(scan.keep.has('read'), 'ALWAYS_TOOLS 里的 read 必须始终可见')
  assert.ok(scan.keep.has('write'))
  assert.ok(scan.keep.has('body_call'), '通用网关必须始终可见，否则被隐藏的能力无法取回')
  assert.ok(
    scan.dispatch.some((d) => d.organ === 'innate_immunity'),
    '扫描意图必须支配到免疫器官',
  )
  assert.ok(
    [...scan.keep].some((t) => t.startsWith('sec_')),
    '被支配器官的能力要显影出来',
  )
  // 注意：不保证某个**具体**的 sec_* 可见 —— 单器官只显影前 perOrganCap 项，
  // 大型器官（innate_immunity 有 49 项）必然有截断，其余经 body_call 取回。
  // 这是设计取舍，不是缺陷；基准里以 capped 类别如实报告。
  assert.ok(scan.keep.size < tools.length, '门控必须真的隐藏了东西')

  const unrelated = workingSet({ command: '今天天气怎么样', tools, organs })
  assert.ok(!unrelated.keep.has('sec_exec'), '无关意图不该显影攻击能力')
  assert.ok(unrelated.keep.size < scan.keep.size)

  assert.deepEqual(
    [...workingSet({ command: '写个脚本跑一下', tools, organs }).keep].sort(),
    [...workingSet({ command: '写个脚本跑一下', tools, organs }).keep].sort(),
  )
})

test('workingSet: 冷启动下 hot 集只由意图决定，不受本机历史影响', { skip: !corpus && 'corpus missing' }, () => {
  const tools = corpus.map((t) => t.name)
  const organs = buildAnatomy(tools)
  const ws = workingSet({ command: '抓取这个网页', tools, organs })
  assert.ok(ws.dispatch.length > 0)
  assert.ok(ws.dispatch.length <= 4, 'topK=4')
  assert.ok(ws.revealed.every((r) => r.tools.length <= 10), 'perOrganCap=10')
})

test('measureGate: 全量 > 门控，且结果自描述', { skip: !corpus && 'corpus missing' }, () => {
  const tasks = [
    { id: 'T-scan', command: '帮我扫一下这个目标站的漏洞', expect: ['sec_webtest'] },
    { id: 'T-crawl', command: '把这个网页抓下来存成 markdown', expect: ['webcrawl'] },
    { id: 'T-write', command: '写个脚本然后跑一下', expect: ['write', 'pwsh'] },
  ]
  const r = measureGate({ tasks, toolSchemas: corpus, counter: schemaTokens })

  assert.equal(r.full.tools, corpus.length)
  assert.ok(r.full.tokens > 0)
  assert.ok(r.saved.pct.mean > 0, '门控必须省下 token')
  assert.ok(r.saved.pct.mean < 1, '不可能省掉 100%（常驻集还在）')
  assert.equal(r.corpus.tasks, 3)
  assert.equal(r.gate.coldStart, true)
  assert.equal(r.gated.tools.max, Math.max(...r.per.map((p) => p.visibleTools)))

  // 正确性护栏：只对**缺陷类**漏显影判失败（常驻集被藏 / 无人认领）。
  // capped 与 unrouted 是设计取舍，有 body_call 网关兜底，报告里如实列出即可。
  assert.equal(
    r.expectation.totals.bug,
    0,
    `缺陷类漏显影: ${JSON.stringify(r.expectation.byClass.bug)}`,
  )
  assert.equal(r.expectation.missDetails.length, r.expectation.totals.bug + r.expectation.totals.capped + r.expectation.totals.unrouted)

  // 确定性：同样输入两次完全一致
  const again = measureGate({ tasks, toolSchemas: corpus, counter: schemaTokens })
  assert.deepEqual(again.saved, r.saved)
})

test('organAlive: 空能力视为活着（纯计算器官）', () => {
  assert.ok(organAlive({ capabilities: [] }, []))
  assert.ok(!organAlive({ capabilities: ['nope_*'] }, ['read']))
})
