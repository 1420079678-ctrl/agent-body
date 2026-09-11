/**
 * Agent-Body 确定性内核 —— 零依赖版本。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这是什么
 * ═══════════════════════════════════════════════════════════════════════
 * 内核里有两种东西：
 *
 *   ① **确定性逻辑** —— 意图路由、器官认领、反射条件、失败归因、组织归档、
 *      token 估算、修剪判据。这些是纯函数：不碰 IO、不调模型、不看时钟。
 *   ② **生理运行时** —— 心跳、事件总线、持久化、工具执行。这些必须活在宿主里。
 *
 * ①被单独搬到这里，做成**不依赖任何东西**的模块：不需要 DeepSeek Harness、
 * 不需要 cordis、不需要 schemastery、不联网。任何人 `git clone` 之后就能跑。
 *
 * 为什么必须这么做：随包发布的 `lib/index.js` 在顶层就 import 了
 * `@deepseek-ai/dsh-tools`，裸 clone 里 `import` 直接失败——于是「82% token 削减」
 * 这类数字外人根本无法复现，只能相信。把确定性部分解耦出来，数字才可被独立验证。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 与内核的一致性
 * ═══════════════════════════════════════════════════════════════════════
 * - **常量表**（器官目录 / 神经支配表 / 组织规则 / 种子反射 / 常驻能力）由
 *   `tools/extract-tables.mjs` 从内核源码机械抽取，不手抄；`--check` 模式在 CI 里
 *   做漂移检测（内核改了而这里没重生成 → 直接失败）。
 * - **纯函数**是本文件的移植版。`test/parity.test.mjs` 会在宿主可用时载入真实的
 *   `dsh-organism/lib/index.js`，用大量输入逐项比对两边输出；宿主不可用时该测试
 *   **明确跳过并标注**，而不是假装通过。
 *
 * 移植不是理想方案，但它是当前唯一能让外部复现的选择；消除它的路径见
 * `docs/host-adapter.md`（把确定性核心下沉为内核直接依赖的第一方包）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 还原 `{$regex,$flags}` → RegExp（与 extract-tables.mjs 的编码对称） */
export function decodeRegExp(value) {
  if (value && typeof value === 'object' && typeof value.$regex === 'string') {
    return new RegExp(value.$regex, value.$flags || '')
  }
  if (Array.isArray(value)) return value.map(decodeRegExp)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = decodeRegExp(v)
    return out
  }
  return value
}

const snapshot = JSON.parse(fs.readFileSync(path.join(here, 'tables.generated.json'), 'utf8'))

/** 生成这份表时对应的内核源码（仓库相对路径） */
export const KERNEL_SOURCE = snapshot.source

/** 策展器官目录 */
export const CURATED = decodeRegExp(snapshot.tables.CURATED)
/** 神经支配表：命令意图 → 受支配器官 */
export const INNERVATION = decodeRegExp(snapshot.tables.INNERVATION)
/** 细胞 → 组织 规则 */
export const TISSUE_RULES = decodeRegExp(snapshot.tables.TISSUE_RULES)
/** 内置种子反射弧 */
export const SEED_REFLEXES = decodeRegExp(snapshot.tables.SEED_REFLEXES)
/** 不参与门控的核心常驻能力 */
export const ALWAYS_TOOLS = snapshot.tables.ALWAYS_TOOLS

// ═══════════════════════════ Token 经济 ═══════════════════════════

/**
 * 粗略 token 估算（确定性，标注为估算而非精确计数）：
 * CJK 与全角字符按 1 字符≈1 token，其余按 4 字符≈1 token —— BPE 的经验近似。
 * 用途是比较「全量 vs 门控后」的相对开销，不是计费口径。
 */
export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0x3000 && cp <= 0x303f)
    if (wide) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 一次工具调用定义的 token 开销（模型实际看到的字段） */
export function schemaTokens(schema) {
  try {
    const t = schema ?? {}
    return estimateTokens(
      JSON.stringify({
        name: t.name ?? '',
        description: t.description ?? '',
        parameters: t.parameters ?? {},
      }),
    )
  } catch {
    return 0
  }
}

// ═══════════════════════════ 器官认领 ═══════════════════════════

