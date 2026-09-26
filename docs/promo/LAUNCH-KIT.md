# Agent-Body — Launch Kit

Everything here is copy-paste ready. Every number was **re-measured on the development machine on
2026-09-26**, and each one ships with the command that reproduces it. If a number is not reproducible
on your machine, don't post it.

> **Read this first — one positioning lesson, from real reader feedback.**
> The two replies the first linux.do post received were polite but pointed: *「听着有点渗人」* (the organ
> framing is uncanny) and *「感觉有点为了器官而器官」* (it reads like organs for their own sake). Both
> readers were reacting to the **metaphor being the headline**.
> **Lead with the checkable engineering result. Let the metaphor be the delivery mechanism, not the pitch.**
> The first line of anything you post should be about the token number, the offline demo, or the closed healing
> loop — not about organs.

---

## 0. The facts you can quote (all re-measured 2026-09-26)

| Claim | Value | How to reproduce |
| --- | --- | --- |
| Tool-schema tokens gated away, cold start | **84.71%** mean (median 85.67%, worst 75.20%) over 48 commands / 256 capability definitions | `npm run bench:check` → must print `与基线一致（23 项指标）` |
| Same figure on a live, warmed-up install | **58%** — 128 of 332 definitions visible, 33,466 / 80,126 tokens | `body_status` → "Token 经济" section |
| Runs with no install, no host, no API key | full chain command → impulse → dispatch → execute → attribution → reflex fire | `npm run demo` |
| Organs on the live install | **43** (29 declared + 14 autonomic) | `body_status` |
| Capabilities claimed by an organ | **332 / 332** (0 orphans) | `body_status` |
| Core kernels depending on no single organ | **6 / 6** green | `body_organ action=integrity` |
| Healing ledger | 200 wounds · **0 open** · 197 healed · 99% · 270 auto-treatments | `body_heal action=list` |
| Self-authored reflex arcs in service | **15 / 15** armed, zero model calls per fire | `body_reflex action=list` |
| CI | 53 success / 27 cancelled (rapid pushes), **0 failures** | GitHub Actions tab |

**Honest caveats to keep attached to the headline** (the README states them; do the same):
- **84.7% is the cold-start scope.** It counts only the tool-schema block of the prompt — not the system
  prompt, not history, not tool results. A body with real run history keeps hot organs resident and saves less (58% live).
- The organ metaphor is a design bet, not a proof. Judge it on the three payoffs in §2.

---

## 1. One-liners

**English (≤140 chars)**
```
Gates 84.7% of tool-schema prompt tokens away for DeepSeek Harness. Verify it offline in 30s: npm run demo
```

**English (Show HN title — ≤80 chars, no hype words)**
```
Show HN: Agent-Body – organ-based plugin layer that gates 84.7% of tool schemas
```

**中文（短）**
```
把 DSH 插件当成器官来写：工具 schema 的提示词 token 砍掉 84.71%，30 秒离线可复现
```

---

## 2. The three payoffs (this is the whole argument — use it, not the metaphor)

1. **Fewer tool schemas in every request.** Capabilities are revealed per turn by intent. On 256 capability
   definitions across 48 representative commands, the tool-schema block drops **84.71%** on average.
   Nothing is lost — everything stays one `body_call` away. `npm run bench:check` fails the build if it drifts.
2. **Removing a plugin must not take the body down.** Six kernels (nerve bus · heart pump · directive layer ·
   reflex engine · dissector · impulse conduction) depend on no single organ. Uninstall a plugin and the
   closest overlapping organ compensates; core integrity stays green. A plugin that was never installed is
   reported *not installed*, not *broken*.
3. **Failures are attributed before anything retries.** Deterministic causes (`tool_missing` / `arg_error` /
   `permission` / `timeout` / `network` / `not_found` / `conflict` / `unknown`) drive a prescription table.
   Read-only remedies run automatically; side-effecting ones wait for the operator. **`arg_error` is never
   auto-retried** — retrying a wrong argument amplifies the mistake. A wound closes only when that organ
   next **succeeds**; the system does not declare itself healed.

