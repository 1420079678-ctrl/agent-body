/**
 * @dsh-external/dsh-mirofish — MiroFish「预言家」接入层（toolkit 形态）
 *
 * 定位：MiroFish（github.com/666ghj/MiroFish，群体智能预测引擎）的轻量 DSH 插件。
 * 本插件只是 HTTP 客户端（零常驻 worker / 零定时器，运行时 <1MB），
 * 重型仿真引擎本体是独立服务（后端 :5001 / 前端 :3000），按需启动、不用不占内存。
 *
 * 预测全流程（引擎侧）：建项目(种子材料)→构建图谱→创建模拟→准备→启动仿真→报告→访谈
 * 对应 action：create_project → build_graph → (task 轮询) → create_sim → prepare →
 *             (prepare_status 轮询) → start → (run_status 轮询) → report → interview
 *
 * 高性能铁律：schema 精简（短句），详解放 tool result。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export const name = "@dsh-external/dsh-mirofish"
export const inject = ['tools']

export interface Config {
  backendBase: string
  frontendBase: string
  timeoutMs: number
}

export const Config = z.object({
  backendBase: z.string().default('http://127.0.0.1:5001'),
  frontendBase: z.string().default('http://127.0.0.1:3000'),
  timeoutMs: z.number().default(10000),
})

/** 统一 HTTP 调用（node fetch，走 OpenSSL 不受 Windows schannel 影响） */
function jsonTrim(v: unknown, max = 4000): string {
  let s: string
  try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch { s = String(v) }
  return s.length > max ? s.slice(0, max) + `…[截断,共${s.length}字符]` : s
}

