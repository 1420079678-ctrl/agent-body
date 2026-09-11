#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Profile the static fetch path: network vs extraction time."""
import os, sys, time, ssl, gzip, urllib.request

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vendor'))
import trafilatura

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36')

URLS = [
    'https://docs.python.org/3/library/json.html',
    'https://docs.python.org/3/library/json.html',
    'https://en.wikipedia.org/wiki/Web_scraping',
    'https://news.ycombinator.com/',
]

for i, url in enumerate(URLS):
    t = time.time()
    req = urllib.request.Request(url, headers={'User-Agent': UA,
                                              'Accept-Encoding': 'gzip, deflate, br'})
    r = urllib.request.urlopen(req, timeout=40, context=ctx)
    raw = r.read()
    t_net = time.time() - t
    enc = r.headers.get('Content-Encoding', '')
    body = gzip.decompress(raw) if 'gzip' in enc else raw
    body = body.decode('utf-8', 'replace')
    t2 = time.time()
    doc = trafilatura.bare_extraction(body, url=url, with_metadata=True,
                                      include_links=True, include_tables=True)
    t_ext = time.time() - t2
    text = (doc.get('text') if isinstance(doc, dict) else getattr(doc, 'text', '')) or ''
    print(f'[{i}] net={t_net:6.2f}s extract={t_ext:6.2f}s html={len(body):7d}B '
          f'text={len(text):6d} {url}')
