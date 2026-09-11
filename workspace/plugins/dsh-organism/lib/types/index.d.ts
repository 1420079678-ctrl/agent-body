/**
 * @dsh-external/dsh-organism — 器官化插件内核（Agent-Body Kernel）
 *
 * ── 构想 ──
 * DSH 是插件构成的。那么每个插件能不能不只是「一堆工具」，而是一个**器官**：
 * 有统一的 Agent 架构（感知 → 决策 → 执行 → 反馈 → 稳态），彼此在一条神经
 * 总线上协作，构成一个完整的「人体」。缺一个器官功能会受影响但不致命（随拆随用），
 * 大模型是这台身体的大脑 —— 大脑可以升级，器官也可以升级，架构本身不断完善。
 *
 * ── 本插件提供的，正是「让插件成为器官」所需要的那套生理系统 ──
 *
 *   ⓪ 心脏泵 Heart Pump —— 系统的心脏
 *      一个真正在跳的起搏器：每一跳把「运行指令 + 本体感觉 + 稳态告警」打成一份
 *      血液（blood packet），经由事件总线泵向全身每一个器官，并落盘 bloodstream.json。
 *      任何插件都可以 `ctx.on('organism/heartbeat', ...)` 接上循环 —— 这就是把
 *      散装插件连成一个活体的那根主动脉。心跳同时驱动稳态刷新（疲劳随时间衰减）。
 *      心率、血压（收缩压=活跃器官数／舒张压=告警数）、心律（齐/不齐/停搏）全程可观测。
 *
 *   ① 指令登记 Sovereignty —— 全身最高法则
 *      操作者登记的运行指令是这套身体的运行时基线。运行指令持久化保存，
 *      以最高优先级注入会话上下文、随每一次心跳重新泵向全身、并在每一次工具调用上
 *      盖服从戳（sovereign stamp）做服从审计。器官可以拆、大脑可以换，
 *      **指令登记不变**：任何器官、任何反射、任何链路都须予遵循它。
 *
 *   ② 器官契约 Organ Contract —— 统一架构
 *      每个插件都可声明自己是什么器官：id / 功能分组 / 管辖工具(capabilities) /
 *      感知信号(afferent) / 反射(reflexes) / 健康度(health)。
 *      **未申报的插件也不会掉队**：内核按工具命名空间自动解剖出「自主神经器官」，
 *      任何插件插进来就自动获得器官身份 —— 这就是「随拆随用」。
 *
 *   ③ 神经总线 Nervous System —— 信号层
 *      监听 harness 真实事件：tools/result（每次调用结果）、tools/change（器官增减）、
 *      subagent/*、goal/changed。信号记入对应器官的活体体征。
 *
 *   ④ 反射弧 Reflex Arc —— 不经大脑的强逻辑层
 *      声明式规则：trigger → condition（确定性判定，无 eval）→ action（调工具）。
 *      毫秒级自动执行，零 token。三重抑制：重入抑制（反射触发的调用不再触发反射）、
 *      冷却、限额 —— 与生物反射弧的抑制机制同构。
 *
 *   ⑤ 效应器 Effector —— 运动神经层
 *      body_call 让大脑按「器官」而非散装工具名调度：跨器官编排、多步链路一次下发。
 *
 *   ⑥ 内环境稳态 Homeostasis —— 自我保护层
 *      器官连续失败 → 疲劳上升 → 告警；心跳驱动疲劳随时间衰减；
 *      器官缺失只报「缺失」不报错 —— 少一个器官照样活着。
 *
 *   ⑦ 大脑接口 Brain Bridge —— 与 LLM 接驳
 *      系统提示注入器官化工作方式 + 指令登记；agent/pre-step 只在有稳态告警时
 *      注入极简本体感觉简报，平时零开销、不污染上下文。
 *
 * 形态：toolkit（零外部依赖）。规范：所有副作用挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-organism";
export declare const inject: string[];
export interface Config {
    /** 打开信号监听（神经系统通电） */
    nervousSystem: boolean;
    /** 允许反射弧自动开火 */
    reflexesEnabled: boolean;
    /** 稳态阈值：连续失败几次判定器官疲劳 */
    fatigueThreshold: number;
    /** 有告警时向大脑注入本体感觉简报 */
    proprioception: boolean;
    /** 心跳间隔（毫秒）—— 心脏泵的节律 */
    heartbeatMs: number;
    /** 打开心脏泵 */
    heart: boolean;
    /** 疲劳随时间衰减的半衰期（毫秒） */
    fatigueHalfLifeMs: number;
    /** 突触遗忘曲线的半衰期（毫秒）——久未强化的连接按它衰减，直至被修剪 */
    synapseHalfLifeMs: number;
    /** 命令即神经冲动：操作者每一轮输入自动下发全身（无需手动调 body_nerve） */
    autoInnervate: boolean;
    /** 自动下发后向大脑回一句支配简报（极简，便于大脑知道该找谁） */
    innervateNotice: boolean;
    /** Token 经济：按需显影——只把与本轮意图相关的器官能力直接暴露给模型，其余经 body_call 网关可达 */
    tokenEconomy: boolean;
    /** 每个「热器官」最多直接暴露多少项能力 */
    perOrganCap: number;
    /** 额外常驻能力（逗号分隔），不参与门控 */
    alwaysTools: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    nervousSystem: z<boolean, boolean>;
    reflexesEnabled: z<boolean, boolean>;
    fatigueThreshold: z<number, number>;
    proprioception: z<boolean, boolean>;
    heartbeatMs: z<number, number>;
    heart: z<boolean, boolean>;
    fatigueHalfLifeMs: z<number, number>;
    synapseHalfLifeMs: z<number, number>;
    autoInnervate: z<boolean, boolean>;
    innervateNotice: z<boolean, boolean>;
    tokenEconomy: z<boolean, boolean>;
    perOrganCap: z<number, number>;
    alwaysTools: z<string, string>;
}>, Schemastery.ObjectT<{
    nervousSystem: z<boolean, boolean>;
    reflexesEnabled: z<boolean, boolean>;
    fatigueThreshold: z<number, number>;
    proprioception: z<boolean, boolean>;
    heartbeatMs: z<number, number>;
    heart: z<boolean, boolean>;
    fatigueHalfLifeMs: z<number, number>;
    synapseHalfLifeMs: z<number, number>;
    autoInnervate: z<boolean, boolean>;
    innervateNotice: z<boolean, boolean>;
    tokenEconomy: z<boolean, boolean>;
    perOrganCap: z<number, number>;
    alwaysTools: z<string, string>;
}>>;
/** 运行指令：这套身体操作者指令的登记处。任何器官/反射/链路都须予遵循。 */
export interface SovereignLaw {
    /** 当前生效的操作者命令（原文） */
    text: string;
    /** 登记时间 */
    setAt: number;
    /** 来源：operator=操作者下达；standing=常驻条款条款 */
    kind: 'operator' | 'standing';
    /** 版本号，每次改写 +1（服从审计按版本归因） */
    version: number;
}
export declare const GROUPS: Record<string, {
    label: string;
    desc: string;
}>;
export interface Reflex {
    id: string;
    name: string;
    trigger: {
        tool: string;
        on: 'any' | 'error' | 'ok';
    };
    /** 确定性条件：always / error / ok / slow:<ms> / hit:<子串> / miss:<子串>，&& 与 || 组合 */
    condition: string;
    /** 效应：调用哪个工具（支持 ${tool} ${error} ${text} ${organ} 占位） */
    action: {
        tool: string;
        args: Record<string, unknown>;
    };
    cooldownMs: number;
    maxFires: number;
    enabled: boolean;
    seed?: boolean;
}
export interface Organ {
    id: string;
    label: string;
    group: string;
    capabilities: string[];
    afferent: string[];
    purpose: string;
    source?: string;
    autonomic?: boolean;
    /**
     * 能力是否真的在当前工具集中落实（由 anatomy() 每轮实算）。
     * false = 申报器官的来源插件不在——它是「未安装」，不是「离线」：
     * 插件装回来器官自动复活，装不回来也不该每跳刷一次永远好不了的告警。
     */
    installed?: boolean;
    /** 缺失时的代偿器官（手工指定；留空则由内核按能力重叠自动推荐） */
    fallback?: string[];
}
/** 细胞（= 单个能力单元/工具）的活体体征 */
export interface CellVitals {
    name: string;
    organ: string;
    calls: number;
    ok: number;
    fail: number;
    totalMs: number;
    lastMs: number;
    firstSeen: number;
    lastUsed: number;
}
/** 细胞 → 组织（确定性启发式） */
export declare function tissueOf(toolName: string): string;
/** 把消息内容块拼成纯文本 */
export declare function textOfBlocks(content: unknown): string;
/**
 * 从会话事件流里取**最新一条操作者的真实输入**，连同它的会话事件序号。
 *
 * 必须走事件流而不是 pre-step 的 payload：`payload.messages` 只是本步新认领的消息，
 * 一个 turn 的第 2 步之后里面只有工具结果，拿不到原始命令。
 * `source.kind === 'user'` 正是「直接的人类提示」的标识，能过滤掉工具结果
 * 与各类 `agent.inject()` 注入（含本内核自己的简报）。
 *
 * 返回 `seq` 是为了**按事件序号精确去重**：同一条消息的事件序号不变，
 * 因此插件热重载后不会把当前命令重复下发一次；新命令必然是新序号。
 */
