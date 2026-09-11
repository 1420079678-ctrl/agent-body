/**
 * @dsh-external/dsh-academic-research — 学术研究流水线（源自 Imbad0202/academic-research-skills v3.x，44.9K★）。
 * research → write → integrity → review → revise → re-review → finalize 全流程编排。
 * 架构：确定性规则引擎 + 状态持久化（JSONL）+ 评审/核查框架生成；内容判断由主代理执行。
 * 数据目录：<DSH_HOME>/plugins/dsh-academic-research/{flows,reviews}
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '@dsh-external/dsh-academic-research'
export const inject = ['tools']

const DATA_ROOT = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '.', '.dsh'), 'plugins', 'dsh-academic-research')
const FLOWS_DIR = path.join(DATA_ROOT, 'flows')
const REVIEWS_DIR = path.join(DATA_ROOT, 'reviews')

function ensureDirs() {
  mkdirSync(FLOWS_DIR, { recursive: true })
  mkdirSync(REVIEWS_DIR, { recursive: true })
}

function loadFlows(): any[] {
  ensureDirs()
  try {
    return readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(FLOWS_DIR, f), 'utf8'))
      } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

function loadFlow(id: string): any {
  const f = path.join(FLOWS_DIR, `${id}.jsonl`)
  if (!existsSync(f)) throw new Error(`flow 不存在: ${id}`)
  return JSON.parse(readFileSync(f, 'utf8'))
}

function saveFlow(flow: any) {
  ensureDirs()
  writeFileSync(path.join(FLOWS_DIR, `${flow.id}.jsonl`), JSON.stringify(flow, null, 2), 'utf8')
}

/** 管线 10 阶段定义（源自 academic-pipeline SKILL.md） */
const STAGES = [
  { id: 1, name: 'RESEARCH', skill: 'deep-research', deliverable: '研究简报 RQ Brief + 方法论 + 文献 + 综合', modes: ['socratic', 'full', 'quick'] },
  { id: 2, name: 'WRITE', skill: 'academic-paper', deliverable: '论文初稿', modes: ['plan', 'full'] },
  { id: 2.5, name: 'INTEGRITY', skill: 'integrity_verification_agent', deliverable: '完整性核查报告 + 修正稿', modes: ['pre-review'], mandatory: true },
  { id: 3, name: 'REVIEW', skill: 'academic-paper-reviewer', deliverable: '5 份评审 + 编辑决定 + 修改路线图', modes: ['full'], mandatory: true },
  { id: 4, name: 'REVISE', skill: 'academic-paper', deliverable: '修订稿 + 回复信', modes: ['revision'] },
  { id: "3'", name: 'RE-REVIEW', skill: 'academic-paper-reviewer', deliverable: '复核报告：修订核对表 + 遗留问题', modes: ['re-review'] },
  { id: "4'", name: 'RE-REVISE', skill: 'academic-paper', deliverable: '第二轮修订稿（如需）', modes: ['revision'] },
  { id: 4.5, name: 'FINAL INTEGRITY', skill: 'integrity_verification_agent', deliverable: '终核报告（必须 PASS）', modes: ['final-check'], mandatory: true },
  { id: 5, name: 'FINALIZE', skill: 'academic-paper', deliverable: '终稿（MD→DOCX→LaTeX→PDF）', modes: ['format-convert'] },
  { id: 6, name: 'PROCESS SUMMARY', skill: 'orchestrator', deliverable: '论文创作过程记录', modes: ['auto'], optional: true },
]

/** 阶段路由：根据用户材料检测入口（源自 Intake & Detection） */
function detectEntry(materials: string[]): number | string {
  const m = materials.map((x) => x.toLowerCase())
  if (m.some((x) => x.includes('review comment') || x.includes('审稿意见') || x.includes('reviewer feedback'))) return 4
  if (m.some((x) => x.includes('revised draft') || x.includes('修订稿'))) return "3'"
  if (m.some((x) => x.includes('paper draft') || x.includes('论文稿') || x.includes('manuscript'))) return 2.5
  if (m.some((x) => x.includes('research data') || x.includes('研究数据') || x.includes('实验数据'))) return 2
  if (m.some((x) => x.includes('final draft') || x.includes('终稿'))) return 5
  return 1
}

// ─────────────────────────── ars_pipeline：管线编排 ───────────────────────────

function stageName(s: number | string) {
  const st = STAGES.find((x) => String(x.id) === String(s))
  return st ? st.name : String(s)
}