/** 工具名 → 器官家族（自动解剖的核心） */
export function familyOf(toolName) {
  let n = toolName
  if (n.startsWith('_dsh_external_')) n = n.replace(/^_dsh_external_/, '')
  if (n.startsWith('dsh_')) n = n.replace(/^dsh_/, '')
  const multi = ['office_docs_', 'social_card_', 'browser_ultimate_', 'minimal_gray_']
  for (const m of multi) if (n.startsWith(m)) return m.replace(/_$/, '')
  const i = n.indexOf('_')
  return i > 0 ? n.slice(0, i) : n
}

/** 器官是否管辖该工具（支持 `prefix*` 通配与精确名） */
export function organClaims(organ, toolName) {
  for (const cap of organ.capabilities) {
    if (cap.endsWith('*')) {
      if (toolName.startsWith(cap.slice(0, -1))) return true
    } else if (cap === toolName) return true
  }
  return false
}

function globMatch(pattern, value) {
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
  return pattern === value
}

/**
 * 触发匹配：支持逗号分隔的正/负模式，`!` 前缀为**排除**。
 * 例：`*,!body_*` = 除自身器官外的任何工具——防止反射被自己的输出触发。
 */
export function matchTrigger(pattern, value) {
  const parts = pattern.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return false
  for (const p of parts) if (p.startsWith('!') && globMatch(p.slice(1), value)) return false
  const positives = parts.filter((p) => !p.startsWith('!'))
  if (positives.length === 0) return true
  return positives.some((p) => globMatch(p, value))
}

/** 器官是否「活着」：至少有一项能力能在当前工具集中落实 */
export function organAlive(organ, tools) {
  if (organ.capabilities.length === 0) return true
  return organ.capabilities.some((cap) =>
    cap.endsWith('*') ? tools.some((t) => t.startsWith(cap.slice(0, -1))) : tools.includes(cap),
  )
}

/** 能力族（用于代偿重叠计算） */
export function capabilityFamilies(o) {
  const out = new Set()
  for (const cap of o.capabilities) {
    const base = cap.replace(/\*$/, '')
    const seg = base.split('_').filter((s) => s.length >= 2 && s !== 'dsh' && s !== 'external')
    if (seg.length) out.add(seg[0])
  }
  return out
}

/**
 * 脱器官代偿：某器官离线时，找仍然活着、能力重叠最高的器官顶上。
 * 同系统分组额外加分（同系统内的器官本来就有功能冗余）。
 */
export function compensateFor(missing, organs, tools) {
  const explicit = new Set(missing.fallback ?? [])
  const mine = capabilityFamilies(missing)
  const scored = []
  for (const o of organs) {
    if (o.id === missing.id) continue
    if (!organAlive(o, tools)) continue
    const overlap =
      [...capabilityFamilies(o)].filter((f) => mine.has(f)).length * 2 +
      (o.group === missing.group ? 1 : 0) +
      (explicit.has(o.id) ? 10 : 0)
    if (overlap > 0) scored.push({ organ: o.id, label: o.label, overlap })
  }
  return scored.sort((a, b) => b.overlap - a.overlap).slice(0, 3)
}

// ═══════════════════════════ 神经支配 ═══════════════════════════

/** 从器官的能力/标识里提炼可匹配的职能词 */
export function organKeywords(o) {
  const stop = new Set(['dsh', 'external', 'deepseek', 'ai', 'the'])
  const out = new Set()
  for (const cap of o.capabilities) {
    const base = cap.replace(/\*$/, '')
    for (const seg of base.split('_')) {
      if (seg.length >= 3 && !stop.has(seg.toLowerCase())) out.add(seg)
    }
  }
  for (const seg of o.id.split(/[:_]/)) if (seg.length >= 3) out.add(seg)
  return [...out]
}

/**
 * 神经支配：一条命令 → 受它支配的器官（按得分排序）。
 * 纯确定性，零模型往返。全部无命中时交由前额叶统一决策。
 */
