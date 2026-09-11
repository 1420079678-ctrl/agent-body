// dsh-reverse-skill 集成测试：用最小 ctx mock 走 apply()，再真实调用每个工具的 execute()。
// 覆盖纯函数测试到不了的地方：cordis 注册契约、工具 handler 的运行时分支、错误路径。
import { apply, Config, resolveRepoRoot } from './lib/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先用真实 DSH_HOME 探测仓库，再切到临时目录隔离案件/经验库写入
const REPO = resolveRepoRoot()
const TMP = mkdtempSync(join(tmpdir(), 'revskill-it-'))
process.env.DSH_HOME = TMP

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) } }
ok(!!REPO, `探测到 reverse-skill 仓库：${REPO}`)
if (!REPO) { console.log('\n仓库缺失，无法继续'); process.exit(1) }

console.log('[1] apply() 注册契约')
const registered = []
const sections = []
const listeners = []
const ctx = {
  effect(fn) { fn(); return () => {} },
  tools: { register(tool) { registered.push(tool); return () => {} } },
  systemPrompt: { section(s) { sections.push(s); return () => {} } },
  on(evt, fn) { listeners.push(evt); return () => {} },
  logger: { info() {}, warn() {} },
}
apply(ctx, new Config({ anchorFirstTurn: false, repoRoot: REPO }))

ok(registered.length === 6, `注册 6 个工具（实际 ${registered.length}）`)
const names = registered.map((t) => t.name).sort()
ok(JSON.stringify(names) === JSON.stringify(['rev_case', 'rev_doctrine', 'rev_journal', 'rev_playbook', 'rev_route', 'rev_toolindex']),
  `工具名集合正确：${names.join(', ')}`)
ok(sections.length === 1 && sections[0].name === 'reverse-skill:doctrine:v1' && sections[0].order === 91,
  `系统提示方法层注册（name=${sections[0]?.name} order=${sections[0]?.order}）`)
ok(sections[0].text.includes('先路由后动手') && sections[0].text.includes('R4*') && sections[0].text.includes('R80'),
  '方法层含路由纪律 + validated 门槛 + 上下文污染自检')
for (const t of registered) {
  ok(typeof t.description === 'string' && t.description.length > 40, `${t.name} 有模型可见描述（${t.description.length} 字符）`)
  ok(t.parameters && typeof t.parameters === 'object', `${t.name} 有参数 schema`)
  ok(t.output && t.output.schema, `${t.name} 声明了 output.schema`)
}

console.log('[2] 工具 execute() 真实调用')
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const call = async (n, args) => String(await byName[n].execute(args, {}))

let out = await call('rev_route', { hint: 'js 前端签名逆向，webpack 加密参数还原' })
ok(out.includes('R3') && out.includes('PRIMARY') && out.includes('本机工具绑定'), 'rev_route 返回路由 + 工具绑定')
ok(out.includes('sec_webscan'), 'rev_route 绑定到本机 sec_* 工具')
out = await call('rev_route', {})
ok(out.includes('全矩阵') && out.includes('R0'), 'rev_route 无 hint → 输出全矩阵')

out = await call('rev_playbook', {})
ok(out.includes('领域技能目录'), 'rev_playbook 目录模式')
out = await call('rev_playbook', { module: 'js-reverse' })
ok(out.includes('js-reverse/SKILL.md'), 'rev_playbook 读 SKILL.md')
out = await call('rev_playbook', { module: 'js-reverse', list: 'references' })
ok(out.includes('references/'), 'rev_playbook references 清单模式')
out = await call('rev_playbook', { module: 'no-such-module' })
ok(out.includes('不存在') && out.includes('js-reverse'), 'rev_playbook 未知模块给出可用清单')
out = await call('rev_playbook', { module: 'js-reverse', file: '../../../etc/passwd' })
ok(!out.includes('root:'), 'rev_playbook 路径越界被拒（未读到系统文件）')

out = await call('rev_doctrine', { topic: 'blindspot' })
ok(out.includes('R78') && out.includes('R80'), 'rev_doctrine blindspot 内容正确')
out = await call('rev_doctrine', { topic: 'ops', file: 'analysis-blindspot-cookbook.md' })
ok(out.includes('R52') && out.includes('Bytes') === false, 'rev_doctrine 读仓库 ops 全文')
out = await call('rev_doctrine', { topic: 'ops', file: '../secret.md' })
ok(out.includes('只接受'), 'rev_doctrine 拒绝越界文件名')
out = await call('rev_doctrine', { topic: 'nope' })
ok(out.includes('未知方法论主题'), 'rev_doctrine 未知主题降级提示')

out = await call('rev_case', { action: 'init', case: 'IT-1', target: 'http://it.local', intent: '集成测试' })
ok(out.includes('已建案件'), 'rev_case init')
out = await call('rev_case', { action: 'evidence', case: 'IT-1', title: '探针返回 200', reproCommand: 'curl -I http://it.local' })
ok(out.includes('E-001'), 'rev_case evidence')
out = await call('rev_case', { action: 'finding', case: 'IT-1', title: '无证据', status: 'candidate' })
ok(out.includes('必须给 evidenceIds'), 'rev_case 拒绝无证据结论')
out = await call('rev_case', { action: 'finding', case: 'IT-1', title: '单证据升 validated', evidenceIds: 'E-001', status: 'validated' })
ok(out.includes('ADF R4*'), 'rev_case 拒绝单证据 validated')
out = await call('rev_case', { action: 'finding', case: 'IT-1', title: '暴露面', evidenceIds: 'E-001', status: 'candidate', severity: 'low' })
ok(out.includes('F-001'), 'rev_case 登记 candidate 结论')
out = await call('rev_case', { action: 'status', case: 'IT-1' })
ok(out.includes('证据：1') && out.includes('结论：1'), 'rev_case status')
out = await call('rev_case', { action: 'review', case: 'IT-1' })
ok(out.includes('review'), 'rev_case review')
out = await call('rev_case', { action: 'unknown-action', case: 'IT-1' })
ok(out.includes('未知 action'), 'rev_case 未知 action 降级提示')
out = await call('rev_case', { action: 'status', case: 'NOT-EXIST' })
ok(out.includes('不存在'), 'rev_case 不存在案件降级提示')

out = await call('rev_journal', { action: 'add', title: '集成测试经验：webpack 签名定位', scenario: 'js 逆向', pattern: '搜 webpackJsonp 与 sign 关键字' })
ok(out.includes('已回写'), 'rev_journal add')
out = await call('rev_journal', { action: 'search', query: 'webpack 签名' })
ok(out.includes('命中') && out.includes('webpackJsonp'), 'rev_journal search')
out = await call('rev_journal', { action: 'index' })
ok(out.includes('共 1 条'), 'rev_journal index')

out = await call('rev_toolindex', {})
ok(out.includes('能力') && out.includes('已就绪'), 'rev_toolindex 全量探测')
out = await call('rev_toolindex', { want: 'jadx' })
ok(out.includes('jadx'), 'rev_toolindex 关键字过滤')
out = await call('rev_toolindex', { want: 'no-such-capability-xyz' })
ok(out.includes('无匹配'), 'rev_toolindex 无匹配提示')

console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
