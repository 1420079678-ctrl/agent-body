#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""webcrawl_worker.py — 2026 多引擎网页抓取 worker（dsh-web-crawl 的执行层）。

设计：一个常驻进程、行协议 JSON-RPC over stdio，Node 侧负责生命周期，本文件
负责真正的抓取。核心是**引擎级联**，而不是单一引擎：

    L0 static   urllib + 浏览器级请求头（最快，覆盖 ~70% 站点）
    L1 render   Patchright（打过补丁的 Playwright，去掉自动化指纹）+ 本机 Chrome
    L2 reader   Jina Reader（r.jina.ai，托管 SOTA reader；反爬兜底，可选）

正文抽取用 trafilatura（2026 年标杆级 boilerplate 去除，评测优于
readability / justext），失败时降级 justext 做 rescue。结构化提取用
BeautifulSoup CSS（纯本地、零模型调用），文档解析用 markitdown。

协议（每行一个 JSON）：
    请求  {"id": "1", "cmd": "fetch", "args": {...}}
    响应  {"id": "1", "ok": true, "data": {...}}
    响应  {"id": "1", "ok": false, "error": "..."}
    握手  {"id": null, "ok": true, "data": {"hello": true, ...}}
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
import ssl
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor

# ── 协议通道必须是干净 UTF-8（Windows 管道默认 GBK 是中文乱码根因）─────────
sys.stdin.reconfigure(encoding='utf-8', errors='replace')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ── 静默第三方库日志：stdout 只允许出现协议行 ──────────────────────────────
import logging
logging.disable(logging.CRITICAL)
for _name in ('trafilatura', 'htmldate', 'courlan', 'justext', 'dateparser',
              'urllib3', 'charset_normalizer', 'markitdown', 'magika', 'asyncio'):
    logging.getLogger(_name).setLevel(logging.CRITICAL)

import warnings
warnings.filterwarnings('ignore')

# ── 供应目录（trafilatura / markitdown / bs4 等，pip 装不进来时用的本地 wheel）──
_HERE = os.path.dirname(os.path.abspath(__file__))
_VENDOR_CANDIDATES = [
    os.environ.get('DSH_WEBCRAWL_LIBS', ''),
    os.path.join(_HERE, 'vendor'),
    os.path.join(os.path.dirname(_HERE), 'vendor'),
    r'<DSH_CHECKOUT>\workspace\pyenvs\libs',
]
for _v in _VENDOR_CANDIDATES:
    if _v and os.path.isdir(_v) and _v not in sys.path:
        sys.path.insert(0, _v)

# 替身目录必须排在 vendor 之前：用它顶掉 markitdown 的真 magika（连带 40MB onnxruntime）。
_SHIMS = os.path.join(_HERE, 'shims')
if os.path.isdir(_SHIMS):
    sys.path.insert(0, _SHIMS)

BROWSER_CHANNEL = os.environ.get('DSH_WEBCRAWL_CHANNEL', 'chrome')
DEFAULT_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
)
READER_ENDPOINT = os.environ.get('DSH_WEBCRAWL_READER', '')

# ── 依赖探测（缺失不致命：逐能力降级，status 命令如实报告）────────────────
def _try_import(mod: str):
    try:
        return __import__(mod)
    except Exception:
        return None


trafilatura = _try_import('trafilatura')
justext = _try_import('justext')
bs4 = _try_import('bs4')
markitdown_mod = _try_import('markitdown')
patchright = _try_import('patchright')
playwright_mod = None if patchright else _try_import('playwright')
try:
    from markdownify import markdownify  # HTML → Markdown 兜底（trafilatura 退化时）
except Exception:
    markdownify = None

STATS = {'requests': 0, 'static': 0, 'render': 0, 'reader': 0, 'trafilatura': 0,
         'justext': 0, 'errors': 0, 'browser_recycles': 0, 'cache_hits': 0}


class ToolError(RuntimeError):
    pass


# ══════════════════════════════════════════════════════════════════════════
# L0：静态抓取（浏览器级请求头；gzip/br/deflate 自动解压）
# ══════════════════════════════════════════════════════════════════════════

def _decompress(body: bytes, enc: str) -> bytes:
    enc = (enc or '').lower()
    try:
        if 'br' in enc:
            try:
                import brotli  # type: ignore
                return brotli.decompress(body)
            except Exception:
                return body
        if 'gzip' in enc:
            return gzip.decompress(body)
        if 'deflate' in enc:
            return zlib.decompress(body, -zlib.MAX_WBITS)
    except Exception:
        return body
    return body


def http_get(url: str, timeout: int = 25, headers: dict | None = None,
             user_agent: str = DEFAULT_UA, proxy: str = '') -> dict:
    """L0 静态抓取。返回 {status, headers, body(text), final_url, elapsed_ms}。"""
    h = {
        'User-Agent': user_agent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
    }
    h.update(headers or {})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    handlers = [urllib.request.HTTPSHandler(context=ctx)]
    if proxy:
        handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers=h, method='GET')
    t0 = time.time()
    try:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read()
            body = _decompress(raw, r.headers.get('Content-Encoding', ''))
            charset = r.headers.get_content_charset()
            if not charset:
                m = re.search(rb'charset=["\']?([\w-]+)', body[:4096], re.I)
                charset = m.group(1).decode('ascii', 'replace') if m else 'utf-8'
            try:
                text = body.decode(charset, 'replace')
            except LookupError:
                text = body.decode('utf-8', 'replace')
            return {'status': r.status, 'headers': dict(r.headers), 'body': text,
                    '_raw': body, 'final_url': r.url,
                    'elapsed_ms': int((time.time() - t0) * 1000)}
    except urllib.error.HTTPError as e:
        raw = e.read()
        body = _decompress(raw, e.headers.get('Content-Encoding', '') if e.headers else '')
        return {'status': e.code, 'headers': dict(e.headers or {}), '_raw': body,
                'body': body.decode('utf-8', 'replace'), 'final_url': url,
                'elapsed_ms': int((time.time() - t0) * 1000)}
    except Exception as e:
        raise ToolError(f'static fetch failed: {type(e).__name__}: {e}') from e


# ══════════════════════════════════════════════════════════════════════════
# L1：浏览器渲染（Patchright 优先 → 原版 Playwright 兜底）
# ══════════════════════════════════════════════════════════════════════════

