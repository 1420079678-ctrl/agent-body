#!/usr/bin/env node
/**
 * Agent-Body 可复现基准。
 *
 * 目标：**陌生人 git clone && make bench 得到同样的数字**。
 *
 * 三条铁律：
 *   ① 输入全部在仓库里（工具 schema 语料、任务集、真实运行轨迹），不联网、不调模型、不要 API key
 *   ② 每个数字都标注口径与局限（见 benchmarks/README.md），不把「工具 schema token」说成「总 prompt token」
 *   ③ 失败案例一并公开——预期能力被门控藏起来时，基准**直接失败**而不是悄悄扣分
 *
 * 用法：
 *   node benchmarks/run.mjs                  # 跑全部，写 results/
 *   node benchmarks/run.mjs --check          # 与 baselines/expected.json 对比（CI）
 *   node benchmarks/run.mjs --json           # 只输出 JSON 到 stdout
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  ALWAYS_TOOLS,
  KERNEL_SOURCE,
  REMEDIES,
  attributeFailure,
  buildAnatomy,
  defaultInstallSet,
  measureGate,
  schemaTokens,
  shouldBoostReflex,
  shouldRetireReflex,
  shouldForgetSkill,
  shouldPruneSynapse,
  synapseDecayFactor,
  validateOrganManifest,
} from '../packages/organ-core/src/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const benchDir = here
const corpusDir = path.join(benchDir, 'corpus')
const resultsDir = path.join(benchDir, 'results')
const baselinesDir = path.join(benchDir, 'baselines')

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const exists = (p) => fs.existsSync(p)

// ═══════════════════════════ 输入 ═══════════════════════════

function loadInputs() {
  const corpus = readJson(path.join(corpusDir, 'tools.json'))
  const intents = readJson(path.join(benchDir, 'tasks', 'intents.json'))
  const catalogPath = path.join(benchDir, '..', 'catalog', 'organs.json')
  return {
    toolSchemas: corpus.tools,
    corpusProvenance: corpus.provenance,
    tasks: intents.tasks,
    intentsMeta: {
      version: intents.version,
      selection: intents.selection,
      comment: intents.$comment,
    },
    catalog: exists(catalogPath) ? readJson(catalogPath) : null,
    liveGate: exists(path.join(corpusDir, 'trace-live-gate.json'))
      ? readJson(path.join(corpusDir, 'trace-live-gate.json'))
      : null,
    trace: {
      healings: exists(path.join(corpusDir, 'trace-healings.json'))
        ? readJson(path.join(corpusDir, 'trace-healings.json')).healings
        : [],
      reflexStats: exists(path.join(corpusDir, 'trace-reflex-stats.json'))
        ? readJson(path.join(corpusDir, 'trace-reflex-stats.json')).stats
        : [],
      synapses: exists(path.join(corpusDir, 'trace-synapses.json'))
        ? readJson(path.join(corpusDir, 'trace-synapses.json')).synapses
        : [],
      skills: exists(path.join(corpusDir, 'trace-skills.json'))
        ? readJson(path.join(corpusDir, 'trace-skills.json')).skills
        : [],
    },
  }
}

// ═══════════════════════════ 套件 1：schema 门控 ═══════════════════════════

function suiteSchemaGating(input) {
  const { toolSchemas, tasks } = input

  const run = (perOrganCap, topK) =>
    measureGate({ tasks, toolSchemas, perOrganCap, topK, counter: schemaTokens })

  const primary = run(10, 4)

  // 参数扫描：perOrganCap 越大省得越少；topK 越大省得越少
  const sweep = []
  for (const cap of [5, 10, 20]) {
    for (const topK of [2, 4, 8]) {
      const r = run(cap, topK)
      sweep.push({
        perOrganCap: cap,
        topK,
        savedPctMean: r.saved.pct.mean,
        visibleToolsMax: r.gated.tools.max,
        misses: r.expectation.misses.length,
      })
    }
  }

  // 最坏情况：单条命令里省得最少的那个（诚实口径——不能只报均值）
  const worst = primary.per.reduce((a, b) => (a.savedPct <= b.savedPct ? a : b))
  const best = primary.per.reduce((a, b) => (a.savedPct >= b.savedPct ? a : b))

  // 正确性护栏分两类处理：
  //   ① 门控隐藏了**常驻集**里或**无人认领**的能力 → 真缺陷，基准 FAIL
  //   ② 器官被支配但能力被 perOrganCap 截断 / 意图没路由到该器官 → 设计取舍，有 body_call 兜底，
  //      报告里如实列出，但不判失败（否则基准会变成一个永远红的噪音源）
  const cls = primary.expectation.totals
  const verdict = cls.bug === 0 ? 'pass' : 'fail'

  // 任务集自身的错误：声明的能力在本机根本不存在 —— 这既不是门控的问题，也不能悄悄放过
  const toolNames = new Set(toolSchemas.map((t) => t.name))
  const taskSetWarnings = tasks
    .map((t) => ({ id: t.id, unknown: (t.expect ?? []).filter((e) => !toolNames.has(e)) }))
    .filter((w) => w.unknown.length > 0)

  return {
    definition:
      'prompt 中的 tool schema token：全部 n 个工具定义的 name+description+parameters 之和（估算器 ' +
      'agent-body/estimateTokens）vs 门控后首轮直接可见的那部分。**不含**系统提示正文、对话历史与工具结果。',
    estimator: primary.estimator,
    gateParams: primary.gate,
    corpus: primary.corpus,
    full: primary.full,
    gated: primary.gated,
    saved: primary.saved,
    savedWorstCase: { id: worst.id, command: worst.command, savedPct: worst.savedPct },
    savedBestCase: { id: best.id, command: best.command, savedPct: best.savedPct },
    alwaysVisible: { count: ALWAYS_TOOLS.length },
    verdict,
    correctness: {
      metric: '任务声明必须首轮可见的能力里，实际被显影的比例（1.0 = 门控没有藏起任务需要的能力）',
      visibleRatio: primary.expectation.visibleRatio,
      counts: cls,
      bugs: primary.expectation.byClass.bug,
      capped: primary.expectation.byClass.capped,
      unrouted: primary.expectation.byClass.unrouted,
      misses: primary.expectation.misses,
    },
    taskSetWarnings,
    sweep,
    per: primary.per,
  }
}

// ═══════════════════════════ 套件 2：消融实验 ═══════════════════════════

function suiteAblation(input) {
  const { trace, toolSchemas } = input

  // ── 归因层：从真实错误文本重算病因，与账本记录比对 ──
  const withError = trace.healings.filter((h) => h.error && h.error.trim())
  const agree = withError.filter((h) => attributeFailure(h.error) === h.cause)
  const attribution = {
    metric: '从错误文本重算的病因 == 账本记录的病因',
    samples: withError.length,
    agree: agree.length,
    agreement: withError.length ? agree.length / withError.length : null,
    disagreements: withError
      .filter((h) => attributeFailure(h.error) !== h.cause)
      .map((h) => ({ tool: h.tool, recorded: h.cause, recomputed: attributeFailure(h.error), error: h.error.slice(0, 120) })),
  }

  // ── 自愈：伤口闭合数与「无需大脑裁决」的占比 ──
  const healed = trace.healings.filter((h) => h.status === 'healed')
  const autoRemedy = trace.healings.filter((h) => (REMEDIES[h.cause] ?? {}).auto === true)
  const healing = {
    metric: '复检闭合的伤口数（关掉自愈 → 恒为 0；开 → 记录里实际闭合的数）',
    woundsRecorded: trace.healings.length,
    closedWithHealing: healed.length,
    closedWithoutHealing: 0,
    delta: healed.length,
    autoExecutableShare: trace.healings.length ? autoRemedy.length / trace.healings.length : null,
    byCause: countBy(trace.healings, (h) => h.cause),
  }

  // ── 反射：同一「工具 × 病因」重复 ≥3 次时系统自己长出的反射 ──
  const pairCounts = new Map()
  for (const h of trace.healings) {
    const k = `${h.tool}::${h.cause}`
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1)
  }
  const autoReflexes = [...pairCounts.entries()].filter(([, n]) => n >= 3)
  const reflex = {
    metric: '「工具 × 病因」累计 ≥3 次 → 自动生成的反射弧条数（关掉反射 → 0）',
    thresholds: { generateAt: 3, retireAtFires: 5, boostAtFires: 4, boostRatio: 0.6 },
    generatedWithReflex: autoReflexes.length,
    generatedWithoutReflex: 0,
    delta: autoReflexes.length,
    candidates: autoReflexes.map(([k, n]) => ({ pair: k, occurrences: n })),
    retirement: {
      wouldRetire: trace.reflexStats.filter((s) => shouldRetireReflex(s)).map((s) => s.id),
      wouldBoost: trace.reflexStats.filter((s) => shouldBoostReflex(s)).map((s) => s.id),
      observed: trace.reflexStats.length,
    },
  }

  // ── 遗忘：突触按半衰期衰减后被修剪的条数 ──
  const HALF_LIFE_MS = 1800000 // 与内核 synapseHalfLifeMs 默认值一致：30 分钟
  const decaySweep = [0, 1, 2, 4, 8].map((multiples) => {
    const idleMs = multiples * HALF_LIFE_MS
    let pruned = 0
    for (const s of trace.synapses) {
      const w = s.weight * synapseDecayFactor(idleMs, HALF_LIFE_MS)
      if (shouldPruneSynapse({ weight: w, paid: s.paid, failed: s.failed })) pruned += 1
    }
    return { idleHalfLives: multiples, idleMinutes: (idleMs / 60000) | 0, pruned, of: trace.synapses.length }
  })
  const forgetting = {
    metric: '按半衰期衰减后落入修剪阈值的突触条数（关掉遗忘 → 恒为 0）',
    halfLifeMinutes: HALF_LIFE_MS / 60000,
    synapsesRecorded: trace.synapses.length,
    sweep: decaySweep,
    prunedWithForgettingAtOneHalfLife: decaySweep[1].pruned,
    prunedWithoutForgetting: 0,
    skills: {
      observed: trace.skills.length,
      wouldForget: trace.skills.filter((s) => shouldForgetSkill(s)).map((s) => s.id),
    },
  }

  // ── 门控：关掉门控的代价 ──
  const gated = measureGate({ tasks: input.tasks, toolSchemas, counter: schemaTokens })
  const gating = {
    metric: '关掉门控 = 每个请求都携带全部工具 schema（省 0%）',
    savedPctWithGating: gated.saved.pct.mean,
    savedPctWithoutGating: 0,
    deltaTokensPerTurn: gated.saved.tokens.mean,
  }

  return { attribution, healing, reflex, forgetting, gating }
}

const countBy = (list, fn) => {
  const out = {}
  for (const x of list) {
    const k = String(fn(x))
    out[k] = (out[k] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

// ═══════════════════════════ 套件 3：基线对照 ═══════════════════════════

function suiteBaselines(input) {
  const { toolSchemas, tasks } = input
  const tools = toolSchemas.map((t) => t.name)
  const byName = new Map(toolSchemas.map((t) => [t.name, t]))
  const fullTokens = tools.reduce((s, n) => s + schemaTokens(byName.get(n)), 0)

  // 基线 A：传统插件（全部工具常驻，无门控）
  const bare = {
    id: 'bare',
    label: '传统：所有工具常驻 prompt',
    savedPctMean: 0,
    visibleTools: tools.length,
    misses: null,
    note: '这是当前绝大多数 agent 框架的实际做法，也是本基准的 0% 参照点。',
  }

  // 基线 B：朴素前缀门控（用命令里的关键词直接匹配工具家族名）
  const naive = tasks.map((task) => {
    const words = String(task.command)
      .toLowerCase()
      .split(/[\s，。、,.;：:！!？?（）()]+/)
      .filter((w) => w.length >= 2)
    const visible = tools.filter((t) => {
      if (ALWAYS_TOOLS.includes(t)) return true
      const tl = t.toLowerCase()
      return words.some((w) => tl.includes(w) || w.includes(tl))
    })
    const tokens = visible.reduce((s, n) => s + schemaTokens(byName.get(n)), 0)
    const expect = task.expect ?? []
    return {
      id: task.id,
      savedPct: (fullTokens - tokens) / fullTokens,
      visibleTools: visible.length,
      missingExpected: expect.filter((e) => !visible.includes(e)),
    }
  })
  const naiveSaved = mean(naive.map((n) => n.savedPct))
  const naiveMisses = naive.reduce((s, n) => s + n.missingExpected.length, 0)
  const naiveTaskMisses = naive.filter((n) => n.missingExpected.length > 0).length

  // 基线 C：本系统（冷启动）
  const gated = measureGate({ tasks, toolSchemas, counter: schemaTokens })

  return {
    fullTokens,
    strategies: [
      bare,
      {
        id: 'naive-prefix',
        label: '朴素：命令词直接匹配工具名',
        savedPctMean: naiveSaved,
        visibleToolsMean: mean(naive.map((n) => n.visibleTools)),
        misses: naiveMisses,
        tasksWithMiss: naiveTaskMisses,
        note: '省得可能更多，但会把任务真正需要的能力藏起来——它不知道「扫漏洞」需要 sec_* 家族。',
      },
      {
        id: 'agent-body-cold-start',
        label: 'Agent-Body：意图 → 器官 → 能力（冷启动）',
        savedPctMean: gated.saved.pct.mean,
        visibleToolsMean: gated.gated.tools.mean,
        misses: gated.expectation.misses.reduce((s, m) => s + m.missing.length, 0),
        tasksWithMiss: gated.expectation.misses.length,
        note: '收益不如朴素门控极端，但把「任务需要的能力」全部保住了——省 token 的前提是不省能力。',
      },
    ],
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// ═══════════════════════════ 套件 4：目录分级 ═══════════════════════════

function suiteCatalog(input) {
  const { catalog, toolSchemas } = input
  if (!catalog) {
    return { status: 'missing', note: 'catalog/organs.json 不存在 —— 运行 node catalog/build.mjs 生成' }
  }
  const tiers = {}
  for (const organ of catalog.organs) {
    tiers[organ.tier] = tiers[organ.tier] ?? { organs: 0, capabilities: 0, highRisk: 0 }
    tiers[organ.tier].organs += 1
    tiers[organ.tier].capabilities += organ.capabilities.length
    tiers[organ.tier].highRisk += organ.permissions.filter((p) =>
      ['exec:process', 'net:listen', 'secrets:read', 'host:inject'].includes(p),
    ).length
  }

  const validation = catalog.organs.map((o) => ({ id: o.id, ...validateOrganManifest(o) }))
  const invalid = validation.filter((v) => !v.ok)

  const defaultSet = defaultInstallSet(catalog.organs)
  const coveredBy = new Set()
  const tools = toolSchemas.map((t) => t.name)
  for (const o of catalog.organs) {
    for (const t of tools) {
      if (o.capabilities.some((c) => (c.endsWith('*') ? t.startsWith(c.slice(0, -1)) : c === t))) coveredBy.add(t)
    }
  }

  return {
    status: 'ok',
    source: catalog.$comment ?? null,
    organCount: catalog.organs.length,
    tiers: Object.fromEntries(Object.entries(tiers).sort()),
    defaultInstall: defaultSet,
    defaultInstallCount: defaultSet.length,
    contractValidation: {
      total: validation.length,
      valid: validation.length - invalid.length,
      invalid: invalid.map((v) => ({ id: v.id, errors: v.errors })),
    },
    coverage: {
      toolsInCorpus: tools.length,
      claimedByCatalog: coveredBy.size,
      unclaimed: tools.filter((t) => !coveredBy.has(t)).slice(0, 20),
    },
  }
}

// ═══════════════════════════ 套件 4：活体快照交叉校验 ═══════════════════════════

/**
 * 用仓库里的估算器和语料，重算「捕获那一刻活体实际显影的 64 项」的 token，
 * 与内核自己账本报出的数值对比。
 *
 * 这是**校验**，不是收益：两边对不上就说明语料不全或估算器偏了——
 * 那时候该修的是它们，而不是把好看的数字写进 README。
 */
