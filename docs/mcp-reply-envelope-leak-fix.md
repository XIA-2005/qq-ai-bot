# 修复：机器人偶发把 {"reply":false} 当作消息发出

更新日期：2026-09-26（第二轮，取代同日早些时候的第一版分析）

## 现象

群聊或私聊里，机器人偶尔把内部决策结构 `{"reply":false}`（少数情况是
`{"reply":true,"text":...}`，或带 Markdown 代码块的同类内容）原样发进聊天，
而不是保持沉默或只发正文。第一版守卫落地后用户仍然看到该现象。

## 根因（两层）

### 1. 运行中的程序根本不包含守卫

- 日常入口 `启动机器人.exe` 启动的是 `release-v0.9.2/win-unpacked/QQ AI Bot.exe`，
  它加载 `release-v0.9.2/win-unpacked/resources/app.asar`。
- 该 asar 构建于 2026-09-24 09:43，`grep -c unwrapReply` 结果为 0；第一版守卫
  （`src/proactive.ts` 的 `unwrapReply`，2026-09-26 19:22）只存在于源码和 `dist/`。
- 结论：修复从未发布到用户实际运行的包，所以"修了还在发"。

### 2. 第一版守卫只认"整段恰好是合法 JSON"

`unwrapReply` 旧实现要求 `trim()` 后首字符是 `{` 且整段 `JSON.parse` 成功。
模型格式漂移的常见形态全部漏过，并被 `src/onebot.ts` 的 `splitReplyMessages`
按行拆成独立气泡发出：

| 模型输出形态 | 旧守卫 | 结果 |
| --- | --- | --- |
| ```` ```json\n{"reply":false}\n``` ```` | 首字符是反引号，原样放行 | 发出代码块 |
| `好的呀\n{"reply":false}` | 首字符不是 `{` | 第二个气泡是信封 |
| `{"reply":false}\n（这条不是在跟我说话）` | `JSON.parse` 失败 | 信封 + 内心独白一起发出 |
| `{reply: false}` / `{'reply': false}` / `{“reply”：false}` | `JSON.parse` 失败 | 发出 |
| `{"reply":false}\n{"reply":false}` | `JSON.parse` 失败 | 发出两次 |
| `reply: false`（花括号丢失） | 无花括号 | 发出 |

同时存在一个自我强化回路：泄漏的信封作为机器人自己的消息被 OneBot 回显，
`src/engine.ts` 的 `recordContext` 把它记进 `GroupContext`，`contextMessages`
再以"机器人：{"reply":false}"的形式喂回给模型，模型据此学会"我会这样说"。

决策路径（`src/group-session.ts`、`src/followup.ts`、`src/proactive.ts` 的 JSON 模式）
本身不会泄漏——`parseProactive` 解析失败即沉默——但同样因为过严，带代码块的
`{"reply":true,"text":"..."}` 会被当成失败而丢掉一次本该有的回复。

## 修复

新增 `src/reply-envelope.ts`，把"信封识别"收敛为一个模块，并在三层接入：

1. 引擎层（`src/engine.ts`，发送前）：`unwrapReply(answer)`
   - 任何位置出现 `reply:false` 信封（裸露、代码块内、混在正文行中、宽松 JSON、
     `reply: false` 裸标志行）→ 整段按沉默处理，记录日志
     「模型输出为内部决策结构，按沉默处理」。
   - `reply:true` 信封 → 用其 `text` 原位替换（保留同段其它正文行）。
   - 不含 `reply` 标志的文本（包括普通 JSON）原样放行。
2. 传输层（`src/onebot.ts` `OneBot.send`）：拆分后的每个气泡再过一遍
   `looksLikeDecision`，是决策残片就不发。这是唯一通往 QQ 的出口，作为兜底，
   保证将来新增的发送路径即使忘记消毒也不会把信封发出去。
3. 语境层（`src/engine.ts` `recordContext`）：机器人自己的回显消息若形似决策信封，
   不记入 `GroupContext`，切断模仿回路。

`parseProactive`（决策路径）改用同一套容错解析 `parseDecision`：代码块、前后杂文、
`"reply":"true"` 字符串标志都能识别；纯文本（模型无视 JSON 指令）仍然沉默，
280 字符上限与 `[CQ:`/`@全体` 过滤不变。

## 改动文件

- `src/reply-envelope.ts`（新增）：`stripFence`、`isEnvelopeLike`、`looksLikeDecision`、
  `parseDecision`、`unwrapReply`
- `src/proactive.ts`：`parseProactive` 改用 `parseDecision`；`unwrapReply` 改为从
  `src/reply-envelope.ts` 转出口，引擎导入路径不变
- `src/engine.ts`：`recordContext` 跳过形似决策的机器人回显
- `src/onebot.ts`：`send` 过滤决策残片气泡
- `tests/reply-envelope.test.cjs`（新增，8 个用例）：负信封全部形态沉默、正信封各种
  包裹只取正文、普通文本与无关 JSON 原样通过、决策路径容错、传输层兜底、
  直接 @ 路径不泄漏、回显信封不进语境
- `tests/proactive.test.cjs`：原「strict model decision」用例改为：代码块与字符串标志的
  正信封计为有效回复，其余（纯文本、负信封、空文本、超长、CQ）仍沉默

## 验证

- `npm run typecheck` 通过；`get_diagnostics` 无告警。
- `npm run build` 通过，`dist/reply-envelope.js` 已生成。
- `node --test tests/reply-envelope.test.cjs`：8/8 通过。
- `node --test tests/*.test.cjs`：首轮 321 个用例，317 通过，4 失败。这 4 个失败在本次
  改动之前就存在（已在 `git worktree` 基线上复现），全部属于尚未提交的群语境功能，
  与信封修复无关；随后已单独处理，见 `docs/mcp-group-context-tests.md`。
  处理后 `npm run ci:offline` 通过，322/322。

## 部署说明（必须做，否则修复不生效）

源码经 `tsc` 编译到 `dist/`，但用户实际运行的是打包产物：

1. 退出正在运行的 QQ AI Bot（托盘退出），否则 `win-unpacked` 内文件被占用。
2. 在仓库根执行 `npm run pack:win`（含 `preflight:runtime`、`build`、electron-builder、
   `launch-manifest.json` 与发布报告）。需要安装包时再执行 `npm run dist:win`。
3. 重新通过 `启动机器人.exe` 启动，在桌面「运行概览 → 当前实际运行包」核对
   `app.asar` 哈希已变化。
4. 验收：`grep -c unwrapReply release-v0.9.2/win-unpacked/resources/app.asar` 应大于 0。

## 后续可选

- 直接 @ 路径的系统提示里可以补一句「直接用聊天正文回复，不要输出 JSON 或
  {"reply":...} 结构」以降低漂移频率；本次未加，因为多处测试断言直接路径的
  messages 结构，需要连同测试一起调整。
- ~~修正上面列出的 4 个群语境相关失败用例。~~ 已完成，见 `docs/mcp-group-context-tests.md`。