function pipelineList() {
  const flows = loadFlows()
  return flows.map((f) => `◆ ${f.id} [${f.status}] ${f.title} → 当前 Stage ${f.current_stage}(${stageName(f.current_stage)}) · ${new Date(f.updated_at).toLocaleString()}`).join('\n') || '（暂无 flow）'
}

function pipelineInit(args: any): any {
  const { title, topic, materials = [] } = args
  const id = 'ARS-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase()
  const entry = detectEntry(materials)
  const flow = {
    id, title, topic, status: 'active',
    current_stage: entry, entry_stage: entry,
    materials, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    stages_done: [], integrity_rounds: 0, revision_loops: 0, history: [], notes: [],
  }
  saveFlow(flow)
  const entryStage = STAGES.find((x) => String(x.id) === String(entry))
  return {
    flow_id: id,
    entry_stage: `${entry} ${entryStage?.name}`,
    message: `已建立学术管线。从 Stage ${entry}(${entryStage?.name}) 开始：${entryStage?.deliverable}`,
    next: pipelineNext(id),
  }
}

function pipelineNext(id: string) {
  const flow = loadFlow(id)
  const st = STAGES.find((x) => String(x.id) === String(flow.current_stage))
  if (!st) throw new Error(`未知阶段: ${flow.current_stage}`)
  const nextStage = nextStageOf(flow)
  return {
    stage: `${flow.current_stage} ${st.name}`,
    skill: st.skill,
    modes: st.modes,
    deliverable: st.deliverable,
    mandatory_checkpoint: !!st.mandatory,
    what_to_do: `执行 ${st.skill}（${st.modes.join('/')} 模式）产出「${st.deliverable}」，完成后用 ars_pipeline update 回报`,
    next_stage: nextStage ? `${nextStage.id} ${nextStage.name}` : '（终态）',
  }
}

function nextStageOf(flow: any): any {
  const order: Array<number | string> = [1, 2, 2.5, 3, 4, "3'", "4'", 4.5, 5, 6]
  const idx = order.findIndex((x) => String(x) === String(flow.current_stage))
  if (idx < 0) return null
  // 修订循环控制：Stage 4' 之后不再推进到下一修订轮
  if (String(flow.current_stage) === "4'") return null
  return STAGES.find((x) => String(x.id) === String(order[idx + 1])) || null
}

function pipelineUpdate(args: any): any {
  const { id, status, result, stage } = args
  const flow = loadFlow(id)
  const doneStage = stage !== undefined ? stage : flow.current_stage
  flow.stages_done.push(String(doneStage))
  flow.history.push({ stage: doneStage, status, result, at: new Date().toISOString() })
  if (status === 'failed') {
    // 失败处理：integrity FAIL 循环（最多 3 轮）；其他阶段失败可重试
    if (String(doneStage) === '2.5' || String(doneStage) === '4.5') {
      flow.integrity_rounds = (flow.integrity_rounds || 0) + 1
      if (flow.integrity_rounds >= 3) {
        flow.notes.push(`Stage ${doneStage} 完整性核查 3 轮 FAIL：需用户决定（继续 / 标记为已知局限 / 放弃）`)
        flow.status = 'blocked'
      } else {
        flow.notes.push(`Stage ${doneStage} 完整性核查 FAIL（第 ${flow.integrity_rounds} 轮），修正后重验`)
        flow.updated_at = new Date().toISOString()
        saveFlow(flow)
        return { flow_id: id, stage: doneStage, status: 'failed', action: 'fix_and_reverify', message: '修正问题后重跑核查（最多 3 轮）' }
      }
    } else {
      flow.notes.push(`Stage ${doneStage} 失败：建议重试、暂停或切换模式`)
      flow.updated_at = new Date().toISOString()
      saveFlow(flow)
      return { flow_id: id, stage: doneStage, status: 'failed', action: 'retry_or_pause', message: '建议重试、暂停或切换模式' }
    }
  } else if (status === 'done') {
    // 评审决定分支：Stage 3/3' 的 Accept/Minor/Major/Reject
    if (doneStage === 3 || doneStage === "3'") {
      const decision = (result || '').toLowerCase()
      if (decision.includes('reject')) {
        flow.notes.push('评审结论 Reject：提供选项（大改回 Stage 2 / 放弃）')
        flow.status = 'blocked'
      } else if (decision.includes('major')) {
        flow.notes.push(`评审 Major：进入修订${doneStage === 3 ? '（Stage 4）' : "（Stage 4'）"}`)
        flow.current_stage = doneStage === 3 ? 4 : "4'"
      } else {
        flow.notes.push('评审 Accept/Minor：进入最终完整性核查 Stage 4.5')
        flow.current_stage = 4.5
      }
    } else {
      const ns = nextStageOf(flow)
      if (ns) { flow.current_stage = ns.id } else { flow.status = 'completed' }
    }
  } else if (status === 'skipped') {
    const ns = nextStageOf(flow)
    if (ns) { flow.current_stage = ns.id } else { flow.status = 'completed' }
  }
  flow.updated_at = new Date().toISOString()
  saveFlow(flow)
  const st = STAGES.find((x) => String(x.id) === String(flow.current_stage))
  return {
    flow_id: id,
    status: flow.status,
    current_stage: `${flow.current_stage} ${st ? st.name : ''}`,
    stages_done: flow.stages_done,
    checkpoint: st?.mandatory ? 'MANDATORY — 需用户明确确认' : 'FULL — 展示进展并确认',
    message: flow.status === 'completed' ? '🎉 管线完成' : `下一阶段: Stage ${flow.current_stage} ${st ? st.name : ''}`,
  }
}

