import z from 'schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
export const name = '@dsh-external/dsh-zero-residence';
// 必须与 BasicCompactionEngine 的 static inject 一致：引擎是我们手动 new 的，
// cordis 不会自动施加它的注入，缺一个就会在 pre-step 抛
// "cannot get property \"tokenMeter\" without inject" 并被基类吞成警告——压缩永不触发。
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions'];
export const Config = z.object({
    engine: z.boolean().default(true),
    narrativeHeadChars: z.number().default(120),
    jobDir: z.string().default(''),
    thresholdRatio: z.number().default(0.15),
    retainTokens: z.number().default(40000),
});
/* ─────────────────────────── 基础度量 ─────────────────────────── */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/;
/** 与 harness 自带 body_tokens 估算器同尺度（实测误差 <0.2%）。 */
function estimateTokens(text) {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        if (CJK.test(ch))
            cjk++;
        else
            other++;
    }
    return Math.round(cjk + other / 4);
}
function dshHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
/* ─────────────────── 持久会话日志读取（无损重建的底座） ─────────────────── */
const ZSTD_MAGIC = 0xFD2FB528;
/** 切分「拼接式 zstd 帧」容器（复用 DSH session-persistence-jsonl 的扫描逻辑）。 */
function scanZstdFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4)
            break;
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
            break;
        offset += 4;
        if (offset === buffer.length)
            break;
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((descriptor & 0x18) !== 0)
            break;
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 0x20) !== 0;
        const checksum = (descriptor & 0x04) !== 0;
        const dictionaryFlag = descriptor & 0x03;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        for (;;) {
            if (buffer.length - offset < 3)
                return frames;
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 0x03;
            const blockSize = blockHeader >>> 3;
            if (blockType === 0x03)
                return frames;
            const payloadBytes = blockType === 0x01 ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes)
                return frames;
            offset += payloadBytes;
            if (lastBlock)
                break;
        }
        if (checksum) {
            if (buffer.length - offset < 4)
                return frames;
            offset += 4;
        }
        frames.push({ start, end: offset });
    }
    return frames;
}
/** 定位某个会话的持久日志文件（不依赖任何 harness 内部服务）。 */
function findSessionLog(sessionId) {
    const root = join(dshHome(), 'sessions');
    if (!existsSync(root))
        return null;
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const e of entries) {
            const p = join(dir, e);
            let st;
            try {
                st = statSync(p);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                stack.push(p);
                continue;
            }
            if (!e.startsWith('session.v') || !e.includes('jsonl'))
                continue;
            if (sessionId === '' || dir.includes(sessionId))
                return p;
        }
    }
    return null;
}
function readSessionEvents(sessionId, limit = 200000) {
    const file = findSessionLog(sessionId);
    if (file === null)
        return [];
    const buf = readFileSync(file);
    const parts = [];
    if (file.endsWith('.zstd')) {
        for (const f of scanZstdFrames(buf)) {
            try {
                parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'));
            }
            catch { /* 单帧损坏不影响其余帧 */ }
        }
    }
    else {
        parts.push(buf.toString('utf8'));
    }
    const out = [];
    for (const line of parts.join('').split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch { /* 跳过撕裂行 */ }
        if (out.length >= limit)
            break;
    }
    return out;
}
/** 从一条消息里抽出它的「可重建身份」：工具名与调用 id。 */
function identify(block) {
    const tool = typeof block.name === 'string' ? block.name
        : typeof block.toolCall?.name === 'string'
            ? String(block.toolCall.name) : undefined;
    const callId = typeof block.toolCallId === 'string' ? block.toolCallId
        : typeof block.toolCall?.id === 'string'
            ? String(block.toolCall.id) : undefined;
    return { tool, callId };
}
function blockText(block) {
    if (typeof block.text === 'string')
        return block.text;
    const content = block.content;
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content.map((c) => (c !== null && typeof c === 'object' && typeof c.text === 'string'
            ? String(c.text) : '')).join('');
    }
    return '';
}
/**
 * 把一段被遮蔽的对话压成「可重建指针清单」。
 *
 * 判据（零驻留原则的落地）：
 *  · 工具结果 / 工具调用 —— 在持久日志里逐字可还原，故**只留指针**（零污染）；
 *  · 叙述类（user / assistant 正文）—— 保留头部若干字符以维持任务语义连续性。
 */
