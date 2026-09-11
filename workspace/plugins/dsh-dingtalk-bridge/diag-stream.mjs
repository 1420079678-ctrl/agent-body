/** 诊断：观察钉钉 Stream 连接 40 秒，记录所有服务端消息与断连时机 */
const APPKEY = 'dingkjchb9nefms6gpt9'
const APPSECRET = 'XSFyhoGY4CyTMiTtjAiUlUxm-Jv-LHNZOuHLvoJTCjyquDEJN8iwWQ-g5OmijkFc'

async function main() {
  const tokenRes = await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${APPKEY}&appsecret=${encodeURIComponent(APPSECRET)}`, { signal: AbortSignal.timeout(15000) })
  const tokenBody = await tokenRes.json()
  const openRes = await fetch('https://api.dingtalk.com/v1.0/gateway/connections/open', {
    method: 'POST',
    headers: { Accept: 'application/json', 'access-token': tokenBody.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: APPKEY, clientSecret: APPSECRET, ua: 'dsh-dingtalk-bridge-diag/0.1', subscriptions: [{ type: 'EVENT', topic: '/v1.0/im/bot/messages/get' }] }),
    signal: AbortSignal.timeout(15000),
  })
  const openBody = await openRes.json()
  const ws = new WebSocket(`${openBody.endpoint}?ticket=${openBody.ticket}`)
  const t0 = Date.now()
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'

  ws.onopen = () => console.log(`[${ts()}] OPEN`)
  ws.onmessage = (ev) => {
    const raw = String(ev.data)
    if (!raw) { console.log(`[${ts()}] <message> 空帧（心跳）`); return }
    let msg
    try { msg = JSON.parse(raw) } catch { console.log(`[${ts()}] <message> 非JSON:`, raw.slice(0, 100)); return }
    if (msg.type === 'SYSTEM') {
      console.log(`[${ts()}] SYSTEM topic=${msg.headers?.topic}`)
      if (msg.headers?.topic === 'ping') {
        ws.send(JSON.stringify({ code: 200, headers: msg.headers, message: 'OK', data: msg.data }))
        console.log(`[${ts()}]   → 回 pong`)
      }
    } else if (msg.type === 'EVENT') {
      console.log(`[${ts()}] EVENT topic=${msg.headers?.topic} data=${String(msg.data).slice(0, 150)}`)
      ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId: msg.headers?.messageId ?? '' }, message: 'OK', data: JSON.stringify({ status: 'SUCCESS' }) }))
    } else {
      console.log(`[${ts()}] <other> type=${msg.type}`, JSON.stringify(msg).slice(0, 150))
    }
  }
  ws.onclose = (e) => console.log(`[${ts()}] CLOSE code=${e.code} reason=${e.reason || ''}`)
  ws.onerror = (e) => console.log(`[${ts()}] ERROR`, e.message || e.type || '')
  setTimeout(() => { console.log(`[${ts()}] 诊断结束`); ws.close(); process.exit(0) }, 40000)
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
