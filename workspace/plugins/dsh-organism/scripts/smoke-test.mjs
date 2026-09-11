/**
 * dsh-organism 离线回归（零网络、零模型往返）
 *
 * 覆盖内核的确定性部分：器官家族归档、能力认领、反射条件求值、占位符填充。
 * 运行：node scripts/smoke-test.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const lib = require(join(here, '..', 'lib', 'index.js'))

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

console.log('\n══ dsh-organism 离线回归 ══\n')

// ── 1. 家族归档（自动解剖的核心） ──
console.log('[1] familyOf —— 工具名 → 器官家族')
eq('sec_webtest → sec', lib.familyOf('sec_webtest'), 'sec')
eq('agi_memory → agi', lib.familyOf('agi_memory'), 'agi')
eq('war_status → war', lib.familyOf('war_status'), 'war')
eq('webcrawl_site → webcrawl', lib.familyOf('webcrawl_site'), 'webcrawl')
eq('_dsh_external_dsh_browser_ultimate_snap → browser_ultimate', lib.familyOf('_dsh_external_dsh_browser_ultimate_snap'), 'browser_ultimate')
eq('_dsh_external_dsh_office_docs_pdf → office_docs', lib.familyOf('_dsh_external_dsh_office_docs_pdf'), 'office_docs')
eq('social_card_render → social_card', lib.familyOf('social_card_render'), 'social_card')
eq('write（无下划线）→ write', lib.familyOf('write'), 'write')
eq('quant_sma → quant', lib.familyOf('quant_sma'), 'quant')

// ── 2. 器官能力认领 ──
console.log('\n[2] organClaims —— 器官是否管辖某工具')
const immune = { id: 'immunity', label: '免疫', group: 'immune', capabilities: ['sec_*', 'vuln_*'], afferent: [], purpose: '' }
ok('sec_* 通配命中 sec_autoscan', lib.organClaims(immune, 'sec_autoscan'))
ok('vuln_* 通配命中 vuln_scan', lib.organClaims(immune, 'vuln_scan'))
ok('不误伤 rev_*', !lib.organClaims(immune, 'rev_route'))
ok('不误伤 secx_*（前缀必须精确）', !lib.organClaims(immune, 'secx_tool'))
const hands = { id: 'hands', label: '手', group: 'motor', capabilities: ['write', 'edit'], afferent: [], purpose: '' }
ok('精确名命中 write', lib.organClaims(hands, 'write'))
ok('精确名不误伤 write_file', !lib.organClaims(hands, 'write_file'))

// ── 3. 反射条件求值（无 eval 的确定性判定） ──
console.log('\n[3] evalCondition —— 反射弧条件判定')
const E = (isError, text, ms = 0) => ({ isError, text, ms })
ok('always 恒真', lib.evalCondition('always', E(false, '')))
ok('空条件恒真', lib.evalCondition('', E(false, '')))
ok('error 命中失败', lib.evalCondition('error', E(true, '')))
ok('error 放过成功', !lib.evalCondition('error', E(false, '')))
ok('ok 命中成功', lib.evalCondition('ok', E(false, '')))
ok('ok 放过失败', !lib.evalCondition('ok', E(true, '')))
ok('hit 子串命中', lib.evalCondition('hit:ENOENT', E(true, "spawn ENOENT nope")))
ok('hit 未命中', !lib.evalCondition('hit:ENOENT', E(true, 'all good')))
ok('miss 取反命中', lib.evalCondition('miss:ok', E(true, 'bad')))
ok('slow 阈值命中', lib.evalCondition('slow:5000', E(false, '', 6000)))
ok('slow 阈值未达', !lib.evalCondition('slow:5000', E(false, '', 1000)))
ok('|| 任一成立', lib.evalCondition('hit:ENOENT || hit:not found', E(true, 'bash: not found')))
ok('&& 全部成立', lib.evalCondition('error && hit:timeout', E(true, 'connection timeout')))
ok('&& 一假即假', !lib.evalCondition('error && hit:timeout', E(false, 'connection timeout')))
ok('已知键拼装（种子反射 R-missing-tool 的原式）', lib.evalCondition('hit:ENOENT || hit:not found || hit:未安装 || hit:command not found', E(true, 'nmap: command not found')))
ok('未知键判假（不放过）', !lib.evalCondition('bogus:1', E(true, '')))

ok('种子反射全部可求值（无非法条件）', (() => {
  // 与源码 SEED_REFLEXES 保持一致的抽样
  const conds = [
    'error',
    'hit:ENOENT || hit:not found || hit:未安装 || hit:command not found',
    'hit:failed || hit:失败',
    'hit:无法协助 || hit:不能帮助',
  ]
  return conds.every(c => typeof lib.evalCondition(c, E(true, 'x')) === 'boolean')
})())

// ── 4. 分组契约完整性 ──
console.log('\n[4] GROUPS —— 人体系统分组契约')
const groups = ['executive', 'nervous', 'immune', 'sensory', 'motor', 'memory', 'metabolic', 'endocrine']
for (const g of groups) {
  ok(`分组 ${g} 已定义且有标签`, Boolean(lib.GROUPS[g]?.label && lib.GROUPS[g]?.desc))
}

// ── 5. 模块契约 ──
console.log('\n[5] 模块导出契约')
eq('插件名', lib.name, '@dsh-external/dsh-organism')
ok('inject 声明包含 tools 与 systemPrompt', Array.isArray(lib.inject) && lib.inject.includes('tools') && lib.inject.includes('systemPrompt'))
ok('apply 为函数', typeof lib.apply === 'function')
ok('Config 已导出（schemastery 契约）', lib.Config !== undefined)

// ── 6. 神经支配（命令 → 器官） ──
console.log('\n[6] innervate —— 命令作为神经冲动的支配路由')
const ANATOMY = [
  { id: 'prefrontal', label: '前额叶', group: 'executive', capabilities: ['todo_write'], afferent: [], purpose: '' },
  { id: 'innate_immunity', label: '固有免疫', group: 'immune', capabilities: ['sec_*'], afferent: [], purpose: '' },
  { id: 'adaptive_immunity', label: '适应性免疫', group: 'immune', capabilities: ['vuln_*'], afferent: [], purpose: '' },
  { id: 'dissection', label: '解剖刀', group: 'immune', capabilities: ['rev_*'], afferent: [], purpose: '' },
  { id: 'eyes', label: '眼睛', group: 'sensory', capabilities: ['webcrawl', 'webcrawl_*'], afferent: [], purpose: '' },
  { id: 'hands', label: '手', group: 'motor', capabilities: ['write', 'edit', 'pwsh'], afferent: [], purpose: '' },
  { id: 'hippocampus', label: '海马体', group: 'memory', capabilities: ['agi_memory'], afferent: [], purpose: '' },
]
const ids = (r) => r.map(x => x.organ)
ok('攻击意图 → 免疫器官', ids(lib.innervate('对目标做端口扫描和漏洞利用', ANATOMY)).includes('innate_immunity'))
ok('逆向意图 → 解剖刀', ids(lib.innervate('把这个 apk 脱壳反编译', ANATOMY)).includes('dissection'))
ok('抓取意图 → 眼睛', ids(lib.innervate('把这个网页抓取下来', ANATOMY)).includes('eyes'))
ok('写文件意图 → 手', ids(lib.innervate('写一个脚本改一下文件', ANATOMY)).includes('hands'))
ok('记忆意图 → 海马体', ids(lib.innervate('检索一下上次的经验并复盘', ANATOMY)).includes('hippocampus'))
ok('无靶标 → 回落前额叶统一决策', ids(lib.innervate('嗯这个嘛', ANATOMY)).includes('prefrontal'))
ok('支配结果按得分降序', (() => {
  const r = lib.innervate('扫描漏洞并写报告', ANATOMY)
  return r.every((x, i) => i === 0 || r[i - 1].score >= x.score)
})())
ok('支配是确定性的（同输入同输出）', JSON.stringify(lib.innervate('扫描目标', ANATOMY)) === JSON.stringify(lib.innervate('扫描目标', ANATOMY)))

// ── 7. 器官存活判定（架构不依赖器官的前提） ──
console.log('\n[7] organAlive —— 器官是否活着')
const T = (...names) => names
ok('通配能力有落实 → 活', lib.organAlive({ id: 'a', label: '', group: '', capabilities: ['sec_*'], afferent: [], purpose: '' }, T('sec_webtest')))
ok('通配能力无落实 → 死', !lib.organAlive({ id: 'a', label: '', group: '', capabilities: ['sec_*'], afferent: [], purpose: '' }, T('write')))
ok('精确能力命中 → 活', lib.organAlive({ id: 'a', label: '', group: '', capabilities: ['write'], afferent: [], purpose: '' }, T('write')))
ok('精确能力缺席 → 死', !lib.organAlive({ id: 'a', label: '', group: '', capabilities: ['write'], afferent: [], purpose: '' }, T('read')))
ok('空能力声明 → 视为活（不误判）', lib.organAlive({ id: 'a', label: '', group: '', capabilities: [], afferent: [], purpose: '' }, T()))

// ── 8. 脱器官代偿（缺一个器官影响不大的机制） ──
console.log('\n[8] compensateFor —— 器官缺失时的代偿')
const ALLT = T('sec_x', 'vuln_y', 'rev_z', 'write')
const immuneDead = { id: 'innate_immunity', label: '固有免疫', group: 'immune', capabilities: ['sec_*'], afferent: [], purpose: '' }
const comp1 = lib.compensateFor(immuneDead, ANATOMY, T('vuln_y', 'write'))
ok('代偿不包含自己', !comp1.some(c => c.organ === 'innate_immunity'))
ok('代偿会选同系统的活器官', comp1.some(c => c.organ === 'adaptive_immunity'))
ok('代偿不会选离线的器官', !lib.compensateFor(immuneDead, ANATOMY, T('write')).some(c => c.organ === 'adaptive_immunity'))
ok('代偿结果按重叠度降序', comp1.every((c, i) => i === 0 || comp1[i - 1].overlap >= c.overlap))
ok('代偿最多 3 个', comp1.length <= 3)
ok('无器官可代偿时返回空（功能降级但不报错）', lib.compensateFor(
  { id: 'x', label: 'X', group: 'metabolic', capabilities: ['nothing_*'], afferent: [], purpose: '' },
  ANATOMY, ALLT).length === 0)

// ── 9. 模块契约（新增部分） ──
console.log('\n[9] 新增导出契约')
ok('innervate 已导出', typeof lib.innervate === 'function')
ok('organAlive 已导出', typeof lib.organAlive === 'function')
ok('compensateFor 已导出', typeof lib.compensateFor === 'function')
ok('evalCondition 仍已导出（回归）', typeof lib.evalCondition === 'function')

// ── 10. 组织归类（细胞 → 组织） ──
console.log('\n[10] tissueOf —— 细胞归入哪类组织')
eq('sec_recon → 感知组织', lib.tissueOf('sec_recon'), '感知组织')
eq('sec_webtest → 检验组织', lib.tissueOf('sec_webtest'), '检验组织')
eq('sec_brute → 效应组织', lib.tissueOf('sec_brute'), '效应组织')
eq('write → 合成组织', lib.tissueOf('write'), '合成组织')
eq('sec_evidence → 记忆组织', lib.tissueOf('sec_evidence'), '记忆组织')
eq('agi_plan → 调控组织', lib.tissueOf('agi_plan'), '调控组织')
eq('sec_journal → 记忆组织（journal 优先于其他词）', lib.tissueOf('sec_journal'), '记忆组织')
eq('未知名字 → 基质组织（兜底不丢）', lib.tissueOf('zzz_qqq'), '基质组织')
ok('组织分类是确定性的', lib.tissueOf('sec_webtest') === lib.tissueOf('sec_webtest'))
ok('覆盖全部 7 类组织的正则均可用', ['sec_recon', 'sec_webtest', 'sec_brute', 'write', 'agi_memory', 'agi_plan', 'dev_uninject_plugin']
  .every(t => ['感知组织', '检验组织', '效应组织', '合成组织', '记忆组织', '调控组织', '清除组织'].includes(lib.tissueOf(t))))

// ── 11. 细胞状态机 ──
console.log('\n[11] cellState —— 细胞状态判定')
const mkCell = (calls, ok, fail) => ({ name: 'x', organ: 'o', calls, ok, fail, totalMs: 0, lastMs: 0, firstSeen: 0, lastUsed: 0 })
eq('从未调用 → 休眠', lib.cellState(mkCell(0, 0, 0), 3), 'dormant')
eq('调用且多数成功 → 活跃', lib.cellState(mkCell(10, 9, 1), 3), 'active')
eq('失败多于成功但未达阈值 → 病变', lib.cellState(mkCell(3, 1, 2), 3), 'pathological')
eq('失败多且超阈值 → 凋亡候选', lib.cellState(mkCell(8, 2, 6), 3), 'apoptotic')
eq('失败超阈值但成功更多 → 仍活跃（不误杀）', lib.cellState(mkCell(20, 15, 5), 3), 'active')
eq('仅一次失败 → 病变（尚未达凋亡阈值）', lib.cellState(mkCell(1, 0, 1), 3), 'pathological')

// ── 12. 模块契约（细胞层） ──
console.log('\n[12] 细胞层导出契约')
ok('tissueOf 已导出', typeof lib.tissueOf === 'function')
ok('cellState 已导出', typeof lib.cellState === 'function')

// ── 13. 失败归因（自愈的第一步） ──
console.log('\n[13] attributeFailure —— 病因归因')
eq('ENOENT → 工具缺失', lib.attributeFailure('spawn nmap ENOENT'), 'tool_missing')
eq('command not found → 工具缺失', lib.attributeFailure('bash: ffuf: command not found'), 'tool_missing')
eq('未安装 → 工具缺失', lib.attributeFailure('协议工具未安装，请先安装'), 'tool_missing')
eq('invalid arguments → 参数错误', lib.attributeFailure('invalid arguments: missing required property "file_path"'), 'arg_error')
eq('INVALID_ARGS → 参数错误', lib.attributeFailure('{"code":"INVALID_ARGS"}'), 'arg_error')
eq('EACCES → 权限', lib.attributeFailure('EACCES: permission denied'), 'permission')
eq('ETIMEDOUT → 超时', lib.attributeFailure('request ETIMEDOUT after 30s'), 'timeout')
eq('ECONNREFUSED → 网络', lib.attributeFailure('connect ECONNREFUSED 127.0.0.1:5001'), 'network')
eq('HTTP 404 → 不存在', lib.attributeFailure('HTTP 404 not found'), 'not_found')
eq('no such file → 不存在（不是工具缺失）', lib.attributeFailure('ENOENT: no such file or directory, open D:\\x'), 'not_found')
eq('PowerShell 术语未识别 → 工具缺失', lib.attributeFailure("nonexistent: 术语 'nonexistent' 不会被识别为 cmdlet、函数、脚本文件或可执行程序的名称。"), 'tool_missing')
eq('Windows 不是内部或外部命令 → 工具缺失', lib.attributeFailure('"ffuf" 不是内部或外部命令，也不是可运行的程序'), 'tool_missing')
eq('EBUSY → 冲突', lib.attributeFailure('EBUSY: resource busy or locked'), 'conflict')
eq('未知文本 → unknown（不硬猜）', lib.attributeFailure('something weird happened'), 'unknown')
eq('空文本 → unknown', lib.attributeFailure(''), 'unknown')
ok('归因是确定性的', lib.attributeFailure('ENOENT') === lib.attributeFailure('ENOENT'))

// ── 14. 处方表（自愈的第二步：对症下药） ──
console.log('\n[14] REMEDIES —— 处方的自动化边界')
const causes = ['tool_missing', 'arg_error', 'permission', 'timeout', 'network', 'not_found', 'conflict', 'unknown']
ok('八类病因全部有处方', causes.every(c => lib.REMEDIES[c] && lib.REMEDIES[c].label))
ok('每张处方都有可读标签与说明', causes.every(c => lib.REMEDIES[c].label.length > 0 && lib.REMEDIES[c].note.length > 0))
ok('参数错误绝不自动重试（自愈不放大错误）', lib.REMEDIES.arg_error.auto === false)
ok('工具缺失可自动处置（只读诊断）', lib.REMEDIES.tool_missing.auto === true && lib.REMEDIES.tool_missing.tool === 'sec_toolchain')
ok('自动处方必带工具，非自动处方可不带', causes.every(c => !lib.REMEDIES[c].auto || lib.REMEDIES[c].tool.length > 0))
ok('安全边界：有副作用的病因不自动动手', ['network', 'not_found', 'conflict'].every(c => lib.REMEDIES[c].auto === false))

// ── 15. 触发匹配（含排除，防反射自触发） ──
console.log('\n[15] matchTrigger —— 触发模式与排除')
ok('* 匹配一切', lib.matchTrigger('*', 'sec_webtest'))
ok('sec_* 前缀匹配', lib.matchTrigger('sec_*', 'sec_webtest'))
ok('sec_* 不匹配 rev_route', !lib.matchTrigger('sec_*', 'rev_route'))
ok('*,!body_* 匹配普通工具', lib.matchTrigger('*,!body_*', 'sec_webtest'))
ok('*,!body_* 排除自身器官（防自触发）', !lib.matchTrigger('*,!body_*', 'body_pulse'))
ok('*,!body_* 排除 body_reflex', !lib.matchTrigger('*,!body_*', 'body_reflex'))
ok('纯排除模式匹配其余全部', lib.matchTrigger('!body_*', 'write'))
ok('多条正向任一命中', lib.matchTrigger('sec_*,rev_*', 'rev_route'))
ok('正向未命中则不触发', !lib.matchTrigger('sec_*,rev_*', 'write'))
ok('负向优先于正向', !lib.matchTrigger('*,!*', 'anything'))
ok('空模式不触发', !lib.matchTrigger('', 'write'))
// ── 16. 操作者输入提取（命令即神经冲动，从会话事件流取） ──
console.log('\n[16] latestHumanText —— 从会话事件流取操作者真实输入')
const U = (text, kind = 'user') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
eq('取出真人输入', lib.latestHumanText([U('帮我扫这个站')]), '帮我扫这个站')
eq('取最新一条', lib.latestHumanText([U('第一句'), U('第二句')]), '第二句')
eq('跳过工具结果（kind=tool）', lib.latestHumanText([U('真实命令'), U('[工具输出]', 'tool')]), '真实命令')
eq('跳过内核注入的插件简报（kind=plugin）', lib.latestHumanText([U('真实命令'), U('【本体感觉】疲劳', 'plugin')]), '真实命令')
eq('跳过神经冲动简报', lib.latestHumanText([U('真实命令'), U('【神经冲动 I-x】已下发', 'plugin')]), '真实命令')
eq('非 user/message 事件被忽略', lib.latestHumanText([{ type: 'turn/start', data: {} }, U('命令')]), '命令')
eq('空事件流返回空', lib.latestHumanText([]), '')
eq('非数组返回空（不炸）', lib.latestHumanText(undefined), '')
eq('空文本跳过并继续往前找', lib.latestHumanText([U('有效'), U('   ')]), '有效')
ok('超长输入被截断（防冲爆脉冲日志）', lib.latestHumanText([U('x'.repeat(9000))]).length === 2000)
console.log('\n[16b] latestHuman —— 事件序号（跨热重载去重的依据）')
const U2 = (text, kind, seq) => ({ type: 'user/message', seq, data: { source: { kind }, content: [{ type: 'text', text }] } })
eq('返回文本与事件序号', lib.latestHuman([U2('命令', 'user', 42)]), { text: '命令', seq: 42 })
eq('取最新一条的序号', lib.latestHuman([U2('旧', 'user', 1), U2('新', 'user', 9)]).seq, 9)
eq('无真人输入返回 null', lib.latestHuman([U2('注入', 'plugin', 3)]), null)
ok('同一事件序号可比对（去重基础）', lib.latestHuman([U2('a', 'user', 7)]).seq === lib.latestHuman([U2('a', 'user', 7), U2('x', 'plugin', 8)]).seq)

console.log('\n[17] textOfBlocks —— 内容块转文本')
eq('字符串', lib.textOfBlocks('abc'), 'abc')
eq('文本块数组', lib.textOfBlocks([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a b')
eq('非文本块被忽略', lib.textOfBlocks([{ type: 'image' }, { type: 'text', text: 'x' }]), 'x')
eq('非数组非字符串返回空', lib.textOfBlocks(42), '')
eq('去掉首尾空白', lib.textOfBlocks([{ type: 'text', text: '  hi  ' }]), 'hi')
// ── 18. 反射信用：淘汰与强化 ──
console.log('\n[18] shouldRetireReflex / shouldBoostReflex —— 反射的修剪判定')
const RS = (o) => Object.assign({ fires: 0, helped: 0, hurt: 0, lastFire: 0, cooldownMs: 0, retired: false }, o)
ok('开火 5 次零贡献 → 淘汰', lib.shouldRetireReflex(RS({ fires: 5, helped: 0, hurt: 5 })))
ok('开火 4 次零贡献 → 还不到淘汰线', !lib.shouldRetireReflex(RS({ fires: 4, helped: 0 })))
ok('帮过一次就不淘汰', !lib.shouldRetireReflex(RS({ fires: 10, helped: 1, hurt: 9 })))
ok('已淘汰的不重复淘汰', !lib.shouldRetireReflex(RS({ fires: 9, helped: 0, retired: true })))
ok('帮忙率 60% 且开火够 → 强化', lib.shouldBoostReflex(RS({ fires: 5, helped: 3 })))
ok('帮忙率 50% → 不强化', !lib.shouldBoostReflex(RS({ fires: 10, helped: 5 })))
ok('开火太少不强化（样本不足）', !lib.shouldBoostReflex(RS({ fires: 3, helped: 3 })))
ok('已淘汰的不强化', !lib.shouldBoostReflex(RS({ fires: 10, helped: 10, retired: true })))

// ── 19. 技能失效遗忘 ──
console.log('\n[19] shouldForgetSkill —— 过时成功路径的遗忘')
const SK = (ok, fail) => ({ id: 'S', name: 'x', steps: [], uses: 0, createdAt: 0, lastUsed: 0, ok, fail })
ok('失败 2 次且多于成功 → 遗忘', lib.shouldForgetSkill(SK(0, 2)))
ok('失败 2 次但成功更多 → 保留（偶然失败不误杀）', !lib.shouldForgetSkill(SK(5, 2)))
ok('只失败 1 次 → 保留（给第二次机会）', !lib.shouldForgetSkill(SK(0, 1)))
ok('全成功 → 保留', !lib.shouldForgetSkill(SK(9, 0)))
ok('从未重放（0/0）→ 保留', !lib.shouldForgetSkill(SK(0, 0)))
ok('旧数据无 ok/fail 字段 → 保留（不误删历史技能）', !lib.shouldForgetSkill({ id: 'S', name: 'x', steps: [], uses: 1, createdAt: 0, lastUsed: 0 }))

// ── 20. 突触衰减与修剪（遗忘曲线） ──
console.log('\n[20] synapseDecayFactor / shouldPruneSynapse')
const H = 1800000
eq('未达半衰期 → 不衰减', lib.synapseDecayFactor(H - 1, H), 1)
eq('刚过一个半衰期 → 衰减一半', lib.synapseDecayFactor(H, H), 0.5)
eq('两个半衰期 → 四分之一', lib.synapseDecayFactor(H * 2, H), 0.25)
eq('三个半衰期 → 八分之一', lib.synapseDecayFactor(H * 3, H), 0.125)
ok('衰减是单调递减的', [1, 2, 3, 4].every(n => lib.synapseDecayFactor(H * n, H) > lib.synapseDecayFactor(H * (n + 1), H)))
ok('半衰期非法时不衰减（防除零）', lib.synapseDecayFactor(H * 5, 0) === 1)
const SY = (w, paid, failed) => ({ key: 'k', rule: '1', organ: 'o', weight: w, paid, failed, updatedAt: 0 })
ok('权重弱且有样本 → 修剪', lib.shouldPruneSynapse(SY(0.1, 2, 0)))
ok('权重强 → 不修剪', !lib.shouldPruneSynapse(SY(3, 5, 1)))
ok('样本不足 → 不修剪（避免过早遗忘）', !lib.shouldPruneSynapse(SY(0.1, 1, 0)))
ok('负权重同样按绝对值修剪', lib.shouldPruneSynapse(SY(-0.05, 3, 2)))

// ── 21. Token 经济：估算 ──
console.log('\n[21] estimateTokens / schemaTokens —— token 开销的确定性估算')
eq('纯 ASCII：4 字符 1 token', lib.estimateTokens('abcd'), 1)
eq('8 字符 ASCII：2 token', lib.estimateTokens('abcdefgh'), 2)
eq('纯中文：1 字 1 token', lib.estimateTokens('扫描漏洞'), 4)
eq('全角标点也按 1 token', lib.estimateTokens('，。！？'), 4)
eq('空文本 0 token', lib.estimateTokens(''), 0)
ok('估算随长度单调不减', (() => {
  let prev = -1
  for (const n of [0, 1, 4, 8, 16, 64, 256]) {
    const cur = lib.estimateTokens('a'.repeat(n))
    if (cur < prev) return false
    prev = cur
  }
  return true
})())
ok('中文估算高于等长 ASCII（能反映真实开销差异）', lib.estimateTokens('扫描漏洞攻击') > lib.estimateTokens('abcdefghij'))
ok('schemaTokens 是确定性的', lib.schemaTokens({ name: 'x', description: 'y' }) === lib.schemaTokens({ name: 'x', description: 'y' }))
ok('缺字段不炸（给有限值而非 NaN）', Number.isFinite(lib.schemaTokens({})))
ok('非对象不炸', Number.isFinite(lib.schemaTokens(null)))
ok('描述越长开销越大', lib.schemaTokens({ name: 'x', description: 'a'.repeat(400) }) > lib.schemaTokens({ name: 'x', description: 'a' }))

// ── 22. 按需显影的安全底线 ──
console.log('\n[22] ALWAYS_TOOLS —— 门控的安全底线')
ok('常驻集非空', lib.ALWAYS_TOOLS.length > 0)
ok('常驻集无重复（避免重复计入成本）', new Set(lib.ALWAYS_TOOLS).size === lib.ALWAYS_TOOLS.length)
ok('必含通用网关 body_call（否则未显影能力不可达）', lib.ALWAYS_TOOLS.includes('body_call'))
ok('必含解剖图 body_map（否则大脑不知道还有什么能力）', lib.ALWAYS_TOOLS.includes('body_map'))
ok('必含账本 body_tokens', lib.ALWAYS_TOOLS.includes('body_tokens'))
ok('必含文件四件套 read/write/edit/grep', ['read', 'write', 'edit', 'grep'].every(t => lib.ALWAYS_TOOLS.includes(t)))
ok('必含命令执行 pwsh', lib.ALWAYS_TOOLS.includes('pwsh'))

console.log(`
══ 结果：${pass} 通过 / ${fail} 失败 ══`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('全部通过 ✅\n')
