/**
 * @agent-body/organ-core —— 零依赖的器官层确定性内核。
 *
 * 这个包不含任何 IO、不调模型、不联网、不依赖宿主运行时。
 * 基准测试、契约测试、CLI 诊断都建立在它之上——所以「陌生人一条命令跑出可验证结果」是成立的。
 */

export * from './kernel.mjs'
export * from './gating.mjs'
export * from './manifest.mjs'
export * from './host-adapter.mjs'

/** 契约版本：器官 SDK 的语义化版本。破坏性变更会在这里体现。 */
export const SDK_VERSION = '0.1.0'
