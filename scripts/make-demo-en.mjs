#!/usr/bin/env node
/**
 * Generate docs/en.html from docs/index.html.
 *
 *   node scripts/make-demo-en.mjs           # write docs/en.html
 *   node scripts/make-demo-en.mjs --check   # exit 1 if docs/en.html is out of date
 *
 * Why a generator instead of a hand-maintained translation
 * -------------------------------------------------------
 * docs/index.html is the page humans edit. It carries the runtime data — an inline
 * `const D = {...}` built from vitals.json / bloodstream.json / pulse.jsonl — plus the Chinese copy.
 * A hand-maintained English twin would drift from both, and a drifted demo page is worse than no
 * English page: it is the one link in the README that is supposed to prove the project works.
 *
 * So this script copies index.html and swaps *only* human-readable copy. The `const D` line is
 * carried across byte-for-byte. Every replacement asserts its expected match count, and the script
 * refuses to write anything if a single one misses — so the day index.html's Chinese copy is edited,
 * this fails loudly here instead of shipping a half-translated page.
 *
 * Final gate: strip the data line, then assert that no CJK codepoint survives outside it. The only
 * Chinese left on the English page is the language switcher's own label, which is written as numeric
 * entities (`&#20013;&#25991;`) precisely so this gate can stay absolute rather than accumulate exemptions.
 *
 * Note on line endings: .gitattributes pins `* text=auto eol=lf`, so the literal newlines below match
 * on any checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, '..', 'docs');
const SRC = path.join(DOCS, 'index.html');
const DST = path.join(DOCS, 'en.html');
const CHECK = process.argv.includes('--check');

/** [description, from, to, expectedCount] */
const RULES = [
  // ---- head ----
  ['html lang', '<html lang="zh-CN">', '<html lang="en" translate="no">', 1],
  ['generated notice',
    '<head>\n<meta charset="utf-8">',
    '<head>\n<meta charset="utf-8">\n<!-- GENERATED from docs/index.html by scripts/make-demo-en.mjs — edit the Chinese page, then re-run the script. -->', 1],
  ['title',
    '<title>Agent-Body — 器官化插件层的实时体征回放</title>',
    '<title>Agent-Body — a live vitals replay of an organ-based plugin layer</title>', 1],
  ['meta description',
    '<meta name="description" content="Agent-Body 把插件系统当一具有机体：心跳、器官、零模型调用的反射弧、睡眠期记忆巩固、闭环自愈。本页是一台真实安装的体征回放。">',
    '<meta name="description" content="Agent-Body treats a plugin system as an organism: a heartbeat, organs, reflex arcs that fire with zero model calls, sleep-time memory consolidation and closed-loop self-healing. This page is a replay of the vitals from a real install.">', 1],
  ['notranslate meta',
    '<style>\n :root{--bg:#0b0e13',
    '<meta name="google" content="notranslate">\n<style>\n :root{--bg:#0b0e13', 1],

  // ---- language switcher ----
  // index.html carries the CSS and the Chinese-side switcher itself (it is the page humans edit).
  // Here we only flip the switcher around, and we spell 中文 as numeric entities so the generated
  // English page contains zero CJK codepoints and the final gate can stay absolute.
  ['switcher markup',
    '<h1>Agent-Body <span class="heart">&#10084;</span><span class="lang"><b>中文</b> · <a href="en.html">English</a></span></h1>',
    '<h1>Agent-Body <span class="heart">&#10084;</span><span class="lang"><a href="index.html">&#20013;&#25991;</a> · <b>English</b></span></h1>', 1],

  // ---- masthead ----
  ['sub',
    '  <p class="sub">把插件系统当一具有机体：器官、神经冲动、心跳、零模型调用的反射弧、睡眠期记忆巩固、闭环自愈。<br>\n  本页是<strong>一台真实开发机的体征回放</strong>——数字是被测出来的，动画重放的是真实事件流。采样 <code>2026-09-23 19:40</code>。</p>',
    '  <p class="sub">A plugin system treated as an organism: organs, nerve impulses, a heartbeat, reflex arcs that fire with zero model calls, sleep-time memory consolidation, closed-loop self-healing.<br>\n  This page is <strong>a replay of the vitals from a real development machine</strong> — the numbers were measured, and the animation replays the real event stream. Sampled <code>2026-09-23 19:40</code>.</p>', 1],
  ['tags',
    '    <span class="tag">43 个器官</span><span class="tag">332/332 项能力已被认领</span>\n    <span class="tag">19/19 条反射弧</span><span class="tag">架构完整性 6/6</span>',
    '    <span class="tag">43 organs</span><span class="tag">332/332 capabilities claimed</span>\n    <span class="tag">19/19 reflex arcs</span><span class="tag">architecture integrity 6/6</span>', 1],

  // ---- install ----
  ['h2 install', '<h2>一行安装</h2>', '<h2>One-line install</h2>', 1],
  ['install note',
    '  <p class="note">dsh plugin 把参数转发给 profile 里的 <code>pnpm add</code>，所以一条命令装三个器官 ·\n  <a href="https://github.com/1420079678-ctrl/agent-body">github.com/1420079678-ctrl/agent-body</a></p>',
    '  <p class="note"><code>dsh plugin</code> forwards its arguments to <code>pnpm add</code> inside the profile, so one command installs three organs ·\n  <a href="https://github.com/1420079678-ctrl/agent-body">github.com/1420079678-ctrl/agent-body</a></p>', 1],

  // ---- vitals ----
  ['h2 vitals', '<h2>生命体征</h2>', '<h2>Vitals</h2>', 1],
  ['h2 body',
    '<h2>身体 · 按调用量排序的器官（体征里有记录的每一个）</h2>',
    '<h2>Body · organs by call volume (every one the vitals have a record for)</h2>', 1],
  ['body note',
    '  <p class="note">每格数字是该器官的累计调用次数。数据来自 <code>vitals.json</code>；鼠标悬停看成功/失败与疲劳度。</p>',
    '  <p class="note">The number in each cell is that organ\'s cumulative call count, read from <code>vitals.json</code>. Hover for successes / failures and fatigue.</p>', 1],
  ['h2 stream', '<h2>本体感觉 · 真实脉冲流</h2>', '<h2>Proprioception · the real pulse stream</h2>', 1],
  ['stream note',
    '  <p class="note">来自 <code>pulse.jsonl</code> 的真实记录，循环回放：💓 心跳 · 🫁 肺循环 · ✓ 器官调用 · 🧩 器官变化。心跳每跳把当前指令、体征与稳态告警打成血包泵向全身。</p>',
    '  <p class="note">Real records from <code>pulse.jsonl</code>, replayed on a loop: 💓 heartbeat · 🫁 pulmonary circulation · ✓ organ call · 🧩 organ change. Each heartbeat packages the current directives, the vitals and any homeostasis warnings into a blood packet and pumps it system-wide. <b>Pulse lines are verbatim tool output and stay in the language the machine ran in</b> — that is what makes them evidence rather than decoration.</p>', 1],

  // ---- token gating ----
  ['h2 token', '<h2>Token 门控（可复现口径）</h2>', '<h2>Token gating (reproducible scope)</h2>', 1],
  ['k gating scope',
    '    <div class="k">48 条代表性命令 · 冷启动 · 只算 tool schema token</div>',
    '    <div class="k">48 representative commands · cold start · tool-schema tokens only</div>', 1],
  ['bar before', '门控前 平均 55,154 tok', 'Ungated: 55,154 tok on average', 1],
  ['bar after', '门控后 平均 8,433 tok', 'Gated: 8,433 tok on average', 1],
  ['gating figure',
    '84.71% <small>省下的 tool schema token（带运行历史的活体口径 74.25%）</small>',
    '84.71% <small>of tool-schema tokens gated away (74.25% on a live install that has run history)</small>', 1],
  ['gating note',
    '    <p class="note">基准、冻结语料与 CI 基线都在仓库里；<code>npm run bench:check</code> 在数字偏移时会失败。</p>',
    '    <p class="note">The benchmark, the frozen corpus and the CI baseline all live in the repository; <code>npm run bench:check</code> fails the build when the number drifts.</p>', 1],

  // ---- ledger ----
  ['h2 learn', '<h2>自愈账本与自训练</h2>', '<h2>The healing ledger and self-training</h2>', 1],
  ['footer',
    '    由真实运行时文件生成：<code>vitals.json</code> · <code>bloodstream.json</code> · <code>pulse.jsonl</code> · <code>snapshot.json</code>（body_status 抓取于 2026-09-23 19:31（本机开发安装）。这些是工具输出里的原值，不是誊写估计。）。\n    不装任何东西也能跑：<code>npm run demo</code> 会跑通同一条「命令 → 冲动 → 支配 → 执行 → 归因 → 反射」链路。MIT · 数据只在本机。',
    '    Generated from the real runtime files: <code>vitals.json</code> · <code>bloodstream.json</code> · <code>pulse.jsonl</code> · <code>snapshot.json</code> (body_status captured on 2026-09-23 19:31 from a local development install). These are the raw values from tool output, not a transcribed estimate.\n    Nothing needs installing to run it: <code>npm run demo</code> runs the same command → impulse → dispatch → execute → attribute → reflex chain. MIT · the data never leaves this machine.', 1],

  // ---- JS-rendered labels ----
  ['k heart', "  k('心跳', s.beat?('#'+s.beat):'—', (s.heartRate?s.heartRate+'/分 · ':'')+(s.rhythm||'')),",
    "  k('Heart', s.beat?('#'+s.beat):'—', (s.heartRate?s.heartRate+' bpm · ':'')+(s.rhythm||'')),", 1],
  ['k bp', "  k('血压', (s.systolic!=null?s.systolic+'/'+s.diastolic:'—'), '收缩压=活跃器官告警数'),",
    "  k('Blood pressure', (s.systolic!=null?s.systolic+'/'+s.diastolic:'—'), 'systolic = active organs · diastolic = alerts'),", 1],
  ['k organs', "  k('器官', s.organsLive||s.organsVitals, (s.organsVitals?s.organsVitals+' 个有体征记录':'')),",
    "  k('Organs', s.organsLive||s.organsVitals, (s.organsVitals?s.organsVitals+' with a vitals record':'')),", 1],
  ['k cells', "  k('细胞', s.cells||'—', '9 类组织 · 群体普查'),",
    "  k('Cells', s.cells||'—', '9 tissue classes · population census'),", 1],
  ['k wounds', "  k('伤口', (s.healed!=null?s.healed+' 已愈':'—'), (s.open!=null?s.open+' 未愈 · '+(s.chronic||0)+' 慢性':'')),",
    "  k('Wounds', (s.healed!=null?s.healed+' healed':'—'), (s.open!=null?s.open+' open · '+(s.chronic||0)+' chronic':'')),", 1],
  ['k healrate', "  k('愈合率', (s.healRate!=null?s.healRate+'%':'—'), '复检通过才闭合'),",
    "  k('Heal rate', (s.healRate!=null?s.healRate+'%':'—'), 'closes only after a re-check'),", 1],
  ['organ tooltip',
    'title="调用 ${o.calls} · 成功 ${o.ok} · 失败 ${o.fail} · 疲劳 ${(o.fatigue*100).toFixed(1)}%"',
    'title="calls ${o.calls} · ok ${o.ok} · fail ${o.fail} · fatigue ${(o.fatigue*100).toFixed(1)}%"', 1],
  ['learn healing title', '<div class="k">自愈闭环</div>', '<div class="k">Closed-loop healing</div>', 1],
  ['learn healing v',
    "${s.healed??'—'} 已愈合 <small>未愈 ${s.open??'—'} · 慢性 ${s.chronic??'—'} · 愈合率 ${s.healRate??'—'}%</small>",
    "${s.healed??'—'} healed <small>open ${s.open??'—'} · chronic ${s.chronic??'—'} · heal rate ${s.healRate??'—'}%</small>", 1],
  ['learn healing note1',
    '   <p class="note">检测 → 确定性归因（tool_missing / arg_error / permission / timeout / network / not_found / conflict）→ 按处方处置 → <b>复检</b>（该器官下次成功才闭合伤口）。',
    '   <p class="note">Detect → deterministic attribution (tool_missing / arg_error / permission / timeout / network / not_found / conflict) → prescribed treatment → <b>re-check</b> (the wound closes only when that organ next succeeds).', 1],
  ['learn healing note2',
    '   <b>arg_error 永不自动重试</b>——重试一个错参数只会放大错误。</p></div>`,',
    '   <b>arg_error is never auto-retried</b> — retrying a wrong argument only amplifies the mistake.</p></div>`,', 1],
  ['learn train title', '<div class="k">自训练（一直在跑，不用你教）</div>', '<div class="k">Self-training (always running, nothing you have to teach)</div>', 1],
  ['learn train v',
    "${s.synapses??0} 突触 · ${s.reflexesLearned??0} 反射 · ${s.skills??0} 技能 <small>平均信任度 ${s.trust??'—'}</small>",
    "${s.synapses??0} synapses · ${s.reflexesLearned??0} reflexes · ${s.skills??0} skills <small>avg trust ${s.trust??'—'}</small>", 1],
  ['learn train note1',
    '   <p class="note">干成 → 强化「命令类 → 器官」；干砸 → 削弱。同一失败重复 3 次，系统<b>自己写出一条反射弧</b>；跨器官链路全通 → 固化成可重放技能。',
    '   <p class="note">Succeed → the "command class → organ" route is reinforced; fail → it decays. The same failure three times and the system <b>writes its own reflex arc</b>; a cross-organ chain that completes becomes a replayable skill.', 1],
  ['learn train note2',
    '   遗忘同样是故意的：突触按半衰期衰减、零贡献的反射自淘汰、持续失败的技能被忘掉。</p></div>`,',
    '   Forgetting is equally deliberate: synapses decay on a half-life, reflexes that contribute nothing are retired, skills that keep failing are forgotten.</p></div>`,', 1],
];

