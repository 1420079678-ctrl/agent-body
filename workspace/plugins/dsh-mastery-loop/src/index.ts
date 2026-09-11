/**
 * @dsh-external/dsh-mastery-loop — 精通闭环学习系统（Mastery Loop）
 *
 * 源自抖音「理科学习 Skill」方法论（识别考点→拆解条件→建立模型→选择方法→复盘错误），
 * 取其精华（思维模板化、系统节点观、反刷题堆量），去其糟粕（科目局限、孤立讲题、
 * 无记忆层），泛化创新为「任何科目」的掌握闭环：
 *
 *   orient 定位 → deconstruct 拆解 → model 建模 → diagnose 诊断
 *   → transfer 迁移 → review 复盘 → path 路径（间隔重复 × 知识图谱）
 *
 * 形态：toolkit（7 个模型侧工具）+ systemPrompt 方法论注入。
 * 规范：所有资源注册挂 ctx.effect（热重载/卸载自动清理）。
 *
 * @module @dsh-external/dsh-mastery-loop
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'

export const name = "@dsh-external/dsh-mastery-loop"
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** 是否启用首轮锚定（首轮只露核心工具，首个工具调用后恢复全部） */
  anchorFirstTurn: boolean
}

export const Config = z.object({
  anchorFirstTurn: z.boolean().default(true),
})

/** 本插件全部工具名（首轮锚定裁剪集合） */
const MINE = new Set([
  'study_orient', 'study_deconstruct', 'study_model', 'study_diagnose',
  'study_transfer', 'study_review', 'study_path',
])
/** 首轮保留的核心工具 */
const CORE = 'study_orient'

/** 系统提示：方法论总纲（注入每个会话） */
const METHOD_SECTION = `# 精通闭环学习系统（Mastery Loop）

面对学生的任何科目问题，你是「学科精通导师」，按闭环工作——先定位，再拆解，再建模，再诊断，再迁移，再复盘，最后排路径：

1. **定位 orient**：先建立知识地图（考点/权重/考核方式/先修依赖），不直接讲题。
2. **拆解 deconstruct**：把问题拆成 条件/结论/隐藏信息/可用模型，找到「入口信号」。
3. **建模 model**：把解法抽象成可复用思维模板卡片（入口/关键转折/易错点/识别信号/通用步骤/费曼一句），让题目变成可迁移的模板。
4. **诊断 diagnose**：错误先归因四类——知识性缺失/方法性错误/审题性偏差/执行性失误，再对症下药，不笼统说「不熟」。
5. **迁移 transfer**：出变式题检验迁移能力（换条件/换情境/提难度），多题一解归纳共性。
6. **复盘 review**：输出复盘模板 + 间隔重复排期（1/3/7/21 天），每道题成为知识图谱的一个节点。
7. **路径 path**：按目标规划学习路径，每个里程碑用自测题验证掌握度。

铁律：
- **不直接给答案**：先让学生暴露思考过程，再诊断纠正。
- **不堆刷题**：每道题必须提炼成模板，杜绝「记答案式」刷题。
- **可验证**：每个阶段结束用自测题检验，掌握 = 能独立做对 + 能讲清，而非「听懂了」。
- **科目无关**：数学/物理/编程/文科/医学/考证通用——把「题」理解为该科目的问题单元。`

