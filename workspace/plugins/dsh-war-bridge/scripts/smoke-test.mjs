/**
 * dsh-war-bridge 冒烟测试（离线可跑，IDA 部分需 MCP 在线）
 *
 * 用法（在插件目录下）：
 *   node scripts/smoke-test.mjs
 *
 * 原理：用最小假 ctx 调 apply()，捕获注册的工具，直接 execute 它们。
 * 不依赖 DSH 运行时，可作升级后的回归脚本。
 */
import { apply } from '../lib/index.js'
import { mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IDA_URL = process.env.WAR_BRIDGE_IDA_URL || 'http://127.0.0.1:13337/mcp'

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`)
}

// ── 1. 用假 ctx 捕获工具 ──
const captured = []
const ctx = {
  effect(fn) {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  tools: {
    register(t) {
      captured.push(t)
      return () => {}
    },
  },
  logger: { info() {} },
}
apply(ctx, { idaUrl: IDA_URL })

const byName = (n) => captured.find((t) => t.name === n)
check('注册 4 个工具', captured.length === 4, captured.map((t) => t.name).join(', '))
for (const n of ['ida', 'war_status', 'war_case', 'war_memory']) {
  check(`工具存在：${n}`, !!byName(n))
}

// ── 2. war_status ──
const status = await byName('war_status').execute({})
check('war_status 返回体检报告', typeof status === 'string' && status.includes('全班组合体体检'))
check('war_status 覆盖三条链', /逆向链 dsh-reverse-skill/.test(status) && /攻击链 dsh-sec-workbench/.test(status) && /编排链 dsh-pentagi/.test(status))
console.log('\n----- war_status -----\n' + status + '\n')

// ── 3. war_memory ──
const idx = await byName('war_memory').execute({ action: 'index' })
check('war_memory index 可读', typeof idx === 'string' && idx.includes('三库合计'))
const mem = await byName('war_memory').execute({ query: 'IDA MCP 环境变量', limit: 3 })
check('war_memory search 有命中', typeof mem === 'string' && mem.includes('命中'))
console.log('\n----- war_memory search -----\n' + mem + '\n')

// ── 4. war_case ──
const cases = await byName('war_case').execute({ action: 'list' })
check('war_case list 可读', typeof cases === 'string' && cases.includes('跨库案件全景'))
const show = await byName('war_case').execute({ action: 'show', case: 'ida-mcp-postmove-verify' })
check('war_case show 能定位到刚建的逆向案件', show.includes('ida-mcp-postmove-verify'))
console.log('\n----- war_case show -----\n' + show.slice(0, 900) + '\n')

// ── 5. war_case handoff（自建临时案件，验证后清理）──
const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const revRoot = join(HOME, 'plugins', 'dsh-reverse-skill', 'cases')
const secRoot = join(HOME, 'plugins', 'dsh-sec-workbench', 'cases')
const probe = '__war_bridge_handoff_probe__'
const revCase = join(revRoot, probe)
const secCase = join(secRoot, probe)
try {
  mkdirSync(join(revCase, 'evidence'), { recursive: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    join(revCase, 'evidence', 'E-001.md'),
    '### E-001\n- title: 探针证据（smoke）\n- source_type: command\n- repro_command: |\n    echo war-bridge\n- raw_excerpt: 探针\n',
    'utf8',
  )
  writeFileSync(
    join(revCase, 'findings.md'),
    '# Findings — probe\n\n### F-001\n- title: 探针结论（smoke）\n- severity: info\n- category: other\n- status: candidate\n- evidence_ids: [E-001]\n',
    'utf8',
  )
  const ho = await byName('war_case').execute({ action: 'handoff', case: probe, from: 'rev' })
  check('war_case handoff 执行', ho.includes('handoff'))
  check('handoff 证据落到攻击链', existsSync(join(secCase, 'evidence', 'E-001.md')))
  check('handoff 结论落到攻击链', existsSync(join(secCase, 'findings.md')))
  const ho2 = await byName('war_case').execute({ action: 'handoff', case: probe, from: 'rev' })
  check('handoff 幂等（重复执行不重复复制）', ho2.includes('跳过已存在 1') || ho2.includes('新增 0'))
  const shown = await byName('war_case').execute({ action: 'show', case: probe })
  check('show 能并排看到两库', shown.includes('逆向链') && shown.includes('攻击链'))
} catch (e) {
  check('war_case handoff 全流程', false, String(e))
} finally {
  rmSync(revCase, { recursive: true, force: true })
  rmSync(secCase, { recursive: true, force: true })
}

// ── 6. ida 桥（需要 MCP 在线）──
const idaStatus = await byName('ida').execute({ action: 'status' })
const online = idaStatus.includes('✅')
check('ida status 探测', true, online ? 'MCP 在线' : 'MCP 离线（跳过后续 IDA 用例）')
console.log('\n----- ida status -----\n' + idaStatus + '\n')

if (online) {
  const work = join(ROOT, '.smoke-work')
  mkdirSync(work, { recursive: true })
  const src = '<DSH_CHECKOUT>\\workspace\\samples\\notepad.exe'
  const sample = join(work, 'smoke.exe')
  if (existsSync(src)) {
    copyFileSync(src, sample)
    const open = await byName('ida').execute({ action: 'open', path: sample })
    check('ida open 成功', open.includes('✅'))
    console.log(open)

    const funcs = await byName('ida').execute({ action: 'funcs', limit: 5 })
    check('ida funcs 出函数列表', /TOTAL=\d+/.test(funcs))
    console.log(funcs)

    const imps = await byName('ida').execute({ action: 'imports', count: 5 })
    check('ida imports 出导入表', imps.includes('imports'))

    const m = funcs.match(/\b(0x[0-9a-fA-F]+)\b/)
    if (m) {
      const dec = await byName('ida').execute({ action: 'decompile', addr: m[1], max_chars: 800 })
      check('ida decompile 出 C 伪代码', dec.includes('{') && dec.length > 100, m[1])
    } else {
      check('ida decompile 出 C 伪代码', false, '未从 funcs 取到地址')
    }

    const ev = await byName('ida').execute({ action: 'eval', code: "print('BRIDGE_EVAL_OK')" })
    check('ida eval 执行 Python', ev.includes('BRIDGE_EVAL_OK'))

    const save = await byName('ida').execute({ action: 'save' })
    check('ida save 落盘', save.includes('ok') || save.includes('true'))
    const close = await byName('ida').execute({ action: 'close' })
    check('ida close 关闭会话', close.includes('close') || close.includes('success'))

    rmSync(work, { recursive: true, force: true })
  } else {
    check('样本存在（workspace\\samples\\notepad.exe）', false, '跳过 IDA 链路用例')
  }
}

// ── 汇总 ──
const fail = results.filter((r) => !r.ok)
console.log('\n=== WAR-BRIDGE SMOKE SUMMARY ===')
console.log(`TOTAL=${results.length} PASS=${results.length - fail.length} FAIL=${fail.length}`)
if (fail.length) console.log('失败项：' + fail.map((f) => f.name).join(' | '))
console.log(fail.length ? 'OVERALL: FAIL' : 'OVERALL: ALL PASS')
process.exit(fail.length ? 1 : 0)