class BrowserPool:
    """常驻浏览器：跨请求复用，冷启动只付一次；崩溃后下次调用自动重建。"""

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._engine = ''
        self._lock_depth = 0

    def engine(self) -> str:
        if patchright:
            return 'patchright'
        if playwright_mod:
            return 'playwright'
        return ''

    def _ensure(self, proxy: str = ''):
        if self._browser is not None:
            return self._browser
        mod = patchright or playwright_mod
        if mod is None:
            raise ToolError('no browser engine available (install patchright or playwright)')
        from importlib import import_module
        sync_playwright = import_module(f'{mod.__name__}.sync_api').sync_playwright
        self._pw = sync_playwright().start()
        launch_args = ['--disable-dev-shm-usage', '--no-first-run',
                       '--no-default-browser-check', '--disable-features=Translate']
        kwargs = {'headless': True, 'args': launch_args}
        if proxy:
            kwargs['proxy'] = {'server': proxy}
        if BROWSER_CHANNEL:
            kwargs['channel'] = BROWSER_CHANNEL
        try:
            self._browser = self._pw.chromium.launch(**kwargs)
        except Exception:
            # 本机没有对应 channel 的 Chrome 时退回 Playwright 自带 chromium
            kwargs.pop('channel', None)
            self._browser = self._pw.chromium.launch(**kwargs)
        self._engine = mod.__name__.split('.')[0]
        return self._browser

    def render(self, url: str, *, user_agent: str = DEFAULT_UA, timeout_ms: int = 45000,
               wait_for_ms: int = 0, wait_for_selector: str = '', js_code: str = '',
               proxy: str = '', block_images: bool = False) -> dict:
        browser = self._ensure(proxy)
        ctx = browser.new_context(
            user_agent=user_agent,
            locale='en-US',
            timezone_id='America/New_York',
            viewport={'width': 1440, 'height': 900},
            ignore_https_errors=True,
        )
        try:
            if block_images:
                ctx.route(re.compile(r'\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4)(\?|$)'),
                          lambda route: route.abort())
            page = ctx.new_page()
            page.set_default_timeout(timeout_ms)
            resp = page.goto(url, wait_until='domcontentloaded', timeout=timeout_ms)
            try:
                page.wait_for_load_state('networkidle', timeout=min(8000, timeout_ms))
            except Exception:
                pass
            if wait_for_selector:
                try:
                    page.wait_for_selector(wait_for_selector, timeout=min(15000, timeout_ms))
                except Exception:
                    pass
            if wait_for_ms:
                page.wait_for_timeout(min(wait_for_ms, 60000))
            js_result = None
            if js_code:
                try:
                    js_result = page.evaluate(js_code)
                except Exception as e:
                    js_result = f'<js_code error: {type(e).__name__}: {e}>'
            html = page.content()
            try:
                title = page.title()
            except Exception:
                title = ''
            return {'html': html, 'title': title, 'status': resp.status if resp else 0,
                    'final_url': page.url, 'js_result': js_result,
                    'has_cf_challenge': _looks_like_challenge(html)}
        finally:
            try:
                ctx.close()
            except Exception:
                pass

    def request(self, url: str, method: str = 'GET', headers: dict | None = None,
                body: str | None = None, timeout_ms: int = 30000) -> dict:
        """浏览器网络栈裸请求：忽略 TLS 证书错误，携带完整浏览器指纹。"""
        browser = self._ensure()
        ctx = browser.new_context(ignore_https_errors=True)
        try:
            opts = {'method': method.upper(), 'headers': headers or {}, 'timeout': timeout_ms,
                    'ignore_https_errors': True}
            if body is not None:
                opts['data'] = body
            r = ctx.request.fetch(url, **opts)
            raw = r.body()
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                text = raw.decode('latin-1', 'replace')
            return {'status': r.status, 'headers': dict(r.headers), 'body': text,
                    'final_url': r.url}
        finally:
            try:
                ctx.close()
            except Exception:
                pass

    def close(self) -> None:
        for obj, meth in ((self._browser, 'close'), (self._pw, 'stop')):
            if obj is not None:
                try:
                    getattr(obj, meth)()
                except Exception:
                    pass
        self._browser = None
        self._pw = None


BROWSER = BrowserPool()


def _looks_like_challenge(html: str) -> bool:
    low = html[:6000].lower()
    return any(s in low for s in (
        'cf-challenge', 'challenge-platform', 'just a moment',
        'enable javascript and cookies to continue', 'datadome',
        'cf_chl_opt', 'turnstile',
    ))


# ══════════════════════════════════════════════════════════════════════════
# 正文抽取：trafilatura 为主，justext 兜底
# ══════════════════════════════════════════════════════════════════════════

_MD_STRUCT = re.compile(r'(?m)^#{1,6}\s+\S|\|\s*-{3,}|^\s*[-*+]\s+\S|\]\(|\*\*\S')
_JUNK_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer',
              'header', 'aside', 'form', 'iframe', 'button']


def _has_md_structure(text: str) -> bool:
    """输出里有没有真正的 Markdown 结构（标题/表格/列表/链接/粗体）。

    用来识破 trafilatura 的退化：短页面上它会放弃正文识别、回退成整页纯文本，
    结果既没有格式也带着 nav/footer 杂质。
    """
    return bool(text) and bool(_MD_STRUCT.search(text[:20000]))


def _bs4_markdown(html: str) -> str:
    """bs4 剪枝 + markdownify → 真 Markdown。trafilatura 退化时的确定性兜底。"""
    if not bs4 or markdownify is None:
        return ''
    try:
        soup = bs4.BeautifulSoup(html, 'lxml')
        for bad in soup(_JUNK_TAGS):
            bad.decompose()
        # 常见噪音容器：按 class/id 关键词剔除
        for el in soup.find_all(attrs={'class': re.compile(
                r'(nav|menu|sidebar|footer|header|comment|social|share|cookie|banner|advert)',
                re.I)}):
            el.decompose()
        root = soup.body or soup
        md = markdownify(str(root), heading_style='ATX', bullets='-')
        return _clean_markdown(md)
    except Exception:
        return ''


def extract_html(html: str, url: str = '', *, output: str = 'markdown',
                 include_links: bool = True, include_tables: bool = True,
                 include_images: bool = False, favor_recall: bool = True,
                 css_selector: str = '', full_metadata: bool = False) -> dict:
    """返回 {text, engine, title, author, date, sitename, description}。

    性能：走 `extract(output_format='markdown')` 快路径（10 万字符 HTML 约 0.1s）。
    **不要**用 `bare_extraction()` / `extract_metadata()` 做主路径——实测同一页面
    bare_extraction 需 6.7–9s、extract_metadata 需 12s，且产出的是纯文本不是 Markdown。

    质量：trafilatura 在**短页面**上会放弃正文识别并回退成整页纯文本（带 nav/footer
    杂质、无任何 Markdown 格式）。因此这里按「谁真的产出了 Markdown 结构」优先级挑选：
    recall → precision → bs4+markdownify → justext → 纯文本。
    """
    if css_selector and bs4:
        try:
            soup = bs4.BeautifulSoup(html, 'lxml')
            picked = soup.select(css_selector)
            if picked:
                html = ''.join(str(x) for x in picked)
        except Exception:
            pass

    meta: dict = {}
    text = ''
    engine = ''
    kw = dict(output_format=output, include_links=include_links,
              include_tables=include_tables, include_images=include_images)

    recall = ''
    precision = ''
    md_alt = ''
    jx = ''

    if trafilatura:
        try:
            recall = trafilatura.extract(html, url=url or None, favor_recall=True, **kw) or ''
        except Exception:
            recall = ''
        if not _has_md_structure(recall):
            try:
                precision = trafilatura.extract(html, url=url or None, favor_precision=True,
                                                **kw) or ''
            except Exception:
                precision = ''

    if not _has_md_structure(recall) and not _has_md_structure(precision):
        md_alt = _bs4_markdown(html)

    if not recall and not precision and not md_alt and justext:
        try:
            parts = justext.justext(html.encode('utf-8', 'replace'),
                                    justext.get_stoplist('English'))
            kept = [p.text for p in parts if not p.is_boilerplate]
            if kept:
                jx = '\n\n'.join(kept)
        except Exception:
            jx = ''

    # 定序挑选：有 Markdown 结构者优先，同结构按 recall → precision → markdownify
    for name, cand in (('trafilatura', recall), ('trafilatura-precision', precision),
                       ('markdownify', md_alt)):
        if cand and _has_md_structure(cand):
            text, engine = cand, name
            break
    if not text:
        for name, cand in (('trafilatura', recall), ('trafilatura-precision', precision),
                           ('markdownify', md_alt), ('justext', jx)):
            if cand:
                text, engine = cand, name
                break

    if not text and bs4:
        try:
            soup = bs4.BeautifulSoup(html, 'lxml')
            for bad in soup(_JUNK_TAGS):
                bad.decompose()
            text = soup.get_text('\n')
            engine = 'bs4-fallback'
        except Exception:
            text = ''

    text = _clean_markdown(text)
    meta = _fast_metadata(html, url)

    if full_metadata and trafilatura:
        # 显式慢路径：完整 trafilatura 元数据（含日期解析），单页可达数秒。
        try:
            doc = trafilatura.extract_metadata(html, default_url=url or None)
            if doc is not None:
                for key in ('title', 'author', 'date', 'sitename', 'description',
                            'categories', 'tags'):
                    val = getattr(doc, key, None)
                    if val and not meta.get(key):
                        meta[key] = val if isinstance(val, str) else str(val)
        except Exception:
            pass

    return {'text': text, 'engine': engine, **meta}


