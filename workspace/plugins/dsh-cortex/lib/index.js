import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from 'schemastery';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const name = '@dsh-external/dsh-cortex';
export const inject = ['tools'];
export const Config = z.object({
    enabled: z.boolean().default(true),
    sleepAfterMs: z.number().default(120000),
    deepAfterMs: z.number().default(300000),
    autoSleep: z.boolean().default(true),
    consolidateGapMs: z.number().default(120000),
    tickMs: z.number().default(3000),
    memoryRecall: z.boolean().default(true),
    recallLimit: z.number().default(3),
    memoryHalfLifeMs: z.number().default(604800000),
    archiveBelow: z.number().default(0.08),
    bufferMax: z.number().default(400),
    noiseWindowMs: z.number().default(60000),
    noiseConvergeAt: z.number().default(5),
});
// ═══════════════════════════ 数据根 ═══════════════════════════
function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function dataDir() {
    const d = join(dshHome(), 'plugins', 'dsh-cortex');
    if (!existsSync(d))
        mkdirSync(d, { recursive: true });
    return d;
}
function memoryFile() { return join(dataDir(), 'memory.jsonl'); }
function stateFile() { return join(dataDir(), 'state.json'); }
function clock() { return Date.now(); }
function stamp(t) { return new Date(t).toISOString().slice(11, 19); }
function dayKey(t) { return new Date(t).toISOString().slice(0, 10); }
export const KIND_LABEL = {
    pitfall: '坑',
    playbook: '打法',
    hotspot: '薄弱环节',
    unresolved: '未解',
    fact: '事实',
};
// ═══════════════════════════ 纯工具 ═══════════════════════════
function readJson(file, fallback) {
    try {
        if (!existsSync(file))
            return fallback;
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function writeJson(file, data) {
    try {
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    }
    catch { /* 稳态优先：落盘失败不抛 */ }
}
const STOP = new Set([
    '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '可以', '需要', '一个', '就是',
    '还是', '因为', '所以', '但是', '如果', '已经', '现在', '时候', '自己', '东西', '这些',
    '那些', '没有', '完成', '进行', '使用', '通过', '由于', '然后', '一下', '不是', '起来',
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'not', 'are', 'was',
    'were', 'you', 'your', 'can', 'will', 'but', 'all', 'any', 'its', 'out', 'get', 'into',
]);
/**
 * 轻量分词：英文/数字按词、中文按 2-gram。只用于记忆的匹配与标签，
 * 不做任何语义推断——皮层是确定性器官，判断留给大脑。
 */
export function tokens(input) {
    const out = new Set();
    const text = String(input ?? '').toLowerCase();
    for (const w of text.match(/[a-z0-9_.\-]{2,}/g) ?? []) {
        if (!STOP.has(w))
            out.add(w);
    }
    const cjk = text.replace(/[^\u4e00-\u9fa5]/g, ' ');
    for (const seg of cjk.split(/\s+/)) {
        if (seg.length < 2)
            continue;
        if (seg.length === 2) {
            if (!STOP.has(seg))
                out.add(seg);
            continue;
        }
        for (let i = 0; i + 2 <= seg.length; i++) {
            const g = seg.slice(i, i + 2);
            if (!STOP.has(g))
                out.add(g);
        }
    }
    return [...out].slice(0, 80);
}
/** 告警归一化：抹掉数字与列表差异，让「同一条告警」稳定收敛到同一个 key */
export function normalizeNote(note) {
    return String(note ?? '')
        .replace(/\d+/g, '#')
        .replace(/[，。、；：！？]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}
export function cardId(kind, key) {
    return `${kind}:${key.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 90)}`;
}
/**
 * 稳态告警降噪的确定性内核——**告警的价值在变化，不在重复**。
 * 同一条告警在窗口内重复只计数；反复出现且从未自愈的收敛为「已知稳态偏移」并静默。
 * 收敛后再重复既不计入抑制也不刷屏：让它彻底安静下来，把音量还给真正的异常。
 */
export function reduceNoise(noise, alerts, now, windowMs, convergeAt) {
    const converged = [];
    let suppressed = 0;
    for (const raw of alerts ?? []) {
        const note = String(raw?.note ?? '');
        const key = `${String(raw?.organ ?? '?')}::${normalizeNote(note)}`;
        const e = noise[key] ?? { count: 0, first: now, last: 0, silenced: false, sample: note.slice(0, 160) };
        const withinWindow = now - e.last < windowMs;
        e.count += 1;
        e.last = now;
        if (e.silenced) {
            // 已收敛的偏移：不再计入抑制，也不再刷屏
        }
        else if (withinWindow) {
            suppressed += 1;
        }
        else if (e.count >= convergeAt) {
            e.silenced = true;
            converged.push(key);
        }
        noise[key] = e;
    }
    return { noise, suppressed, converged };
}
/**
 * 从一段经历里提炼可长期复用的模式——**巩固的确定性内核，零模型调用**。
 * 四类产物：反复踩的坑 / 跑通的链路 / 高频低成功率的薄弱环节 / 失败后悬空未解的事。
 * @param since 只对该时刻之后**又发生过**的模式建卡，避免重复扫同一段经历把权重刷虚。
 */
export function extractPatterns(evs, since, now) {
    const pitfalls = [];
    const playbooks = [];
    const hotspots = [];
    const unresolved = [];
    // ── 坑：同一工具连续失败 ≥3 ──
    let run = null;
    const failRuns = [];
    const flush = () => {
        if (run && run.count >= 3)
            failRuns.push(run);
        run = null;
    };
    for (const e of evs) {
        if (!e.ok) {
            if (run && run.tool === e.tool) {
                run.count += 1;
                run.err = e.err || run.err;
                run.at = e.t;
            }
            else {
                flush();
                run = { tool: e.tool, count: 1, err: e.err, at: e.t };
            }
        }
        else
            flush();
    }
    flush();
    for (const f of failRuns) {
        if (f.at <= since)
            continue;
        pitfalls.push({
            id: cardId('pitfall', f.tool),
            t: f.at,
            kind: 'pitfall',
            title: `${f.tool} 连续失败 ${f.count} 次`,
            body: `错误：${f.err || '（无错误信息）'}\n处置：先核参数与路径，再换工具或换器官；不要原地重试。`,
            tags: [f.tool, ...tokens(f.err).slice(0, 8)],
            weight: 1 + Math.min(2, f.count / 3),
            uses: 0, lastUsed: 0, source: 'sleep',
        });
    }
    // ── 打法：重复出现的成功链路（n-gram，n=2..4） ──
    const okEvs = evs.filter(e => e.ok);
    const grams = new Map();
    for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= okEvs.length; i++) {
            const slice = okEvs.slice(i, i + n);
            const g = slice.map(e => e.tool).join(' → ');
            const lastT = slice[slice.length - 1]?.t ?? now;
            const cur = grams.get(g) ?? { count: 0, last: 0 };
            cur.count += 1;
            cur.last = Math.max(cur.last, lastT);
            grams.set(g, cur);
        }
    }
    const plays = [...grams.entries()]
        .filter(([g, v]) => {
        if (v.count < 2 || v.last <= since)
            return false;
        // 排除「同一个工具连做几次」这类平凡链路——它们不含可复用的顺序信息
        return new Set(g.split(' → ')).size >= 2;
    })
        .sort((a, b) => {
        const distinct = (g) => new Set(g.split(' → ')).size;
        return (distinct(b[0]) - distinct(a[0])) || (b[1].count - a[1].count);
    })
        .slice(0, 5);
    for (const [g, v] of plays) {
        playbooks.push({
            id: cardId('playbook', g),
            t: v.last,
            kind: 'playbook',
            title: `链路 ${g}`,
            body: `这条链路在一次经历中跑通 ${v.count} 次。同类任务可直接复用，不必重新摸索顺序。`,
            tags: tokens(g),
            weight: 1 + Math.min(2, v.count / 3),
            uses: 0, lastUsed: 0, source: 'sleep',
        });
    }
    // ── 薄弱环节：高频但成功率偏低 ──
    const perTool = new Map();
    for (const e of evs) {
        const s = perTool.get(e.tool) ?? { ok: 0, fail: 0, ms: 0 };
        if (e.ok)
            s.ok += 1;
        else
            s.fail += 1;
        s.ms += e.ms;
        perTool.set(e.tool, s);
    }
    for (const [tool, s] of perTool) {
        const total = s.ok + s.fail;
        if (total < 8)
            continue;
        const rate = s.ok / total;
        if (rate >= 0.7)
            continue;
        hotspots.push({
            id: cardId('hotspot', tool),
            t: now,
            kind: 'hotspot',
            title: `${tool} 是薄弱环节（成功率 ${(rate * 100).toFixed(0)}%）`,
            body: `共调用 ${total} 次：成功 ${s.ok}、失败 ${s.fail}，平均 ${Math.round(s.ms / total)}ms。\n用法上多留一步校验，或考虑换能力重叠的其他器官。`,
            tags: [tool],
            weight: 1.2,
            uses: 0, lastUsed: 0, source: 'sleep',
        });
    }
    // ── 未解：最后一次成功之后，再没走通过 ──
    const tail = evs.slice(-60);
    const lastOkAt = tail.filter(e => e.ok).reduce((acc, e) => Math.max(acc, e.t), 0);
    const dangling = tail.filter(e => !e.ok && e.t > lastOkAt);
    if (dangling.length >= 3) {
        const names = [...new Set(dangling.map(e => e.tool))].join('、');
        unresolved.push({
            id: cardId('unresolved', names),
            t: dangling[dangling.length - 1]?.t ?? now,
            kind: 'unresolved',
            title: `悬而未决：${names}`,
            body: `最后一次成功之后累计 ${dangling.length} 次失败，始终没有走通。\n下次遇到先换路径，别沿着这条死路再走一遍。`,
            tags: tokens(names),
            weight: 1.5,
            uses: 0, lastUsed: 0, source: 'sleep',
        });
    }
    return { pitfalls, playbooks, hotspots, unresolved };
}
function extractText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content.map(c => {
            if (typeof c === 'string')
                return c;
            if (c && typeof c === 'object' && typeof c.text === 'string')
                return c.text;
            return '';
        }).join(' ').trim();
    }
    return '';
}
/** 取本会话最后一条真人输入（kind:'user' 才是操作者本人，plugin/tool 都是注入） */
function latestHuman(events) {
    if (!Array.isArray(events))
        return null;
    let best = null;
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e || e.type !== 'user/message')
            continue;
        if (e.data?.source?.kind !== 'user')
            continue;
        const text = extractText(e.data?.content);
        if (!text)
            continue;
        const seq = Number(e.seq ?? i);
        if (!best || seq > best.seq)
            best = { text, seq };
    }
    return best;
}
// ═══════════════════════════ 主体 ═══════════════════════════
export function apply(ctx, config) {
    if (!config.enabled)
        return;
    // ── 活体状态 ──
    const buffer = [];
    let memories = [];
    let state = {
        phase: 'awake',
        lastActivityAt: clock(),
        lastConsolidateAt: 0,
        sleepStartedAt: 0,
        reports: [],
        rhythm: {},
        noise: {},
        stats: { consolidations: 0, cardsCreated: 0, recalls: 0, noiseSuppressed: 0 },
    };
    let lastPersistAt = 0;
    let lastMemoryPersistAt = 0;
    const recalledKeyBySession = new Map();
    let stopped = false;
    // ── 加载 ──
    function loadMemories() {
        memories = [];
        try {
            if (!existsSync(memoryFile()))
                return;
            for (const line of readFileSync(memoryFile(), 'utf8').split('\n')) {
                const s = line.trim();
                if (!s)
                    continue;
                try {
                    memories.push(JSON.parse(s));
                }
                catch { /* 跳过坏行，记忆不许拖垮皮层 */ }
            }
        }
        catch { /* 忽略 */ }
    }
    /**
     * 记忆落盘。throttled=true 时 30 秒内只写一次——召回是**读操作**，
     * 只更新「用过几次」，不该每读一次就落一次盘（否则外部清理会被立刻写回）。
     */
    function persistMemories(throttled = false) {
        if (throttled && clock() - lastMemoryPersistAt < 30000)
            return;
        lastMemoryPersistAt = clock();
        try {
            writeFileSync(memoryFile(), memories.map(m => JSON.stringify(m)).join('\n') + (memories.length ? '\n' : ''), 'utf8');
        }
        catch { /* 忽略 */ }
    }
    function loadState() {
        const s = readJson(stateFile(), {});
        state = {
            phase: 'awake',
            lastActivityAt: clock(),
            lastConsolidateAt: Number(s.lastConsolidateAt ?? 0),
            sleepStartedAt: 0,
            reports: Array.isArray(s.reports) ? s.reports.slice(-20) : [],
            rhythm: (s.rhythm && typeof s.rhythm === 'object') ? s.rhythm : {},
            noise: (s.noise && typeof s.noise === 'object') ? s.noise : {},
            stats: {
                consolidations: Number(s.stats?.consolidations ?? 0),
                cardsCreated: Number(s.stats?.cardsCreated ?? 0),
                recalls: Number(s.stats?.recalls ?? 0),
                noiseSuppressed: Number(s.stats?.noiseSuppressed ?? 0),
            },
        };
    }
    function persistState(force = false) {
        if (!force && clock() - lastPersistAt < 10000)
            return;
        lastPersistAt = clock();
        writeJson(stateFile(), state);
    }
    loadMemories();
    loadState();
    // ═══════════ ① 唤醒 / 睡眠 ═══════════
    /** 节律记事簿：入睡/醒来/巩固/收敛这些「一天的转折」按时间记下来 */
    const rhythmNotes = [];
    function pushRhythmNote(note) {
        rhythmNotes.push(`[${stamp(clock())}] ${note}`);
        if (rhythmNotes.length > 40)
            rhythmNotes.splice(0, rhythmNotes.length - 40);
    }
    /** 任何一次器官活动 = 清醒信号（皮层因此知道「身体在干活」） */
    function awaken(reason) {
        const wasAsleep = state.phase !== 'awake';
        if (wasAsleep) {
            const last = state.reports[state.reports.length - 1];
            if (last && !last.wokeAt) {
                last.wokeAt = clock();
                last.durationMs = last.wokeAt - last.enteredAt;
            }
        }
        state.phase = 'awake';
        state.sleepStartedAt = 0;
        state.lastActivityAt = clock();
        if (wasAsleep) {
            const r = state.reports[state.reports.length - 1];
            if (r)
                pushRhythmNote(`☀️ 醒来（${reason}）：睡了 ${fmtDur(r.durationMs)}，巩固 ${r.created} 新建 / ${r.reinforced} 强化 / ${r.archived} 归档`);
        }
        persistState();
    }
    function fmtDur(ms) {
        if (ms < 1000)
            return `${ms}ms`;
        const s = Math.round(ms / 1000);
        if (s < 60)
            return `${s} 秒`;
        const m = Math.floor(s / 60);
        if (m < 60)
            return `${m} 分 ${s % 60} 秒`;
        return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
    }
    /** 记录一次「清醒信号」。why 只作诊断——睡不着时得能一眼看出是谁在刷活动。 */
    function markActivity(why) {
        state.lastActivityAt = clock();
        state.lastActivityWhy = why;
        if (state.phase !== 'awake')
            awaken(why);
        const d = dayKey(clock());
        const hour = new Date().getHours();
        const arr = state.rhythm[d] ?? new Array(24).fill(0);
        arr[hour] = (arr[hour] ?? 0) + 1;
        state.rhythm[d] = arr;
        // 只留最近 7 天
        const keys = Object.keys(state.rhythm).sort();
        while (keys.length > 7) {
            const k = keys.shift();
            if (k)
                delete state.rhythm[k];
        }
    }
    // ═══════════ ② 巩固（睡眠中真正发生的事） ═══════════
    /** 写入或强化一张记忆卡；返回 true 表示新建 */
    function upsert(card, reinforce) {
        const cur = memories.find(m => m.id === card.id);
        if (cur) {
            if (reinforce)
                cur.weight = Math.min(10, cur.weight + 1);
            cur.body = card.body;
            if (cur.archived)
                cur.archived = false;
            return false;
        }
        memories.push(card);
        return true;
    }
    /**
     * 巩固：把一段经历提炼成长期记忆。全程确定性，零模型调用。
     * 四类产物——反复踩的坑 / 跑通的链路 / 高频低成功率的薄弱环节 / 失败后悬空的未解之事。
     */
    function consolidate(reason, enteredAt, deepest) {
        const now = clock();
        const evs = buffer.slice();
        const notes = [];
        let created = 0;
        let reinforced = 0;
        const since = state.lastConsolidateAt;
        // 提炼：四类模式全部交给确定性内核（纯函数，可离线回归）
        const pat = extractPatterns(evs, since, now);
        for (const card of pat.pitfalls) {
            if (upsert(card, true)) {
                created += 1;
                notes.push(`坑：${card.title}`);
            }
            else
                reinforced += 1;
        }
        for (const card of pat.playbooks) {
            if (upsert(card, true)) {
                created += 1;
                notes.push(`打法：${card.title}`);
            }
            else
                reinforced += 1;
        }
        for (const card of pat.hotspots) {
            if (upsert(card, false)) {
                created += 1;
                notes.push(`薄弱：${card.title}`);
            }
            else
                reinforced += 1;
        }
        for (const card of pat.unresolved) {
            if (upsert(card, true)) {
                created += 1;
                notes.push(`未解：${card.title}`);
            }
            else
                reinforced += 1;
        }
        // ── 遗忘：久未使用的记忆按半衰期衰减，越线归档 ──
        let archived = 0;
        for (const m of memories) {
            if (m.archived)
                continue;
            const anchor = m.lastUsed || m.t;
            const dt = Math.max(0, now - anchor);
            m.weight *= Math.pow(0.5, dt / config.memoryHalfLifeMs);
            if (m.weight < config.archiveBelow) {
                m.archived = true;
                archived += 1;
            }
        }
        persistMemories();
        state.lastConsolidateAt = clock();
        state.stats.consolidations += 1;
        state.stats.cardsCreated += created;
        const report = {
            t: now, enteredAt, wokeAt: 0, deepest,
            durationMs: 0, scanned: evs.length, created, reinforced, archived, notes: notes.slice(0, 12),
        };
        state.reports.push(report);
        if (state.reports.length > 20)
            state.reports.splice(0, state.reports.length - 20);
        persistState(true);
        pushRhythmNote(`😴 巩固（${reason}）：扫描 ${evs.length} 段经历 → 新建 ${created} / 强化 ${reinforced} / 归档 ${archived}`);
        return report;
    }
    // ═══════════ ③ 召回 ═══════════
    /** 按文本召回最相关的记忆卡（确定性打分：标签 > 标题 > 正文，再乘权重） */
    function recall(text, limit) {
        const q = tokens(text);
        if (!q.length)
            return [];
        const scored = [];
        for (const m of memories) {
            if (m.archived)
                continue;
            let s = 0;
            for (const tk of q) {
                if (m.tags.some(x => x === tk))
                    s += 3;
                else if (m.tags.some(x => x.length >= 3 && (x.includes(tk) || tk.includes(x))))
                    s += 1.5;
                if (m.title.toLowerCase().includes(tk))
                    s += 2;
                else if (m.body.toLowerCase().includes(tk))
                    s += 1;
            }
            if (s <= 0)
                continue;
            scored.push({ m, s: s * (0.5 + m.weight) });
        }
        return scored.sort((a, b) => b.s - a.s).slice(0, Math.max(1, limit)).map(x => x.m);
    }
    // ═══════════ ④ 稳态降噪 ═══════════
    /**
     * 采集稳态告警：窗口内重复只计数；反复出现且从未自愈的收敛为「已知稳态偏移」并静默。
     * 告警的意义在于变化，噪音只会让真异常被淹没。
     */
    function ingestAlerts(list) {
        if (!Array.isArray(list))
            return;
        const r = reduceNoise(state.noise, list, clock(), config.noiseWindowMs, config.noiseConvergeAt);
        state.noise = r.noise;
        state.stats.noiseSuppressed += r.suppressed;
        for (const k of r.converged) {
            pushRhythmNote(`🔇 收敛为已知稳态偏移（重复 ${config.noiseConvergeAt} 次）：${k.slice(0, 90)}`);
        }
        persistState();
    }
    // ═══════════ 相位巡检（心脏之外的第二个时钟：昼夜节律） ═══════════
    ctx.effect(() => {
        const timer = setInterval(() => {
            if (stopped)
                return;
            try {
                const idle = clock() - state.lastActivityAt;
                const prev = state.phase;
                let next = 'awake';
                if (idle >= config.deepAfterMs)
                    next = 'deep';
                else if (idle >= config.sleepAfterMs)
                    next = 'light';
                if (!config.autoSleep && next !== 'awake')
                    next = state.phase === 'awake' ? 'awake' : state.phase;
                if (prev === 'awake' && next !== 'awake') {
                    state.sleepStartedAt = clock();
                    pushRhythmNote(`🌙 入睡（${next === 'deep' ? '深睡' : '浅睡'}）`);
                }
                state.phase = next;
                if (state.phase === 'deep' && clock() - state.lastConsolidateAt >= config.consolidateGapMs) {
                    const hasNew = buffer.some(e => e.t > state.lastConsolidateAt);
                    if (hasNew)
                        consolidate('深睡巩固', state.sleepStartedAt || clock(), 'deep');
                }
                persistState();
            }
            catch { /* 节律钟绝不因单次异常停摆 */ }
        }, Math.max(1000, config.tickMs));
        return () => { clearInterval(timer); stopped = true; };
    }, 'cortex: sleep-wake pacemaker');
    // ═══════════ 信号接入 ═══════════
    // 信号 A：每次工具结果 = 清醒信号 + 经历记录
    ctx.effect(() => ctx.on('tools/result', ((exec, result) => {
        try {
            const ex = exec;
            const toolName = String(ex?.name ?? '');
            if (!toolName)
                return;
            const r = result;
            const isError = Boolean(r?.isError);
            buffer.push({
                t: clock(),
                tool: toolName,
                ok: !isError,
                ms: 0,
                err: String(r?.error?.message ?? '').slice(0, 240),
            });
            if (buffer.length > config.bufferMax)
                buffer.splice(0, buffer.length - config.bufferMax);
            // 工具调用**不算清醒信号**——只记录成经历。定义「醒着」的是会话推进（见信号 A0）：
            // 系统内部的后台工具（如零驻留的维护调用）会周期性自触发，若按它们计时，皮层永远睡不着。
        }
        catch { /* 皮层绝不影响主流程 */ }
    })), 'cortex: tools/result listener');
    // 信号 A2：时延观测（只测不改）
    ctx.effect(() => ctx.on('tools/post-execute', (async (exec, _result, next) => {
        const started = clock();
        try {
            return await next();
        }
        finally {
            const name = String(exec?.name ?? '');
            const ms = clock() - started;
            for (let i = buffer.length - 1; i >= 0 && i > buffer.length - 6; i--) {
                const e = buffer[i];
                if (e && e.tool === name && e.ms === 0) {
                    e.ms = ms;
                    break;
                }
            }
        }
    })), 'cortex: latency probe');
    // 信号 B：接上 organism 的心跳——血液包里带着全身稳态告警，皮层对它做降噪
    ctx.effect(() => ctx.on('organism/heartbeat', (blood) => {
        try {
            const b = blood;
            ingestAlerts(b?.alerts);
            // 心跳**不算清醒活动**：心脏是自动跳的，不代表身体在干活。
            // 若把心跳当活动，每 15 秒就刷新一次「最后一次活动」——皮层将永远睡不着。
            // 只记一个独立的搏动计数，供观测「心跳确实通到皮层」，不参与睡意计算。
            state.beats = (state.beats ?? 0) + 1;
        }
        catch { /* 忽略 */ }
    }), 'cortex: heartbeat listener (noise control)');
    // 信号 A0：**会话推进 = 身体醒着**。这是唯一的清醒信号。
    // 判据取「会话是否在推进」而不是「有没有工具在跑」——后者会被系统内部的后台工具
    // （零驻留维护、各种自触发调用）周期性刷成永不静默，身体就再也睡不着了。
    ctx.effect(() => ctx.on('agent/pre-step', (async (_payload, next) => {
        try {
            markActivity('session-step');
        }
        catch { /* 皮层绝不影响主流程 */ }
        return await next();
    })), 'cortex: wake on session step');
    // 信号 C：命令进来 → 主动召回记忆
    if (config.memoryRecall) {
        ctx.effect(() => ctx.on('agent/pre-step', (async (payload, next) => {
            const decision = await next();
            if (!decision || decision.kind !== 'enter')
                return decision;
            try {
                const p = payload;
                const agent = p?.agent;
                if (agent === undefined)
                    return decision;
                const session = agent.session;
                const sid = String(session?.id ?? 'default');
                const human = latestHuman(session?.snapshotEvents?.());
                if (!human)
                    return decision;
                // 同一条命令只注入一次。关键：**只有真注入了才记账**——
                // 若在「没命中」时也记账，那条命令就永久失去召回机会（记忆库是随睡眠慢慢长出来的，
                // 一条命令进来时库里可能还没有对应经验，不该被一次性判死）。
                const turn = Number(p?.turn ?? NaN);
                const key = Number.isFinite(turn) ? `turn:${turn}` : `seq:${human.seq}`;
                if (recalledKeyBySession.get(sid) === key)
                    return decision;
                const hits = recall(human.text, config.recallLimit);
                if (!hits.length)
                    return decision;
                recalledKeyBySession.set(sid, key);
                const now = clock();
                for (const h of hits) {
                    h.uses += 1;
                    h.lastUsed = now;
                    h.weight = Math.min(10, h.weight + 0.2);
                }
                persistMemories(true);
                state.stats.recalls += 1;
                persistState(true);
                const lines = [
                    '【皮层记忆】这类事以前有过记录，先看一眼再动手：',
                    ...hits.map(h => `- [${KIND_LABEL[h.kind] ?? h.kind}] ${h.title}${h.body ? ` —— ${h.body.split('\n')[0]}` : ''}（用过 ${h.uses} 次）`),
                    '（cortex_memory action=search 看全文；与本次无关就忽略）',
                ];
                return {
                    ...decision,
                    messages: [...(Array.isArray(decision.messages) ? decision.messages : []), createUserMessage({
                            source: { kind: 'plugin:@dsh-external/dsh-cortex' },
                            content: [{ type: 'text', text: lines.join('\n') }],
                        })],
                };
            }
            catch {
                return decision;
            }
        })), 'cortex: memory recall on pre-step');
    }
    // ═══════════════════════════ 工具集 ═══════════════════════════
    /** 运行时查看 / 调节律参数（只改内存，不落盘——重启回到 profile 配置） */
    function configAction(args) {
        const numeric = ['sleepAfterMs', 'deepAfterMs', 'consolidateGapMs', 'memoryHalfLifeMs', 'archiveBelow', 'noiseWindowMs', 'noiseConvergeAt', 'recallLimit'];
        const flags = ['autoSleep', 'memoryRecall'];
        const changed = [];
        const bag = config;
        for (const f of numeric) {
            const v = args[f];
            if (v === undefined)
                continue;
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n))
                continue;
            bag[f] = n;
            changed.push(`${f} = ${n}`);
        }
        for (const f of flags) {
            const v = args[f];
            if (v === undefined)
                continue;
            bag[f] = Boolean(v);
            changed.push(`${f} = ${Boolean(v)}`);
        }
        return [
            '# ⚙️ 皮层节律参数',
            '',
            `- 入睡阈值：静默 ${fmtDur(config.sleepAfterMs)} → 浅睡；静默 ${fmtDur(config.deepAfterMs)} → 深睡（深睡才巩固）`,
            `- 巩固间隔：深睡中每 ${fmtDur(config.consolidateGapMs)} 最多一轮`,
            `- 自动入睡：${config.autoSleep ? '开' : '关'}　命令级召回：${config.memoryRecall ? '开' : '关'}（每次至多 ${config.recallLimit} 张）`,
            `- 记忆衰减：半衰期 ${fmtDur(config.memoryHalfLifeMs)}，权重 <${config.archiveBelow} 归档`,
            `- 告警降噪：去重窗口 ${fmtDur(config.noiseWindowMs)}，重复 ${config.noiseConvergeAt} 次收敛静默`,
            '',
            changed.length
                ? `## 本次改动\n${changed.map(c => `- ${c}`).join('\n')}\n\n> 只改运行时内存（不落盘），重启后回到 profile 配置。定时巡检周期 ${fmtDur(config.tickMs)} 不受影响。`
                : '（未传参数——以上即当前生效值。传 `sleepAfterMs=8000` 这类字段即可临时调整）',
        ].join('\n');
    }
    const outStr = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };
    const tools = [
        // ═══ 1. cortex_sleep — 睡眠与巩固 ═══
        defineTool({
            name: 'cortex_sleep',
            description: '皮层的睡眠与巩固：看当前清醒/浅睡/深睡与昼夜节律，手动入睡并立即巩固一段经历，或直接跑一次巩固把经历提炼成长期记忆。巩固是确定性的（零模型调用）：反复踩的坑、跑通的链路、高频低成功率的薄弱环节、悬而未决的事。',
            parameters: {
                action: { type: 'string', description: 'status(默认，看相位与节律) / enter(手动入睡并立即巩固) / wake(强制醒来) / consolidate(立刻巩固一次) / history(历次睡眠报告) / config(查看或运行时调节律参数)' },
                sleepAfterMs: { type: 'number', description: 'config 用：静默多久算浅睡（毫秒）' },
                deepAfterMs: { type: 'number', description: 'config 用：静默多久算深睡（毫秒）' },
                consolidateGapMs: { type: 'number', description: 'config 用：深睡中两轮巩固的最小间隔（毫秒）' },
                memoryHalfLifeMs: { type: 'number', description: 'config 用：记忆权重衰减半衰期（毫秒）' },
                archiveBelow: { type: 'number', description: 'config 用：权重低于此值自动归档' },
                noiseWindowMs: { type: 'number', description: 'config 用：告警去重窗口（毫秒）' },
                noiseConvergeAt: { type: 'number', description: 'config 用：同一告警重复几次收敛为「已知稳态偏移」' },
                recallLimit: { type: 'number', description: 'config 用：每次最多召回几张记忆卡' },
                autoSleep: { type: 'boolean', description: 'config 用：是否允许自动入睡' },
                memoryRecall: { type: 'boolean', description: 'config 用：是否做命令级主动召回' },
            },
            output: outStr,
            async execute(args) {
                const a = (args.action ?? 'status').trim();
                if (a === 'config')
                    return configAction(args);
                if (a === 'enter' || a === 'consolidate') {
                    const entered = a === 'enter' ? clock() : state.sleepStartedAt || clock();
                    if (a === 'enter') {
                        state.phase = 'deep';
                        state.sleepStartedAt = entered;
                        pushRhythmNote('🌙 手动入睡（深睡）');
                    }
                    const hasNew = buffer.some(e => e.t > state.lastConsolidateAt);
                    if (!hasNew) {
                        return `😴 巩固已是最新：自上次巩固（${state.lastConsolidateAt ? stamp(state.lastConsolidateAt) : '从未'}）以来没有新的经历可整理。`;
                    }
                    const r = consolidate(a === 'enter' ? '手动入睡' : '手动巩固', entered, 'deep');
                    const head = r.created + r.reinforced > 0
                        ? `😴 巩固完成（扫描 ${r.scanned} 段经历）`
                        : `😴 巩固完成（扫描 ${r.scanned} 段经历，没有新的可提炼模式）`;
                    return [
                        head,
                        `- 新建记忆：**${r.created}**　强化既有：**${r.reinforced}**　归档遗忘：**${r.archived}**`,
                        r.notes.length ? `- 本次提炼：\n${r.notes.map(n => `  · ${n}`).join('\n')}` : '',
                        states(),
                    ].filter(Boolean).join('\n');
                }
                if (a === 'wake') {
                    const was = state.phase;
                    awaken('手动唤醒');
                    return was === 'awake' ? '☀️ 本来就是清醒的。' : `☀️ 已唤醒（原相位 ${was}）。`;
                }
                if (a === 'history') {
                    const rs = state.reports.slice().reverse();
                    if (!rs.length)
                        return '尚无睡眠记录——静默满 ' + fmtDur(config.sleepAfterMs) + ' 会自动入睡，也可用 `cortex_sleep action=enter` 立即跑一次巩固。';
                    return [
                        `# 😴 睡眠史（近 ${rs.length} 次）`,
                        '',
                        ...rs.map(r => `- ${stamp(r.t)}　最深 ${r.deepest}　时长 ${fmtDur(r.durationMs || (r.wokeAt ? r.wokeAt - r.enteredAt : 0))}　扫描 ${r.scanned}　新建 ${r.created} / 强化 ${r.reinforced} / 归档 ${r.archived}${r.notes.length ? `\n  · ${r.notes.slice(0, 3).join('；')}` : ''}`),
                    ].join('\n');
                }
                return states();
            },
        }),
        // ═══ 2. cortex_memory — 长期记忆 ═══
        defineTool({
            name: 'cortex_memory',
            description: '皮层的长期记忆：跨会话沉淀的经验卡（坑/打法/薄弱环节/未解/事实）。search 按关键词检索，add 手工写入一条，list 看全部，stats 看记忆画像，forget 归档失效的卡。新命令进来时皮层会自动召回相关记忆并注入，无需手查。',
            parameters: {
                action: { type: 'string', description: 'search(默认) / add / list / stats / forget / revive(把归档的卡召回)' },
                query: { type: 'string', description: 'search 的关键词' },
                kind: { type: 'string', description: 'pitfall / playbook / hotspot / unresolved / fact' },
                title: { type: 'string', description: 'add 用：一句话标题' },
                body: { type: 'string', description: 'add 用：正文' },
                tags: { type: 'string', description: 'add 用：标签，逗号分隔' },
                id: { type: 'string', description: 'forget / revive 用：记忆卡 id' },
            },
            output: outStr,
            async execute(args) {
                const a = (args.action ?? 'search').trim();
                if (a === 'add') {
                    const title = String(args.title ?? '').trim();
                    if (!title)
                        return '缺少 title —— 记忆卡至少要有一句话标题。';
                    const card = {
                        id: cardId(String(args.kind ?? 'fact'), title),
                        t: clock(),
                        kind: (['pitfall', 'playbook', 'hotspot', 'unresolved', 'fact'].includes(String(args.kind)) ? String(args.kind) : 'fact'),
                        title,
                        body: String(args.body ?? ''),
                        tags: String(args.tags ?? '').split(/[,，\s]+/).filter(Boolean).concat(tokens(title)).slice(0, 20),
                        weight: 2,
                        uses: 0, lastUsed: 0, source: 'manual',
                    };
                    const isNew = upsert(card, true);
                    persistMemories();
                    if (isNew)
                        state.stats.cardsCreated += 1;
                    persistState(true);
                    return `${isNew ? '✓ 已记住' : '✓ 已强化既有记忆'}：\`${card.id}\`\n- ${card.title}　[${KIND_LABEL[card.kind]}]\n${card.body ? `- ${card.body.split('\n')[0]}` : ''}\n\n记忆库共 ${memories.length} 张（活跃 ${memories.filter(m => !m.archived).length}）。`;
                }
                if (a === 'stats') {
                    const byKind = new Map();
                    for (const m of memories)
                        if (!m.archived)
                            byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
                    const top = memories.filter(m => !m.archived).sort((x, y) => y.weight - x.weight).slice(0, 5);
                    return [
                        '# 🧠 皮层记忆画像',
                        '',
                        `- 记忆卡：**${memories.length}**（活跃 ${memories.filter(m => !m.archived).length}　归档 ${memories.filter(m => m.archived).length}）`,
                        `- 分类：${[...byKind.entries()].map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`).join('　') || '（空）'}`,
                        `- 召回次数：${state.stats.recalls}　巩固次数：${state.stats.consolidations}　累计新建：${state.stats.cardsCreated}`,
                        `- 衰减半衰期：${fmtDur(config.memoryHalfLifeMs)}；权重低于 ${config.archiveBelow} 自动归档`,
                        '',
                        top.length ? '## 权重最高的记忆' : '（记忆库还是空的——静默入睡巩固后会自动形成，也可用 `cortex_memory action=add` 手工写入）',
                        ...top.map(m => `- **${m.title}**　[${KIND_LABEL[m.kind] ?? m.kind}]　权重 ${m.weight.toFixed(2)}　用过 ${m.uses} 次`),
                    ].join('\n');
                }
                if (a === 'forget' || a === 'revive') {
                    const id = String(args.id ?? '').trim();
                    const m = memories.find(x => x.id === id || x.title.includes(id));
                    if (!m)
                        return `没找到记忆卡：${id || '（未提供 id）'}`;
                    m.archived = a === 'forget';
                    if (a === 'revive')
                        m.weight = Math.max(m.weight, 1);
                    persistMemories();
                    return `${a === 'forget' ? '🗄 已归档' : '♻️ 已召回'}：${m.title}`;
                }
                if (a === 'list') {
                    const act = memories.filter(m => !m.archived).sort((x, y) => y.weight - x.weight);
                    const arc = memories.filter(m => m.archived);
                    if (!act.length && !arc.length)
                        return '记忆库是空的。';
                    return [
                        `# 🧠 长期记忆（活跃 ${act.length} / 归档 ${arc.length}）`,
                        '',
                        ...act.map(m => `- **${m.title}**　[${KIND_LABEL[m.kind] ?? m.kind}]　w=${m.weight.toFixed(2)}　用 ${m.uses} 次　\`${m.id}\``),
                        arc.length ? `\n（归档 ${arc.length} 张，用 \`cortex_memory action=revive id=...\` 可召回）` : '',
                    ].filter(Boolean).join('\n');
                }
                // search（默认）
                const q = String(args.query ?? '').trim();
                if (!q)
                    return '用法：`cortex_memory action=search query=关键词`；或 action=stats 看画像。';
                const hits = recall(q, 8);
                if (!hits.length)
                    return `没检索到与「${q}」相关的记忆（记忆库 ${memories.filter(m => !m.archived).length} 张活跃卡）。`;
                return [
                    `# 🧠 召回「${q}」（${hits.length} 张）`,
                    '',
                    ...hits.map(m => `- **${m.title}**　[${KIND_LABEL[m.kind] ?? m.kind}]　w=${m.weight.toFixed(2)}　用 ${m.uses} 次\n  · ${m.body.split('\n').join('\n  · ')}\n  · \`${m.id}\``),
                ].join('\n');
            },
        }),
        // ═══ 3. cortex_homeo — 稳态降噪 ═══
        defineTool({
            name: 'cortex_homeo',
            description: '皮层对全身稳态告警做降噪：同一条告警在窗口内重复只计数不刷屏，反复出现且从未自愈的收敛为「已知稳态偏移」并静默——告警的价值在变化，不在重复。status 看收敛情况，silence/unsilence 手工干预，clear 清空统计。',
            parameters: {
                action: { type: 'string', description: 'status(默认) / silence(静默某条) / unsilence(解除静默) / clear(清空降噪统计)' },
                key: { type: 'string', description: 'silence/unsilence 用：告警 key 或其中的子串' },
            },
            output: outStr,
            async execute(args) {
                const a = (args.action ?? 'status').trim();
                const entries = Object.entries(state.noise);
                if (a === 'silence' || a === 'unsilence') {
                    const k = String(args.key ?? '').trim();
                    if (!k)
                        return '缺少 key。先用 `cortex_homeo action=status` 看当前的告警 key。';
                    const hit = entries.find(([key]) => key === k || key.includes(k));
                    if (!hit)
                        return `没找到匹配的告警：${k}`;
                    hit[1].silenced = a === 'silence';
                    persistState(true);
                    return `${a === 'silence' ? '🔇 已静默' : '🔊 已解除静默'}：\`${hit[0]}\`（累计 ${hit[1].count} 次）`;
                }
                if (a === 'clear') {
                    const n = entries.length;
                    state.noise = {};
                    state.stats.noiseSuppressed = 0;
                    persistState(true);
                    return `🧹 已清空降噪账本（${n} 条记录）。`;
                }
                const active = entries.filter(([, e]) => !e.silenced).sort((x, y) => y[1].count - x[1].count);
                const silenced = entries.filter(([, e]) => e.silenced).sort((x, y) => y[1].count - x[1].count);
                const rhythmLine = rhythmSummary();
                return [
                    '# 🛡 稳态降噪',
                    '',
                    `- 累计抑制重复告警：**${state.stats.noiseSuppressed}** 次（去重窗口 ${fmtDur(config.noiseWindowMs)}）`,
                    `- 收敛阈值：同一条重复 **${config.noiseConvergeAt}** 次即静默为「已知稳态偏移」`,
                    `- 账本：活跃 ${active.length} 条　已静默 ${silenced.length} 条`,
                    '',
                    active.length ? '## 仍在观察' : '## 仍在观察\n（无——内环境干净）',
                    ...active.slice(0, 8).map(([k, e]) => `- \`${k.slice(0, 70)}\`　累计 ${e.count} 次　最近 ${stamp(e.last)}`),
                    silenced.length ? '\n## 已收敛为已知稳态偏移（静默中）' : '',
                    ...silenced.slice(0, 8).map(([k, e]) => `- \`${k.slice(0, 70)}\`　累计 ${e.count} 次　首次 ${stamp(e.first)}`),
                    silenced.length ? '\n> 这类是「长期如此、不会自己变好」的偏移，皮层不再让它刷屏。要解除用 `cortex_homeo action=unsilence key=<子串>`。' : '',
                    '',
                    rhythmLine,
                ].filter(Boolean).join('\n');
            },
        }),
    ];
    /** 相位 + 节律 + 统计的一行式状态 */
    function states() {
        const idle = clock() - state.lastActivityAt;
        const phaseIcon = state.phase === 'awake' ? '☀️ 清醒' : state.phase === 'light' ? '🌙 浅睡' : '😴 深睡';
        const last = state.reports[state.reports.length - 1];
        return [
            `# 🧠 皮层状态`,
            '',
            `- 相位：**${phaseIcon}**　已静默 ${fmtDur(idle)}（≥${fmtDur(config.sleepAfterMs)} 入睡，≥${fmtDur(config.deepAfterMs)} 深睡）`,
            `- 记忆：**${memories.length}** 张（活跃 ${memories.filter(m => !m.archived).length}）　召回 ${state.stats.recalls} 次　巩固 ${state.stats.consolidations} 次`,
            `- 经历缓冲：${buffer.length}/${config.bufferMax} 段　降噪抑制 ${state.stats.noiseSuppressed} 次`,
            `- 心跳接收：**${state.beats ?? 0}** 次（心脏泵的搏动；不计入睡意，静默时长只由真实调用决定）`,
            `- 最近清醒信号：\`${state.lastActivityWhy ?? '—'}\``,
            last ? `- 上次巩固：${stamp(last.t)}　新建 ${last.created} / 强化 ${last.reinforced} / 归档 ${last.archived}` : '- 上次巩固：尚无',
            '',
            rhythmSummary(),
        ].join('\n');
    }
    /** 昼夜节律：最近一天的活跃分布 */
    function rhythmSummary() {
        const days = Object.keys(state.rhythm).sort();
        const today = days[days.length - 1];
        if (!today)
            return '## 昼夜节律\n（尚无活动记录）';
        const arr = state.rhythm[today] ?? [];
        const total = arr.reduce((s, n) => s + n, 0);
        const peak = arr.indexOf(Math.max(...arr));
        const spark = arr
            .map(n => (n === 0 ? '·' : n < 3 ? '▁' : n < 8 ? '▃' : n < 16 ? '▅' : '█'))
            .join('');
        const maxN = Math.max(1, ...arr);
        const bars = arr
            .map((n, h) => (n > 0 ? `  ${String(h).padStart(2, '0')}时 ${'█'.repeat(Math.max(1, Math.round((n / maxN) * 12)))} ${n}` : ''))
            .filter(Boolean);
        return [
            `## 昼夜节律（${today}）`,
            `\`0${spark}23\`　共 ${total} 次活动　最活跃 ${peak} 时`,
            ...(total ? bars.slice(0, 8) : []),
        ].join('\n');
    }
    for (const tool of tools)
        ctx.effect(() => ctx.tools.register(tool), `cortex: ${tool.name}`);
    // 启动脉冲：让全身知道皮层上线了
    pushRhythmNote('🧠 皮层上线：睡眠周期 + 长期记忆 + 稳态降噪');
    persistState(true);
}
//# sourceMappingURL=index.js.map