function pipelineStatus(id: string) {
  const flow = loadFlow(id)
  const st = STAGES.find((x) => String(x.id) === String(flow.current_stage))
  const lines = [
    `【${flow.id}】${flow.title}（主题：${flow.topic}）`,
    `状态: ${flow.status} | 入口 Stage ${flow.entry_stage} | 当前 Stage ${flow.current_stage}(${st?.name})`,
    `已完阶段: ${flow.stages_done.join(' → ') || '（无）'}`,
    `修订循环: ${flow.revision_loops}/2 | 完整性核查轮次: ${flow.integrity_rounds || 0}/3`,
    '',
    '进度看板:',
  ]
  STAGES.forEach((s) => {
    const done = flow.stages_done.includes(String(s.id))
    const cur = String(s.id) === String(flow.current_stage)
    lines.push(`  ${done ? '✅' : cur ? '▶️' : '⬜'} Stage ${s.id} ${s.name}${s.mandatory ? ' [MANDATORY]' : ''}${s.optional ? ' [可选]' : ''}`)
  })
  if (flow.notes.length) {
    lines.push('', '备注:')
    flow.notes.forEach((n: string) => lines.push(`  ⚠️ ${n}`))
  }
  return lines.join('\n')
}

// ─────────────────────────── ars_review：论文评审面板 ───────────────────────────

function reviewPanel(args: any): any {
  const { paper, field = 'auto', mode = 'full' } = args
  const detected = field === 'auto' ? '自动识别（主代理判断论文所属学科）' : field
  const seats = [
    { id: 'EIC', name: 'Journal-Fit Reviewer', focus: '期刊契合度、原创性、整体质量、目标读者相关性', checks: ['是否适合目标期刊/会议', '原创性与增量贡献', '研究重要性', '与读者群的相关性'] },
    { id: 'R1', name: 'Methodology Reviewer', focus: '研究设计、统计有效性、可复现性', checks: ['研究设计严谨性', '抽样策略与数据收集', '分析方法选择与统计效度', '效应量与置信区间', '可复现性与数据透明度'] },
    { id: 'R2', name: 'Domain Reviewer', focus: '文献覆盖、理论框架、领域贡献', checks: ['文献综述完整性', '理论框架适切性', '学术论证准确性', '领域增量贡献', '关键参考文献缺失'] },
    { id: 'R3', name: 'Perspective Reviewer', focus: '跨学科联系、实际影响、挑战基本假设', checks: ['跨学科联系与借鉴', '实际应用与政策含义', '更广泛的社会/伦理影响', '对基本假设的挑战'] },
    { id: 'DA', name: 'Devil\'s Advocate', focus: '核心论证挑战、逻辑谬误、最强反方论点', checks: ['核心论证的最强反方论点', '选择性证据（cherry-picking）', '确认偏误', '逻辑链验证', '过度概括', '替代路径分析', '利益相关者盲区', '"So what?" 测试'] },
  ]
  const lines = [
    `【学术论文评审面板 · 5 席位】领域: ${detected} | 模式: ${mode === 'full' ? '完整评审' : mode}`,
    '',
    '评审流程（源自 academic-paper-reviewer v1.11）:',
    '  Phase 0: 分析论文领域 → 配置 4 张评审卡（用户可调整）',
    '  Phase 1: 5 席位并行独立评审（不互相参考，角色分离）',
    '  Phase 2: 编辑综合 → 共识/分歧识别 → 编辑决定信 + 修改路线图',
    '',
    '5 席位角色卡:',
  ]
  seats.forEach((s) => {
    lines.push(`  ── ${s.id} ${s.name}`)
    lines.push(`     关注: ${s.focus}`)
    lines.push(`     核查项: ${s.checks.join(' / ')}`)
  })
  lines.push('', '输出约定:')
  lines.push('  · 5 份独立评审报告（每份含 Major/Minor/Question 问题编号）')
  lines.push('  · Devil\'s Advocate 的 CRITICAL 问题必须在编辑决定中逐条裁决')
  lines.push('  · 编辑决定: Accept / Minor Revision / Major Revision / Reject')
  lines.push('  · 修改路线图（不可变核心）+ 作者裁定 sidecar')
  lines.push('  · ⚠️ 评审只读：不修改投稿稿，全部输出为独立文档')
  if (paper) lines.push('', `待评论文: ${String(paper).slice(0, 200)}${String(paper).length > 200 ? '…' : ''}`)
  return lines.join('\n')
}

