/**
 * @dsh-external/dsh-file-chips — UI 面板形态（由 dev_scaffold_plugin 生成）。
 * host 侧：工具 + webServer API；client 侧：conversation.view slot 面板。
 * 构建：npm run build（host tsc）+ npm run build:client（tsdown → lib/client.js）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'

export const name = "@dsh-external/dsh-file-chips"
export const inject = ['tools', 'webServer']

export interface Config {
  title: string
}

export const Config = z.object({
  title: z.string().default('面板'),
})

export function apply(ctx: Context, config: Config): void {
  // host API（前缀路由，client 面板消费）
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/@dsh-external/dsh-file-chips/api',
    handler: async (req: any, res: any) => {
      const text = JSON.stringify({ title: config.title, ts: Date.now() })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(text)
    },
  }), '@dsh-external/dsh-file-chips: api')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_file_chips_status',
    description: "Codex-style file attachment chips in the composer: shows uploaded file names as removable chips above the textarea",
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return JSON.stringify({ title: config.title })
    },
  })), '@dsh-external/dsh-file-chips: status tool')
}