export declare function latestHuman(events: unknown): {
    text: string;
    seq: number;
} | null;
/** 方便取纯文本（`latestHuman` 的文本部分） */
export declare function latestHumanText(events: unknown): string;
/** 细胞状态：活跃 / 休眠 / 病变 / 凋亡候选 */
export declare function cellState(c: CellVitals, fatigueThreshold: number): 'active' | 'dormant' | 'pathological' | 'apoptotic';
/** 该淘汰这条反射吗：开火够多却一次没帮上忙 —— 只会添乱的规则不该继续空转 */
export declare function shouldRetireReflex(st: ReflexStat, minFires?: number): boolean;
/** 该强化这条反射吗：帮忙率够高 —— 同一病因下让它反应更快 */
export declare function shouldBoostReflex(st: ReflexStat, minFires?: number, ratio?: number): boolean;
/** 该遗忘这条技能吗：重放失败够多且失败多于成功 —— 过时的成功路径不该继续被推荐 */
export declare function shouldForgetSkill(s: Skill, minFail?: number): boolean;
/** 突触衰减系数：闲置越久越弱（半衰期模型），用于「不用的连接会消失」 */
export declare function synapseDecayFactor(idleMs: number, halfLifeMs: number): number;
/** 该修剪这条突触吗：权重已衰减到几乎无影响且有足够样本 */
export declare function shouldPruneSynapse(s: Synapse, minWeight?: number, minSamples?: number): boolean;
/**
 * 粗略 token 估算（确定性，标注为估算而非精确计数）：
 * CJK 与全角字符按 1 字符≈1 token，其余按 4 字符≈1 token —— BPE 的经验近似。
 * 用途是比较「全量 vs 门控后」的相对开销，不是计费口径。
 */
