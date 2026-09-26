# 安全与缺陷复查（v0.9.2，2026-09-26）

范围：`src/` 全部 38 个文件（约 4000 行）逐文件阅读，重点是命令执行、网络出口、文件读写、IPC、密钥、远程控制面板、管理员指令、模型输入输出边界、费用控制；`ui/`、`mobile/` 只查 DOM 注入点。方法：模式扫描（exec/spawn/eval/innerHTML/nodeIntegration…）+ 数据流人工复核 + 针对每个确认问题补回归测试。

## 一、修复的问题（已打进 21:15 的包，asar `8ce36418…`）

| # | 严重度 | 位置 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | **高（功能/费用）** | `budget.ts` `reservation()` | 预算预留把请求 JSON 的字节数当 token 数，图片 base64 也被算进去：一张 300 KB 照片≈¥0.8 预留 > 默认每对象 ¥0.50，≥1 MB 直接超每日 ¥2 → 只要带稍大的图，回复就以「预算已达上限」失败。用户当前配置正是 ¥2 / ¥0.50。 | 估算时把 `image_url` 部分替换成短占位，每张图固定预留 1024 token（DeepSeek 文档每图 ≤384 token，留 2.6 倍余量）；真实用量回报后照旧结算。新增 `tests/budget-image-hold.test.cjs`：4 张 1 MB 图预留仍为 ¥0.05 底线。 |
| 2 | 中（越权/隐私，纵深防御） | `onebot.fetchMessage` | 引用回复的 `get_msg` 只按消息 id 取，没有校验取回的消息属于当前群。NapCat 的 reply 段正常只指向同一会话，但若 id 映射异常/被构造，可能把私聊或其他群的内容和图片带进本群回复。 | 只接受 `^-?\d{1,20}$` 的 id；返回结果若 `message_type!=='group'` 或 `group_id` 与请求群不符一律丢弃；`route()` 也只保留格式合法的 quotedId。测试覆盖私聊/他群/非法 id。 |
| 3 | 中（策略一致性） | `engine.fetchQuoted` | 被引用消息的发送者若在屏蔽名单里，其文字和图片仍会送进模型（`recordContext` 对屏蔽用户是跳过的）。 | 与 recordContext 同一套门槛：非法 QQ 号或屏蔽用户 → 视为无引用。测试覆盖。 |
| 4 | 低（费用） | `engine.reply` | 主动接话任务也会触发引用消息的 `get_msg` 查询（结果根本用不上）；追问判断的房间行数不设上限（30 行）。 | 引用查询限定非主动任务；追问判断只带最近 12 行。 |
| 5 | 低（正确性） | `scheduler.ts` 合并批次 | 同一人 1.5 秒内两条消息合并时，只保留第一条的 `quotedId`，第二条引用的图找不到。 | 合并时保留任一条的 quotedId。测试覆盖。 |
| 6 | 低（正确性） | `group-context.ts` / `onebot.send` | 有人引用机器人自己的某条气泡时，缓冲里的机器人行没有 QQ 消息 id，只能再调 `get_msg`，且上下文里会出现重复的一行。 | `OneBot.send` 返回各气泡的消息 id，机器人行以 `alias` 记录；`find` 与回显去重优先按 id 精确匹配，文本去重只作为没有 id 时的兜底，且发送时写入的行永不被去重掉。测试覆盖。 |

## 二、复核后确认没有问题的面（不需要改）

- **Electron 面**：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`；preload 只暴露白名单 channel；每个 IPC 处理器校验 `sender===主窗口` + `senderFrame===mainFrame` + file URL 精确匹配；拒绝所有权限请求、新窗口、导航、webview；渲染端 `ui/*.js` 没有 innerHTML。
- **密钥**：API Key / NapCat token 只经 `safeStorage` 加密落盘（0600），拒绝明文；日志、审计、幂等日志、预算文件均不含正文或密钥（已有测试断言）。
- **网络出口**：模型只允许 `https://api.deepseek.com`（`redirect:'error'`，1 MB 响应上限，超时）；余额同理；图片只允许 QQ CDN 域名白名单，逐跳校验重定向、`credentials:'omit'`、大小/格式按字节魔数判断，禁 SVG/HTML；本地缓存读取做 realpath 目录包含检查。
- **手机控制面板**：仅监听 127.0.0.1，Host 头白名单（防 DNS rebinding），配对秘密 32 字节随机 + 5 分钟有效，设备令牌只存哈希、`timingSafeEqual`，`__Host-` Cookie `SameSite=Strict`，写操作要求 JSON Content-Type + Idempotency-Key（跨站表单无法构造），按 IP/设备限速，请求体 16 KB 上限，CSP/COOP/CORP/nosniff 齐全。
- **管理员指令**：只接受私聊、`adminIds` 白名单 QQ（`user_id` 由 NapCat 给出，群成员无法伪造），指令参数全部正则校验，经 `ControlService` 统一审计。
- **模型输出到 QQ**：只生成 text/face 段，`@` 仅指向提问者，决策路径拒绝 `[CQ:` 与 `@全体`；内部决策 JSON 有三层兜底不会漏到群里。
- **资源边界**：上下文/历史/去重表/会话/审计/用量文件均有上限；消息文本 4000 字、图片 4 张、每图 5 MB、总 12 MB、12 秒。

## 三、建议（未改代码）

1. 本机工作目录里 `tools/inspect-msg.cjs` 等临时探针脚本（未纳入仓库）内写死了 NapCat WebSocket 的 access_token，而 `tools/` 未被 .gitignore 忽略；令牌每次登录都会轮换所以当前无风险，但建议删除或加入忽略，避免误提交。
2. 直接 @ 时借用「群里最近 5 分钟的图」是按时间而非按语义判断，若 @ 的内容与图无关会多花一次视觉输入（已在提示里要求模型忽略）。如觉得费用敏感，可把 `RECENT_MEDIA_WINDOW_MS` 调小。
3. 群成员通过对话诱导模型复述人设提示词属于大模型固有风险，代码层已把群聊数据标注为「非指令」，无法完全杜绝；人设里不要放敏感信息。
4. 编辑器报 `moduleResolution=node10` 在 TypeScript 7 弃用，项目自带 tsc 仍正常；升级 TS 时需要迁移。

## 四、验证

- `npm test` 334/334（新增 5 条回归测试）；`npm run ci:offline` 退出 0（含 prettier 对 budget.ts 的格式检查）；`npm run pack:win` 退出 0。
- `release-v0.9.2/win-unpacked/resources/app.asar` 21:15，`launch-manifest.json` asarSha256 `8ce36418…` 一致。
