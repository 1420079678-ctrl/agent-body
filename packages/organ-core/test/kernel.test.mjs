import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALWAYS_TOOLS,
  CURATED,
  attributeFailure,
  cellState,
  compensateFor,
  estimateTokens,
  evalCondition,
  familyOf,
  fillTemplate,
  innervate,
  matchTrigger,
  organAlive,
  organClaims,
  schemaTokens,
  shouldBoostReflex,
  shouldForgetSkill,
  shouldPruneSynapse,
  shouldRetireReflex,
  synapseDecayFactor,
  tissueOf,
} from '../src/index.mjs'

test('familyOf: 归一化外部包前缀与多段家族', () => {
  assert.equal(familyOf('sec_webtest'), 'sec')
  assert.equal(familyOf('agi_memory'), 'agi')
  assert.equal(familyOf('_dsh_external_dsh_office_docs_pdf'), 'office_docs')
  assert.equal(familyOf('_dsh_external_dsh_browser_ultimate_snap'), 'browser_ultimate')
  assert.equal(familyOf('dsh_social_card_render'), 'social_card')
  assert.equal(familyOf('write'), 'write')
})

test('organClaims: 通配前缀必须精确，不误伤相邻家族', () => {
  const immune = { id: 'immunity', capabilities: ['sec_*', 'vuln_*'] }
  assert.ok(organClaims(immune, 'sec_autoscan'))
  assert.ok(organClaims(immune, 'vuln_scan'))
  assert.ok(!organClaims(immune, 'rev_route'))
  assert.ok(!organClaims(immune, 'secx_tool'))
  const hands = { id: 'hands', capabilities: ['write', 'edit'] }
  assert.ok(organClaims(hands, 'write'))
  assert.ok(!organClaims(hands, 'write_file'))
})

test('matchTrigger: `!` 排除优先于正模式（防自触发）', () => {
  assert.ok(matchTrigger('*', 'anything'))
  assert.ok(!matchTrigger('*,!body_*', 'body_map'))
  assert.ok(matchTrigger('*,!body_*', 'read'))
  assert.ok(matchTrigger('sec_*,vuln_*', 'vuln_scan'))
  assert.ok(!matchTrigger('sec_*,vuln_*', 'read'))
  assert.ok(!matchTrigger('', 'read'))
})

test('evalCondition: 无 eval 的确定性条件求值', () => {
  const E = (isError, text, ms = 0) => ({ isError, text, ms })
  assert.ok(evalCondition('', E(false, '')))
  assert.ok(evalCondition('always', E(false, '')))
  assert.ok(evalCondition('error', E(true, '')))
  assert.ok(!evalCondition('error', E(false, '')))
  assert.ok(evalCondition('slow:500', E(false, '', 900)))
  assert.ok(!evalCondition('slow:500', E(false, '', 100)))
  assert.ok(evalCondition('hit:ENOENT', E(true, 'spawn foo ENOENT')))
  assert.ok(evalCondition('miss:ok', E(true, 'bad')))
  assert.ok(evalCondition('error&&hit:timeout', E(true, 'connect timeout')))
  assert.ok(!evalCondition('error&&hit:timeout', E(true, 'other')))
  assert.ok(evalCondition('ok||error', E(true, '')))
  assert.ok(!evalCondition('bogus', E(false, '')))
})

test('attributeFailure: 归因顺序正确（URL 404 不得被吞成 tool_missing）', () => {
  assert.equal(attributeFailure('HTTP 404 not found'), 'not_found')
  assert.equal(attributeFailure('no such file or directory'), 'not_found')
  assert.equal(attributeFailure("'foo' is not recognized as an internal command"), 'tool_missing')
  assert.equal(attributeFailure('不会被识别为 cmdlet'), 'tool_missing')
  assert.equal(attributeFailure('invalid arguments: missing required property "file_path"'), 'arg_error')
  assert.equal(attributeFailure('EACCES: permission denied'), 'permission')
  assert.equal(attributeFailure('request timed out'), 'timeout')
  assert.equal(attributeFailure('connect ECONNREFUSED 127.0.0.1:1'), 'network')
  assert.equal(attributeFailure('EEXIST: file already exists'), 'conflict')
  assert.equal(attributeFailure(''), 'unknown')
})

// 已知盲区，不是「预期行为」：内核的中文 PowerShell 话术只覆盖了「不会被识别为」，
// 而 Windows 上真实抛出的文案是「无法将“x”项识别为 cmdlet、函数、脚本文件或可运行程序的名称」。
// 后果是这类失败被归因成 unknown（走「检索历史经验」处方），而不是 tool_missing（走「盘点工具链」）。
// 这里把它固定成测试，是为了让修复它的人必须先改这条断言——而不是让盲区悄悄漂走。
test('attributeFailure: 已知盲区 —— 真实中文 PowerShell 文案被归为 unknown', () => {
  const realWinMessage =
    'foo : 无法将“foo”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。'
  assert.equal(attributeFailure(realWinMessage), 'unknown')
})


