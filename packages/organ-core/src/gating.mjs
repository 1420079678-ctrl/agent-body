/**
 * 按需显影（schema gating）的确定性模型 —— 基准与 SDK 共用同一份实现。
 *
 * 这是对内核 `workingSetFor()` 的忠实移植（内核源码见
 * `workspace/plugins/dsh-organism/src/index.ts` 的「按需显影」一节）：
 *
 *   keep  = ALWAYS_TOOLS ∩ 当前工具集 ∪ 配置追加的常驻工具
 *   hot   = innervate(最新命令).slice(0, topK)          ← 当前意图
 *         ∪ 10 分钟内调用过的器官                        ← 近期活动
 *         ∪ 信任度 ≥ 0.7 的器官                          ← 历史信任
 *   keep += 每个 hot 器官最多 perOrganCap 个它认领的工具
 *
 * 未显影的能力不会消失——`body_call` 是通向任意能力的通用网关。
 *
 * ⚠️ **冷启动约定**：基准默认只启用①（当前意图），把②③留空。
 * 理由是可复现性：②③依赖运行历史（本机用过什么、信任度攒到多少），
 * 别人 clone 之后跑出来的必然是另一组数字。冷启动是**最少假设**的口径，
 * 也是门控收益的**下界**（有历史时 hot 集更大、省得更少）。
 */

import { ALWAYS_TOOLS, CURATED, familyOf, innervate, organAlive, organClaims, schemaTokens } from './kernel.mjs'

/** 门控参数的默认值，与内核 Config 保持一致 */
export const GATE_DEFAULTS = {
  perOrganCap: 10,
  topK: 4,
  recentWindowMs: 600000,
  trustThreshold: 0.7,
}

/**
 * 解剖：策展器官 + 未被认领工具自动升格成的「自主神经器官」。
 * 与内核 `anatomy()` 同构。
 */
export function buildAnatomy(tools) {
  const declared = CURATED.map((o) => ({ ...o, installed: organAlive(o, tools) }))
  const covered = new Set()
  for (const o of declared) for (const t of tools) if (organClaims(o, t)) covered.add(t)

  const auto = new Map()
  for (const t of tools) {
    if (covered.has(t)) continue
    const fam = familyOf(t)
    const arr = auto.get(fam) ?? []
    arr.push(t)
    auto.set(fam, arr)
  }
  const autonomic = [...auto.entries()].map(([fam, list]) => ({
    id: `auto:${fam}`,
    label: `自主神经器官（${fam}）`,
    group: 'autonomic',
    capabilities: list,
    afferent: [],
    purpose: '未被策展目录认领的能力，自动升格为器官',
    installed: true,
  }))
  return [...declared, ...autonomic]
}

/**
 * 计算一条命令下「直接可见」的工具集合。
 *
 * @param {object} opts
 * @param {string} opts.command          操作者的命令原文
 * @param {string[]} opts.tools          当前全部工具名
 * @param {object[]} opts.organs         解剖结果（buildAnatomy 的产物）
 * @param {number} [opts.perOrganCap]    单器官显影上限
 * @param {number} [opts.topK]           意图支配取前几名器官
 * @param {string[]} [opts.recentOrgans] 近期活动器官（默认空 = 冷启动）
 * @param {string[]} [opts.trustedOrgans] 高信任器官（默认空 = 冷启动）
 */
export function workingSet(opts) {
  const {
    command = '',
    tools,
    organs,
    perOrganCap = GATE_DEFAULTS.perOrganCap,
    topK = GATE_DEFAULTS.topK,
    recentOrgans = [],
    trustedOrgans = [],
  } = opts

  const all = new Set(tools)
  const keep = new Set()
  for (const t of ALWAYS_TOOLS) if (all.has(t)) keep.add(t)

  const hot = new Set()
  const dispatch = []
  for (const r of innervate(command, organs).slice(0, topK)) {
    hot.add(r.organ)
    dispatch.push({ organ: r.organ, score: r.score, ruleIndex: r.ruleIndex })
  }
  for (const id of recentOrgans) hot.add(id)
  for (const id of trustedOrgans) hot.add(id)

  const revealed = []
  for (const id of hot) {
    const o = organs.find((x) => x.id === id)
    if (!o) continue
    let n = 0
    const got = []
    for (const t of tools) {
      if (n >= perOrganCap) break
      if (!organClaims(o, t)) continue
      keep.add(t)
      got.push(t)
      n += 1
    }
    if (got.length) revealed.push({ organ: id, tools: got })
  }

  return { keep, hot: [...hot], dispatch, revealed }
}

/** 百分比与统计的确定性实现（不引入随机数） */
function stats(values) {
  if (values.length === 0) return { n: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))]
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    median: at(0.5),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p10: at(0.1),
    p90: at(0.9),
  }
}

/**
 * 跑一组命令，测量「全量 vs 门控」的 tool-schema token 开销。
 *
 * @param {object} opts
 * @param {Array<{id:string, command:string, expect?:string[]}>} opts.tasks 任务集
 * @param {Array<{name:string, description?:string, parameters?:unknown}>} opts.toolSchemas 全量工具定义
 * @param {number} [opts.perOrganCap]
 * @param {number} [opts.topK]
 * @param {(schema:object)=>number} [opts.counter] token 计数器（默认内核估算器）
 */
