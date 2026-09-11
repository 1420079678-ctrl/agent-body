/**
 * 器官契约 —— 把生理隐喻翻译成工程接口。
 *
 * 「器官 / 心跳 / 神经冲动 / 反射弧 / 突触 / 伤口」作为叙事没问题，但作为**依赖**太模糊：
 * 别人没法据此判断一个插件能不能装、会不会动他的文件、失败时该被怎么对待。
 * 这个模块给出可校验的答案：分级、权限声明、生命周期、错误分类、稳态可导出。
 */

import { FAILURE_CAUSES } from './kernel.mjs'

/** 器官分级 —— 默认只装 core + general */
export const ORGAN_TIERS = /** @type {const} */ (['core', 'general', 'professional', 'experimental'])

export const TIER_POLICY = {
  core: {
    label: '核心',
    defaultInstall: true,
    description: '身体之所以是身体：器官解剖、意图路由、心跳、自愈、记忆、token 门控。默认安装，接口冻结优先级最高。',
    risk: 'low',
  },
  general: {
    label: '通用',
    defaultInstall: true,
    description: '任何项目都用得上：文件、终端、网页搜索/抓取。默认安装。',
    risk: 'low',
  },
  professional: {
    label: '专业',
    defaultInstall: false,
    description: '面向特定领域的高能力器官（安全测试、逆向、二进制分析、量化…）。能力大、副作用大，需显式授权后才装。',
    risk: 'high',
  },
  experimental: {
    label: '实验',
    defaultInstall: false,
    description: '接口未定、随时会变的器官。装了就要接受破坏性变更。',
    risk: 'medium',
  },
}

/** 权限声明 —— 器官必须**声明**它要碰什么，越界不是「用错了」而是「没声明」 */
export const PERMISSION_KINDS = {
  'fs:read': { label: '读文件', risk: 'low', scope: '工作区与只读路径' },
  'fs:write': { label: '写文件', risk: 'medium', scope: '工作区可写路径' },
  'exec:process': { label: '执行子进程', risk: 'high', scope: '本机进程与命令行' },
  'net:http': { label: '发起网络请求', risk: 'medium', scope: '出站 HTTP(S)' },
  'net:listen': { label: '监听端口', risk: 'high', scope: '入站监听' },
  'secrets:read': { label: '读取凭据', risk: 'high', scope: '凭据存储（只读，不得外发）' },
  'llm:call': { label: '调用模型', risk: 'medium', scope: '按 token 计费的模型调用' },
  'host:inject': { label: '运行时注入插件', risk: 'high', scope: '改变自身结构' },
}

/**
 * 生命周期钩子 —— 器官在什么时候会被叫到。
 * 全部可缺省；缺省即「这个器官不需要在这一步做任何事」，而不是错误。
 */
export const LIFECYCLE_HOOKS = {
  onInstall: '安装后一次：建目录、写默认状态',
  onActivate: '每次上线：注册能力、订阅信号',
  onImpulse: '收到操作者命令的神经冲动（可返回它认领的那一支）',
  onToolResult: '任一工具调用结束后（观测与反射的入口）',
  onFailure: '自己管辖的能力失败后（拿到的已带确定性归因）',
  onHeartbeat: '心跳泵血时（拿到当前血液包）',
  onDeactivate: '下线前：退订、flush 状态',
  onUninstall: '卸载前：把要留的东西导出（不得静默丢数据）',
}

/** 稳态必须可导出/可重置/可解释/可回滚的四条硬要求 */
export const HOMEOSTASIS_EXPORT_REQUIREMENTS = [
  '可导出：突触权重、反射弧统计、伤口账本、技能、信任度都能序列化成 JSON',
  '可重置：能回到健康基线而不丢已学到的经验（清损伤、留记忆）',
  '可解释：每个权重与每道伤口都要能说出「为什么是它」（ruleIndex / cause / evidence）',
  '可回滚：任何自动处置都在账本里留有 before/after，可反向执行',
]

