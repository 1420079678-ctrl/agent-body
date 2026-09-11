/**
 * DeerFlow-style deep-research role library for `dsh-agent-teams-pro`.
 *
 * Ported from ByteDance's DeerFlow (open-source super-agent harness): the lead
 * agent decomposes a goal into a stage-gated deep-research plan and spawns
 * specialist members. Each role carries a self-contained persona, a tool hint,
 * and an explicit success criterion, so members drive a deterministic workflow
 * (recon → plan → research fan-out → synthesize → review → report) instead of
 * ad-hoc cooperation.
 *
 * @module dsh-agent-teams-pro/roles
 */
/** The role's research phase within the Deep Research pipeline. */
export type DeerFlowPhase = 'recon' | 'plan' | 'research' | 'synthesize' | 'review' | 'report' | 'implement';
/** A DeerFlow deep-research role definition. */
export interface DeerFlowRole {
    /** Canonical role key, used as the member name / claim key (e.g. `planner`). */
    readonly key: string;
    /** Human label for display in the activity panel. */
    readonly label: string;
    /** Which phase of the deep-research pipeline this role owns. */
    readonly phase: DeerFlowPhase;
    /** The member persona (self-contained, replaces the generic worker persona). */
    readonly persona: string;
    /** One-line tool hint so the captain knows what to delegate. */
    readonly toolHint: string;
    /** Explicit success criterion; the member must satisfy it before reporting done. */
    readonly successCriterion: string;
    /** Expected deliverable shape. */
    readonly deliverable: string;
}
/** The full Deep Research role library, keyed by canonical role key. */
export declare const DEERFLOW_ROLES: Record<string, DeerFlowRole>;
/** The default deep-research team composition the captain should spawn. */
export declare const DEFAULT_DEEP_RESEARCH_CAST: readonly string[];
/** Resolve a role by key, or `undefined` when the key is not a DeerFlow role. */
export declare function resolveRole(key: string): DeerFlowRole | undefined;
/** Whether a role key is a recognized DeerFlow role. */
export declare function isDeerFlowRole(key: string): boolean;
/**
 * Build a member persona from a DeerFlow role, wrapping it with the shared
 * team rules. Used by `agent_teams_add_member` when the requested role is one
 * of the DeerFlow deep-research roles; generic roles keep the generic persona.
 */
export declare function deepResearchPersona(roleKey: string, teamName: string, memberName: string, stateDir: string): string;
