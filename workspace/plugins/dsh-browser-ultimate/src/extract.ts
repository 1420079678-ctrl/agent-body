/**
 * 内容提取层（crawl4ai 式能力「综合」进真实浏览器引擎）：
 * - 正文净化（Readability 风格打分器，页面内执行）
 * - 链接提取（内/外链去重）
 * - CSS 结构化提取（crawl4ai_extract 等价物）
 * - 整站 BFS 深爬（带登录态，逐页正文摘要）
 *
 * 所有脚本以「函数表达式」注入 eval（daemon 用 args 包装 IIFE 调用）。
 */
import { daemonCommand } from './api.js'
import type { BrowserEngine } from './engine.js'
import type { CommandResult } from './api.js'

/** 正文净化脚本（函数表达式，接收 args；返回 {url,title,byline,text,wordCount,...}） */
export const EXTRACT_CONTENT_JS = `(function (args) {
  var NEG = /comment|sidebar|footer|menu|nav|breadcrumb|related|recommend|promo|advert|banner|cookie|social|share|widget|login|signin|subscribe|newsletter|pagination|popup|modal|hidden/i;
  var POS = /article|content|main|post|entry|text|body|detail|news|story|page/i;
  var REMOVE = 'script,style,noscript,template,iframe,svg,canvas,audio,video,form,button,select,textarea,input,header,footer,aside,nav,.ads,.advert,.advertisement,.banner,.share,.social,.comment,.comments,.footer,.sidebar,.menu,.nav,.navigation,.breadcrumb,.pagination,.related,.recommend,.recommended,.promo,.popup,.modal,.cookie,.newsletter,.subscribe,.widget,.hidden,[hidden],[aria-hidden="true"]';
  var strip = function (el) { try { el.querySelectorAll(REMOVE).forEach(function (n) { n.remove(); }); } catch (e) {} };
  var title = document.title || (document.querySelector('meta[property="og:title"]') || {}).content || '';
  var candidates = Array.from(document.querySelectorAll('p,pre,blockquote,li,td,h1,h2,h3,h4,h5,h6'));
  var scores = new Map();
  candidates.forEach(function (el) {
    var t = (el.textContent || '').trim();
    if (t.length < 25) return;
    var score = Math.min(4, Math.floor(t.length / 200));
    if ((t.match(/[，,。.；;]/g) || []).length > 3) score += 1;
    var cls = (el.className || '') + ' ' + (el.id || '');
    if (POS.test(cls)) score += 3;
    if (NEG.test(cls)) { return; }
    var cur = el.parentElement, depth = 0;
    while (cur && depth < 4) {
      var c = (cur.className || '') + ' ' + (cur.id || '');
      if (POS.test(c)) score += 4;
      if (NEG.test(c)) score -= 6;
      scores.set(cur, (scores.get(cur) || 0) + score);
      cur = cur.parentElement; depth++;
    }
  });
  var best = null, bestScore = 0;
  scores.forEach(function (s, el) {
    if (s > bestScore && (el.textContent || '').trim().length > 100) { bestScore = s; best = el; }
  });
  var root = best;
  if (!root) {
    root = document.querySelector('article') || document.querySelector('main') || document.querySelector('.content') || document.querySelector('#content') || document.body;
  }
  strip(root);
  var paras = [];
  root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre,blockquote,li').forEach(function (n) {
    var t = (n.textContent || '').trim();
    if (t.length >= 15) paras.push(t);
  });
  if (!paras.length) {
    var tt = (root.textContent || '').trim();
    if (tt) paras.push(tt);
  }
  var text = paras.join('\\n\\n');
  if (args && args.maxLength && text.length > args.maxLength) text = text.slice(0, args.maxLength) + '\\n…[截断]';
  var byline = ((document.querySelector('meta[name="author"]') || {}).content || (document.querySelector('meta[property="article:author"]') || {}).content || '').trim();
  var sel = '';
  if (root && root !== document.body) { sel = root.tagName + '.' + String(root.className || '').split(' ').slice(0, 3).join('.'); }
  return { url: location.href, title: title, byline: byline, text: text, wordCount: text.split(/\\s+/).filter(Boolean).length, paragraphs: paras.length, selected: sel.slice(0, 80) };
})`

/** 链接提取脚本（返回 {internal:[{href,text}], external:[...]}） */
export const EXTRACT_LINKS_JS = `(function (args) {
  var base = location.origin;
  var out = { internal: [], external: [] };
  var seen = new Set();
  document.querySelectorAll('a[href]').forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href) return;
    try { href = new URL(href, location.href).href; } catch (e) { return; }
    if (!/^https?:/.test(href)) return;
    var t = (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    var key = href + '|' + t;
    if (seen.has(key)) return; seen.add(key);
    var item = { href: href, text: t };
    if (href.indexOf(base) === 0) out.internal.push(item); else out.external.push(item);
  });
  var dedupe = function (arr) { var m = new Map(); arr.forEach(function (i) { if (!m.has(i.href)) m.set(i.href, i); }); return Array.from(m.values()); };
  out.internal = dedupe(out.internal); out.external = dedupe(out.external);
  if (args && args.maxInternal) out.internal = out.internal.slice(0, args.maxInternal);
  if (args && args.maxExternal) out.external = out.external.slice(0, args.maxExternal);
  return out;
})`

