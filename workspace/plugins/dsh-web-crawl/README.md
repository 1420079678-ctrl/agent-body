# @dsh-external/dsh-web-crawl

2026 多引擎网页抓取工具包。**取代 dsh-crawl4ai**——crawl4ai 0.9.2 在本机已完全跑不通：
静态路径报 `ContentScrapingStrategy` 抽象方法缺失，浏览器路径因 playwright 1.58 未装自带
chromium 而 `Executable doesn't exist`（2026-09-11 实测，两条路径都挂）。

## 与 crawl4ai 的技术换代点

| 层 | crawl4ai（2024） | dsh-web-crawl（2026） |
|---|---|---|
| 正文抽取 | 自带启发式 PruningContentFilter | **trafilatura 2.2**（boilerplate 去除标杆）→ precision 档 → markdownify → justext 自适应挑选 |
| 渲染 | Playwright 自带 chromium（需单独下载） | **Patchright**（打过补丁的 Playwright，消除自动化指纹）驱动**本机 Chrome**（`channel=chrome`），失败自动退原版 Playwright |
| 抓取策略 | 静态/浏览器二选一 | **三级级联**：L0 静态 → 判「JS 空壳」才升 L1 浏览器 → L2 Jina Reader 托管兜底（带熔断） |
| 文档 | 无 | **markitdown**：PDF / DOCX / PPTX / XLSX / HTML / EPUB / CSV → Markdown，扩展名靠**魔数嗅探**定 |
| 站点地图 | 纯 BFS 爬链接 | **robots.txt → sitemap.xml（含 index 递归）** + BFS 链接，层级并行 |
| 依赖 | 要求 `pip install crawl4ai` | **自带 vendor/**，不依赖系统 Python 包状态 |

## 工具

| 工具 | 用途 |
|---|---|
| `webcrawl` | 单页抓取（多引擎级联，返回 Markdown + 元数据 + 链接 + 分阶段 timings） |
| `webcrawl_site` | 同域 BFS 深爬（层级并行 + 内容指纹去重 + 深度/页数/全局超时三重上限） |
| `webcrawl_map` | 站点地图（robots/sitemap + 链接发现，不下正文） |
| `webcrawl_extract` | CSS schema 结构化提取（纯本地，零模型调用） |
| `webcrawl_links` | 单页出链清单（复用抓取结果，不二次请求） |
| `webcrawl_doc` | 文档 → Markdown（本地路径或 URL） |
| `webcrawl_http` | 浏览器网络栈裸请求（真实 Chrome TLS 指纹，忽略证书错误） |
| `webcrawl_status` | 引擎健康诊断（浏览器/抽取器/缺失模块/缓存计数），`clear_cache=true` 清缓存 |

## 三个关键设计决定

**1. 抽取走快路径，不走 `bare_extraction`。**
实测同一页面：`extract(output_format='markdown')` ≈ **0.1s 且产出真 Markdown**；
`bare_extraction()` ≈ **7–9s 且只产出纯文本**（它要构建 Document 对象并跑日期解析）；
`extract_metadata()` 更是 12s。元数据改由 bs4 从 meta 标签直读（毫秒级）。
`scripts/selftest_local.py` 里有 ≥3x 的性能闸门，防止有人把主路径改回慢路径。

**2. 短页面上 trafilatura 会退化，必须自适应。**
短页面时 trafilatura 判定内容不足、回退成整页纯文本——带着 nav/footer 杂质、没有任何
Markdown 格式。`favor_precision` 能解决，但长页面上 recall 更好。所以按「谁真的产出了
Markdown 结构」定序挑选：`recall → precision → bs4剪枝+markdownify → justext → 纯文本`。

**3. 「该不该渲染」看脚本占比，不看正文长短。**
`example.com` 只有 113 字符正文但它是完整静态页，不该渲染；真空壳是「正文极少 +
内联脚本占比高」或存在框架挂载点。判据：Cloudflare/DataDome 特征、`enable javascript`
提示、`#root`/`#app`/`#__next`、**内联脚本占比 > 25% 且正文 < 300 字符**、正文 < 200 且
HTML > 8KB。

## 可靠性

- **重试**：L0 静态失败重试一次（本机 DNS 时好时坏，重试救回过多次）。
- **Reader 熔断**：`r.jina.ai` 在部分网络不可达；连续失败 2 次即熔断 600s，避免每次
  auto 模式白等 20s 超时。`webcrawl_status` 会如实报告熔断状态。
- **结果缓存**：LRU + 5min TTL，同 URL+参数重复抓取直接命中（实测 0ms）。
- **文档响应自动路由**：静态响应若是 PDF/XLSX 等，直接走 markitdown，不当网页抽正文。
- **扩展名三级判据**：魔数嗅探 → Content-Type → URL 后缀。很多文档 URL 三者都缺
  （`go.microsoft.com/fwlink/?LinkID=...` 返回 `application/octet-stream` 但字节头是
  `PK\x03\x04`），只有魔数能判对。
- **停止链路**：所有工具接 `exec.signal`，点停止即 `taskkill /T /F` 杀掉
  python + chrome 整棵进程树；空闲超时自动回收。

## 构建 / 重放

```powershell
& <DSH_CHECKOUT>\workspace\plugins\dsh-web-crawl\scripts\replay-web-crawl.ps1
```

会话内注入：`dev_uninject_plugin(match="dsh-web-crawl")` → `dev_inject_plugin(dir=...)`

## 测试

```powershell
python scripts\selftest_local.py        # 46 项离线确定性回归（不碰网络）
python scripts\webcrawl_worker_probe.py # 18 项联网冒烟（含 SPA/Cloudflare/PDF/缓存/深爬）
python scripts\probe_docs.py            # 文档格式覆盖（pdf/txt/html/csv/xlsx/docx）
python scripts\capability_bench.py      # 能力对照实测（抽取快慢路径 / 并行度 / 缓存）
```

`selftest_local.py` 是主力：本机外网不稳（DNS 时通时不通），联网冒烟会时红时绿，离线
套件保证逻辑正确性可复现。联网探针会把 DNS/连接类失败标成 **SKIP**（环境问题）而非
FAIL，只有真正的插件缺陷才算失败。

`capability_bench.py` 遵守三条纪律，否则会得出假数字：**关缓存**做 A/B（缓存键不含
`use_cache`，不关的话第二次全命中缓存、测出来的是缓存不是并发）、**每组取 min**（本机
外网抖动大）、**对照项同进程连续跑**（排除冷启动漂移）。

## 安装依赖的坑（本机特有）

`pip install` 在本机写 `*.whl.metadata` 会被拒（`Errno 13 Permission denied`），稳定
复现、`--target` / `--user` / 重试都无效。`scripts/wheelgrab.py` 绕开 pip：从 PyPI JSON
API 解析依赖、**校验 `Requires-Dist` 的版本约束**、按 `cp313/win_amd64` 标签选 wheel、
urllib 下载、zipfile 解包到 `vendor/`。

**vendor 体积控制**：markitdown 依赖 `magika`，而 magika 拖进 40MB 的 onnxruntime。
`src/shims/magika.py` 用 20 行替身顶掉它（稳定返回 unknown，让 markitdown 退回扩展名
判据）——83.6MB → 40.3MB。同一思路，文档格式判据改用本地魔数嗅探而非 ML 模型。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `pythonPath` | `python` | worker 解释器 |
| `timeoutSeconds` | 90 | 单次工具超时（冷启动自动 ×3） |
| `idleShutdownMs` | 300000 | 空闲回收（防 chrome 常驻） |
| `vendorDir` | `''` | 额外 sys.path（留空自动用插件内 `vendor/`） |
| `browserChannel` | `chrome` | Chrome channel：chrome / msedge / chromium |
| `proxy` | `''` | 所有引擎共用的代理 |
| `readerFallback` | `false` | auto 模式下允许 Jina Reader 兜底 |
| `registerAsFetchProvider` | `false` | 让内置 `web_fetch` 路由到本插件（需 `DSH_WEB_FETCH_PROVIDER=webcrawl`） |
