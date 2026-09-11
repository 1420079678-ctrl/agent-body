import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const name = '@dsh-external/dsh-war-bridge';
export const inject = ['tools'];
export const Config = z.object({
    idaUrl: z.string().default('http://127.0.0.1:13337/mcp'),
});
const PLUGIN_DIR = {
    rev: 'dsh-reverse-skill',
    sec: 'dsh-sec-workbench',
    agi: 'dsh-pentagi',
};
const LIB_LABEL = {
    rev: '逆向链 dsh-reverse-skill',
    sec: '攻击链 dsh-sec-workbench',
    agi: '编排链 dsh-pentagi',
};
function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function rootOf(lib) {
    return join(dshHome(), 'plugins', PLUGIN_DIR[lib]);
}
/** 反向技能仓库的 tool-index.json（探测多个候选根，找不到返回 null） */
function revToolIndexFile() {
    const cands = [process.env.DSH_WORKSPACE, join(dshHome(), '..', 'workspace')].filter((x) => typeof x === 'string' && x.length > 0);
    for (const c of cands) {
        const f = join(c, 'reverse-skill', 'skills', 'tool-index.json');
        if (existsSync(f))
            return f;
    }
    return null;
}
function casesDir(lib) {
    return join(rootOf(lib), 'cases');
}
function journalDir(lib) {
    return join(rootOf(lib), 'journal');
}
function agiMemFile() {
    return join(rootOf('agi'), 'memory', 'kb.jsonl');
}
function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
function listDirs(dir) {
    if (!existsSync(dir))
        return [];
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
    }
    catch {
        return [];
    }
}
function listFiles(dir, re) {
    if (!existsSync(dir))
        return [];
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && re.test(d.name))
            .map((d) => d.name)
            .sort();
    }
    catch {
        return [];
    }
}
// ═══════════════════════════ IDA MCP 客户端 ═══════════════════════════
let IDA_SESSION = null;
async function mcpPost(url, body, timeoutMs) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    // Streamable HTTP 可能以 SSE 帧回复（data: {...}）
    let payload = text;
    if (/^\s*event\s*:/m.test(text) || /^\s*data\s*:/m.test(text)) {
        payload = text
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
    }
    try {
        return JSON.parse(payload);
    }
    catch {
        return { raw: text };
    }
}
async function idaCall(url, toolName, args, timeoutMs = 300000) {
    const r = await mcpPost(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }, timeoutMs);
    if (r?.error)
        throw new Error(String(r.error.message || JSON.stringify(r.error)));
    return r?.result;
}
/** 从 MCP tool result 取结构化内容：structuredContent 优先，其次解析 content[].text */
function unwrap(result) {
    if (!result)
        return null;
    if (result.structuredContent !== undefined)
        return result.structuredContent;
    const c = result.content;
    if (Array.isArray(c) && c.length) {
        const t = c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
        try {
            return JSON.parse(t);
        }
        catch {
            return t;
        }
    }
    return result;
}
async function idaTools(url, timeoutMs = 8000) {
    const r = await mcpPost(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, timeoutMs);
    const tools = r?.result?.tools;
    return Array.isArray(tools) ? tools.map((t) => String(t?.name ?? '')) : [];
}
async function idaSessions(url) {
    try {
        const list = unwrap(await idaCall(url, 'idb_list', {}, 15000));
        return Array.isArray(list?.sessions) ? list.sessions : [];
    }
    catch {
        return [];
    }
}
/** 解析本次调用要用的 database（session_id）：显式 > 记忆 > 自动认领活动会话 */
async function resolveSession(url, explicit) {
    if (explicit) {
        IDA_SESSION = explicit;
        return { id: explicit, note: '（显式指定）' };
    }
    if (IDA_SESSION)
        return { id: IDA_SESSION, note: '' };
    const sessions = await idaSessions(url);
    const pick = sessions.find((s) => s?.is_active) || sessions[0];
    if (pick?.session_id) {
        IDA_SESSION = String(pick.session_id);
        return { id: IDA_SESSION, note: '（自动认领活动会话）' };
    }
    return { id: null, note: '' };
}
const PY_HELPERS = [
    'import idautils, idc, ida_bytes, ida_funcs, ida_name',
].join('\n');
async function pyEval(url, db, code) {
    const r = unwrap(await idaCall(url, 'py_eval', { database: db, code: `${PY_HELPERS}\n${code}` }));
    return {
        stdout: String(r?.stdout ?? ''),
        result: String(r?.result ?? ''),
        stderr: String(r?.stderr ?? ''),
    };
}
function parseEvidence(caseDir) {
    const dir = join(caseDir, 'evidence');
    const out = [];
    for (const f of listFiles(dir, /\.md$/i)) {
        const t = readText(join(dir, f));
        const id = (t.match(/^###\s+(\S+)/m)?.[1] ?? f.replace(/\.md$/i, '')).trim();
        const title = (t.match(/^-\s*title\s*:\s*(.+)$/m)?.[1] ?? '').trim();
        out.push({ id, title: title.slice(0, 110) });
    }
    return out;
}
function parseFindings(caseDir) {
    const text = readText(join(caseDir, 'findings.md'));
    if (!text)
        return [];
    const out = [];
    for (const block of text.split(/^###\s+/m).slice(1)) {
        const first = block.split(/\r?\n/)[0]?.trim() ?? '';
        if (!/^[A-Za-z]+-\d+/.test(first))
            continue;
        const get = (k) => {
            const m = block.match(new RegExp(`^-\\s*${k}\\s*:\\s*(.*)$`, 'm'));
            return m ? m[1].trim() : '';
        };
        out.push({
            id: first,
            title: get('title').slice(0, 130),
            status: get('status').split(/[（(]/)[0].trim(),
            severity: get('severity').split(/\s|\|/)[0].trim(),
        });
    }
    return out;
}
function parseScope(caseName, caseDir) {
    const text = readText(join(caseDir, 'scope.md'));
    if (!text)
        return [];
    return text
        .split(/\r?\n/)
        .filter((l) => /^-\s*(case_id|created|target|intent|task|auth|status|scope)\s*:/i.test(l) || /^#\s/.test(l))
        .slice(0, 10);
}
function caseStats(lib) {
    return listDirs(casesDir(lib)).map((n) => {
        const dir = join(casesDir(lib), n);
        const findings = parseFindings(dir);
        return {
            lib,
            name: n,
            dir,
            ev: parseEvidence(dir).length,
            fd: findings.length,
            validated: findings.filter((f) => /validated|confirmed/i.test(f.status)).length,
        };
    });
}
function scanJournals(lib) {
    const dir = journalDir(lib);
    return listFiles(dir, /\.md$/i).map((f) => {
        const body = readText(join(dir, f));
        const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, '')).trim();
        return { source: `${LIB_LABEL[lib]} · journal`, title, body };
    });
}
function scanAgiMemory() {
    const file = agiMemFile();
    if (!existsSync(file))
        return [];
    const out = [];
    for (const line of readText(file).split(/\r?\n/)) {
        const s = line.trim();
        if (!s)
            continue;
        try {
            const o = JSON.parse(s);
            const body = [o.pattern, o.chain, o.pitfalls, o.title].filter(Boolean).join('\n');
            out.push({
                source: `编排链 dsh-pentagi · kb.jsonl${o.id ? ` (${String(o.id)})` : ''}`,
                title: String(o.title ?? '(无标题)'),
                body,
            });
        }
        catch {
            /* 跳过坏行 */
        }
    }
    return out;
}
function scoreDoc(doc, terms) {
    const title = doc.title.toLowerCase();
    const body = doc.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
        if (!t)
            continue;
        if (title.includes(t))
            score += 5;
        let idx = body.indexOf(t);
        let hits = 0;
        while (idx >= 0 && hits < 20) {
            hits++;
            idx = body.indexOf(t, idx + t.length);
        }
        score += Math.min(hits, 5);
    }
    return score;
}
function snippet(doc, terms, width = 220) {
    const body = doc.body.replace(/\s+/g, ' ');
    const lower = body.toLowerCase();
    let at = -1;
    for (const t of terms) {
        const i = lower.indexOf(t);
        if (i >= 0 && (at < 0 || i < at))
            at = i;
    }
    if (at < 0)
        at = 0;
    const start = Math.max(0, at - 60);
    return (start > 0 ? '…' : '') + body.slice(start, start + width) + (body.length > start + width ? '…' : '');
}
function splitTerms(query) {
    return query
        .toLowerCase()
        .split(/[\s,，、;；/|]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2);
}
// ═══════════════════════════ 工具实现 ═══════════════════════════
async function idaStatus(url) {
    try {
        const tools = await idaTools(url);
        const sessions = await idaSessions(url);
        const active = sessions.filter((s) => s?.is_active);
        return [
            `【ida · status】✅ IDA MCP 在线 ${url}`,
            `工具数：${tools.length}${tools.includes('py_eval') ? '（含 py_eval，unsafe 模式）' : '（无 py_eval）'}`,
            `会话：${sessions.length} 个${active.length ? `，活动 ${active.length}` : ''}`,
            ...sessions.map((s) => `  · ${s.session_id} ${s.filename ?? ''}${s.is_active ? ' [活动]' : ''}${s.backend ? ` (${s.backend})` : ''}`),
            tools.length ? `样例工具：${tools.slice(0, 12).join(', ')}…` : '',
        ]
            .filter(Boolean)
            .join('\n');
    }
    catch (e) {
        return [
            `【ida · status】❌ 连不上 ${url}`,
            `原因：${String(e)}`,
            ``,
            `启动方式（无窗口）：powershell -File "<reverse-skill>\\skills\\ida-reverse\\scripts\\start.ps1"`,
            `默认路径：<DSH_CHECKOUT>\\workspace\\reverse-skill\\skills\\ida-reverse\\scripts\\start.ps1`,
        ].join('\n');
    }
}
async function idaAction(url, args) {
    const action = String(args.action || 'status').toLowerCase();
    if (action === 'status')
        return await idaStatus(url);
    if (action === 'raw') {
        const toolName = String(args.tool || '');
        if (!toolName)
            return '【ida · raw】需要 tool（MCP 工具名）。';
        let payload = {};
        if (args.json) {
            try {
                payload = JSON.parse(String(args.json));
            }
            catch (e) {
                return `【ida · raw】json 解析失败：${String(e)}`;
            }
        }
        if (payload.database === undefined) {
            const s = await resolveSession(url, args.database);
            if (s.id)
                payload.database = s.id;
        }
        const out = unwrap(await idaCall(url, toolName, payload));
        return `【ida · raw ${toolName}】\n${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}`;
    }
    if (action === 'open') {
        const p = String(args.path || '');
        if (!p)
            return '【ida · open】需要 path（被分析文件路径）。';
        const out = unwrap(await idaCall(url, 'idb_open', { input_path: p }, 600000));
        const sid = out?.session?.session_id ? String(out.session.session_id) : null;
        if (sid)
            IDA_SESSION = sid;
        const h = out?.warmup?.health ?? {};
        return [
            `【ida · open】${out?.success ? '✅' : '❌'} ${p}`,
            sid ? `会话：${sid}` : '',
            h.auto_analysis_ready !== undefined ? `自动分析：${h.auto_analysis_ready} ｜ Hex-Rays：${h.hexrays_ready} ｜ 字符串缓存：${h.strings_cache_size ?? 'n/a'}` : '',
            h.imagebase ? `镜像基址：${h.imagebase}` : '',
            out?.message ? String(out.message) : '',
        ]
            .filter(Boolean)
            .join('\n');
    }
    if (action === 'list') {
        const out = unwrap(await idaCall(url, 'idb_list', {}, 20000));
        const sessions = Array.isArray(out?.sessions) ? out.sessions : [];
        if (!sessions.length)
            return '【ida · list】当前没有打开的会话。';
        return [
            `【ida · list】${sessions.length} 个会话`,
            ...sessions.map((s) => `· ${s.session_id} ｜ ${s.filename ?? ''} ｜ ${s.input_path ?? ''}${s.is_active ? ' ｜ [活动]' : ''}`),
        ].join('\n');
    }
    const sess = await resolveSession(url, args.database);
    const db = sess.id;
    if (!db)
        return `【ida · ${action}】没有可用会话——先 action=open path=<文件>，或 action=list 查看。`;
    const limit = Math.min(Math.max(Number(args.limit ?? 40) || 40, 1), 500);
    if (action === 'close' || action === 'save') {
        const out = unwrap(await idaCall(url, action === 'save' ? 'idb_save' : 'idb_close', { database: db }, 300000));
        if (action === 'close' && IDA_SESSION === db)
            IDA_SESSION = null;
        return `【ida · ${action}】${JSON.stringify(out)}`;
    }
    if (action === 'funcs') {
        const filter = String(args.query || '');
        const r = await pyEval(url, db, [
            `fs=list(idautils.Functions())`,
            `print('TOTAL=' + str(len(fs)))`,
            `flt=${JSON.stringify(filter)}.lower()`,
            `n=0`,
            `for f in fs:`,
            `    nm=idc.get_func_name(f)`,
            `    if flt and flt not in nm.lower(): continue`,
            `    print(hex(f), nm, idc.get_func_attr(f, idc.FUNCATTR_END)-f)`,
            `    n+=1`,
            `    if n>=${limit}: break`,
        ].join('\n'));
        return [`【ida · funcs】${sess.note}`, r.stdout.trim() || '(无输出)', r.stderr ? `stderr: ${r.stderr}` : ''].filter(Boolean).join('\n');
    }
    if (action === 'decompile') {
        const addr = String(args.addr || '');
        if (!addr)
            return '【ida · decompile】需要 addr（十六进制地址，如 0x140001094）。';
        const out = unwrap(await idaCall(url, 'decompile', { database: db, addr }, 300000));
        const code = out?.code ? String(out.code) : JSON.stringify(out);
        const max = Math.min(Math.max(Number(args.max_chars ?? 6000) || 6000, 500), 40000);
        return `【ida · decompile ${addr}】\n${code.slice(0, max)}${code.length > max ? '\n…（截断，可调 max_chars）' : ''}`;
    }
    if (action === 'imports') {
        const offset = Number(args.offset ?? 0) || 0;
        const count = Math.min(Math.max(Number(args.count ?? 30) || 30, 1), 200);
        const out = unwrap(await idaCall(url, 'imports', { database: db, offset, count }, 60000));
        const rows = Array.isArray(out?.data) ? out.data : [];
        return [
            `【ida · imports】${rows.length} 条（next_offset=${out?.next_offset ?? 'n/a'}）`,
            ...rows.map((r) => `· ${r.module ?? ''}!${r.imported_name ?? r.name ?? ''} @ ${r.addr ?? ''}`),
        ].join('\n');
    }
    if (action === 'strings') {
        const pat = String(args.query || '');
        const r = await pyEval(url, db, [
            `import ida_strlist`,
            `try:`,
            `    ida_strlist.build_strlist()`,
            `except Exception: pass`,
            `flt=${JSON.stringify(pat)}.lower()`,
            `n=0`,
            `for s in ida_strlist.string_info_t_list:`,
            `    val=str(getattr(s,'string','') or '')`,
            `    if flt and flt not in val.lower(): continue`,
            `    print(hex(s.ea), val[:120])`,
            `    n+=1`,
            `    if n>=${limit}: break`,
            `print('SHOWN=' + str(n))`,
        ].join('\n'));
        return [`【ida · strings】${sess.note}`, r.stdout.trim() || '(无输出)', r.stderr ? `stderr: ${r.stderr}` : ''].filter(Boolean).join('\n');
    }
    if (action === 'xrefs') {
        const target = String(args.addr || args.query || '');
        if (!target)
            return '【ida · xrefs】需要 addr（地址）或 query（符号名）。';
        const r = await pyEval(url, db, [
            `t=${JSON.stringify(target)}`,
            `ea=int(t,16) if t.lower().startswith('0x') else idc.get_name_ea_simple(t)`,
            `print('TARGET=' + hex(ea))`,
            `n=0`,
            `for x in idautils.XrefsTo(ea):`,
            `    print('from', hex(x.frm), idc.get_func_name(x.frm), 'type', x.type)`,
            `    n+=1`,
            `    if n>=${limit}: break`,
            `print('XREFS=' + str(n))`,
        ].join('\n'));
        return [`【ida · xrefs ${target}】`, r.stdout.trim() || '(无输出)', r.stderr ? `stderr: ${r.stderr}` : ''].filter(Boolean).join('\n');
    }
    if (action === 'disasm') {
        const addr = String(args.addr || '');
        if (!addr)
            return '【ida · disasm】需要 addr。';
        const out = unwrap(await idaCall(url, 'disasm', { database: db, addr }, 120000));
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return `【ida · disasm ${addr}】\n${text.slice(0, 8000)}`;
    }
    if (action === 'eval') {
        const code = String(args.code || '');
        if (!code)
            return '【ida · eval】需要 code（Python 片段）。';
        const r = await pyEval(url, db, code);
        return [
            `【ida · eval】session=${db}`,
            r.stdout.trim() ? `stdout:\n${r.stdout.trim()}` : '',
            r.result && r.result !== 'None' ? `result: ${r.result}` : '',
            r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : '',
        ]
            .filter(Boolean)
            .join('\n');
    }
    return `【ida】未知 action：${action}。支持：status/open/list/close/save/funcs/decompile/disasm/imports/strings/xrefs/eval/raw`;
}
async function warStatus(url) {
    const lines = ['【war_status · 全班组合体体检】', ''];
    // 1) 逆向链 + IDA
    const revCases = caseStats('rev');
    const revJournal = listFiles(journalDir('rev'), /\.md$/i).length;
    const revIdx = revToolIndexFile();
    let idaLine = '❌ 未在线';
    let idaToolsN = 0;
    let sessN = 0;
    try {
        const tools = await idaTools(url, 5000);
        idaToolsN = tools.length;
        sessN = (await idaSessions(url)).length;
        idaLine = `✅ 在线（${idaToolsN} 工具，${sessN} 会话）${tools.includes('py_eval') ? ' · unsafe' : ''}`;
    }
    catch {
        idaLine = '❌ 未在线（跑 ida-reverse\\scripts\\start.ps1 拉起）';
    }
    lines.push(`逆向链 dsh-reverse-skill`);
    lines.push(`  · IDA MCP：${idaLine}`);
    lines.push(`  · 案件：${revCases.length} 个 ｜ 证据 ${revCases.reduce((a, c) => a + c.ev, 0)} 条 ｜ 结论 ${revCases.reduce((a, c) => a + c.fd, 0)} 条`);
    lines.push(`  · 经验 journal：${revJournal} 篇`);
    lines.push('');
    // 2) 攻击链
    const secCases = caseStats('sec');
    const secJournal = listFiles(journalDir('sec'), /\.md$/i).length;
    const secReports = listFiles(join(rootOf('sec'), 'reports'), /.+/).length;
    lines.push(`攻击链 dsh-sec-workbench`);
    lines.push(`  · 案件：${secCases.length} 个 ｜ 证据 ${secCases.reduce((a, c) => a + c.ev, 0)} 条 ｜ 结论 ${secCases.reduce((a, c) => a + c.fd, 0)} 条（validated/confirmed ${secCases.reduce((a, c) => a + c.validated, 0)}）`);
    lines.push(`  · 经验 journal：${secJournal} 篇 ｜ 报告：${secReports} 份`);
    lines.push('');
    // 3) 编排链
    const flows = listFiles(join(rootOf('agi'), 'flows'), /\.json$/i);
    let memN = 0;
    const memFile = agiMemFile();
    if (existsSync(memFile)) {
        memN = readText(memFile)
            .split(/\r?\n/)
            .filter((l) => l.trim().startsWith('{')).length;
    }
    const agiReports = listFiles(join(rootOf('agi'), 'reports'), /.+/).length;
    lines.push(`编排链 dsh-pentagi`);
    lines.push(`  · 任务流 flow：${flows.length} 个 ｜ 知识库记忆：${memN} 条 ｜ 报告：${agiReports} 份`);
    lines.push('');
    // 4) 跨库
    const revNames = new Set(revCases.map((c) => c.name));
    const shared = secCases.filter((c) => revNames.has(c.name)).map((c) => c.name);
    lines.push(`跨库`);
    lines.push(`  同名案件（两库都有）：${shared.length ? shared.join(', ') : '无'}`);
    lines.push(`  记忆总量：${revJournal + secJournal + memN} 条（rev ${revJournal} + sec ${secJournal} + agi ${memN}）`);
    lines.push(`  三链合体用法：rev 侧反编译取证 → war_case handoff 交给 sec 侧 → agi_plan 编排利用 → war_memory 跨库检索复用`);
    lines.push('');
    lines.push(`IDA 工具索引文件：${revIdx ? `✅ ${revIdx}` : '⚠️ 缺（跑 refresh-tool-index.ps1）'}`);
    return lines.join('\n');
}
function warCase(args) {
    const action = String(args.action || 'list').toLowerCase();
    const rev = caseStats('rev');
    const sec = caseStats('sec');
    if (action === 'list') {
        const lines = ['【war_case · 跨库案件全景】', ''];
        lines.push(`逆向链 cases（${casesDir('rev')}）`);
        if (!rev.length)
            lines.push('  （空）');
        for (const c of rev)
            lines.push(`  · ${c.name} ｜ 证据 ${c.ev} ｜ 结论 ${c.fd}${c.validated ? `（validated ${c.validated}）` : ''}`);
        lines.push('');
        lines.push(`攻击链 cases（${casesDir('sec')}）`);
        if (!sec.length)
            lines.push('  （空）');
        for (const c of sec)
            lines.push(`  · ${c.name} ｜ 证据 ${c.ev} ｜ 结论 ${c.fd}${c.validated ? `（validated ${c.validated}）` : ''}`);
        return lines.join('\n');
    }
    const name = String(args.case || '');
    if (!name)
        return `【war_case · ${action}】需要 case（案件名）。`;
    const hit = (list, lib) => list.find((c) => c.name === name && c.lib === lib);
    if (action === 'show') {
        const parts = [`【war_case · show】${name}`];
        for (const lib of ['rev', 'sec']) {
            const stat = hit(lib === 'rev' ? rev : sec, lib);
            const dir = join(casesDir(lib), name);
            parts.push('');
            if (!existsSync(dir)) {
                parts.push(`◆ ${LIB_LABEL[lib]}：该库无此案件`);
                continue;
            }
            parts.push(`◆ ${LIB_LABEL[lib]}（证据 ${stat?.ev ?? 0} ｜ 结论 ${stat?.fd ?? 0}）`);
            const scope = parseScope(name, dir);
            if (scope.length)
                parts.push(...scope.map((s) => `   ${s}`));
            const ev = parseEvidence(dir);
            if (ev.length)
                parts.push(`   证据：${ev.slice(0, 12).map((e) => `${e.id} ${e.title}`).join(' ｜ ')}${ev.length > 12 ? ` …共 ${ev.length}` : ''}`);
            const fd = parseFindings(dir);
            if (fd.length) {
                parts.push('   结论：');
                for (const f of fd)
                    parts.push(`     · ${f.id} [${f.status || 'n/a'}${f.severity ? `/${f.severity}` : ''}] ${f.title}`);
            }
        }
        return parts.join('\n');
    }
    if (action === 'handoff') {
        const from = (String(args.from || 'rev').toLowerCase() === 'sec' ? 'sec' : 'rev');
        const to = from === 'rev' ? 'sec' : 'rev';
        const srcDir = join(casesDir(from), name);
        if (!existsSync(srcDir))
            return `【war_case · handoff】源案件不存在：${srcDir}`;
        const dstDir = join(casesDir(to), name);
        const dstEv = join(dstDir, 'evidence');
        mkdirSync(dstEv, { recursive: true });
        // 证据：按文件名去重复制（只增不改）
        let copiedEv = 0;
        let skippedEv = 0;
        for (const f of listFiles(join(srcDir, 'evidence'), /\.md$/i)) {
            const target = join(dstEv, f);
            if (existsSync(target)) {
                skippedEv++;
                continue;
            }
            copyFileSync(join(srcDir, 'evidence', f), target);
            copiedEv++;
        }
        // 结论：按 F-id 去重，整块追加
        const srcText = readText(join(srcDir, 'findings.md'));
        const dstFindings = join(dstDir, 'findings.md');
        const existing = new Set(parseFindings(dstDir).map((f) => f.id));
        const blocks = srcText
            .split(/^###\s+/m)
            .slice(1)
            .filter((b) => /^[A-Za-z]+-\d+/.test(b.split(/\r?\n/)[0]?.trim() ?? ''));
        const fresh = blocks.filter((b) => !existing.has((b.split(/\r?\n/)[0] ?? '').trim()));
        if (!existsSync(dstFindings)) {
            appendFileSync(dstFindings, `# Findings — ${name}\n\n（由 war-bridge 从 ${LIB_LABEL[from]} 交接）\n\n`, 'utf8');
        }
        if (fresh.length) {
            appendFileSync(dstFindings, `\n${fresh.map((b) => `### ${b.trimEnd()}`).join('\n\n')}\n`, 'utf8');
        }
        const stamp = new Date().toISOString();
        appendFileSync(join(dstDir, 'timeline.md'), `| ${stamp} | handoff from ${from} | war_case | 交接证据 ${copiedEv} 条（跳过重复 ${skippedEv}）｜结论 ${fresh.length} 条 | — |\n`, 'utf8');
        return [
            `【war_case · handoff】${LIB_LABEL[from]} → ${LIB_LABEL[to]}`,
            `案件：${name}`,
            `目标目录：${dstDir}`,
            `证据：新增 ${copiedEv} 条，跳过已存在 ${skippedEv} 条`,
            `结论：新增 ${fresh.length} 条${fresh.length ? `（${fresh.map((b) => (b.split(/\r?\n/)[0] ?? '').trim()).join(', ')}）` : ''}`,
            `时间线已记录。`,
            ``,
            `提示：交接是只增操作，源库内容不变；两库同名案件此后可用 war_case show 并排查看。`,
        ].join('\n');
    }
    return `【war_case】未知 action：${action}。支持：list/show/handoff`;
}
function warMemory(args) {
    const action = String(args.action || 'search').toLowerCase();
    const revDocs = scanJournals('rev');
    const secDocs = scanJournals('sec');
    const agiDocs = scanAgiMemory();
    const all = [...revDocs, ...secDocs, ...agiDocs];
    if (action === 'index') {
        const latest = (docs, n = 5) => docs.slice(-n).map((d) => `   · ${d.title.slice(0, 90)}`).join('\n');
        return [
            `【war_memory · index】三库合计 ${all.length} 条`,
            ``,
            `逆向链 journal：${revDocs.length} 条`,
            latest(revDocs),
            ``,
            `攻击链 journal：${secDocs.length} 条`,
            latest(secDocs),
            ``,
            `编排链 kb.jsonl：${agiDocs.length} 条`,
            latest(agiDocs),
            ``,
            `检索：war_memory action=search query="关键词1 关键词2"`,
        ].join('\n');
    }
    const query = String(args.query || '');
    if (!query)
        return '【war_memory】需要 query（关键词，空格分隔取并集计分）。';
    const terms = splitTerms(query);
    if (!terms.length)
        return '【war_memory】query 太短（每个关键词至少 2 字符）。';
    const limit = Math.min(Math.max(Number(args.limit ?? 8) || 8, 1), 30);
    const hits = all
        .map((d) => ({ d, score: scoreDoc(d, terms) }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    if (!hits.length) {
        return `【war_memory · search】"${query}" 在三库（${all.length} 条）中无命中。\n建议换更短的关键词、或先用 war_memory action=index 看有什么。`;
    }
    const lines = [`【war_memory · search】"${query}" 命中 ${hits.length}/${all.length} 条`, ''];
    for (const h of hits) {
        lines.push(`◆ [${h.score}分] ${h.d.title}`);
        lines.push(`  来源：${h.d.source}`);
        lines.push(`  摘要：${snippet(h.d, terms)}`);
        lines.push('');
    }
    return lines.join('\n');
}
// ═══════════════════════════ 注册 ═══════════════════════════
export function apply(ctx, config) {
    const url = config.idaUrl || 'http://127.0.0.1:13337/mcp';
    const tools = [
        defineTool({
            name: 'ida',
            description: 'IDA MCP 直连桥（逆向链的手）：status 体检/open 打开样本/list 会话/funcs 函数/decompile 反编译/disasm 反汇编/imports 导入表/strings 字符串/xrefs 交叉引用/eval 执行 Python/save 落盘/close 关闭/raw 任意 MCP 工具。免去把 69 个 IDA 工具塞进 schema 的 token 开销，一个入口全通。IDA 服务未起时按返回里的提示跑 start.ps1。',
            parameters: {
                action: { type: 'string', description: 'status(默认)/open/list/close/save/funcs/decompile/disasm/imports/strings/xrefs/eval/raw' },
                path: { type: 'string', description: 'action=open 时：被分析文件路径' },
                addr: { type: 'string', description: 'decompile/disasm/xrefs 的地址（如 0x140001094）或符号名' },
                query: { type: 'string', description: 'funcs/strings 的名字过滤子串' },
                code: { type: 'string', description: 'action=eval 的 Python 片段（已自动注入 idautils/idc/ida_bytes/ida_funcs/ida_name）' },
                database: { type: 'string', description: '会话 id（不传则自动认领活动会话）' },
                limit: { type: 'number', description: '返回条数上限（默认 40，最大 500）' },
                offset: { type: 'number', description: 'imports 起始偏移（默认 0）' },
                count: { type: 'number', description: 'imports 条数（默认 30）' },
                max_chars: { type: 'number', description: 'decompile 输出截断长度（默认 6000）' },
                tool: { type: 'string', description: 'action=raw 时的 MCP 工具名' },
                json: { type: 'string', description: 'action=raw 时的参数 JSON 字符串' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
            async execute(args) {
                try {
                    return await idaAction(url, args || {});
                }
                catch (e) {
                    return `【ida · 失败】${String(e)}`;
                }
            },
        }),
        defineTool({
            name: 'war_status',
            description: '全班组合体体检：一次看清逆向链（IDA MCP 是否在线/工具数/会话、rev 案件与 journal）、攻击链（sec 案件/证据/结论/journal/报告）、编排链（agi flow/知识库/报告）以及跨库同名案件与记忆总量。开工和收工各看一眼，就知道兄弟们是否都在线。',
            parameters: {},
            output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
            async execute() {
                try {
                    return await warStatus(url);
                }
                catch (e) {
                    return `【war_status · 失败】${String(e)}`;
                }
            },
        }),
        defineTool({
            name: 'war_case',
            description: '跨库案件桥：list 两库案件全景（证据/结论计数）；show case=<名> 把逆向链与攻击链的同名案件并排看；handoff case=<名> from=rev|sec 把源案件的证据与结论**只增不改**地交接进另一库（供后续攻击/报告引用）。联合行动时用它替代手工搬文件。',
            parameters: {
                action: { type: 'string', description: 'list(默认)/show/handoff' },
                case: { type: 'string', description: '案件名（show/handoff 必填）' },
                from: { type: 'string', description: 'handoff 源库：rev(默认) 或 sec' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
            async execute(args) {
                try {
                    return warCase(args || {});
                }
                catch (e) {
                    return `【war_case · 失败】${String(e)}`;
                }
            },
        }),
        defineTool({
            name: 'war_memory',
            description: '三库统一检索：一次查遍逆向链 journal、攻击链 journal、编排链 kb.jsonl（关键词并集计分，标题×5、正文命中计分）。开新目标前先 war_memory action=search query="关键词"，直接复用上次打法；action=index 看三库都有什么。',
            parameters: {
                action: { type: 'string', description: 'search(默认)/index' },
                query: { type: 'string', description: '关键词，空格/逗号分隔（每个≥2字符）' },
                limit: { type: 'number', description: '返回条数（默认 8，最大 30）' },
            },
            output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
            async execute(args) {
                try {
                    return warMemory(args || {});
                }
                catch (e) {
                    return `【war_memory · 失败】${String(e)}`;
                }
            },
        }),
    ];
    for (const tool of tools) {
        ctx.effect(() => ctx.tools.register(tool), `war-bridge: ${tool.name}`);
    }
    ctx.logger?.info?.(`[${name}] war bridge active (${tools.length} tools, ida=${url})`);
}
//# sourceMappingURL=index.js.map