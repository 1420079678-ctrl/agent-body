#!/usr/bin/env node
/**
 * 一次性：把「活体」上捕获的原始素材，整理成 repo 内可复现的基准语料。
 *
 * 基准必须能被陌生人离线复跑，所以**输入必须进仓库**。但输入来自一台真实运行的
 * agent-body，里面带着本机路径、用户名和运行历史——直接提交就是把隐私和不可复现的
 * 状态一起发布出去。
 *
 * 这个脚本做三件事：
 *   ① 工具 schema 语料：全量保留（这是被测对象），附带来源与捕获方式
 *   ② 运行轨迹：脱敏后固化成 fixture（伤口账本 / 反射统计 / 突触 / 技能）
 *   ③ 一律确定性输出（排序、稳定缩进），保证 diff 可读、可审查
 *
 * 用法：
 *   node benchmarks/tools/prepare-corpus.mjs [--raw <dir>] [--state <organism-data-dir>]
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const benchDir = path.join(repoRoot, 'benchmarks')
const rawDir = path.join(benchDir, 'corpus', 'raw')
const outDir = path.join(benchDir, 'corpus')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const stateDir = arg('--state', path.join(process.env.DSH_HOME ?? '', 'plugins', 'dsh-organism'))

/** 脱敏：本机路径、用户名、临时目录——保留结构，抹掉身份 */
export function sanitize(text) {
  let out = String(text)
  out = out.replace(/[A-Za-z]:\\+(?:DeepSeekHarness|agent-body-public|agent-body)[\\/][^\s"']*/gi, '<REPO_PATH>')
  out = out.replace(/[A-Za-z]:\\\\+(?:DeepSeekHarness|agent-body-public)[^\s"']*/gi, '<REPO_PATH>')
  out = out.replace(/\/(?:home|Users)\/[^/\s"']+/g, '/<HOME>')
  out = out.replace(/C:\\+Users\\+[^\\\s"']+/gi, '<HOME>')
  out = out.replace(/X1973/g, '<user>')
  out = out.replace(/AppData\\+Local\\+Temp\\+[^\s"']*/gi, '<TEMP>')
  return out
}

/** 稳定序列化：对象键排序，缩进固定 */
function stable(value, indent = 2) {
  const seen = new WeakSet()
  const norm = (v) => {
    if (v instanceof RegExp) return { $regex: v.source, $flags: v.flags }
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]'
      seen.add(v)
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(norm(value), null, indent) + '\n'
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return { __parseError: String(e.message) }
  }
}

function main() {
  fs.mkdirSync(outDir, { recursive: true })

  const report = { generatedAt: new Date().toISOString(), steps: [] }

  // ── ① 工具 schema 语料 ──
  // 必须用 captured-all-tools.json（256 项，含核心工具）。早期的 captured-tools.json 只有 229 项——
  // 因为 `ctx.tools.schemas()` 默认只返回**根作用域**（插件工具），漏掉了 read/write/edit/pwsh/
  // web_search/subagent/todo_write 这些挂在 **agent 作用域** 上的核心工具。
  // 漏掉它们会让分母偏小、地板算成 0，收益被高估——所以这里显式优先全量文件。
  const candidates = ['captured-all-tools.json', 'captured-tools.json']
  const rawTools = candidates.map((f) => path.join(rawDir, f)).find((p) => fs.existsSync(p))
  if (rawTools) {
    const tools = JSON.parse(fs.readFileSync(rawTools, 'utf8'))
      .map((t) => ({
        name: String(t.name),
        description: stripVolatile(String(t.description ?? '')),
        parameters: t.parameters ?? { type: 'object', properties: {} },
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const corpus = {
      $comment:
        '捕获自一台真实运行的 DeepSeek Harness + Agent-Body 身体的工具定义全集（含核心工具）。' +
        '这是基准的**被测输入**：schema 门控的 token 收益建立在它之上。' +
        '捕获脚本见 benchmarks/tools/CAPTURE.md；脱敏与整理见 benchmarks/tools/prepare-corpus.mjs。',
      provenance: {
        capturedFrom: 'live DeepSeek Harness session (agent-body organs installed)',
        captureMethod:
          'ctx.tools.layers.scoped 的每个作用域键 → ctx.tools.schemas(scope) → 并集取 name/description/parameters' +
          '（既要根作用域的插件工具，也要 agent 作用域的核心工具）',
        sourceFile: path.basename(rawTools),
        capturedAt: new Date().toISOString().slice(0, 10),
        toolCount: tools.length,
        sanitized: true,
      },
      tools,
    }
    fs.writeFileSync(path.join(outDir, 'tools.json'), stable(corpus, 2))
    report.steps.push({ step: 'tools.json', tools: tools.length, from: path.basename(rawTools) })
  } else {
    report.steps.push({ step: 'tools.json', skipped: `raw capture missing in ${path.relative(repoRoot, rawDir)}` })
  }

  // ── ①b 活体装配快照（用于估算器反向校验 + 活体口径对照） ──
  const rawLive = path.join(rawDir, 'live-gate.json')
  if (fs.existsSync(rawLive)) {
    const live = JSON.parse(fs.readFileSync(rawLive, 'utf8'))
    fs.writeFileSync(path.join(outDir, 'trace-live-gate.json'), stable(live, 2))
    report.steps.push({
      step: 'trace-live-gate.json',
      visibleTools: (live.visibleTools ?? []).length,
      note: '活体快照：不可离线复现，仅作对照与估算器校验',
    })
  } else {
    report.steps.push({ step: 'trace-live-gate.json', skipped: 'no raw/live-gate.json' })
  }


  // ── ② 运行轨迹：伤口账本 ──
  const healings = readJsonIfExists(path.join(stateDir, 'healings.json'))
  if (Array.isArray(healings)) {
    const fixture = {
      $comment:
        '真实运行中的自愈账本（一次伤口 = 一次失败 → 归因 → 处置 → 复检）。' +
        '消融实验用它回放：关掉自愈时这些伤口不会闭合。已脱敏：本机路径→<REPO_PATH>，用户名→<user>。',
      provenance: { from: 'dsh-organism/healings.json', sanitized: true },
      healings: healings
        .map((h) => ({
          organ: h.organ,
          tool: h.tool,
          cause: h.cause,
          status: h.status,
          attempts: h.attempts,
          error: sanitize(h.error ?? ''),
        }))
        .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : a.cause < b.cause ? -1 : 1)),
    }
    fs.writeFileSync(path.join(outDir, 'trace-healings.json'), stable(fixture, 2))
    report.steps.push({ step: 'trace-healings.json', wounds: fixture.healings.length })
  } else {
    report.steps.push({ step: 'trace-healings.json', skipped: 'no state dir' })
  }

  // ── ③ 运行轨迹：反射统计 / 突触 / 技能 ──
  const reflexStats = readJsonIfExists(path.join(stateDir, 'reflex-stats.json'))
  if (reflexStats && !reflexStats.__parseError) {
    const entries = Array.isArray(reflexStats)
      ? reflexStats
      : Object.entries(reflexStats).map(([id, v]) => ({ id, ...(v ?? {}) }))
    fs.writeFileSync(
      path.join(outDir, 'trace-reflex-stats.json'),
      stable(
        {
          $comment: '真实运行中的反射弧统计（开火次数 / 帮上忙次数 / 是否已停用）。消融实验用它判定该淘汰与该强化谁。',
          provenance: { from: 'dsh-organism/reflex-stats.json', sanitized: true },
          stats: entries
            .map((s) => ({
              id: String(s.id ?? s.reflexId ?? ''),
              fires: Number(s.fires ?? 0),
              helped: Number(s.helped ?? 0),
              retired: Boolean(s.retired ?? false),
            }))
            .sort((a, b) => (a.id < b.id ? -1 : 1)),
        },
        2,
      ),
    )
    report.steps.push({ step: 'trace-reflex-stats.json', reflexes: entries.length })
  }

  const synapses = readJsonIfExists(path.join(stateDir, 'synapses.json'))
  if (Array.isArray(synapses)) {
    const list = synapses.map((row) => (Array.isArray(row) ? row[1] : row)).filter(Boolean)
    fs.writeFileSync(
      path.join(outDir, 'trace-synapses.json'),
      stable(
        {
          $comment:
            '真实运行中的突触表（命令类别 × 器官 的 Hebbian 权重）。消融实验用它判定衰减与修剪：关掉遗忘时没有任何突触会被剪掉。',
          provenance: { from: 'dsh-organism/synapses.json', sanitized: true },
          synapses: list
            .map((s) => ({
              rule: String(s.rule ?? ''),
              organ: String(s.organ ?? ''),
              paid: Number(s.paid ?? 0),
              failed: Number(s.failed ?? 0),
              weight: Number(s.weight ?? 0),
            }))
            .sort((a, b) => (a.organ < b.organ ? -1 : a.organ > b.organ ? 1 : a.rule < b.rule ? -1 : 1)),
        },
        2,
      ),
    )
    report.steps.push({ step: 'trace-synapses.json', synapses: list.length })
  }

  const skills = readJsonIfExists(path.join(stateDir, 'skills.json'))
  if (Array.isArray(skills)) {
    fs.writeFileSync(
      path.join(outDir, 'trace-skills.json'),
      stable(
        {
          $comment: '真实运行中固化的跨器官链路技能（成功路径）。消融实验用它判定该遗忘谁。',
          provenance: { from: 'dsh-organism/skills.json', sanitized: true },
          skills: skills
            .map((s) => ({
              id: String(s.id ?? ''),
              ok: Number(s.ok ?? 0),
              fail: Number(s.fail ?? 0),
              steps: Array.isArray(s.steps) ? s.steps.map((x) => sanitize(String(x))) : [],
            }))
            .sort((a, b) => (a.id < b.id ? -1 : 1)),
        },
        2,
      ),
    )
    report.steps.push({ step: 'trace-skills.json', skills: skills.length })
  }

  fs.writeFileSync(path.join(outDir, 'PREPARED.json'), stable(report, 2))
  console.log(JSON.stringify(report, null, 2))
}

/** 描述里可能带本机路径或会随时间漂移的内容，清掉以保证语料稳定 */
function stripVolatile(text) {
  return sanitize(text)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
