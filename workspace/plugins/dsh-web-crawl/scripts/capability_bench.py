#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capability_bench.py — 新旧能力对照实测。

三条纪律（第一版基准就是因为违反它们才得出假数字）：
  1. **关缓存**：A/B 对照必须 cache=False，否则第二次跑全命中缓存，测出来的是缓存不是并发。
  2. **取最小值**：本机外网抖动大（DNS/握手偶发超时），每组重复测并取 min，不用单次值。
  3. **同进程对比**：对照项在同一个 worker 里连续跑，排除冷启动漂移。
"""
import importlib.util
import json
import os
import statistics
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
PLUG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(PLUG, 'lib', 'webcrawl_worker.py')


class Worker:
    def __init__(self):
        self.p = subprocess.Popen([sys.executable, WORKER], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, encoding='utf-8', errors='replace',
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.p.stdout.readline()
        self.n = 0

    def call(self, cmd, args):
        self.n += 1
        t = time.time()
        self.p.stdin.write(json.dumps({'id': str(self.n), 'cmd': cmd, 'args': args}) + '\n')
        self.p.stdin.flush()
        d = json.loads(self.p.stdout.readline())
        return d.get('data') or {}, time.time() - t, d.get('ok')

    def best(self, cmd, args, n=3):
        """跑 n 次取最小耗时与对应结果（缓存关闭，避免自污染）。"""
        times, data = [], {}
        for _ in range(n):
            data, w, ok = self.call(cmd, args)
            times.append(w)
        return min(times), data, times

    def close(self):
        try:
            self.p.kill()
        except Exception:
            pass


def fmt(ms):
    return f'{ms*1000:8.0f} ms'


print('=' * 80)
print('A. 正文抽取：快路径 vs 慢路径（同一 HTML，纯 CPU，与网络无关）')
print('=' * 80)
sys.path.insert(0, os.path.join(PLUG, 'lib', 'shims'))
sys.path.insert(0, os.path.join(PLUG, 'vendor'))
import trafilatura


def best_of(fn, n=5):
    ts = []
    for _ in range(n):
        t = time.time()
        fn()
        ts.append(time.time() - t)
    return min(ts)


def page(n_sec, with_dates):
    meta = ('<meta property="article:published_time" content="2026-01-02T03:04:05Z">'
            '<meta name="author" content="Jane"><meta name="description" content="d">'
            ) if with_dates else ''
    return ('<html><head><title>Big</title>' + meta + '</head><body><article>'
            + ''.join(f'<h2>Sec {i}</h2><p>' + 'lorem ipsum dolor sit amet. ' * 40 + '</p>'
                      for i in range(n_sec))
            + '</article></body></html>')


for label, html in (('合成页 120 节（无日期元数据）', page(120, False)),
                    ('合成页 120 节（带日期/作者元数据）', page(120, True))):
    tf = best_of(lambda: trafilatura.extract(html, url='https://d.test/b', output_format='markdown'))
    ts = best_of(lambda: trafilatura.bare_extraction(html, url='https://d.test/b', with_metadata=True))
    tm = best_of(lambda: trafilatura.extract_metadata(html, default_url='https://d.test/b'))
    fast = trafilatura.extract(html, output_format='markdown') or ''
    doc = trafilatura.bare_extraction(html, url='https://d.test/b', with_metadata=True)
    slow = (doc.get('text') if isinstance(doc, dict) else getattr(doc, 'text', '')) or ''
    print(f'\n  {label}  (html={len(html)//1024}KB)')
    print(f'    extract(output_format=markdown)  {fmt(tf)}   ← 现在的主路径')
    print(f'    bare_extraction(with_metadata)   {fmt(ts)}   ← 我第一版用的路径  {ts/tf:.1f}x')
    print(f'    extract_metadata()               {fmt(tm)}   {tm/tf:.1f}x')
    print(f'    Markdown 标题数：主路径 {fast.count(chr(10)+"##")}   旧路径 {slow.count(chr(10)+"##")}')

print()
print('=' * 80)
print('B. 深爬并行度（cache=False，min of 3，同站点同页数）')
print('=' * 80)
w = Worker()
res = {}
for conc in (1, 4, 8):
    t, d, times = w.best('crawl_site', {'url': 'https://quotes.toscrape.com/', 'max_depth': 2,
                                        'max_pages': 12, 'max_length': 1200,
                                        'concurrency': conc, 'cache': False}, n=3)
    res[conc] = (t, d, times)
base = res[1][0]
for conc in (1, 4, 8):
    t, d, times = res[conc]
    print(f'  concurrency={conc}   {fmt(t)}   pages={d.get("pages_crawled")} '
          f' 加速 {base/t:.2f}x   (3 次: {[round(x,2) for x in times]})')
w.close()

print()
print('=' * 80)
print('C. 静态 vs 浏览器（cache=False，min of 3）')
print('=' * 80)
w = Worker()
for label, args in (
        ('example.com auto（判为静态）', {'url': 'https://example.com/', 'mode': 'auto', 'cache': False}),
        ('example.com 强制静态',        {'url': 'https://example.com/', 'mode': 'static', 'cache': False}),
        ('example.com 强制浏览器',      {'url': 'https://example.com/', 'mode': 'browser', 'cache': False}),
        ('JS 页 auto（自动升级）',      {'url': 'https://quotes.toscrape.com/js/', 'mode': 'auto', 'cache': False})):
    t, d, times = w.best('fetch', args, n=3)
    print(f'  {label:32} {fmt(t)}  engine={str(d.get("engine")):20} chars={d.get("chars")} '
          f'(3 次: {[round(x,2) for x in times]})')
w.close()

print()
print('=' * 80)
print('D. 结果缓存（同一 URL 连续两次，缓存键不含 use_cache）')
print('=' * 80)
w = Worker()
d1, t1, _ = w.call('fetch', {'url': 'https://example.org/', 'cache': True})
d2, t2, _ = w.call('fetch', {'url': 'https://example.org/', 'cache': True})
d3, t3, _ = w.call('fetch', {'url': 'https://example.org/', 'cache': True})
print(f'  第 1 次（冷）   {fmt(t1)}  cached={d1.get("cached")}')
print(f'  第 2 次         {fmt(t2)}  cached={d2.get("cached")}')
print(f'  第 3 次         {fmt(t3)}  cached={d3.get("cached")}')
if t2 < t1:
    print(f'  → 缓存命中加速 {t1/max(t2, 1e-4):.0f}x')
else:
    print('  → 未命中：首个请求已失败或网络抖动，加速不可测')
# 反证：cache=False 时不该命中
d4, t4, _ = w.call('fetch', {'url': 'https://example.org/', 'cache': False})
print(f'  关缓存重申     {fmt(t4)}  cached={d4.get("cached")}  '
      f'（应为 False，证明缓存键生效而非误命中）')
w.close()
