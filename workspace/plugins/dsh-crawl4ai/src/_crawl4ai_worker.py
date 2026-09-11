#!/usr/bin/env python3
"""crawl4ai 常驻 worker — DSH 插件 dsh-crawl4ai 的 Python 后端。

行协议 JSON-RPC over stdio：
  请求（stdin 每行一个）: {"id": str, "cmd": str, "args": dict}
  响应（stdout 每行一个）: {"id": str, "ok": true, "data": dict} | {"id": str, "ok": false, "error": str}

命令：
  ping          -> {"pong": true, "version": "..."}
  crawl         -> 单页抓取（静态 HTTP 自适应 -> 可升浏览器渲染）
  http          -> 任意方法 HTTP（浏览器页面内 fetch，走浏览器 TLS 指纹）
  crawl_many    -> 多 URL 并发抓取
  crawl_site    -> BFS 深爬整站（同域）
  map_site      -> 站点地图（发现链接，不保存正文）
  extract       -> CSS 选择器结构化提取（JsonCssExtractionStrategy）
  links         -> 单页链接清单
  shutdown      -> 优雅退出（close 浏览器池）

设计要点（吸收 crawl4ai / Firecrawl / Trafilatura 优点，规避各自缺点）：
- AsyncWebCrawler 常驻：start() 一次复用浏览器池，规避每次冷启动的秒级~分钟级开销
- 静态页优先 HTTP（ContentScrapingStrategy），失败/JS 依赖升浏览器，规避「一律开浏览器」的慢与重
- 内容过滤（Pruning + word_count_threshold）净化正文，规避裸转换的导航噪音
- 所有异常隔离到单次响应，协议永不中断
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any

sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_MAX_LENGTH = 50_000
DEFAULT_WORD_COUNT_THRESHOLD = 10
CONCURRENCY = 2  # 浏览器并发上限，防内存爆炸（规避 crawl4ai 并发吃内存的缺点）

_crawler: Any = None
_browser_config: Any = None
_semaphore: asyncio.Semaphore | None = None


def _emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _err(req_id: str, error: str) -> None:
    _emit({"id": req_id, "ok": False, "error": error})


def _ok(req_id: str, data: dict[str, Any]) -> None:
    _emit({"id": req_id, "ok": True, "data": data})


# ═══════════════════════════════════════════════════════════════════════════
# crawl4ai 懒加载（仅真实调用时 import，规避导入开销）
# ═══════════════════════════════════════════════════════════════════════════

def _c4() -> Any:
    from crawl4ai import AsyncWebCrawler, BrowserConfig  # noqa: F401
    return sys.modules["crawl4ai"]


def _normalize_run_result(r: Any, url: str, max_length: int) -> dict[str, Any]:
    """把 crawl4ai 的 CrawlResult 规范化为协议数据（字段名在 0.9.x 验证过）。"""
    md = getattr(r, "markdown", "") or ""
    if max_length and len(md) > max_length:
        md = md[:max_length] + "\n\n[... truncated]"
    metadata = getattr(r, "metadata", None) or {}
    title = getattr(r, "title", None) or (metadata.get("title") if isinstance(metadata, dict) else None)
    links = getattr(r, "links", None) or {}
    internal = links.get("internal", []) if isinstance(links, dict) else []
    external = links.get("external", []) if isinstance(links, dict) else []
    return {
        "url": getattr(r, "url", None) or url,
        "success": bool(getattr(r, "success", True)),
        "status_code": getattr(r, "status_code", 200) or 200,  # 缓存命中时 crawl4ai 返回 None
        "markdown": md,
        "chars": len(md),
        "word_count": len(md.split()),
        "title": title or "",  # 保证 string（工具 schema 校验）
        "internal_links": len(internal),
        "external_links": len(external),
        "error": getattr(r, "error_message", "") or "",
    }


def _crawl_run_config(browser: bool, args: dict[str, Any]) -> Any:
    """构造 CrawlerRunConfig。browser=False 时用纯 HTTP 抓取（ContentScrapingStrategy）。"""
    c4 = _c4()
    cache = bool(args.get("cache", True))
    cache_mode = getattr(c4, "CacheMode").ENABLED if cache else getattr(c4, "CacheMode").BYPASS

    kwargs: dict[str, Any] = {
        "cache_mode": cache_mode,
        "word_count_threshold": int(args.get("word_count_threshold", DEFAULT_WORD_COUNT_THRESHOLD)),
        "magic": bool(args.get("magic", True)),
        "verbose": False,
    }
    if args.get("css_selector"):
        kwargs["css_selector"] = str(args["css_selector"])
    if args.get("exclude_tags"):
        kwargs["exclude_tags"] = list(args["exclude_tags"])
    if args.get("wait_for_ms"):
        kwargs["wait_for"] = f"css:body:timeout={int(args['wait_for_ms'])}"
    if args.get("js_code"):
        kwargs["js_code"] = list(args["js_code"]) if isinstance(args["js_code"], list) else [str(args["js_code"])]
    if args.get("user_agent"):
        kwargs["user_agent"] = str(args["user_agent"])
    if args.get("headers"):
        kwargs["headers"] = dict(args["headers"])
    if not browser:
        kwargs["strategy"] = c4.ContentScrapingStrategy()
    return c4.CrawlerRunConfig(**kwargs)


def _browser_config_for(args: dict[str, Any]) -> Any:
    """BrowserConfig：UA/代理可配（吸收 Firecrawl 反爬能力，规避裸浏览器易被拦）。"""
    c4 = _c4()
    kwargs: dict[str, Any] = {"headless": True}
    if args.get("user_agent"):
        kwargs["user_agent"] = str(args["user_agent"])
    if args.get("proxy"):
        kwargs["proxy"] = str(args["proxy"])
    return c4.BrowserConfig(**kwargs)


# ═══════════════════════════════════════════════════════════════════════════
# 命令实现
# ═══════════════════════════════════════════════════════════════════════════

async def _ensure_crawler(browser: bool, args: dict[str, Any]) -> Any:
    global _crawler, _browser_config
    if _crawler is None:
        c4 = _c4()
        _browser_config = _browser_config_for(args)
        # 静默 logger：crawl4ai 默认向 stderr 打 [INIT]/[FETCH] 日志，父进程不消费
        # stderr 时管道缓冲填满会死锁（Windows 尤甚）；抑制后协议永不阻塞。
        _crawler = c4.AsyncWebCrawler(
            config=_browser_config,
            logger=c4.AsyncLogger(log_file=None, verbose=False),
        )
        await _crawler.start()
    return _crawler


async def cmd_ping(_args: dict[str, Any]) -> dict[str, Any]:
    return {"pong": True, "version": "crawl4ai"}


async def cmd_http(args: dict[str, Any]) -> dict[str, Any]:
    """任意方法 HTTP 请求（GET/POST/PUT/DELETE…）——用真实浏览器页面导航到目标
    （走浏览器 TLS 指纹，绕过反爬），再在页面内 fetch 目标 URL（可跨域），
    返回状态码/响应头/响应体。"""
    url = str(args.get("url", ""))
    if not url:
        return {"url": "", "success": False, "status": 0, "headers": {}, "body": "", "error": "missing url"}
    method = str(args.get("method", "GET")).upper()
    headers = dict(args.get("headers") or {})
    body = args.get("body")
    timeout_ms = int(args.get("timeout", 25000))

    try:
        crawler = await _ensure_crawler(True, args)
        strat = getattr(crawler, "crawler_strategy", None)
        bm = getattr(strat, "browser_manager", None)
        browser = getattr(bm, "browser", None) if bm else None
        if browser is None:
            return {"url": url, "success": False, "status": 0, "headers": {}, "body": "",
                    "error": "browser unavailable"}
        context = await browser.new_context(ignore_https_errors=True, user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0")
        page = await context.new_page()
        # 先导航到目标 origin 的根路径（建立同源上下文；失败也继续，用 about:blank 兜底）
        from urllib.parse import urlparse
        origin = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
        try:
            await page.goto(origin + "/", timeout=15000, wait_until="domcontentloaded")
        except Exception:  # noqa: BLE001
            try:
                await page.goto("about:blank", timeout=8000)
            except Exception:  # noqa: BLE001
                pass
        # 页面内 fetch（浏览器指纹通道，任意方法）
        js = f"""
        (async () => {{
          try {{
            const resp = await fetch({json.dumps(url)}, {{
              method: {json.dumps(method)},
              headers: {json.dumps(headers)},
              body: {json.dumps(body) if body else 'undefined'},
            }});
            const text = await resp.text();
            const hdrs = {{}};
            resp.headers.forEach((v, k) => {{ hdrs[k] = v; }});
            return JSON.stringify({{ status: resp.status, headers: hdrs, body: text }});
          }} catch (e) {{
            return JSON.stringify({{ status: 0, headers: {{}}, body: '', error: String(e) }});
          }}
        }})()
        """
        raw = await page.evaluate(js)
        await context.close()
        import json as _json
        data = _json.loads(raw or '{"status":0,"headers":{},"body":"","error":"empty"}')
        return {
            "url": url, "success": bool(data.get("status")), "status": int(data.get("status") or 0),
            "headers": data.get("headers") or {}, "body": str(data.get("body") or "")[:200_000],
            "error": str(data.get("error") or ""),
        }
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "success": False, "status": 0, "headers": {}, "body": "",
                "error": f"{type(exc).__name__}: {exc}"}


async def cmd_crawl(args: dict[str, Any]) -> dict[str, Any]:
    url = str(args["url"])
    browser = bool(args.get("browser", True))
    max_length = int(args.get("max_length", DEFAULT_MAX_LENGTH))
    timeout_ms = int(args.get("timeout", DEFAULT_TIMEOUT_MS))
    crawler = await _ensure_crawler(browser, args)
    run_config = _crawl_run_config(browser, args)

    try:
        result = await asyncio.wait_for(
            crawler.arun(url, config=run_config),
            timeout=timeout_ms / 1000.0,
        )
    except asyncio.TimeoutError:
        return {"url": url, "success": False, "status_code": 0, "markdown": "", "chars": 0,
                "word_count": 0, "title": None, "internal_links": 0, "external_links": 0,
                "error": f"timeout after {timeout_ms}ms"}
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "success": False, "status_code": 0, "markdown": "", "chars": 0,
                "word_count": 0, "title": None, "internal_links": 0, "external_links": 0,
                "error": f"{type(exc).__name__}: {exc}"}

    return _normalize_run_result(result, url, max_length)


async def cmd_crawl_many(args: dict[str, Any]) -> dict[str, Any]:
    urls = [str(u) for u in args.get("urls", [])]
    browser = bool(args.get("browser", True))
    max_length = int(args.get("max_length", DEFAULT_MAX_LENGTH))
    timeout_ms = int(args.get("timeout", DEFAULT_TIMEOUT_MS))
    crawler = await _ensure_crawler(browser, args)
    run_config = _crawl_run_config(browser, args)
    try:
        results = await asyncio.wait_for(
            crawler.arun_many(urls, config=run_config),
            timeout=max(timeout_ms, 30_000) / 1000.0,
        )
    except Exception as exc:  # noqa: BLE001
        return {"urls": urls, "success": False, "results": [], "error": f"{type(exc).__name__}: {exc}"}
    return {
        "urls": urls,
        "success": True,
        "results": [_normalize_run_result(r, urls[i] if i < len(urls) else "", max_length)
                    for i, r in enumerate(results)],
        "error": "",
    }


async def cmd_crawl_site(args: dict[str, Any]) -> dict[str, Any]:
    """BFS 深爬（吸收 crawl4ai BFSDeepCrawlStrategy + Firecrawl crawl 端点）。"""
    url = str(args["url"])
    max_depth = int(args.get("max_depth", 2))
    max_pages = int(args.get("max_pages", 20))
    max_length = int(args.get("max_length", DEFAULT_MAX_LENGTH))
    timeout_ms = int(args.get("timeout", 120_000))
    crawler = await _ensure_crawler(True, args)
    c4 = _c4()
    run_config = c4.CrawlerRunConfig(
        cache_mode=c4.CacheMode.ENABLED if bool(args.get("cache", True)) else c4.CacheMode.BYPASS,
        deep_crawl_strategy=c4.BFSDeepCrawlStrategy(
            max_depth=max_depth,
            max_pages=max_pages,
            include_external=False,
        ),
        word_count_threshold=int(args.get("word_count_threshold", DEFAULT_WORD_COUNT_THRESHOLD)),
        magic=True,
        verbose=False,
    )
    try:
        results = await asyncio.wait_for(
            crawler.arun(url, config=run_config),
            timeout=timeout_ms / 1000.0,
        )
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "success": False, "pages": [], "pages_crawled": 0, "error": f"{type(exc).__name__}: {exc}"}

    pages = []
    for r in results:
        md = getattr(r, "markdown", "") or ""
        if max_length and len(md) > max_length:
            md = md[:max_length]
        pages.append({
            "url": getattr(r, "url", None) or url,
            "success": bool(getattr(r, "success", True)),
            "status_code": getattr(r, "status_code", 200) or 200,
            "title": ((getattr(r, "metadata", None) or {}).get("title") if isinstance(getattr(r, "metadata", None), dict) else getattr(r, "title", None)) or "",
            "markdown": md,
            "chars": len(md),
            "word_count": len(md.split()),
        })
    return {"url": url, "success": True, "pages": pages, "pages_crawled": len(pages), "error": ""}


async def cmd_map_site(args: dict[str, Any]) -> dict[str, Any]:
    """站点地图：BFS 发现链接（HTTP 优先，失败升浏览器），不保存正文（省内存）。"""
    url = str(args["url"])
    max_pages = int(args.get("max_pages", 100))
    timeout_ms = int(args.get("timeout", 120_000))
    seen: set[str] = set()
    queue: list[str] = [url]
    edges: list[dict[str, str]] = []

    from urllib.parse import urlparse

    host = urlparse(url).netloc

    async def _crawl_links(u: str) -> tuple[bool, list[dict[str, Any]]]:
        """抓一页的链接；HTTP 模式失败则浏览器模式重试（自适应）。"""
        try:
            crawler = await _ensure_crawler(False, args)
            run_config = _crawl_run_config(False, args)
            r = await asyncio.wait_for(crawler.arun(u, config=run_config), timeout=min(timeout_ms, 60_000) / 1000.0)
            links = getattr(r, "links", None) or {}
            internal = links.get("internal", []) if isinstance(links, dict) else []
            if not internal and not getattr(r, "success", True):
                raise RuntimeError(getattr(r, "error_message", "") or "empty")
            return True, [
                {"href": l.get("href", ""), "text": (l.get("text") or "")[:120]}
                for l in internal
            ]
        except Exception:  # noqa: BLE001 — 升级浏览器模式重试
            try:
                crawler = await _ensure_crawler(True, args)
                run_config = _crawl_run_config(True, args)
                r = await asyncio.wait_for(crawler.arun(u, config=run_config), timeout=min(timeout_ms, 60_000) / 1000.0)
                links = getattr(r, "links", None) or {}
                internal = links.get("internal", []) if isinstance(links, dict) else []
                return True, [
                    {"href": l.get("href", ""), "text": (l.get("text") or "")[:120]}
                    for l in internal
                ]
            except Exception as exc:  # noqa: BLE001
                return False, [{"href": "", "text": f"error: {type(exc).__name__}: {exc}"}]

    while queue and len(seen) < max_pages:
        u = queue.pop(0)
        if u in seen:
            continue
        seen.add(u)
        ok, found = await _crawl_links(u)
        edges.append({"from": u, "ok": ok, "links": found})
        for l in found:
            href = l.get("href", "")
            if not href or not href.startswith("http"):
                continue
            try:
                h = urlparse(href).netloc
            except Exception:  # noqa: BLE001
                continue
            if h == host and href not in seen and len(seen) < max_pages:
                queue.append(href)

    return {"url": url, "success": True, "pages_seen": len(seen), "pages": edges, "error": ""}


async def cmd_extract(args: dict[str, Any]) -> dict[str, Any]:
    """CSS 结构化提取（吸收 Firecrawl extract + crawl4ai JsonCssExtractionStrategy，本地免费）。"""
    url = str(args["url"])
    schema = args.get("schema")
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except Exception as exc:  # noqa: BLE001
            return {"url": url, "success": False, "data": None, "error": f"invalid schema JSON: {exc}"}
    if not isinstance(schema, dict):
        return {"url": url, "success": False, "data": None, "error": "schema must be a JSON object (name/baseSelector/fields)"}

    timeout_ms = int(args.get("timeout", DEFAULT_TIMEOUT_MS))
    crawler = await _ensure_crawler(bool(args.get("browser", True)), args)
    c4 = _c4()
    run_config = c4.CrawlerRunConfig(
        cache_mode=c4.CacheMode.ENABLED if bool(args.get("cache", True)) else c4.CacheMode.BYPASS,
        extraction_strategy=c4.JsonCssExtractionStrategy(schema=schema, verbose=False),
        magic=True,
        verbose=False,
    )
    try:
        r = await asyncio.wait_for(crawler.arun(url, config=run_config), timeout=timeout_ms / 1000.0)
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "success": False, "data": None, "error": f"{type(exc).__name__}: {exc}"}

    extracted = getattr(r, "extracted_content", None)
    data = None
    if extracted:
        try:
            data = json.loads(extracted) if isinstance(extracted, str) else extracted
        except Exception:  # noqa: BLE001
            data = extracted
    return {"url": url, "success": bool(getattr(r, "success", True)), "data": data if data is not None else {}, "error": getattr(r, "error_message", "") or ""}


async def cmd_links(args: dict[str, Any]) -> dict[str, Any]:
    """单页链接清单（internal + external 合并）。"""
    url = str(args["url"])
    timeout_ms = int(args.get("timeout", DEFAULT_TIMEOUT_MS))
    crawler = await _ensure_crawler(bool(args.get("browser", True)), args)
    run_config = _crawl_run_config(bool(args.get("browser", True)), args)
    try:
        r = await asyncio.wait_for(crawler.arun(url, config=run_config), timeout=timeout_ms / 1000.0)
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "success": False, "links": [], "error": f"{type(exc).__name__}: {exc}"}
    links = getattr(r, "links", None) or {}
    merged = []
    for kind in ("internal", "external"):
        for l in (links.get(kind, []) if isinstance(links, dict) else []):
            merged.append({"href": l.get("href", ""), "text": (l.get("text") or "")[:200], "kind": kind})
    return {"url": url, "success": True, "links": merged, "error": ""}


async def cmd_shutdown(_args: dict[str, Any]) -> dict[str, Any]:
    global _crawler
    if _crawler is not None:
        try:
            await _crawler.close()
        except Exception:  # noqa: BLE001
            pass
        _crawler = None
    return {"bye": True}


# ═══════════════════════════════════════════════════════════════════════════
# 主循环
# ═══════════════════════════════════════════════════════════════════════════

HANDLERS = {
    "ping": cmd_ping,
    "crawl": cmd_crawl,
    "http": cmd_http,
    "crawl_many": cmd_crawl_many,
    "crawl_site": cmd_crawl_site,
    "map_site": cmd_map_site,
    "extract": cmd_extract,
    "links": cmd_links,
    "shutdown": cmd_shutdown,
}

# stdin 读取：daemon 线程 + 队列（非阻塞轮询）。
# 不能 run_in_executor：asyncio.run 结束时会等待默认 executor 的线程结束，
# 而阻塞在 readline 的线程永不返回 → 进程永不退出。
import queue as _queue
import threading as _threading

_line_queue: _queue.Queue = _queue.Queue()


def _stdin_reader() -> None:
    for raw in sys.stdin.buffer:
        _line_queue.put(raw)
    _line_queue.put(None)  # EOF 哨兵


def _start_stdin_reader() -> None:
    _threading.Thread(target=_stdin_reader, name="c4ai-stdin", daemon=True).start()


async def _dispatch(req_id: str, cmd: str, args: dict[str, Any]) -> None:
    handler = HANDLERS.get(cmd)
    if handler is None:
        _err(req_id, f"unknown command: {cmd}")
        return
    try:
        data = await handler(args)
    except Exception as exc:  # noqa: BLE001
        _err(req_id, f"{type(exc).__name__}: {exc}")
        return
    _ok(req_id, data)


async def main() -> None:
    global _semaphore
    _semaphore = asyncio.Semaphore(CONCURRENCY)

    _emit({"id": None, "ok": True, "data": {"hello": True, "concurrency": CONCURRENCY}})

    _start_stdin_reader()

    # 空闲自毁兜底：Node 侧 reload/崩溃泄漏的 worker 进程在此超时后自行退出
    # （含浏览器回收），与 Node 侧 idleShutdownMs 形成双保险，杜绝进程残留。
    idle_timeout = float(os.environ.get("CRAWL4AI_WORKER_IDLE_S", "300"))
    last_activity = time.monotonic()

    shutting_down = False
    while True:
        try:
            raw = _line_queue.get_nowait()
        except _queue.Empty:
            if not shutting_down and time.monotonic() - last_activity > idle_timeout:
                break  # 空闲超时自毁
            await asyncio.sleep(0.2)
            continue
        if raw is None:
            break  # stdin EOF
        last_activity = time.monotonic()
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            _err("", f"invalid JSON: {exc}")
            continue
        req_id = str(payload.get("id", ""))
        cmd = str(payload.get("cmd", ""))
        args = payload.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        if cmd == "shutdown":
            shutting_down = True
        asyncio.create_task(_dispatch(req_id, cmd, args))
        if shutting_down:
            break

    await asyncio.sleep(0.2)  # 让在途响应写完
    await cmd_shutdown({})
    _emit({"id": None, "ok": True, "data": {"bye": True}})
    # 用 os._exit 跳过解释器清理：daemon stdin 线程在退出序列中被终止会产生
    # 访问冲突（Windows）；浏览器已 close、bye 帧已 flush，直接终止进程最干净。
    os._exit(0)


if __name__ == "__main__":
    # 关键：必须在事件循环启动前完成 crawl4ai 的 import。在运行中的
    # Proactor 事件循环（asyncio.run(main()) 内）import crawl4ai 会在
    # Windows 上永久挂起（crawl4ai 0.9.2 已知行为）。此处同步预加载，
    # 之后 _c4() 的 import 命中模块缓存，毫秒级返回。
    import crawl4ai  # noqa: F401
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
