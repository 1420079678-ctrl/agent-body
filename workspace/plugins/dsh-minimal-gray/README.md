# @dsh-external/dsh-minimal-gray

**极简灰度版（Minimal Gray）Agent 预设** — 技术来源：抖音「用这段提示词，彻底解锁 deepseek」图文。

以 DSH 极简模式为底，用**平台自适应 Shell**（Windows→PowerShell / Unix→Bash）对抗 Windows 不适配 Bash 的问题，并精选文件、搜索、网页、待办、后台任务、技能与目标工具的最小组合。

## 它解决什么

- 极简模式只有 `bash + str_replace_editor`，在 **Windows 上 bash/PTY 不可用**，编码 agent 直接残废。
- 「极简灰度版」在 Windows 自动切到 **PowerShell（tool-pwsh，走宿主沙箱）**，Unix 保留持久 Bash；并补上文件读写、搜索、网页搜索、待办、后台任务、技能、目标等常用工具的最小集。

## 机制

DSH 的 agent preset = `<DSH_HOME>/.agent-presets/<id>/` 下的 `agent.cordis.yml`（+ 可选 `preset.yml`）。发现是**热加载**的——每次读取都重扫根目录，写入后预设选择器立即出现，**无需重启**。

插件注入时自动（幂等）把 `presets/minimal-gray/` 同步到该目录。

## 使用

```bash
# 构建（需 DSH_CHECKOUT 或自动探测到 <DSH_CHECKOUT>\app）
bash scripts/build.sh

# 注入（dsh-super-injector）
# dev_inject_plugin <DSH_CHECKOUT>\workspace\plugins\dsh-minimal-gray
```

注入后：

- 预设选择器出现「极简灰度版」（order 4，在极简模式之后）。
- 工具 `minimal_gray_status` / `minimal_gray_install` / `minimal_gray_uninstall` 可管理预设。

## 预设内容（presets/minimal-gray/agent.cordis.yml）

| 部分 | 内容 |
| --- | --- |
| persona | 完整单行，无运行时上下文（同极简） |
| shell | Windows→tool-pwsh；Unix→持久 Bash（PTY 组，win32 整组关闭） |
| filesystem | 裸本地 fs + str_replace_editor（isolate 域） |
| 精选工具 | tool-fs、tool-fs-search、tool-web（仅搜索）、tool-todo、tool-jobs、tool-ask-user、skill-filesystem、tool-skill、tool-goal |

## 验证

```bash
# 检查预设已安装
Test-Path $env:DSH_HOME\.agent-presets\minimal-gray\agent.cordis.yml
```
