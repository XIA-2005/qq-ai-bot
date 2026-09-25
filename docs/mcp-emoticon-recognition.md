# 表情包无法识别的根因与修复

## 1. 现象

机器人收到 QQ 表情或表情包时没有任何反应；即使消息里同时有文字，回复也完全不体现对方的情绪。

## 2. 排查

### 2.1 协议层：表情有三种形态

依据 OneBot 11 / NapCat 的消息段规范，表情会以三种不同结构到达：

| 形态 | 段类型 | 关键字段 |
|---|---|---|
| QQ 内置表情 | `face` | `id`（表情编号） |
| 商城表情包 | `mface` | `emoji_id`、`emoji_package_id`、`summary`（表情名称） |
| 商城表情转图片 | `image` | `file: "marketface"` 或携带 `emoji_id`、`sub_type: 1`，附 `summary` |

NapCat 明确说明 mface「以 image 消息段上报（子类型区分）」，因此**只处理 `mface` 是不够的**。

### 2.2 代码层：三种形态一种都没处理

`src/config.ts` 的 `route()` 解析循环原本只有 `text` 与 `image` 两个分支：

- `face` / `mface` 没有分支，整段被静默忽略；
- 商城表情转成的 `image` 落进通用图片分支，OCR 抓不到文字便退化为 `[图片]`；
- 末尾兜底 `if(!text||...||(!hasText&&textParts.every(p=>p==='[图片]')))return null;`
  把「只有图片、没有文字」的消息判定为非对话，于是纯表情消息被彻底丢弃。

实测确认（修复前）：

| 输入 | 结果 |
|---|---|
| 纯 `face` | DROP，机器人无反应 |
| 纯 `mface` | DROP |
| 商城表情转 image | DROP |
| 文字 + `face` | 通过，但**表情被丢掉**，模型只看到文字 |

`summary` 字段本身就携带表情名称（如「开心」「笑哭」），这一现成的语义信息被完全浪费。

## 3. 修复

### 3.1 新增 `faceLabel()`

`src/config.ts` 导出 `faceLabel(segment)`，把任意一种表情形态归一化成 `[表情: 名称]`：

- `face`：查内置 `FACE_NAMES` 表（覆盖约 170 个常用表情 id，如 `178 → 斜眼笑`、
  `179 → doge`、`182 → 笑哭`）；查不到时退回 `summary`，再不行用 `QQ表情` 占位。
- `mface`：直接取 `summary`，缺失时用 `表情包`。
- `image`：仅当带有 `emoji_id`、`emoji_package_id`、`file === 'marketface'` 或 `sub_type === 1`
  这些商城表情特征时才识别为表情，避免把普通照片误判成表情。

`summary` 会剥掉 QQ 自带的方括号（`[菜狗]` → `菜狗`），防止出现 `[表情: [菜狗]]`。

### 3.2 接入解析循环并修正兜底

`face` / `mface` 新增独立分支，`image` 分支优先尝试 `faceLabel()`，命中即按表情处理。
三者都会置 `hasText = true`，使表情被视为**有效对话内容**，不再被末尾兜底丢弃。

普通图片的行为保持不变：有 OCR 文字则为 `[图片文字: …]`，无文字仍返回 `null`
（既有测试 `ignores images only…` 继续通过，说明该设计被有意保留）。

### 3.3 提示词说明

`route()` 是所有链路的统一入口，但三条链路各有系统提示词，均补充了对该标记的解释：

| 文件 | 位置 |
|---|---|
| `src/config.ts` | `defaults.prompt`（私聊与 @ 回复） |
| `src/group-session.ts` | `PREAMBLE`（群持续参与） |
| `src/proactive.ts` | `proactiveMessages`（主动接话） |

要点：`[表情: 名称]` 中的名称即含义，应按情绪与语气理解并自然回应，
不要复述该标记，也不要声称自己看不到表情。

## 4. 验证

`npx tsc --noEmit` 无错误，`get_diagnostics` 0 条，`npm test` **168 pass / 0 fail**
（新增 1 个用例、14 条断言）。

修复后实测：

| 输入 | 结果 |
|---|---|
| `face` id=178 | `[表情: 斜眼笑]` ✅ |
| `face` id=14 | `[表情: 微笑]` ✅ |
| `face` 未知 id | `[表情: QQ表情]`，不再丢弃 ✅ |
| `mface` summary=开心 | `[表情: 开心]` ✅ |
| `image` file=marketface | `[表情: 笑哭]` ✅ |
| `image` 带 emoji_id | `[表情: 狗头]` ✅ |
| 文字 + `face` | `你好 [表情: 斜眼笑]` ✅ |
| 群 @ + 纯表情 | `[表情: 赞]` ✅ |
| 普通图片无 OCR | 仍为 `null`（设计保留）✅ |

## 5. 说明与后续

- 表情名称表是静态的；QQ 新增表情 id 时会退回 `summary` 或 `QQ表情` 占位，
  不会丢消息，但名称可能不精确。需要时在 `FACE_NAMES` 中补充条目即可。
- 本修复让模型「知道对方发了什么表情」，但机器人**回复仍是纯文本**，不会发送表情包。
  若需要让它也发表情，须在 `OneBot.send` 中构造 `face` 或 `mface` 消息段，属于独立改动。
- 普通图片在未接入视觉模型前仍只能依赖 OCR，无文字的照片不触发回复。
