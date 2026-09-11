# @dsh-external/dsh-dingtalk-bridge

钉钉线上桥连服务：Stream 长连接接收钉钉机器人消息，转发给 DSH LLM 并回复。

**零公网 IP、零端口映射**：走钉钉 Stream 模式（WebSocket 出站长连接），
钉钉开放平台主动推送消息到本机，回复经消息自带的 `sessionWebhook` 送达。

## 已实现功能

- 钉钉 Stream 协议客户端（零运行时依赖：Node ≥21 内置 fetch + WebSocket 实现）
  - `gettoken` → `connections/open` → WebSocket 长连接，自动重连 + 心跳
- 消息桥接：钉钉群聊 @机器人 / 单聊 → DSH LLM → 回复
- 会话记忆：按 conversationId 保留最近 N 轮上下文（内存）
- 命令：`/help` `/status` `/clear`
- Web 面板（conversation.view「钉钉桥连」标签）：连接状态灯、收发统计、
  最近消息日志、连接/断开/自检按钮（3s 轮询 host API）
- Host API：`GET/POST /dingtalk-bridge/api/{status,connect,disconnect,test}`

## 配置

| 配置项 | 说明 | 默认 |
|---|---|---|
| `clientId` | 钉钉企业内部应用 AppKey | 空（可环境变量 `DINGTALK_CLIENT_ID`） |
| `clientSecret` | 钉钉企业内部应用 AppSecret | 空（可环境变量 `DINGTALK_CLIENT_SECRET`） |
| `autoStart` | 启动即自动连接 | `true` |
| `provider` / `model` | LLM 路由（留空自动探测） | 自动 |
| `systemPrompt` | 机器人 persona | 内置中文助手提示 |
| `maxTokens` | 单条回复上限 | 512 |
| `historyPerChat` | 每会话记忆轮数 | 6 |
| `onlyAtMention` | 群聊仅响应 @机器人 | `true` |
| `replyPrefix` | 回复前缀 | 空 |

配置入口（任选）：
1. profile `cordis.patch.yml` 按 entry id 写 `config:`（重启生效）
2. 环境变量 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET`（重启生效）
3. 运行时：注入器 loader `entry.update({ config }, false, true)` 热更新

## 钉钉侧准备（一次性）

1. [钉钉开放平台](https://open.dingtalk.com) 创建**企业内部应用**（或使用已有）
2. 记录「凭证与基础信息」的 **AppKey / AppSecret**
3. 应用需具备**机器人**能力（应用功能 → 机器人与消息推送）
4. 把 AppKey/AppSecret 配进插件（见上）

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh     # host 编译
node scripts/build-client.mjs                      # client bundle（免依赖）
# 注入器环境内：
dev_build_plugin <本目录>
dev_inject_plugin <本目录>
dev_reload_package dsh-dingtalk-bridge             # 改配置/代码后热重载
```

## 卸载

```bash
dev_uninject_plugin dsh-dingtalk-bridge
```
