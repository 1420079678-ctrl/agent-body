#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Find out why trafilatura degrades to plain text on small pages, and which
call sequence reliably yields real Markdown."""
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
PLUG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PLUG, 'lib', 'shims'))
sys.path.insert(0, os.path.join(PLUG, 'vendor'))

import trafilatura
from markdownify import markdownify
import bs4

ARTICLE = """<html><head><title>Test Article</title></head><body><nav>menu junk</nav>
<article><h1>Main Heading</h1>
<p>First paragraph with a <a href="https://demo.test/x">link</a>.</p>
<h2>Sub Heading</h2>
<ul><li>alpha</li><li>beta</li></ul>
<table><tr><th>k</th><th>v</th></tr><tr><td>1</td><td>2</td></tr></table>
</article><footer>footer junk</footer></body></html>"""

LONG = """<html><head><title>Long</title></head><body><nav>menu junk</nav>
<article><h1>Doc Title</h1>""" + ''.join(
    f'<h2>Section {i}</h2><p>' + 'sentence here. ' * 60 + '</p>' for i in range(6)
) + """<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
</article><footer>footer junk</footer></body></html>"""

VARIANTS = [
    ('markdown 默认(带回退)', dict(output_format='markdown')),
    ('markdown no_fallback', dict(output_format='markdown', no_fallback=True)),
    ('markdown favor_recall+no_fallback', dict(output_format='markdown', no_fallback=True, favor_recall=True)),
    ('markdown favor_precision', dict(output_format='markdown', favor_precision=True)),
]

for label, html in (('SHORT synthetic', ARTICLE), ('LONG synthetic', LONG)):
    print(f'\n=== {label} ({len(html)}B) ===')
    for name, kw in VARIANTS:
        try:
            out = trafilatura.extract(html, url='https://demo.test/a', **kw)
        except Exception as e:
            out = f'<err {e}>'
        out = out or ''
        heads = out.count('\n#') + (1 if out.startswith('#') else 0)
        print(f'  {name:36} len={len(out):5d} heads={heads} junk={"menu junk" in out} '
              f'head={out[:70]!r}')

    # markdownify 路线（bs4 剪枝后）
    soup = bs4.BeautifulSoup(html, 'lxml')
    for bad in soup(['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'form']):
        bad.decompose()
    md = markdownify(str(soup), heading_style='ATX', strip=['a'] if False else None)
    md = re.sub(r'\n{3,}', '\n\n', md).strip()
    heads = md.count('\n#') + (1 if md.startswith('#') else 0)
    print(f'  {"bs4 剪枝 + markdownify":36} len={len(md):5d} heads={heads} junk={"menu junk" in md} '
          f'head={md[:70]!r}')
