/**
 * @agent-body/organ-sdk —— 写一个器官所需的全部东西。
 *
 * 设计原则：**契约与运行时分离**。
 *   - 这份包是零依赖纯函数：写器官、校验器官、单测器官都不需要装 DeepSeek Harness。
 *   - 真要跑起来，由宿主适配器（organ-core 的 createMemoryHost 或真实 host adapter）接上 runtime。
 *
 * 于是「写一个器官」的门槛从「装一整套宿主并读懂它」降到「会写一个对象」，
 * 而「这个器官合不合规」由 `defineOrgan` 当场告诉你，不用等跑起来才发现。
 *
 * 导入方式用相对路径而非包名：**仓库里不装任何依赖也能跑**（`npm run demo` 零安装）。
 */

import {
  ORGAN_TIERS,
  PERMISSION_KINDS,
  validateOrganManifest,
  defineOrgan as coreDefineOrgan,
  fillTemplate,
} from '../../organ-core/src/index.mjs'

export const ORGAN_SDK_VERSION = '0.1.0'

/** 器官契约版本区间——宿主据此判断兼容性 */
export const CONTRACT_VERSION = '^0.1.0'

/** 权限的风险等级：安装器据此决定要不要向用户确认 */
export const PERMISSION_RISK = Object.freeze({
  'fs:read': 'low',
  'fs:write': 'medium',
  'net:http': 'medium',
  'net:listen': 'high',
  'exec:process': 'high',
  'host:inject': 'high',
  'llm:call': 'medium',
  'secrets:read': 'high',
})

/**
 * 声明一个器官。
 *
 * ```js
 * export default defineOrgan({
 *   id: 'paper_reader',
 *   label: '论文阅读（文献）',
 *   tier: 'professional',
 *   group: 'memory',
 *   purpose: '把一篇论文拆成可检索的卡片',
 *   capabilities: ['paper_fetch', 'paper_digest'],
 *   permissions: ['net:http'],
 *   signals: ['tools/result'],
 *   handles: ['network', 'timeout'],
 *   fallback: ['hippocampus'],
 *   hooks: { onResult(ctx, e) { ... } },
 * })
 * ```
 *
 * 校验不通过会**当场抛错**——写错名字的器官在运行时表现为「什么都没发生」，
 * 那是最难查的一类问题，必须在声明的这一刻就挡住。
 */
export function defineOrgan(spec) {
  const manifest = normalize(spec)
  const res = validateOrganManifest(manifest)
  if (!res.ok) {
    const lines = res.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')
    throw new OrganContractError(
      `器官「${manifest.id ?? '(缺 id)'}」不符合契约：\n${lines}`,
      res.errors,
    )
  }
  for (const w of res.warnings ?? []) console.warn(`[organ-sdk] ${manifest.id}: ${w.message}`)

  const hooks = spec.hooks ?? {}
  const core = coreDefineOrgan(manifest, hooks)

  return Object.freeze({
    ...core,
    manifest: Object.freeze(manifest),
    /** 高风险权限需显式确认——安装器用它决定要不要弹确认 */
    requiresConfirmation: manifest.permissions.some((p) => highestRisk([p]) === 'high'),
    riskLevel: highestRisk(manifest.permissions),
    /** 便于测试与 CLI：不接宿主也能拿到一份确定的描述 */
    describe: () => describeOrgan(manifest),
  })
}

/** 补全缺省值，让最简声明也能通过契约 */
function normalize(spec) {
  return {
    sdkVersion: CONTRACT_VERSION,
    tier: 'experimental',
    capabilities: [],
    permissions: [],
    signals: [],
    handles: [],
    fallback: [],
    ...spec,
  }
}

function highestRisk(permissions) {
  const order = { low: 0, medium: 1, high: 2 }
  let max = 'low'
  for (const p of permissions ?? []) {
    const r = PERMISSION_RISK[p] ?? 'medium'
    if (order[r] > order[max]) max = r
  }
  return max
}

/** 人类可读的一句话画像——CLI 与文档共用，避免各处自己拼 */
export function describeOrgan(manifest) {
  const perms = manifest.permissions.length ? manifest.permissions.join(', ') : '不碰外部资源'
  return `${manifest.label}（${manifest.id}）· ${manifest.tier} · ${manifest.capabilities.length} 项能力 · ${perms}`
}

/**
 * 注入消息时用的 `source` —— **跨会话格式代际的唯一正确写法**。
 *
 * 为什么不能自己拼 `{ kind: 'plugin', plugin: name }`：
 *   - v3 的 `SOURCE_KINDS` 白名单挂在 `assertEvent(event, 2)` 上（只约束 v2→v3 **迁移**），
 *     `version === 3` 时它直接返回，**原生 v3 写入并不校验普通消息的 kind** ——
 *     所以旧写法在两代之间「看起来都能跑」，直到 v4 宿主拒收；
 *   - v4 的 admission 明确拒绝 `kind === 'plugin'`，要求 producer-owned 的 kind，
 *     第三方生产者就是 `plugin:<自己的名字>`（见 `producerKind()`）。
 *
 * `{ kind: 'plugin:<name>' }` 同时满足两代：v3 原生写入接受它，v4 正是要求它。
 * 实测口径：宿主自己的 `encodeCurrentEvent` 对 `user/message` 与 `agent/inbox/spliced`
 * 均放行该形式，对 `system/message` 拒绝 —— 两代没有共同写法的只有 `system/message`，
 * 所以不要写那个槽位（本仓库没有器官写它）。
 *
 * @param {string} name 生产者身份（你自己的包名或插件名）；**不要借用第一方名字**
 * @returns {{ kind: string }} 可直接放进 createUserMessage / followup / send 的 source
 */
export function injectedSource(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new OrganContractError('injectedSource 需要一个非空的生产者名字', [])
  }
  return Object.freeze({ kind: `plugin:${name.trim()}` })
}

/** 契约违规——单列一个类型，便于调用方区分「我传错了」与「内部炸了」 */
export class OrganContractError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'OrganContractError'
    this.errors = errors
  }
}

/**
 * 声明一条反射弧：**不过大脑的强逻辑**。
 * 命中即毫秒级执行、零模型调用——所以条件必须是确定性的（无 eval）。
 *
 * 条件语法：`always` / `error` / `ok` / `slow:<ms>` / `hit:<子串>` / `miss:<子串>`，
 * 用 `&&`、`||` 组合。动作参数支持 `${tool}` `${error}` `${text}` `${organ}` 占位符。
 */
export function defineReflex({
  id,
  name,
  triggerTool,
  triggerOn = 'any',
  condition = 'always',
  actionTool,
  actionArgs = {},
  cooldownMs = 5000,
  maxFires,
}) {
  if (!id || !triggerTool || !actionTool) {
    throw new OrganContractError('反射弧需要 id / triggerTool / actionTool', [])
  }
  if (!['any', 'error', 'ok'].includes(triggerOn)) {
    throw new OrganContractError(`triggerOn 只能是 any/error/ok，收到 ${triggerOn}`, [])
  }
  return Object.freeze({
    id,
    name: name ?? id,
    triggerTool,
    triggerOn,
    condition,
    actionTool,
    actionArgs,
    cooldownMs,
    maxFires,
    /** 动作参数里的占位符替换 */
    render: (vars) =>
      Object.fromEntries(
        Object.entries(actionArgs).map(([k, v]) => [k, typeof v === 'string' ? fillTemplate(v, vars) : v]),
      ),
  })
}

export { ORGAN_TIERS, PERMISSION_KINDS, validateOrganManifest, fillTemplate }
