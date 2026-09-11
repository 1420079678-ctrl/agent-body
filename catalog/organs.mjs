/**
 * 器官目录 —— 分级与权限的**单一事实源**。
 *
 * 目录回答三个问题，缺一个别人就不敢用：
 *   ① 默认装哪些？（分级）—— 25 个器官全装会让新人的第一屏就是 256 个工具
 *   ② 它要碰什么？（权限声明）—— 「会不会动我的文件/网络」必须能查，不能靠读源码
 *   ③ 它自己兜哪些失败？（handles）—— 兜不住的由内核处方表接
 *
 * 标签/系统分组/能力清单不在这里手写——从内核源码抽取（`extract-tables.mjs`），
 * 避免两处定义漂移。这里只增加内核里没有的**策略信息**。
 *
 * 生成：node catalog/build.mjs
 */

import { CURATED } from '../packages/organ-core/src/index.mjs'

/** 每个器官的策略信息：分级 + 权限 + 处置的病因 + 代偿顺序 */
export const ORGAN_POLICY = {
  prefrontal: {
    tier: 'core',
    permissions: [],
    fallback: ['delegation'],
    note: '执行控制的中枢，零外部副作用。',
  },
  proprioception_center: { tier: 'core', permissions: [], fallback: [] },
  cortex: { tier: 'core', permissions: ['fs:read', 'fs:write'], fallback: [] },
  cortex_files: { tier: 'core', permissions: ['fs:read', 'fs:write'], fallback: ['hippocampus'] },
  hippocampus: { tier: 'core', permissions: ['fs:read', 'fs:write'], fallback: ['cortex_files'] },
  growth: { tier: 'core', permissions: [], fallback: [] },

  hands: {
    tier: 'general',
    permissions: ['fs:read', 'fs:write', 'exec:process'],
    handles: ['permission', 'not_found'],
    fallback: ['innate_immunity'],
  },
  ears: { tier: 'general', permissions: ['net:http'], handles: ['network', 'timeout'], fallback: ['eyes'] },
  eyes: { tier: 'general', permissions: ['net:http', 'fs:write'], handles: ['network', 'timeout'], fallback: ['ears'] },
  delegation: { tier: 'general', permissions: ['llm:call'], fallback: ['prefrontal'] },
  jobs: { tier: 'general', permissions: ['exec:process'], handles: ['timeout'], fallback: ['hands'] },

  craft: { tier: 'professional', permissions: ['fs:read', 'fs:write', 'exec:process'], handles: ['not_found'], fallback: ['hands'] },
  expressive: { tier: 'professional', permissions: ['fs:write', 'exec:process'], handles: ['not_found'], fallback: ['craft'] },
  synapse: { tier: 'general', permissions: ['fs:read', 'fs:write'], fallback: [] },
  corpus_callosum: { tier: 'general', permissions: [], fallback: [] },
  plasticity: { tier: 'professional', permissions: ['host:inject', 'exec:process'], handles: ['tool_missing', 'conflict'], fallback: ['neurogenesis'] },
  neurogenesis: { tier: 'experimental', permissions: ['host:inject'], handles: ['conflict'], fallback: ['plasticity'] },
  oracle: { tier: 'experimental', permissions: ['net:http', 'llm:call'], handles: ['network', 'timeout'], fallback: ['prefrontal'] },
  metabolism: { tier: 'professional', permissions: ['net:http'], handles: ['network', 'timeout'], fallback: [] },
  dynamic_vision: { tier: 'professional', permissions: ['net:http', 'exec:process'], handles: ['timeout', 'network'], fallback: ['eyes'] },

  innate_immunity: {
    tier: 'professional',
    permissions: ['net:http', 'net:listen', 'exec:process'],
    handles: ['network', 'timeout', 'not_found', 'permission'],
    fallback: ['adaptive_immunity', 'dissection'],
    note: '49 项能力、单器官最贵——专业能力默认不装，装了也要按需显影。',
  },
  adaptive_immunity: { tier: 'professional', permissions: ['net:http', 'fs:read'], handles: ['not_found'], fallback: ['innate_immunity'] },
  dissection: { tier: 'professional', permissions: ['fs:read', 'exec:process'], handles: ['tool_missing', 'not_found'], fallback: ['innate_immunity'] },
  interoception: { tier: 'general', permissions: ['fs:read'], fallback: [] },
}

/** 缺省策略：没写进 ORGAN_POLICY 的器官按最保守处理 */
const DEFAULT_POLICY = { tier: 'experimental', permissions: [], fallback: [] }

/** 组装器官清单（可直接喂给 validateOrganManifest） */
export function buildOrganManifests() {
  return CURATED.map((o) => {
    const policy = ORGAN_POLICY[o.id] ?? DEFAULT_POLICY
    return {
      id: o.id,
      label: o.label,
      tier: policy.tier,
      group: o.group,
      purpose: o.purpose ?? policy.note ?? `${o.label}——管辖 ${o.capabilities.length} 项能力`,
      capabilities: o.capabilities,
      permissions: policy.permissions ?? [],
      sdkVersion: '^0.1.0',
      signals: signalsFor(o.id),
      handles: policy.handles ?? [],
      fallback: policy.fallback ?? [],
    }
  })
}

/** 器官感知哪些宿主信号（决定它在哪个事件上被叫到） */
function signalsFor(id) {
  switch (id) {
    case 'proprioception_center':
      return ['tools/result', 'organism/heartbeat']
    case 'cortex':
      return ['agent/pre-step', 'organism/heartbeat']
    case 'cortex_files':
    case 'hippocampus':
      return ['tools/result']
    case 'prefrontal':
      return ['agent/pre-step', 'goal/changed']
    case 'innate_immunity':
    case 'adaptive_immunity':
      return ['tools/result', 'organism/impulse']
    case 'plasticity':
    case 'neurogenesis':
      return ['tools/change']
    default:
      return ['tools/result']
  }
}
