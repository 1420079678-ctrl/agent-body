/**
 * AgentTeams Pro — Deep Research Edition (dsh-agent-teams-pro).
 *
 * Merges two things:
 * - The proven `dsh-agent-teams` engine: captain/member/task-dependency/mailbox
 *   orchestration over durable continuable subagents, plus a live Web panel.
 * - ByteDance DeerFlow's deep-research protocol: specialist roles with explicit
 *   phase/success-criterion personas (coordinator/planner/researcher/searcher/
 *   synthesizer/reviewer/reporter/implementer), a stage-gated research pipeline
 *   (recon → plan → research → synthesize → review → report), and a
 *   `deerflow_plan` scaffold that turns a goal into a ready-to-create task DAG.
 *
 * The result is a super-agent harness: one natural language request ("用
 * AgentTeams Pro 深度研究一下 X") launches a DeerFlow-style specialist team
 * that researches, cross-checks, and writes a cited report.
 *
 * @module dsh-agent-teams-pro
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "agent-teams-pro";
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /**
     * State directory name under the captain's workspace; team state lives at
     * `<workspace>/<stateDir>/<teamId>/` (default `.agent-teams`).
     */
    stateDir?: string;
    /** `ctx.subagents` provider used to spawn members; must support continuable children and personas (default `spawn`). */
    memberProvider?: string;
    /** Optional model override applied to every member. */
    memberModel?: string;
    /** Member delegation depth cap (default `1`; `0` forbids delegation entirely). */
    memberMaxDepth?: number;
    /** Team size cap in members (default `8`). */
    maxMembers?: number;
    /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
    promptSectionOrder?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