/** CSS 结构化提取脚本（args.schema = {baseSelector, fields:[{name,selector,type,attr,fields}]}） */
export const EXTRACT_CSS_JS = `(function (args) {
  var schema = args.schema || {};
  var q = function (el, sel) { try { return el.querySelector(sel); } catch (e) { return null; } };
  var qa = function (el, sel) { try { return Array.from(el.querySelectorAll(sel)); } catch (e) { return []; } };
  var pick = function (el, f) {
    if (!f || !f.selector) return null;
    var node = q(el, f.selector);
    if (!node) return null;
    var type = f.type || 'text';
    if (type === 'text') return (node.textContent || '').trim();
    if (type === 'html') return node.innerHTML;
    if (type === 'attr') return node.getAttribute(f.attr || 'href') || '';
    if (type === 'list') return qa(el, f.selector).map(function (n) { return (n.textContent || '').trim(); }).filter(Boolean);
    if (type === 'nested') return qa(el, f.selector).map(function (n) { return extractNode(n, f.fields); });
    return (node.textContent || '').trim();
  };
  var extractNode = function (root, fields) {
    var obj = {};
    (fields || []).forEach(function (f) { obj[f.name] = pick(root, f); });
    return obj;
  };
  var rows = schema.baseSelector ? qa(document, schema.baseSelector).map(function (n) { return extractNode(n, schema.fields); }) : [extractNode(document, schema.fields)];
  return { url: location.href, count: rows.length, rows: rows };
})`

/** 登录态 fetch 脚本（args = {url, method, headers, body}，credentials include） */
export const FETCH_JS = `(function (args) {
  return (async function () {
    var r = await fetch(args.url, {
      method: args.method || 'GET',
      headers: args.headers || {},
      body: args.body || undefined,
      credentials: 'include',
      redirect: 'follow',
    });
    var ct = r.headers.get('content-type') || '';
    var text = await r.text();
    var parsed = null;
    if (ct.indexOf('json') >= 0) { try { parsed = JSON.parse(text); } catch (e) {} }
    var headers = {};
    r.headers.forEach(function (v, k) { headers[k] = v; });
    return { status: r.status, statusText: r.statusText, headers: headers, url: r.url, textLength: text.length, parsed: parsed, text: text.slice(0, 200000) };
  })();
})`

export interface CrawlPage {
  url: string
  title: string
  wordCount: number
  summary: string
  depth: number
}

/**
 * 整站 BFS 深爬（单标签页顺序执行，带登录态）。
 * 返回逐页 {url,title,wordCount,summary,depth}，summary 为正文前 N 字符。
 */
export async function deepCrawl(
  engine: BrowserEngine,
  seedUrl: string,
  opts: { maxPages?: number; maxDepth?: number; summaryLen?: number; sameOriginOnly?: boolean } = {},
): Promise<{ pages: CrawlPage[]; visited: number }> {
  const maxPages = Math.min(opts.maxPages ?? 20, 100)
  const maxDepth = opts.maxDepth ?? 2
  const summaryLen = opts.summaryLen ?? 500
  const sameOriginOnly = opts.sameOriginOnly ?? true

  let seed = seedUrl
  if (!/^https?:/.test(seed)) seed = 'https://' + seed

  const pages: CrawlPage[] = []
  const visited = new Set<string>()
  const queue: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }]

  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift()!
    if (visited.has(url)) continue
    visited.add(url)

    try {
      const open = await daemonCommand(engine, 'open', { url }, 40000)
      const tab = open.result.tab as string
      await new Promise((r) => setTimeout(r, 900)) // SPA/渲染等待

      const content = await daemonCommand(engine, 'eval', {
        script: EXTRACT_CONTENT_JS,
        args: {},
        tab,
      }, 20000)
      const c = content.result.result as any
      const summary = (c?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, summaryLen)

      pages.push({ url, title: c?.title ?? '', wordCount: c?.wordCount ?? 0, summary, depth })

      if (depth < maxDepth) {
        const linksRes = await daemonCommand(engine, 'eval', {
          script: EXTRACT_LINKS_JS,
          args: { maxInternal: 30, maxExternal: 0 },
          tab,
        }, 15000)
        const links = linksRes.result.result as { internal: Array<{ href: string }> }
        for (const l of links.internal ?? []) {
          if (visited.has(l.href)) continue
          const u = new URL(l.href)
          const s = new URL(seed)
          if (sameOriginOnly && u.origin !== s.origin) continue
          queue.push({ url: l.href, depth: depth + 1 })
        }
      }
    } catch (e) {
      pages.push({ url, title: `[失败] ${(e as Error).message.slice(0, 120)}`, wordCount: 0, summary: '', depth })
    }
  }

  return { pages, visited: visited.size }
}

/** 把 daemon 的 pinix:// 截图路径转成真实绝对路径 */
export function resolveShotPath(pinixPath: string, dataDir: string): string {
  const m = /screenshots\/([^/]+)$/.exec(pinixPath)
  if (!m) return pinixPath
  return `${dataDir}/data/browser/screenshots/${m[1]}`
}

export type { CommandResult }