---

## 3. Ready-to-post: Chinese (linux.do · V2EX · 掘金 · 知乎)

> linux.do note: 开源推广 posts go through a review queue (the server replies `action: enqueued`) and the
> category expects the **开源推广 / 开源项目** tags plus the project self-declaration form. Replies to an
> existing approved thread do not need the form. Don't post the same project twice in one day.

```markdown
把 DSH 插件当成器官来写：工具 schema 的提示词 token 砍掉 84.71%

装了三十多个插件之后，工具定义本身就是几万 token，每次请求都重发一遍。这个项目做的是按当轮命令的
意图门控显影——基准里 256 个能力定义、48 条代表性命令，冷启动平均只显影 36 个，工具 schema 这块
的 token 均值砍掉 84.71%（中位 85.67%，最差一条 75.2%）。被藏起来的能力没消失，一次 body_call 就能取回。

省多少是能自己验的：

    git clone https://github.com/1420079678-ctrl/agent-body && cd agent-body
    npm run bench:check     # 跟基线漂了就非零退出
    npm run demo            # 不用装 DSH、不用 key，看完整链路

除了省 token，另外两件事是我更在意的：

一是卸掉一个插件不该让整个身体塌。六个内核（神经总线 / 心脏泵 / 主权层 / 反射引擎 / 解剖器 /
冲动传导）不依赖任何一个器官。实测把 dsh-office-docs 卸掉，craft 器官立刻判离线，自动由能力重叠
最高的在线器官代偿，核心完整性还是 6/6。

二是失败先归因再决定要不要重试。不是报错就重试——确定性归因后按处方表处置，只读类自动执行、
有副作用的留给人裁决，arg_error 绝不自动重试。伤口要等那个器官下次真的成功才算闭合，不是自己
宣布自己好了；超过 5 分钟没好就标 chronic 停止空转。同一条「工具 × 病因」失败三次，系统会自己
写出一条反射弧，下次直接开火、零模型调用。

我这台现在的账：43 个器官 / 332 项能力全部被认领 / 架构完整性 6/6 / 伤口 200 个、0 未愈、
197 已愈、99% / 自学反射 15 条在开火。

MIT，仓库里带了完整的基准报告、目录和 CI 门。

https://github.com/1420079678-ctrl/agent-body
```

---

## 4. Ready-to-post: English (Hacker News · Reddit · dev.to)

**Show HN** (HN rewards plain, specific, no marketing voice; put the link in the URL field, not the text):

```
Title: Show HN: Agent-Body – organ-based plugin layer that gates 84.7% of tool schemas
URL:   https://github.com/1420079678-ctrl/agent-body

I run an agent with ~330 tool definitions from ~40 plugins. The tool-schema block of the prompt alone was
~80k tokens, re-sent every request. This project gates it by intent: each turn reveals only the capabilities
that turn is about.

On 256 capability definitions over 48 representative commands, the tool-schema block drops 84.71% on average
(median 85.67%, worst case 75.20%). That's the cold-start scope — with real run history, hot organs stay
resident and I measure 58% live (128 of 332 visible, 33,466/80,126 tokens). The benchmark is in the repo and
fails CI if it drifts.

Two things I care about more than the token number:

- No single plugin is load-bearing. Six kernels (nerve bus, heart pump, directive layer, reflex engine,
  dissector, impulse conduction) depend on no organ. Uninstall a plugin and the closest overlapping organ
  compensates; a plugin that was never installed reports as "not installed", not "broken".
- Failures are attributed before anything retries. arg_error is never auto-retried. A wound closes only when
  that organ next succeeds — the system doesn't declare itself healed.

Nothing outside Node built-ins is imported by the core, so you can run the whole chain offline, no API key:

    git clone https://github.com/1420079678-ctrl/agent-body && cd agent-body
    npm run demo
    npm run bench:check

The project is a plugin layer for DeepSeek Harness, so the live numbers come from that host; the demo and
benchmark run without it. MIT.
```

