# @dsh-external/dsh-browser-ultimate

无敌浏览器控制：**bb-browser 真实浏览器引擎**（登录态/反爬免疫/CDP 控制）+ **crawl4ai 式内容提取**（正文净化/深爬/结构化）二合一。

不是无头浏览器，是**你的真实 Chrome**：网站以为是你在操作——因为就是你。登录态天然可用、反爬检测无法识别、复杂鉴权页面自己处理。

## 架构

```
DSH web 进程（插件）
  ├─ spawn 真实 Chrome（--remote-debugging-port=9222，独立 profile：登录态持久化）
  ├─ spawn bb-browser daemon（HTTP 127.0.0.1:19824，Bearer token 鉴权）
  └─ 13 个工具经 POST /command 分发
```

- Chrome 用独立 `user-data-dir`（`<dataDir>/chrome-data`），登录态与日常浏览器隔离但持久保存
- `engine.json` 持久化进程信息，重启复用；插件卸载/重启时优雅停机
- 所有 spawn 均 `windowsHide: true`（不弹终端窗口）
- 日志：`<dataDir>/engine.log`（>1MB 自动滚轮）

## 工具清单（13 个）

| 工具 | 作用 |
|---|---|
| `status` | 引擎健康/启动/停止/重启，返回标签页与浏览器版本 |
| `open` | 打开 URL（新标签或当前标签 goto），SPA 等待 |
| `snap` | 页面快照（可访问性树，交互元素带 ref 编号供 click/fill 使用） |
| `act` | 页面交互：click/hover/fill/type/press/scroll/select/check/uncheck |
| `eval` | 页面上下文执行 JS（可读 DOM/调页面函数） |
| `fetch` | 带登录态 fetch（credentials include，同源最稳） |
| `debug` | network 抓包 / console / errors / cookies / source grep / trace |
| `shot` | 页面截图保存 PNG，返回文件路径（可用 read_image 查看） |
| `crawl` | 正文净化抓取（Readability 打分器，登录态下可抓登录后内容） |
| `links` | 页面链接清单（内/外链去重带锚文本） |
| `extract` | CSS 结构化提取为 JSON（schema 驱动，crawl4ai_extract 等价物） |
| `deepcrawl` | 整站 BFS 深爬（登录态，逐页标题/字数/摘要） |
| `site` | 站点适配器：内置 wikipedia/zhihu/bilibili/github + 社区 adapter（list/info/run/update） |

## 典型用法

```text
1. status start          → 启动引擎（首次会自动找 Chrome/Edge/Brave）
2. open https://...      → 打开页面
3. snap                  → 拿可访问性树（元素带 ref）
4. act click ref=...     → 交互
5. crawl url=...         → 抓正文；extract schema=... → 结构化提取
6. fetch url=...         → 带登录态调接口
7. shot                  → 截图
8. status stop           → 关闭引擎（登录态保留在 profile 中）
```

## 配置（Schema 默认值）

| 配置 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `<DSH_HOME>/plugins/dsh-browser-ultimate` | 数据目录（profile/engine.json/日志/截图） |
| `cdpPort` | 9222 | Chrome 调试端口（被占用自动 +1） |
| `daemonPort` | 19824 | bb-browser daemon 端口（被占用自动 +1） |
| `chromePath` | 自动探测 | 手动指定 Chrome/Edge/Brave 可执行文件 |
| `windowSize` | 1920,1080 | 浏览器窗口尺寸 |
| `timeoutMs` | 35000 | 命令超时 |

## 构建与注入

```bash
DSH_CHECKOUT=<DSH_CHECKOUT>\app bash scripts/build.sh   # 编译 src → lib
# 注入器环境内：
dev_build_plugin <本目录>   # 或直接 bash scripts/build.sh
dev_inject_plugin <本目录>  # 注入（若已注入会热重载）
```

冒烟测试（引擎真实链路，需 Chrome）：

```bash
node smoke-test.mjs   # 启动引擎 → open example.com → eval → stop
```

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `未找到 Chrome/Edge/Brave 可执行文件` | 未安装 Chromium 系浏览器；配置 `chromePath` 指定路径 |
| `Chrome 未能在 30s 内就绪` | 杀进程后重试；检查 `chromePath` 是否正确、旧实例是否残留 |
| `bb-browser daemon 未能在 20s 内就绪` | 查看 `engine.log` 尾部；`npm install` 是否完成（依赖 `bb-browser`） |
| `EADDRINUSE` | 端口被占用会自动 +1 重选；若仍报错，手动 `status stop` 清理残留 |
| 登录态失效 | 登录是人工在打开的 Chrome 窗口完成的——`open` 后手动登录一次，之后 Cookie 持久化在 profile 中 |
| 社区 adapter 拉不到 | `site update` 拉取社区适配器后再 `site list` |