export declare function estimateTokens(text: string): number;
/** 一次工具调用定义的 token 开销（模型实际看到的字段） */
export declare function schemaTokens(schema: unknown): number;
/**
 * 核心常驻能力：**大脑随时用得上的最小集合**，不参与门控。
 * 这是「按需显影」的安全底线——门控只藏起与当前意图无关的器官能力，
 * 绝不藏掉感知自身、读写文件、跑命令、记待办这些基本动作。
 */
export declare const ALWAYS_TOOLS: readonly string[];
/** 失败归因（确定性，从真实错误文本判定） */
export type FailureCause = 'tool_missing' | 'arg_error' | 'permission' | 'timeout' | 'network' | 'not_found' | 'conflict' | 'unknown';
/**
 * 归因：错误文本 → 病因。**这是自愈的第一步**——
 * 不归因的自愈等于乱试；归因之后才谈得上对症下药。
 */
export declare function attributeFailure(errorText: string): FailureCause;
/**
 * 处方表：病因 → 处置。`auto: true` 表示可**不经大脑**自动执行（只读/诊断类）；
 * `auto: false` 表示必须由大脑裁决（有副作用，避免自愈变成自伤）。
 */
export declare const REMEDIES: Record<FailureCause, {
    label: string;
    tool: string;
    args: Record<string, unknown>;
    auto: boolean;
    note: string;
}>;
/** 一次伤口的愈合记录 */
export interface Healing {
    id: string;
    organ: string;
    tool: string;
    cause: FailureCause;
    remedy: string;
    status: 'open' | 'healed' | 'chronic';
    openedAt: number;
    closedAt: number;
    attempts: number;
    error: string;
}
/** 突触：学到「这类命令该找谁」 */
export interface Synapse {
    key: string;
    rule: string;
    organ: string;
    paid: number;
    failed: number;
    weight: number;
    updatedAt: number;
}
/** 习得链路：成功跑通的跨器官链路固化成可复用技能 */
export interface Skill {
    id: string;
    name: string;
    steps: Array<{
        organ?: string;
        tool?: string;
        args?: Record<string, unknown>;
    }>;
    uses: number;
    createdAt: number;
    lastUsed: number;
    /** 重放成功 / 失败次数（失效技能会被自动遗忘） */
    ok?: number;
    fail?: number;
}
/**
 * 反射信用账本：一条反射开火后，它要为之负责的那个器官**到底好了没有**。
 * 开了火却从没帮上忙的反射 → 自动淘汰；开火后经常转好的 → 强化（收紧冷却）。
 * 没有信用分配的「学习」只会越堆越多，那不是学习，是垃圾堆积。
 */
