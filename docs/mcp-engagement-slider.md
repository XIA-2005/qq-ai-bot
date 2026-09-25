# 机器人参与积极度滑杆

## 问题

用户反馈「聊天时机器人没有参与进来」。原因不是 bug，而是 `src/proactive.ts` 里五道写死的闸门共同把机器人压成了
一个几乎不说话的旁观者：至少 3 条新消息才判断一次、每群每分钟最多判断一次、两次发言间隔 5 分钟、每小时上限
6 次，外加提示词里那句「默认保持沉默」。这些常数没有任何一处可以由用户调整。

## 方案

把这五个量收敛成一个 0–100 的滑杆，落在 `src/engagement.ts` 这个新模块里，作为唯一的真相来源。

| 锚点 | 0 | 15 | 30（默认） | 60 | 100 |
|---|---|---|---|---|---|
| `freshLines` 判断门槛 | 6 | 4 | **3** | 2 | 1 |
| `checkIntervalMs` | 5 分 | 2 分 | **60 秒** | 45 秒 | 30 秒 |
| `cooldownMs` 发言间隔 | 30 分 | 10 分 | **5 分** | 2 分 | 30 秒 |
| `hourlyLimit` | 0 | 3 | **6** | 15 | 30 |
| 语气 | 从不主动 | 很克制 | 标准 | 积极 | 很活跃 |

锚点之间线性插值后取整。**等级 30 逐字复现改动前的行为**，因此所有老配置和既有测试的期望值不变。

`level===0` 是一个真正的开关而不只是很慢：`hourlyLimit` 归零后，`observe()` 和 `allowed()` 两处都会拒绝，
不存在任何漏网路径，也就不会再为「要不要插话」付 API 费用。

### 语气随滑杆改写

数值只决定判断频率，真正决定模型愿不愿意开口的是提示词。`SESSION_STANCE` 和 `AMBIENT_STANCE` 两张表按
`tone` 给出五档措辞，从「严格保持安静」一路到「像一个熟络的群友那样积极参与」。`balanced` 一档是原句，
逐字未改。

另有一处细节：持续参与模式下，原本只要上一条是机器人自己发的就强制沉默（`SESSION_QUIET`）。只有在
`lively` 一档才解除这个自我禁言，否则高积极度仍然会被这条规则卡住，滑杆拉到头也没用。

## 改了哪些文件

- **新增** `src/engagement.ts` — 映射表、`clampEngagement`、`engagementTuning`、`engagementTone`、两张语气表。
- **新增** `ui/engagement-ui.js` — 浏览器侧镜像，同时用 `module.exports` 导出供测试引用。
- **新增** `tests/engagement.test.cjs` — 7 个测试。
- `src/config.ts` — `Config.engagement`，默认 30，校验区间 `[0,100]` 且必须为整数。
- `src/proactive.ts` — `Proactive` 构造函数接受 `()=>EngagementTuning`；五处常数改为读 tuning。
- `src/group-session.ts` — `PREAMBLE` 拆成 head/stance/tail，`sessionMessages` 多一个可选 `level`。
- `src/engine.ts` — 把 `this.config.engagement` 接到 Proactive 和两个 prompt 构造函数上。
- `ui/index.html` / `ui/app.js` / `ui/workspace.css` — 「回复规则」页的滑杆、实时说明文字与样式。

## 两个刻意的设计决定

**上下文窗口与发言冷却解耦。** 原来 `COOLDOWN` 这一个常数同时用于「多久能再发言」和「保留多久的群聊上下文」。
如果让滑杆同时驱动两者，高积极度会把上下文窗口压到 30 秒，机器人反而因为看不到前文而变蠢。现在拆成独立的
`CONTEXT_WINDOW`，固定 5 分钟。

**UI 镜像有防漂移测试。** `ui/engagement-ui.js` 必须在浏览器里独立运行，无法 import TS 模块，只能复制一份映射表。
测试对 0–100 全部 101 个等级逐一比对两份实现的输出，任何一边改了另一边没跟上，测试立刻失败。

## 验证

- `npm test` → **177/177 通过**（原 170 + 新增 7），0 失败。
- `npx tsc --noEmit` → TSC=0；`get_diagnostics` → 0 条。
- 模拟「每 20 秒一条消息、持续一小时」的活跃群，实测每小时发言次数：
  等级 0 → 0 次，15 → 3 次，30 → 6 次，50 → 12 次，75 → 21 次，100 → 30 次。

## 影响范围

滑杆只作用于「主动接话」和「@ 一次后持续参与」。**被人 @ 时一定会回复，私聊一定会回复**，不受此设置影响。