test('tissueOf: 组织归档是确定性的且覆盖每一类', () => {
  assert.equal(tissueOf('sec_exploit'), '效应组织')
  assert.equal(tissueOf('web_search'), '感知组织')
  assert.equal(tissueOf('sec_evidence'), '记忆组织')
  assert.equal(tissueOf('quant_sma'), '计量组织')
  assert.equal(tissueOf('vuln_patch_gen'), '合成组织')
  // 兜底：名字看不出动作的细胞归入基质组织，而不是抛错或返回空
  assert.equal(tissueOf('zzz_totally_unknown_cell'), '基质组织')
})

test('学习与修剪判据：强化与遗忘成对存在', () => {
  assert.ok(shouldRetireReflex({ fires: 5, helped: 0, retired: false }))
  assert.ok(!shouldRetireReflex({ fires: 5, helped: 1, retired: false }))
  assert.ok(!shouldRetireReflex({ fires: 3, helped: 0, retired: false }))
  assert.ok(!shouldRetireReflex({ fires: 9, helped: 0, retired: true }))

  assert.ok(shouldBoostReflex({ fires: 4, helped: 3, retired: false }))
  assert.ok(!shouldBoostReflex({ fires: 4, helped: 1, retired: false }))

  assert.ok(shouldForgetSkill({ ok: 0, fail: 2 }))
  assert.ok(!shouldForgetSkill({ ok: 3, fail: 2 }))

  assert.equal(synapseDecayFactor(0, 1000), 1)
  assert.equal(synapseDecayFactor(999, 1000), 1)
  assert.equal(synapseDecayFactor(1000, 1000), 0.5)
  assert.equal(synapseDecayFactor(3000, 1000), 0.125)

  assert.ok(shouldPruneSynapse({ weight: 0.1, paid: 2, failed: 0 }))
  assert.ok(!shouldPruneSynapse({ weight: 0.1, paid: 1, failed: 0 }))
  assert.ok(!shouldPruneSynapse({ weight: 0.5, paid: 5, failed: 0 }))
})

test('cellState: 活跃/休眠/病变/凋亡候选', () => {
  assert.equal(cellState({ calls: 0, ok: 0, fail: 0 }, 3), 'dormant')
  assert.equal(cellState({ calls: 5, ok: 5, fail: 0 }, 3), 'active')
  assert.equal(cellState({ calls: 5, ok: 1, fail: 2 }, 3), 'pathological')
  assert.equal(cellState({ calls: 5, ok: 1, fail: 4 }, 3), 'apoptotic')
})

test('token 估算器：与内核同口径（CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1）', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('中文 abcd'), 4) // 2 宽字符 + ceil(5/4)
  assert.equal(schemaTokens({ name: 'x', description: '', parameters: {} }), estimateTokens(JSON.stringify({ name: 'x', description: '', parameters: {} })))
  assert.equal(schemaTokens(null), estimateTokens(JSON.stringify({ name: '', description: '', parameters: {} })))
})

test('innervate: 意图 → 器官是确定性的，无命中时落到前额叶', () => {
  const organs = CURATED
  const scan = innervate('帮我扫一下这个目标站的漏洞', organs)
  assert.equal(scan[0].organ, 'innate_immunity')
  assert.ok(scan.some((r) => r.organ === 'adaptive_immunity'))

  const nothing = innervate('嗯', organs)
  assert.equal(nothing[0].organ, 'prefrontal')
  assert.equal(nothing[0].score, 5)

  // 同一输入两次必须完全一致（确定性）
  assert.deepEqual(innervate('写个脚本跑一下', organs), innervate('写个脚本跑一下', organs))
})

test('organAlive / compensateFor: 缺器官时代偿是算出来的', () => {
  const tools = ['sec_webtest', 'vuln_scan', 'read', 'web_search']
  const immune = { id: 'a', group: 'immune', capabilities: ['sec_*'], afferent: [] }
  const vuln = { id: 'b', group: 'immune', capabilities: ['vuln_*'], afferent: [] }
  const eyes = { id: 'c', group: 'sensory', capabilities: ['web_*'], afferent: [] }
  assert.ok(organAlive(immune, tools))
  assert.ok(organAlive(eyes, tools))
  assert.ok(!organAlive({ id: 'z', capabilities: ['quant_*'], afferent: [] }, tools))

  const comp = compensateFor(immune, [immune, vuln, eyes], tools)
  assert.ok(comp.length > 0)
  assert.equal(comp[0].organ, 'b') // 同组 + 能力族重叠
})

test('fillTemplate: 反射动作里的占位符', () => {
  assert.equal(fillTemplate('${tool}', { tool: 'read' }), 'read')
  assert.deepEqual(fillTemplate({ q: '${tool}', n: 1 }, { tool: 'x' }), { q: 'x', n: 1 })
  assert.deepEqual(fillTemplate(['${a}', '${b}'], { a: '1' }), ['1', ''])
})

test('常量表规模符合契约快照', () => {
  assert.ok(CURATED.length >= 20)
  assert.ok(ALWAYS_TOOLS.includes('read'))
  assert.ok(ALWAYS_TOOLS.includes('body_call'))
  for (const o of CURATED) {
    assert.ok(o.id && o.label && o.group)
    assert.ok(Array.isArray(o.capabilities) && o.capabilities.length > 0)
  }
})