/** 器官清单的 JSON Schema（draft 2020-12） */
export const ORGAN_MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agent-body.dev/schemas/organ-manifest-0.1.json',
  title: 'Agent-Body Organ Manifest',
  type: 'object',
  required: ['id', 'label', 'tier', 'group', 'purpose', 'capabilities', 'permissions', 'sdkVersion'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: '器官 id（小写 + 下划线）' },
    label: { type: 'string', minLength: 1, description: '人类可读名' },
    tier: { enum: [...ORGAN_TIERS], description: '分级：决定默认装不装' },
    group: {
      enum: ['executive', 'nervous', 'immune', 'sensory', 'motor', 'memory', 'metabolic', 'endocrine', 'autonomic'],
      description: '所属系统',
    },
    purpose: { type: 'string', minLength: 1, description: '一句话职能' },
    capabilities: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', description: '工具名或 prefix* 通配' },
      description: '它管辖哪些工具',
    },
    permissions: {
      type: 'array',
      items: { enum: Object.keys(PERMISSION_KINDS) },
      description: '它需要哪些权限（空数组 = 纯计算，不碰外界）',
      uniqueItems: true,
    },
    sdkVersion: { type: 'string', description: '所依据的 organ-sdk 契约版本（semver range）' },
    signals: {
      type: 'array',
      items: { type: 'string' },
      description: '它感知哪些信号（事件名）',
    },
    handles: {
      type: 'array',
      items: { enum: FAILURE_CAUSES },
      description: '它承诺自行处置哪些失败病因（未列出的由内核处方表兜底）',
    },
    fallback: {
      type: 'array',
      items: { type: 'string' },
      description: '离线时优先由谁代偿（器官 id）',
    },
    source: { type: 'string', description: '来源包名' },
    homepage: { type: 'string' },
    license: { type: 'string' },
  },
}

/**
 * 校验器官清单。
 * @returns {{ok:boolean, errors:Array<{path:string,message:string}>}}
 */
export function validateOrganManifest(manifest) {
  const errors = []
  const push = (path, message) => errors.push({ path, message })

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: [{ path: '', message: 'manifest 必须是对象' }] }
  }

  const schema = ORGAN_MANIFEST_SCHEMA
  for (const key of schema.required) {
    if (manifest[key] === undefined) push(key, '必填字段缺失')
  }
  for (const key of Object.keys(manifest)) {
    if (!(key in schema.properties)) push(key, '未知字段（契约不允许额外字段）')
  }

  if (manifest.id !== undefined && !/^[a-z][a-z0-9_]*$/.test(String(manifest.id))) {
    push('id', '必须是 小写字母开头 + 小写字母/数字/下划线')
  }
  if (manifest.tier !== undefined && !ORGAN_TIERS.includes(manifest.tier)) {
    push('tier', `必须是 ${ORGAN_TIERS.join(' / ')} 之一，实际 ${JSON.stringify(manifest.tier)}`)
  }
  if (manifest.group !== undefined && !schema.properties.group.enum.includes(manifest.group)) {
    push('group', `未知系统分组 ${JSON.stringify(manifest.group)}`)
  }
  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
      push('capabilities', '必须是非空数组（一个不管辖任何工具的器官没有存在的意义）')
    } else {
      manifest.capabilities.forEach((c, i) => {
        if (typeof c !== 'string' || c.length === 0) push(`capabilities[${i}]`, '必须是非空字符串')
      })
    }
  }
  if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) {
    push('permissions', '必须是数组（没有权限就写空数组，不要省略）')
  } else if (Array.isArray(manifest.permissions)) {
    manifest.permissions.forEach((p, i) => {
      if (!(p in PERMISSION_KINDS)) push(`permissions[${i}]`, `未声明的权限 ${JSON.stringify(p)}`)
    })
  }
  if (manifest.handles !== undefined) {
    if (!Array.isArray(manifest.handles)) push('handles', '必须是数组')
    else manifest.handles.forEach((h, i) => {
      if (!FAILURE_CAUSES.includes(h)) push(`handles[${i}]`, `未知病因 ${JSON.stringify(h)}`)
    })
  }
  if (manifest.sdkVersion !== undefined && !/^[\^~]?\d+\.\d+\.\d+/.test(String(manifest.sdkVersion))) {
    push('sdkVersion', `看起来不是 semver：${JSON.stringify(manifest.sdkVersion)}`)
  }

  // 高风险器官必须显式声明高风险权限，且必须出现在专业/实验分级里
  if (Array.isArray(manifest.permissions)) {
    const highRisk = manifest.permissions.filter(
      (p) => PERMISSION_KINDS[p] && PERMISSION_KINDS[p].risk === 'high',
    )
    if (highRisk.length > 0 && manifest.tier === 'core') {
      push('tier', `申请了高风险权限（${highRisk.join(', ')}）的器官不得标为 core`)
    }
    if (highRisk.length > 0 && !Array.isArray(manifest.handles)) {
      push('handles', '有高风险权限的器官必须声明它能自行处置哪些失败病因')
    }
  }

  return { ok: errors.length === 0, errors }
}

/** 按分级决定默认安装集 */
export function defaultInstallSet(manifests) {
  return manifests
    .filter((m) => {
      const policy = TIER_POLICY[m.tier]
      return policy && policy.defaultInstall
    })
    .map((m) => m.id)
}
