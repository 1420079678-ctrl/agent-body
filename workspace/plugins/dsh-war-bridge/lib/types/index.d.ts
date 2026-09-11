/**
 * @dsh-external/dsh-war-bridge — 战友桥（War Bridge）
 *
 * 问题：本机的三套安全插件各打各的——
 *   dsh-reverse-skill  = 逆向链（rev_* 工具 + IDA MCP/idalib 监督进程，案件库 A）
 *   dsh-sec-workbench  = 攻击链（40+ sec_* 工具，案件库 B、journal）
 *   dsh-pentagi        = 编排链（agi_plan/agi_next/agi_flow，flow + kb.jsonl）
 * 它们的案件目录结构几乎一致却分属两个根，记忆分三处，IDA 的 69 个 MCP 工具
 * 又没法被 sec_* 直接调用——联合行动时人得自己搬数据。
 *
 * 本插件提供四根"血管"，把三条链拧成一股绳（全部零依赖、确定性、零模型往返）：
 *   ida          IDA MCP 直连桥：status/open/list/funcs/decompile/disasm/imports/
 *                strings/xrefs/eval/save/close/raw（免去把 69 个工具塞进 schema 的 token 开销）
 *   war_status   全班组合体体检：IDA 服务 / rev 案件与记忆 / sec 案件与记忆 / agi 流与知识库
 *   war_case     跨库案件：list（两库全景）/ show（并排查看）/ handoff（证据与结论跨库交接）
 *   war_memory   三库统一检索：rev journal + sec journal + pentagi kb.jsonl 一次查
 *
 * 形态：toolkit。规范：所有工具注册挂 ctx.effect（热重载/卸载自动清理）。
 * 铁律：只读为主；唯一写操作是 war_case handoff（显式调用才会写目标库，且只增不改）。
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-war-bridge";
export declare const inject: string[];
export interface Config {
    /** IDA MCP（idalib 监督进程）的 Streamable HTTP 端点 */
    idaUrl: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    idaUrl: z<string, string>;
}>, Schemastery.ObjectT<{
    idaUrl: z<string, string>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
