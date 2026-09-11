import { CallId } from '@deepseek-ai/dsh-llm/brand';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import z from 'schemastery';
export const name = "@dsh-external/dsh-daily-fund-scan";
export const inject = ['timer', 'tools'];
export const Config = z.object({
    runAt: z.string().default('15:30'),
    pollMs: z.number().min(10000).default(60000),
    fundPool: z.string().default([
        '510300|沪深300ETF',
        '510050|上证50ETF',
        '159915|创业板ETF',
        '510500|中证500ETF',
        '512100|中证1000ETF',
        '588000|科创50ETF',
        '159949|创业板50ETF',
        '513100|纳指ETF',
        '513500|标普500ETF',
        '513050|中概互联ETF',
        '159920|恒生ETF',
        '518880|黄金ETF',
        '511010|国债ETF',
        '510880|红利ETF',
        '512890|红利低波ETF',
        '512690|酒ETF',
        '512480|半导体ETF',
        '512660|军工ETF',
        '515030|新能源车ETF',
        '512170|医疗ETF',
        '515790|光伏ETF',
        '512000|券商ETF',
        '161725|招商中证白酒',
    ].join('\n')),
    capital: z.number().default(100000),
    outDir: z.string().default(''),
});
export function apply(ctx, config) {
    const SHORT = "dsh-daily-fund-scan";
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const logFile = join(dshHome, 'super-injector', SHORT + '.log');
    const log = (msg) => {
        try {
            mkdirSync(join(dshHome, 'super-injector'), { recursive: true });
            appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n');
        }
        catch { /* 日志失败静默 */ }
    };
    const parsePool = () => String(config.fundPool ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
        const [code, name] = l.split('|');
        return { code: code.trim(), name: (name || code).trim() };
    });
    /** 直接调用 invest 插件注册的工具（确定性引擎，不消耗 LLM token） */
    async function callTool(name, args) {
        const res = await ctx.tools.execute({
            callId: CallId(SHORT + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
            name,
            arguments: args,
            signal: AbortSignal.timeout(60000),
        });
        if (res.isError)
            return 'ERROR: ' + JSON.stringify(res.content ?? []);
        const text = (res.content ?? []).map((b) => b.text ?? '').join('\n');
        return text || '（无输出）';
    }
    /** 解析报告文本中的建议仓位%（invest 输出形如 "仓位: 轻仓试探（0.4%）：制度..."）和止损/目标 */
    function parsePosition(report) {
        const lineM = report.match(/仓位[:：]\s*([^\n]+)/);
        const line = lineM ? lineM[1] : '';
        const pctM = line.match(/([\d.]+)%/);
        const stopM = report.match(/止损\s*([\d.]+)%/);
        const targetM = report.match(/目标\s*([\d.]+)%/);
        return {
            pct: pctM ? parseFloat(pctM[1]) : 0,
            stop: stopM ? stopM[1] + '%' : '-',
            target: targetM ? targetM[1] + '%' : '-',
        };
    }
    /** 提取一句话结论（"结论: ..." 行） */
    function extractConclusion(report) {
        const m = report.match(/结论[:：]\s*(.+)/);
        return m ? m[1].slice(0, 120) : report.split('\n')[0] ?? '';
    }
    /** 提取综合评分（"综合 40 分 → 减仓"） */
    function extractScore(report) {
        const m = report.match(/综合\s*([\d.]+)分\s*→\s*([\u4e00-\u9fa5/]+)/);
        return m ? `${m[1]}分→${m[2]}` : '-';
    }
    /** 大白话 verdict：普通小白一看就知道买不买 */
    function plainVerdict(pct) {
        if (pct <= 0)
            return '❌ 先不买';
        if (pct < 1)
            return '🟡 小钱试探';
        if (pct < 5)
            return '🟢 可以买';
        return '✅ 放心买';
    }
    /** 大白话理由：从 invest 结论文本里提取普通人都懂的原因 */
    function plainReason(conclusion, report) {
        if (/期望收益不为正|不建仓/.test(report))
            return '赚钱概率不高，先等等';
        if (/资金在撤|净流出/.test(report))
            return '大资金在跑，别接飞刀';
        if (/低位吸筹|净流入/.test(report))
            return '大资金在悄悄买入';
        if (/多空平衡|方向未定/.test(report))
            return '方向不明，观望';
        if (/轻仓试探/.test(report))
            return '可以拿小钱试';
        if (/回避/.test(conclusion))
            return '现在不合适';
        return conclusion.slice(0, 40) || '数据正常';
    }
    async function runScan() {
        const today = new Date();
        const dateStr = today.toISOString().slice(0, 10);
        const pool = parsePool();
        log(`scan start: ${pool.length} funds, capital=${config.capital}`);
        // 1. 大盘制度（含白话翻译）
        let regimeRaw = '震荡（查询失败）';
        let regimePlain = '市场偏弱，只拿小钱试探，别重仓';
        try {
            const regime = await callTool('invest_regime', {});
            const m = regime.match(/制度[:：]\s*(.+?)(?:\n|$)/);
            regimeRaw = m ? m[1].trim() : regime.split('\n')[0] ?? regimeRaw;
            if (/进攻/.test(regimeRaw))
                regimePlain = '市场偏强，可以正常分批买入';
            else if (/防守/.test(regimeRaw))
                regimePlain = '市场偏弱，只拿小钱试探，别重仓';
            else
                regimePlain = '市场一般，小买试水，严格止损';
        }
        catch (e) {
            log('regime error: ' + String(e));
        }
        // 2. 逐只扫描
        const rows = [];
        const buys = [];
        for (const f of pool) {
            try {
                const report = await callTool('invest_report', { code: f.code, intent: '每日基金扫描定投建议' });
                const score = extractScore(report);
                const { pct, stop, target } = parsePosition(report);
                const conclusion = extractConclusion(report);
                const amount = Math.round(config.capital * (pct / 100));
                const verdict = plainVerdict(pct);
                const reason = plainReason(conclusion, report);
                // 有仓位时补调 invest_position 拿止损/目标（invest_report 不含）
                let stopFinal = stop, targetFinal = target;
                if (pct > 0) {
                    try {
                        const pos = await callTool('invest_position', { code: f.code });
                        const posPct = pos.match(/止损\s*([\d.]+)%/);
                        const posTarget = pos.match(/目标\s*([\d.]+)%/);
                        if (posPct)
                            stopFinal = posPct[1] + '%';
                        if (posTarget)
                            targetFinal = posTarget[1] + '%';
                    }
                    catch { /* 止损缺失不影响主流程 */ }
                }
                rows.push(`| ${f.code} | ${f.name} | ${verdict} | ¥${amount} | ${stopFinal} | ${targetFinal} | ${reason} |`);
                if (pct > 0 && amount > 0)
                    buys.push({ code: f.code, name: f.name, amount, stop: stopFinal, target: targetFinal, verdict, reason });
                log(`  ${f.code} ${f.name}: pct=${pct}% amount=${amount} score=${score}`);
            }
            catch (e) {
                rows.push(`| ${f.code} | ${f.name} | ⚠️ 查询失败 | - | - | - | ${String(e).slice(0, 40)} |`);
                log(`  ${f.code} error: ${String(e)}`);
            }
        }
        // 3. 买入清单：金额降序 + 小白三步
        buys.sort((a, b) => b.amount - a.amount);
        const buyRows = buys.length
            ? buys.map((b) => `| ${b.code} | ${b.name} | ${b.verdict} | ¥${b.amount} | ${b.stop} | ${b.target} | ${b.reason} |`)
            : ['| - | - | ❌ 今天没有 | ¥0 | - | - | 全部先观望 |'];
        const buyLines = buys.length
            ? buys.map((b, i) => `${i + 1}. **${b.name}（${b.code}）**：买 **¥${b.amount}**｜跌 ${b.stop} 就卖｜涨 ${b.target} 卖一半`)
            : ['今天没有适合买的，全都先观望。'];
        const md = [
            `# 🐣 小白每日基金日报 ${dateStr}`,
            ``,
            `> 数据源：eastmoney 真实行情（经 invest 七力引擎）｜按 ¥${config.capital} 本金算，钱少就同比例缩小`,
            ``,
            `## 🌦️ 今天大盘怎么样`,
            ``,
            `**${regimeRaw}** → ${regimePlain}`,
            ``,
            `## 🛒 今天能买什么（按金额从大到小）`,
            ``,
            `| 代码 | 名称 | 建议 | 买多少钱 | 跌多少卖 | 涨多少卖 | 为什么 |`,
            `|---|---|---|---|---|---|---|`,
            ...buyRows,
            ``,
            `## 📋 今天照着做（三步）`,
            ``,
            `1. **打开证券 App** → 搜索上面的代码（如 518880）→ 点「买入」`,
            `2. **金额填表格里的数**（钱少就按比例缩小，比如本金只有 5 万就减半）`,
            `3. **跌到「跌多少卖」就立刻卖**，涨到「涨多少卖」卖掉一半落袋`,
            ``,
            `## 🔍 全部 ${pool.length} 只基金扫描明细`,
            ``,
            `| 代码 | 名称 | 建议 | 金额 | 止损 | 目标 | 为什么 |`,
            `|---|---|---|---|---|---|---|`,
            ...rows,
            ``,
            `## ⚠️ 三个铁律`,
            ``,
            `1. 只用**亏了也不心疼的闲钱**，绝不借钱、不押生活费`,
            `2. 每次买入**必须设止损**：跌到止损位就走，不扛单`,
            `3. 市场偏弱时（今天就是）买入都是试探，**别一次买完**，分批来`,
            ``,
            `---`,
            `*投资有风险，决策需独立判断*`,
            ``,
        ].join('\n');
        // 输出到 DSH 插件数据目录：DSH_HOME/plugins/dsh-daily-fund-scan/reports/
        const outDir = config.outDir || join(dshHome, 'plugins', SHORT, 'reports');
        const outFile = join(outDir, `daily-fund-scan-${dateStr}.md`);
        try {
            mkdirSync(outDir, { recursive: true });
            writeFileSync(outFile, md, 'utf8');
            log(`report written: ${outFile} (${md.length} bytes)`);
        }
        catch (e) {
            log('write report error: ' + String(e));
        }
    }
    // ═══ 守护循环：轮询到点触发（避免依赖系统 cron） ═══
    let lastRunDate = '';
    ctx.setInterval(() => {
        void (async () => {
            const now = new Date();
            const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const today = now.toISOString().slice(0, 10);
            if (hhmm === config.runAt && lastRunDate !== today) {
                lastRunDate = today;
                log('trigger at ' + hhmm);
                await runScan();
            }
        })().catch((e) => log('loop error: ' + String(e)));
    }, config.pollMs);
    ctx.logger?.info?.('[' + "@dsh-external/dsh-daily-fund-scan" + '] 每日基金扫描启动（每天 ' + config.runAt + ' 触发，基金池 ' + parsePool().length + ' 只）');
    // 启动后立即跑一次（验证链路）
    setTimeout(() => { void runScan().catch((e) => log('initial run error: ' + String(e))); }, 3000);
}
//# sourceMappingURL=index.js.map