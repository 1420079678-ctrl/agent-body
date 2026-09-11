#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""webcrawl_worker_probe.py — 直接驱动 worker 做冒烟自检（不经 DSH）。

用法：
  python webcrawl_worker_probe.py            # 全量冒烟
  python webcrawl_worker_probe.py status     # 只跑某条命令
"""
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, '..', 'lib', 'webcrawl_worker.py')
WORKER = os.path.normpath(WORKER)

CASES = {
    'status': ('status', {}),
    'static': ('fetch', {'url': 'https://example.com/', 'mode': 'auto', 'max_length': 4000}),
    'js': ('fetch', {'url': 'https://quotes.toscrape.com/js/', 'mode': 'auto', 'max_length': 6000}),
    'docs': ('fetch', {'url': 'https://docs.python.org/3/library/json.html', 'mode': 'auto', 'max_length': 4000}),
    'links': ('links', {'url': 'https://quotes.toscrape.com/'}),
    'extract': ('extract', {'url': 'https://quotes.toscrape.com/',
                            'schema': {'name': 'quotes', 'baseSelector': 'div.quote',
                                       'fields': [{'name': 'quote', 'selector': 'span.text', 'type': 'text'},
                                                  {'name': 'author', 'selector': 'small.author', 'type': 'text'},
                                                  {'name': 'tags', 'selector': 'a.tag', 'type': 'list'}]}}),
    'http': ('http', {'url': 'https://httpbin.org/get', 'method': 'GET', 'timeout': 20000}),
    'map': ('map_site', {'url': 'https://quotes.toscrape.com/', 'max_pages': 3}),
    'spa': ('fetch', {'url': 'https://react.dev/', 'mode': 'auto', 'max_length': 3000}),
    'cf': ('fetch', {'url': 'https://nowsecure.nl/', 'mode': 'auto', 'max_length': 3000}),
    'doc': ('doc', {'url': 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'}),
    # ── 新增能力 ───────────────────────────────────────────────────────────
    'pdfpage': ('fetch', {'url': 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
                          'mode': 'auto', 'max_length': 2000}),
    'cache1': ('fetch', {'url': 'https://example.org/', 'mode': 'auto', 'max_length': 2000}),
    'cache2': ('fetch', {'url': 'https://example.org/', 'mode': 'auto', 'max_length': 2000}),
    'reader': ('fetch', {'url': 'https://example.com/', 'mode': 'reader', 'max_length': 1500}),
    'markdown': ('fetch', {'url': 'https://en.wikipedia.org/wiki/Web_scraping',
                           'mode': 'auto', 'max_length': 4000}),
    'deep': ('crawl_site', {'url': 'https://quotes.toscrape.com/', 'max_depth': 1,
                            'max_pages': 8, 'max_length': 1500, 'concurrency': 4}),
    'cachestat': ('cache', {}),
}


def drive(worker, conn, timeout=180):
    proc = subprocess.Popen([sys.executable, worker], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding='utf-8', errors='replace',
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    out = {}
    try:
        hello = proc.stdout.readline()
        out['hello'] = json.loads(hello) if hello else None
        i = 0
        for name, (cmd, args) in conn:
            i += 1
            proc.stdin.write(json.dumps({'id': str(i), 'cmd': cmd, 'args': args}) + '\n')
            proc.stdin.flush()
            out[name] = json.loads(proc.stdout.readline())
        proc.stdin.write(json.dumps({'id': 'bye', 'cmd': 'shutdown', 'args': {}}) + '\n')
        proc.stdin.flush()
        proc.wait(timeout=15)
    except Exception as e:
        out['_driver_error'] = f'{type(e).__name__}: {e}'
    finally:
        try:
            proc.kill()
        except Exception:
            pass
    return out


ENV_PATTERNS = ('timed out', '10060', 'URLError', 'getaddrinfo',
                'ERR_NAME_NOT_RESOLVED', 'ConnectionReset', '10054',
                'reader 引擎不可用', 'handshake operation timed out')


def is_env_failure(err: str) -> bool:
    """区分「插件缺陷」与「本机网络不可达」——后者不该算失败，但要如实标注。"""
    return any(p in err for p in ENV_PATTERNS)


def main():
    names = sys.argv[1:] or list(CASES.keys())
    conn = [(n, CASES[n]) for n in names if n in CASES]
    t0 = time.time()
    res = drive(WORKER, conn)
    print(f'worker: {WORKER}')
    h = res.get('hello') or {}
    print(f"hello: {json.dumps(h.get('data', h), ensure_ascii=False)[:300]}")
    ok = fail = skip = 0
    for name, _ in conn:
        r = res.get(name, {})
        d = r.get('data') or {}
        # 协议层 ok=True 不等于业务成功：必须看 data.success（旧探针这里出过假阳性）
        if r.get('ok') and d.get('success') is False:
            err = str(d.get('error') or '')
            if is_env_failure(err):
                skip += 1
                print(f"  [{name}] SKIP 本机网络不可达（非插件缺陷）：{err[:100]}")
                continue
            fail += 1
            print(f"  [{name}] FAIL {err[:160]}")
            continue
        if not r.get('ok'):
            err = str(r.get('error') or '')
            if is_env_failure(err):
                skip += 1
                print(f"  [{name}] SKIP 本机网络不可达（非插件缺陷）：{err[:100]}")
                continue
            fail += 1
            print(f"  [{name}] FAIL {err[:160]}")
            continue
        ok += 1
        if name in ('static', 'js', 'docs', 'spa', 'cf', 'pdfpage', 'cache1',
                    'cache2', 'reader', 'markdown'):
            tm = d.get('timings') or {}
            print(f"  [{name}] OK engine={d.get('engine')} extractor={d.get('extractor')} "
                  f"chars={d.get('chars')} cached={d.get('cached')} timings={tm} "
                  f"title={str(d.get('title'))[:38]!r}")
            if d.get('notes'):
                print(f"        notes: {d['notes']}")
            if d.get('markdown'):
                print(f"        head: {d['markdown'][:110]!r}")
        elif name == 'extract':
            print(f"  [{name}] OK count={d.get('count')} first={json.dumps((d.get('rows') or [None])[0], ensure_ascii=False)[:140]}")
        elif name == 'links':
            print(f"  [{name}] OK internal={d.get('internal')} external={d.get('external')} engine={d.get('engine')}")
        elif name in ('map', 'deep'):
            print(f"  [{name}] OK pages={d.get('pages_seen') or d.get('pages_crawled')} "
                  f"concurrency={d.get('concurrency')} {d.get('elapsed_ms')}ms")
        elif name == 'http':
            print(f"  [{name}] OK status={d.get('status')} chars={len(str(d.get('body','')))}")
        elif name in ('status', 'cachestat'):
            print(f"  [{name}] OK healthy={d.get('healthy')} stats={json.dumps(d.get('stats') or d.get('page_cache'), ensure_ascii=False)[:160]}")
        else:
            print(f"  [{name}] OK {json.dumps(d, ensure_ascii=False)[:200]}")
    if res.get('_driver_error'):
        print('driver error:', res['_driver_error'])
    total = len(conn)
    print(f'=== {ok} passed, {fail} failed, {skip} skipped (of {total}) in {time.time()-t0:.1f}s ===')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