export function apply(ctx: Context, config: Config): void {
  async function callApi(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) {
    const res = await fetch(config.backendBase.replace(/\/$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? config.timeoutMs),
    })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text.slice(0, 1500) }
    return { httpStatus: res.status, ok: res.ok, data }
  }

  /** multipart 上传（ontology/generate 要求 form-data + files） */
  async function callForm(path: string, form: FormData, timeoutMs?: number) {
    const res = await fetch(config.backendBase.replace(/\/$/, '') + path, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs ?? 120000),
    })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text.slice(0, 1500) }
    return { httpStatus: res.status, ok: res.ok, data }
  }

  // ── 工具 1：状态检查 ────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_mirofish_status',
    description: "MiroFish 预言家引擎状态检查：服务是否在线、项目与模拟列表；离线时返回启动指引",
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute() {
      const base = config.backendBase.replace(/\/$/, '')
      try {
        const t0 = Date.now()
        const [projects, sims] = await Promise.all([
          callApi('GET', '/api/graph/project/list', undefined, 4000),
          callApi('GET', '/api/simulation/list', undefined, 4000),
        ])
        const lines = [
          `MiroFish 服务在线 ✓ (${Date.now() - t0}ms)`,
          `前端沙盘: ${config.frontendBase}`,
          `项目列表: ${jsonTrim(projects.data, 1200)}`,
          `模拟列表: ${jsonTrim(sims.data, 1200)}`,
        ]
        return lines.join('\n')
      } catch (e: unknown) {
        return [
          'MiroFish 服务离线 ✗（' + base + ' 不可达: ' + (e instanceof Error ? e.message : String(e)) + '）',
          '启动方式（二选一，独立进程不影响 DSH 内存）：',
          '  Docker: cd <MiroFish目录> && docker compose up -d',
          '  源码:   cd <MiroFish目录> && npm run dev',
          '  一键脚本: workspace\\scripts\\start-mirofish.ps1',
          '未部署？运行 workspace\\scripts\\deploy-mirofish.ps1（需要 ZEP_API_KEY 与 LLM_API_KEY）',
        ].join('\n')
      }
    },
  })), '@dsh-external/dsh-mirofish: status tool')

  // ── 工具 2：预测流程统一客户端 ──────────────────────────────────────
  type ApiArgs = {
    action: 'create_project' | 'build_graph' | 'graph_task' | 'create_sim' | 'prepare'
      | 'prepare_status' | 'start' | 'run_status' | 'report' | 'interview' | 'raw'
    projectId?: string
    simulationId?: string
    taskId?: string
    prompt?: string
    maxRounds?: number
    seedFile?: string
    payload?: Record<string, unknown>
    path?: string
    method?: 'GET' | 'POST'
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_mirofish_api',
    description:
      "MiroFish 预言家预测流程：群体智能推演任何问题（舆情/金融/剧情走向）。" +
      "链路 create_project→build_graph→graph_task轮询→create_sim→prepare→prepare_status轮询→start→run_status轮询→report→interview。" +
      "先调 mirofish_status 确认服务在线。",
    parameters: {
      action: { type: 'string', required: true, description: '流程步骤，见工具描述' },
      projectId: { type: 'string', description: '项目 id (proj_xxx)' },
      simulationId: { type: 'string', description: '模拟 id (sim_xxx)' },
      taskId: { type: 'string', description: '图谱构建任务 id (task_xxx)' },
      prompt: { type: 'string', description: 'interview 时对模拟世界提出的问题' },
      maxRounds: { type: 'number', description: 'start 时仿真轮数上限（消耗大，建议≤40）' },
      seedFile: { type: 'string', description: 'create_project 时种子材料文件路径（md/txt/pdf）；无则用 payload.seed_text' },
      payload: { type: 'json', description: '附加请求体字段（如种子材料 seed_text、title 等）' },
      path: { type: 'string', description: 'action=raw 时自定义 API 路径（如 /api/graph/ontology/generate）' },
      method: { type: 'string', description: 'action=raw 时 HTTP 方法，默认 POST' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(rawArgs) {
      const args = rawArgs as unknown as ApiArgs
      // 框架可能把 json 类型参数以字符串传入——归一化
      let payloadRaw = (args.payload ?? {}) as Record<string, unknown> | string
      if (typeof payloadRaw === 'string') {
        try { payloadRaw = JSON.parse(payloadRaw) as Record<string, unknown> } catch { payloadRaw = {} }
      }
      const p: Record<string, unknown> = { ...payloadRaw }
      if (args.maxRounds !== undefined) p.max_rounds = args.maxRounds
      if (args.prompt !== undefined) p.prompt = args.prompt
      try {
        let r: Awaited<ReturnType<typeof callApi> | Awaited<ReturnType<typeof callForm>>>
        switch (args.action) {
          case 'create_project': {
            // ontology/generate 是 multipart/form-data + files（必填）+ simulation_requirement（必填）
            const fd = new FormData()
            const seedText = String(p.seed_text ?? p.seedText ?? '')
            if (args.seedFile) {
              const buf = readFileSync(args.seedFile)
              fd.append('files', new Blob([buf]), basename(args.seedFile))
            } else if (seedText) {
              fd.append('files', new Blob([seedText], { type: 'text/plain' }), 'seed.txt')
            } else {
              return 'create_project 需要种子材料：传 seedFile=<文件路径> 或 payload.seed_text=<文本>'
            }
            const req = String(p.simulation_requirement ?? args.prompt ?? '')
            if (!req) return "create_project 需要 simulation_requirement（预测需求描述）：放 payload.simulation_requirement 或 prompt"
            fd.append('simulation_requirement', req)
            if (p.project_name) fd.append('project_name', String(p.project_name))
            if (p.additional_context) fd.append('additional_context', String(p.additional_context))
            r = await callForm('/api/graph/ontology/generate', fd)
            break
          }
          case 'build_graph':
            if (!args.projectId && !p.project_id) return '缺少 projectId'
            p.project_id ??= args.projectId
            r = await callApi('POST', '/api/graph/build', p); break
          case 'graph_task':
            if (!args.taskId) return '缺少 taskId'
            r = await callApi('GET', '/api/graph/task/' + encodeURIComponent(args.taskId)); break
          case 'create_sim':
            if (!args.projectId && !p.project_id) return '缺少 projectId'
            p.project_id ??= args.projectId
            r = await callApi('POST', '/api/simulation/create', p); break
          case 'prepare':
          case 'prepare_status':
          case 'start': {
            const sid = args.simulationId || (p.simulation_id as string)
            if (!sid) return '缺少 simulationId'
            p.simulation_id = sid
            if (args.action === 'prepare') r = await callApi('POST', '/api/simulation/prepare', p)
            else if (args.action === 'prepare_status') r = await callApi('POST', '/api/simulation/prepare/status', { simulation_id: sid })
            else r = await callApi('POST', '/api/simulation/start', p)
            break
          }
          case 'run_status':
            if (!args.simulationId) return '缺少 simulationId'
            r = await callApi('GET', '/api/simulation/' + encodeURIComponent(args.simulationId) + '/run-status'); break
          case 'report':
            if (!args.simulationId) return '缺少 simulationId'
            r = await callApi('GET', '/api/report/check/' + encodeURIComponent(args.simulationId)); break
          case 'interview': {
            const sid = args.simulationId || (p.simulation_id as string)
            if (!sid) return '缺少 simulationId'
            p.simulation_id = sid
            r = await callApi('POST', '/api/simulation/interview', p, 120000)
            break
          }
          case 'raw':
            if (!args.path) return 'action=raw 需要 path'
            r = await callApi(args.method === 'GET' ? 'GET' : 'POST', args.path, args.method === 'GET' ? undefined : p); break
          default:
            return '未知 action: ' + args.action
        }
        return `HTTP ${r.httpStatus}\n${jsonTrim(r.data)}`
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return `调用失败: ${msg}\n（服务离线？先跑 _dsh_external_dsh_mirofish_status 看指引）`
      }
    },
  })), '@dsh-external/dsh-mirofish: api tool')

  void ctx
}