export function innervate(command, organs) {
  const hits = new Map()
  const add = (id, score, reason, ruleIndex) => {
    const cur = hits.get(id) ?? { score: 0, reasons: [], ruleIndex }
    cur.score += score
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason)
    if (cur.ruleIndex < 0) cur.ruleIndex = ruleIndex
    hits.set(id, cur)
  }
  for (let i = 0; i < INNERVATION.length; i += 1) {
    const rule = INNERVATION[i]
    const m = command.match(rule.match)
    if (!m) continue
    for (const id of rule.organs) add(id, 10, `命令词「${m[0]}」`, i)
  }
  const lower = command.toLowerCase()
  for (const o of organs) {
    for (const kw of organKeywords(o)) {
      if (kw.length >= 3 && lower.includes(kw.toLowerCase())) add(o.id, 4, `职能词「${kw}」`, -1)
    }
  }
  if (hits.size === 0) add('prefrontal', 5, '无明确靶器官——由前额叶统一决策', -1)
  return [...hits.entries()]
    .map(([organ, v]) => ({ organ, score: v.score, reason: v.reasons.join('、'), ruleIndex: v.ruleIndex }))
    .sort((a, b) => b.score - a.score)
}

// ═══════════════════════════ 反射条件 ═══════════════════════════

/** 确定性条件求值（无 eval）：always/error/ok/slow:<ms>/hit:<sub>/miss:<sub>，|| 分组、&& 串联 */
export function evalCondition(cond, data) {
  if (!cond || cond.trim() === '' || cond.trim() === 'always') return true
  for (const grp of cond.split('||').map((s) => s.trim())) {
    let all = true
    for (const clause of grp.split('&&').map((s) => s.trim())) {
      const idx = clause.indexOf(':')
      const key = idx < 0 ? clause : clause.slice(0, idx)
      const val = idx < 0 ? '' : clause.slice(idx + 1)
      let pass = false
      switch (key) {
        case 'always': pass = true; break
        case 'error': pass = data.isError; break
        case 'ok': pass = !data.isError; break
        case 'slow': pass = data.ms >= Number(val || '0'); break
        case 'hit': pass = data.text.includes(val); break
        case 'miss': pass = !data.text.includes(val); break
        default: pass = false
      }
      if (!pass) {
        all = false
        break
      }
    }
    if (all) return true
  }
  return false
}

/** 反射动作里的 `${var}` 模板填充 */
export function fillTemplate(v, vars) {
  if (typeof v === 'string') return v.replace(/\$\{(\w+)\}/g, (_m, k) => vars[k] ?? '')
  if (Array.isArray(v)) return v.map((x) => fillTemplate(x, vars))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = fillTemplate(x, vars)
    return out
  }
  return v
}

// ═══════════════════════════ 组织归档 ═══════════════════════════

/** 细胞 → 组织（确定性启发式） */
export function tissueOf(toolName) {
  for (const r of TISSUE_RULES) if (r.match.test(toolName)) return r.tissue
  return '基质组织'
}

/** 全部组织名（按规则顺序，附带兜底基质组织） */
export function tissueNames() {
  return [...new Set([...TISSUE_RULES.map((r) => r.tissue), '基质组织'])]
}

// ═══════════════════════════ 学习与修剪 ═══════════════════════════

/** 细胞状态：活跃 / 休眠 / 病变 / 凋亡候选 */
export function cellState(c, fatigueThreshold) {
  if (c.calls === 0) return 'dormant'
  if (c.fail >= fatigueThreshold && c.fail > c.ok) return 'apoptotic'
  if (c.fail > c.ok) return 'pathological'
  return 'active'
}

/** 该淘汰这条反射吗：开火够多却一次没帮上忙 —— 只会添乱的规则不该继续空转 */
export function shouldRetireReflex(st, minFires = 5) {
  return !st.retired && st.fires >= minFires && st.helped === 0
}

/** 该强化这条反射吗：帮忙率够高 —— 同一病因下让它反应更快 */
export function shouldBoostReflex(st, minFires = 4, ratio = 0.6) {
  return !st.retired && st.fires >= minFires && st.helped / st.fires >= ratio
}

/** 该遗忘这条技能吗：重放失败够多且失败多于成功 —— 过时的成功路径不该继续被推荐 */
export function shouldForgetSkill(s, minFail = 2) {
  const ok = s.ok ?? 0
  const fail = s.fail ?? 0
  return fail >= minFail && fail > ok
}