function suiteLiveSnapshot(input) {
  const live = input.liveGate
  if (!live) return { status: 'missing', note: 'corpus/trace-live-gate.json 不存在' }

  const byName = new Map(input.toolSchemas.map((t) => [t.name, t]))
  const tokenOf = (n) => (byName.has(n) ? schemaTokens(byName.get(n)) : 0)

  const fullTokens = input.toolSchemas.reduce((s, t) => s + schemaTokens(t), 0)
  const visibleTokens = live.visibleTools.reduce((s, n) => s + tokenOf(n), 0)
  const unknown = live.visibleTools.filter((n) => !byName.has(n))
  const k = live.kernelReported

  return {
    metric:
      '用仓库估算器重算活体快照的显影清单 vs 内核账本自报数值。比值接近 1 说明语料完备、估算器与内核同口径。',
    reproducible: false,
    note: '活体口径含近期活动与历史信任，依赖捕获那一刻的运行状态，**不可离线复现**；仅作对照与校验。',
    capturedFrom: live.capturedFrom,
    kernel: k,
    recomputed: {
      fullTools: input.toolSchemas.length,
      fullTokens,
      visibleTools: live.visibleTools.length,
      visibleTokens,
    },
    agreement: {
      fullRatio: k.fullTokens ? fullTokens / k.fullTokens : null,
      gatedRatio: k.gatedTokens ? visibleTokens / k.gatedTokens : null,
      fullDeltaPct: k.fullTokens ? (fullTokens - k.fullTokens) / k.fullTokens : null,
      gatedDeltaPct: k.gatedTokens ? (visibleTokens - k.gatedTokens) / k.gatedTokens : null,
    },
    /** 快照里出现、但语料里没有的工具——非空就是语料缺陷 */
    unknownToolsInSnapshot: unknown,
    verdict:
      unknown.length === 0 && Math.abs(1 - visibleTokens / k.gatedTokens) < 0.15 ? 'consistent' : 'inconsistent',
  }
}