_META_KEYS = (
    ('og:title', 'title'), ('twitter:title', 'title'),
    ('og:site_name', 'sitename'), ('og:description', 'description'),
    ('description', 'description'), ('author', 'author'),
    ('article:published_time', 'date'), ('og:updated_time', 'date'),
    ('date', 'date'), ('pubdate', 'date'), ('og:type', 'og_type'),
)


def _fast_metadata(html: str, url: str = '') -> dict:
    """bs4 从 meta 标签直读元数据（毫秒级），替代 trafilatura 的秒级元数据路径。"""
    out: dict = {}
    if not bs4 or not html:
        return out
    try:
        head = html[:400000]
        soup = bs4.BeautifulSoup(head, 'lxml')
        for prop, key in _META_KEYS:
            if out.get(key):
                continue
            tag = (soup.find('meta', attrs={'property': prop})
                   or soup.find('meta', attrs={'name': prop})
                   or soup.find('meta', attrs={'itemprop': prop}))
            if tag and tag.get('content'):
                out[key] = tag['content'].strip()[:500]
        for key, tag_name in (('title', 'title'),):
            if not out.get(key):
                t = soup.find(tag_name)
                if t and t.string:
                    out[key] = t.string.strip()[:300]
        if not out.get('sitename') and url:
            out['sitename'] = urllib.parse.urlsplit(url).netloc
    except Exception:
        pass
    return out


def _clean_markdown(text: str) -> str:
    if not text:
        return ''
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{4,}', '\n\n\n', text)
    text = re.sub(r'!\[[^\]]*\]\((?:data:|javascript:)[^)]*\)', '', text)
    return text.strip()


def count_links(html: str, base_url: str) -> dict:
    out = {'internal': 0, 'external': 0, 'links': []}
    if not bs4:
        return out
    try:
        soup = bs4.BeautifulSoup(html, 'lxml')
        host = urllib.parse.urlsplit(base_url).netloc
        seen = set()
        for a in soup.find_all('a', href=True):
            href = urllib.parse.urljoin(base_url, a['href'].strip())
            if not href.lower().startswith(('http://', 'https://')):
                continue
            href = href.split('#')[0]
            if href in seen:
                continue
            seen.add(href)
            kind = 'internal' if urllib.parse.urlsplit(href).netloc == host else 'external'
            out[kind] += 1
            if len(out['links']) < 400:
                out['links'].append({'href': href, 'text': (a.get_text() or '').strip()[:120],
                                     'kind': kind})
    except Exception:
        pass
    return out


# ══════════════════════════════════════════════════════════════════════════
# L2：Jina Reader 托管兜底（反爬极硬时的最后一条路）
# ══════════════════════════════════════════════════════════════════════════

def reader_fetch(url: str, timeout: int = 40) -> dict:
    endpoint = READER_ENDPOINT or 'https://r.jina.ai/'
    target = endpoint.rstrip('/') + '/' + url
    r = http_get(target, timeout=timeout, headers={'Accept': 'text/plain'})
    if r['status'] != 200:
        raise ToolError(f'reader returned HTTP {r["status"]}')
    STATS['reader'] += 1
    body = r['body']
    title = ''
    m = re.match(r'Title:\s*(.+)', body)
    if m:
        title = m.group(1).strip()
    return {'text': body, 'title': title, 'engine': 'jina-reader', 'status': 200}


class _ReaderGate:
    """reader 熔断器。

    r.jina.ai 在部分网络（含本机）不可达；若每次都白等 20s 超时，auto 模式会被拖死。
    连续失败 2 次即熔断，冷却期后只放一个探测请求试放。status 会如实报告状态。
    """

    def __init__(self, threshold: int = 2, cooldown_s: float = 600.0) -> None:
        self.threshold = threshold
        self.cooldown_s = cooldown_s
        self.failures = 0
        self.disabled_until = 0.0
        self.last_error = ''

    def available(self) -> bool:
        return time.time() >= self.disabled_until

    def ok(self) -> None:
        self.failures = 0
        self.disabled_until = 0.0
        self.last_error = ''

    def fail(self, err: str) -> None:
        self.failures += 1
        self.last_error = err[:200]
        if self.failures >= self.threshold:
            self.disabled_until = time.time() + self.cooldown_s

    def state(self) -> dict:
        left = max(0, int(self.disabled_until - time.time()))
        return {'available': self.available(), 'failures': self.failures,
                'cooldown_left_s': left, 'last_error': self.last_error}


READER_GATE = _ReaderGate()


# ══════════════════════════════════════════════════════════════════════════
# 引擎级联
# ══════════════════════════════════════════════════════════════════════════

def looks_js_gated(html: str) -> bool:
    """静态 HTML 是否「JS 空壳」——决定是否值得升级到浏览器渲染。

    关键：短 ≠ 空壳。example.com 只有 110 字符正文但它是完整静态页，不该渲染；
    真正的空壳是「正文极少 + 外壳很大（JS bundle 撑起来的）」或明确的框架挂载点。
    """
    if not html:
        return True
    if _looks_like_challenge(html):
        return True
    low = html.lower()
    if 'enable javascript' in low or 'requires javascript' in low:
        return True
    if not bs4:
        return False
    try:
        soup = bs4.BeautifulSoup(html, 'lxml')
        html_len = len(html)
        roots = soup.find_all(id=re.compile(r'^(root|app|__next|__nuxt|__app|q-app)$'))
        # 内联脚本体积占比：JS 撑起来的页面，正文少但脚本极大
        script_bytes = sum(len(s.string or '') for s in soup.find_all('script'))
        js_ratio = script_bytes / max(1, html_len)
        for bad in soup(['script', 'style', 'noscript', 'template', 'svg']):
            bad.decompose()
        visible = re.sub(r'\s+', ' ', soup.get_text(' ')).strip()
        n_visible = len(visible)
        # 明确框架挂载点 + 内容还没渲染出来
        if roots and n_visible < 2000:
            return True
        # 正文极少 + 脚本占比高 → 数据在 JS 里，必须渲染
        if n_visible < 300 and js_ratio > 0.25:
            return True
        # 空壳：正文极少，HTML 却很大（体积全在 JS/JSON 里）
        if n_visible < 200 and html_len > 8000:
            return True
        # 有页面骨架就别渲染了
        if n_visible < 200 and soup.find(['p', 'article', 'h1', 'h2', 'li', 'td', 'pre']):
            return False
    except Exception:
        pass
    return False