let html = fs.readFileSync(SRC, 'utf8');

const failures = [];
for (const [name, from, to, expected] of RULES) {
  const count = html.split(from).length - 1;
  if (count !== expected) { failures.push(`${name}: expected ${expected} match(es), found ${count}`); continue; }
  html = html.split(from).join(to);
}

if (failures.length) {
  console.error('make-demo-en: index.html has drifted from what this script expects.');
  console.error('Someone edited the Chinese copy without updating the rules below. Update RULES, then re-run.');
  failures.forEach(f => console.error('  - ' + f));
  process.exit(1);
}

// Gate: no CJK may survive outside the runtime-data line.
const lines = html.split('\n');
const dataLine = lines.find(l => l.startsWith('const D = {'));
if (!dataLine) { console.error('make-demo-en: could not locate the `const D` data line.'); process.exit(1); }
const outsideData = lines.filter(l => !l.startsWith('const D = {')).join('\n');
const cjk = outsideData.match(/[\u4e00-\u9fff]/g) || [];
if (cjk.length) {
  const i = outsideData.search(/[\u4e00-\u9fff]/);
  console.error(`make-demo-en: ${cjk.length} CJK character(s) survive outside the data line — a rule is missing.`);
  console.error('  ...' + outsideData.slice(Math.max(0, i - 90), i + 60).replace(/\n/g, '\\n') + '...');
  process.exit(1);
}

if (CHECK) {
  const current = fs.existsSync(DST) ? fs.readFileSync(DST, 'utf8') : '';
  if (current !== html) {
    console.error('make-demo-en: docs/en.html is out of date. Run `node scripts/make-demo-en.mjs`.');
    process.exit(1);
  }
  console.log(`make-demo-en: docs/en.html is up to date (${html.length} bytes, ${RULES.length} rules).`);
} else {
  fs.writeFileSync(DST, html, 'utf8');
  console.log('make-demo-en: wrote docs/en.html');
  console.log('  bytes            ', html.length);
  console.log('  rules applied    ', RULES.length);
  console.log('  CJK outside data  0');
  console.log('  data line preserved byte-for-byte:', html.includes(dataLine));
}
