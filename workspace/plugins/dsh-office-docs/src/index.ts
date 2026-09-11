/**
 * @dsh-external/dsh-office-docs — Office 文档处理工具箱（源自 OpenAI Codex Sol 5.6 skills）。
 * PDF（reportlab/pdfplumber/pypdf + pypdfium2 渲染验证）/ DOCX（python-docx）/
 * PPTX（python-pptx）/ XLSX（openpyxl）/ 通用转换（pandoc）。
 * 执行：node 工具壳 → spawn python scripts/office_docs.py（stdin 传 JSON，windowsHide 无弹窗）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '@dsh-external/dsh-office-docs'
export const inject = ['tools']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(__dirname, '..', 'scripts', 'office_docs.py')

/** 跑 python 引擎：JSON 入参走 stdin（绕开 Windows argv 编码），stdout UTF-8 解析 */
function runPy(action: string, args: Record<string, unknown>, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [SCRIPT, action], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`office_docs ${action} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`python 启动失败: ${e.message}（python 是否在 PATH？）`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`office_docs ${action} 失败 [exit ${code}]: ${stderr.slice(-800)}`))
        return
      }
      try {
        // 引擎输出 JSON，格式化为可读文本返回
        const obj = JSON.parse(stdout)
        resolve(JSON.stringify(obj, null, 2))
      } catch {
        reject(new Error(`引擎输出非 JSON: ${stdout.slice(-400)}`))
      }
    })
    child.stdin.write(JSON.stringify(args))
    child.stdin.end()
  })
}

function mustExist(p?: string) {
  if (p && !existsSync(p)) throw new Error(`文件不存在: ${p}`)
}

export function apply(ctx: Context): void {
  // ── PDF：构建 / 提取 / 渲染验证（Sol 5.6 PDF Skill）─────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_office_docs_pdf',
    description: 'PDF 文档处理：pdf_build 用 reportlab 构建 PDF（blocks: 标题/段落/表格/图片，自动注册中文字体）；pdf_extract 提取文本+表格+元数据；pdf_render 用 pypdfium2 把每页渲染成 PNG 供视觉验证。blocks 示例：[{"type":"heading","text":"标题","level":1},{"type":"para","text":"正文"},{"type":"table","rows":[["a","b"]]}]',
    parameters: {
      action: { type: 'string', required: true, description: 'pdf_build | pdf_extract | pdf_render' },
      path: { type: 'string', description: 'PDF 路径（build 输出/extract 输入/render 输入）' },
      blocks: { type: 'array', description: 'build 用：文档块列表' },
      outdir: { type: 'string', description: 'render 用：PNG 输出目录（缺省同目录 render/）' },
      scale: { type: 'number', description: 'render 用：渲染倍率（默认 1.5）' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(args: any): Promise<string> {
      if (args.action === 'pdf_extract' || args.action === 'pdf_render') mustExist(args.path)
      return runPy(args.action, args)
    },
  })), 'dsh-office-docs: pdf')

  // ── DOCX：构建 / 提取 / 追加（Sol 5.6 DOCX Skill）───────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_office_docs_docx',
    description: 'Word 文档处理：docx_build 用 python-docx 构建（blocks: 标题/段落/表格/分页）；docx_extract 提取段落文本+表格数据；docx_append 往现有文档追加内容。',
    parameters: {
      action: { type: 'string', required: true, description: 'docx_build | docx_extract | docx_append' },
      path: { type: 'string', description: 'DOCX 路径（build 输出/extract 输入/append 输入输出）' },
      blocks: { type: 'array', description: 'build/append 用：内容块列表' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(args: any): Promise<string> {
      if (args.action === 'docx_extract' || args.action === 'docx_append') mustExist(args.path)
      return runPy(args.action, args)
    },
  })), 'dsh-office-docs: docx')

  // ── PPTX：构建 / 提取（Sol 5.6 Slides Skill）────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_office_docs_pptx',
    description: 'PowerPoint 演示文稿处理：pptx_build 用 python-pptx 构建（slides: 每页 title+bullets，标题+内容布局）；pptx_extract 提取每页文本。',
    parameters: {
      action: { type: 'string', required: true, description: 'pptx_build | pptx_extract' },
      path: { type: 'string', description: 'PPTX 路径' },
      slides: { type: 'array', description: 'build 用：幻灯片列表 [{title, bullets:[...]}]' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(args: any): Promise<string> {
      if (args.action === 'pptx_extract') mustExist(args.path)
      return runPy(args.action, args)
    },
  })), 'dsh-office-docs: pptx')

  // ── XLSX：构建 / 提取（Sol 5.6 Spreadsheets Skill）──────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_office_docs_xlsx',
    description: 'Excel 电子表格处理：xlsx_build 用 openpyxl 构建多 sheet 表格（sheets: [{name, rows:[[...]]}]，首行自动加粗表头）；xlsx_extract 读取全部 sheet 数据。',
    parameters: {
      action: { type: 'string', required: true, description: 'xlsx_build | xlsx_extract' },
      path: { type: 'string', description: 'XLSX 路径' },
      sheets: { type: 'array', description: 'build 用：sheet 列表' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(args: any): Promise<string> {
      if (args.action === 'xlsx_extract') mustExist(args.path)
      return runPy(args.action, args)
    },
  })), 'dsh-office-docs: xlsx')

  // ── 通用转换（pandoc）───────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_office_docs_convert',
    description: '文档格式转换（pandoc）：md/html/docx 等互转。input + output 路径必填，from/to 缺省按扩展名推断。如 markdown→docx、html→docx。',
    parameters: {
      input: { type: 'string', required: true, description: '输入文件路径' },
      output: { type: 'string', required: true, description: '输出文件路径（扩展名决定目标格式）' },
      from: { type: 'string', description: '源格式（缺省按 input 扩展名）' },
      to: { type: 'string', description: '目标格式（缺省按 output 扩展名）' },
      standalone: { type: 'boolean', description: '是否 -s 独立文档（缺省 false）' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute(args: any): Promise<string> {
      mustExist(args.input)
      return runPy('convert', args)
    },
  })), 'dsh-office-docs: convert')
}
