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
/** The canonical deep-research pipeline stages, in execution order. */
export declare const DEEP_RESEARCH_STAGES: readonly [{
    readonly id: "recon";
    readonly label: "侦察 Recon";
    readonly phase: "recon";
    readonly role: "searcher";
    readonly desc: "界定范围、关键问题、权威来源、约束";
}, {
    readonly id: "plan";
    readonly label: "规划 Plan";
    readonly phase: "plan";
    readonly role: "planner";
    readonly desc: "把目标拆成带依赖的并行研究任务 DAG（含搜索词与成功判据）";
}, {
    readonly id: "research";
    readonly label: "研究 Research";
    readonly phase: "research";
    readonly role: "researcher";
    readonly desc: "逐任务搜索/抓取/提取证据，每条事实带来源 URL";
}, {
    readonly id: "synthesize";
    readonly label: "综合 Synthesize";
    readonly phase: "synthesize";
    readonly role: "synthesizer";
    readonly desc: "合并研究成果为连贯、去重、带引用的正文";
}, {
    readonly id: "review";
    readonly label: "审查 Review";
    readonly phase: "review";
    readonly role: "reviewer";
    readonly desc: "对抗式核验每条声明的证据与引用，拒绝无出处结论";
}, {
    readonly id: "report";
    readonly label: "报告 Report";
    readonly phase: "report";
    readonly role: "reporter";
    readonly desc: "落盘最终 Markdown 报告（摘要/正文/发现表/来源附录）";
}];
/** Group the pipeline into dependency layers (tasks in a layer may fan out). */
export declare const DEEP_RESEARCH_LAYERS: readonly [{
    readonly layer: 1;
    readonly stage: "recon";
    readonly deps: readonly [];
}, {
    readonly layer: 2;
    readonly stage: "plan";
    readonly deps: readonly ["recon"];
}, {
    readonly layer: 3;
    readonly stage: "research";
    readonly deps: readonly ["plan"];
}, {
    readonly layer: 4;
    readonly stage: "synthesize";
    readonly deps: readonly ["research"];
}, {
    readonly layer: 5;
    readonly stage: "review";
    readonly deps: readonly ["synthesize"];
}, {
    readonly layer: 6;
    readonly stage: "report";
    readonly deps: readonly ["review"];
}];
/** Register the two DeerFlow orchestration tools. */
export declare function registerDeepResearchTools(ctx: import('@deepseek-ai/cordis').Context): void;