/** 突触衰减系数：闲置越久越弱（半衰期模型），用于「不用的连接会消失」 */
export function synapseDecayFactor(idleMs, halfLifeMs) {
  if (halfLifeMs <= 0 || idleMs < halfLifeMs) return 1
  return Math.pow(0.5, Math.floor(idleMs / halfLifeMs))
}

/** 该修剪这条突触吗：权重已衰减到几乎无影响且有足够样本 */
export function shouldPruneSynapse(s, minWeight = 0.2, minSamples = 2) {
  return Math.abs(s.weight) < minWeight && s.paid + s.failed >= minSamples
}

// ═══════════════════════════ 自愈：归因与处方 ═══════════════════════════

/**
 * 失败归因（确定性，从真实错误文本判定）。
 * **这是自愈的第一步**——不归因的自愈等于乱试；归因之后才谈得上对症下药。
 */
export function attributeFailure(errorText) {
  const t = errorText || ''
  // ① HTTP / 路径类「不存在」先判，否则会被下面的 not found 误判成工具缺失
  if (/\bHTTP\s*404\b|\bstatus:?\s*404\b|404 not found/i.test(t)) return 'not_found'
  if (/no such file or directory|系统找不到指定的路径|cannot find the path|文件不存在|找不到文件|path does not exist/i.test(t)) return 'not_found'
  // ② 工具/命令缺失（含 Windows PowerShell 的「不会被识别为 cmdlet」与 Unix 的「不是内部或外部命令」）
  if (/command not found|is not recognized|不是内部或外部命令|不会被识别为|未安装|not installed|spawn\s+\S+\s+ENOENT|ENOENT/i.test(t)) return 'tool_missing'
  // ③ 参数错误
  if (/invalid arguments|required property|ToolArgsError|INVALID_ARGS|expected .* received/i.test(t)) return 'arg_error'
  // ④ 权限
  if (/EACCES|EPERM|permission denied|拒绝访问|access is denied|权限不足|没有权限/i.test(t)) return 'permission'
  // ⑤ 超时
  if (/ETIMEDOUT|timeout|timed out|超时|deadline exceeded/i.test(t)) return 'timeout'
  // ⑥ 网络
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|connect ECONN|网络不可达|连接被拒绝/i.test(t)) return 'network'
  // ⑦ 冲突
  if (/EEXIST|already exists|conflict|被占用|locked|EBUSY/i.test(t)) return 'conflict'
  return 'unknown'
}

/**
 * 处方表：病因 → 处置。`auto: true` 表示可**不经大脑**自动执行（只读/诊断类）；
 * `auto: false` 表示必须由大脑裁决（有副作用，避免自愈变成自伤）。
 */
export const REMEDIES = {
  tool_missing: { label: '工具缺失 → 盘点本机工具链真实路径', tool: 'sec_toolchain', args: {}, auto: true, note: '缺工具不是能力问题而是装备问题：先查真路径，避免误判成"没这个本事"' },
  arg_error: { label: '参数错误 → 不自动重试（自愈不治错误调用）', tool: '', args: {}, auto: false, note: '参数错是大脑的锅，自动重试只会放大错误——必须大脑修正后重发' },
  permission: { label: '权限受限 → 查授权与沙箱档位', tool: 'auto_status', args: {}, auto: true, note: '权限问题靠换路径或提权，不靠重试' },
  timeout: { label: '超时 → 查负载与并发档位', tool: 'auto_status', args: {}, auto: true, note: '超时是能力边界信号：降载或拆小任务' },
  network: { label: '网络不可达 → 换器官或走代理路径', tool: '', args: {}, auto: false, note: '网络类病因需大脑换路径（同能力的不同器官）' },
  not_found: { label: '目标不存在 → 不重试，改侦察', tool: '', args: {}, auto: false, note: '目标不在就是不在，重试无意义' },
  conflict: { label: '资源被占用 → 等待或换资源', tool: '', args: {}, auto: false, note: '冲突需要等待机制或换目标' },
  unknown: { label: '未知病因 → 检索历史经验', tool: 'war_memory', args: { action: 'search', query: '${tool}', limit: 5 }, auto: true, note: '先回忆：这类失败上次是怎么过去的' },
}

export const FAILURE_CAUSES = /** @type {const} */ ([
  'tool_missing', 'arg_error', 'permission', 'timeout', 'network', 'not_found', 'conflict', 'unknown',
])