// ─────────────────────────── ars_paper_plan：论文写作框架 ───────────────────────────

function paperPlan(args: any): any {
  const { topic, type = 'research', citation = 'APA7', lang = 'zh' } = args
  const lines = [
    `【论文写作计划 · 8 阶段】主题: ${topic} | 类型: ${type} | 引用: ${citation}`,
    '',
    'Phase 0 CONFIG — 配置访谈（intake_agent）: 目标期刊/会议、篇幅、结构偏好、读者',
    '  ⚠️ 铁律: 用户必须先确认 Paper Configuration Record 才能进入 Phase 1',
    'Phase 1 RESEARCH — 文献策略（literature_strategist）: 检索策略 + 来源语料',
    'Phase 2 ARCHITECTURE — 结构设计（structure_architect）: 大纲 + 证据地图',
    '  ⚠️ 用户必须批准大纲（可要求重构）',
    'Phase 3 ARGUMENTATION — 论证构建（argument_builder）: 论证蓝图（CER 链）',
    'Phase 4 DRAFTING — 写作（draft_writer）: 完整草稿（生成器-评估器分离）',
    'Phase 5a CITATIONS — 引用合规（citation_compliance）: 引用审计报告',
    'Phase 5b ABSTRACT — 双语摘要（abstract_bilingual）: 摘要 + 关键词（与 5a 并行）',
    'Phase 6 PEER REVIEW — 内部评审（peer_reviewer）: 评审报告（最多 2 轮修订）',
    'Phase 7 FORMAT — 格式化（formatter）: 最终输出包',
    '',
    '输出格式:',
    `  文本: ${lang === 'zh' ? '中文（学术术语保留英文）' : 'English'} | 引用: ${citation} | 图表: 独立可复用`,
    '',
    '铁律（源自 academic-paper Anti-Patterns）:',
    '  · 最多 2 轮修订循环；未解决项 → "Acknowledged Limitations"',
    '  · 内部评审 Critical 问题阻塞进入 Phase 7',
    '  · 用户可跳过 Phase 1（自带文献时）',
    '  · 不伪造数据/结果/方法；引用必须有真实来源',
  ]
  return lines.join('\n')
}

// ─────────────────────────── ars_integrity：完整性核查 ───────────────────────────

