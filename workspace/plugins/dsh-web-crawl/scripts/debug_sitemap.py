#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Debug robots.txt → sitemap discovery."""
import importlib.util
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
PLUG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PLUG, 'lib', 'shims'))
sys.path.insert(0, os.path.join(PLUG, 'vendor'))

spec = importlib.util.spec_from_file_location('wcw', os.path.join(PLUG, 'lib', 'webcrawl_worker.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

for origin in ['https://www.theguardian.com', 'https://en.wikipedia.org',
               'https://httpbin.org', 'https://quotes.toscrape.com']:
    try:
        rb = w.http_get(origin + '/robots.txt', timeout=25)
        body = rb['body']
        hits = [m.group(1).strip() for m in re.finditer(r'(?im)^\s*sitemap:\s*(\S+)', body)]
        print(f'{origin}')
        print(f'   robots status={rb["status"]} len={len(body)} sitemap_lines={hits[:3]}')
        if hits:
            sm = w.http_get(hits[0], timeout=25)
            print(f'   first sitemap status={sm["status"]} len={len(sm["body"])} '
                  f'isindex={"<sitemapindex" in sm["body"][:2000].lower()} '
                  f'locs={len(re.findall(r"<loc>", sm["body"], re.I))}')
    except Exception as e:
        print(f'{origin}\n   robots FAILED {type(e).__name__}: {str(e)[:110]}')

print('\n=== discover_sitemap 汇总 ===')
for origin in ['https://www.theguardian.com', 'https://en.wikipedia.org']:
    try:
        r = w.discover_sitemap(origin, max_urls=50)
        print(f'{origin}: tried={r["sitemaps"]} urls={len(r["urls"])} sample={r["urls"][:3]}')
    except Exception as e:
        print(f'{origin}: FAILED {type(e).__name__}: {str(e)[:110]}')
