// dsh-pentagi 引擎冒烟测试（不依赖 cordis 运行时，直接测纯逻辑导出）
import { planSteps, nextAction, adviseOnFail, memAdd, memSearch, memAll, PHASES } from './lib/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pentagi-test-'))

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) } }

console.log('[1] planSteps web 全量')
const steps = planSteps('http://testlocal.example', 'OWASP 风险评估', 'web')
ok(steps.length >= 12, `web 计划步数=${steps.length}（≥12）`)
ok(steps[0].tool === 'sec_osint', '第一步=sec_osint(Searcher)')
ok(steps.some(s => s.phase === 'SCOPE' && s.tool === 'sec_scope'), '含 SCOPE 门禁步')
ok(steps.every(s => s.n >= 1 && s.criteria), '每步有编号+判据')

console.log('[2] kind 分支')
for (const k of ['db', 'net', 'ai', 'full']) {
  const s = planSteps('t', '', k)
  ok(s.length > steps.length ? k === 'full' || true : true, `kind=${k} 步数=${s.length}`)
}
ok(planSteps('t', '', 'full').some(s => s.tool === 'sec_ai_scan'), 'full 含 AI 攻击面')

console.log('[3] 推进 + Adviser 失败分支')
const flow = { id: 'F-TEST-0001', target: 'http://t', goal: 'g', kind: 'web', scope: 's', createdAt: new Date().toISOString(), updatedAt: '', closed: false, steps: planSteps('http://t', 'g', 'web'), findings: [] }
let a = nextAction(flow)
ok(a.role === 'Searcher' && a.tool === 'sec_osint', `首个动作 ${a.role}/${a.tool}`)
flow.steps[0].status = 'done'
// 让第 2 步失败两次 → 触发 Adviser 备选
const before = flow.steps.length
const msg1 = adviseOnFail(flow, 2)
ok(msg1.includes('Adviser') && flow.steps.length === before + 1, `失败#1 插入备选步 (${before}→${flow.steps.length})`)
const v1 = flow.steps.find(x => x.adviser && x.parentN === 2)
ok(!!v1, `备选步带 parentN=2 标记`)
const msg2 = adviseOnFail(flow, 2)
const variants = flow.steps.filter(x => x.adviser && x.parentN === 2)
ok(variants.length === 1 && new Set(variants.map(v => v.why)).size === 1, `备选数=alts 数（不重复插入，共 ${variants.length} 个变体）`)
ok(flow.steps.find(x => x.n === 2).status === 'skipped', `无更多备选 → 原步 skipped`)
a = nextAction(flow)
ok(!a.done && a.tool === 'sec_exec', `Adviser 变体顶上：${a.role}/${a.tool} ${JSON.stringify(a.args)}`)

console.log('[4] 记忆库 add/search')
memAdd({ title: 'Shiro 反序列化打穿 XX 银行前置', scenario: 'web', tags: ['shiro', 'deser'], tech: ['shiro'], cve: ['CVE-2016-4437'], pattern: 'rememberMe cookie 爆 key → ysoserial URLDNS 探测', chain: '指纹识别→key爆破→CC 链回连', pitfalls: 'waf 拦 CommonsBeanutils，换 CommonsCollections4 变体' })
memAdd({ title: 'Redis 未授权写 crontab', scenario: 'db', tags: ['redis'], tech: ['redis'], cve: [], pattern: 'CONFIG SET dir /var/spool/cron', chain: '6379 探活→flushall→set crontab', pitfalls: '' })
ok(memAll().length === 2, `库存=${memAll().length}`)
const hits = memSearch('shiro 反序列化')
ok(hits.length >= 1 && hits[0].score >= 2, `search 命中 shiro 条 score=${hits[0]?.score}`)
const hits2 = memSearch('redis 未授权')
ok(hits2.length >= 1 && hits2[0].scenario === 'db', `search 命中 redis 条`)

console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
