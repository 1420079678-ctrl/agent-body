/**
 * dsh-cortex 离线确定性回归（零网络、零模型调用）。
 * 覆盖：导出契约 / 分词 / 告警归一化 / 记忆 id 稳定性 / 巩固内核 extractPatterns 的六类边界。
 */
import * as m from '../lib/index.js'

let pass = 0
const fails = []

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return }
  fails.push(`${name}${extra ? ` — ${extra}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
}

const ev = (t, tool, okf, err = '') => ({ t, tool, ok: okf, ms: 10, err })

// ── 1. 导出契约 ──
ok('导出 name', m.name === '@dsh-external/dsh-cortex', String(m.name))
ok('导出 inject 含 tools', Array.isArray(m.inject) && m.inject.includes('tools'))
ok('导出 apply 是函数', typeof m.apply === 'function')
ok('导出 Config schema', Boolean(m.Config))
const DEFAULTS = m.Config({})
ok('Config 默认值：静默 2 分钟入睡', DEFAULTS.sleepAfterMs === 120000, String(DEFAULTS.sleepAfterMs))
ok('Config 默认值：深睡 5 分钟', DEFAULTS.deepAfterMs === 300000, String(DEFAULTS.deepAfterMs))
ok('Config 默认值：收敛阈值 5', DEFAULTS.noiseConvergeAt === 5, String(DEFAULTS.noiseConvergeAt))
ok('Config 默认值：记忆召回开启', DEFAULTS.memoryRecall === true && DEFAULTS.recallLimit === 3)
ok('导出的纯函数齐全', ['tokens', 'normalizeNote', 'cardId', 'extractPatterns'].every(k => typeof m[k] === 'function'))

// ── 2. 分词 ──
{
  const t = m.tokens('修改 DSH 插件的 baseURL 配置')
  ok('分词：英文词命中', t.includes('baseurl'), JSON.stringify(t))
  ok('分词：中文 2-gram 命中', t.includes('插件'), JSON.stringify(t))
  ok('分词：停用词被滤掉', !t.includes('什么') && !t.includes('可以'))
  ok('分词：空输入安全', m.tokens('').length === 0 && m.tokens(null).length === 0)
}

// ── 3. 告警归一化：数字抹平，同一条告警收敛到同一 key ──
{
  const a = m.normalizeNote('🚨 生命力告警：1 个器官离线：neurogenesis')
  const b = m.normalizeNote('🚨 生命力告警：1 个器官离线：neurogenesis')
  const c = m.normalizeNote('器官「代谢」连续失败 3 次')
  const d = m.normalizeNote('器官「代谢」连续失败 7 次')
  ok('归一化：同内容稳定', a === b)
  ok('归一化：不同数字归为同一 key', c === d, `${c} vs ${d}`)
  ok('归一化：抹掉数字', !/\d/.test(a), a)
}

// ── 4. 记忆卡 id 稳定 ──
{
  eq('cardId 稳定', m.cardId('pitfall', 'pwsh'), m.cardId('pitfall', 'pwsh'))
  ok('cardId 区分类型', m.cardId('pitfall', 'x') !== m.cardId('playbook', 'x'))
}

// ── 5. 巩固内核：extractPatterns ──
{
  // 5.1 连续失败 3 次 → 一个坑
  const evs = [ev(1000, 'pwsh', false, 'boom'), ev(2000, 'pwsh', false, 'boom'), ev(3000, 'pwsh', false, 'boom')]
  const r = m.extractPatterns(evs, 0, 5000)
  eq('坑：连续失败 3 次产出 1 张卡', r.pitfalls.length, 1)
  ok('坑：标题含次数', r.pitfalls[0]?.title.includes('连续失败 3 次'), r.pitfalls[0]?.title)
  ok('坑：标签含工具名', r.pitfalls[0]?.tags.includes('pwsh'))

  // 5.2 只失败 2 次不触发
  eq('坑：连续失败 2 次不产出', m.extractPatterns([ev(1, 'x', false), ev(2, 'x', false)], 0, 10).pitfalls.length, 0)

  // 5.3 中途成功打断连续段
  const broken = [ev(1, 'x', false), ev(2, 'x', false), ev(3, 'x', true), ev(4, 'x', false)]
  eq('坑：成功打断连续段', m.extractPatterns(broken, 0, 10).pitfalls.length, 0)

  // 5.4 since 过滤：老经历不重复建卡
  eq('坑：since 之后没再发生则不建卡', m.extractPatterns(evs, 9999, 10000).pitfalls.length, 0)
  eq('坑：since=0 正常建卡', m.extractPatterns(evs, 0, 10000).pitfalls.length, 1)
}

