/**
 * Agent-Body 解剖/体征面板（宿主半）。
 *
 * 为什么是宿主半而不是客户端 slot：客户端半必须是模块加载器包裹的打包产物
 * （`window.__ModuleLoader__.load({id, factory})`），需要 tsdown/vite 构建链；
 * 而体征数据本来就在宿主侧的文件里，用 `ctx.webServer.register` 挂两个路由
 * （页面 + 实时 JSON）即可拿到一个**不需要构建、可热注入、可随时卸载**的活体面板。
 *
 * 数据来源（每次请求现读，不是快照）：
 *   $DSH_HOME/plugins/dsh-organism/
 *     ├─ bloodstream.json   心跳 / 血压 / 愈合账本 / 学习计数
 *     ├─ vitals.json        器官体征（[id, 统计] 对）
 *     ├─ reflexes.json      持久化反射弧
 *     └─ pulse.jsonl        真实脉冲流（取尾部若干条）
 *
 * 路由：
 *   GET /anatomy            自包含 HTML 面板（原生 JS 每 3 秒拉一次 JSON）
 *   GET /anatomy/data.json  上面那些文件的实时投影
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

export const name = '@dsh-external/dsh-anatomy-panel'

/** webServer 是硬依赖：没有它这个面板没有意义（缺失时加载期就报错，不静默降级）。 */
export const inject = ['webServer']

const PANEL_PATH = '/anatomy'
const DATA_PATH = '/anatomy/data.json'

function organismDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-organism')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 读 pulse.jsonl 的尾部若干行（文件可能很大，只读最后 256KB）。 */
async function readTailLines(file, maxBytes, maxLines) {
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const stream = createReadStream(file, { start, end: size - 1, encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    const lines = []
    for await (const line of rl) {
      if (line.trim()) lines.push(line)
      if (lines.length > maxLines * 2) lines.splice(0, lines.length - maxLines * 2)
    }
    stream.close()
    return lines.slice(-maxLines)
  } catch {
    return []
  }
}

const KEEP_KINDS = new Set(['heart', 'reflex', 'alert', 'discover', 'law', 'obey', 'organ', 'call'])

async function buildSnapshot(pulseLimit) {
  const dir = organismDir()
  const blood = readJson(join(dir, 'bloodstream.json')) ?? {}
  const vitals = readJson(join(dir, 'vitals.json')) ?? {}
  const reflexes = readJson(join(dir, 'reflexes.json')) ?? []

  const organs = []
  for (const item of vitals.organs ?? []) {
    if (!Array.isArray(item) || item.length < 2 || typeof item[1] !== 'object') continue
    const st = item[1] ?? {}
    organs.push({
      id: String(item[0]),
      calls: Number(st.calls ?? 0),
      ok: Number(st.ok ?? 0),
      fail: Number(st.fail ?? 0),
      fatigue: Number(st.fatigue ?? 0),
    })
  }
  organs.sort((a, b) => b.calls - a.calls)

  const raw = await readTailLines(join(dir, 'pulse.jsonl'), 262144, pulseLimit * 3)
  const pulses = []
  for (const line of raw) {
    try {
      const j = JSON.parse(line)
      if (!KEEP_KINDS.has(j.kind)) continue
      pulses.push({
        t: j.t ?? 0,
        k: j.kind ?? '',
        o: j.organ ?? '',
        tool: j.tool ?? '',
        n: String(j.note ?? '').slice(0, 170),
      })
    } catch {
      // 单行坏数据不该让整面板失败：跳过，继续读下一行
    }
  }

  const healing = blood.healing ?? {}
  const learning = blood.learning ?? {}
  const pressure = blood.pressure ?? {}

  return {
    at: Date.now(),
    available: existsSync(join(dir, 'bloodstream.json')),
    dir,
    beat: blood.beat ?? null,
    rhythm: blood.rhythm ?? null,
    heartRate: blood.heartRate ?? null,
    systolic: pressure.systolic ?? null,
    diastolic: pressure.diastolic ?? null,
    healed: healing.healed ?? null,
    open: healing.open ?? null,
    chronic: healing.chronic ?? null,
    healRate: healing.rate == null ? null : Math.round(Number(healing.rate) * 1000) / 10,
    synapses: learning.synapses ?? null,
    reflexesLearned: learning.reflexes ?? null,
    skills: learning.skills ?? null,
    trust: learning.trust ?? null,
    reflexesPersisted: Array.isArray(reflexes) ? reflexes.length : 0,
    organs,
    pulses: pulses.slice(-pulseLimit),
  }
}

function panelHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent-Body · 解剖与体征</title>
<style>
 :root{--bg:#0b0e13;--panel:#121721;--line:#1e2634;--ink:#e8edf5;--dim:#8b97a8;--ok:#39d98a;--bad:#f0506e;--pulse:#5b8def;--warn:#f5a524}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 ui-sans-serif,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 .wrap{padding:18px 20px 40px}
 h1{font-size:19px;margin:0 0 2px}
 .sub{color:var(--dim);font-size:12.5px;margin:0 0 14px}
 .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
 .k{color:var(--dim);font-size:11.5px;letter-spacing:.05em;text-transform:uppercase}
 .v{font-size:20px;font-weight:600;margin-top:2px}
 .v small{font-size:12px;color:var(--dim);font-weight:400}
 h2{font-size:14px;margin:22px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line);color:#c9d4e4}
 .orgs{display:flex;flex-wrap:wrap;gap:5px}
 .organ{border:1px solid var(--line);border-radius:7px;padding:3px 8px;font-size:12px;color:#b9c4d4;background:#0e131c;transition:all .25s}
 .organ.hit{border-color:var(--ok);color:#eafff4;box-shadow:0 0 12px rgba(57,217,138,.25)}
 .organ small{color:var(--dim);margin-left:5px}
 #stream{height:200px;overflow:hidden;font-size:12px}
 #stream div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px dashed #161d29;padding:2px 0}
 .hk{color:var(--bad)}.hd{color:var(--ok)}.hp{color:var(--pulse)}.ha{color:var(--warn)}.hm{color:var(--dim)}
 .stale{color:var(--warn)}
 footer{color:var(--dim);font-size:11.5px;margin-top:24px;border-top:1px solid var(--line);padding-top:10px}
</style></head>
<body><div class="wrap">
  <h1>Agent-Body · 解剖与体征</h1>
  <p class="sub">实时读取 <code>${'$DSH_HOME'}/plugins/dsh-organism</code> 的运行时文件；本页每 3 秒刷新。心跳 <span id="hb">💓</span></p>
  <div class="grid" id="stats"></div>
  <h2>器官（按累计调用量）</h2>
  <div class="card" style="max-height:260px;overflow:auto"><div class="orgs" id="body"></div></div>
  <h2>本体感觉 · 真实脉冲流</h2>
  <div class="card"><div id="stream"></div></div>
  <p class="sub" id="meta"></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
const cls = {heart:'hm',reflex:'hp',alert:'ha',discover:'hd',law:'hp',obey:'hk',organ:'hd',call:'hm'};
const icon = {heart:'💓',reflex:'⚡',alert:'⚠',discover:'🫁',law:'§',obey:'🛡',organ:'🧩',call:'✓'};
let lastSeen = 0;
let bodyCount = 0;
/** 脉冲的实际文案：organism 里 call 类脉冲的 note 常为空，那就退回工具名 / 器官名，不留空行。 */
function pulseText(p){
  const body = (p.n && p.n.trim()) || p.tool || p.o || p.k;
  return (icon[p.k] || '·') + ' ' + body;
}
async function tick(){
  try{
    const r = await fetch('/anatomy/data.json', { cache: 'no-store' });
    if(!r.ok){ $('meta').innerHTML = '<span class="stale">数据不可用（HTTP ' + r.status + '）—— 器官可能未安装</span>'; return; }
    const d = await r.json();
    $('stats').innerHTML = [
      ['心跳', d.beat != null ? '#' + d.beat : '—', (d.heartRate != null ? d.heartRate + '/分 · ' : '') + (d.rhythm || '')],
      ['血压', d.systolic != null ? d.systolic + '/' + d.diastolic : '—', '收缩压=活跃告警'],
      ['器官', d.organs.length, '有体征记录的'],
      ['伤口', d.healed != null ? d.healed + ' 已愈' : '—', (d.open ?? '—') + ' 未愈 · ' + (d.chronic ?? '—') + ' 慢性'],
      ['愈合率', d.healRate != null ? d.healRate + '%' : '—', '复检通过才闭合'],
      ['自训练', (d.synapses ?? 0) + ' 突触 · ' + (d.reflexesLearned ?? 0) + ' 反射', (d.skills ?? 0) + ' 技能 · 信任度 ' + (d.trust ?? '—')],
    ].map(([k,v,s]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + (s ? ' <small>' + s + '</small>' : '') + '</div></div>').join('');
    if ($('body').childElementCount !== d.organs.length || bodyCount !== d.organs.length) {
      $('body').innerHTML = d.organs.map(o => '<span class="organ" data-id="' + o.id + '" title="调用 ' + o.calls + ' · 成功 ' + o.ok + ' · 失败 ' + o.fail + '">' + o.id + '<small>' + o.calls + '</small></span>').join('');
      bodyCount = d.organs.length;
    }
    const tail = d.pulses.slice(-18).reverse();
    $('stream').innerHTML = tail.map(p => '<div class="' + (cls[p.k] || 'hm') + '">' + pulseText(p) + '</div>').join('');
    const newest = tail.length ? tail[0] : null;
    if (newest && newest.t > lastSeen) {
      lastSeen = newest.t;
      if (newest.o) { const t = document.querySelector('.organ[data-id="' + newest.o + '"]'); if (t) { t.classList.add('hit'); setTimeout(() => t.classList.remove('hit'), 900); } }
    }
    $('meta').textContent = '采样 ' + new Date(d.at).toLocaleTimeString() + ' · 数据目录 ' + d.dir + ' · 本机数据，不上传';
  } catch(e){
    $('meta').innerHTML = '<span class="stale">读取失败：' + e + '</span>';
  }
}
tick(); setInterval(tick, 3000);
</script></body></html>`
}

export function apply(ctx) {
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: PANEL_PATH,
      handler: async (req, res) => {
        send(res, 200, 'text/html; charset=utf-8', panelHtml())
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: DATA_PATH,
      handler: async (req, res) => {
        try {
          const snap = await buildSnapshot(120)
          if (!snap.available) {
            send(res, 503, 'application/json; charset=utf-8',
              JSON.stringify({ error: 'organism runtime files not found', dir: snap.dir }))
            return
          }
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify(snap))
        } catch (error) {
          send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: String(error) }))
        }
      },
    }),
  )

  ctx.logger?.info?.(`anatomy panel at ${PANEL_PATH} (data ${DATA_PATH})`)
}
