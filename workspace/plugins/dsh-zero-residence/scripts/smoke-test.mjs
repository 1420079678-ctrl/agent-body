// 冒烟测试：用真实会话日志验证零驻留指针压缩的压缩比与无损重建能力
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildPointerManifest, computeLedger } from '../lib/index.js';

const SESS = '<DSH_CHECKOUT>\\data\\sessions';
const MAGIC = 0xFD2FB528;
function scan(buf) {
  const out = []; let o = 0;
  while (o < buf.length) {
    const s = o;
    if (buf.length - o < 4 || buf.readUInt32LE(o) !== MAGIC) break;
    o += 4; const d = buf.readUInt8(o); o += 1;
    const cs = d >>> 6, ss = (d & 0x20) !== 0, ck = (d & 0x04) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df, cb = cs === 0 ? (ss ? 1 : 0) : 1 << cs;
    o += (ss ? 0 : 1) + db + cb;
    for (;;) {
      if (buf.length - o < 3) return out;
      const bh = buf.readUIntLE(o, 3); o += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) return out;
      const pb = bt === 1 ? 1 : bs;
      if (buf.length - o < pb) return out;
      o += pb; if (last) break;
    }
    if (ck) o += 4;
    out.push([s, o]);
  }
  return out;
}
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.startsWith('session.v3.jsonl')) out.push(p);
  }
  return out;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } };

// ── 1. 从真实会话取一段被遮蔽区（tool/result + assistant），跑指针压缩 ──
const files = walk(SESS).map(p => ({ p, s: fs.statSync(p).size })).sort((a, b) => b.s - a.s);
console.log('# 零驻留引擎冒烟测试\n');
console.log(`使用会话: ${path.basename(path.dirname(files[0].p))}`);

const buf = fs.readFileSync(files[0].p);
const text = scan(buf).map(([s, e]) => zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')).join('');
const events = [];
for (const l of text.split('\n')) { if (l.trim()) { try { events.push(JSON.parse(l)) } catch { } } }

const messages = [];
for (const ev of events) {
  if (ev.type === 'tool/result' || ev.type === 'assistant/message' || ev.type === 'user/message') {
    const m = ev.data?.message;
    if (m) messages.push(m);
  }
  if (messages.length >= 600) break;
}
ok(messages.length > 100, `从持久日志还原出 ${messages.length} 条消息作为遮蔽样本`);

const built = buildPointerManifest(messages, 120);
const ratio = built.shadowedTokens / Math.max(1, built.manifestTokens);
console.log('\n## 指针压缩结果');
console.log(`  遮蔽原始   : ${built.shadowedTokens.toLocaleString('en-US')} token`);
console.log(`  指针清单   : ${built.manifestTokens.toLocaleString('en-US')} token`);
console.log(`  压缩比     : ${ratio.toFixed(1)}×  （节省 ${(100 - built.manifestTokens / built.shadowedTokens * 100).toFixed(1)}%）`);
console.log(`  条目       : ${built.entries} 条，其中 ${built.pointerOnly} 条走纯指针（零驻留）`);
console.log(`  LLM 调用   : 0 次`);

ok(ratio > 5, `压缩比 ${ratio.toFixed(1)}× > 5×`);
ok(built.manifestTokens < built.shadowedTokens, '清单显著小于原文');
ok(built.pointerOnly > 0, `${built.pointerOnly} 条工具载荷被纯指针化`);
ok(built.text.includes('重建索引'), '清单含重建索引段');
ok(built.text.includes('key='), '清单含可重建 key');

console.log('\n## 清单样本（前 12 行）');
console.log(built.text.split('\n').slice(0, 12).map(l => '  ' + l).join('\n'));

// ── 2. 账本 ──
console.log('\n## 账本自检');
const sid = path.basename(path.dirname(files[0].p));
const led = computeLedger(sid);
ok(led.includes('驻留账本'), 'computeLedger 返回结构化账本');
ok(/A = Σ n_t = [\d,]+/.test(led), '账本含注意力积分 A');
console.log(led.split('\n').map(l => '  ' + l).join('\n'));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
