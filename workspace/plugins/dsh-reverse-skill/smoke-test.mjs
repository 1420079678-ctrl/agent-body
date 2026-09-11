// dsh-reverse-skill 引擎冒烟测试（不依赖 cordis 运行时，直接测纯逻辑导出）
import {
  resolveRepoRoot, loadRouting, routeHint, listModules, readModule,
  DOCTRINE, caseAction, journalAction, loadManifest, scanTools, whichSync,
} from './lib/index.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'revskill-test-'))

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) } }

console.log('[1] 仓库探测 + 路由表加载')
// 先用真实 DSH_HOME 测自动探测，再切到临时目录隔离案件/经验库写入
const detected = resolveRepoRoot()
ok(!!detected, `自动探测到 reverse-skill 仓库：${detected || '(未找到)'}`)
if (!detected) { console.log('\n仓库缺失，后续测试跳过'); process.exit(1) }
process.env.DSH_HOME = TMP
const repo = resolveRepoRoot(detected)
ok(repo === detected, '显式 repoRoot 配置生效')
const cfg = loadRouting(repo)
ok(!!cfg, 'routing.json 加载成功')
ok(cfg.priority.length >= 40, `priority 条数=${cfg.priority.length}（≥40）`)
ok(Object.keys(cfg.routes).length === cfg.priority.length, `routes 数 ${Object.keys(cfg.routes).length} == priority 数 ${cfg.priority.length}`)

console.log('[2] 全量路由正则的 JS 兼容性（PowerShell 正则 → JS RegExp）')
let compiled = 0, broken = []
for (const id of Object.keys(cfg.routes)) {
  for (const kw of cfg.routes[id].keywords || []) {
    for (const pat of [kw.must, kw.exclude, ...(kw.mustAll || [])].filter(Boolean)) {
      try { new RegExp(pat, 'i'); compiled++ } catch (e) { broken.push(`${id}: ${String(e.message).slice(0, 60)}`) }
    }
  }
}
ok(broken.length === 0, `${compiled} 条正则全部可编译${broken.length ? '；失败：' + broken.join(' | ') : ''}`)

console.log('[3] 路由裁决（真实任务描述 + 上游 master-route.ps1 实测基准）')
// 下表的期望值全部来自上游 skills/scripts/master-route.ps1 的实测输出（2026-09-10，reverse-skill@7e2097f），
// 作为移植保真度的回归锚点：本插件路由结果必须与上游逐条一致。
const cases = [
  ['js 前端签名逆向，webpack 打包的加密参数还原', 'R3', 'medium'],
  ['APK 反编译 重打包 绕过证书校验', 'R1', 'medium'],
  ['IDA 反编译一个 stripped 二进制，追踪数据流', 'R6', 'high'],
  ['从厂商补丁差分定位漏洞并写 N-day PoC', 'R16', 'high'],
  ['EDR 免杀，直接系统调用绕过 hook', 'R18', 'high'],
  ['对目标做完整渗透，从外网打到域控', 'R10', 'high'],
  ['SQL 注入 + 目录爆破 渗透测试工具链', 'R11', 'high'],
  ['固件提取 binwalk 然后 QEMU 仿真 fuzz', 'R8', 'high'],
  ['随便聊聊天今天天气不错', 'R0', 'low'],
]
for (const [hint, expect, conf] of cases) {
  const r = routeHint(cfg, hint)
  const good = r.primary === expect && r.confidence === conf
  if (good) pass++; else fail++
  console.log(`  ${good ? '✓' : '✗'} 「${hint.slice(0, 26)}」→ ${r.primary}(${r.confidence}) 上游=${expect}(${conf})`)
}
{
  const r = routeHint(cfg, 'js 前端签名逆向，webpack 打包的加密参数还原')
  ok(r.ruleHits.length > 0 && r.skill.endsWith('SKILL.md'), `路由含命中依据(${r.ruleHits.length} 条) + 技能路径`)
  const empty = routeHint(cfg, '')
  ok(empty.primary === cfg.meta.fallbackId && empty.confidence === 'low', '空 hint → 回退 R0 + low 置信')
}

console.log('[4] 技能目录 + 模块读取')
const mods = listModules(repo)
ok(mods.length >= 40, `模块数=${mods.length}（≥40）`)
ok(mods.some(m => m.module === 'js-reverse'), '含 js-reverse 模块')
ok(mods.some(m => m.module === 'reverse-engineering/dsl-vm-reverse'), '含二级模块 reverse-engineering/dsl-vm-reverse')
const sk = readModule(repo, 'js-reverse')
ok(sk.ok && sk.text.length > 500, `读到 js-reverse/SKILL.md（${sk.text.length} 字符）`)
const escape = readModule(repo, 'js-reverse', '../../../../etc/passwd')
ok(!escape.ok, '路径越界被拒绝')
const miss = readModule(repo, 'js-reverse', 'references/nope.md')
ok(!miss.ok && miss.text.includes('可读文件'), '不存在文件给出可读清单')

console.log('[5] 方法论')
ok(Object.keys(DOCTRINE).length >= 8, `内置方法论主题=${Object.keys(DOCTRINE).length}`)
ok(DOCTRINE.adf.includes('R4*') && DOCTRINE.adf.includes('R43'), 'ADF 含 validated 门槛与死锁重规划')
ok(DOCTRINE.blindspot.includes('R78') && DOCTRINE.blindspot.includes('R80'), 'BS 含 LLM 幻觉与上下文污染')