export function buildPointerManifest(messages, headChars) {
    const lines = [];
    let shadowed = 0;
    let pointerOnly = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const raw = JSON.stringify(msg);
        const tokens = estimateTokens(raw);
        shadowed += tokens;
        let kind = msg.role ?? 'unknown';
        let tool;
        let callId;
        let head = '';
        for (const b of blocks) {
            const id = identify(b);
            if (id.tool !== undefined)
                tool = id.tool;
            if (id.callId !== undefined)
                callId = id.callId;
            // 以块类型判定真实角色：工具结果常以 user 角色回传，标签必须还原语义
            if (b.type === 'tool-result')
                kind = 'tool·result';
            else if (b.type === 'tool-call' && kind !== 'tool·result')
                kind = 'assistant·call';
            const t = blockText(b);
            if (head === '' && t !== '')
                head = t;
        }
        if (tool !== undefined)
            kind = `${kind}·${tool}`;
        const recoverable = callId !== undefined;
        if (recoverable)
            pointerOnly++;
        head = head.replace(/\s+/g, ' ').slice(0, recoverable ? 0 : headChars);
        const key = recoverable ? ` key=${callId}` : '';
        const preview = head === '' ? '' : ` 「${head}${head.length >= headChars ? '…' : ''}」`;
        lines.push(`  #${i} ${kind} ≈${tokens.toLocaleString('en-US')} tok${key}${preview}`);
    }
    const total = shadowed;
    const header = [
        '[零驻留遮蔽 · Zero-Residence Shadow]',
        `本段 ${messages.length} 条消息（≈${total.toLocaleString('en-US')} token）已从上下文驱逐。`,
        '原始内容完整保存在持久会话日志中，可逐字重建——信息未丢失，只是不再驻留。',
        `其中 ${pointerOnly} 条工具载荷仅保留指针（零驻留），叙述类保留头部 ${headChars} 字符。`,
        '',
        '重建索引：',
    ];
    const footer = [
        '',
        `重建任意条目：zr_recall key=<调用id>   （返回原始内容，零驻留代价）`,
        `查看本会话账本：zr_ledger`,
    ];
    const text = [...header, ...lines, ...footer].join('\n');
    return {
        text,
        shadowedTokens: total,
        manifestTokens: estimateTokens(text),
        entries: messages.length,
        pointerOnly,
    };
}
const engineStats = { runs: 0, shadowed: 0, manifest: 0, pointerOnly: 0 };
/** 引擎挂载状态（自报，避免靠猜）。 */
let engineMounted = false;
let engineMountNote = '未尝试挂载';
/** 计数器落盘：插件重载会重建模块级状态，不落盘就会把已发生的压缩数清零。 */
function statsPath() { return join(dshHome(), 'zero-residence', 'engine-stats.json'); }
function persistStats() {
    try {
        const dir = join(dshHome(), 'zero-residence');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(statsPath(), JSON.stringify(engineStats));
    }
    catch { /* 落盘失败不影响压缩本身 */ }
}
function loadStats() {
    try {
        const p = statsPath();
        if (existsSync(p))
            Object.assign(engineStats, JSON.parse(readFileSync(p, 'utf8')));
    }
    catch { /* 首次运行无文件，保持零值 */ }
}
const probe = { calls: 0, lastTrigger: '—', lastOutcome: '尚未被调用', forced: 0 };
let forceNextCompaction = false;
/** 插件所在上下文与引擎实例，用于核实「本上下文实际解析到的 compaction 是谁」。 */
let boundCtx = null;
let engineInstance = null;
/**
 * 覆写 `summarize()` 的确定性实现：不调用 LLM，直接把遮蔽区压成指针清单。
 * 返回 unmarked 形态（`llmStreamCall` 缺省）——该分支正是为非 LLM 摘要器预留的。
 */