// ═══════════════════════════ 运行 ═══════════════════════════

function run() {
  const started = Date.now()
  const input = loadInputs()

  const result = {
    schema: 'agent-body-benchmark/1',
    generatedAt: new Date().toISOString(),
    kernelSource: KERNEL_SOURCE,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    inputs: {
      toolsCorpus: input.corpusProvenance,
      intentSet: input.intentsMeta,
      trace: {
        healings: input.trace.healings.length,
        reflexStats: input.trace.reflexStats.length,
        synapses: input.trace.synapses.length,
        skills: input.trace.skills.length,
      },
    },
    suites: {},
  }

  result.suites.schemaGating = suiteSchemaGating(input)
  result.suites.ablation = suiteAblation(input)
  result.suites.baselines = suiteBaselines(input)
  result.suites.catalog = suiteCatalog(input)
  result.suites.liveSnapshot = suiteLiveSnapshot(input)

  result.durationMs = Date.now() - started

  // 正确性护栏：门控藏起了**不该藏**的能力 → 基准失败，绝不悄悄放过
  const cls = result.suites.schemaGating.correctness.counts
  result.verdict = result.suites.schemaGating.verdict
  if (cls.bug > 0) {
    result.failureCases = result.suites.schemaGating.correctness.bugs
  }
  return result
}

