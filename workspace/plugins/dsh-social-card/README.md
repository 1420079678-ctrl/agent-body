# @dsh-external/dsh-social-card

**Guizang Social Card Skill 的 DSH 插件化落地** —— 把「素材」变成小红书图文 / 公众号封面对（21:9+1:1）。

把 [op7418/guizang-social-card-skill](https://github.com/op7418/guizang-social-card-skill) 的「Agent 驱动式设计系统」转成 DSH toolkit 插件：

- **设计智能**（选主题 / 排版配方 / 配色 / 文案压缩）= agent 按插件注入的方法论 + 可读参考文档执行
- **确定性执行**（稳定产出正确尺寸 PNG）= 插件工具

## 工具集

| 工具 | 用途 |
| --- | --- |
| `social_card_docs` | 读取参考文档全文（风格 / 排版配方 / 主题预设 / 组件规范 / 平台规格 / 标题派生 / QA 清单） |
| `social_card_scaffold` | 从种子模板建任务文件夹（复制 index.html + 设主题/accent + assets/output） |
| `social_card_render` | 用 Chrome(CDP) 渲染 index.html 里每个 `.poster` / `.pair-preview` 节点成原生尺寸 PNG |
| `social_card_validate` | 跑 QA 校验器（R1-R9：溢出/页脚碰撞/瑞士粗体/最小字号/4带密度/标题行数/版心擦除/视觉边界/标题间距） |

## 两种视觉模式

1. **Editorial Magazine × E-ink**（6 主题）：`ink-classic` `indigo-porcelain` `forest-ink` `kraft-paper` `dune` `midnight-ink` —— 宋体/衬线大标题 + 纸张墨色 + 氛围层，用于「慢、深思、手作感」。
2. **Swiss International**（4 强调色）：`ikb` `lemon-yellow` `lemon-green` `safety-orange` —— Inter 极轻大字 + mono 小标注 + 左对齐网格 + 细线，用于「工程化、量化、果断」。

**铁律**：瑞士模式「越大越轻」——大字不加粗（默认 200-300），禁止 80-120px @ weight 700-900。

## 板尺寸（种子模板已写死）

| 类 | 尺寸 | 用途 |
| --- | --- | --- |
| `.poster.xhs` | 1080×1440 | 小红书 3:4 |
| `.poster.square` | 1080×1080 | 微信方封面 1:1 |
| `.poster.wide` | 2100×900 | 微信主封面 21:9 |
| `.pair-preview` | — | 21:9 + 1:1 并排预览 |

## 标准工作流

1. **Intake**：收集目标平台/比例、源文案、小红书类目、素材图/截图、视频资产、风格偏好、硬约束。用户只给文字没图时，**先问一次**（A 自己照片/截图 / B Pexels/Unsplash / C AI 生成），只问一次。
2. **Extract The Story**：转页计划。小红书 P1 封面钩子 + P2-N 每页一观点（5-9 页）；公众号必出 21:9 + 1:1 配对。
3. **Choose Style Mode**：editorial 或 swiss + 一个主题。
4. **Plan Pages**：内部计划（hook / 观点 / 关键文案 / 视觉证据 / 版式意图）。
5. **Seed**：`social_card_scaffold taskName mode=… theme=…` → 编辑 `index.html`，替换 `<!-- POSTERS_HERE -->` 为每页 `<section class="poster …">`（用 layout-recipes 的 M01-M16 / S01-S12）。**不要从零写 HTML**。
6. **Render**：`social_card_render <taskDir>` → `output/*.png`（返回实际像素尺寸）。
7. **Deliver**：默认先给用户看图 + 一句话总结；用户要核查才跑 `social_card_validate`。**别每次都跑校验器拖慢交付**。

## 渲染引擎原理

- **定位 Chrome**：`DSH_SOCIAL_CARD_CHROME` 环境变量 → 系统 Chrome/Edge → `ms-playwright` 缓存 chromium。
- **连接方式**：优先连已运行 chrome 的 CDP（`:9222` 等）；找不到则自己 `spawn(--headless=new --remote-debugging-port=N)`（`stdio:'ignore'` 规避沙箱管道 EPERM）再 `connectOverCDP`。
- **节点截图**：`element.screenshot()` 按元素原生尺寸输出 PNG（`.xhs`→1080×1440 等），支持 `scale` 高清倍率。
- **字体**：模板依赖 Google Fonts（Noto Serif SC / Playfair / Inter / IBM Plex Mono）+ WebGL 墨水背景；渲染前 `waitForTimeout` + `document.fonts.status==='loaded'` 等待。

## 构建与注入

Windows（推荐，无需 WSL bash）：
```powershell
pwsh -NoProfile -File scripts\build.ps1 -Checkout <DSH_CHECKOUT>\app
dev_inject_plugin <DSH_CHECKOUT>\workspace\plugins\dsh-social-card
```

依赖：`Node` + 本机 `Chrome`（或 `Edge`）+ 插件 `node_modules\playwright-core`（已随副本安装）。

## 架构

```
src/index.ts         插件入口：apply(ctx,config) 注册 4 工具 + 注入系统提示方法论
assets/template-editorial-card.html   杂志模板种子
assets/template-swiss-card.html       瑞士模板种子
assets/magazine-bg-webgl.js           WebGL 墨水背景（editorial 氛围层）
assets/screenshot-backgrounds/*.webp  主题背景图
references/*.md       16 篇设计系统参考文档
validate-social-deck.mjs  QA 校验器（R1-R9）
scripts/build.ps1      Windows 原生构建（复刻 build.sh）
```
