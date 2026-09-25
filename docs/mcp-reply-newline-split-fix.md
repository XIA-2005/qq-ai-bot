# 回复未拆分为多条消息的根因与修复

## 1. 现象

机器人有时把本应分开的两句话作为一条消息发出：

```
看不到
只能看到文字
```

期望是连发两条独立消息气泡：

```
看不到
```
```
只能看到文字
```

## 2. 排查过程

`docs/mcp-reply-message-split.md` 记录的分段能力早已实现，因此先怀疑是回归。取证顺序如下。

### 2.1 分段器本身正常

`src/onebot.ts` 的 `splitReplyMessages` 使用 `masked.split(/\r?\n+/)`，**单换行与空行都会拆分**
（注意：旧文档称"单换行不拆分"，与当前实现不符，以代码为准）。对现网产物 `dist/onebot.js` 实测：

| 输入 | 输出 |
|---|---|
| `看不到\n只能看到文字` | `["看不到","只能看到文字"]` |
| `看不到\n\n只能看到文字` | `["看不到","只能看到文字"]` |
| `看不到只能看到文字` | `["看不到只能看到文字"]` |

分段器与 `OneBot.send` 的顺发逻辑均无缺陷。

### 2.2 真正的根因：模型没有输出换行符

三条回复链路的系统提示词都**从未要求模型分行**：

| 链路 | 提示词位置 | 原文要求 |
|---|---|---|
| 普通私聊 / @ 回复 | `src/config.ts` `defaults.prompt` | "请用自然的纯文本回复" |
| 主动接话 | `src/proactive.ts` `proactiveMessages` | `text` 为"一两句自然的纯文本" |
| 群持续参与 | `src/group-session.ts` `PREAMBLE` | "自然的纯文本，一到两句" |

模型因此把两句话放在同一行返回，`splitReplyMessages` 收到的本就是单行字符串，自然只能发一条。
用户在 QQ 里看到的"两行"是气泡宽度自动折行造成的视觉假象，并非真实换行符。

**结论：缺陷在提示词层，不在分段层。**

## 3. 修复

### 3.1 新增共享指令常量

`src/config.ts` 导出 `SPLIT_INSTRUCTION`，明确要求每个自然句独占一行、行间用换行符分隔、
不使用空行与编号、最多 5 行。放在 `config.ts` 而非 `onebot.ts`，避免 `profiles.ts` 为取一个常量
而依赖 WebSocket 实现模块。

### 3.2 接入三条链路

| 文件 | 改动 |
|---|---|
| `src/profiles.ts` | `resolveTarget` 返回的 `prompt` 末尾追加 `SPLIT_INSTRUCTION`，覆盖私聊与 @ 回复 |
| `src/proactive.ts` | JSON 指令补充"text 里如果有两句话，用换行符 `\n` 分开…最多 3 行" |
| `src/group-session.ts` | `PREAMBLE` 补充同义约束 |

### 3.3 放宽长度上限

`parseProactive` 的字符上限由 240 提升至 280，避免换行符与分行表达把正常回复顶出限制而被判沉默。

JSON 路径限 3 行、普通路径限 5 行，与 `splitReplyMessages` 的 `maxParts = 5` 防刷屏上限一致。

## 4. 验证

- `npx tsc --noEmit`：无错误
- `npm test`：**166 pass / 0 fail**（新增 1 条断言，覆盖"带换行的 proactive 文本原样通过"）
- 端到端实测（走真实 `dist/` 产物）：

| 检查项 | 结果 |
|---|---|
| 解析后的 prompt 含分句指令 | true |
| `splitReplyMessages("看不到\n只能看到文字")` | `["看不到","只能看到文字"]` |
| `parseProactive` 保留换行 | `"看不到\n只能看到文字"` |
| `OneBot.send` 实际发出的气泡 | `["@1 看不到", "只能看到文字"]` |

最后一项同时确认 @ 标签只出现在第一条，后续气泡为纯文本。

## 5. 同步更新的测试

两处断言随规格变更同步，而非绕过失败：

- `tests/proactive.test.cjs`：超长样本由 `x.repeat(241)` 改为 `x.repeat(281)` 以匹配新上限；
  新增带换行文本应原样返回的断言。
- `tests/profiles-preview.test.cjs`：`assert.equal(a.prompt, c.prompt)` 改为
  `startsWith(c.prompt)` + `includes(SPLIT_INSTRUCTION)`。

## 6. 说明与后续

- 本修复通过提示词引导模型输出换行，属于概率性改善而非硬保证；模型偶尔仍可能返回单行。
  若需确定性拆分，需在 `splitReplyMessages` 中加入按句末标点（。！？）的启发式切分，
  但那会影响"刻意写成一句话"的正常回复，需要产品侧决策后再实施。
- 用户自定义 prompt（`TargetProfile.prompt`）同样会追加该指令，无需逐个对象改写。
- 旧文档 `docs/mcp-reply-message-split.md` 第 31 行"单换行不拆分"的描述与实现不符，
  建议后续一并订正。
