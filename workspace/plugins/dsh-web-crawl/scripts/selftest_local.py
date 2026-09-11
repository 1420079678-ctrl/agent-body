#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""selftest_local.py — 完全离线的确定性回归。

本机外网不稳（getaddrinfo 失败 / 握手超时），线上冒烟会时红时绿。这个套件把
worker 的**纯逻辑**部分（sitemap 发现、JS 空壳判定、Markdown 抽取、链接统计、
缓存、CSS 抽取、文档响应识别）用合成输入直接验证，不碰网络，结果可复现。

用法：python selftest_local.py
"""
import importlib.util
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
PLUG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PLUG, 'lib', 'shims'))
sys.path.insert(0, os.path.join(PLUG, 'vendor'))

spec = importlib.util.spec_from_file_location('wcw', os.path.join(PLUG, 'lib', 'webcrawl_worker.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

PASS, FAIL = 0, 0


def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  PASS {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}  {detail}')


# ── 合成站点：robots.txt → sitemap index → 两个子 sitemap ────────────────────
ROBOTS = """User-agent: *
Disallow: /private/
Sitemap: https://demo.test/sitemap-index.xml
"""
SITEMAP_INDEX = """<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://demo.test/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://demo.test/sitemap-2.xml</loc></sitemap>
</sitemapindex>
"""
SITEMAP_1 = """<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://demo.test/a</loc></url>
  <url><loc>https://demo.test/b</loc></url>
  <url><loc>https://demo.test/c</loc></url>
