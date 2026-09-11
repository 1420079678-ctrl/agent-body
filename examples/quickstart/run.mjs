#!/usr/bin/env node
/**
 * 五分钟跑通 Agent-Body —— 零安装演示。
 *
 *   npm run demo          （或 node examples/quickstart/run.mjs）
 *
 * 这个脚本不连任何外部服务、不需要 DeepSeek Harness、不需要 API key，
 * 用仓库里真实的 256 项工具语料和真实的常量表跑一遍完整链路：
 *
 *   你的命令 → 神经冲动 → 支配器官 → 器官执行 → 失败归因 → 反射自动复查
 *
 * 跑完你会看到三个可验证的结论，以及它们各自的数字来源。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  buildAnatomy,
  createMemoryHost,
  evalCondition,
  innervate,
  measureGate,
  organClaims,
  schemaTokens,
  workingSet,
} from '../../packages/organ-core/src/index.mjs'
import { defineOrgan, defineReflex } from '../../packages/organ-sdk/src/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

function step(n, title) {
  console.log(`\n${C.bold(`── ${n}. ${title} `.padEnd(64, '─'))}`)
}

// ═══════════════ 0. 语料 ═══════════════

const corpusPath = path.join(repoRoot, 'benchmarks', 'corpus', 'tools.json')
if (!fs.existsSync(corpusPath)) {
  console.error(`找不到语料 ${corpusPath}\n先跑：npm run corpus`)
  process.exit(1)
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'))
const toolSchemas = corpus.tools
const toolNames = toolSchemas.map((t) => t.name)

console.log(C.bold('\nAgent-Body · 五分钟跑通\n'))
console.log(
  C.dim(
    `语料：${toolSchemas.length} 项能力定义，捕获自 ${corpus.provenance.capturedFrom}\n` +
      `（${corpus.provenance.captureMethod}）`,
  ),
)

// ═══════════════ 1. 器官解剖 ═══════════════

step(1, '把工具清单解析成器官')

const organs = buildAnatomy(toolNames)
const curated = organs.filter((o) => !o.id.startsWith('auto:'))
const autonomic = organs.filter((o) => o.id.startsWith('auto:'))

console.log(`策展器官 ${C.cyan(curated.length)} 个，自主器官 ${C.cyan(autonomic.length)} 个（未申报的插件自动升格）`)

// 注意用 organClaims 而不是 capabilities.includes：策展器官的能力**允许写成通配模式**
// （例如 `_dsh_external_dsh_browser_ultimate_*`），朴素的字符串包含会把它们全判成「无人认领」。
const unclaimed = toolNames.filter((t) => !organs.some((o) => organClaims(o, t)))
console.log(
  unclaimed.length === 0
    ? C.green(`✓ ${toolNames.length}/${toolNames.length} 项能力全部被某个器官认领，0 游离`)
    : C.red(`✗ ${unclaimed.length} 项无人认领：${unclaimed.slice(0, 5).join(', ')}`),
)

// ═══════════════ 2. 命令 → 冲动 → 支配 ═══════════════

const COMMAND = '帮我扫一下这个目标站的漏洞，顺便看看越权'
step(2, `你的命令变成神经冲动：「${COMMAND}」`)

const dispatch = innervate(COMMAND, curated)
console.log(`支配 ${C.cyan(dispatch.length)} 个器官：`)
for (const d of dispatch) {
  const o = organs.find((x) => x.id === d.organ)
  console.log(`  ${C.green('→')} ${(o?.label ?? d.organ).padEnd(24)} ${C.dim(`规则 #${d.ruleIndex ?? '-'}，计分 ${d.score ?? '-'}（每个命中关键词 +10）`)}`)
}
console.log(C.dim('  这一步是确定性的关键词路由——零模型调用，同一句话永远得到同一个结果。'))

// ═══════════════ 3. 按需显影：省了多少 token ═══════════════

step(3, '按需显影：这一轮只把用得上的能力放进提示词')

const fullTokens = toolSchemas.reduce((s, t) => s + schemaTokens(t), 0)
const ws = workingSet({ command: COMMAND, tools: toolNames, organs })
const visibleTokens = toolNames.filter((t) => ws.keep.has(t)).reduce(
  (s, n) => s + schemaTokens(toolSchemas.find((x) => x.name === n)),
  0,
)
const savedPct = ((fullTokens - visibleTokens) / fullTokens) * 100

console.log(`全量 tool schema　　${String(fullTokens).padStart(6)} token　（${toolNames.length} 项）`)
console.log(`这一轮实际显影　　${String(visibleTokens).padStart(6)} token　（${ws.keep.size} 项）`)
console.log(`${C.bold(`省下 ${C.green(savedPct.toFixed(1) + '%')}`)}　${C.dim('口径：只算 tool schema 块，不含系统提示/历史/工具结果')}`)
console.log(C.dim('其余能力没有消失——一次 body_call 就能取回。'))

// ═══════════════ 4. 器官真的干活 + 失败归因 ═══════════════

step(4, '让器官真的执行一次，并看它怎么处理失败')

const host = createMemoryHost({
  tools: {
    // 一个好心但会失败的器官工具：第一次报错，第二次成功
    sec_scan: (() => {
      let calls = 0
      return () => {
        calls += 1
        if (calls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:8080')
        return { hosts: 3, open: 1 }
      }
    })(),
    rev_journal: (args) => ({ recorded: true, ...args }),
  },
})

const scout = defineOrgan({
  id: 'demo_scout',
  label: '演示·侦察器官',
  tier: 'general',
  group: 'sensory',
  purpose: '演示：调一次外部扫描，失败就交给反射处理',
  capabilities: ['sec_scan'],
  permissions: ['net:http'],
  signals: ['tools/result'],
  handles: ['network'],
  fallback: ['innate_immunity'],
})

console.log(`声明器官：${C.cyan(scout.describe())}`)
console.log(C.dim(`  风险等级 ${scout.riskLevel}，需要确认：${scout.requiresConfirmation}`))

const first = await host.executeTool('sec_scan', {})
console.log(`\n第一次调用：${first.ok ? '成功' : C.red('失败')}　${C.dim(first.error?.message ?? '')}`)

// ═══════════════ 5. 反射自动复查（零模型调用） ═══════════════

step(5, '反射弧自动开火：同一处失败不靠「再想一遍」解决')

const refetch = defineReflex({
  id: 'R-demo-retry',
  name: '扫描失败 → 记录经验，交给下一次决策',
  triggerTool: 'sec_scan',
  condition: 'error&&hit:ECONNREFUSED',
  actionTool: 'rev_journal',
  actionArgs: { note: '${tool} 连接被拒：${error}' },
  cooldownMs: 1000,
})

const fired = evalCondition(refetch.condition, { isError: true, text: first.error.message, ms: 12 })
console.log(`条件 ${C.cyan(refetch.condition)} → ${fired ? C.green('命中，开火') : '不命中'}`)
if (fired) {
  const args = refetch.render({ tool: 'sec_scan', error: first.error.message, organ: scout.manifest.id, text: COMMAND })
  const r = await host.executeTool(refetch.actionTool, args)
  console.log(`  动作 ${refetch.actionTool}(${JSON.stringify(args).slice(0, 90)}…)`)
  console.log(`  ${r.ok ? C.green('✓ 已记录') : C.red('✗ 失败')}　${C.dim('全程零模型调用')}`)
}
console.log(C.dim('  确定性条件求值、无 eval；重入抑制 + 冷却 + 限额保证它不会变成死循环。'))

// ═══════════════ 6. 基准给自己打分 ═══════════════

step(6, '用基准给自己打分（不是我说的，是它算的）')

const gate = measureGate({
  toolSchemas,
  tasks: JSON.parse(fs.readFileSync(path.join(repoRoot, 'benchmarks', 'tasks', 'intents.json'), 'utf8')).tasks,
})
const p = (x) => `${(x * 100).toFixed(2)}%`
console.log(
  `${gate.corpus.tasks} 条代表性命令：省下的 token 均值 ${C.green(p(gate.saved.pct.mean))}，` +
    `中位 ${p(gate.saved.pct.median)}，最差 ${C.yellow(p(gate.saved.pct.min))}`,
)
console.log(
  `正确性护栏：缺陷 ${gate.expectation.totals.bug}（必须为 0）· 被截断 ${gate.expectation.totals.capped} · 未路由 ${gate.expectation.totals.unrouted}`,
)
console.log(C.dim('  被截断/未路由都能经 body_call 取回，但会多一跳——所以它们被单独计数，不混进「省了多少」。'))

console.log(`\n${C.bold('接下来看哪')}`)
console.log(`  ${C.cyan('benchmarks/results/REPORT.md')}　　${C.dim('完整的基准报告与缺口明细')}`)
console.log(`  ${C.cyan('catalog/organs.json')}　　　　　　${C.dim('25 个器官的分级与权限声明')}`)
console.log(`  ${C.cyan('npm run check')}　　　　　　　　　${C.dim('提交前总闸：常量表 + 目录 + 测试 + 基准')}`)
console.log('')
