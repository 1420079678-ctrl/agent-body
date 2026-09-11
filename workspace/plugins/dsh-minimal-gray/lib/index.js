/**
 * @dsh-external/dsh-minimal-gray — 极简灰度版 Agent 预设（Minimal Gray）。
 *
 * 技术来源：抖音「用这段提示词，彻底解锁 deepseek」图文 —— 以 DSH 极简模式为底，
 * 用「平台自适应 Shell」（Windows→PowerShell，Unix→Bash）对抗 Windows 不适配
 * Bash 的问题，并精选文件/搜索/网页/待办/后台任务/技能/目标工具的最小组合。
 *
 * 本插件把该技术落地为 DSH 原生机制：注入时自动（幂等）把预设目录
 * `presets/minimal-gray/`（preset.yml + agent.cordis.yml）同步到
 * `<DSH_HOME>/.agent-presets/minimal-gray/`。DSH 的预设发现是热加载的——
 * 每次读取都重新扫描根目录，因此写入后预设选择器立即出现，无需重启。
 *
 * 同时提供三个管理工具：
 *   - `minimal_gray_install`   安装/更新预设（幂等，内容一致则跳过）
 *   - `minimal_gray_uninstall` 删除已安装的预设目录
 *   - `minimal_gray_status`    报告安装状态与预设内容
 *
 * @module @dsh-external/dsh-minimal-gray
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from 'schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = '@dsh-external/dsh-minimal-gray';
export const inject = ['tools'];
export const Config = z.object({
    presetId: z.string().default('minimal-gray'),
    autoInstall: z.boolean().default(true),
    uninstallOnDispose: z.boolean().default(false),
    dshHome: z.string().default(''),
});
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
/** Built-layout presets root: <pkg>/presets/<presetId>/. */
const PRESETS_ROOT = join(PLUGIN_DIR, '..', 'presets');
/** The user preset root DSH's agent-presets package appends automatically. */
function userPresetRoot(config) {
    const home = config.dshHome.trim().length > 0
        ? config.dshHome
        : (process.env.DSH_HOME?.trim() ?? '');
    const resolvedHome = home.length > 0 ? resolve(home) : join(homedir(), '.dsh');
    return join(resolvedHome, '.agent-presets');
}
/** Resolve the preset id from config, validating the DSH preset id shape. */
function resolvePresetId(config) {
    const id = config.presetId;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        throw new Error(`minimal-gray: preset id "${id}" must match /^[a-z0-9][a-z0-9-]*$/`);
    }
    return id;
}
/** Source preset directory shipped with this plugin. */
function sourcePresetDir() {
    return join(PRESETS_ROOT, 'minimal-gray');
}
/** Destination preset directory under the user root. */
function destPresetDir(root, id) {
    return join(root, id);
}
/** Read a file as UTF-8 text, or undefined when missing. */
function readMaybe(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
}
/** True when the file is a regular file. */
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/** Copy one preset directory idempotently: writes only differing files. */
function syncPresetDir(source, dest) {
    const written = [];
    const unchanged = [];
    for (const entry of readdirSync(source, { withFileTypes: true })) {
        const src = join(source, entry.name);
        const dst = join(dest, entry.name);
        if (entry.isDirectory()) {
            const nested = syncPresetDir(src, dst);
            written.push(...nested.written);
            unchanged.push(...nested.unchanged);
            continue;
        }
        if (!isFile(src))
            continue;
        const content = readFileSync(src, 'utf8');
        if (readMaybe(dst) === content) {
            unchanged.push(dst);
            continue;
        }
        mkdirSync(dest, { recursive: true });
        writeFileSync(dst, content, 'utf8');
        written.push(dst);
    }
    return { written, unchanged };
}
export function apply(ctx, config) {
    const root = userPresetRoot(config);
    const id = resolvePresetId(config);
    const dest = destPresetDir(root, id);
    const source = sourcePresetDir();
    const install = () => {
        if (!existsSync(source)) {
            throw new Error(`minimal-gray: preset source missing: ${source}`);
        }
        const result = syncPresetDir(source, dest);
        ctx.logger.info(`minimal-gray: preset "${id}" installed at ${dest} `
            + `(${result.written.length} written, ${result.unchanged.length} unchanged)`);
        return { ...result, dest };
    };
    // Idempotent auto-install on apply (default on).
    if (config.autoInstall) {
        try {
            install();
        }
        catch (error) {
            ctx.logger.warn(`minimal-gray: auto-install failed: ${String(error)}`);
        }
    }
    // Optional cleanup on dispose (default off — presets are user data).
    if (config.uninstallOnDispose) {
        ctx.effect(() => () => {
            try {
                rmSync(dest, { recursive: true, force: true });
                ctx.logger.info(`minimal-gray: preset "${id}" removed from ${dest}`);
            }
            catch (error) {
                ctx.logger.warn(`minimal-gray: dispose cleanup failed: ${String(error)}`);
            }
        }, '@dsh-external/dsh-minimal-gray: dispose cleanup');
    }
    const describe = () => {
        const presetYml = readMaybe(join(dest, 'preset.yml'));
        const agentYml = readMaybe(join(dest, 'agent.cordis.yml'));
        return {
            presetId: id,
            root,
            installed: existsSync(dest) && isFile(join(dest, 'agent.cordis.yml')),
            presetYml: presetYml ?? null,
            agentCordisYml: agentYml ?? null,
        };
    };
    // ── tools ─────────────────────────────────────────────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'minimal_gray_install',
        description: '安装/更新「极简灰度版」Agent 预设到 DSH_HOME/.agent-presets/（幂等：仅写入有差异的文件）。'
            + '写入后预设选择器热加载出现，无需重启。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        async execute() {
            const result = install();
            return JSON.stringify({ ok: true, ...result }, null, 2);
        },
    })), '@dsh-external/dsh-minimal-gray: install tool');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'minimal_gray_uninstall',
        description: '删除已安装的「极简灰度版」预设目录（<DSH_HOME>/.agent-presets/minimal-gray/）。'
            + '删除后预设选择器不再显示该预设。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        async execute() {
            if (!existsSync(dest)) {
                return JSON.stringify({ ok: true, removed: false, reason: 'not installed', dest });
            }
            rmSync(dest, { recursive: true, force: true });
            ctx.logger.info(`minimal-gray: preset "${id}" uninstalled from ${dest}`);
            return JSON.stringify({ ok: true, removed: true, dest });
        },
    })), '@dsh-external/dsh-minimal-gray: uninstall tool');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'minimal_gray_status',
        description: '报告「极简灰度版」Agent 预设的安装状态：是否已安装、预设目录位置、'
            + 'preset.yml 与 agent.cordis.yml 内容。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        async execute() {
            return JSON.stringify(describe(), null, 2);
        },
    })), '@dsh-external/dsh-minimal-gray: status tool');
}
//# sourceMappingURL=index.js.map