{
  // 5.5 成功链路 n-gram → 打法
  const evs = []
  let t = 0
  for (let i = 0; i < 2; i++) {
    for (const name of ['read', 'grep', 'edit']) { t += 100; evs.push(ev(t, name, true)) }
  }
  const r = m.extractPatterns(evs, 0, t + 1)
  ok('打法：识别出重复链路', r.playbooks.some(c => c.title.includes('read → grep → edit')), JSON.stringify(r.playbooks.map(c => c.title)))
  ok('打法：权重随次数上升', r.playbooks.every(c => c.weight >= 1))

  // 平凡链路（同一个工具连做几次）不是打法——没有可复用的顺序信息
  const rep = [ev(1, 'edit', true), ev(2, 'edit', true), ev(3, 'edit', true), ev(4, 'edit', true)]
  eq('打法：同工具重复链路被过滤', m.extractPatterns(rep, 0, 10).playbooks.length, 0)

  // 跨工具链路优先于同工具长链
  const mixed = [ev(1, 'a', true), ev(2, 'b', true), ev(3, 'a', true), ev(4, 'b', true)]
  const rm = m.extractPatterns(mixed, 0, 10)
  ok('打法：跨工具链路被识别', rm.playbooks.some(c => c.title.includes('a → b')), JSON.stringify(rm.playbooks.map(c => c.title)))
}

{
  // 5.6 薄弱环节
  const evs = []
  for (let i = 0; i < 10; i++) evs.push(ev(i, 'flaky', i < 5))
  const r = m.extractPatterns(evs, 0, 100)
  eq('薄弱：10 次 50% 成功率 → 1 张卡', r.hotspots.length, 1)
  ok('薄弱：标题带成功率', r.hotspots[0]?.title.includes('50%'), r.hotspots[0]?.title)

  // 样本不足不评
  const few = []
  for (let i = 0; i < 7; i++) few.push(ev(i, 'flaky', false))
  eq('薄弱：样本 <8 不评', m.extractPatterns(few, 0, 100).hotspots.length, 0)

  // 成功率达标不评
  const good = []
  for (let i = 0; i < 8; i++) good.push(ev(i, 'solid', i !== 0))
  eq('薄弱：成功率 ≥70% 不评', m.extractPatterns(good, 0, 100).hotspots.length, 0)
}

{
  // 5.7 未解之事
  const evs = [ev(100, 'a', true), ev(200, 'b', false), ev(300, 'b', false), ev(400, 'c', false)]
  const r = m.extractPatterns(evs, 0, 500)
  eq('未解：最后成功之后 3 次失败 → 1 张卡', r.unresolved.length, 1)
  ok('未解：标题列出工具', (r.unresolved[0]?.title ?? '').includes('b'), r.unresolved[0]?.title)

  const fine = [ev(100, 'a', false), ev(200, 'b', true)]
  eq('未解：成功收尾不产卡', m.extractPatterns(fine, 0, 500).unresolved.length, 0)
}

{
  // 5.8 空输入安全
  const r = m.extractPatterns([], 0, 1000)
  eq('空经历：四类皆空', [r.pitfalls.length, r.playbooks.length, r.hotspots.length, r.unresolved.length], [0, 0, 0, 0])
  const r2 = m.extractPatterns([ev(1, 't', true)], 0, 1000)
  ok('单次成功：不误报', r2.pitfalls.length === 0 && r2.unresolved.length === 0)
}