**Reddit r/LocalLLaMA / r/DeepSeek** — lead with the token number, keep it short, and put the repo link in
the body (not the title). Add the caveat sentence; these subs punish unqualified numbers.

---

## 5. Short thread (X / Twitter / Bluesky)

```
1/ Tool schemas are the quiet tax on every agent request. On a body with ~330 tool definitions, that block
   alone was ~80k tokens, re-sent every call.

2/ Agent-Body gates it per turn by intent. 48 commands × 256 capability definitions: the tool-schema block
   drops 84.71% on average.

3/ Warm install, real history: 58% (128 of 332 definitions visible). Everything gated stays one call away.

4/ The part I actually care about: no single plugin is load-bearing. Six kernels depend on no organ.
   Uninstall one, the closest overlapping organ compensates.

5/ And failures are attributed before retry. arg_error is never auto-retried. A wound closes only when that
   organ next succeeds.

6/ Core imports nothing outside Node built-ins. Verify offline, no API key:
   git clone … && npm run demo

   https://github.com/1420079678-ctrl/agent-body
```

---

## 6. Assets

| Asset | Path | Use |
| --- | --- | --- |
| Social preview card (2560×1280, 497 KB) | `docs/promo/social-preview.png` | GitHub social preview (already set) · OG image · post header |
| Editable source of that card | `docs/promo/social-preview.html` | Re-render after a number changes (`translate="no"` is set on purpose) |
| Demo GIF (1040×660, 82 frames) | `docs/demo/agent-body.gif` | Inline in posts that support images |
| Raw captured facts behind every GIF number | `docs/demo/captured.json` | Proof that the GIF's numbers are not retyped |

Re-render the card after a numbers change:

```powershell
# open docs/promo/social-preview.html in Chrome, set viewport 1280×640 @2x, screenshot
# (the HTML sets translate="no" — Chrome auto-translate WILL otherwise rewrite the copy)
```

---

## 7. Where to post, and what each channel is actually worth

| Channel | Status | Reality check |
| --- | --- | --- |
| **linux.do** (`开发调优` + `开源推广`) | **One post live, 150 views** | The only channel with measured conversion so far: ~150 views → ~9 stars. Posts go through a review queue. Use the "three payoffs" framing, not the metaphor. |
| GitHub repo surface | Done | Description now leads with the token number; homepage points at the live demo; social preview set; 20 topics; CI green. |
| DSH plugin marketplace (`market_search`) | Ranks well | #1 for `organ`, #1 for `heartbeat`, #2 for `self-healing`, #3 for `prompt tokens`. **It ranks by stars — so ranking improves as stars grow.** |
| awesome-list PRs | Low value | Past PRs merged into small lists produced ~0 traffic. Skip unless trivial. |
| DSH official Discussions | Low value | It behaves as a ticket queue, not a discovery surface (#7555 got ~1 upvote in 2 days). |
| Hacker News / V2EX / Reddit | Not attempted | Needs an account. HN signup takes only a username + password (no email); V2EX and Reddit need more. |

**The bottleneck is reach, not conversion.** ~150 linux.do views converted to ~9 stars — that is a healthy
rate. What's missing is a large enough audience seeing it once.

---

## 8. Things not to do

- **Don't claim a bug-free or production-ready state.** The repo states its scope, tested-vs-asserted splits
  and known gaps; contradicting that in a post is the fastest way to lose the technically-minded reader.
- **Don't quote 84.7% without saying "tool-schema block, cold start".** Every number in the README carries its
  scope, because the headline is easy to over-read.
- **Don't post the same project to the same community twice in a day.** Reply inside the existing thread when
  there is genuinely something new; open a new thread only for a new angle, spaced out.
- **Don't lead with organs.** Two readers already told us it reads as a gimmick. That is the single most
  useful piece of feedback this project has received.