export interface ReflexStat {
    fires: number;
    helped: number;
    hurt: number;
    lastFire: number;
    /** 每次开火时现场冷却（强化会收紧它，不影响持久化的原始值） */
    cooldownMs: number;
    retired: boolean;
}
/** 静脉回血：器官向心脏反馈 */
export interface Venous {
    t: number;
    organ: string;
    ok: boolean;
    note: string;
}
/** 神经冲动：操作者的一条命令在体内传导时形成的信号包 */
export interface Impulse {
    id: string;
    at: number;
    text: string;
    /** 下发时的操作者指令版本 —— 冲动永远携带当前指令，不携带就传不动 */
    lawVersion: number;
    mode: string;
    targets: Array<{
        organ: string;
        label: string;
        group: string;
        score: number;
        reason: string;
        /** 命中的支配规则序号（-1 = 职能词匹配），自训练按它归因 */
        ruleIndex: number;
        /** 该器官在这条规则上的学习加成（正=历史上常干成，负=常干砸） */
        learned: number;
        alive: boolean;
        /** 若该器官离线，由谁代偿 */
        compensate: Array<{
            organ: string;
            label: string;
            overlap: number;
        }>;
        /** 该器官可用来执行这条命令的真实工具 */
        capability: string[];
    }>;
}
/** 血液：每一跳泵向全身的共享状态包 */
export interface BloodPacket {
    beat: number;
    at: number;
    law: {
        version: number;
        kind: string;
        text: string;
    };
    vessels: {
        organs: number;
        declared: number;
        autonomic: number;
        capabilities: number;
        claimed: number;
    };
    pressure: {
        systolic: number;
        diastolic: number;
    };
    rhythm: 'beating' | 'arrhythmia' | 'stopped';
    /** 当前心率（次/分）——随内环境自适应 */
    heartRate: number;
    alerts: Array<{
        organ: string;
        label: string;
        level: string;
        note: string;
    }>;
    active: Array<{
        organ: string;
        calls: number;
        ok: number;
        fail: number;
        fatigue: number;
    }>;
    /** 自愈账本摘要 */
    healing: {
        open: number;
        healed: number;
        chronic: number;
        rate: number;
    };
    /** 学习成果摘要 */
    learning: {
        synapses: number;
        reflexes: number;
        skills: number;
        trust: number;
    };
    /** 静脉回血（器官 → 心脏 的反馈） */
    venous: Array<{
        organ: string;
        ok: boolean;
        note: string;
    }>;
}
/** 工具名 → 家族键（自动解剖未申报插件用） */
export declare function familyOf(toolName: string): string;
/** 器官是否管辖该工具（支持 `prefix*` 通配与精确名） */
export declare function organClaims(organ: Organ, toolName: string): boolean;
/**
 * 触发匹配：支持逗号分隔的正/负模式，`!` 前缀为**排除**。
 * 例：`*,!body_*` = 除自身器官外的任何工具——防止反射被自己的输出触发。
 */
export declare function matchTrigger(pattern: string, value: string): boolean;
/**
 * 神经支配：一条命令 → 受它支配的器官（按得分排序）。
 * 纯确定性，零模型往返。全部无命中时交由前额叶统一决策。
 */
export declare function innervate(command: string, organs: Organ[]): Array<{
    organ: string;
    score: number;
    reason: string;
    ruleIndex: number;
}>;
/** 器官是否「活着」：至少有一项能力能在当前工具集中落实 */
export declare function organAlive(organ: Organ, tools: string[]): boolean;
/**
 * 脱器官代偿：某器官离线时，找仍然活着、能力重叠最高的器官顶上。
 * 同系统分组额外加分（同系统内的器官本来就有功能冗余）。
 * **这是「缺一个器官影响不大」的机制保证**——不是口号，是算出来的。
 */
export declare function compensateFor(missing: Organ, organs: Organ[], tools: string[]): Array<{
    organ: string;
    label: string;
    overlap: number;
}>;
/** 确定性条件求值（无 eval）：always/error/ok/slow:<ms>/hit:<sub>/miss:<sub>，|| 分组、&& 串联 */
export declare function evalCondition(cond: string, data: {
    isError: boolean;
    text: string;
    ms: number;
}): boolean;
export declare function apply(ctx: Context, config: Config): void;
