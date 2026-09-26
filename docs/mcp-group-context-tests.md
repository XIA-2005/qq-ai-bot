# 群语境功能：4 个失败用例的分类与修复

更新日期：2026-09-26

## 背景

信封泄漏修复（见 `docs/mcp-reply-envelope-leak-fix.md`）落地时，全量测试有 4 个失败，
经 `git worktree` 在基线（HEAD `be05f4e` + 当时的未提交改动）复现，确认全部来自尚未提交的
群语境功能（`src/group-context.ts` 及 `src/engine.ts` 中的 `recordContext`/`contextMessages`
接入），与信封修复无关。本文记录逐个分类与处理。

## 逐个分类

| 用例 | 性质 | 处理 |
| --- | --- | --- |
| `tests/group-context.test.cjs`「mention-mode @ reply reads recent group history」 | 功能 bug | 修代码 |
| `tests/group-context.test.cjs`「private reply keeps its original two-message shape」 | 测试配置错误 | 修测试 |
| `tests/scheduler.test.cjs`「private users and group authors never share merged content or memories」 | 断言过期 | 改断言 |
| `tests/scheduler.test.cjs`「same group uses one lane across authors; separate groups can run concurrently」 | 断言过期 | 改断言 |

### 1. 当前消息没有被排除出群语境（功能 bug）

`src/engine.ts` 的直接 @ 路径用 `contextMessages(recent.filter(l=>l.id!==job.rawMessageId))`
排除"正在回答的这条消息"，但 `recordContext` 写入 `ContextLine.id` 的格式是 `群号:消息号`，
而 `route()` 给出的 `rawMessageId` 只是消息号，两者永远不相等。后果：每次 @ 回复，
当前消息既出现在语境里又作为 user turn 出现，模型看到重复内容。

另一个隐患：调度器把同一作者短时间内的多条消息合并成一个批次（`src/scheduler.ts`
`submit`），合并后的 job 只保留第一条的 `rawMessageId`，即使修正了 id 格式，
批次里第二条起的消息仍会重复出现在语境中。

修复：

- `src/config.ts`：`Accepted` 新增可选字段 `rawMessageIds?:string[]`。
- `src/scheduler.ts`：合并批次时把每条消息的 `rawMessageId` 累加进 `rawMessageIds`。
- `src/engine.ts`：用 `own = {群号:id | id ∈ rawMessageId ∪ rawMessageIds}` 过滤语境行。

新增用例 `tests/scheduler.test.cjs`「a merged group batch keeps every folded message out of
the room context」：先发一条无 @ 的群消息作为语境，再连发三条 @ 消息合并成一个批次，
断言更早的语境行仍在、三条被合并的消息一条都不在语境里、user turn 是三条的合并文本。

### 2. 私聊用例的白名单配置（测试错误）

该文件共享的 `cfg()` 设置 `friends:[]`，私聊消息在 `route()` 里被
`resolveTarget(c,'friend',user).enabled` 拒绝，从未产生模型调用，`inputs[0]` 为 `undefined`。
修复：该用例单独设置 `engine.config.friends=['123456']`，其余群聊用例不受影响。

### 3、4. 调度器用例中「messages 长度恒为 2」的断言（过期）

群语境功能的设计就是让直接 @ 回复带上同群最近的聊天记录（含其他成员的发言），
所以同群多作者场景下 prompt 会多出 2 条消息（语境 system + 语境 user）。
原断言 `m.length===2` 是在功能出现前写的，它真正想保护的是两件事：
私聊内容不进任何人的 prompt、群成员之间不共享记忆（assistant 轮次）。
改为直接断言这两点：

- 私聊 prompt 仍是 2 条；任何 prompt 的语境部分都不包含「私聊」文本。
- 另一作者的 prompt 里没有 `assistant` 轮次（语境可共享，记忆不共享）；
  user turn 仍是它自己的消息。

## 验证

- `npm run ci:offline`（typecheck、browser-assets、eslint、prettier、全量测试）通过：
  322 个用例全部通过（原 321 + 新增 1）。
- `npm run pack:win` 成功，`release-v0.9.2/win-unpacked/resources/app.asar` 于 20:17 重建，
  `launch-manifest.json` 已更新（asar SHA256 以 `28d1b1cc` 开头），
  `docs/releases/v0.9.2.md` 由发布报告脚本重新生成（offline 322/322，PWA 3/3）。

## 改动文件

- `src/config.ts`、`src/scheduler.ts`、`src/engine.ts`
- `tests/group-context.test.cjs`、`tests/scheduler.test.cjs`