class TTLCache:
    """请求级 LRU+TTL 缓存。同一会话里反复抓同一 URL（判定→再抓→深爬）命中即秒回。"""

    def __init__(self, maxsize: int = 64, ttl: float = 300.0) -> None:
        self.maxsize = maxsize
        self.ttl = ttl
        self._d: dict = {}

    def get(self, key):
        item = self._d.get(key)
        if not item:
            return None
        ts, val = item
        if time.time() - ts > self.ttl:
            self._d.pop(key, None)
            return None
        self._d.pop(key, None)
        self._d[key] = (ts, val)  # touch：LRU 顺序
        return val

    def set(self, key, val) -> None:
        self._d.pop(key, None)
        self._d[key] = (time.time(), val)
        while len(self._d) > self.maxsize:
            self._d.pop(next(iter(self._d)))

    def clear(self) -> None:
        self._d.clear()

    def stats(self) -> dict:
        return {'entries': len(self._d), 'maxsize': self.maxsize, 'ttl_s': self.ttl}


_PAGE_CACHE = TTLCache(maxsize=64, ttl=300.0)

DOC_EXT = re.compile(r'\.(pdf|docx?|xlsx?|pptx?|epub|csv|rtf|odt|ods|odp)$', re.I)
DOC_MIME = re.compile(
    r'(application/(pdf|msword|vnd\.openxmlformats-officedocument\.\w+\.\w+\+xml|'
    r'vnd\.ms-excel|vnd\.ms-powerpoint|epub\+zip)|text/csv)', re.I)

READER_DEFAULT = os.environ.get('DSH_WEBCRAWL_READER_AUTO', '') == '1'


def _is_document(url: str, headers: dict) -> bool:
    ctype = ''
    for k, v in (headers or {}).items():
        if k.lower() == 'content-type':
            ctype = str(v)
            break
    if DOC_MIME.search(ctype):
        return True
    return bool(DOC_EXT.search(urllib.parse.urlsplit(url).path)) and not ctype.startswith('text/html')


