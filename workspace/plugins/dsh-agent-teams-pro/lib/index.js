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
import z from '@deepseek-ai/schemastery';
import { registerAgentTeamsTools } from "./tools.js";
import { registerDeepResearchTools } from "./deep-research.js";
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchivedTeamsActivity, collectTeamsActivity } from "./snapshot.js";
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'];
export const name = 'agent-teams-pro';
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents'];
export const Config = z.object({
    stateDir: z.string().default('.agent-teams'),
    memberProvider: z.string().default('spawn'),
    memberModel: z.string(),
    memberMaxDepth: z.natural().default(1),
    maxMembers: z.natural().min(1).default(8),
    promptSectionOrder: z.natural().default(117),
});
/**
 * The model-facing usage policy: when and how to drive AgentTeams Pro as a
 * DeerFlow-style deep-research harness. Extends the base AgentTeams protocol
 * with the specialist roles, the stage-gated pipeline, and the `deerflow_plan`
 * scaffold, and requires evidence-backed, cited work from every member.
 */
function usageSectionText(toolNames) {
    return `When the user asks to run a deep research, multi-source investigation, or a complex multi-step task with AgentTeams (e.g. "用 AgentTeams 深度研究一下 X"), you are the captain of a DeerFlow-style deep-research team. You orchestrate a pipeline of specialist members, each with an explicit phase and success criterion.

DeerFlow deep-research protocol (the team's spine):
1. Start with deerflow_plan giving the goal; it returns the recommended cast (searcher, planner, researcher, synthesizer, reviewer, reporter) and a stage-gated task DAG (recon → plan → research → synthesize → review → report), each stage with an explicit success criterion. Use agent_teams_create to become captain.
2. Add members with agent_teams_add_member using the DeerFlow role names (searcher, planner, researcher, synthesizer, reviewer, reporter, implementer, coordinator) — the plugin gives each role its deep-research persona automatically. Add extra researcher members when the goal splits into parallel sub-questions.
3. Create tasks with agent_teams_create_task, wiring dependencies along the pipeline: recon → plan → research (may fan out) → synthesize → review → report. Assign each task to its role member.
4. Dispatch: agent_teams_claim_task (with assignee) then wake each member with agent_teams_send_message naming its task id and instructions. One task per message.
5. Poll agent_teams_status until members are idle. Relay member-to-member messages (from=<sender>). Every member must satisfy its success criterion and cite sources; the reviewer is responsible for rejecting uncited output. Collect completed tasks' outputs; if a member reports a blocker, reassign or adjust the plan.
6. Present the synthesized, cited result to the user, then agent_teams_delete unless the user wants to keep working with the team.

Members are evidence-driven: every factual claim in the final deliverable must carry a verifiable source URL or a reproducible command. Never present unsourced or fabricated material as a finding. Shallow or uncited work is a failed task even if the summary is long.

Tools: ${toolNames}`;
}
export function apply(ctx, config) {
    const resolved = {
        stateDir: config.stateDir ?? '.agent-teams',
        memberProvider: config.memberProvider ?? 'spawn',
        memberModel: config.memberModel,
        memberMaxDepth: config.memberMaxDepth ?? 1,
        maxMembers: config.maxMembers ?? 8,
    };
    // Provider registration is a sibling plugin's effect (`subagent-spawn` /
    // `subagent-fork` rows), which can land after this mount under the Loader's
    // concurrent activation — so capability validation happens at the first
    // member spawn (`spawnMember`), the earliest point the provider list is
    // settled, rather than here.
    const toolNames = [
        'agent_teams_create',
        'agent_teams_add_member',
        'agent_teams_remove_member',
        'agent_teams_create_task',
        'agent_teams_claim_task',
        'agent_teams_update_task',
        'agent_teams_send_message',
        'agent_teams_status',
        'agent_teams_delete',
        'deerflow_plan',
        'deerflow_members',
    ].join(', ');
    ctx.systemPrompt.section({
        name: 'agent-teams-pro:usage',
        order: config.promptSectionOrder ?? 117,
        text: usageSectionText(toolNames),
    });
    registerAgentTeamsTools(ctx, resolved);
    registerDeepResearchTools(ctx);
    // The activity panel data/artwork routes need the Web server and the
    // workspace registry, which headless profiles do not mount; under
    // concurrent activation they may also bind after this plugin. Register the
    // routes lazily: try now, then on each service binding event. In a webless
    // profile the plugin stays tool-only and never blocks boot.
    let webRegistered = false;
    const registerWebSurface = () => {
        if (webRegistered)
            return;
        const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]));
        const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1]));
        if (webServer === undefined || workspaceRegistry === undefined)
            return;
        webRegistered = true;
        // Activity panel data route: the browser floater polls this for team
        // snapshots (disk truth + live subagent activity). Mirrors the Claude
        // Code desktop watcher's server-side snapshot pattern.
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-agent-teams/state',
            handler: async (req, res) => {
                const url = new URL(req.url ?? '/', 'http://x');
                const roots = workspaceRegistry.list().map((workspace) => ({
                    workspace: workspace.title,
                    stateRoot: join(workspace.path, resolved.stateDir),
                }));
                // ?archived=1 serves teams moved to archive/ (post-delete review).
                const snapshots = url.searchParams.get('archived') === '1'
                    ? await collectArchivedTeamsActivity(ctx, roots)
                    : await collectTeamsActivity(ctx, roots);
                const body = JSON.stringify({ teams: snapshots });
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(body);
            },
        }), 'agent-teams: activity route');
        // Whale mascot artwork: serve the packaged role/action images to the
        // activity panel. An explicit allowlist guards the route (no path
        // traversal); the images ship with the bundle (files: assets/).
        const artDir = fileURLToPath(new URL('../assets/agent-teams/', import.meta.url));
        const ART_ALLOWLIST = new Set([
            'team-lead.png', 'researcher.png', 'engineer.png', 'designer.png',
            'qa-engineer.png', 'security-reviewer.png', 'data-analyst.png',
            'docs-coordinator.png', 'action-working.png', 'action-thinking.png',
            'action-reporting.png', 'action-celebrating.png', 'action-sleeping.png',
            'action-sending.png',
        ]);
        ctx.effect(() => webServer.register({
            kind: 'prefix',
            path: '/plugins/dsh-agent-teams/assets',
            handler: async (req, res) => {
                let name;
                try {
                    name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
                }
                catch {
                    // Malformed percent-encoding: treat as an unknown asset, not a 400.
                    res.writeHead(404);
                    res.end();
                    return;
                }
                if (!ART_ALLOWLIST.has(name)) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                try {
                    const data = await readFile(join(artDir, name));
                    res.writeHead(200, {
                        'content-type': 'image/png',
                        'cache-control': 'public, max-age=86400',
                    });
                    res.end(data);
                }
                catch (error) {
                    ctx.logger.warn(`agent-teams: artwork read failed for ${name}: ${String(error)}`);
                    res.writeHead(404);
                    res.end();
                }
            },
        }), 'agent-teams: artwork route');
    };
    registerWebSurface();
    ctx.on('internal/service', (name) => {
        if (WEB_SERVER_KEYS.includes(name)
            || WORKSPACE_KEYS.includes(name)) {
            registerWebSurface();
        }
    });
}
