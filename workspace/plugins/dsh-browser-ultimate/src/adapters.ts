/**
 * 内置站点适配器（真实浏览器登录态直取；社区 adapter 走 daemon site_run）。
 * 每个 adapter: { name, description, domain, args描述, run(engine, args, tab?) }
 */
import { daemonCommand } from './api.js'
import { EXTRACT_CONTENT_JS } from './extract.js'
import type { BrowserEngine } from './engine.js'

export interface BuiltinAdapter {
  name: string
  description: string
  domain: string
  args: Record<string, string>
  example: string
  run: (engine: BrowserEngine, args: Record<string, string>) => Promise<unknown>
}

/** 打开 URL 并提取正文（通用后端） */
async function openAndExtract(engine: BrowserEngine, url: string): Promise<unknown> {
  const open = await daemonCommand(engine, 'open', { url }, 40000)
  const tab = open.result.tab as string
  await new Promise((r) => setTimeout(r, 1200))
  const res = await daemonCommand(engine, 'eval', { script: EXTRACT_CONTENT_JS, args: { maxLength: 8000 }, tab }, 20000)
  const c = res.result.result as any
  return { tab, url, title: c?.title, byline: c?.byline, wordCount: c?.wordCount, text: (c?.text ?? '').slice(0, 8000) }
}

export const BUILTIN_ADAPTERS: BuiltinAdapter[] = [
  {
    name: 'wikipedia/summary',
    description: '维基百科词条摘要（zh.wikipedia REST API，可跨域）',
    domain: 'zh.wikipedia.org',
    args: { q: '词条名' },
    example: 'wikipedia/summary "Python"',
    async run(engine, args) {
      const q = args.q ?? args.query ?? 'Python'
      const res = await daemonCommand(engine, 'eval', {
        script: `(function (a) { return (async function () { var r = await fetch('https://zh.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(a.q), { headers: { 'Accept': 'application/json' } }); if (!r.ok) return { error: 'HTTP ' + r.status }; return await r.json(); })(); })`,
        args: { q },
      }, 20000)
      const j = res.result.result as any
      if (j?.error) throw new Error(`wikipedia: ${j.error}`)
      return {
        title: j?.title,
        extract: j?.extract ?? '',
        description: j?.description,
        url: j?.content_urls?.desktop?.page ?? j?.content_urls?.mobile?.page,
        wordCount: (j?.extract ?? '').split(/\s+/).filter(Boolean).length,
      }
    },
  },
  {
    name: 'zhihu/hot',
    description: '知乎热榜（真实登录态打开热榜页提取）',
    domain: 'www.zhihu.com',
    args: {},
    example: 'zhihu/hot',
    async run(engine) {
      const open = await daemonCommand(engine, 'open', { url: 'https://www.zhihu.com/hot' }, 40000)
      const tab = open.result.tab as string
      await new Promise((r) => setTimeout(r, 2500))
      const res = await daemonCommand(engine, 'eval', {
        script: `(function (a) {
          var rows = [];
          document.querySelectorAll('.HotItem').forEach(function (el) {
            var t = el.querySelector('.HotItem-title'); var e = el.querySelector('.HotItem-excerpt'); var h = el.querySelector('.HotItem-metrics');
            var link = el.querySelector('a.HotItem-title') || el.querySelector('a');
            rows.push({ rank: rows.length + 1, title: t ? t.textContent.trim() : '', excerpt: e ? e.textContent.trim().slice(0, 120) : '', heat: h ? h.textContent.trim() : '', href: link ? link.href : '' });
          });
          return { url: location.href, count: rows.length, rows: rows };
        })`,
        args: {}, tab,
      }, 20000)
      return res.result.result
    },
  },
  {
    name: 'bilibili/video',
    description: 'B站视频信息（BV号，真实登录态打开页面提取）',
    domain: 'www.bilibili.com',
    args: { bvid: 'BV1xx411c7mD' },
    example: 'bilibili/video BV1xx411c7mD',
    async run(engine, args) {
      const bvid = args.bvid ?? args.video ?? ''
      if (!/^BV/.test(bvid)) throw new Error('bilibili/video 需要 BV 号，如 BV1xx411c7mD')
      const open = await daemonCommand(engine, 'open', { url: `https://www.bilibili.com/video/${bvid}` }, 40000)
      const tab = open.result.tab as string
      await new Promise((r) => setTimeout(r, 2500))
      const res = await daemonCommand(engine, 'eval', {
        script: `(function (a) {
          var og = function (p) { var m = document.querySelector('meta[property="' + p + '"]'); return m ? m.content : ''; };
          var t = document.querySelector('h1');
          return { url: location.href, title: og('og:title') || (t ? t.textContent.trim() : ''), description: og('og:description') || '', viewCount: og('og:video:tag') ? '' : '', bvid: a.bvid, pageTitle: document.title };
        })`,
        args: { bvid }, tab,
      }, 20000)
      return res.result.result
    },
  },
  {
    name: 'github/search',
    description: 'GitHub 仓库搜索（真实登录态打开搜索结果页提取）',
    domain: 'github.com',
    args: { q: '关键词' },
    example: 'github/search "dsh-plugin"',
    async run(engine, args) {
      const q = args.q ?? args.query ?? ''
      if (!q) throw new Error('github/search 需要 q 参数')
      const open = await daemonCommand(engine, 'open', { url: `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories` }, 40000)
      const tab = open.result.tab as string
      await new Promise((r) => setTimeout(r, 2500))
      const res = await daemonCommand(engine, 'eval', {
        script: `(function (a) {
          var rows = [];
          document.querySelectorAll('div[data-testid="results-list"] > div').forEach(function (el) {
            var link = el.querySelector('a[href^="/"]');
            var desc = el.querySelector('p');
            var stars = el.querySelector('#repo-stars-counter-star');
            if (!link) return;
            rows.push({ fullName: link.textContent.trim().replace(/\\s+/g, ''), href: 'https://github.com' + link.getAttribute('href'), desc: desc ? desc.textContent.trim().slice(0, 150) : '', stars: stars ? stars.textContent.trim() : '' });
          });
          return { url: location.href, query: a.q, count: rows.length, rows: rows };
        })`,
        args: { q }, tab,
      }, 20000)
      return res.result.result
    },
  },
]

export function findBuiltin(name: string): BuiltinAdapter | undefined {
  return BUILTIN_ADAPTERS.find((a) => a.name === name)
}
