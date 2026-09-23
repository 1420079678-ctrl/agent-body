# dsh-anatomy-panel — 解剖与体征面板（宿主半）

把 Agent-Body 的活体体征挂进 harness 自己的 HTTP 端点，浏览器打开 `http://127.0.0.1:<port>/anatomy` 即可看到：

- **心跳 / 血压 / 器官 / 伤口 / 愈合率 / 自训练**（突触 · 反射 · 技能 · 信任度）
- **器官**：按累计调用量排序，脉冲打到哪个器官那一格会亮一下
- **本体感觉**：真实脉冲流（心跳、肺循环、反射开火、器官调用）

数据**每次请求现读**运行时文件，不是快照：

```
$DSH_HOME/plugins/dsh-organism/
  ├─ bloodstream.json   心跳 / 血压 / 愈合账本 / 学习计数
  ├─ vitals.json        器官体征（[id, 统计] 对）
  ├─ reflexes.json      持久化反射弧
  └─ pulse.jsonl        真实脉冲流（只读尾部 256KB，避免大文件拖慢）
```

## 为什么是宿主半，不是客户端 slot

客户端 slot 的槽位是对的（`sidebar.panellist` + `main` 那一对），但客户端半必须是**模块加载器包裹的打包产物**
（`window.__ModuleLoader__.load({id, factory})`），需要 tsdown/vite 构建链。而体征数据本来就在宿主侧文件里，
用 `ctx.webServer.register` 挂两个路由就能拿到一个**不需要构建、可热注入、可随时卸载**的活体面板。

## 路由

| 路由 | 内容 |
| --- | --- |
| `GET /anatomy` | 自包含 HTML（原生 JS，每 3 秒拉一次 JSON，无外部依赖） |
| `GET /anatomy/data.json` | 上面那些文件的实时投影（器官 / 心跳 / 账本 / 脉冲） |

## 安装（开发期）

```
dev_inject_plugin D:\DeepSeekHarness\workspace\dsh-anatomy-panel
```

卸载：`dev_uninject_plugin @dsh-external/dsh-anatomy-panel`。
若要长期生效，把包注册进 profile 的 `dsh.profile.bundles` 并在改动后跑
`node bin/launch.mjs --check-startup` 验证桌面启动链路。

## 边界

- 只读：不写任何文件，不改变器官行为。
- 数据只在本机流转；`/anatomy/data.json` 与其他 harness 路由同源，靠 harness 自身的访问控制保护。
- 器官未安装时 `/anatomy` 仍然可开，数据接口返回 503 并说明缺哪个目录（不静默显示空面板）。


## 在仓库里的定位

这是一个**宿主半器官**（无 `src/`、无构建步骤）：`lib/index.js` 就是源码，因为面板的全部逻辑是「读运行时文件 → 渲染两个路由」，
没有需要 TypeScript 表达的东西。若要转成 TS，把它当普通器官处理（`src/index.ts` + `tsc`），行为不变。

它依赖 `dsh-organism` 的运行时文件，因此**不随自足器官的 tarball 一起发布**：单独装上它而没装器官时，页面仍可打开，
数据接口会返回 503 并写出缺失的目录，不会静默显示空面板。