// ── 6. 记忆卡结构契约 ──
{
  const r = m.extractPatterns([ev(1, 'pwsh', false, 'e'), ev(2, 'pwsh', false, 'e'), ev(3, 'pwsh', false, 'e')], 0, 10)
  const c = r.pitfalls[0]
  ok('记忆卡：字段齐全', ['id', 't', 'kind', 'title', 'body', 'tags', 'weight', 'uses', 'lastUsed', 'source'].every(k => k in c))
  ok('记忆卡：kind 合法', ['pitfall', 'playbook', 'hotspot', 'unresolved', 'fact'].includes(c.kind))
  ok('记忆卡：weight 为正数', typeof c.weight === 'number' && c.weight > 0)
  ok('记忆卡：初始未被使用', c.uses === 0 && c.lastUsed === 0)
}

// ── 7. 稳态降噪内核：reduceNoise ──
{
  const T0 = 1700000000000
  const alert = { organ: 'neurogenesis', note: '🚨 生命力告警：1 个器官离线：neurogenesis' }

  // 7.1 首次告警：不抑制、不静默
  {
    const noise = {}
    const r = m.reduceNoise(noise, [alert], T0, 60000, 5)
    eq('降噪：首次不产生抑制', r.suppressed, 0)
    eq('降噪：首次不收敛', r.converged.length, 0)
    eq('降噪：建立 1 条账本', Object.keys(noise).length, 1)
    const k = Object.keys(noise)[0]
    eq('降噪：首次计数为 1', noise[k].count, 1)
    ok('降噪：首次未静默', noise[k].silenced === false)
    eq('降噪：首次时间戳正确', noise[k].first, T0)
  }

  // 7.2 窗口内重复 → 只计数 + 计入抑制（不刷屏）
  {
    const noise = {}
    m.reduceNoise(noise, [alert], T0, 60000, 5)
    const r2 = m.reduceNoise(noise, [alert], T0 + 1000, 60000, 5)
    m.reduceNoise(noise, [alert], T0 + 2000, 60000, 5)
    eq('降噪：窗口内重复被抑制', r2.suppressed, 1)
    eq('降噪：计数持续累加', noise[Object.keys(noise)[0]].count, 3)
  }

  // 7.3 重复到阈值 → 收敛为「已知稳态偏移」并静默
  {
    const noise = {}
    let conv = []
    for (let i = 0; i < 5; i++) conv = conv.concat(m.reduceNoise(noise, [alert], T0 + i * 90000, 60000, 5).converged)
    const k = Object.keys(noise)[0]
    eq('降噪：第 5 次触发收敛', conv.length, 1)
    ok('降噪：已标记静默', noise[k].silenced === true)
    const after = m.reduceNoise(noise, [alert], T0 + 5 * 90000, 60000, 5)
    eq('降噪：静默后不再计入抑制（彻底安静）', after.suppressed, 0)
    eq('降噪：静默后计数仍如实累加', noise[k].count, 6)
  }

  // 7.4 数字不同但内容相同 → 收敛到同一条
  {
    const noise = {}
    m.reduceNoise(noise, [{ organ: 'x', note: '器官「代谢」连续失败 3 次' }], T0, 60000, 5)
    m.reduceNoise(noise, [{ organ: 'x', note: '器官「代谢」连续失败 9 次' }], T0 + 100, 60000, 5)
    eq('降噪：仅数字不同归为同一条', Object.keys(noise).length, 1)
  }

  // 7.5 不同器官/不同告警分开记账
  {
    const noise = {}
    m.reduceNoise(noise, [
      { organ: 'a', note: '器官离线' },
      { organ: 'b', note: '器官离线' },
      { organ: 'a', note: '器官疲劳' },
    ], T0, 60000, 5)
    eq('降噪：不同来源分开记账', Object.keys(noise).length, 3)
  }

  // 7.6 空输入安全
  {
    const noise = {}
    const r = m.reduceNoise(noise, [], T0, 60000, 5)
    eq('降噪：空输入无副作用', [Object.keys(noise).length, r.suppressed, r.converged.length], [0, 0, 0])
    const r2 = m.reduceNoise(noise, null, T0, 60000, 5)
    eq('降噪：null 输入不炸', r2.suppressed, 0)
  }
}

console.log(fails.length ? `\n✗ 回归未通过：${fails.length} 项失败 / 共 ${pass + fails.length} 项` : `\n✓ 回归通过：${pass} 项断言全部满足`)
for (const f of fails) console.log(`  ✗ ${f}`)
process.exit(fails.length ? 1 : 0)
