/**
 * @dsh-external/dsh-cortex — 皮层（睡眠 · 记忆 · 巩固）
 *
 * ── 为什么需要它 ──
 * organism 给了这具身体「器官 + 心跳 + 反射 + 自愈 + 自训练」，但它只有「此刻」：
 * 心跳均匀地跳、器官各干各的、经验随会话一起漂走。一个从不睡觉的身体，
 * 学到的东西留不住（突触长期停在个位数），报警的却一点也忘不掉
 * （同一条离线告警每跳刷一次，真异常反而被淹没）。
 *
 * 皮层补上的，正是生物体区别于机器的两样东西——**时间**与**记忆**：
 *
 *   ⓪ 睡眠周期 Sleep-Wake Cycle
 *      每一次工具调用都是「清醒信号」。静默越久越困：静默 ≥ sleepAfterMs 入浅睡，
 *      ≥ deepAfterMs 入深睡。深睡时执行**巩固**——扫描这段时间的全部经历，
 *      把反复踩的坑、跑通的链路、高频的薄弱环节提炼成长期记忆。
 *      一旦有活动立刻醒来，并留下一份睡眠报告（睡了多久、整理出什么）。
 *
 *   ① 长期记忆 Long-term Memory
 *      记忆卡分四类：坑 / 打法 / 薄弱环节 / 事实。带权重与使用计数、跨会话持久化。
 *      新命令一进来，皮层按关键词主动召回最相关的几张卡注入上下文——
 *      「这类事以前踩过什么坑」，不必等大脑自己想起来。
 *      用不到的记忆按半衰期衰减、归档（不物理删除，可召回）。
 *
 *   ② 稳态降噪 Homeostatic Noise Control
 *      告警的价值在「变化」，不在「重复」。同一条稳态告警在窗口内重复只计数不刷屏；
 *      反复出现且从未自愈的，收敛为「已知稳态偏移」并静默——让真正的异常浮出水面。
 *
 * 形态：toolkit（零外部依赖）。规范：所有副作用挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-cortex";
export declare const inject: string[];
export interface Config {
    /** 皮层总开关 */
    enabled: boolean;
    /** 静默多久算「浅睡」（毫秒） */
    sleepAfterMs: number;
    /** 静默多久算「深睡」——深睡才做巩固（毫秒） */
    deepAfterMs: number;
    /** 自动入睡（关掉则只能手动 enter） */
    autoSleep: boolean;
    /** 深睡期间两次巩固的最小间隔（毫秒） */
    consolidateGapMs: number;
    /** 相位巡检间隔（毫秒） */
    tickMs: number;
    /** 新命令进来时主动召回记忆并注入 */
    memoryRecall: boolean;
    /** 每次最多召回几条 */
    recallLimit: number;
    /** 记忆遗忘半衰期（毫秒）——久未使用的卡按它衰减 */
    memoryHalfLifeMs: number;
    /** 权重低于此值的记忆归档 */
    archiveBelow: number;
    /** 事件环形缓冲上限 */
    bufferMax: number;
    /** 告警去重窗口（毫秒）——窗口内同一条告警只计数不记录 */
    noiseWindowMs: number;
    /** 同一条告警重复到几次，收敛为「已知稳态偏移」并静默 */
    noiseConvergeAt: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    sleepAfterMs: z<number, number>;
    deepAfterMs: z<number, number>;
    autoSleep: z<boolean, boolean>;
    consolidateGapMs: z<number, number>;
    tickMs: z<number, number>;
    memoryRecall: z<boolean, boolean>;
    recallLimit: z<number, number>;
    memoryHalfLifeMs: z<number, number>;
    archiveBelow: z<number, number>;
    bufferMax: z<number, number>;
    noiseWindowMs: z<number, number>;
    noiseConvergeAt: z<number, number>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    sleepAfterMs: z<number, number>;
    deepAfterMs: z<number, number>;
    autoSleep: z<boolean, boolean>;
    consolidateGapMs: z<number, number>;
    tickMs: z<number, number>;
    memoryRecall: z<boolean, boolean>;
    recallLimit: z<number, number>;
    memoryHalfLifeMs: z<number, number>;
    archiveBelow: z<number, number>;
    bufferMax: z<number, number>;
    noiseWindowMs: z<number, number>;
    noiseConvergeAt: z<number, number>;
}>>;
/** cortex_sleep 的参数：action 之外的字段用于 `action=config` 运行时调节律 */
export interface SleepArgs {
    action?: string;
    sleepAfterMs?: number;
    deepAfterMs?: number;
    consolidateGapMs?: number;
    memoryHalfLifeMs?: number;
    archiveBelow?: number;
    noiseWindowMs?: number;
    noiseConvergeAt?: number;
    recallLimit?: number;
    autoSleep?: boolean;
    memoryRecall?: boolean;
}
export type MemoryKind = 'pitfall' | 'playbook' | 'hotspot' | 'unresolved' | 'fact';
export declare const KIND_LABEL: Record<string, string>;
/** 记忆卡：皮层的一枚长期记忆。权重随「使用 + 再次出现」上升、随时间衰减。 */
export interface MemoryCard {
    id: string;
    /** 首次形成时间 */
    t: number;
    kind: MemoryKind;
    title: string;
    body: string;
    tags: string[];
    /** 权重（0–10）：越高越容易被召回 */
    weight: number;
    /** 被召回使用次数 */
    uses: number;
    lastUsed: number;
    archived?: boolean;
    source: string;
}
export type Phase = 'awake' | 'light' | 'deep';
export interface SleepReport {
    t: number;
    enteredAt: number;
    wokeAt: number;
    /** 进入过的最深相位 */
    deepest: Phase;
    durationMs: number;
    scanned: number;
    created: number;
    reinforced: number;
    archived: number;
    notes: string[];
}
export interface NoiseEntry {
    count: number;
    first: number;
    last: number;
    silenced: boolean;
    sample: string;
}
export interface CortexState {
    phase: Phase;
    lastActivityAt: number;
    lastConsolidateAt: number;
    sleepStartedAt: number;
    reports: SleepReport[];
    /** 'YYYY-MM-DD' → 24 个小时桶的活跃计数 */
    rhythm: Record<string, number[]>;
    noise: Record<string, NoiseEntry>;
    /** 累计收到的 organism 心跳数——只用于观测「心跳确实通到皮层」，不参与睡意计算 */
    beats?: number;
    /** 最近一次清醒信号的来源（诊断：睡不着时看谁在刷活动） */
    lastActivityWhy?: string;
    /** 本次生命期统计 */
    stats: {
        consolidations: number;
        cardsCreated: number;
        recalls: number;
        noiseSuppressed: number;
    };
}
export interface Ev {
    t: number;
    tool: string;
    ok: boolean;
    ms: number;
    err: string;
}
/**
 * 轻量分词：英文/数字按词、中文按 2-gram。只用于记忆的匹配与标签，
 * 不做任何语义推断——皮层是确定性器官，判断留给大脑。
 */