def fetch_page(url: str, *, mode: str = 'auto', max_length: int = 60000,
               css_selector: str = '', user_agent: str = DEFAULT_UA, proxy: str = '',
               wait_for_ms: int = 0, wait_for_selector: str = '', js_code: str = '',
               include_links: bool = True, include_tables: bool = True,
               include_images: bool = False, timeout_ms: int = 45000,
               allow_reader: bool | None = None, full_metadata: bool = False,
               use_cache: bool = True, retries: int = 1) -> dict:
    """多引擎级联抓取单页。mode: auto（默认，按需升级）/ static / browser / reader。"""
    STATS['requests'] += 1
    t0 = time.time()
    reader_ok = READER_DEFAULT if allow_reader is None else allow_reader
    key = (url, mode, css_selector, include_links, include_tables, include_images,
           js_code, wait_for_ms, wait_for_selector, full_metadata)
    if use_cache:
        hit = _PAGE_CACHE.get(key)
        if hit is not None:
            STATS['cache_hits'] += 1
            out = dict(hit)
            out['cached'] = True
            out['timings'] = dict(hit.get('timings') or {})
            out['timings']['total_ms'] = int((time.time() - t0) * 1000)
            return out

    notes: list[str] = []
    last_err = ''
    timings: dict = {}

    # L0 静态
    if mode in ('auto', 'static'):
        attempt = 0
        while True:
            try:
                t = time.time()
                r = http_get(url, timeout=max(5, timeout_ms // 1000),
                             user_agent=user_agent, proxy=proxy)
                # 累加而非覆盖：重试过的请求要把失败那次的耗时也算进 timings，数字才诚实
                timings['network_ms'] = timings.get('network_ms', 0) + int((time.time() - t) * 1000)
                STATS['static'] += 1
                break
            except ToolError as e:
                attempt += 1
                timings['network_ms'] = timings.get('network_ms', 0) + int((time.time() - t) * 1000)
                if attempt > retries:
                    last_err = str(e)
                    notes.append(f'static 失败（{attempt} 次）：{e}')
                    r = None
                    break
                notes.append(f'static 第 {attempt} 次失败，重试：{str(e)[:120]}')
        timings['static_attempts'] = attempt + (1 if r is not None else 0)
        if r is not None:
            # 静态响应其实是文档（PDF/XLSX/…）→ 直接走文档转换，别当网页抽正文
            if _is_document(r['final_url'], r['headers']):
                try:
                    t = time.time()
                    ctype = ''
                    for k, v in (r['headers'] or {}).items():
                        if k.lower() == 'content-type':
                            ctype = str(v)
                            break
                    d = doc_to_markdown_bytes(r.get('_raw') or b'', r['final_url'],
                                              content_type=ctype)
                    timings['doc_ms'] = int((time.time() - t) * 1000)
                    if d.get('success') and d.get('chars'):
                        ex = {'text': d['markdown'], 'engine': 'markitdown',
                              'title': d.get('title', '')}
                        notes.append('static: 响应为文档，已按 markitdown 转换')
                        out = _pack(url, r['final_url'], r['status'], ex, '', max_length,
                                    'static+doc', notes, t0, timings)
                        if use_cache:
                            _PAGE_CACHE.set(key, out)
                        return out
                except Exception as e:
                    notes.append(f'文档转换失败：{e}')

            t = time.time()
            ex = extract_html(r['body'], r['final_url'], include_links=include_links,
                              include_tables=include_tables, include_images=include_images,
                              css_selector=css_selector, full_metadata=full_metadata)
            timings['extract_ms'] = int((time.time() - t) * 1000)
            need_js = mode == 'auto' and (
                looks_js_gated(r['body'])
                or (len(ex['text']) < 200 and len(r['body']) > 8000)
            )
            if not need_js and r['status'] < 400 and ex['text']:
                out = _pack(url, r['final_url'], r['status'], ex, r['body'], max_length,
                            'static', notes, t0, timings)
                if use_cache:
                    _PAGE_CACHE.set(key, out)
                return out
            if mode == 'static':
                out = _pack(url, r['final_url'], r['status'], ex, r['body'], max_length,
                            'static', notes, t0, timings)
                if use_cache:
                    _PAGE_CACHE.set(key, out)
                return out
            notes.append('static: JS 空壳或正文为空，升级浏览器渲染' if need_js
                         else f'static: HTTP {r["status"]}')

    # L1 浏览器渲染
    if mode in ('auto', 'browser'):
        try:
            t = time.time()
            rr = BROWSER.render(url, user_agent=user_agent, timeout_ms=timeout_ms,
                                wait_for_ms=wait_for_ms, wait_for_selector=wait_for_selector,
                                js_code=js_code, proxy=proxy, block_images=not include_images)
            timings['render_ms'] = int((time.time() - t) * 1000)
            STATS['render'] += 1
            t = time.time()
            ex = extract_html(rr['html'], rr['final_url'], include_links=include_links,
                              include_tables=include_tables, include_images=include_images,
                              css_selector=css_selector, full_metadata=full_metadata)
            timings['extract_ms'] = int((time.time() - t) * 1000)
            if rr.get('has_cf_challenge'):
                notes.append('browser: 检测到 Cloudflare/DataDome 挑战页')
            if rr.get('js_result') is not None:
                ex['text'] = (ex['text'] + '\n\n[JS]\n' + str(rr['js_result'])).strip()
            if ex['text']:
                out = _pack(url, rr['final_url'], rr['status'], ex, rr['html'], max_length,
                            f'browser({BROWSER.engine()})', notes, t0, timings)
                if use_cache:
                    _PAGE_CACHE.set(key, out)
                return out
            last_err = 'browser rendered but extraction produced no text'
            notes.append(last_err)
        except Exception as e:
            last_err = f'{type(e).__name__}: {e}'
            notes.append(f'browser 失败：{last_err}')
            STATS['errors'] += 1

    # L2 托管 reader
    reader_err = ''
    if mode == 'reader' or (mode == 'auto' and reader_ok):
        if not READER_GATE.available():
            reader_err = f'reader 已熔断（{READER_GATE.state()["failures"]} 次失败，冷却 {READER_GATE.state()["cooldown_left_s"]}s）：{READER_GATE.state()["last_error"]}'
            notes.append(reader_err)
        else:
            try:
                t = time.time()
                rd = reader_fetch(url, timeout=max(8, min(25, timeout_ms // 1000)))
                timings['reader_ms'] = int((time.time() - t) * 1000)
                READER_GATE.ok()
                ex = {'text': _clean_markdown(rd['text']), 'title': rd.get('title', ''),
                      'engine': 'jina-reader'}
                out = _pack(url, url, rd['status'], ex, '', max_length, 'reader', notes, t0, timings)
                if use_cache:
                    _PAGE_CACHE.set(key, out)
                return out
            except Exception as e:
                reader_err = f'{type(e).__name__}: {e}'
                READER_GATE.fail(reader_err)
                st = READER_GATE.state()
                notes.append(f'reader 失败（{st["failures"]} 次）：{reader_err}'
                             + ('（已熔断，后续 auto 模式将跳过 L2）' if not st['available'] else ''))

    STATS['errors'] += 1
    if not last_err and reader_err:
        last_err = f'reader 引擎不可用：{reader_err}'
    return {'url': url, 'success': False, 'error': last_err or 'all engines failed',
            'notes': notes, 'timings': timings, 'elapsed_ms': int((time.time() - t0) * 1000)}


def _pack(url: str, final_url: str, status: int, ex: dict, html: str, max_length: int,
          engine: str, notes: list[str], t0: float, timings: dict | None = None,
          cached: bool = False) -> dict:
    text = ex.get('text', '')
    links = count_links(html, final_url or url) if html else {'internal': 0, 'external': 0, 'links': []}
    tm = dict(timings or {})
    tm['total_ms'] = int((time.time() - t0) * 1000)
    return {
        'url': url,
        'final_url': final_url,
        'success': True,
        'status_code': status,
        'markdown': text[:max_length],
        'chars': len(text),
        'word_count': len(text.split()),
        'title': ex.get('title', '') or '',
        'author': ex.get('author', '') or '',
        'date': ex.get('date', '') or '',
        'sitename': ex.get('sitename', '') or '',
        'description': ex.get('description', '') or '',
        'extractor': ex.get('engine', ''),
        'engine': engine,
        'internal_links': links['internal'],
        'external_links': links['external'],
        'links': links['links'],
        'timings': tm,
        'cached': cached,
        'notes': notes,
        'elapsed_ms': tm['total_ms'],
    }


# ══════════════════════════════════════════════════════════════════════════
# 深爬 / 站点地图
# ══════════════════════════════════════════════════════════════════════════

def _same_site(a: str, b: str) -> bool:
    return urllib.parse.urlsplit(a).netloc == urllib.parse.urlsplit(b).netloc


def _norm_url(u: str) -> str:
    s = urllib.parse.urlsplit(u)
    path = re.sub(r'/+$', '', s.path) or '/'
    return urllib.parse.urlunsplit((s.scheme, s.netloc.lower(), path, '', ''))


SKIP_EXT = re.compile(
    r'\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|rss|zip|gz|tgz|rar|7z|exe|dmg|msi|'
    r'mp3|mp4|avi|mov|wav|woff2?|ttf|eot|pdf|docx?|xlsx?|pptx?)(\?|$)', re.I)


def crawl_site(seed: str, *, max_depth: int = 2, max_pages: int = 20,
               max_length: int = 20000, mode: str = 'auto', user_agent: str = DEFAULT_UA,
               proxy: str = '', per_page_timeout_ms: int = 30000, deadline_s: float = 240.0,
               allow_reader: bool = False, concurrency: int = 4,
               use_cache: bool = True) -> dict:
    """BFS 同域深爬：层级并行 + 内容指纹去重 + 逐页上限 + 全局超时（防失控）。

    并行只在一层之内做（BFS 层级屏障），保证 frontier 顺序可预期；同层并发数可配。
    """
    t0 = time.time()
    seen: set[str] = {_norm_url(seed)}
    hashes: set[str] = set()
    pages: list[dict] = []
    frontier: list[tuple[str, int]] = [(seed, 0)]
    workers = max(1, min(16, int(concurrency or 1)))

    while frontier and len(pages) < max_pages:
        if time.time() - t0 > deadline_s:
            break
        batch = frontier[:max(0, max_pages - len(pages))]
        frontier = frontier[len(batch):]
        next_depth = batch[0][1] + 1

        def one(item: tuple[str, int]) -> dict:
            url, _depth = item
            try:
                r = fetch_page(url, mode=mode, max_length=max_length, user_agent=user_agent,
                               proxy=proxy, timeout_ms=per_page_timeout_ms,
                               allow_reader=allow_reader, use_cache=use_cache)
            except Exception as e:
                return {'url': url, 'ok': False, 'error': f'{type(e).__name__}: {e}'}
            if not r.get('success'):
                return {'url': url, 'ok': False, 'error': r.get('error', 'failed')}
            return {'_page': r, '_links': r.get('links') or []}

        if workers > 1 and len(batch) > 1:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(one, batch))
        else:
            results = [one(b) for b in batch]

        for res in results:
            r = res.get('_page')
            if r is None:
                pages.append(res)
                continue
            h = hashlib.sha1(r['markdown'][:20000].encode('utf-8', 'replace')).hexdigest()
            if h in hashes:
                continue
            hashes.add(h)
            pages.append({'url': r.get('final_url') or r['url'], 'ok': True,
                          'title': r.get('title', ''), 'status_code': r.get('status_code'),
                          'engine': r.get('engine'), 'extractor': r.get('extractor'),
                          'chars': r.get('chars'), 'markdown': r.get('markdown', '')[:max_length]})
            # 直接复用本页已抓到的链接，不再二次请求（旧实现每页多打一次 HTTP）
            if next_depth <= max_depth:
                for lk in (res.get('_links') or []):
                    href = lk.get('href', '')
                    if not _same_site(href, seed) or SKIP_EXT.search(href):
                        continue
                    k = _norm_url(href)
                    if k not in seen:
                        seen.add(k)
                        frontier.append((href, next_depth))
    return {'url': seed, 'success': True, 'pages_crawled': len(pages), 'queued': len(frontier),
            'concurrency': workers, 'pages': pages, 'elapsed_ms': int((time.time() - t0) * 1000)}


def discover_sitemap(origin: str, *, user_agent: str = DEFAULT_UA, proxy: str = '',
                     max_urls: int = 2000, max_sitemaps: int = 12,
                     timeout: int = 20) -> dict:
    """通过 robots.txt → sitemap.xml（含 sitemap index 递归）发现 URL。

    比纯 BFS 爬链接高效得多，也是站点地图工具该做的第一件事。
    """
    found: list[str] = []
    sitemaps: list[str] = []
    seen_sitemaps: set[str] = set()
    try:
        rb = http_get(urllib.parse.urljoin(origin, '/robots.txt'), timeout=timeout,
                      user_agent=user_agent, proxy=proxy)
        if rb['status'] == 200:
            for m in re.finditer(r'(?im)^\s*sitemap:\s*(\S+)', rb['body']):
                sitemaps.append(m.group(1).strip())
    except Exception:
        pass
    if not sitemaps:
        sitemaps = [urllib.parse.urljoin(origin, '/sitemap.xml')]

    while sitemaps and len(seen_sitemaps) < max_sitemaps and len(found) < max_urls:
        sm = sitemaps.pop(0)
        if sm in seen_sitemaps:
            continue
        seen_sitemaps.add(sm)
        try:
            r = http_get(sm, timeout=timeout, user_agent=user_agent, proxy=proxy)
            if r['status'] != 200:
                continue
            body = r['body']
        except Exception:
            continue
        locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', body, re.I)
        is_index = '<sitemapindex' in body[:2000].lower()
        if is_index:
            sitemaps.extend(locs[:max_sitemaps])
            continue
        for loc in locs:
            if loc not in found:
                found.append(loc)
            if len(found) >= max_urls:
                break
    return {'sitemaps': sorted(seen_sitemaps), 'urls': found}


def map_site(seed: str, *, max_pages: int = 100, user_agent: str = DEFAULT_UA,
             proxy: str = '', mode: str = 'static', deadline_s: float = 180.0,
             use_sitemap: bool = True, concurrency: int = 4) -> dict:
    """站点地图：优先走 sitemap.xml（快且全），再补 BFS 链接发现，不下正文。"""
    t0 = time.time()
    origin = '{u.scheme}://{u.netloc}'.format(u=urllib.parse.urlsplit(seed))
    sitemap_info: dict = {'sitemaps': [], 'urls': []}
    if use_sitemap:
        try:
            sitemap_info = discover_sitemap(origin, user_agent=user_agent, proxy=proxy,
                                            max_urls=min(2000, max_pages * 20))
        except Exception:
            pass

    seen: set[str] = {_norm_url(u) for u in sitemap_info['urls']}
    frontier: list[tuple[str, int]] = [(seed, 0)]
    out: list[dict] = []
    workers = max(1, min(16, int(concurrency or 1)))

    while frontier and len(out) < max_pages:
        if time.time() - t0 > deadline_s:
            break
        batch = frontier[:max(0, max_pages - len(out))]
        frontier = frontier[len(batch):]
        next_depth = batch[0][1] + 1

        def one(item: tuple[str, int]) -> dict:
            url, _d = item
            try:
                if mode == 'static':
                    r = http_get(url, timeout=20, user_agent=user_agent, proxy=proxy)
                    html = r['body']
                else:
                    rr = BROWSER.render(url, user_agent=user_agent, timeout_ms=30000,
                                        proxy=proxy, block_images=True)
                    html = rr['html']
                links = count_links(html, url)['links']
                internal = [l for l in links
                            if l['kind'] == 'internal' and not SKIP_EXT.search(l['href'])]
                return {'from': url, 'ok': True, 'count': len(internal), 'links': internal[:200]}, internal
            except Exception as e:
                return {'from': url, 'ok': False, 'error': f'{type(e).__name__}: {e}'}, []

        if workers > 1 and len(batch) > 1:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(one, batch))
        else:
            results = [one(b) for b in batch]

        for entry, internal in results:
            out.append(entry)
            if next_depth <= 2:
                for lk in internal:
                    k = _norm_url(lk['href'])
                    if k not in seen:
                        seen.add(k)
                        frontier.append((lk['href'], next_depth))

    # sitemap 里的 URL 也算「已发现」，作为独立一节返回，便于直接选种子
    sm_urls = [u for u in sitemap_info['urls'] if _same_site(u, origin)]
    return {'url': seed, 'success': True, 'pages_seen': len(out), 'pages': out,
            'sitemaps': sitemap_info['sitemaps'],
            'sitemap_urls': sm_urls[:2000], 'sitemap_url_count': len(sm_urls),
            'known_urls': sorted(seen)[:2000],
            'concurrency': workers,
            'elapsed_ms': int((time.time() - t0) * 1000)}


# ══════════════════════════════════════════════════════════════════════════
# CSS 结构化提取（纯本地，零模型调用）
# ══════════════════════════════════════════════════════════════════════════

def extract_css(url: str, schema: dict, *, mode: str = 'auto', user_agent: str = DEFAULT_UA,
                proxy: str = '', cache: bool = True, css_html: str = '') -> dict:
    if not bs4:
        raise ToolError('beautifulsoup4 unavailable; cannot run CSS extraction')
    raw = css_html or None
    if raw is None:
        # 一次抓取拿到 HTML 与链接（不再「先抓正文再重抓一次」）
        key = ('css', url, mode, user_agent)
        raw = _HTML_CACHE.get(key) if cache else None
        if raw is None:
            try:
                r = http_get(url, timeout=30, user_agent=user_agent, proxy=proxy)
                raw = r['body']
                need_render = mode == 'browser' or (mode == 'auto' and looks_js_gated(raw))
            except Exception:
                raw = ''
                need_render = True
            if not raw or len(raw) < 200 or need_render:
                try:
                    rr = BROWSER.render(url, user_agent=user_agent, timeout_ms=45000,
                                        proxy=proxy, block_images=True)
                    raw = rr['html']
                except Exception as e:
                    if not raw:
                        return {'url': url, 'success': False,
                                'error': f'{type(e).__name__}: {e}'}
            if cache and raw:
                _HTML_CACHE[key] = raw
                if len(_HTML_CACHE) > 24:
                    _HTML_CACHE.pop(next(iter(_HTML_CACHE)))

    soup = bs4.BeautifulSoup(raw, 'lxml')
    base_sel = schema.get('baseSelector') or schema.get('base_selector') or 'body'
    fields = schema.get('fields') or []

    def field_value(node, f: dict):
        sel = f.get('selector') or ''
        ftype = (f.get('type') or 'text').lower()
        attr = f.get('attribute') or f.get('attr')
        targets = [node] if (not sel or sel == ':scope' or sel == 'text()') else node.select(sel)
        if ftype == 'list':
            vals = []
            for t in targets:
                vals.append(t.get(attr) if attr else t.get_text(' ', strip=True))
            return vals
        if not targets:
            return None
        t = targets[0]
        if ftype == 'attr' or attr:
            return t.get(attr) if attr else None
        if ftype == 'html':
            return str(t)
        if ftype == 'nested':
            return {sub['name']: field_value(t, sub) for sub in f.get('fields', [])}
        return t.get_text(' ', strip=True)

    try:
        bases = soup.select(base_sel)
    except Exception as e:
        return {'url': url, 'success': False, 'error': f'invalid baseSelector {base_sel!r}: {e}'}
    rows = []
    for b in bases:
        rows.append({f['name']: field_value(b, f) for f in fields})
    return {'url': url, 'success': True, 'count': len(rows),
            'data': {'name': schema.get('name', 'items'), 'items': rows}, 'rows': rows}


_HTML_CACHE: dict[str, str] = {}


# ══════════════════════════════════════════════════════════════════════════
# 文档 → Markdown（markitdown：PDF/DOCX/PPTX/XLSX/HTML/EPUB/…）
# ══════════════════════════════════════════════════════════════════════════

def http_download(url: str, path: str, timeout: int = 90,
                  user_agent: str = DEFAULT_UA) -> tuple:
    """二进制下载（文档用）。绝不能走 http_get 的文本解码路径——PDF/XLSX 会被写坏。

    返回 (字节数, content-type)。content-type 是必需的：很多文档 URL 没有扩展名
    （`https://example.com/`、`https://go.microsoft.com/fwlink/?LinkID=...`），只靠
    扩展名会存成 `.bin`，markitdown 就无法路由到正确的转换器。
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={
        'User-Agent': user_agent,
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
    }, method='GET')
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        data = r.read()
        ctype = (r.headers.get('Content-Type') or '').split(';')[0].strip().lower()
    with open(path, 'wb') as f:
        f.write(data)
    return len(data), ctype


MIME_EXT = {
    'application/pdf': '.pdf',
    'text/html': '.html',
    'application/xhtml+xml': '.html',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/xml': '.xml',
    'text/xml': '.xml',
    'application/epub+zip': '.epub',
    'application/rtf': '.rtf',
    'application/zip': '.zip',
    'application/msword': '.doc',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
}


ZIP_OLE_MAGIC = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'


def sniff_ext(data: bytes) -> str:
    """按魔数嗅探格式——替代 magika 的那部分职责，20 行换掉 40MB。

    为什么必需：很多文档 URL 既没有扩展名，content-type 还是
    `application/octet-stream`（实测 go.microsoft.com 的 xlsx 短链就是这样）。
    两级判据都失效时，只有字节头能说清它是什么。
    """
    if not data:
        return ''
    head = data[:512]
    if head.startswith(b'%PDF'):
        return '.pdf'
    if head.startswith(b'PK\x03\x04') or head.startswith(b'PK\x05\x06'):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = z.namelist()
                if 'mimetype' in names:
                    try:
                        if b'epub' in z.read('mimetype'):
                            return '.epub'
                    except Exception:
                        pass
                joined = ' '.join(names[:400])
                if 'word/' in joined:
                    return '.docx'
                if 'xl/' in joined:
                    return '.xlsx'
                if 'ppt/' in joined:
                    return '.pptx'
                return '.zip'
        except Exception:
            return '.zip'
    if head.startswith(ZIP_OLE_MAGIC):
        # 旧版 Office 复合文档：按内部流名区分
        low = data[:65536].lower()
        if b'worddocument' in low:
            return '.doc'
        if b'workbook' in low or b'book' in low:
            return '.xls'
        if b'powerpoint' in low:
            return '.ppt'
        return '.doc'
    if head.lstrip()[:5].lower() == b'{\\rtf':
        return '.rtf'
    txt = head.lstrip()[:400].lower()
    if txt.startswith(b'<!doctype html') or txt.startswith(b'<html') or b'<html' in txt[:200]:
        return '.html'
    if txt.startswith(b'<?xml'):
        return '.xml'
    if txt.startswith(b'{') or txt.startswith(b'['):
        return '.json'
    return ''


def guess_ext(url: str, content_type: str = '', data: bytes = b'') -> str:
    """扩展名判据优先级：魔数嗅探 → Content-Type → URL 路径后缀 → .bin。

    魔数排第一是因为它最可靠：URL 后缀可能撒谎（.php 返回 PDF），
    content-type 也可能是 octet-stream 这种无信息的兜底值。
    """
    sniffed = sniff_ext(data)
    if sniffed:
        return sniffed
    mime = (content_type or '').split(';')[0].strip().lower()
    if mime in MIME_EXT:
        return MIME_EXT[mime]
    if mime.startswith('text/'):
        return '.txt'
    ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1][:8]
    if ext and re.match(r'^\.[A-Za-z0-9]{1,7}$', ext):
        return ext.lower()
    return '.bin'


def doc_to_markdown(path: str = '', url: str = '', max_length: int = 200000) -> dict:
    if markitdown_mod is None:
        raise ToolError('markitdown unavailable')
    data = None
    if url:
        tmp = os.path.join(_TMPDIR, 'doc_' + hashlib.sha1(url.encode()).hexdigest() + '.tmp')
        try:
            n, ctype = http_download(url, tmp)
        except Exception as e:
            return {'url': url, 'success': False, 'error': f'download failed: {type(e).__name__}: {e}'}
        if n < 32:
            return {'url': url, 'success': False, 'error': f'downloaded only {n} bytes'}
        with open(tmp, 'rb') as f:
            data = f.read()
        # 魔数嗅探 / content-type / URL 后缀三级判据定扩展名（很多文档 URL 三者都缺）
        final = os.path.splitext(tmp)[0] + guess_ext(url, ctype, data)
        try:
            if os.path.abspath(final) != os.path.abspath(tmp):
                if os.path.exists(final):
                    os.remove(final)
                os.replace(tmp, final)
        except Exception:
            final = tmp
        path = final
    if not path or not os.path.isfile(path):
        return {'url': url, 'success': False, 'error': f'file not found: {path!r}'}
    if data is None:
        with open(path, 'rb') as f:
            data = f.read()
    out = doc_to_markdown_bytes(data, path, max_length=max_length)
    out['url'] = url
    out['path'] = path
    return out


def doc_to_markdown_bytes(data: bytes, name: str = 'doc.bin', max_length: int = 200000,
                          content_type: str = '') -> dict:
    """内存版文档转换（抓取时命中文档响应直接走这里）。

    `name` 可以是 URL 或本地路径；扩展名缺失时按 content_type 推断——否则 markitdown
    拿到 `.bin` 会报 "No converter found"。
    """
    if markitdown_mod is None:
        raise ToolError('markitdown unavailable')
    if not data:
        return {'success': False, 'error': 'empty body', 'chars': 0}
    ext = guess_ext(name, content_type, data)
    tmp = os.path.join(_TMPDIR, 'blob_' + hashlib.sha1(data[:4096]).hexdigest()[:16] + ext)
    try:
        with open(tmp, 'wb') as f:
            f.write(data)
        md = markitdown_mod.MarkItDown(enable_plugins=False)
        res = md.convert(tmp)
        text = getattr(res, 'text_content', '') or ''
        title = getattr(res, 'title', '') or ''
        return {'success': True, 'markdown': text[:max_length], 'chars': len(text),
                'title': title, 'ext': ext.lstrip('.').lower(), 'path': tmp}
    except Exception as e:
        return {'success': False, 'error': f'convert failed: {type(e).__name__}: {e}',
                'chars': 0}


_TMPDIR = os.path.join(os.environ.get('TEMP', '.'), 'dsh-webcrawl')
try:
    os.makedirs(_TMPDIR, exist_ok=True)
except Exception:
    _TMPDIR = os.path.dirname(os.path.abspath(__file__))


# ══════════════════════════════════════════════════════════════════════════
# 命令分发
# ══════════════════════════════════════════════════════════════════════════

REQUIRED_MODULES = {
    'trafilatura': 'text extraction (primary)',
    'justext': 'text extraction (rescue)',
    'bs4': 'CSS extraction / link parsing / JS-shell detection',
    'lxml': 'HTML parser backend',
    'markdownify': 'HTML → Markdown fallback when trafilatura degrades',
    'markitdown': 'document → Markdown',
    'patchright': 'stealth browser engine (falls back to playwright)',
    'playwright': 'browser engine (fallback)',
    'charset_normalizer': 'charset detection',
}


def cmd_status(args: dict) -> dict:
    if args.get('clear_cache'):
        _PAGE_CACHE.clear()
        _HTML_CACHE.clear()
    missing = []
    for mod, why in REQUIRED_MODULES.items():
        if _try_import(mod) is None:
            missing.append({'module': mod, 'needed_for': why})
    degraded = {m['module'] for m in missing}
    return {
        'ok': True,
        'python': sys.version.split()[0],
        'engines': {
            'static': True,
            'browser': BROWSER.engine() or None,
            'reader': {
                'endpoint': (READER_ENDPOINT or 'https://r.jina.ai/'),
                'auto': READER_DEFAULT,
                **READER_GATE.state(),
            },
        },
        'extractors': {
            'trafilatura': getattr(trafilatura, '__version__', None) if trafilatura else None,
            'justext': bool(justext),
            'beautifulsoup4': getattr(bs4, '__version__', None) if bs4 else None,
            'markdownify': bool(markdownify),
            'markitdown': bool(markitdown_mod),
        },
        'missing_modules': missing,
        'healthy': not any(m in degraded for m in ('trafilatura', 'bs4', 'lxml')) and BROWSER.engine() is not None,
        'vendor_paths': [p for p in _VENDOR_CANDIDATES if p and os.path.isdir(p)],
        'browser_channel': BROWSER_CHANNEL,
        'cache': _PAGE_CACHE.stats(),
        'stats': STATS,
    }


def cmd_fetch(a: dict) -> dict:
    return fetch_page(
        a['url'],
        mode=a.get('mode', 'auto'),
        max_length=int(a.get('max_length', 60000)),
        css_selector=a.get('css_selector', '') or '',
        user_agent=a.get('user_agent') or DEFAULT_UA,
        proxy=a.get('proxy', '') or '',
        wait_for_ms=int(a.get('wait_for_ms', 0) or 0),
        wait_for_selector=a.get('wait_for_selector', '') or '',
        js_code=a.get('js_code', '') or '',
        include_links=bool(a.get('include_links', True)),
        include_tables=bool(a.get('include_tables', True)),
        include_images=bool(a.get('include_images', False)),
        timeout_ms=int(a.get('timeout', 45000) or 45000),
        allow_reader=a.get('allow_reader'),
        full_metadata=bool(a.get('full_metadata', False)),
        use_cache=bool(a.get('cache', True)),
    )


def cmd_crawl_site(a: dict) -> dict:
    return crawl_site(
        a['url'],
        max_depth=int(a.get('max_depth', 2)),
        max_pages=int(a.get('max_pages', 20)),
        max_length=int(a.get('max_length', 20000)),
        mode=a.get('mode', 'auto'),
        user_agent=a.get('user_agent') or DEFAULT_UA,
        proxy=a.get('proxy', '') or '',
        per_page_timeout_ms=int(a.get('timeout', 30000) or 30000),
        deadline_s=float(a.get('deadline_s', 240) or 240),
        allow_reader=bool(a.get('allow_reader', False)),
        concurrency=int(a.get('concurrency', 4) or 4),
        use_cache=bool(a.get('cache', True)),
    )


def cmd_map_site(a: dict) -> dict:
    return map_site(a['url'], max_pages=int(a.get('max_pages', 100)),
                    user_agent=a.get('user_agent') or DEFAULT_UA, proxy=a.get('proxy', '') or '',
                    mode=a.get('mode', 'static'),
                    use_sitemap=bool(a.get('use_sitemap', True)),
                    concurrency=int(a.get('concurrency', 4) or 4))


def cmd_extract(a: dict) -> dict:
    return extract_css(a['url'], a['schema'], mode=a.get('mode', 'auto'),
                       user_agent=a.get('user_agent') or DEFAULT_UA, proxy=a.get('proxy', '') or '',
                       cache=bool(a.get('cache', True)))


def cmd_cache(a: dict) -> dict:
    """缓存管理：clear 清空页面/HTML 缓存。"""
    if (a.get('action') or '').lower() == 'clear':
        _PAGE_CACHE.clear()
        _HTML_CACHE.clear()
        return {'success': True, 'cleared': True}
    return {'success': True, 'page_cache': _PAGE_CACHE.stats(),
            'html_cache_entries': len(_HTML_CACHE)}


def cmd_links(a: dict) -> dict:
    """出链清单：直接复用抓取结果里已算好的链接，不再二次请求。"""
    r = fetch_page(a['url'], mode=a.get('mode', 'auto'), max_length=200,
                   user_agent=a.get('user_agent') or DEFAULT_UA, proxy=a.get('proxy', '') or '',
                   allow_reader=a.get('allow_reader'))
    if not r.get('success'):
        return {'url': a['url'], 'success': False, 'error': r.get('error')}
    links = r.get('links') or []
    return {'url': r.get('final_url') or a['url'], 'success': True, 'links': links,
            'internal': sum(1 for l in links if l['kind'] == 'internal'),
            'external': sum(1 for l in links if l['kind'] == 'external'),
            'engine': r.get('engine'), 'cached': r.get('cached')}


def cmd_doc(a: dict) -> dict:
    return doc_to_markdown(a.get('path', ''), a.get('url', ''),
                           max_length=int(a.get('max_length', 200000)))


def cmd_http(a: dict) -> dict:
    url = a['url']
    method = (a.get('method') or 'GET').upper()
    headers = a.get('headers') or {}
    body = a.get('body')
    timeout = int(a.get('timeout', 30000) or 30000)
    try:
        r = BROWSER.request(url, method=method, headers=headers, body=body, timeout_ms=timeout)
        return {'url': url, 'success': True, **r}
    except Exception as e:
        # 浏览器栈不可用时退回 urllib（仍忽略证书错误）
        try:
            g = http_get(url, timeout=max(5, timeout // 1000), headers=headers)
            return {'url': url, 'success': True, 'status': g['status'],
                    'headers': g['headers'], 'body': g['body'], 'final_url': g['final_url'],
                    'note': f'browser stack unavailable ({type(e).__name__}); used urllib'}
        except Exception as e2:
            return {'url': url, 'success': False, 'error': f'{type(e).__name__}: {e} / urllib: {e2}'}


def cmd_shutdown(_args: dict) -> dict:
    BROWSER.close()
    return {'bye': True}


HANDLERS = {
    'status': cmd_status, 'fetch': cmd_fetch, 'crawl_site': cmd_crawl_site,
    'map_site': cmd_map_site, 'extract': cmd_extract, 'links': cmd_links,
    'doc': cmd_doc, 'http': cmd_http, 'cache': cmd_cache, 'shutdown': cmd_shutdown,
}


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main() -> None:
    emit({'id': None, 'ok': True, 'data': {
        'hello': True,
        'engines': {'browser': BROWSER.engine() or None,
                    'extractors': {'trafilatura': bool(trafilatura), 'justext': bool(justext),
                                   'markitdown': bool(markitdown_mod), 'bs4': bool(bs4)}},
        'pid': os.getpid(),
    }})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        rid = msg.get('id')
        cmd = msg.get('cmd') or ''
        args = msg.get('args') or {}
        fn = HANDLERS.get(cmd)
        if fn is None:
            emit({'id': rid, 'ok': False, 'error': f'unknown command: {cmd}'})
            continue
        try:
            data = fn(args)
            emit({'id': rid, 'ok': True, 'data': data})
        except Exception as e:
            emit({'id': rid, 'ok': False,
                  'error': f'{type(e).__name__}: {e}',
                  'trace': traceback.format_exc()[-1200:]})
        if cmd == 'shutdown':
            break
    BROWSER.close()


if __name__ == '__main__':
    main()