class ZeroResidenceEngine extends BasicCompactionEngine {
    headChars;
    constructor(ctx, config, headChars) {
        super(ctx, config);
        this.headChars = headChars;
    }
    /**
     * 探针 + 强制触发。默认仍走基类的比例阈值；但可用 `zr_compact` 置位强制开关，
     * 下一步的 pre-step 会改走 `context-overflow` 路径——按官方契约该路径
     * "may force a useful balanced reduction even below the normal threshold"。
     */
    async compactIfNeeded(agent, trigger, signal) {
        probe.calls++;
        probe.lastTrigger = trigger;
        try {
            const useTrigger = forceNextCompaction ? 'context-overflow' : trigger;
            if (forceNextCompaction) {
                forceNextCompaction = false;
                probe.forced++;
            }
            const result = await super.compactIfNeeded(agent, useTrigger, signal);
            probe.lastOutcome = result === null
                ? `${useTrigger}: 返回 null（未达阈值或无可安全压缩区）`
                : `${useTrigger}: 遮蔽 ${result.shadowedTokenCount} token（seqs ${result.shadowedRange.start}–${result.shadowedRange.end}）`;
            return result;
        }
        catch (error) {
            probe.lastOutcome = `抛错：${error instanceof Error ? error.message : String(error)}`;
            throw error;
        }
    }
    async summarize(input, _agent, _signal) {
        const built = buildPointerManifest(input.messages, this.headChars);
        engineStats.runs++;
        engineStats.shadowed += built.shadowedTokens;
        engineStats.manifest += built.manifestTokens;
        engineStats.pointerOnly += built.pointerOnly;
        persistStats();
        const block = { type: 'text', text: built.text };
        return {
            summary: [block],
            provider: 'zero-residence',
            model: 'deterministic-pointer',
            rawOutput: [block],
        };
    }
}
function readTail(file, chars) {
    if (!existsSync(file))
        return '';
    const text = readFileSync(file, 'utf8');
    return text.length <= chars ? text : `…（已截断前 ${text.length - chars} 字符）\n${text.slice(-chars)}`;
}
/** 从会话日志里按调用 id 还原被遮蔽的工具原文。 */
function recallByCallId(callId) {
    for (const sessionId of listSessionIds()) {
        for (const ev of readSessionEvents(sessionId, 40000)) {
            if (ev.type !== 'tool/result' && ev.type !== 'tool/call')
                continue;
            const serialized = JSON.stringify(ev.data ?? {});
            if (!serialized.includes(callId))
                continue;
            return { text: serialized, source: `${sessionId}/${ev.type}#${ev.seq ?? '?'}` };
        }
    }
    return null;
}
function listSessionIds() {
    const root = join(dshHome(), 'sessions');
    if (!existsSync(root))
        return [];
    const ids = [];
    const stack = [root];
    while (stack.length > 0 && ids.length < 80) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const e of entries) {
            const p = join(dir, e);
            let st;
            try {
                st = statSync(p);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                if (e.startsWith('session-')) {
                    ids.push(e);
                    continue;
                }
                stack.push(p);
            }
        }
    }
    return ids;
}
/**
 * 核实「本插件上下文实际解析到的 compaction 服务是谁」——避免把「构造成功」
 * 误当成「agent 循环真的在用我的引擎」。
 */