export declare function tokens(input: string): string[];
/** 告警归一化：抹掉数字与列表差异，让「同一条告警」稳定收敛到同一个 key */
export declare function normalizeNote(note: string): string;
export declare function cardId(kind: string, key: string): string;
export interface NoiseTick {
    noise: Record<string, NoiseEntry>;
    /** 本次被抑制的重复告警数（窗口内重复只计数不刷屏） */
    suppressed: number;
    /** 本次新收敛为「已知稳态偏移」的告警 key */
    converged: string[];
}
/**
 * 稳态告警降噪的确定性内核——**告警的价值在变化，不在重复**。
 * 同一条告警在窗口内重复只计数；反复出现且从未自愈的收敛为「已知稳态偏移」并静默。
 * 收敛后再重复既不计入抑制也不刷屏：让它彻底安静下来，把音量还给真正的异常。
 */
export declare function reduceNoise(noise: Record<string, NoiseEntry>, alerts: Array<{
    organ?: string;
    note?: string;
}>, now: number, windowMs: number, convergeAt: number): NoiseTick;
export interface PatternResult {
    pitfalls: MemoryCard[];
    playbooks: MemoryCard[];
    hotspots: MemoryCard[];
    unresolved: MemoryCard[];
}
/**
 * 从一段经历里提炼可长期复用的模式——**巩固的确定性内核，零模型调用**。
 * 四类产物：反复踩的坑 / 跑通的链路 / 高频低成功率的薄弱环节 / 失败后悬空未解的事。
 * @param since 只对该时刻之后**又发生过**的模式建卡，避免重复扫同一段经历把权重刷虚。
 */
export declare function extractPatterns(evs: Ev[], since: number, now: number): PatternResult;
export declare function apply(ctx: Context, config: Config): void;
