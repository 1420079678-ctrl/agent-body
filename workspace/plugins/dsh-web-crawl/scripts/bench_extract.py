#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Benchmark trafilatura modes: what actually costs time, and which call
produces real Markdown (headings/lists/tables) rather than plain text."""
import os, sys, time, ssl, gzip, inspect, urllib.request

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vendor'))
import trafilatura
from trafilatura import bare_extraction, extract

print('=== bare_extraction signature ===')
print(' ', inspect.signature(bare_extraction))
print('=== extract signature ===')
print(' ', inspect.signature(extract))

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36')
URL = 'https://docs.python.org/3/library/json.html'
req = urllib.request.Request(URL, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br'})
r = urllib.request.urlopen(req, timeout=40, context=ctx)
raw = r.read()
body = gzip.decompress(raw).decode('utf-8', 'replace') if 'gzip' in r.headers.get('Content-Encoding', '') else raw.decode('utf-8', 'replace')
print(f'\nhtml={len(body)}B ({URL})')

MODES = [
    ('md default',            lambda: extract(body, url=URL, output_format='markdown')),
    ('md favor_recall',       lambda: extract(body, url=URL, output_format='markdown', favor_recall=True)),
    ('txt default',           lambda: extract(body, url=URL, output_format='txt')),
    ('md no links/tables',    lambda: extract(body, url=URL, output_format='markdown', include_links=False, include_tables=False)),
    ('bare_extraction meta',  lambda: bare_extraction(body, url=URL, with_metadata=True)),
    ('bare no meta',          lambda: bare_extraction(body, url=URL, with_metadata=False)),
]

for name, fn in MODES:
    best = None
    out = None
    for _ in range(2):
        t = time.time()
        try:
            out = fn()
            dt = time.time() - t
        except Exception as e:
            print(f'{name:22} ERROR {type(e).__name__}: {e}')
            break
        best = dt if best is None else min(best, dt)
    else:
        if isinstance(out, str):
            txt = out or ''
        elif isinstance(out, dict):
            txt = out.get('text') or ''
        else:
            txt = getattr(out, 'text', '') or ''
        heads = sum(1 for l in txt.split('\n') if l.startswith('#'))
        tables = txt.count('|---') + txt.count('| ---')
        print(f'{name:22} {best:6.2f}s  len={len(txt):6d}  headings={heads:3d}  tables={tables:3d}')

print('\n=== metadata-only 成本拆解（htmldate / courlan 是否拖慢）===')
for name, fn in [
    ('extract_metadata', lambda: trafilatura.extract_metadata(body)),
]:
    t = time.time(); fn(); print(f'{name:22} {time.time()-t:6.2f}s')