</urlset>
"""
SITEMAP_2 = """<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://demo.test/d</loc></url>
</urlset>
"""
SITEMAP_404 = '<html><body>not found</body></html>'

FAKE = {
    'https://demo.test/robots.txt': (200, ROBOTS),
    'https://demo.test/sitemap-index.xml': (200, SITEMAP_INDEX),
    'https://demo.test/sitemap-1.xml': (200, SITEMAP_1),
    'https://demo.test/sitemap-2.xml': (200, SITEMAP_2),
    'https://demo.test/sitemap.xml': (404, SITEMAP_404),
}

_real_http_get = w.http_get


def fake_http_get(url, timeout=25, headers=None, user_agent=None, proxy=''):
    if url in FAKE:
        status, body = FAKE[url]
        return {'status': status, 'headers': {'content-type': 'text/plain'},
                'body': body, '_raw': body.encode(), 'final_url': url, 'elapsed_ms': 0}
    raise w.ToolError(f'network disabled in selftest: {url}')


print('=== 1. sitemap 发现（robots.txt → sitemap index → 子 sitemap）===')
w.http_get = fake_http_get
r = w.discover_sitemap('https://demo.test', max_urls=100)
check('robots.txt 里解析出 Sitemap 行', 'https://demo.test/sitemap-index.xml' in r['sitemaps'], str(r['sitemaps']))
check('index 递归到两个子 sitemap',
      'https://demo.test/sitemap-1.xml' in r['sitemaps'] and 'https://demo.test/sitemap-2.xml' in r['sitemaps'],
      str(r['sitemaps']))
check('URL 汇总 4 条且去重', len(r['urls']) == 4, f"got {r['urls']}")
check('未误抓 404 sitemap 的内容', 'https://demo.test/sitemap.xml' not in r['sitemaps'], str(r['sitemaps']))

print('\n=== 2. robots.txt 无 Sitemap 行时退回 /sitemap.xml ===')
FAKE['https://demo.test/robots.txt'] = (200, 'User-agent: *\nDisallow: /\n')
r2 = w.discover_sitemap('https://demo.test', max_urls=100)
check('退回默认 /sitemap.xml', r2['sitemaps'] == ['https://demo.test/sitemap.xml'], str(r2['sitemaps']))
FAKE['https://demo.test/robots.txt'] = (200, ROBOTS)

print('\n=== 3. robots.txt 不可达时仍退回默认路径 ===')


def dead_http_get(url, **kw):
    raise w.ToolError('boom')


w.http_get = dead_http_get
r3 = w.discover_sitemap('https://demo.test', max_urls=10)
check('robots 挂了也不抛异常', r3['sitemaps'] == ['https://demo.test/sitemap.xml'], str(r3))
w.http_get = _real_http_get

# ── 4. JS 空壳判定 ─────────────────────────────────────────────────────────
print('\n=== 4. JS 空壳判定（该渲染 / 不该渲染）===')
SPA_SHELL = ('<html><head><title>App</title></head><body><div id="root"></div>'
             '<script>' + 'var data=' + '[' + ','.join(['"x"'] * 4000) + '];' + '</script>'
             '</body></html>')
STATIC_SHORT = ('<html><head><title>Example</title></head><body>'
                '<h1>Example Domain</h1><p>This domain is for use in examples.</p>'
                '</body></html>')
NOSCRIPT_ONLY = ('<html><body><noscript>Please enable JavaScript to continue.</noscript>'
                 '<div id="app"></div></body></html>')
STATIC_ARTICLE = ('<html><head><title>Doc</title></head><body><article><h1>T</h1>' +
                  '<p>' + 'word ' * 500 + '</p></article></body></html>')
CF_CHALLENGE = '<html><head><title>Just a moment...</title></head><body>' \
               '<div class="cf-challenge-running">checking your browser</div></body></html>'

check('SPA 空壳（#root + 巨量内联脚本）→ 需渲染', w.looks_js_gated(SPA_SHELL) is True)
check('短静态页（example.com 型）→ 不渲染', w.looks_js_gated(STATIC_SHORT) is False)
check('noscript 提示 → 需渲染', w.looks_js_gated(NOSCRIPT_ONLY) is True)
check('正常长文章 → 不渲染', w.looks_js_gated(STATIC_ARTICLE) is False)
check('Cloudflare 挑战页 → 需渲染', w.looks_js_gated(CF_CHALLENGE) is True)
check('空 HTML → 需渲染', w.looks_js_gated('') is True)

# ── 5. 正文抽取：真 Markdown + 链接/表格开关 ────────────────────────────────
print('\n=== 5. 正文抽取产出真 Markdown ===')
ARTICLE = """<html><head><title>Test Article</title>
<meta property="og:site_name" content="DemoSite">
<meta name="description" content="A demo description">
<meta name="author" content="Jane Doe">
</head><body><nav>menu junk</nav>
<article><h1>Main Heading</h1>
<p>First paragraph with a <a href="https://demo.test/x">link</a>.</p>
<h2>Sub Heading</h2>
<ul><li>alpha</li><li>beta</li></ul>
<table><tr><th>k</th><th>v</th></tr><tr><td>1</td><td>2</td></tr></table>
</article><footer>footer junk</footer></body></html>"""

ex = w.extract_html(ARTICLE, 'https://demo.test/a')
txt = ex['text']
check('抽取器为 trafilatura 系（短页会选 precision 档）',
      ex['engine'] in ('trafilatura', 'trafilatura-precision'), str(ex['engine']))
check('含 Markdown 一级标题', '# Main Heading' in txt, repr(txt[:200]))
check('含 Markdown 二级标题', '## Sub Heading' in txt, repr(txt[:300]))
check('含 Markdown 链接', '](https://demo.test/x)' in txt, repr(txt[:300]))
check('含 Markdown 表格', '|' in txt and '---' in txt, repr(txt[-300:]))
check('导航/页脚杂质被去除', 'menu junk' not in txt and 'footer junk' not in txt)
check('元数据 title 快路径命中', ex.get('title') == 'Test Article', str(ex.get('title')))
check('元数据 sitename 来自 og:site_name', ex.get('sitename') == 'DemoSite', str(ex.get('sitename')))
check('元数据 author 命中', ex.get('author') == 'Jane Doe', str(ex.get('author')))

t0 = time.time()
w.extract_html(ARTICLE * 40, 'https://demo.test/a')
dt = time.time() - t0
check(f'大文档抽取 < 1.5s（实测 {dt:.2f}s）', dt < 1.5, f'{dt:.2f}s')

# ── 5b. 性能回归闸门：禁止把主路径退回 bare_extraction ──────────────────────
# 实测（同一输入）：extract(output_format='markdown') 远快于 bare_extraction——
# bare_extraction 要构建 Document 并跑元数据/日期解析，且产出的是纯文本。
# 合成页面上约 7x；带元数据的真实页面（如文档站）差距更大。闸门设 3x 以跨机器稳健。
print('\n=== 5b. 抽取快路径 vs 慢路径（离线基准，与网络无关）===')
BIG = ('<html><head><title>Big</title></head><body><article>'
       + ''.join(f'<h2>Sec {i}</h2><p>' + 'lorem ipsum dolor sit amet. ' * 40 + '</p>'
                 for i in range(80))
       + '</article></body></html>')
import trafilatura as _tf

def _time(fn, n=2):
    best = None
    for _ in range(n):
        t = time.time()
        fn()
        d = time.time() - t
        best = d if best is None else min(best, d)
    return best

t_fast = _time(lambda: _tf.extract(BIG, url='https://demo.test/big', output_format='markdown'))
t_slow = _time(lambda: _tf.bare_extraction(BIG, url='https://demo.test/big', with_metadata=True))
ratio = t_slow / max(t_fast, 1e-6)
print(f'  extract(markdown) = {t_fast:.3f}s   bare_extraction(meta) = {t_slow:.3f}s   ratio = {ratio:.1f}x')
check(f'快路径比 bare_extraction 快 ≥3x（实测 {ratio:.1f}x）', ratio >= 3, f'{ratio:.1f}x')
fast_out = _tf.extract(BIG, output_format='markdown') or ''
check('快路径产出真 Markdown（含标题）', fast_out.count('\n##') >= 70, str(fast_out.count("\n##")))
slow_doc = _tf.bare_extraction(BIG, url='https://demo.test/big', with_metadata=True)
slow_txt = (slow_doc.get('text') if isinstance(slow_doc, dict) else getattr(slow_doc, 'text', '')) or ''
check('慢路径确实只给纯文本（无 Markdown 标题）', slow_txt.count('\n##') == 0, str(slow_txt.count("\n##")))

# ── 6. 链接统计 ────────────────────────────────────────────────────────────
print('\n=== 6. 链接统计（内部/外部/去重/锚点）===')
LINKS_HTML = ('<html><body>'
              '<a href="/a">a</a><a href="/a">a dup</a><a href="/a#frag">a frag</a>'
              '<a href="https://demo.test/b?q=1#x">b</a>'
              '<a href="https://other.test/c">ext</a>'
              '<a href="mailto:x@y.z">mail</a>'
              '<a href="javascript:void(0)">js</a>'
              '</body></html>')
lk = w.count_links(LINKS_HTML, 'https://demo.test/')
# /a、/a(重复)、/a#frag(去锚点后仍是 /a) → 去重后只剩 2 个内部链接；/b?q=1#x 去锚点是另一个
check('内部链接去重/去锚点后为 2（/a 与 /b?q=1）', lk['internal'] == 2, str(lk['internal']))
check('外部链接为 1', lk['external'] == 1, str(lk['external']))
check('mailto/javascript 不计入', all('mailto' not in l['href'] and 'javascript' not in l['href']
                                      for l in lk['links']), str([l['href'] for l in lk['links']]))

# ── 7. 文档响应识别 ────────────────────────────────────────────────────────
print('\n=== 7. 文档响应识别（自动转 markitdown）===')
check('Content-Type: application/pdf → 文档',
      w._is_document('https://x/y', {'content-type': 'application/pdf'}) is True)
check('.xlsx 扩展名 → 文档',
      w._is_document('https://x/report.xlsx', {'content-type': 'application/octet-stream'}) is True)
check('HTML 扩展名 + text/html → 不是文档',
      w._is_document('https://x/page.html', {'content-type': 'text/html; charset=utf-8'}) is False)
check('无扩展名的 HTML → 不是文档',
      w._is_document('https://x/post', {'content-type': 'text/html'}) is False)

# ── 8. 缓存 ────────────────────────────────────────────────────────────────
print('\n=== 8. TTL/LRU 缓存 ===')
c = w.TTLCache(maxsize=2, ttl=60)
c.set('a', 1); c.set('b', 2)
check('命中', c.get('a') == 1)
# 注意：上面的 get('a') 已把 a 变成最近使用 → 这次应逐出 b（真 LRU 语义）
c.set('c', 3)
check('LRU 逐出最久未用的 b', c.get('a') == 1 and c.get('b') is None and c.get('c') == 3,
      f"a={c.get('a')} b={c.get('b')} c={c.get('c')}")
c2 = w.TTLCache(maxsize=4, ttl=0.01)
c2.set('k', 'v')
time.sleep(0.05)
check('TTL 过期生效', c2.get('k') is None)

# ── 9. CSS 结构化提取 ──────────────────────────────────────────────────────
print('\n=== 9. CSS 结构化提取 ===')
SHOP = """<html><body><div class="item"><h3 class="n">A</h3><span class="p">$1</span>
<a href="/a">link</a></div><div class="item"><h3 class="n">B</h3><span class="p">$2</span>
<a href="/b">link</a></div></body></html>"""
res = w.extract_css('https://demo.test/', {
    'name': 'items', 'baseSelector': 'div.item',
    'fields': [{'name': 'name', 'selector': 'h3.n', 'type': 'text'},
               {'name': 'price', 'selector': 'span.p', 'type': 'text'},
               {'name': 'href', 'selector': 'a', 'type': 'attr', 'attribute': 'href'},
               {'name': 'tags', 'selector': 'h3', 'type': 'list'}],
}, css_html=SHOP)
check('提取 2 行', res.get('count') == 2, str(res.get('count')))
rows = res.get('rows') or []
check('文本字段正确', rows and rows[0]['name'] == 'A' and rows[1]['price'] == '$2', str(rows))
check('attr 字段正确', rows and rows[0]['href'] == '/a', str(rows))
check('list 字段正确', rows and rows[0]['tags'] == ['A'], str(rows))
bad = w.extract_css('https://demo.test/', {'baseSelector': '@@bad@@', 'fields': []}, css_html=SHOP)
check('非法选择器返回 success=false 而非抛异常', bad.get('success') is False, str(bad))

# ── 10. URL 归一化 / 同站判定 ──────────────────────────────────────────────
print('\n=== 10. URL 归一化与同站判定 ===')
check('尾斜杠归一', w._norm_url('https://X.test/a/') == w._norm_url('https://x.test/a'),
      f"{w._norm_url('https://X.test/a/')} vs {w._norm_url('https://x.test/a')}")
check('query/fragment 剔除', w._norm_url('https://x.test/a?b=1#c') == 'https://x.test/a')
check('同站判定', w._same_site('https://x.test/a', 'https://x.test/b') is True)
check('跨站判定', w._same_site('https://x.test/a', 'https://y.test/b') is False)
check('静态资源被跳过', bool(w.SKIP_EXT.search('https://x.test/a.png')))
check('HTML 页不被跳过', not w.SKIP_EXT.search('https://x.test/a.html'))

print(f'\n=== {PASS} passed, {FAIL} failed ===')
sys.exit(0 if FAIL == 0 else 1)