function writeOutputs(result) {
  fs.mkdirSync(path.join(resultsDir, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(resultsDir, 'result.json'), JSON.stringify(result, null, 2) + '\n')

  const g = result.suites.schemaGating
  const a = result.suites.ablation
  const b = result.suites.baselines
  const c = result.suites.catalog

  const pct = (x) => `${(x * 100).toFixed(2)}%`
  const md = `# Agent-Body benchmark — raw report

> 自动生成，请勿手改。复现：\`make bench\`（或 \`node benchmarks/run.mjs\`）。
> **本文件是确定性产物：不含时间戳、不含平台名，同样输入必得同样字节**——这样 \`bench:check\` 能真正用它做 diff，
> CI 也不会因为「跑过一次」就把工作区弄脏；跨平台（Windows / Linux）产出的字节也一样。
> 环境与时间戳只写在 \`results/result.json\` 里。
>
> 要求 Node ≥ 22.19 / 24（估算器与内核同口径，见 §5 的交叉校验）

**verdict: ${result.verdict.toUpperCase()}**

## 口径（务必先读）

- 被测量的是 **prompt 中的 tool schema token**：全部工具定义的 name+description+parameters 之和，
  对比门控后首轮直接可见的那部分。**不包含**系统提示正文、对话历史与工具结果。
- 计数器是确定性估算器（CJK≈1 token/字符，其余≈4 字符/token），用于**相对比较**，不是计费口径。
- 门控口径为**冷启动**：只由当前命令的意图决定显影集，不使用任何本机运行历史。
  这是收益的**下界**（有历史时显影集更大、省得更少），也是唯一可被别人复现的口径。

## 1. Schema 门控

| 指标 | 值 |
| --- | --- |
| 工具总数 | ${g.corpus.tools} |
| 器官数（策展 + 自主升格） | ${g.corpus.organs}（${g.corpus.curatedOrgans} + ${g.corpus.autonomicOrgans}） |
| 任务集 | ${g.corpus.tasks} |
| 全量 schema token | ${g.full.tokens} |
| 门控后 schema token（均值） | ${Math.round(g.gated.tokens.mean)} |
| **省下（均值）** | **${pct(g.saved.pct.mean)}** |
| 省下（中位数 / p10 / 最差） | ${pct(g.saved.pct.median)} / ${pct(g.saved.pct.p10)} / ${pct(g.savedWorstCase.savedPct)} |
| 省下（最多的一条） | ${pct(g.savedBestCase.savedPct)} — \`${g.savedBestCase.command}\` |
| 每轮平均省下 token | ${Math.round(g.saved.tokens.mean)} |

最差的一条是 **${g.savedWorstCase.id}**（\`${g.savedWorstCase.command}\`）——只省 ${pct(g.savedWorstCase.savedPct)}。
看均值不如看这一条：它说明收益在最不利意图下会缩到多少。

**门控参数（topK × perOrganCap）扫描：**

| perOrganCap \\ topK | ${[...new Set(g.sweep.map((s) => s.topK))].join(' | ')} |
| --- | ${[...new Set(g.sweep.map((s) => s.topK))].map(() => '---').join(' | ')} |
${[...new Set(g.sweep.map((s) => s.perOrganCap))]
  .map((cap) => {
    const row = g.sweep.filter((s) => s.perOrganCap === cap)
    return `| ${cap} | ${row.map((s) => pct(s.savedPctMean)).join(' | ')} |`
  })
  .join('\n')}

**正确性护栏**：任务声明必须首轮可见的能力，实测显影比例 ${g.correctness.visibleRatio ? pct(g.correctness.visibleRatio.mean) : 'n/a'}。

| 类别 | 数量 | 含义 |
| --- | --- | --- |
| 缺陷（bug） | ${g.correctness.counts.bug} | 常驻集或无人认领的能力被藏起来 —— **必须修**，非 0 时基准 FAIL |
| 被截断（capped） | ${g.correctness.counts.capped} | 器官已受支配，但单器官只显影前 ${g.gateParams.perOrganCap} 项，能力被截断；经 \`body_call\` 可取回 |
| 未路由（unrouted） | ${g.correctness.counts.unrouted} | 该意图没有支配到管辖此能力的器官；经 \`body_call\` 可取回，或补一条意图规则 |

${g.correctness.counts.bug + g.correctness.counts.capped + g.correctness.counts.unrouted > 0
  ? `**缺口明细**（每一条都要能行动，不能只报个数）：\n\n${[
      ...g.correctness.bugs.map((m) => `- ❌ \`${m.task}\` → \`${m.tool}\`：${m.reason}`),
      ...g.correctness.capped.map((m) => `- ⚠️ \`${m.task}\` → \`${m.tool}\`（${m.organ}）：${m.reason}`),
      ...g.correctness.unrouted.map((m) => `- ⚠️ \`${m.task}\` → \`${m.tool}\`（${m.organ}）：${m.reason}`),
    ].join('\n')}`
  : '无缺口：任务需要的能力全部首轮可见。'}
${(g.taskSetWarnings ?? []).length ? `\n**任务集告警**（声明的能力在本机不存在，属任务集自身的错误）：\n${g.taskSetWarnings.map((w) => `- \`${w.id}\` → ${w.unknown.join(', ')}`).join('\n')}` : ''}

## 2. 消融实验（关掉一项机制会少掉什么）

| 机制 | 开 | 关 | 差 |
| --- | --- | --- | --- |
| 自愈（伤口闭合） | ${a.healing.closedWithHealing} | ${a.healing.closedWithoutHealing} | ${a.healing.delta} |
| 反射自生成（工具×病因≥${a.reflex.thresholds.generateAt}） | ${a.reflex.generatedWithReflex} | ${a.reflex.generatedWithoutReflex} | ${a.reflex.delta} |
| 遗忘（突触修剪 @1 个半衰期） | ${a.forgetting.prunedWithForgettingAtOneHalfLife} | ${a.forgetting.prunedWithoutForgetting} | ${a.forgetting.prunedWithForgettingAtOneHalfLife} |
| 门控（省 token） | ${pct(a.gating.savedPctWithGating)} | ${pct(a.gating.savedPctWithoutGating)} | ${Math.round(a.gating.deltaTokensPerTurn)} tok/轮 |

**归因层**：从真实错误文本重算病因，与账本记录一致率 **${a.attribution.agreement === null ? 'n/a' : pct(a.attribution.agreement)}**（${a.attribution.agree}/${a.attribution.samples}）。
${a.attribution.disagreements.length ? `不一致 ${a.attribution.disagreements.length} 例（这本身就是可修的缺陷）：\n${a.attribution.disagreements.map((d) => `- \`${d.tool}\` 记录=${d.recorded} 重算=${d.recomputed}`).join('\n')}` : '无不一致。'}

**突触衰减扫描**（半衰期 ${a.forgetting.halfLifeMinutes} 分钟）：

| 闲置 | 被修剪 | 占突触总数 |
| --- | --- | --- |
${a.forgetting.sweep.map((s) => `| ${s.idleMinutes} 分钟 | ${s.pruned} | ${s.pruned}/${s.of} |`).join('\n')}

**反射淘汰/强化**：观察 ${a.reflex.retirement.observed} 条，应淘汰 ${a.reflex.retirement.wouldRetire.length} 条、应强化 ${a.reflex.retirement.wouldBoost.length} 条。

## 3. 基线对照

| 策略 | 省下（均值） | 首轮可见工具（均值） | 误藏关键能力 | 任务受影响 |
| --- | --- | --- | --- | --- |
${b.strategies
  .map(
    (s) =>
      `| ${s.label} | ${pct(s.savedPctMean)} | ${s.visibleToolsMean ? Math.round(s.visibleToolsMean) : s.visibleTools} | ${s.misses === null ? '—' : s.misses} | ${s.tasksWithMiss ?? '—'} |`,
  )
  .join('\n')}

朴素前缀门控省得更多但会误藏能力；本系统的取舍是**先不省能力，再省 token**。

## 4. 器官目录分级

${c.status === 'ok' ? `- 器官数 ${c.organCount}，默认安装 ${c.defaultInstallCount} 个（${c.defaultInstall.join(', ')}）
- 分级分布：${Object.entries(c.tiers).map(([t, v]) => `${t} ${v.organs}`).join(' · ')}
- 契约校验：${c.contractValidation.valid}/${c.contractValidation.total} 通过${c.contractValidation.invalid.length ? `（失败：${c.contractValidation.invalid.map((i) => i.id).join(', ')}）` : ''}
- 语料覆盖：${c.coverage.claimedByCatalog}/${c.coverage.toolsInCorpus} 个工具被目录认领` : `- ${c.note}`}

## 5. 活体快照交叉校验

${(() => {
  const l = result.suites.liveSnapshot
  if (!l || l.status === 'missing') return `- ${l ? l.note : '缺失'}`
  const p = (x) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`)
  return `捕获自：${l.capturedFrom}（**不可离线复现**，含运行历史）

| | 内核账本自报 | 本仓库估算器重算 | 偏差 |
| --- | --- | --- | --- |
| 全量 token（${l.recomputed.fullTools} 项） | ${l.kernel.fullTokens} | ${l.recomputed.fullTokens} | ${p(l.agreement.fullDeltaPct)} |
| 显影后 token（${l.recomputed.visibleTools} 项） | ${l.kernel.gatedTokens} | ${l.recomputed.visibleTokens} | ${p(l.agreement.gatedDeltaPct)} |

判定：**${l.verdict}**${l.unknownToolsInSnapshot.length ? `　⚠️ 快照里有 ${l.unknownToolsInSnapshot.length} 项不在语料中：${l.unknownToolsInSnapshot.join(', ')}` : '（语料完备，估算器与内核同口径）'}

> 活体口径是 **${pct(l.kernel.savedPct)}**（${l.kernel.gatedTools}/${l.kernel.fullTools} 项）。
> 它与上面的冷启动口径差值，就是「本机运行历史」带来的显影增量——历史越多，省得越少。
> 两个数都真实，**引用时必须带上口径**。`
})()}

