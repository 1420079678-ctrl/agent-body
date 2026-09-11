/**
 * DeerFlow deep-research orchestration tools for `dsh-agent-teams-pro`.
 *
 * These tools give the captain a deterministic deep-research scaffold:
 * - `deerflow_plan` — one call produces a stage-gated research plan (recon →
 *   plan → research → synthesize → review → report) as ready-to-create tasks
 *   with dependencies, success criteria, and the recommended DeerFlow cast.
 * - `deerflow_members` — the recommended DeerFlow member roster for a goal.
 *
 * They are thin and deterministic: they return structured guidance the captain
 * acts on with the existing `agent_teams_*` tools (create task / add member /
 * claim / update / send), and they embed the explicit success criteria from
 * {@link roles.ts} so the team never drifts into ad-hoc cooperation.
 *
 * @module dsh-agent-teams-pro/deep-research
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_DEEP_RESEARCH_CAST, DEERFLOW_ROLES } from "./roles.js";
/** The canonical deep-research pipeline stages, in execution order. */
export const DEEP_RESEARCH_STAGES = [
    { id: 'recon', label: '侦察 Recon', phase: 'recon', role: 'searcher', desc: '界定范围、关键问题、权威来源、约束' },
    { id: 'plan', label: '规划 Plan', phase: 'plan', role: 'planner', desc: '把目标拆成带依赖的并行研究任务 DAG（含搜索词与成功判据）' },
    { id: 'research', label: '研究 Research', phase: 'research', role: 'researcher', desc: '逐任务搜索/抓取/提取证据，每条事实带来源 URL' },
    { id: 'synthesize', label: '综合 Synthesize', phase: 'synthesize', role: 'synthesizer', desc: '合并研究成果为连贯、去重、带引用的正文' },
    { id: 'review', label: '审查 Review', phase: 'review', role: 'reviewer', desc: '对抗式核验每条声明的证据与引用，拒绝无出处结论' },
    { id: 'report', label: '报告 Report', phase: 'report', role: 'reporter', desc: '落盘最终 Markdown 报告（摘要/正文/发现表/来源附录）' },
];
/** Group the pipeline into dependency layers (tasks in a layer may fan out). */
export const DEEP_RESEARCH_LAYERS = [
    { layer: 1, stage: 'recon', deps: [] },
    { layer: 2, stage: 'plan', deps: ['recon'] },
    { layer: 3, stage: 'research', deps: ['plan'] },
    { layer: 4, stage: 'synthesize', deps: ['research'] },
    { layer: 5, stage: 'review', deps: ['synthesize'] },
    { layer: 6, stage: 'report', deps: ['review'] },
];
/** Render the plan as compact text for the model after a successful call. */
function renderPlan(value) {
    const lines = [
        `Deep-research plan for: ${value.goal}`,
        `Recommended cast: ${value.cast.join(', ')}`,
        `Pipeline tasks (dependencies in parens):`,
    ];
    for (const task of value.tasks) {
        const dep = task.deps.length > 0 ? ` (deps: ${task.deps.join(',')})` : '';
        lines.push(`  - ${task.id} [${task.role}] ${task.subject}${dep}`);
        lines.push(`      success: ${task.success}`);
    }
    return lines.join('\n');
}
/** Register the two DeerFlow orchestration tools. */
export function registerDeepResearchTools(ctx) {
    ctx.tools.register(defineTool({
        name: 'deerflow_plan',
        description: 'Generate a stage-gated Deep Research plan for a goal (recon → plan → research → synthesize → review → report) as ready-to-create tasks with dependencies. Returns the recommended DeerFlow member cast and one task per pipeline stage, each with an explicit success criterion. Use this to bootstrap a deep-research team: it tells you exactly which members to add and which tasks to create.',
        parameters: {
            goal: { type: 'string', required: true, description: 'The research goal / user question to answer.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    goal: { type: 'string', required: true },
                    cast: { type: 'array', items: { type: 'string' }, required: true },
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                subject: { type: 'string', required: true },
                                role: { type: 'string', required: true },
                                deps: { type: 'array', items: { type: 'string' }, required: true },
                                success: { type: 'string', required: true },
                            },
                        },
                        required: true,
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderPlan(value) }],
        },
        async execute(args) {
            const goal = args.goal.trim();
            const cast = [...DEFAULT_DEEP_RESEARCH_CAST];
            const tasks = DEEP_RESEARCH_STAGES.map((stage, index) => {
                const role = DEERFLOW_ROLES[stage.role];
                const deps = DEEP_RESEARCH_LAYERS[index]?.deps ?? [];
                // Research fans out into per-subtopic tasks at layer 3; the captain
                // duplicates `research` for each sub-question when the goal splits.
                return {
                    id: stage.id,
                    subject: `${stage.label}: ${goal.slice(0, 80)}`,
                    role: stage.role,
                    deps: [...deps],
                    success: role?.successCriterion ?? '阶段成功判据未定义',
                };
            });
            return { goal, cast, tasks };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'deerflow_members',
        description: 'Return the recommended DeerFlow deep-research member roster for a goal, each with label, phase, tool hint, and success criterion. Use this to know which specialist members to add (agent_teams_add_member) and what to delegate to each. Pass specific=true for the full per-role detail (persona is applied automatically on add_member).',
        parameters: {
            specific: { type: 'boolean', description: 'Return full per-role detail (default false).' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: renderMembers(value) }],
        },
        async execute(args) {
            const cast = DEFAULT_DEEP_RESEARCH_CAST;
            const roster = cast.map((key) => {
                const role = DEERFLOW_ROLES[key];
                if (role === undefined)
                    return { key, label: key, phase: '', toolHint: '', success: '' };
                return {
                    key: role.key,
                    label: role.label,
                    phase: role.phase,
                    toolHint: role.toolHint,
                    success: args.specific === true ? role.successCriterion : role.successCriterion.slice(0, 60),
                };
            });
            return { count: roster.length, roster };
        },
    }));
}
/** Render the member roster as compact text. */
function renderMembers(value) {
    const roster = value.roster ?? [];
    const lines = [`Recommended Deep Research cast (${roster.length}):`];
    for (const member of roster) {
        lines.push(`  - ${member.key} (${member.label}) — ${member.phase}`);
        lines.push(`      tool: ${member.toolHint}`);
        lines.push(`      success: ${member.success}`);
    }
    return lines.join('\n');
}
