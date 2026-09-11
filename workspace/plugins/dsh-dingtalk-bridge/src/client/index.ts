/**
 * @dsh-external/dsh-dingtalk-bridge — client 面板（conversation.view slot）。
 * 遵循已装配插件（dsh-invest-master）验证过的模式：
 *   - require('react') + React.createElement（无 JSX）
 *   - 面板本体为 vanilla DOM（useEffect 挂载），轮询 /dingtalk-bridge/api/status
 *   - ctx.slots.inject('conversation.view', () => ctx.slots.register({...}, Component))
 */

const React = require('react')

export const inject = ['slots']

const API = '/dingtalk-bridge/api'
const STATUS_LABEL = {
  idle: '待连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  error: '出错',
  disabled: '未配置',
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function injectStyles() {
  if (document.getElementById('dtb-styles')) return
  const s = document.createElement('style')
  s.id = 'dtb-styles'
  s.textContent = `
.dtb-wrap{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:#e6eaf2;font-size:13px;line-height:1.6;padding:14px 16px;border-radius:14px;
  background:linear-gradient(180deg,#131a24,#0d1117);border:1px solid rgba(148,163,184,.12);margin:2px 0}
.dtb-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.dtb-title{font-size:15px;font-weight:800;letter-spacing:.3px;display:flex;align-items:center;gap:8px}
.dtb-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(148,163,184,.15)}
.dtb-dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dtb-ok .dtb-dot{background:#3fb950;box-shadow:0 0 8px #3fb950}
.dtb-warn .dtb-dot{background:#d29922;box-shadow:0 0 8px #d29922}
.dtb-err .dtb-dot{background:#e5534b;box-shadow:0 0 8px #e5534b}
.dtb-off .dtb-dot{background:#6e7681}
.dtb-detail{font-size:11.5px;color:#9aa7b8;margin-bottom:10px}
.dtb-stats{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.dtb-stat{background:rgba(255,255,255,.04);border:1px solid rgba(148,163,184,.1);padding:3px 10px;border-radius:999px;font-size:11.5px}
.dtb-actions{display:flex;gap:8px;margin-bottom:10px}
.dtb-btn{padding:4px 12px;border-radius:8px;border:1px solid rgba(148,163,184,.25);background:rgba(255,255,255,.05);color:#e6eaf2;cursor:pointer;font-size:12px;transition:background .15s}
.dtb-btn:hover{background:rgba(255,255,255,.12)}
.dtb-err{color:#e5534b;font-size:11.5px;margin-bottom:8px;white-space:pre-wrap}
.dtb-log{border-top:1px solid rgba(148,163,184,.1);padding-top:8px;max-height:280px;overflow:auto;font-size:11.5px}
.dtb-line{padding:1.5px 0;color:#c7d2e0;white-space:pre-wrap;word-break:break-all}
.dtb-line.dtb-out{color:#8b98a9}
.dtb-empty{color:#6e7681;font-size:11.5px;padding:6px 0}
.dtb-steps{background:rgba(63,185,80,.07);border:1px solid rgba(63,185,80,.25);border-radius:10px;padding:10px 12px;font-size:12px;color:#9fd3a8;white-space:pre-wrap;margin-top:8px}
`
  document.head.appendChild(s)
}

function createPanel() {
  injectStyles()
  const root = document.createElement('div')
  root.className = 'dtb-wrap'
  root.innerHTML =
    '<div class="dtb-hd"><div class="dtb-title">🔗 钉钉桥连</div>' +
    '<span class="dtb-status dtb-off" id="dtb-status"><span class="dtb-dot"></span><span id="dtb-status-txt">读取中…</span></span></div>' +
    '<div class="dtb-detail" id="dtb-detail"></div>' +
    '<div class="dtb-stats" id="dtb-stats"></div>' +
    '<div class="dtb-actions">' +
    '<button class="dtb-btn" data-act="connect">连接</button>' +
    '<button class="dtb-btn" data-act="disconnect">断开</button>' +
    '<button class="dtb-btn" data-act="test">自检 gettoken</button>' +
    '</div>' +
    '<div class="dtb-err" id="dtb-err"></div>' +
    '<div class="dtb-log" id="dtb-log"><div class="dtb-empty">正在读取状态…</div></div>'

  const statusEl = root.querySelector('#dtb-status')
  const statusTxt = root.querySelector('#dtb-status-txt')
  const detailEl = root.querySelector('#dtb-detail')
  const statsEl = root.querySelector('#dtb-stats')
  const errEl = root.querySelector('#dtb-err')
  const logEl = root.querySelector('#dtb-log')

  for (const btn of root.querySelectorAll('.dtb-btn')) {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-act')
      fetch(API + '/' + act, { method: 'POST' })
        .then((r) => r.json())
        .then((j) => {
          if (!j.ok) errEl.textContent = '操作失败：' + (j.error || 'unknown')
          else void load()
        })
        .catch((e) => { errEl.textContent = '操作失败：' + e.message })
    })
  }

  const toneFor = (status) =>
    status === 'connected' ? 'dtb-ok' : status === 'disabled' ? 'dtb-off' : status === 'error' ? 'dtb-err' : 'dtb-warn'

  const load = () => {
    fetch(API + '/status')
      .then((r) => r.json())
      .then((j) => {
        const s = j.state
        if (!s) {
          statusTxt.textContent = '不可用'
          detailEl.textContent = j.error || ''
          return
        }
        statusEl.className = 'dtb-status ' + toneFor(s.status)
        statusTxt.textContent = STATUS_LABEL[s.status] || s.status
        const since = s.connectedAt ? new Date(s.connectedAt).toLocaleTimeString() : '—'
        detailEl.textContent = s.detail + (s.connectedAt ? ' ｜ 自 ' + since : '')
        statsEl.textContent = ''
        const stat = (k, v) => {
          const span = document.createElement('span')
          span.className = 'dtb-stat'
          span.textContent = k + ' ' + v
          statsEl.appendChild(span)
        }
        stat('📥 收', s.msgIn)
        stat('📤 发', s.msgOut)
        stat('🤖 LLM', s.llmCalls)
        errEl.textContent = s.lastError ? '最近错误：' + s.lastError : ''
        logEl.textContent = ''
        if (!s.history || s.history.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'dtb-empty'
          empty.textContent = '暂无消息。在钉钉里 @机器人 或单聊机器人即可对话。'
          logEl.appendChild(empty)
        } else {
          for (const h of s.history.slice(-20)) {
            const line = document.createElement('div')
            const time = new Date(h.at).toLocaleTimeString()
            const who = h.direction === 'in' ? '「' + (h.from || '?') + '」' : 'DSH'
            line.className = 'dtb-line' + (h.direction === 'in' ? '' : ' dtb-out')
            line.textContent = '[' + time + '] ' + who + '：' + h.text
            logEl.appendChild(line)
          }
        }
      })
      .catch((e) => {
        statusTxt.textContent = 'API 不可达'
        errEl.textContent = '面板无法连接 host API：' + e.message
      })
  }
  load()
  const timer = setInterval(load, 3000)
  root.__dtbTimer = timer
  return root
}

/** React FC：挂载 vanilla 面板 */
function DingTalkPanel() {
  const ref = React.useRef(null)
  React.useEffect(() => {
    const host = ref.current
    if (!host) return undefined
    const el = createPanel()
    host.appendChild(el)
    return () => {
      if (el.__dtbTimer) clearInterval(el.__dtbTimer)
      if (el.parentNode) el.parentNode.removeChild(el)
    }
  }, [])
  return React.createElement('div', { ref, style: { height: '100%', overflow: 'auto' } })
}

export function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/dsh-dingtalk-bridge-panel',
      label: () => '钉钉桥连',
      order: 40,
    }, DingTalkPanel)
  ), '@dsh-external/dsh-dingtalk-bridge: panel')
}