function resolveCompactionOwner() {
    const c = boundCtx;
    if (c === null || c.compaction === undefined)
        return '无法解析（ctx.compaction 不可见）';
    const name = c.compaction.constructor?.name ?? '未知';
    // 按构造函数名判定（插件重载会换实例，instanceof 不可靠）
    if (name === 'ZeroResidenceEngine') {
        const same = engineInstance !== null && c.compaction === engineInstance;
        return `${name} ✅ 零驻留引擎在管（${same ? '同一实例' : '重载后的实例，属正常'}）`;
    }
    return `${name} ⚠️ 仍是基础引擎，零驻留未接管`;
}
/** 当前会话的驻留账本：读持久日志重算 A 与三段分解。 */
export function computeLedger(sessionId) {
    const events = readSessionEvents(sessionId);
    if (events.length === 0)
        return `未找到会话日志：${sessionId}（DSH_HOME=${dshHome()}）`;
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const APPEND = new Set(['user/message', 'assistant/message', 'tool/result', 'agent/inbox/spliced']);
    let systemTok = 0;
    let histTok = 0;
    const steps = [];
    let toolsSum = 0;
    let sysSum = 0;
    let histSum = 0;
    for (const ev of events) {
        const t = ev.type ?? '';
        if (t === 'system/message') {
            systemTok = estimateTokens(JSON.stringify(ev.data ?? {}));
            continue;
        }
        if (APPEND.has(t)) {
            histTok += estimateTokens(JSON.stringify(ev.data ?? {}));
            continue;
        }
        if (t === 'request/header') {
            const header = (ev.data ?? {});
            const toolsTok = estimateTokens(JSON.stringify(header.header ?? {}));
            steps.push(1);
            toolsSum += toolsTok;
            sysSum += systemTok;
            histSum += histTok;
        }
    }
    const T = steps.length;
    const A = toolsSum + sysSum + histSum;
    const fmt = (n) => Math.round(n).toLocaleString('en-US');
    const pct = (n) => (A === 0 ? '0.0' : ((n / A) * 100).toFixed(1));
    return [
        `# 驻留账本 · ${sessionId}`,
        `模型请求数 T = ${T}`,
        `A = Σ n_t = ${fmt(A)} token （≈${(A / 1e6).toFixed(1)}M）`,
        `  ├ 请求头（工具 schema 等） ${pct(toolsSum)}%`,
        `  ├ system 前缀（每步重发） ${pct(sysSum)}%`,
        `  └ 历史重发（累积）        ${pct(histSum)}%`,
        '',
        `压缩引擎状态：${engineMounted ? '✅' : '⚠️'} ${engineMountNote}`,
        `pre-step 压缩钩子：被调用 ${probe.calls} 次｜最近 trigger=${probe.lastTrigger}｜结果：${probe.lastOutcome}｜强制触发 ${probe.forced} 次`,
        `本上下文 compaction 实际解析到：${resolveCompactionOwner()}`,
        `零驻留引擎已运行 ${engineStats.runs} 次，累计遮蔽 ${fmt(engineStats.shadowed)} token，`,
        `生成清单 ${fmt(engineStats.manifest)} token（压缩比 ${engineStats.shadowed === 0 ? 'n/a' : (engineStats.shadowed / Math.max(1, engineStats.manifest)).toFixed(1)}×），`,
        `其中 ${engineStats.pointerOnly} 条走纯指针（零驻留）。`,
    ].join('\n');
}
/* ─────────────────────────── 插件入口 ─────────────────────────── */
export function apply(ctx, config) {
    boundCtx = ctx;
    loadStats();
    const headChars = config.narrativeHeadChars;
    const jobRoot = config.jobDir !== '' ? config.jobDir : join(dshHome(), 'zero-residence', 'jobs');
    const jobs = new Map();
    try {
        mkdirSync(jobRoot, { recursive: true });
    }
    catch { /* 目录已存在或不可写，工具调用时再报 */ }
    const outStr = {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: String(v) }],
    };
    /* ① 零驻留压缩引擎：覆盖本上下文的 compaction 服务 */
    if (config.engine) {
        try {
            const engine = new ZeroResidenceEngine(ctx, {
                auto: true,
                thresholdRatio: config.thresholdRatio,
                retainTokens: config.retainTokens,
            }, headChars);
            engineInstance = engine;
            engineMounted = true;
            engineMountNote = '已挂载';
            ctx.logger.info('[zero-residence] 已挂载零驻留压缩引擎（确定性指针压缩，零 LLM 调用）');
            ctx.effect(() => () => { void engine; }, 'zero-residence: compaction engine');
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            engineMounted = false;
            engineMountNote = `挂载失败，降级为仅工具模式：${msg}`;
            ctx.logger.warn(`[zero-residence] 引擎挂载失败，降级为仅工具模式：${msg}`);
        }
    }
    /* ② zr_ledger —— 驻留账本 */
    const ledger = defineTool({
        name: 'zr_ledger',
        description: '零驻留账本：计算指定会话的注意力积分 A（=Σ 每步上下文大小）与三段成本分解，'
            + '并报告零驻留引擎已遮蔽的 token 与压缩比。用 session 指定会话 id，留空则自动选取最近的会话。',
        parameters: {
            session: { type: 'string', description: '会话 id 或目录名子串，留空 = 最近会话' },
        },
        output: outStr,
        async execute(args) {
            const wanted = args.session ?? '';
            const ids = listSessionIds();
            const target = wanted === '' ? ids[0] : ids.find((i) => i.includes(wanted)) ?? wanted;
            if (target === undefined || target === '')
                return '未找到任何会话日志。';
            return computeLedger(target);
        },
    });
    ctx.effect(() => ctx.tools.register(ledger), 'zero-residence: zr_ledger');
    /* ③ zr_recall —— 无损重建（零驻留的另一半：驱逐≠丢失） */
    const recall = defineTool({
        name: 'zr_recall',
        description: '重建被零驻留遮蔽的原始内容：按工具调用 id（key）或会话 seq 从持久会话日志中逐字还原。'
            + '被 zr 遮蔽的内容只是不再驻留，从未丢失——需要原文时用它取回。',
        parameters: {
            key: { type: 'string', description: '工具调用 id（被遮蔽清单里的 key=...）' },
            session: { type: 'string', description: '限定会话（可选，加速检索）' },
            maxChars: { type: 'number', description: '返回上限字符数，默认 6000' },
        },
        output: outStr,
        async execute(args) {
            const found = recallByCallId(args.key);
            if (found === null)
                return `未在持久日志中找到 key=${args.key} 的原始内容。`;
            const cap = args.maxChars ?? 6000;
            const body = found.text.length > cap ? `${found.text.slice(0, cap)}\n…（共 ${found.text.length} 字符，已截断）` : found.text;
            return `# zr_recall · ${args.key}\n来源: ${found.source}\n\n${body}`;
        },
    });
    ctx.effect(() => ctx.tools.register(recall), 'zero-residence: zr_recall');
    /* ④ zr_compact —— 武装下一次强制压缩（绕过比例阈值），用于在线验证引擎真的会跑 */
    const compactTool = defineTool({
        name: 'zr_compact',
        description: '武装「下一次 pre-step 强制压缩」：绕过比例阈值，改走 context-overflow 路径触发一次真实压缩。'
            + '用于在线验证零驻留引擎（触发后引擎运行数应 +1、遮蔽 token > 0，且全程无 LLM 摘要调用）。'
            + 'action=arm 武装 / action=probe 只看钩子探针。',
        parameters: {
            action: { type: 'string', description: 'arm / probe' },
        },
        output: outStr,
        async execute(args) {
            if (args.action === 'arm') {
                forceNextCompaction = true;
                return '已武装：下一次 agent/pre-step 将强制压缩一次（走 context-overflow 路径）。\n'
                    + '下一步结束后用 zr_ledger 查看「压缩引擎运行数」与「pre-step 钩子探针」。';
            }
            return `pre-step 钩子：被调用 ${probe.calls} 次｜最近 trigger=${probe.lastTrigger}\n`
                + `结果：${probe.lastOutcome}\n强制触发 ${probe.forced} 次｜武装中=${forceNextCompaction}`;
        },
    });
    ctx.effect(() => ctx.tools.register(compactTool), 'zero-residence: zr_compact');
    /* ④ zr_fast —— 异步效应器：把阻塞式长命令变成即返句柄（延迟靶心 = pwsh 79%） */
    const fast = defineTool({
        name: 'zr_fast',
        description: '异步执行 shell 命令并立即返回句柄，绝不阻塞。用于任何可能超过 ~5 秒的命令'
            + '（构建、扫描、爬取、批量 IO）。action=run 启动；action=check 查状态与输出尾部；action=list 列句柄。',
        parameters: {
            action: { type: 'string', description: 'run / check / list' },
            command: { type: 'string', description: 'action=run 时执行的命令（PowerShell）' },
            id: { type: 'string', description: 'action=check 时的句柄 id' },
            tailChars: { type: 'number', description: '输出尾部字符数，默认 3000' },
        },
        output: outStr,
        async execute(args) {
            if (args.action === 'run') {
                if (args.command === undefined || args.command.trim() === '')
                    return '缺少 command。';
                const id = `zr${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
                const file = join(jobRoot, `${id}.log`);
                let fd;
                try {
                    fd = openSync(file, 'w');
                }
                catch (error) {
                    return `无法创建输出文件：${error instanceof Error ? error.message : String(error)}`;
                }
                let child;
                try {
                    // 注意：本机实测 `detached: true` 会让子进程秒退（exit 0、零输出），
                    // 故只用 windowsHide 保证无窗口，不脱离父进程。详见 scripts/spawn-probe2.mjs。
                    child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', args.command], {
                        windowsHide: true,
                        stdio: ['ignore', fd, fd],
                    });
                }
                catch (error) {
                    closeSync(fd);
                    return `启动失败：${error instanceof Error ? error.message : String(error)}`;
                }
                child.on('exit', (code) => {
                    try {
                        closeSync(fd);
                    }
                    catch { /* 已关闭 */ }
                    const r = jobs.get(id);
                    if (r)
                        r.exitCode = code;
                    // 落盘退出码，使 check 在插件重载后仍能判定完成
                    try {
                        writeFileSync(`${file}.exit`, String(code ?? -1));
                    }
                    catch { /* 落盘失败不影响主流程 */ }
                });
                child.unref();
                jobs.set(id, { id, command: args.command, pid: child.pid ?? -1, file, startedAt: Date.now(), exitCode: null });
                return `已异步启动。句柄 id=${id}（pid ${child.pid ?? '?'}），输出 → ${file}\n`
                    + `立即用 zr_fast action=check id=${id} 查看进度；不要在等待期间空转。`;
            }
            if (args.action === 'check') {
                if (args.id === undefined)
                    return '缺少 id。';
                const rec = jobs.get(args.id);
                if (rec === undefined)
                    return `未知句柄 ${args.id}（本进程只记得住本次运行启动的句柄）。`;
                // 退出码以落盘文件为准（内存态在插件重载后不保）
                const exitFile = `${rec.file}.exit`;
                const code = rec.exitCode ?? (existsSync(exitFile) ? Number(readFileSync(exitFile, 'utf8').trim()) : null);
                const alive = code === null || Number.isNaN(code);
                const tail = readTail(rec.file, args.tailChars ?? 3000);
                return `# ${rec.id}  ${alive ? '运行中' : `已结束 (exit ${code})`}\n命令: ${rec.command}\n耗时: ${((Date.now() - rec.startedAt) / 1000).toFixed(1)}s\n\n${tail}`;
            }
            if (args.action === 'list') {
                if (jobs.size === 0)
                    return '本次运行尚无句柄。';
                return [...jobs.values()].map((r) => `${r.id}  ${r.exitCode === null ? '运行中' : `exit ${r.exitCode}`}  ${((Date.now() - r.startedAt) / 1000).toFixed(0)}s  ${r.command.slice(0, 70)}`).join('\n');
            }
            return `未知 action: ${args.action}（支持 run / check / list）`;
        },
    });
    ctx.effect(() => ctx.tools.register(fast), 'zero-residence: zr_fast');
    ctx.logger.info('[zero-residence] 已上线：指针压缩引擎 + zr_ledger / zr_recall / zr_fast');
}
export default { name, inject, Config, apply };
//# sourceMappingURL=index.js.map