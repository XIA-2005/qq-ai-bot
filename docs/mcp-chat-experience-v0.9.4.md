# v0.9.4 · 聊天体验与软件关怀（2026-09-27）

本次改动分四层，全部有离线测试覆盖（`tests/chat-experience.test.cjs`、`tests/persona-layer.test.cjs`、`tests/software-care.test.cjs`、`tests/persona-social.test.cjs`）。设置页「像人一样说话」一栏可开关全部新行为。

## 一、更像群里的活人（引擎 / 上下文）

| 改动 | 位置 | 说明 |
|---|---|---|
| 群名片代替 成员N | `group-context.ts` `group-session.ts` `followup.ts` `proactive.ts` | 群上下文、持续参与、追问判断、主动接话的发言人都用群名片；提问者也用名字。开关 `useRealNames`（默认开）。 |
| 直接回复不再逢人就 @ | `engine.addressMode` `onebot.send` | 一分钟内、中间没别人插话 → 不带任何前缀；有人插话或回得晚 → 用 QQ 引用（`reply` 段）指向那条消息；没有可引用的才 @。合并批次引用最后一条。 |
| 机器人互怼熔断 | `loop-guard.ts` | `otherBots` 名单：它们的话只做背景，被它们 @ 每 10 分钟最多回一次；任何账号与机器人连续 6 条快速一来一回（间隔 <10 s）→ 该群自动静音 5 分钟并私聊管理员。管理员 `#静音 群号 [分钟]` / `#解除静音 群号`。 |
| 群上下文窗口 | `group-context.ts` | 5 分钟 → 24 小时（仍最多 30 条），慢群里 @ 时不再"失忆"。 |
| 主动接话群顺手看图 | `engine.reply` `media.ts` | 自加入的群每 `proactiveImageMinutes`（默认 10）分钟允许看一张群友刚发的图，提示词只允许一句短评。 |
| 发送前硬约束 | `shape.ts` | 不管模型写什么：`maxLines` 条、每条 `maxLineChars` 字（按标点切）、`stripPeriod` 去句末句号、每条最多一个 [表情]。默认全关（0），人设放开时建议 3 / 25 / 开。 |
| 上下文与记忆持久化 | `persist.ts` | 群上下文 + 每人历史 5 秒防抖写入 `engine-state.json`，重启恢复；**暂停/保存配置不再清空上下文**，只有「清空对话记忆」才清。 |

## 二、人设层（`persona-layer.ts`）

- **表情包库**：群里出现过的市场表情（mface）按关键词学到 `stickers.json`，人设/模型写 `[表情包: 汪汪]` 即发送真实表情包；不认识的关键词直接丢弃，不会把字面文本发出去。开关 `stickersEnabled`；`#表情包` 查看已学关键词。
- **动态 few-shot**：`tools/build-style-samples.cjs --in artifacts/qq-history/my-qq-history.json` 生成 `style-samples.json`（本机 930 条），每次请求按词面重叠挑 5 条最像的 + 3 条随机附上，只对齐语气不照抄。开关 `styleSamplesEnabled`。
- **风格尾巴**：`styleTail`（≤300 字）作为每次请求最后一条 system 放在提问之前，利用模型对末尾指令的敏感度防漂移。
- **群记忆本**：`memory/<群号>.md` 纯文本，`#记忆` / `#记住 群号 一句话` / `#忘记`；每次群请求注入前 1500 字。可选 `memoryAutoDistill`：每晚 3 点让模型基于当天记录重写（每群一次请求，走预算）。

## 三、软件本身

- **出事私聊管理员**（`notifyAdmin`）：预算触顶、模型连续 5 次失败、机器人循环熔断、QQ 断线超过 5 分钟后恢复 → 私聊 `adminIds`，每类 30 分钟最多一条。
- **日志落盘 + 诊断包**（`diagnostics.ts`）：脱敏日志按天写 `logs/YYYY-MM-DD.log`，保留 14 天；日志页「导出诊断包」生成 `diagnostics/diagnostics-<时间>/`（版本与包哈希、脱敏配置、引擎计数、最近日志、审计与用量）并自动打开。
- **人设历史 / 导入导出**（`persona-history.ts`）：每次全局人设被替换时旧版进入 `persona-history.json`（最多 20 版），人设页可一键回滚、导出 JSON、导入 JSON/TXT 到草稿。
- **应用内更新**（`updater.ts`）：首页「检查更新」查 GitHub Release；有 `QQ-AI-Bot-vX.Y.Z-win-unpacked.zip`（配 `.sha256`）就可一键下载、校验、解压到当前包旁边的 `release-vX.Y.Z`，正在运行的包不动，下次 `启动机器人.exe` 自动选最高版本。打包后 `node scripts/make-release-zip.cjs` 产出这两个文件用于上传 Release。打包版启动 20 秒后静默检查一次。

## 四、社会性回归（`tests/persona-social.test.cjs`）

固定一段群聊 + 人设配置，断言模型看到的请求结构（人设→记忆/表情包/原话→群名片上下文→风格提醒→提问）、真正发到 QQ 的东西（条数、字数、句号、表情、是否 @）、对其他机器人的免疫和循环熔断、迟到回复的引用行为。以后改引擎，这四条不过就是把体验改坏了。

## 配置项一览（全部有默认值，老配置无需改动）

`useRealNames`(true) `otherBots`([]) `maxLines`(0) `maxLineChars`(0) `stripPeriod`(false) `proactiveImageMinutes`(10) `styleTail`('') `styleSamplesEnabled`(true) `stickersEnabled`(true) `memoryAutoDistill`(false)
