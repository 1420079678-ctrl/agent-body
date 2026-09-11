# @dsh-external/dsh-mirofish

MiroFish「预言家」接入层 —— [666ghj/MiroFish](https://github.com/666ghj/MiroFish)（群体智能预测引擎，盛大孵化）的轻量 DSH 插件。

## 设计：插件 ≠ 引擎

| | 说明 |
|---|---|
| 本插件 | 纯 HTTP 客户端（toolkit 形态），零常驻 worker / 零定时器，运行时 <1MB |
| MiroFish 本体 | 独立重型服务（Python 后端 :5001 + Web 前端 :3000 + OASIS 仿真引擎），按需启动、不用不占内存 |
| 每次对话生效 | 两个工具全局注册进 tools schema；schema 保持极简控制 token 开销 |

## 工具

### `mirofish_status`
服务健康检查 + 项目/模拟列表摘要；离线时返回启动指引。

### `mirofish_api(action, ...)`
预测全流程统一客户端：

```
create_project (种子材料→项目) → build_graph → graph_task(轮询)
→ create_sim → prepare → prepare_status(轮询) → start(maxRounds≤40)
→ run_status(轮询) → report → interview
```

| 参数 | 用于 |
|---|---|
| `action` | 流程步骤（见上链路） |
| `projectId` / `simulationId` / `taskId` | 各步所需 id |
| `prompt` / `maxRounds` | interview 问题 / start 轮数上限 |
| `payload` | 附加请求体（如 `seed_text`、`title`） |
| `path` / `method` | `action=raw` 时自定义透传（上游 API 演化的逃生舱） |

## 典型对话用法

> 「用预言家预测一下 XX 政策发布后的舆情走向」

模型会自动：status 确认在线 → create_project（投喂种子材料）→ … → report 输出预测报告，并可用 interview 与模拟世界中的任意 Agent 对话。

## 部署 / 启动（引擎本体）

```powershell
# 首次部署（需 ZEP_API_KEY + LLM_API_KEY；在普通终端跑，沙箱会拒 esbuild spawn）
workspace\scripts\deploy-mirofish.ps1 -LLMApiKey sk-xxx -ZepApiKey zep_xxx

# 之后启动（Docker 优先，源码兜底；幂等）
workspace\scripts\start-mirofish.ps1
```

## 构建与注入（升级）

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_build_plugin <本目录> → dev_inject_plugin <本目录>
```
