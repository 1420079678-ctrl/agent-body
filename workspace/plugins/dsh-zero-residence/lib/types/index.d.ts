/**
 * @dsh-external/dsh-zero-residence — 零驻留协议引擎（Zero-Residence Protocol Engine）
 *
 * ── 问题（本机实测） ──
 * 对一个 511 步的真实会话做成本分解：累计注意力积分 A = Σ n_t = 6.53e8 token，
 * 其中 **91.3% 来自「历史重发」**——每条消息在它之后的每一步都被重读一次。
 * 而行业全部省 token 手段（压缩、摘要、工具门控）都在优化「大小」，只覆盖 4.2%。
 * 默认的 compaction-basic 要攒到 contextWindow 的 80%（本机 = 80 万 token）才触发，
 * 且触发时还要花一次 LLM 调用来做**有损**摘要。
 *
 * ── 本引擎的颠覆点 ──
 * 覆写 `summarize()`（compaction-basic 唯一的子类定制钩子），把「有损 LLM 摘要」
 * 换成「**确定性零成本指针压缩**」：
 *   ① 零 LLM 调用 —— 不花一个 token、不花一秒等待；
 *   ② 无损 —— 被遮蔽内容 100% 可按 key 从持久会话日志重建（`zr_recall`）；
 *   ③ 可审计 —— 遮蔽清单本身就是账本。
 * 依据是零驻留原则：任何可确定性重建的信息，最优驻留时间为零。
 *
 * ── 速度侧（同一实测的另一半结论） ──
 * 同一 1,598 步的回归显示：上下文大小只解释 0.3% 的每步耗时（R²=0.003），
 * 而每步 14.3s 中 **工具执行占 8.69s（61%）**，2,765 次调用里 `pwsh` 一个工具
 * 独吞 79.1%（均值 16.19s，最长单次 1,799s）。故本插件同时提供 `zr_fast`：
 * 把阻塞式长命令变成即返句柄，直接掐掉延迟靶心。
 *
 * 形态：toolkit + service provider。所有副作用挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis';
import z from 'schemastery';
import type { Message } from '@deepseek-ai/dsh-llm';
export declare const name = "@dsh-external/dsh-zero-residence";
export declare const inject: string[];
export interface Config {
    /** 挂载零驻留压缩引擎（覆盖同上下文的 compaction 服务；false 时只提供工具） */
    engine: boolean;
    /** 叙述类消息保留的正文字符数（工具载荷一律只留指针） */
    narrativeHeadChars: number;
    /** zr_fast 句柄与输出的存放目录（默认 DSH_HOME 下） */
    jobDir: string;
    /**
     * 压缩触发阈值：上下文达到「模型窗口 × 该比例」即触发。
     * 默认 0.8（harness 原值）意味着本机 100 万窗口要攒到 80 万 token 才驱逐——
     * 这正是实测 91.3% 驻留成本的结构性根源，故默认下调到 0.3。
     */
    thresholdRatio: number;
    /** 压缩后保留的最近上下文 token 数（比 retainRatio 更可预测，故用绝对值） */
    retainTokens: number;
}
export declare const Config: z<Config>;
/**
 * 把一段被遮蔽的对话压成「可重建指针清单」。
 *
 * 判据（零驻留原则的落地）：
 *  · 工具结果 / 工具调用 —— 在持久日志里逐字可还原，故**只留指针**（零污染）；
 *  · 叙述类（user / assistant 正文）—— 保留头部若干字符以维持任务语义连续性。
 */
export declare function buildPointerManifest(messages: readonly Message[], headChars: number): {
    text: string;
    shadowedTokens: number;
    manifestTokens: number;
    entries: number;
    pointerOnly: number;
};
/** 当前会话的驻留账本：读持久日志重算 A 与三段分解。 */
export declare function computeLedger(sessionId: string): string;
export declare function apply(ctx: Context, config: Config): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: z<Config>;
    apply: typeof apply;
};
export default _default;
