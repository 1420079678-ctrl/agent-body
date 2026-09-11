# @dsh-external/dsh-crawl4ai

DSH 世界级网页爬取工具包（v0.2）。在 [crawl4ai](https://github.com/unclecode/crawl4ai) 0.9.x（67K+ star 的开源 LLM 友好爬虫）之上封装**常驻 Python worker**，复用浏览器实例规避每次冷启动开销，提供 5 个模型工具 + 可选 `WebFetchProvider`。

## 工具集（对齐 Firecrawl 四端点 + crawl4ai 深爬）

| 工具 | 能力 | 对标 |
|---|---|---|
| `crawl4ai` | 单页智能抓取：静态 HTTP 自适应 → 失败升浏览器渲染；Pruning 内容过滤净化正文；返回 Markdown + 标题 + 链接统计 | Firecrawl scrape / crawl4ai arun |
| `crawl4ai_crawl` | 整站 BFS 深爬（同域，max_depth/max_pages 上限） | Firecrawl crawl / crawl4ai BFS |
| `crawl4ai_map` | 站点地图：发现站内链接，不下载正文 | Firecrawl map |
| `crawl4ai_extract` | CSS 选择器结构化提取（schema → JSON，本地免费） | Firecrawl extract / JsonCssExtractionStrategy |
| `crawl4ai_links` | 单页出链清单（internal/external + 锚文本） | crawl4ai links |

## 设计取舍（吸收业界先进技术优点、规避缺点）

- **常驻 worker 复用浏览器**：冷启动一次（import+浏览器 ~2s），之后单页抓取 ~0.7s；规避 crawl4ai「每次冷启动秒级~分钟级」的缺点
- **自适应抓取**：`browser=false` 走纯 HTTP（ContentScrapingStrategy），快且省资源；`map_site` 内部 HTTP 优先、失败自动升浏览器；规避「一律开浏览器」的慢与重（吸收 AdaptiveCrawler / Firecrawl 分级）
- **正文净化**：Pruning 内容过滤 + `word_count_threshold` + `exclude_tags`，去导航/页脚/广告噪音（吸收 Trafilatura / readability 优点）
- **深爬/地图保守上限**：`max_depth`、`max_pages`、同域限制，防失控（规避 Scrapy 式无界爬取）
- **结构化提取本地化**：CSS schema → JSON，不引入 LLM 提取策略（规避 API key 与成本；吸收 Firecrawl extract 的 schema 设计）
- **代理/UA 可配**：`proxy` + 自定义 `user_agent`（吸收 Firecrawl 反爬能力）
- **进程卫生**：worker 空闲自毁（默认 5 分钟）+ Node 侧 idle 回收 + reload 同步强杀 + 请求超时强制回收，杜绝 chromium/python 残留

## 配置（cordis.yml / 插件 Config）

| 键 | 默认 | 说明 |
|---|---|---|
| `pythonPath` | `python` | 装有 crawl4ai 的 Python 解释器 |
| `timeoutSeconds` | `60` | 单请求超时（冷启动首个请求自动 3 倍放宽） |
| `idleShutdownMs` | `300000` | Node 侧空闲回收（worker 自身另有 5 分钟自毁兜底） |
| `defaultMaxPages` | `50` | 深爬/地图默认页数上限 |
| `proxy` | `''` | 浏览器代理 URL（如 `http://user:pass@host:port`） |
| `registerAsFetchProvider` | `false` | 注册 `crawl4ai` WebFetchProvider（见下） |

## WebFetchProvider（可选，opt-in）

设置 `registerAsFetchProvider: true` 后注册 `id='crawl4ai'` 的 fetch provider，让内置 `web_fetch` / `web_search` 的源抓取获得渲染 + 净化能力。**必须同时**把 web 侧的 fetchProvider 配成 `crawl4ai`（或设 `DSH_WEB_FETCH_PROVIDER=crawl4ai`），否则与 `http` provider 并存会触发 `WEB_PROVIDER_AMBIGUOUS`。默认关闭，零影响现有 web_fetch。

## Python worker（`lib/_crawl4ai_worker.py`）

行协议 JSON-RPC over stdio：stdin 每行一个 `{"id","cmd","args"}`，stdout 每行一个 `{"id","ok","data"|"error"}`。
命令：`ping` / `crawl` / `crawl_many` / `crawl_site` / `map_site` / `extract` / `links` / `shutdown`。

已知平台坑（均已处理）：
- Windows Proactor 下 `connect_read_pipe` 读 stdin 崩溃 → 改 daemon 线程 + 队列轮询
- **运行中的事件循环里 import crawl4ai 永久挂起** → 提前到 `asyncio.run` 之前同步 import
- daemon 线程 + 解释器退出产生访问冲突 → 退出用 `os._exit(0)`
- 父进程不消费 stderr 会管道死锁 → worker 内静默 logger + Node 侧 stderr ignore

## 构建与注入

```bash
# 可重放脚本（构建 → 提示注入 → 健康检查）
& <DSH_CHECKOUT>\workspace\scripts\replay-crawl4ai.ps1
# 或手动：dev_build_plugin → dev_uninject_plugin(match=dsh-crawl4ai) → dev_inject_plugin
```

健康检查：`python <DSH_CHECKOUT>\workspace\scripts\crawl4ai_worker_probe.py`（ping + shutdown，3 秒内完成）。