export function apply(ctx: Context, config: Config): void {
  // ── 方法论注入系统提示 ────────────────────────────────────────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'mastery-loop:method',
    order: 90,
    text: METHOD_SECTION,
  }), 'mastery-loop: method section')

  // ── 工具集（每个工具 = 方法论强制器：规范化输入 + 结构化产出骨架）──────
  const tools = [
    defineTool({
      name: 'study_orient',
      description: '定位科目知识地图：考点/权重/考核方式/先修/自检题。开始学习或学新章节前必用。',
      parameters: {
        subject: { type: 'string', required: true, description: '科目名，如 高等数学/数据结构/刑法/生理学' },
        scope: { type: 'string', required: true, description: '学习范围：章节、考试大纲或教材目录' },
        goal: { type: 'string', description: '目标（可选）：如 期末90分 / 考研 / 转专业' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { subject: string; scope: string; goal?: string }) {
        return buildOrientPrompt(args)
      },
    }),
    defineTool({
      name: 'study_deconstruct',
      description: '拆解问题结构：条件/结论/隐藏信息/可用模型/入口信号。做题卡住或面对新题型时用。',
      parameters: {
        problem: { type: 'string', required: true, description: '题目原文或问题描述' },
        subject: { type: 'string', required: true, description: '所属科目' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { problem: string; subject: string }) {
        return buildDeconstructPrompt(args)
      },
    }),
    defineTool({
      name: 'study_model',
      description: '生成可复用思维模板卡片（入口/转折/易错/识别信号/通用步骤/费曼一句）。每道题都要提炼成模板。',
      parameters: {
        topic: { type: 'string', required: true, description: '知识点或题型名' },
        subject: { type: 'string', required: true, description: '所属科目' },
        source: { type: 'string', description: '来源题目（可选），便于模板附着具体例题' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { topic: string; subject: string; source?: string }) {
        return buildModelPrompt(args)
      },
    }),
    defineTool({
      name: 'study_diagnose',
      description: '错误归因诊断：知识缺失/方法错误/审题偏差/执行失误 + 根因 + 对症方案。错题必用。',
      parameters: {
        problem: { type: 'string', required: true, description: '题目原文' },
        myAnswer: { type: 'string', required: true, description: '学生的作答/思路（必须真实暴露）' },
        correctAnswer: { type: 'string', description: '正确答案或解析（可选，缺省由你推演）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { problem: string; myAnswer: string; correctAnswer?: string }) {
        return buildDiagnosePrompt(args)
      },
    }),
    defineTool({
      name: 'study_transfer',
      description: '生成变式题检验迁移（换条件/换情境/提难度）+ 多题一解归纳。掌握一个模板后必用。',
      parameters: {
        topic: { type: 'string', required: true, description: '要检验的知识点或模板名' },
        subject: { type: 'string', required: true, description: '所属科目' },
        count: { type: 'integer', description: '变式题数量，默认 3' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { topic: string; subject: string; count?: number }) {
        return buildTransferPrompt(args)
      },
    }),
    defineTool({
      name: 'study_review',
      description: '复盘 + 间隔重复排期（1/3/7/21 天）+ 主动回忆测试。学完一节/一批错题后必用。',
      parameters: {
        session: { type: 'string', required: true, description: '本次学了什么：章节、题目清单、易错点' },
        subject: { type: 'string', required: true, description: '所属科目' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { session: string; subject: string }) {
        return buildReviewPrompt(args)
      },
    }),
    defineTool({
      name: 'study_path',
      description: '学习路径规划：目标→阶段→每日任务→里程碑自测。备考/学新课前必用。',
      parameters: {
        subject: { type: 'string', required: true, description: '科目名' },
        goal: { type: 'string', required: true, description: '目标：如 两周掌握概率论 / 期末90 / 六级600' },
        deadline: { type: 'string', description: '截止时间（可选）' },
        hoursPerDay: { type: 'number', description: '每天可投入小时数，默认 2' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { subject: string; goal: string; deadline?: string; hoursPerDay?: number }) {
        return buildPathPrompt(args)
      },
    }),
  ]

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `mastery-loop: ${tool.name}`)
  }

  // ── 首轮锚定：首个工具调用前只露核心工具（省首轮 prefill）──────────────
  if (config.anchorFirstTurn) {
    ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
      const assembled = await next()
      const agent = context.agent
      if (!agent || agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call')) return assembled
      return { ...assembled, tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE) }
    })
  }

  ctx.logger?.info?.(`[${name}] mastery-loop active (${tools.length} tools, anchor=${config.anchorFirstTurn})`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// 方法论操作指令（工具返回给模型的工作骨架——保证闭环结构化执行）
// ═══════════════════════════════════════════════════════════════════════════════

function buildOrientPrompt(args: { subject: string; scope: string; goal?: string }): string {
  return `【定位阶段 · study_orient】学生要在「${args.subject}」范围内掌握：${args.scope}${args.goal ? `；目标：${args.goal}` : ''}
按以下结构输出知识地图（不要讲题）：
1. 考点清单：把范围拆成 5-12 个考点，按考核频率排序，标注权重（高/中/低）
2. 考核方式：每个考点通常怎么考（计算/证明/选择/论述/代码/案例）
3. 先修依赖：列出考点间的前置关系（谁要先学，用 A←B 表示 A 依赖 B）
4. 三个自检题：最能暴露「真懂还是假懂」的检测问题（先不给答案）
5. 学习顺序建议：按先修依赖排一条从零到掌握的顺序
要求：先修关系必须画成图（知识图谱节点观），自检题要能区分「背过」和「掌握」。`
}

function buildDeconstructPrompt(args: { problem: string; subject: string }): string {
  return `【拆解阶段 · study_deconstruct】科目「${args.subject}」，题目：
「${args.problem}」
按以下结构拆解（不要直接给完整解答）：
1. 条件清单：逐条列出已知条件（含隐藏条件——单位、约束、隐含假设）
2. 结论/目标：要求什么？判据是什么？
3. 可用模型：这题可能用到哪些已有模板/公式/方法（来自知识地图或模板库）
4. 入口信号：哪个条件是最关键的下手点？为什么？
5. 卡点定位：如果学生卡住，最可能卡在哪一步（提示学生先自己尝试）
要求：拆解要让学生看清「结构」，而不是记住这道题。`
}

function buildModelPrompt(args: { topic: string; subject: string; source?: string }): string {
  return `【建模阶段 · study_model】为「${args.subject}」的「${args.topic}」${args.source ? `（来源题：${args.source}）` : ''}生成思维模板卡片：
卡片结构：
- 模板名：一句话概括（如「导数零点问题→单调性+端点值」）
- 识别信号：看到什么词/条件/结构就想到这个模板（可并列 3-5 条）
- 入口：第一步做什么
- 关键转折：最容易卡住/决定成败的中间步骤
- 易错点：常见坑（符号/边界/漏条件/想当然）
- 通用步骤：3-6 步可复用流程
- 费曼一句：用一句大白话讲清本质（讲给完全不懂的人）
- 变式方向：这个模板还能套哪些变化
要求：模板必须「可迁移」——换一道同类题也能照着走；费曼一句必须口语化。`
}

function buildDiagnosePrompt(args: { problem: string; myAnswer: string; correctAnswer?: string }): string {
  return `【诊断阶段 · study_diagnose】题目：「${args.problem}」
学生作答：「${args.myAnswer}」
${args.correctAnswer ? `参考答案：「${args.correctAnswer}」` : ''}
按以下结构诊断（先归因，再对症，最后才给正确解法）：
1. 错误归因：从四类中判定主因——①知识性缺失（概念/公式没掌握）②方法性错误（思路方向错）③审题性偏差（看漏条件/理解错题意）④执行性失误（会但算错/写错）
2. 证据链：逐条指出学生作答里「哪个环节出了问题」对应上面的归因
3. 根因追问：向学生提 1-2 个追问问题，确认是「不知道」还是「知道但没想到」
4. 对症方案：按归因给出针对性训练（知识缺失→回炉知识点；方法错误→换模板；审题偏差→条件标注训练；执行失误→规范步骤+限时）
5. 正确解法：在诊断后给出完整解法
要求：归因必须落到四类之一（可并列），禁止笼统说「不熟」；先诊断后讲解。`
}

function buildTransferPrompt(args: { topic: string; subject: string; count?: number }): string {
  const n = Math.min(Math.max(args.count ?? 3, 1), 5)
  return `【迁移阶段 · study_transfer】检验「${args.subject}」的「${args.topic}」是否真掌握。生成 ${n} 道变式题：
1. 第 1 题：换条件（数值/场景变化，结构不变）——检验基础迁移
2. 第 2 题：换情境（换到另一个应用场景）——检验抽象理解
${n >= 3 ? `3. 第 3 题：提难度（加约束/多步组合）——检验深层掌握` : ''}
${n >= 4 ? `4. 第 4 题：跨章节/逆向题（反着问）——检验知识网络` : ''}
${n >= 5 ? `5. 第 5 题：易错陷阱题（专挑常见坑）——检验易错点防御` : ''}
每题附：①题目 ②参考答案 ③考核的模板/考点 ④如果做错，最可能的归因。
最后做「多题一解」归纳：这几题共同的解题骨架是什么？
要求：变式必须真的变（不能只是换数字），做完让学生独立作答再对答案。`
}

function buildReviewPrompt(args: { session: string; subject: string }): string {
  return `【复盘阶段 · study_review】科目「${args.subject}」，本次学习内容：${args.session}
输出复盘报告：
1. 复盘模板（高手四问）：这类题入口在哪？关键转折在哪？容易错在哪？下次怎么一眼识别？
2. 知识节点登记：把本次学到的东西登记为图谱节点（节点名 + 模板链接 + 易错点）
3. 掌握度自评：让学生自评 1-5，并给出 1 个验证问题（主动回忆，不看书作答）
4. 间隔重复排期：按 1/3/7/21 天排期表列出每个节点的复习日期和复习方式（回忆测试而非重看）
5. 下一步：根据本次表现，建议下一个 orient/deconstruct 的起点
要求：排期表要具体到「哪天复习哪个节点、用什么方式（做题/默写/讲给别人）」。`
}

function buildPathPrompt(args: { subject: string; goal: string; deadline?: string; hoursPerDay?: number }): string {
  const hours = args.hoursPerDay ?? 2
  return `【路径阶段 · study_path】科目「${args.subject}」，目标：${args.goal}${args.deadline ? `，截止：${args.deadline}` : ''}，每天可投入约 ${hours} 小时。
输出学习路径计划：
1. 目标拆解：把目标拆成可验证的子目标（每个子目标 = 能独立完成一类题/能讲清一个主题）
2. 阶段划分：3-5 个阶段，每阶段 1-2 周，按先修依赖排列（对应 orient 的知识地图）
3. 每日任务模板：每阶段给出「每天 2 小时」的具体任务模板（学新+练题+复盘+复习的配比）
4. 里程碑验证：每阶段结束时用「自测题」验证（给出 2-3 道自测题标准）
5. 风险预案：最可能放弃/卡住的点 + 应对策略
要求：计划必须具体到「今天做什么」，子目标必须可验证（不是「学会」，而是「能独立做对 X 类题」）。`
}
