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
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-minimal-gray";
export declare const inject: string[];
export interface Config {
    /** Preset id (must match /^[a-z0-9][a-z0-9-]*$/). */
    presetId: string;
    /** Auto-install the preset on plugin apply (idempotent). Default true. */
    autoInstall: boolean;
    /** Remove the installed preset directory when the plugin is unloaded. Default false. */
    uninstallOnDispose: boolean;
    /** Optional DSH_HOME override; defaults to $DSH_HOME then ~/.dsh. */
    dshHome: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    presetId: z<string, string>;
    autoInstall: z<boolean, boolean>;
    uninstallOnDispose: z<boolean, boolean>;
    dshHome: z<string, string>;
}>, Schemastery.ObjectT<{
    presetId: z<string, string>;
    autoInstall: z<boolean, boolean>;
    uninstallOnDispose: z<boolean, boolean>;
    dshHome: z<string, string>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
