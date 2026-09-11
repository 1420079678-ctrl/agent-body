/**
 * @dsh-external/dsh-social-card — Guizang Social Card Skill 的 DSH 落地
 *
 * 把一个「Agent 驱动式设计系统」转成 DSH toolkit 插件：
 *   - 设计智能（选主题/排版/配色/文案压缩）= agent 按注入的方法论 + 可读参考文档执行
 *   - 确定性执行（能稳定产出正确尺寸 PNG）= 本插件工具
 *
 * 工具集（4 个核心 + 1 文档读取）：
 *   social_card_docs     返回指定参考文档全文（设计系统来源）
 *   social_card_scaffold 从种子模板建任务文件夹（复制 index.html + 设主题/accent）
 *   social_card_render   用 Chrome(CDP) 渲染 index.html 里每个 .poster/.pair-preview 节点成 PNG
 *   social_card_validate 跑 QA 校验器（R1-R9）
 *
 * 渲染引擎（核心，跨平台）：
 *   - 定位本机 Chrome/Chromium（env 覆盖 → 系统路径 → ms-playwright 缓存）
 *   - 优先连接「已运行 chrome」的 CDP（避免重复起进程）；找不到则自己 spawn（stdio:ignore）
 *   - 在浏览器上下文打开 file://index.html，等待字体/WebGL 就绪
 *   - 对每个 .poster/.pair-preview 节点 element.screenshot() → 原生尺寸 PNG 到 output/
 *
 * 规范：所有资源注册挂 ctx.effect（热重载/卸载自动清理，注入器踩坑记录）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, copyFileSync, cpSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { connect as netConnect } from 'node:net'

// 浏览器上下文内使用的 DOM 全局（waitForFunction 回调运行于页面，tsconfig 未含 dom lib）
declare const document: any

export const name = "@dsh-external/dsh-social-card"
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** 任务输出根目录（空 = DSH 插件数据目录 social-card 子目录） */
  outRoot: string
  /** Chrome/Chromium 可执行文件（空 = 自动探测） */
  chromePath: string
  /** 渲染时是否等待字体/网络空闲（模板依赖 Google Fonts + WebGL 背景） */
  waitForFonts: boolean
}

export const Config = z.object({
  outRoot: z.string().default(''),
  chromePath: z.string().default(''),
  waitForFonts: z.boolean().default(true),
})

// ── 插件包根：assets/ references/ validate-social-deck.mjs 都在 lib/ 同级 ──
const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(__dirname, '..')
const ASSETS = join(PKG_ROOT, 'assets')
const REFS = join(PKG_ROOT, 'references')
const VALIDATOR = join(PKG_ROOT, 'validate-social-deck.mjs')

/** 参考文档索引（文档名 → 标题/用途） */
const DOC_INDEX: Record<string, string> = {
  'platform-specs': '平台规格：精确比例/输出尺寸/命名',
  'style-system': 'Guizang 编辑杂志与瑞士风格视觉规则',
  'theme-presets': '6 杂志调色板 + 4 瑞士强调色',
  'layout-recipes': '卡片/公众号排版配方（M01-M16 / S01-S12）',
  'components': '组件规范：字栈/字号/最小可读尺寸/中文标题长度带/间距 token/Lucide 图标规则',
  'background-systems': '电子杂志 WebGL/水墨/纸张背景',
  'portrait-fill': '3:4 竖版如何避免下方欠填',
  'content-planning': '封面钩子/分页拆解/文案压缩',
  'production-workflow': 'HTML/CSS 渲染与图像处理',
  'live-photo-production': 'Live Photo 实况照片：信息预算/单vs三联/长视频 intake/发布提醒',
  'image-overlay': '文字压图：照片合格判定/局部着色/主体避让',
  'screenshot-treatment': '截图处理：.frame-shot/.frame-img/设备边框',
  'map-component': '地图组件：真实路线 Mapbox/OSM，概念示意 SVG，禁止实时 JS 地图',
  'title-shortener': '公众号 21:9+1:1 标题派生（5 步提取/4 模式/反模式）',
  'category-cookbook': '小红书 11 类目路由：食谱/配方与适用配方确认',
  'qa-checklist': '交付前 QA 检查清单',
}

