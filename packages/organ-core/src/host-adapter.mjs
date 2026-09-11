/**
 * HostAdapter —— 降低宿主绑定风险。
 *
 * 现状是这套器官层完全长在 DeepSeek Harness 上。Harness 仍在开发者预览期，
 * API 会变；绑死一个预览版宿主是这套系统最大的单点风险。
 *
 * 解法：器官只依赖 `HostAdapter` 这个接口，不直接依赖任何宿主 SDK。
 * Harness 只是**第一个**适配器。写第二个适配器（哪怕只是个测试用的内存宿主）
 * 就能证明「器官层不是 Harness 的附属品」——本文件自带一个内存适配器，
 * 契约测试套件就跑在它上面，不需要装任何东西。
 *
 * 兼容矩阵与迁移路径见 `docs/host-adapter.md`。
 */

import { attributeFailure } from './kernel.mjs'

/** HostAdapter 必须实现的方法（缺一个就不算适配器） */
export const HOST_ADAPTER_METHODS = /** @type {const} */ ([
  ['listTools', '列出宿主当前可见的工具名'],
  ['getToolSchema', '取单个工具的 schema'],
  ['executeTool', '执行一个工具（器官唯一的 effector 通道）'],
  ['emit', '向宿主广播事件'],
  ['on', '订阅宿主事件，返回退订函数'],
  ['readState', '读取持久化状态（器官自己的命名空间）'],
  ['writeState', '写入持久化状态'],
  ['log', '结构化日志'],
  ['now', '取当前时间（可注入时钟，便于确定性测试）'],
])

/** 可选的宿主能力：有则用，没有则降级 */
export const HOST_ADAPTER_OPTIONAL_METHODS = /** @type {const} */ ([
  ['registerSystemPromptSection', '向系统提示注入一段内容（没有则器官不自带提示词）'],
  ['watchTools', '订阅工具集变化'],
  ['spawnTimer', '宿主托管的定时器（没有则由器官自带 setInterval）'],
])

/**
 * 校验一个对象够不够格当宿主适配器。
 * @returns {{ok:boolean, missing:string[], optionalMissing:string[]}}
 */
export function validateHostAdapter(adapter) {
  const missing = []
  const optionalMissing = []
  if (adapter === null || typeof adapter !== 'object') {
    return {
      ok: false,
      missing: HOST_ADAPTER_METHODS.map(([m]) => m),
      optionalMissing: HOST_ADAPTER_OPTIONAL_METHODS.map(([m]) => m),
    }
  }
  for (const [m] of HOST_ADAPTER_METHODS) if (typeof adapter[m] !== 'function') missing.push(m)
  for (const [m] of HOST_ADAPTER_OPTIONAL_METHODS) if (typeof adapter[m] !== 'function') optionalMissing.push(m)
  return { ok: missing.length === 0, missing, optionalMissing }
}

/**
 * 内存宿主适配器 —— 参考实现 + 契约测试的靶子。
 * 完全确定性：时钟由计数器驱动，事件同步派发，状态放内存。
 * 它证明器官契约可以在**没有 DeepSeek Harness 的机器上**被完整验证。
 */
export function createMemoryHost(options = {}) {
  const state = new Map()
  const listeners = new Map()
  const tools = new Map(Object.entries(options.tools ?? {}))
  const events = []
  let tick = 0
  const start = options.startTime ?? 0

  const adapter = {
    name: 'memory-host',
    kind: 'reference',

    listTools() {
      return [...tools.keys()]
    },
    getToolSchema(name) {
      return tools.get(name) ?? null
    },
    /**
     * 执行一个工具。
     *
     * **绝不向器官抛异常**：器官不该在自己身上写 try/catch，失败是正常的一等公民。
     * 抛出的一律收成 `{ok:false, error:{message, cause}}`，cause 走确定性归因——
     * 于是反射弧和自愈账本能拿到同一套病因，而不是各自解析错误字符串。
     */
    async executeTool(name, args) {
      const t = tools.get(name)
      if (t === undefined) {
        return { ok: false, error: { message: `tool not found: ${name}`, cause: 'not_found' } }
      }
      try {
        if (typeof t === 'function') return { ok: true, result: await t(args) }
        return { ok: true, result: t.result ?? null }
      } catch (e) {
        const message = e && e.message ? String(e.message) : String(e)
        return { ok: false, error: { message, cause: attributeFailure(message) } }
      }
    },
    emit(event, payload) {
      events.push({ event, payload, at: adapter.now() })
      for (const fn of listeners.get(event) ?? []) fn(payload)
    },
    on(event, fn) {
      const arr = listeners.get(event) ?? []
      arr.push(fn)
      listeners.set(event, arr)
      return () => {
        const cur = listeners.get(event) ?? []
        listeners.set(event, cur.filter((f) => f !== fn))
      }
    },
    readState(key) {
      return state.has(key) ? structuredClone(state.get(key)) : null
    },
    writeState(key, value) {
      state.set(key, structuredClone(value))
    },
    log(level, message, fields) {
      events.push({ event: 'log', payload: { level, message, fields }, at: adapter.now() })
    },
    now() {
      return start + tick * 1000
    },

    // 可选能力
    registerSystemPromptSection(_id, _text) {
      return () => {}
    },
    watchTools(fn) {
      const off = adapter.on('tools/change', fn)
      return off
    },
    spawnTimer(ms, fn) {
      const id = setInterval(() => {
        tick += 1
        fn()
      }, Math.max(1, ms))
      id.unref?.()
      return () => clearInterval(id)
    },

    // 测试辅助（不属于契约）
    __advance(ms) {
      tick += Math.max(1, Math.floor(ms / 1000))
    },
    __events() {
      return events
    },
    __state() {
      return state
    },
    __setTool(name, impl) {
      tools.set(name, impl)
    },
  }

  return adapter
}

/**
 * 器官定义助手：把「一个器官」写成宿主无关的声明式对象。
 * `hooks` 里出现的键必须是 LIFECYCLE_HOOKS 里的名字。
 */
export function defineOrgan(manifest, hooks = {}) {
  return {
    manifest,
    hooks,
    /** 该器官认领这条神经冲动吗（确定性，无副作用） */
    claimsCommand(impulse) {
      if (typeof hooks.claims === 'function') return Boolean(hooks.claims(impulse))
      const caps = manifest.capabilities ?? []
      const text = String(impulse?.text ?? '').toLowerCase()
      return caps.some((c) => text.includes(String(c).replace(/\*$/, '').toLowerCase()))
    },
  }
}