function integrityCheck(args: any): any {
  const { paper, mode = 'pre-review' } = args
  const phases = [
    { id: 'A', name: 'REFERENCES 参考文献核查', checks: ['每条引文在参考文献列表中有对应条目', '参考文献条目格式正确（作者/年份/标题/出处）', '引用与来源一致（无幻觉引用）'] },
    { id: 'B', name: 'CITATION CONTEXT 引用上下文核查', checks: ['引用位置与论点匹配（claim ↔ source 对齐）', '二手引用（"cited in"）已标注', '引文未断章取义'] },
    { id: 'C', name: 'STATISTICAL DATA 统计数据核查', checks: ['统计数字与图表一致', '效应量/置信区间/样本量报告完整', 'p 值未过度解读', '数据来源可追溯'] },
    { id: 'D', name: 'ORIGINALITY 原创性核查', checks: ['与已发表工作区分度', '自我抄袭（重复使用自己已发表内容）', 'AI 文本特征（可读性/模板化）'] },
    { id: 'E', name: 'CLAIMS 声明核查', checks: ['每条结论有对应证据', '声明强度与证据匹配（不过度断言）', '因果与相关区分'] },
  ]
  const failureModes = [
    { id: 1, name: 'Citation Hallucination 引用幻觉', desc: '虚构不存在的文献/引用', signal: 'SUSPECTED → BLOCK' },
    { id: 2, name: 'Implementation Bug 实现缺陷', desc: '分析代码/脚本存在 bug 导致结果错误', signal: 'SUSPECTED → BLOCK' },
    { id: 3, name: 'Hallucinated Results 结果幻觉', desc: '编造实验/模拟/分析结果', signal: 'SUSPECTED → BLOCK' },
    { id: 4, name: 'Shortcut Reliance 捷径依赖', desc: '用简化替代品充数（近似值代替完整计算）', signal: 'SUSPECTED → 提示' },
    { id: 5, name: 'Bug-as-Insight 把 bug 当洞见', desc: '把实现错误解释为科学发现', signal: 'SUSPECTED → BLOCK' },
    { id: 6, name: 'Methodology Fabrication 方法论虚构', desc: '编造实验方法/数据收集流程', signal: 'SUSPECTED → BLOCK' },
    { id: 7, name: 'Pipeline Frame-Lock 框架锁定', desc: '固定思维模式导致系统性偏差', signal: 'SUSPECTED → 提示' },
  ]
  const lines = [
    `【学术完整性核查 · ${mode === 'pre-review' ? '评审前（Stage 2.5）' : '终核（Stage 4.5）'}】`,
    '',
    '5 阶段核查协议:',
  ]
  phases.forEach((p) => {
    lines.push(`  Phase ${p.id} ${p.name}`)
    p.checks.forEach((c) => lines.push(`    □ ${c}`))
  })
  lines.push('', 'AI 研究失败模式清单（7 模式，SUSPECTED 即阻塞，需用户确认才放行）:')
  failureModes.forEach((f) => lines.push(`  [${f.id}] ${f.name} — ${f.desc} [${f.signal}]`))
  lines.push('', '⚠️ 铁律:')
  lines.push('  · Stage 4.5 必须从零开始全新核查（不依赖 Stage 2.5 结论）')
  lines.push('  · 未验证项绝不静默丢弃：记录未知状态/分母/样本')
  lines.push('  · 3 轮 FAIL 后：列出不可验证项，用户决定（继续/已知局限/放弃）')
  lines.push('  · 输出: 核查报告 + 修正稿（如发现问题）')
  if (paper) lines.push('', `待核查论文: ${String(paper).slice(0, 200)}${String(paper).length > 200 ? '…' : ''}`)
  return lines.join('\n')
}

// ─────────────────────────── ars_metrics：学术指标 ───────────────────────────