// ── 系统提示方法论文本（注入每个会话；简短，详解放工具描述与文档） ──
const METHOD_SECTION = `# 归藏社交卡设计系统（Guizang Social Card Skill）

把「素材」变成小红书图文 / 公众号封面对（21:9+1:1）/ Live Photo 实况卡 / 三联实况拼图。这是一套 **Agent 驱动式设计系统**——设计判断由你做，确定性执行由工具完成。

## 两种视觉模式（一套卡片只选一种，别混搭）
1. **Editorial Magazine × E-ink**：宋体/衬线大标题 + 安静无衬线正文，纸张+墨色，氛围层（纸纹/水墨/WebGL）。用于「慢、深思、手作感」的内容。
2. **Swiss International**：Inter/Helvetica 极轻大字 + mono 小标注，严格左对齐网格，细线，一个高饱和强调色。用于「工程化、量化、果断」的内容。
   - **铁律**：瑞士模式「越大越轻」——20-240px 大字不加粗（默认 200-300），禁止 80-120px @ weight 700-900。

挑模式和主题，用 \`social_card_docs\` 读对应文档：
- 模式定不了 → 读 style-system.md（编辑意图判断：是「专题故事」还是「发布说明」）
- 选调色板 → 读 theme-presets.md（6 杂志 + 4 瑞士强调色，不发明颜色）
- 选每页排法 → 读 layout-recipes.md（M01-M16 / S01-S12，避免每页重复标题+卡片）
- 读组件规范 → components.md（字栈/字号/最小可读尺寸/中文标题长度带/间距 token）

## 标准工作流
1. **Intake**：收集影响输出的信息——目标平台/比例、源文案/文章/标题、小红书类目、素材图/截图位置、视频资产（Live Photo）、风格偏好、硬约束。用户只给文字没图时，**先问一次**要不要用他自己的照片 / 去 Pexels/Unsplash 找 / AI 生成（推荐 A：自己的照片最不「AI 感」）；只问一次，之后不碎碎念。
2. **Extract The Story**：转成页计划。小红书：P1 封面钩子，P2-N 每页一个观点，5-9 页；公众号：必出 21:9 主封面 + 1:1 方封面配对，同一 HTML 里加组合预览。
3. **Choose Style Mode**：选模式 + 一个主题（editorial 6 选1 / swiss 4 选1）。
4. **Plan Pages**：内部计划（每页：封面钩子/观点/关键文案/视觉证据/版式意图）。
5. **Seed The Template**：不要从零写 HTML。用 \`social_card_scaffold\` 从种子模板建任务文件夹，然后在 index.html 里把 \`<!-- POSTERS_HERE -->\` 占位替换成每页的 \`<section class="poster …">\`。editorial→template-editorial-card.html，swiss→template-swiss-card.html，模板已接好字体/主题 token/三种板尺寸（.xhs 1080×1440 / .square 1080×1080 / .wide 2100×900）/配对预览框/氛围层。
6. **Render**：\`social_card_render\` 渲染全部 poster 节点成 PNG 到 output/。会检查实际像素尺寸。
7. **Deliver**：默认「先给用户看」——立即贴出渲染图绝对路径 + 一句话总结，然后问「你先自己看，还是我先自动核查一遍」？用户要核查才跑 \`social_card_validate\`（R1-R9，FAIL 才退出 1，WARN 只提示）。**不要每次都跑校验器拖慢交付**。

## 硬约束（违反就是劣质）
- 内容必须覆盖 ≥75% 画布高度；>15% 的纯空白带要有留白理由；**禁止 \`flex:1\` 上下夹击把内容塞中段**。
- 标题不超行数/字符上限（小红书 h-xl ≤2 行 8 字）；标题下留 ≥28px；不许压到页脚带（页脚用 flex margin-top:auto，不用 absolute）。
- 不裁剪脸/关键 UI/产品细节；不伪造数据/百分比/发布信息。
- 不把「生产术语」当面向用户的 H1/钩子；文案写用户真实场景。
- 不在 skill 根目录放任务产物——一律用 \`social_card_scaffold\` 建任务文件夹。
- 交付前读 qa-checklist.md，跑 4 横带密度检查；跑 \`social_card_validate\` 时 R1 overflow 按溢出量分级处理（<40px 微调 / 40-90 局部压缩 / 90-160 缩标题 / 160+ 换配方）。

## 参考文档
用 \`social_card_docs <名>\` 读取。文档名见工具描述里的索引。`

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'social-card:method:v1',
    order: 80,
    text: METHOD_SECTION,
  }), 'social-card: method section')

  // 数据根目录
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const outRoot = config.outRoot || join(dshHome, 'plugins', 'dsh-social-card', 'tasks')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'social_card_docs',
    description: '读取归藏社交卡设计系统的参考文档全文（风格/排版/主题/组件/平台/标题派生等）。返回 Markdown。',
    parameters: {
      doc: { type: 'string', required: true, description: '文档名：platform-specs / style-system / theme-presets / layout-recipes / components / background-systems / portrait-fill / content-planning / production-workflow / live-photo-production / image-overlay / screenshot-treatment / map-component / title-shortener / category-cookbook / qa-checklist' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { doc: string }) {
      const key = String(args.doc).trim()
      const file = join(REFS, key + '.md')
      if (!existsSync(file)) {
        return `❌ 未找到文档「${key}」。可用：${Object.keys(DOC_INDEX).join(', ')}`
      }
      const text = readFileSync(file, 'utf8')
      return `# ${key}.md — ${DOC_INDEX[key] || ''}\n\n${text}`
    },
  })), 'social-card: docs tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'social_card_scaffold',
    description: '从种子模板创建社交卡任务文件夹：复制 index.html + 设主题/accent，返回任务路径与可用板尺寸。之后编辑 index.html 替换 POSTERS_HERE。',
    parameters: {
      taskName: { type: 'string', required: true, description: '任务名（slug，如 rednote-travel-hangzhou）' },
      mode: { type: 'string', description: 'editorial（默认，杂志×电子墨）| swiss（瑞士国际）' },
      theme: { type: 'string', description: 'editorial: ink-classic|indigo-porcelain|forest-ink|kraft-paper|dune|midnight-ink；swiss: ikb|lemon-yellow|lemon-green|safety-orange' },
      title: { type: 'string', description: '页面 <title>（可选，默认任务名）' },
      outDir: { type: 'string', description: '自定义输出根目录（默认插件数据目录 tasks/）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { taskName: string; mode?: string; theme?: string; title?: string; outDir?: string }) {
      const slug = String(args.taskName).trim().replace(/[\\/:*?"<>| ]+/g, '-')
      if (!slug) return '❌ 任务名不能为空'
      const mode = args.mode === 'swiss' ? 'swiss' : 'editorial'
      const rootDir = args.outDir || outRoot
      const taskDir = join(rootDir, slug)
      if (existsSync(taskDir)) {
        return `⚠️ 任务文件夹已存在：${taskDir}\n直接编辑其中 index.html 即可。`
      }
      const seed = mode === 'swiss'
        ? join(ASSETS, 'template-swiss-card.html')
        : join(ASSETS, 'template-editorial-card.html')
      if (!existsSync(seed)) return `❌ 种子模板缺失：${seed}`
      mkdirSync(taskDir, { recursive: true })
      mkdirSync(join(taskDir, 'assets'), { recursive: true })
      mkdirSync(join(taskDir, 'output'), { recursive: true })
      let html = readFileSync(seed, 'utf8')
      if (args.theme) {
        const t = String(args.theme).trim()
        if (mode === 'editorial' && ['ink-classic','indigo-porcelain','forest-ink','kraft-paper','dune','midnight-ink'].includes(t)) {
          html = html.replace(/data-theme="[^"]*"/, `data-theme="${t}"`)
        } else if (mode === 'swiss' && ['ikb','lemon-yellow','lemon-green','safety-orange'].includes(t)) {
          html = html.replace(/data-accent="[^"]*"/, `data-accent="${t}"`)
        }
      }
      if (args.title) {
        html = html.replace(/<title>[^<]*<\/title>/, `<title>${String(args.title).replace(/[<>&]/g, '')}</title>`)
      }
      writeFileSync(join(taskDir, 'index.html'), html, 'utf8')
      copyFileSync(join(ASSETS, 'magazine-bg-webgl.js'), join(taskDir, 'assets', 'magazine-bg-webgl.js'))
      const bgSrc = join(ASSETS, 'screenshot-backgrounds')
      if (existsSync(bgSrc)) {
        cpSync(bgSrc, join(taskDir, 'assets', 'screenshot-backgrounds'), { recursive: true })
      }
      writeFileSync(join(taskDir, 'assets', 'SOURCES.md'), `# 素材来源（Image Sources）\n\n逐行记录：\`文件名 ← 来源URL\`\n- \n`, 'utf8')
      const boardInfo = `.poster.xhs    1080×1440  (3:4  小红书)
.poster.square 1080×1080  (1:1  微信方封面)
.poster.wide   2100× 900  (21:9 微信主封面)
配对预览: <section class="pair-preview"> 放 21:9 + 1:1 并排`
      return `✅ 已创建任务：${taskDir}

模式：${mode}${args.theme ? ` · ${args.theme}` : ''}

操作：
1. 编辑 ${join(taskDir, 'index.html')}，把 \`<!-- POSTERS_HERE -->\` 占位替换成每页 \`<section class="poster …">\`
2. 素材图放 ${join(taskDir, 'assets')}/
3. 用 social_card_render 渲染 → 输出到 ${join(taskDir, 'output')}/

可用板尺寸：
${boardInfo}`
    },
  })), 'social-card: scaffold tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'social_card_render',
    description: '用 Chrome(CDP) 把任务 index.html 里每个 .poster/.pair-preview 节点渲染成原生尺寸 PNG，输出到任务 output/。返回每个文件的像素尺寸。',
    parameters: {
      taskDir: { type: 'string', required: true, description: '任务文件夹（含 index.html）' },
      waitMs: { type: 'number', description: '渲染等待毫秒（默认 1500，等字体/WebGL）' },
      scale: { type: 'number', description: '缩放因子（默认 1 原生尺寸，2=高清）' },
      includePair: { type: 'boolean', description: '是否渲染 .pair-preview 配对预览框（默认 true）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { taskDir: string; waitMs?: number; scale?: number; includePair?: boolean }) {
      const taskDir = args.taskDir
      const indexHtml = join(taskDir, 'index.html')
      if (!existsSync(indexHtml)) {
        return `❌ 未找到 index.html：${indexHtml}\n先用 social_card_scaffold 建任务。`
      }
      const outDir = join(taskDir, 'output')
      mkdirSync(outDir, { recursive: true })
      const waitMs = args.waitMs ?? 1500
      const scale = args.scale ?? 1
      const includePair = args.includePair !== false

      const chrome = config.chromePath || detectChrome()
      if (!chrome) {
        return `❌ 未找到 Chrome/Chromium。请设置 config.chromePath 指向 chrome.exe，或安装 Chrome。`
      }

      let browser: any = null
      let cleanup: (() => void) | null = null
      const { chromium } = await import('playwright-core')

      // 优先连已运行 chrome 的 CDP
      const cdpUrl = await ensureChromeCdp(chrome)
      if (cdpUrl) {
        try {
          browser = await chromium.connectOverCDP(cdpUrl)
        } catch {
          browser = null
        }
      }
      // 否则自 spawn（stdio:ignore 避免管道 EPERM）
      if (!browser) {
        const port = 9333 + Math.floor(Math.random() * 40)
        const proc = spawn(chrome, [
          '--headless=new', '--disable-gpu', '--hide-scrollbars',
          '--no-first-run', '--no-default-browser-check', '--disable-extensions',
          '--force-device-scale-factor=1',
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${join(homedir(), '.dsh-social-card-chrome')}`,
          'about:blank',
        ], { stdio: 'ignore', windowsHide: true, detached: false })
        cleanup = () => { try { proc.kill() } catch {} }
        await waitForTcp(`127.0.0.1:${port}`, 8000)
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      }

      try {
        const page = await browser.newPage()
        const fileUrl = 'file://' + indexHtml.replace(/\\/g, '/')
        await page.goto(fileUrl, { waitUntil: 'load' })
        await page.waitForTimeout(waitMs)
        if (config.waitForFonts) {
          try { await page.waitForFunction(() => (document as any).fonts?.status === 'loaded', null, { timeout: 5000 }) } catch {}
          await page.waitForTimeout(300)
        }

        const selectors = ['section.poster']
        if (includePair) selectors.push('section.pair-preview')
        const results: string[] = []
        const nodes = await page.$$(selectors.join(','))
        if (nodes.length === 0) {
          return `⚠️ 未找到 .poster / .pair-preview 节点。请确认 index.html 里已替换 POSTERS_HERE 为 <section class="poster …">。`
        }
        for (const n of nodes) {
          const id = await n.evaluate((el: any) => el.id || el.dataset?.id || el.className || 'node')
          const bb = await n.boundingBox()
          const safe = String(id).replace(/[\\/:*?"<>| ]+/g, '-')
          const f = join(outDir, `${safe}.png`)
          await n.screenshot({ path: f, type: 'png' })
          results.push(`  ✓ ${safe}  →  ${f}  (${Math.round(bb?.width || 0)}×${Math.round(bb?.height || 0)})`)
        }
        return `✅ 渲染完成 ${nodes.length} 个节点 → ${outDir}/\n${results.join('\n')}\n\n这些 PNG 即最终社交卡。`
      } finally {
        try { await browser.close() } catch {}
        if (cleanup) cleanup()
      }
    },
  })), 'social-card: render tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'social_card_validate',
    description: '跑归藏 QA 校验器（R1-R9：溢出/页脚碰撞/瑞士粗体/最小字号/4带密度/标题行数/版心擦除/视觉边界/标题间距）。FAIL 退出 1，WARN 只提示。',
    parameters: {
      taskDir: { type: 'string', required: true, description: '任务文件夹（含 index.html）' },
      style: { type: 'string', description: 'swiss | editorial（可选；缺省自动从 html data-theme/data-accent 推断）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { taskDir: string; style?: string }) {
      const indexHtml = join(args.taskDir, 'index.html')
      if (!existsSync(indexHtml)) return `❌ 未找到 index.html：${indexHtml}`
      if (!existsSync(VALIDATOR)) return `❌ 校验器缺失：${VALIDATOR}`
      try {
        const out = execFileSync('node', args.style ? [VALIDATOR, args.taskDir, `--style=${args.style}`] : [VALIDATOR, args.taskDir], {
          encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
        })
        return `✅ 校验通过：\n${out}`
      } catch (e: any) {
        const stderr = e.stderr ? String(e.stderr) : ''
        const stdout = e.stdout ? String(e.stdout) : ''
        const body = stdout || stderr
        if (body) {
          return `⚠️ 校验到问题（exit ${e.status}）：\n${body}`
        }
        return `❌ 校验器执行失败：${String(e.message || e)}`
      }
    },
  })), 'social-card: validate tool')
}

// ── Chrome 定位 / CDP 连接辅助 ────────────────────────────────────────────
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
function detectChrome(): string | null {
  if (process.env.DSH_SOCIAL_CARD_CHROME) {
    const p = process.env.DSH_SOCIAL_CARD_CHROME
    if (existsSync(p)) return p
  }
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c
  try {
    const mp = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    if (existsSync(mp)) {
      const dirs = readdirSync(mp).filter(d => /^chromium-\d+/.test(d))
      dirs.sort((a, b) => parseInt(b.replace(/chromium-/, ''), 10) - parseInt(a.replace(/chromium-/, ''), 10))
      for (const d of dirs) {
        for (const sub of ['chrome-win64', 'chrome-win']) {
          const exe = join(mp, d, sub, 'chrome.exe')
          if (existsSync(exe)) return exe
        }
      }
    }
  } catch {}
  return null
}

// 尝试连已运行的 chrome CDP；返回 URL 或 null
async function ensureChromeCdp(chrome: string): Promise<string | null> {
  for (const port of [9222, 9223, 9333, 9334]) {
    const url = `http://127.0.0.1:${port}`
    try {
      const res = await fetchJson(url + '/json/version')
      if (res && res.webSocketDebuggerUrl) return url
    } catch {}
  }
  return null
}

// 简单 JSON fetch
function fetchJson(url: string): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const fn = url.startsWith('https') ? httpsGet : httpGet
    const req = fn(url, (res: any) => {
      let data = ''
      res.on('data', (c: any) => (data += c))
      res.on('end', () => {
        try { resolvePromise(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// 等 TCP 端口就绪（spawn 后等待 CDP）
async function waitForTcp(hostPort: string, timeoutMs: number): Promise<void> {
  const [host, portStr] = hostPort.split(':')
  const port = parseInt(portStr, 10)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const sock = netConnect(port, host, () => { sock.destroy(); resolvePromise() })
        sock.on('error', () => reject(new Error('conn refused')))
        sock.setTimeout(500, () => { sock.destroy(); reject(new Error('timeout')) })
      })
      return
    } catch {
      await sleep(200)
    }
  }
  throw new Error(`CDP port ${hostPort} not ready after ${timeoutMs}ms`)
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