console.log('[6] 案件链（Evidence→Finding→Path）')
const cfgObj = { repoRoot: repo, caseRoot: join(TMP, 'cases'), anchorFirstTurn: false }
let out = caseAction(cfgObj, { action: 'init', case: 'T-1', target: 'http://demo.local', intent: '漏洞验证' })
ok(out.includes('已建案件'), 'init 建案件')
// 造一个证据文件用于 hash 校验
const artDir = join(TMP, 'cases', 'T-1', 'artifacts')
mkdirSync(artDir, { recursive: true })
writeFileSync(join(artDir, 'proof.txt'), 'proof-of-concept-001', 'utf8')
out = caseAction(cfgObj, { action: 'evidence', case: 'T-1', title: '目录遍历返回 200', reproCommand: 'curl -s http://demo.local/../../etc/passwd', sourceType: 'command', artifactPath: 'artifacts/proof.txt' })
ok(out.includes('E-001') && out.includes('hash='), 'evidence 落地并记录 sha256')
out = caseAction(cfgObj, { action: 'evidence', case: 'T-1', title: '第二条独立证据（动态侧）', reproCommand: 'frida hook 验证', sourceType: 'command' })
ok(out.includes('E-002'), 'E-002 落地')
out = caseAction(cfgObj, { action: 'finding', case: 'T-1', title: '无证据结论', status: 'candidate' })
ok(out.includes('必须给 evidenceIds'), '无证据结论被拒绝登记')
out = caseAction(cfgObj, { action: 'finding', case: 'T-1', title: '引用不存在的证据', evidenceIds: 'E-999' })
ok(out.includes('拒绝登记'), '引用不存在证据被拒绝')
out = caseAction(cfgObj, { action: 'finding', case: 'T-1', title: '单证据想升 validated', evidenceIds: 'E-001', status: 'validated', confidence: 'high' })
ok(out.includes('ADF R4*'), '单证据升 validated 被拒绝（R4*）')
out = caseAction(cfgObj, { action: 'finding', case: 'T-1', title: '目录遍历', evidenceIds: 'E-001,E-002', status: 'validated', confidence: 'high', severity: 'high', category: 'vuln' })
ok(out.includes('F-001'), '双证据升 validated 通过')
out = caseAction(cfgObj, { action: 'path', case: 'T-1', title: '攻击路径', pathType: 'attack', steps: '探测目录遍历 — E-001;读文件 — E-001,E-002', goal: '读取敏感文件' })
ok(out.includes('P-001'), 'path 登记')
out = caseAction(cfgObj, { action: 'review', case: 'T-1' })
ok(out.includes('review'), `review 执行：${out.split('\n')[0]}`)
ok(out.includes('工作项') || out.includes('通过') || out.includes('问题'), 'review 输出结构完整')
// hash 篡改检测
writeFileSync(join(artDir, 'proof.txt'), 'TAMPERED', 'utf8')
out = caseAction(cfgObj, { action: 'review', case: 'T-1' })
ok(out.includes('hash 不匹配'), 'artifact 被篡改 → review 检出 hash 不匹配')
out = caseAction(cfgObj, { action: 'status', case: 'T-1' })
ok(out.includes('证据：2') && out.includes('validated 1'), `status 统计正确`)

console.log('[7] 经验库（自进化）')
out = journalAction(cfgObj, 'add', { title: 'XX 系统目录遍历 + 无鉴权读文件', scenario: '黑盒 web 测试', chain: 'swagger 泄露 → 路径穿越 → 读 /etc/passwd', pattern: '先找 swagger/api-docs 再试路径穿越，比盲扫快十倍', pitfalls: 'WAF 拦 ../，用 ..%2f 双编码绕过', tags: 'web,path-traversal', route: 'R11' })
ok(out.includes('已回写'), 'journal add 落地')
out = journalAction(cfgObj, 'search', { query: '路径穿越 swagger' })
ok(out.includes('命中') && out.includes('比盲扫快十倍'), 'journal search 命中并回带可复用模式')
out = journalAction(cfgObj, 'search', { query: '毫无关联的词组xyz' })
ok(out.includes('无命中'), 'journal 无关词不误命中')
out = journalAction(cfgObj, 'index', {})
ok(out.includes('共 1 条'), 'journal index 正常')

console.log('[8] 工具自举')
const caps = loadManifest(repo)
ok(caps.length >= 20, `能力清单=${caps.length} 项`)
ok(caps.some(c => c.name === 'jadx') && caps.some(c => c.name === 'frida'), '含 jadx / frida')
ok(whichSync('node') !== null, `PATH 探测可用（node → ${whichSync('node')}）`)
ok(whichSync('definitely-not-a-real-tool-xyz') === null, '不存在的工具返回 null')
const rows = scanTools(repo)
ok(rows.length === caps.length, `scanTools 覆盖全部能力（${rows.length}）`)
const found = rows.filter(r => r.found).map(r => r.name)
console.log(`    本机已装：${found.join(', ') || '(无)'}`)

console.log('[9] 插件入口结构（cordis 契约）')
const mod = await import('./lib/index.js')
ok(mod.name === '@dsh-external/dsh-reverse-skill', `插件名=${mod.name}`)
ok(Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('systemPrompt'), `inject=${JSON.stringify(mod.inject)}`)
ok(typeof mod.apply === 'function', 'apply 为函数')
ok(!!mod.Config && typeof mod.Config === 'function', 'Config 为 schemastery schema')
try {
  const parsed = new mod.Config({})
  ok(parsed.anchorFirstTurn === true && parsed.repoRoot === '', 'Config 默认值正确（anchor=true, repoRoot 空）')
} catch (e) { ok(false, `Config 解析失败：${String(e)}`) }

console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