export function measureGate(opts) {
  const { tasks, toolSchemas, perOrganCap = GATE_DEFAULTS.perOrganCap, topK = GATE_DEFAULTS.topK } = opts
  // 缺省用内核同一套估算器——文档承诺过默认值，就不能让调用方踩 TypeError
  const counter = opts.counter ?? schemaTokens

  const tools = toolSchemas.map((t) => t.name)
  const organs = buildAnatomy(tools)
  const byName = new Map(toolSchemas.map((t) => [t.name, t]))

  const tokensOf = (names) => names.reduce((sum, n) => sum + counter(byName.get(n) ?? { name: n }), 0)

  const fullNames = [...tools]
  const fullTokens = tokensOf(fullNames)

  const per = tasks.map((task) => {
    const ws = workingSet({ command: task.command, tools, organs, perOrganCap, topK })
    const gatedNames = tools.filter((t) => ws.keep.has(t))
    const gatedTokens = tokensOf(gatedNames)
    const savedTokens = fullTokens - gatedTokens
    const reachable = new Set(gatedNames)
    // 任务声明的期望能力中，有多少在首轮就直接可见（其余需经 body_call 网关取回）
    const expect = task.expect ?? []
    const expectVisible = expect.filter((t) => reachable.has(t))

    // 未显影的期望能力要**归因**：是缺陷，还是被设计的取舍？
    // 不归因就变成「有 11 个漏显影」这种不能行动的数字。
    const dispatchOrgans = ws.dispatch.map((d) => d.organ)
    const misses = expect
      .filter((t) => !reachable.has(t))
      .map((t) => {
        if (ALWAYS_TOOLS.includes(t)) {
          return { tool: t, kind: 'bug', reason: '常驻集里的能力不该被门控隐藏——这是缺陷，不是取舍' }
        }
        const owner = organs.find((o) => organClaims(o, t))
        if (!owner) {
          return { tool: t, kind: 'bug', reason: '没有任何器官认领它——解剖有缺口' }
        }
        if (dispatchOrgans.includes(owner.id)) {
          return {
            tool: t,
            kind: 'capped',
            organ: owner.id,
            reason: `器官「${owner.label}」已被支配，但每个器官只显影前 ${perOrganCap} 项，它被截断——需经 body_call 取回`,
          }
        }
        return {
          tool: t,
          kind: 'unrouted',
          organ: owner.id,
          reason: `该意图没有支配到器官「${owner.label}」——需经 body_call 取回，或补一条意图规则`,
        }
      })

    return {
      id: task.id,
      command: task.command,
      dispatch: ws.dispatch,
      visibleTools: gatedNames.length,
      visibleTokens: gatedTokens,
      savedTokens,
      savedPct: fullTokens === 0 ? 0 : savedTokens / fullTokens,
      expects: expect,
      expectsVisible: expectVisible,
      expectsVisibleRatio: expect.length === 0 ? null : expectVisible.length / expect.length,
      misses,
    }
  })

  const savedPcts = per.map((p) => p.savedPct)
  const expectRatios = per.map((p) => p.expectsVisibleRatio).filter((v) => v !== null)
  const allMisses = per.flatMap((p) => p.misses.map((m) => ({ task: p.id, ...m })))
  const byClass = {
    /** 真缺陷：基准应当失败 */
    bug: allMisses.filter((m) => m.kind === 'bug'),
    /** 设计取舍：器官已支配但被 perOrganCap 截断，经 body_call 可取回 */
    capped: allMisses.filter((m) => m.kind === 'capped'),
    /** 设计取舍：意图没路由到这个器官 */
    unrouted: allMisses.filter((m) => m.kind === 'unrouted'),
  }

  return {
    estimator: counter ? 'custom' : 'agent-body/estimateTokens',
    gate: { perOrganCap, topK, coldStart: true },
    corpus: {
      tools: tools.length,
      organs: organs.length,
      curatedOrgans: organs.filter((o) => !o.id.startsWith('auto:')).length,
      autonomicOrgans: organs.filter((o) => o.id.startsWith('auto:')).length,
      tasks: tasks.length,
    },
    full: { tools: fullNames.length, tokens: fullTokens },
    gated: {
      tokens: stats(per.map((p) => p.visibleTokens)),
      tools: stats(per.map((p) => p.visibleTools)),
    },
    saved: {
      tokens: stats(per.map((p) => p.savedTokens)),
      pct: stats(savedPcts),
    },
    /**
     * 门控是否把「任务真正需要的器官能力」藏起来了。
     * 分三类：bug（缺陷，必须修）/ capped / unrouted（取舍，有网关兜底）。
     * 判定只看 bug —— 把取舍也当失败，基准会变成一个永远红的噪音源；
     * 把 bug 当取舍，门控就会悄悄退化成「什么都藏」。
     */
    expectation: {
      tasks: expectRatios.length,
      visibleRatio: expectRatios.length ? stats(expectRatios) : null,
      totals: { bug: byClass.bug.length, capped: byClass.capped.length, unrouted: byClass.unrouted.length },
      byClass,
      missDetails: allMisses,
      misses: per
        .filter((p) => p.misses.length > 0)
        .map((p) => ({ id: p.id, missing: p.misses.map((m) => m.tool) })),
    },
    per,
  }
}
