# 群聊看图 + @ 后读上下文：诊断与修复记录

日期：2026-09-26 · 版本：v0.9.2（`release-v0.9.2/win-unpacked`，asar 20:43）· 测试：329/329

## 现象

1. 群里发图片/表情包后 @ 机器人，它说自己看不到图；好友私聊里同样的图可以识别。
2. 群里 @ 机器人时，它不看前面群友聊了什么，答非所问。

两者确实同源：群聊里"图"和"@ 的那句话"几乎总是两条消息，而回复只拿得到 @ 的那一条。

## 根因（按代码核实）

| # | 位置 | 问题 |
|---|------|------|
| 1 | `engine.reply` | 私聊每条消息都是任务，图在任务里；群里图片通常是单独一条消息，只有后面的 @ 是任务，任务里没有图 → 模型被告知"本轮未提供真实图像"。20:17 版只在 3 分钟内借用群里最近的图，且对所有群任务都借（主动接话也走视觉，费钱）。 |
| 2 | `onebot.ts` 事件转发 | 只转发 `post_type==='message'`；NapCat 对机器人自己发出的消息报 `message_sent`，因此机器人的回复从未进入群上下文缓冲，模型看不到"自己刚说过什么"。 |
| 3 | `config.route` | 忽略 `reply`（引用回复）段。用户"引用某张图 + @ 看看"时，无法知道他指的是哪条消息。 |
| 4 | `engine.receive` 会话模式 | 一次 @ 打开持续参与时房间是空的，第一次判断看不到 @ 之前的对话。 |
| 5 | `group-context.ts` | 窗口 5 分钟 / 20 行，慢群里 @ 时前文早已过期。 |
| 6 | `contextMessages` | 提问者自己之前的话被编号成"成员N"，模型分不清哪些是提问的人说的。 |
| 7 | `engine.reply` 历史记忆 | 每人历史把整段群快照（system+JSON）也存进去，下一轮再叠加新的快照，历史里出现多份过期群记录；追问判断的提示词也被存进历史。 |

## 修复

- **引用回复**：`Accepted.quotedId`（`route()` 读取 `reply` 段）。回复时先在缓冲里找被引用的消息，找不到则通过新增的 `OneBot.fetchMessage(id)`（`get_msg`）取回；被引用消息自带的图片优先附加（日志"附加被引用消息里的 N 张图片供识别"），上下文里该行标 `quoted:true`，若已出缓冲则前置显示。取回失败只记日志、按无引用继续。
- **最近图片**：`RECENT_MEDIA_WINDOW_MS` 3→5 分钟；仅"明确 @"（非主动接话 / 会话判断 / 追问判断）才借用群里最近的图，附加时说明来源（`withPreparedMedia(..., origin)`：`message | quoted | recent`），并告诉模型"仅当消息在谈论图片时才结合，否则忽略"。
- **机器人自己的回复进上下文**：`send` 成功后立即 `context.record(... fromBot:true)`；`GroupContext.record` 对 120 秒内同文本（整条或其中一行）的机器人回显去重，NapCat 若日后回显也不会重复。
- **窗口**：30 分钟 / 30 行 / 每行 300 字。
- **标签**：提问者的历史发言标"提问者"，机器人标"机器人"，其余"成员N"；intro 明确要求"接着这段对话的话题和语气"。
- **会话模式**：`rooms.open(..., seed)` 用 @ 之前的群记录（含机器人行，保留"机器人"标签）预填房间。
- **历史记忆**：只存 `[user, assistant]` 对话本身，不再夹带群快照或判断提示词；追问任务的 `roomLines` 改用真实群缓冲（无则退回 proactive.recent）。
- **同步性**：没有引用时 `reply()` 到模型调用前仍是同步的（调度器 abort/合并语义不变）。

## 涉及文件

`src/config.ts` `src/engine.ts` `src/group-context.ts` `src/group-session.ts` `src/media.ts` `src/onebot.ts` `src/main.ts`；
测试 `tests/group-media-context.test.cjs`（新增 7 条）、`tests/group-session.test.cjs`（会话预填后的房间期望）。

## 验证

- `npm test` 329/329；`npm run ci:offline` 退出 0；`npm run pack:win` 退出 0。
- `release-v0.9.2/win-unpacked/resources/app.asar` 20:43，`launch-manifest.json` asarSha256 `74e1b592…` 与文件一致，asar 内含 `fetchQuoted` / `RECENT_MEDIA_WINDOW_MS = 300_000`。

## 实机自检要点

1. 群里先发一张图，1 分钟内 `@机器人 这图是什么` → 日志出现"附加群里最近 1 张图片供识别"，回复能描述图。
2. 引用一张几分钟前的图并 @ → 日志"附加被引用消息里的 1 张图片供识别"。
3. 群友聊几句后 @ 机器人问"你觉得呢" → 回复接着前面的话题；再追问时它记得自己上一条回复。
4. 主动接话（未被 @）不会触发"附加…图片"的日志（不额外花视觉费用）。