function paperMetrics(args: any): any {
  const { text, min_refs = 10 } = args
  const t = String(text || '')
  const words = t.split(/\s+/).filter(Boolean).length
  const refs = (t.match(/^\[?\d+\]?\s+[A-Z]/gm) || []).length
  const sections = (t.match(/^#{1,3}\s+.+$/gm) || []).length
  const citations = (t.match(/\[\d+(?:[-,]\d+)*\]/g) || []).length
  const figures = (t.match(/!\[.*?\]\(/g) || []).length
  const tables = (t.match(/^\|.*\|$/gm) || []).length
  const target = words >= 3000 ? 3000 : 1000
  return {
    word_count: words, target, ratio: Math.round((words / target) * 100) + '%',
    references: refs, min_refs,
    ref_status: refs >= min_refs ? 'OK' : `LOW (min ${min_refs})`,
    sections, citations, figures, tables,
    verdict: words >= target * 0.9 && refs >= min_refs ? '达标' : '未达标（补字数/参考文献）',
  }
}

// ─────────────────────────── apply ───────────────────────────

export function apply(ctx: Context): void {
  const T = (name: string, description: string, parameters: any, execute: (a: any) => Promise<any> | any) =>
    ctx.effect(() => ctx.tools.register(defineTool({
      name, description, parameters,
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
      async execute(a: any): Promise<string> {
        const r = await execute(a)
        return typeof r === 'string' ? r : JSON.stringify(r, null, 2)
      },
    })), `dsh-academic-research: ${name}`)

  // ── 1. ars_pipeline — 管线编排状态机 ──
  T('ars_pipeline', '学术研究管线编排（源自 academic-research-skills）：10 阶段 research→write→integrity→review→revise→re-review→finalize。action=list 列出全部 flow；action=init 立项（title/topic/materials 自动检测入口阶段）；action=next 取当前阶段任务（角色/工具/交付物/下一阶段）；action=update 回报阶段结果（done 自动推进、failed 触发重试/完整性 3 轮 FAIL 阻塞、评审 Accept/Minor/Major/Reject 分支路由）；action=status 看板。铁律：完整性核查（Stage 2.5/4.5）MANDATORY 不可跳过；修订最多 2 轮；每阶段完成需用户确认。',
    {
      action: { type: 'string', required: true, description: 'list | init | next | update | status' },
      id: { type: 'string', description: 'flow id（next/update/status 用）' },
      title: { type: 'string', description: 'init 用：论文标题' },
      topic: { type: 'string', description: 'init 用：研究主题' },
      materials: { type: 'array', description: 'init 用：已有材料（空=从研究开始；paper draft=从完整性核查；review comment=从修订；final draft=从格式化）' },
      status: { type: 'string', description: 'update 用：done | failed | skipped' },
      result: { type: 'string', description: 'update 用：真实结果摘要（评审阶段含 Accept/Minor/Major/Reject 关键词）' },
      stage: { type: 'number', description: 'update 用：完成的阶段号（缺省当前阶段）' },
    },
    (a) => {
      switch (a.action) {
        case 'list': return pipelineList()
        case 'init': return pipelineInit(a)
        case 'next': return pipelineNext(a.id)
        case 'update': return pipelineUpdate(a)
        case 'status': return pipelineStatus(a.id)
        default: throw new Error('未知 action: ' + a.action)
      }
    })

  // ── 2. ars_review — 论文评审面板 ──
  T('ars_review', '学术论文多视角评审面板（源自 academic-paper-reviewer）：5 席位角色分离评审（Journal-Fit + 方法学 + 领域 + 跨学科视角 + Devil\'s Advocate），生成评审卡/核查项/输出约定。主代理按面板执行：Phase 0 领域分析配置评审卡 → Phase 1 五席位独立评审 → Phase 2 编辑综合（共识/分歧 + 编辑决定 + 修改路线图）。铁律：评审只读不改稿；Devil\'s Advocate CRITICAL 问题必须逐条裁决；不虚构评审意见。',
    {
      paper: { type: 'string', description: '论文内容/路径（可选，用于上下文）' },
      field: { type: 'string', description: '学科领域（缺省 auto 自动识别）' },
      mode: { type: 'string', description: 'full（完整 5 席评审，默认）| re-review（复核）' },
    },
    (a) => reviewPanel(a))

  // ── 3. ars_paper_plan — 论文写作框架 ──
  T('ars_paper_plan', '学术论文写作计划框架（源自 academic-paper）：8 阶段流程（配置→文献→结构→论证→草稿→引用/摘要并行→内部评审→格式化）+ 铁律（最多 2 轮修订、配置记录需确认、Critical 阻塞）。主代理按框架逐步执行并产出对应文档。',
    {
      topic: { type: 'string', required: true, description: '论文主题' },
      type: { type: 'string', description: 'research（默认）| review | case' },
      citation: { type: 'string', description: '引用格式，默认 APA7' },
      lang: { type: 'string', description: 'zh（默认）| en' },
    },
    (a) => paperPlan(a))

  // ── 4. ars_integrity — 完整性核查 ──
  T('ars_integrity', '学术完整性核查协议（源自 integrity_verification_agent）：5 阶段核查（参考文献/引用上下文/统计数据/原创性/声明）+ 7 模式 AI 研究失败清单（SUSPECTED 即阻塞，需用户确认）。Stage 4.5 终核必须从零全新核查。输出核查报告 + 修正建议。',
    {
      paper: { type: 'string', description: '论文内容/路径' },
      mode: { type: 'string', description: 'pre-review（Stage 2.5，默认）| final-check（Stage 4.5）' },
    },
    (a) => integrityCheck(a))

  // ── 5. ars_metrics — 学术指标 ──
  T('ars_metrics', '论文指标统计：字数/目标达成率、参考文献数、章节数、引用数、图表数，判定是否达标。确定性计算，零模型调用。',
    {
      text: { type: 'string', required: true, description: '论文文本（Markdown）' },
      min_refs: { type: 'number', description: '最低参考文献数（默认 10）' },
    },
    (a) => paperMetrics(a))
}