## 原始数据

- 本报告：\`benchmarks/results/REPORT.md\`（**确定性产物，入库**，可直接 diff）
- 机器可读结果：\`benchmarks/results/result.json\`（每次运行带时间戳，**不入库**；与本报告同源）
- 比对基线：\`benchmarks/baselines/expected.json\`（CI 用它判断漂移）
- 输入语料：\`benchmarks/corpus/\`（工具 schema 全集 + 脱敏后的真实运行轨迹 + 活体快照）
- 任务集：\`benchmarks/tasks/intents.json\`
- 口径说明：\`benchmarks/README.md\`
`

  fs.writeFileSync(path.join(resultsDir, 'REPORT.md'), md)
  console.log(`wrote ${path.relative(process.cwd(), path.join(resultsDir, 'result.json'))}`)
  console.log(`wrote ${path.relative(process.cwd(), path.join(resultsDir, 'REPORT.md'))}`)
}

function checkAgainstBaseline(result) {
  const expectedPath = path.join(baselinesDir, 'expected.json')
  if (!exists(expectedPath)) {
    console.error(`no baseline file at ${expectedPath}`)
    process.exit(2)
  }
  const expected = readJson(expectedPath)
  const actual = flatten(result)
  const problems = []

  for (const [key, want] of Object.entries(expected.metrics)) {
    const got = actual[key]
    if (got === undefined) {
      problems.push(`${key}: 基准里没有这个指标`)
      continue
    }
    const tol = expected.tolerance?.[key] ?? 1e-9
    if (typeof want === 'number') {
      if (Math.abs(got - want) > tol) problems.push(`${key}: 期望 ${want}，实际 ${got}（容差 ${tol}）`)
    } else if (got !== want) {
      problems.push(`${key}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
    }
  }

  if (problems.length) {
    console.error(`\n✗ 与基线不符（${problems.length} 项）：`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\n如果是**有意**改动（算法/语料/任务集变了），请更新 benchmarks/baselines/expected.json 并在 CHANGELOG 里说明。')
    process.exit(1)
  }
  console.log(`✓ 与基线一致（${Object.keys(expected.metrics).length} 项指标）`)
}

function flatten(result) {
  const g = result.suites.schemaGating
  const a = result.suites.ablation
  const b = result.suites.baselines
  return {
    verdict: result.verdict,
    'gating.tools': g.corpus.tools,
    'gating.organs': g.corpus.organs,
    'gating.tasks': g.corpus.tasks,
    'gating.fullTokens': g.full.tokens,
    'gating.savedPctMean': g.saved.pct.mean,
    'gating.savedPctMedian': g.saved.pct.median,
    'gating.savedPctWorst': g.savedWorstCase.savedPct,
    'gating.savedTokensMean': g.saved.tokens.mean,
    'gating.correctnessMisses': g.correctness.misses.length,
    'ablation.healingClosed': a.healing.closedWithHealing,
    'ablation.autoReflexes': a.reflex.generatedWithReflex,
    'ablation.prunedAtOneHalfLife': a.forgetting.prunedWithForgettingAtOneHalfLife,
    'ablation.attributionAgreement': a.attribution.agreement,
    'baseline.naiveSavedPct': b.strategies[1].savedPctMean,
    'baseline.naiveMisses': b.strategies[1].misses,
    'baseline.agentBodySavedPct': b.strategies[2].savedPctMean,
    'baseline.agentBodyMisses': b.strategies[2].misses,
    'catalog.organs': result.suites.catalog.organCount ?? null,
    'catalog.defaultInstall': result.suites.catalog.defaultInstallCount ?? null,
    'live.kernelSavedPct': result.suites.liveSnapshot?.kernel?.savedPct ?? null,
    'live.recomputedVisibleTokens': result.suites.liveSnapshot?.recomputed?.visibleTokens ?? null,
    'live.verdict': result.suites.liveSnapshot?.verdict ?? null,
  }
}

// ── main ──
const result = run()

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(result.verdict === 'pass' ? 0 : 1)
}

// 写基线：把当前结果固化成 CI 的比对基准。
// 只在**有意**改动（算法/语料/任务集）之后手动跑，并在 CHANGELOG 里说明为什么变。
if (process.argv.includes('--write-baseline')) {
  fs.mkdirSync(baselinesDir, { recursive: true })
  const metrics = flatten(result)
  const baseline = {
    $comment:
      'CI 基线：benchmarks/run.mjs --check 会逐项比对这些指标。' +
      '改动算法/语料/任务集导致数字变化时，重跑 --write-baseline 并在 CHANGELOG 说明原因——' +
      '不要为了「让 CI 变绿」而直接覆盖它。',
    generatedAt: result.generatedAt,
    kernelSource: result.kernelSource,
    tolerance: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, typeof v === 'number' ? 1e-9 : 0])),
    metrics,
  }
  fs.writeFileSync(path.join(baselinesDir, 'expected.json'), JSON.stringify(baseline, null, 2) + '\n')
  console.log(`wrote baselines/expected.json (${Object.keys(metrics).length} metrics)`)
  process.exit(result.verdict === 'pass' ? 0 : 1)
}

writeOutputs(result)

if (result.verdict !== 'pass') {
  console.error('\n✗ 基准判定：FAIL —— 门控把任务需要的能力藏了起来')
  console.error(JSON.stringify(result.failureCases, null, 2))
  process.exit(1)
}

if (process.argv.includes('--check')) {
  checkAgainstBaseline(result)
}

console.log(
  `\n省下 tool-schema token：均值 ${(result.suites.schemaGating.saved.pct.mean * 100).toFixed(2)}%` +
    `（中位 ${(result.suites.schemaGating.saved.pct.median * 100).toFixed(2)}%，` +
    `最差 ${(result.suites.schemaGating.savedWorstCase.savedPct * 100).toFixed(2)}%）`,
)
