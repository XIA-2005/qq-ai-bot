# QQ AI Bot 工程文件职责索引（源码 v0.9.4）

> **历史基线索引：**以下“207 个文件”和“不执行测试／打包”的统计只适用于当时的 v0.9.4 盘点，不是 v0.9.6 的实时文件清单。新增功能、发布状态和使用方法见 [v0.9.6 说明](releases/v0.9.6-public.md)。

> 盘点日期：2026-09-27。当前工作区：`/d/QQ-AI-Bot`。这是后续任务的**定位索引**，不是功能验收或已运行版本的证明。

## 阅读范围与可靠性

- 以 `git ls-files` 的 **207 个受版本管理文件**为可维护范围：逐一核查 **202 个文本文件**（`package-lock.json` 的 5,242 行也已分段读取）；另外读取 **3 个 PNG 图标的尺寸/格式**。**2 个 EXE 不反编译、不运行**，仅据 `scripts/Launcher.cs`、`scripts/build-launcher.cmd` 和文档说明其职责。
- 分类：根目录/CI 11、`src/` 46、`ui/` 11、`mobile/` 11、`scripts/` 38、`tests/` 44、`tools/` 2、`docs/` 44；每个受管理文件在下表**恰好出现一次**。
- 没有执行应用、测试、QQ 登录、付费模型请求、隧道部署或第三方二进制，也没有读取私人聊天导出/QQ 数据库。实际行为与打包状态仍须在后续具体任务中验证。

## 当前架构（以源码为准）

```text
启动机器人.exe ──选最高且哈希完整的 release-v*/win-unpacked/QQ AI Bot.exe
                           │
                    Electron src/main.ts
                    ├─ src/store.ts / src/config.ts：本机设置、密钥和白名单
                    ├─ src/login.ts → NapCat 子进程 → 本机 OneBot WS (src/onebot.ts)
                    │                                      ↓
                    │     src/engine.ts → src/scheduler.ts → 群上下文/人设/图片
                    │                                      ↓
                    │     src/tracked-model.ts → 预算预留 → DeepSeek → 用量账本
                    │                                      ↓
                    │                     回复整形 → OneBot → QQ
                    ├─ src/preload.ts → ui/：受控 IPC 桌面界面
                    └─ src/web-server.ts (127.0.0.1:5188) → mobile/：PWA/用量后台
                                         ↑
                               可选 HTTPS Named Tunnel
```

关键边界：桌面 IPC 中的启停等控制动作、QQ 管理指令与手机 API 共用 `src/control.ts` 的操作策略；登录、配置保存和预算调整等桌面动作另由 `src/main.ts` 处理。手机配对、设备令牌哈希和幂等写入分别见 `src/remote-access.ts` 与 `src/idempotency.ts`。聊天文字会随模型请求送到 DeepSeek；启用视觉时图片也可能被送出。每日费用护栏只是本机**估算**，不是服务商账户硬上限。外置 NapCat/QQ 文件属于第三方运行时，不是本仓库源码。

## 逐文件职责（207/207）

### 根目录与 CI（11）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `.github/workflows/offline-ci.yml` | GitHub Actions：Windows 离线源码/假服务 CI 与 Ubuntu Chromium PWA 浏览器测试。 |
| `.gitignore` | 排除依赖、编译与发布目录、第三方运行时、日志、配置和私人聊天导出。 |
| `LICENSE` | 项目自身的 MIT 许可；不替代 NapCat 或 QQ 组件各自的许可。 |
| `README.md` | 产品说明、风险提示、安装/构建/测试和目录入口；页首版本号仍写 0.9.3。 |
| `THIRD-PARTY-NOTICES.md` | NapCat/QQ 原生组件的许可声明、来源和不可随公开安装器分发的边界。 |
| `eslint.config.cjs` | 仅为选定 P2 测试与脚本配置增量 ESLint 规则，并非全仓库 lint。 |
| `package-lock.json` | npm lockfile v3：锁定 0.9.4 的依赖树与完整性信息（418 个 package 记录）。 |
| `package.json` | 应用版本 0.9.4、依赖、开发/测试命令和 electron-builder 的 Windows 打包配置。 |
| `tsconfig.json` | 严格 TypeScript 编译设置：src → dist、ES2022、CommonJS。 |
| `启动机器人.exe` | 编译后的 .NET 选包启动器；按版本和 EXE/ASAR 哈希选择完整发布目录，逻辑见 scripts/Launcher.cs。 |
| `配置iPhone固定远程.cmd` | 面向用户的固定域名远程配置入口；拒绝命令行 Token，转交交互式 PowerShell 脚本。 |

### 核心源码（46）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `src/addressing.ts` | 维护机器人已发消息 ID，识别群内 @、引用和点名，决定消息是否确实指向机器人。 |
| `src/admin.ts` | QQ 管理员指令处理器：鉴权后查询状态/余额、管理白名单与人设、群记忆和静音等。 |
| `src/api-account.ts` | 追踪模型 API 的调用状态与余额查询；以密钥身份摘要关联本地验证历史。 |
| `src/auto-reply.ts` | 管理自动开启回复的待启动/手动暂停状态，集中检查连接、知情同意、密钥与白名单前提。 |
| `src/balance.ts` | 只读调用 DeepSeek 官方余额接口，限制重定向、响应大小并严格校验币种与金额。 |
| `src/budget.ts` | 本机估算费用护栏：持久化请求前预留、按日/对象限额、结果结算与异常保守占用。 |
| `src/config.ts` | 配置默认值与校验、OneBot 消息段/表情解析、白名单与群消息路由及知情确认版本。 |
| `src/control.ts` | 桌面、QQ 管理员、手机 API 共用的操作策略边界：启停、名单、人设、积极度和余额。 |
| `src/desktop.ts` | Electron 托盘、关闭到托盘、可选开机启动和 QQ 掉线/恢复通知。 |
| `src/diagnostics.ts` | 按日轮转日志、保留期清理，以及脱敏的本机诊断导出。 |
| `src/engagement.ts` | 把 0–100 积极度映射成主动接话频率、冷却、次数与模型语气。 |
| `src/engine.ts` | 核心消息流水线：路由、群上下文/会话、调度、图片、人设、模型请求、发送和状态持久化。 |
| `src/followup.ts` | 机器人在群里发言后的 90 秒追问窗口、误判次数限制及交给模型的判断提示词。 |
| `src/group-context.ts` | 有界群聊历史与图片缓存，处理引用、提问者/群名片标记和上下文快照恢复。 |
| `src/group-session.ts` | 群里 @ 一次后的多人持续参与状态机、空闲过期、成员标签及会话模型提示。 |
| `src/humanize.ts` | 拟人化思考/打字延时、无价值附和识别、QQ 表情反应和文本空格处理。 |
| `src/idempotency.ts` | 手机写操作的持久化幂等收据：在副作用前记 pending，避免重启或重试时重复执行。 |
| `src/ipc-input.ts` | Electron IPC 输入边界：仅接收普通对象或空载荷，拒绝数组和异常原型。 |
| `src/ipc-origin.ts` | 校验 IPC 发起者是否是预期本地 UI 的 file URL，兼容 Windows 盘符大小写。 |
| `src/login-memory.ts` | 只记住 QQ 号码及“是否记住”选项，不保存密码；支持迁移与清除。 |
| `src/login.ts` | 管理 NapCat 子进程、动态本机端口和令牌、扫码状态轮询、连接与退出。 |
| `src/loop-guard.ts` | 限制其他机器人触发频率，检测群内快速乒乓循环并临时静音。 |
| `src/main.ts` | Electron 主进程总装：Store/登录/OneBot/Engine/预算/远程服务/窗口/IPC 与生命周期。 |
| `src/media-file.ts` | 从受控 QQ 本地 profile/cache 读取图片，阻止原始路径越界及特殊文件。 |
| `src/media.ts` | QQ 图片/表情包引用、CDN 白名单下载与重定向限制、OCR/视觉附件组装及大小边界。 |
| `src/model.ts` | 请求 DeepSeek chat/completions，处理超时/取消、响应大小、错误和 Token 用量解析。 |
| `src/onebot.ts` | OneBot WebSocket 协议客户端：事件与 API、消息拆分/引用/@、表情发送、媒体读取及取消。 |
| `src/persist.ts` | 把 Engine 的群上下文和个人会话记忆防抖写入用户数据目录并在重启后恢复。 |
| `src/persona-history.ts` | 全局人设历史版本、回滚列表、导入/导出格式和有限留存。 |
| `src/persona-layer.ts` | 表情包关键词库、本人语气样本、群记忆便签及向模型请求插入人设补充上下文。 |
| `src/persona.ts` | 人设素材与提示词校验，分片请求模型提炼人设草稿。 |
| `src/preload.ts` | 安全地通过 contextBridge 向桌面渲染进程公开白名单 IPC 调用与状态订阅。 |
| `src/preview.ts` | 按好友/群的独立试聊会话；隔离状态、支持取消，走计费模型但不发送 QQ 消息。 |
| `src/proactive.ts` | 白名单群主动接话的候选累计、冷却/限频与模型 JSON 决策解析。 |
| `src/profiles.ts` | 逐好友/群的备注、启停、人设、记忆和群模式覆盖；计算有效配置与新增授权。 |
| `src/remote-access.ts` | 手机一次性扫码配对、设备令牌哈希/到期/撤销、固定 HTTPS 地址和审计记录。 |
| `src/reply-envelope.ts` | 识别并剥离模型输出的 reply 决策 JSON，阻止内部控制结构泄漏到 QQ 消息。 |
| `src/runtime-verification.ts` | 外置 NapCat 运行时登录前校验文件数、关键 SHA-256 与符号链接，失败拒绝启动。 |
| `src/scheduler.ts` | 按私聊/群分车道合并消息，控制并发、冷却、队列过期、优先级与取消。 |
| `src/shape.ts` | 出站回复的气泡数、每气泡字数、句号与表情数量最后一道整形约束。 |
| `src/store.ts` | Electron 用户目录配置持久化；使用 safeStorage 保护 API Key/令牌，读取后验证配置。 |
| `src/tracked-model.ts` | 所有付费模型请求共用入口：预算先落盘预留，再跟踪账户/用量，失败保留保守预留。 |
| `src/updater.ts` | 查询 GitHub Release、下载与可选 SHA-256 校验更新包，解压为新 release-v* 目录。 |
| `src/usage-analytics.ts` | 在总账之外维护按模型/日期/小时/对象与逐次调用的有界用量报表。 |
| `src/usage-ledger.ts` | 按 Token 和捕获单价做 BigInt 定点估价、累计账本、用途/对象归属及持久化。 |
| `src/web-server.ts` | 仅本机监听的 PWA/用量后台静态服务与手机 API；设备认证、限流、CSP 和幂等写入。 |

### 桌面界面（11）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `ui/account-ui.js` | 桌面 DeepSeek 余额与模型连接状态组件，以及余额刷新交互。 |
| `ui/app.js` | 桌面渲染层总控：页面切换、配置读取/保存、登录/人设/远程配对和状态更新。 |
| `ui/budget.css` | 桌面每日费用护栏面板的输入框与操作区样式。 |
| `ui/engagement-ui.js` | 积极度映射的浏览器侧镜像；由测试与 src/engagement.ts 对齐。 |
| `ui/index.html` | 桌面单页界面的页面骨架、表单、对话框、资源链接与 CSP。 |
| `ui/style.css` | 桌面全局设计系统、基础布局和各主页面通用样式。 |
| `ui/usage-ui.js` | 桌面用量统计、单价设置与每日预算面板的显示和保存交互。 |
| `ui/whitelist-rows.css` | 好友/群/主动接话动态号码行编辑器的对称布局与状态样式。 |
| `ui/whitelist-rows.js` | 动态白名单与主动接话群行组件：增删、校验、备注、建议和去重。 |
| `ui/workspace-ui.js` | 逐对象配置、白名单行关联、独立试聊和桌面设置的页面逻辑。 |
| `ui/workspace.css` | 逐对象弹窗、试聊区域、白名单/工作区及桌面设置的扩展样式。 |

### 手机 PWA 与用量后台（11）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `mobile/app.css` | 手机远程控制 PWA 的布局、按钮、状态和积极度滑杆样式。 |
| `mobile/app.js` | 扫码配对后的手机控制逻辑：设备会话、状态、名单、启停、人设、积极度与重试。 |
| `mobile/apple-touch-icon.png` | 180×180 的 iOS 主屏幕触摸图标。 |
| `mobile/dashboard.css` | 手机/网页用量后台的图表、表格和响应式布局样式。 |
| `mobile/dashboard.html` | 用量后台独立页面：总额、按模型/用途/对象、趋势和调用明细容器。 |
| `mobile/dashboard.js` | 读取统计 API、筛选与绘制报表、明细与 CSV 导出。 |
| `mobile/icon-192.png` | 192×192 PWA 图标，供 manifest 和桌面安装使用。 |
| `mobile/icon-512.png` | 512×512 PWA 图标，供高分辨率安装展示。 |
| `mobile/index.html` | 手机控制与配对入口页面，包括状态、对象、人设及导航骨架。 |
| `mobile/manifest.webmanifest` | PWA 名称、启动路径、显示模式、主题色与安装图标声明。 |
| `mobile/sw.js` | PWA Service Worker：缓存静态壳、离线回退与缓存版本更新。 |

### 构建、部署与验收脚本（38）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `scripts/Launcher.cs` | .NET 启动器源码：扫描完整版本包、验证清单与 EXE/ASAR 哈希后启动最高版本。 |
| `scripts/audit-external-installer.cjs` | 离线审计桌面-only 安装器的资源白名单与 ASAR，阻止 NapCat/QQ/私有配置混入。 |
| `scripts/build-external-runtime.cjs` | 构造无 QQ 运行时的 Windows NSIS 打包配置，输出到 artifacts/external-runtime-v*。 |
| `scripts/build-launcher.cmd` | 用 .NET Framework C# 编译 scripts/Launcher.cs，生成 scripts/launcher.exe 并复制为根目录启动器。 |
| `scripts/check-browser-assets.cjs` | 离线检查桌面/PWA HTML 引用、CSP、禁止内联脚本和浏览器 JS 语法。 |
| `scripts/check-computer-use.ps1` | 本地电脑操作脚本技能的调用/截图完整性自检；不是应用运行时入口。 |
| `scripts/clean-dist.cjs` | 构建前安全删除仓库内的 dist 编译目录。 |
| `scripts/cloudflare-verified.ps1` | 固定 cloudflared 版本与 SHA-256，下载/运行前核验可执行文件。 |
| `scripts/desktop-login-smoke.cjs` | 真实 Electron + QQ 二维码服务的手工冒烟探针；不扫码、不发消息，不属于离线单测。 |
| `scripts/external-runtime-mode.txt` | 桌面-only 包的资源标记；主进程据此改从用户目录找外置 QQ 运行时。 |
| `scripts/install-cloudflare-tunnel.cmd` | 旧 Windows 安装入口兼容层；拒收命令行 Token 并跳转安全交互脚本。 |
| `scripts/launch.cjs` | 开发环境启动 Electron，清理会影响 Electron 行为的继承环境变量。 |
| `scripts/launcher-check.sh` | 用隔离的假包验证启动器选包/哈希逻辑，不连接 QQ 或模型。 |
| `scripts/launcher.exe` | Launcher.cs 编译出的 scripts 目录副本，与根目录启动器同源；本次未反编译。 |
| `scripts/login-smoke.cjs` | 真实 NapCat 运行时二维码生成冒烟脚本；不扫码、不发消息，会输出本地结果。 |
| `scripts/make-release-zip.cjs` | 将完整 win-unpacked 打为更新 ZIP 并写 .sha256，供 GitHub Release 上架。 |
| `scripts/preflight-runtime.cjs` | 打包前离线校验 NapCat 目录关键文件 SHA-256、文件数量与链接安全。 |
| `scripts/probe-usage-dashboard.cjs` | 用本机假控制服务通过 HTTP 探测用量后台资源与统计 API。 |
| `scripts/setup-remote-tunnel.ps1` | 交互配置固定 Cloudflare Named Tunnel/Windows 连接器；涉及管理员权限与用户 Token。 |
| `scripts/smoke-external-desktop.cjs` | 隔离用户目录测试无 QQ 运行时安装包的桌面界面，不安装 NSIS、不调用付费 API。 |
| `scripts/smoke.cjs` | 隔离配置的开发版 Electron 桌面冒烟测试，验证基本 UI/IPC 初始状态。 |
| `scripts/test-cloudflare-verified.ps1` | 用假下载文件离线测试 cloudflared 固定哈希验证与拒绝路径。 |
| `scripts/uninstall-cloudflare-tunnel.cmd` | 调用 PowerShell 卸载脚本的 Windows 包装入口，拒收额外参数。 |
| `scripts/uninstall-cloudflare-tunnel.ps1` | 管理员权限下用经校验的 cloudflared 卸载 Windows 服务，并提示轮换 Token。 |
| `scripts/vendor-runtime.lock.json` | NapCat v4.18.28 本地运行时的最少文件数（700）与 8 个关键文件 SHA-256 锁定清单。 |
| `scripts/verify-account-packaged.cjs` | 历史 v0.8.1 打包包账户/余额状态验收，使用假 API 和隔离用户目录。 |
| `scripts/verify-group-session-packaged.cjs` | 历史 v0.9.0 打包包多人群会话行为验收，使用假 QQ/模型。 |
| `scripts/verify-packaged.cjs` | 历史 v0.2.0 完整 EXE 的基础启动与页面验收脚本。 |
| `scripts/verify-persona-packaged.cjs` | 历史 v0.4.0 打包包人设页面验收，使用隔离用户目录。 |
| `scripts/verify-proactive-packaged.cjs` | 历史 v0.3.0 打包包主动接话配置验收，使用隔离用户目录。 |
| `scripts/verify-scheduler-packaged.cjs` | 历史 v0.7.0 打包包会话调度与设置验收，使用假依赖。 |
| `scripts/verify-session-packaged.cjs` | 历史 v0.5.0 打包包会话/登录记忆相关界面验收，不登录真实 QQ。 |
| `scripts/verify-startup-rows-packaged.cjs` | 历史 v0.6.0 打包包逐行白名单和启动自动回复验收。 |
| `scripts/verify-usage-packaged.cjs` | 历史 v0.8.2 打包包用量/费用界面验收，使用假 API。 |
| `scripts/verify-whitelist-proactive-packaged.cjs` | 历史 v0.9.0 包的白名单与主动接话编辑器布局/交互 CDP 验收。 |
| `scripts/verify-workspace-packaged.cjs` | 历史 v0.8.0 打包包逐对象配置与独立试聊工作区验收。 |
| `scripts/write-launcher-manifest.cjs` | 读取包内 ASAR 实际版本、计算 EXE/ASAR 哈希并写启动器需要的 launch-manifest.json。 |
| `scripts/write-release-report.cjs` | 在离线和浏览器验证通过后生成版本发布摘要及校验/测试数据。 |

### 测试（44）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `tests/_probe.test.cjs` | 开发调试探针：打印 route 在 context/session/ambient 模式的结果，没有严格断言。 |
| `tests/addressing.test.cjs` | 群内 @、引用、姓名呼叫和自身消息 ID 识别回归。 |
| `tests/admin-mobile.test.cjs` | QQ 管理员权限、共享控制策略、手机配对/API 与固定隧道边界回归。 |
| `tests/api-account.test.cjs` | 官方余额读取格式、安全限制与模型状态持久化/错误路径测试。 |
| `tests/budget-image-hold.test.cjs` | 图片输入预算预留按固定风险额、而非 base64 字节长度计费的测试。 |
| `tests/chat-experience.test.cjs` | v0.9.4 回复整形、机器人循环保护、群称呼、记忆保持和群聊体验测试。 |
| `tests/core.test.cjs` | 核心配置验证、白名单/消息路由、模型输出与引擎基础行为测试。 |
| `tests/desktop.test.cjs` | 托盘、关闭行为、开机启动权限及掉线/恢复提醒防抖测试。 |
| `tests/engagement.test.cjs` | 积极度映射、主动接话/群模式语气及桌面镜像一致性测试。 |
| `tests/external-runtime.test.cjs` | 无 QQ 运行时打包配置、外置运行时离线校验与登录前阻断测试。 |
| `tests/followup.test.cjs` | 群发言后追问窗口、误判次数和判断提示词规则测试。 |
| `tests/group-context.test.cjs` | 群 @ 回复携带近期文字/图片、私聊隔离及上下文暂停恢复测试。 |
| `tests/group-media-context.test.cjs` | 引用图片、QQ 旧消息读取、近期图片借用和群成员标记测试。 |
| `tests/group-session.test.cjs` | 群 @ 开启持续参与、他人发言、空闲结束、禁用对象与发送条件测试。 |
| `tests/humanize.test.cjs` | 思考/打字时间、随机扰动、无价值附和与表情反应测试。 |
| `tests/ipc-origin.test.cjs` | Windows file URL 大小写兼容及非预期 IPC 来源拒绝测试。 |
| `tests/login-memory.test.cjs` | 只记 QQ 号的持久化、禁用/遗忘、损坏/无效数据处理测试。 |
| `tests/login.test.cjs` | NapCat 管理端口/令牌、扫码认证哈希与子进程环境保护单测。 |
| `tests/media.test.cjs` | 图片 opt-in、消息图片解析、媒体资源上限、OCR/视觉和路由测试。 |
| `tests/onebot-split-messages.test.cjs` | OneBot 表情段、换行/标点分句、代码块保护与分段发送测试。 |
| `tests/onebot.test.cjs` | 本机假 OneBot WebSocket 的握手、认证、事件和发送/关闭测试。 |
| `tests/p1-guardrails.test.cjs` | 暂停/取消后禁止继续发送、群追问窗口终止等 P1 回归。 |
| `tests/p1-release.test.cjs` | 根目录唯一启动器与假包版本/哈希选包回归。 |
| `tests/p2-budget-ui.test.cjs` | 桌面默认费用护栏的显示、确认保存与失效阻断状态测试。 |
| `tests/p2-budget.test.cjs` | 费用护栏跨重启预留、并发、未知用量、预算溢出与写失败测试。 |
| `tests/p2-idempotency.test.cjs` | 手机操作幂等日志、崩溃恢复、重复请求和失败关闭测试。 |
| `tests/p2-ipc-input.test.cjs` | 桌面 IPC 普通对象载荷与非法原型/数组拒绝测试。 |
| `tests/p2-login-fake-napcat.test.cjs` | 全假 NapCat 扫码、上线、断线重连、停止后过期轮询测试。 |
| `tests/p2-model-budget-gateway.test.cjs` | 统一模型网关对聊天/试聊/验证/人设的预算和记账拦截测试。 |
| `tests/p2-pwa-browser.browser.cjs` | 真 Chromium + 假本地服务：PWA 扫码配对、Cookie、撤销与幂等重试浏览器测试。 |
| `tests/p2-release-report.test.cjs` | 发布报告只接受真实测试统计、校验清单与版本内容的测试。 |
| `tests/persona-layer.test.cjs` | 表情包学习、本人语气样本检索、群记忆与模型消息装饰测试。 |
| `tests/persona-social.test.cjs` | 群名片/语气/记忆注入、出站气泡约束与机器人互相对话防护测试。 |
| `tests/persona.test.cjs` | 人设输入与提炼、旧配置迁移及自动开启/手动暂停门槛测试。 |
| `tests/proactive-and-whitelist-ui.test.cjs` | 动态主动接话群编辑器、号码校验、白名单联动和 CSS 对齐测试。 |
| `tests/proactive.test.cjs` | 主动接话授权、候选门槛、冷却、每小时限频和取消测试。 |
| `tests/profiles-preview.test.cjs` | 逐对象配置迁移与验证、独立试聊隔离/取消测试。 |
| `tests/reply-envelope.test.cjs` | 模型 reply:false/true 控制信封解析及禁止原样发出测试。 |
| `tests/scheduler.test.cjs` | 连续消息合并、按车道并发、队列过期、优先级/取消行为测试。 |
| `tests/software-care.test.cjs` | 日志和诊断脱敏、人设历史回滚、更新包校验/安装单测。 |
| `tests/startup-rows.test.cjs` | 逐行白名单输入校验、启动自动回复状态与保存授权测试。 |
| `tests/sticker-media.test.cjs` | 表情包 CDN 重定向、域名/内网防护、预览回退和本地读取测试。 |
| `tests/usage-analytics.test.cjs` | 模型/时间/对象分摊、统计明细与隐私边界测试。 |
| `tests/usage-ledger.test.cjs` | 定点费用估算、缓存命中、单价验证与未知用量处理测试。 |

### 开发辅助工具（2）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `tools/build-style-samples.cjs` | 从用户自己导出的聊天历史生成本地语气样本文件；涉及私有数据，非产品在线入口。 |
| `tools/computer-use.json` | 外部 computer-use 辅助技能的调用元数据；本次读取的 toolRoot 呈脱敏/乱码，未验证可执行性。 |

### 文档及历史记录（44）

| 文件（仓库相对路径） | 作用 |
| --- | --- |
| `docs/changelog-archive.md` | 多版本产品改动与旧交付记录汇总；页内“当前”须按源码/实际包重新核对。 |
| `docs/current-release.md` | 启动方式和隐私/费用边界说明；当前文本仍称 v0.9.2，与 package.json 0.9.4 不一致。 |
| `docs/mcp-addressing.md` | 群聊判断谁在对机器人说话、点名/引用与句中空格的修复记录。 |
| `docs/mcp-api-balance-status.md` | v0.8.1 DeepSeek 余额查询和模型连接状态修复说明。 |
| `docs/mcp-chat-experience-v0.9.4.md` | v0.9.4 群聊拟人化、人设层与软件关怀的变更/验证记录。 |
| `docs/mcp-computer-use.md` | 外部本地 computer-use 脚本的接入、边界和历史验证记录。 |
| `docs/mcp-conversation-scheduler.md` | v0.7.0 连续输入合并、按会话调度、暂停与参数的设计交付记录。 |
| `docs/mcp-emoticon-recognition.md` | 收到 QQ 表情/表情包时理解情绪的根因、协议解析与修复。 |
| `docs/mcp-emoticon-sending.md` | 把模型输出的表情标记转成可发送 OneBot QQ 表情的实施记录。 |
| `docs/mcp-engagement-slider.md` | 主动接话积极度滑杆从固定阈值到可调映射的设计和验证。 |
| `docs/mcp-followup.md` | 群聊无 @ 追问交给模型判定的方案；附后续费用/窗口语义修订。 |
| `docs/mcp-forced-sentence-split.md` | 模型未换行时按中文标点兜底分句、代码/格式保护与验收。 |
| `docs/mcp-group-context-tests.md` | 群语境功能四个失败用例的成因分流与修复记录。 |
| `docs/mcp-group-media-context.md` | 群里先发图再 @、引用图片以及读取近期群聊上下文的诊断记录。 |
| `docs/mcp-group-session-plan.md` | 群 @ 一次后多人持续参与的早期需求、状态机与实施计划。 |
| `docs/mcp-group-sessions.md` | v0.9.0 群持续参与行为、范围、费用与测试交付记录。 |
| `docs/mcp-humanize.md` | 打字节奏、拟人等待、表情反应、无意义附和与戳一戳的体验改造。 |
| `docs/mcp-implementation.md` | 最初 Electron/OneBot/DeepSeek 版本的实施与联调记录；属历史快照。 |
| `docs/mcp-integrated-login.md` | 内置 NapCat 一体化扫码、动态端口与子进程管理的实施记录。 |
| `docs/mcp-ios-mobile-control.md` | 现行 Safari/PWA 配对与 Cloudflare Named Tunnel 部署手册；部署须核实本机配置。 |
| `docs/mcp-iphone-native-remote-architecture.md` | 历史 SwiftUI 原生 iPhone 客户端设计，未作为已交付原生 App。 |
| `docs/mcp-login-blocker.md` | 曾经缺失 QQ 运行时 DLL 的阻塞排查记录，文首标明现已解决。 |
| `docs/mcp-media-vision-fix.md` | 图片/表情包识别首轮修复的历史根因、媒体链路与安全限制。 |
| `docs/mcp-project-improvement-review.md` | P1 修复前的项目审阅与改进建议；风险状态和版本数据不是当前事实。 |
| `docs/mcp-project-overview.md` | v0.9.0 历史架构全景，包含已过时的端口、测试数和发布版本。 |
| `docs/mcp-reply-envelope-leak-fix.md` | 模型把内部 reply:false 控制 JSON 发进 QQ 的诊断与双层防护修复。 |
| `docs/mcp-reply-message-split.md` | 聊天多段落拆分与 OCR 图文增强的早期设计方案。 |
| `docs/mcp-reply-newline-split-fix.md` | 回复未自动换行导致只发一个气泡的根因与提示词修正。 |
| `docs/mcp-security-audit.md` | v0.9.2 安全复查与修复记录；覆盖范围和结论是当时快照。 |
| `docs/mcp-startup-whitelist-rows.md` | v0.6.0 逐行白名单以及每次启动自动回复的实施说明。 |
| `docs/mcp-sticker-media-fix.md` | QQ 表情包 CDN/本地缓存/静态预览兜底的后续修复记录。 |
| `docs/mcp-target-profiles-desktop.md` | v0.8.0 逐对象配置、独立试聊、托盘与开机启动的交付说明。 |
| `docs/mcp-usage-costs.md` | v0.8.2 按聊天/对象和 Token 单价累计估算费用的设计说明。 |
| `docs/mcp-usage-dashboard.md` | v0.9.0 网页用量后台、模型/时间/对象维度及明细导出的设计。 |
| `docs/mcp-v082-feature-analysis.md` | v0.8.2 功能与技术架构的历史分析快照。 |
| `docs/mcp-version-guide.md` | 2026-09-22 的版本、安装目录与进程状态历史快照，不能当当前启动指引。 |
| `docs/mcp-whitelist-proactive-ui.md` | v0.9.0 白名单/主动接话行编辑器对齐方案；文件本身保留了粘贴的 read_files 包装文本。 |
| `docs/p1-repair-release-0.9.1.md` | v0.9.1 七项 P1 整改和离线验收的历史交付说明。 |
| `docs/release-v0.9.3-desktop-only.md` | v0.9.3 只含桌面界面、不附 QQ/NapCat 的安装器说明及校验值。 |
| `docs/releases/v0.9.2.md` | 自动生成的 v0.9.2 发布校验与测试摘要；不是当前运行实例证明。 |
| `docs/releases/v0.9.3.md` | 自动生成的 v0.9.3 发布校验与测试摘要；不是当前运行实例证明。 |
| `docs/releases/v0.9.4.md` | 自动生成的 v0.9.4 发布校验与测试摘要；实际运行包仍以进程路径为准。 |
| `docs/remote-deployment.md` | 固定远程的示例域名 DNS/Cloudflare 迁移清单，示例值不得直接执行。 |
| `docs/windows-external-runtime.md` | v0.9.3 桌面-only Windows 安装器与用户自行配置外置 NapCat/QQ 运行时说明。 |

## 本轮审查后新增的可维护文件（基线 207 项之外）

下面这些文件是在上述 **207 个受 Git 管理文件的原始盘点之后**加入的，均已读取和核对职责，不能把它们误算作第三方生成物；截至本轮末工作区仍未提交。

| 文件 | 职责 |
| --- | --- |
| `src/backup-archive.ts` | scrypt + AES-256-GCM 流式加密备份、完整认证预览、文件范围/路径校验、临时提取与回滚；包含 QQ/NapCat 档案，排除手机配对设备记录。 |
| `src/config-history.ts` | 保留至多 20 份不含密钥的旧配置，以供预览和明确确认后回滚。 |
| `tests/audit-regression.test.cjs` | 日志脱敏、升级 SHA 和已存在目录、发送气泡及 Unicode 等首轮审查回归。 |
| `tests/audit-profiles.test.cjs` | 逐群真名和逐对象风格/发送约束，以及逐群夜间 QQ 映射授权边界。 |
| `tests/audit-desktop.browser.cjs` | Chromium 隔离验证对象设置对群名片、风格约束及夜间映射确认的表单行为。 |
| `tests/backup-archive.test.cjs` | 纯假资料检验密文、登录档案文件、排除手机令牌、篡改/密码/恶意路径拒绝、回滚与异常残留清理。 |
| `tests/config-history.test.cjs` | 配置版本的有界保留、不含密钥及重读验收。 |
| `tests/backup-ui.browser.cjs` | Chromium 假 IPC 验证密码、导入预览/确认、表情情绪下拉编辑。 |
| `tests/proactive-image.browser.cjs` | Chromium 假 IPC 验证逐张图片的独立授权、取消保存与旧看图间隔禁用，以及群级授权提示。 |
| `docs/feature-audit-2026-09-27.md` | 17 项功能逐项审查与离线/真实验收边界，随本轮实现更新。 |
| `docs/mcp-project-file-map.md` | 本职责索引自身；最初盘点时尚未纳入 Git。 |

本轮还修改既有 `src/group-context.ts`、`src/engine.ts`、`src/persona-layer.ts`、`src/profiles.ts`、`src/store.ts`、`src/main.ts` 和 `ui/` 对应表单等；这些文件在上方原始表中已有条目。离线测试/源码改动**不表示**生成的发布包已经更新。

## 未跟踪/生成目录：按用途归档，不当作源码

以下为**盘点时**已见到的典型目录，数量随构建/本地使用变化；不是对全部磁盘文件作逐个语义审阅：

| 本地目录 | 盘点时文件数 | 用途与处理边界 |
| --- | ---: | --- |
| `release-v0.9.1/`、`release-v0.9.2/`、`release-v0.9.3/`、`release-v0.9.4/` | 801、802、800、800 | 不同版本的 Electron/Chromium 打包文件、`app.asar`、启动清单和 NapCat/QQ 原生运行时；从源码/包配置生成或本机恢复，**不是四套独立源代码**。 |
| `artifacts/` | 494 | 历史截图、假服务验收 JSON、构建/测试日志、打包 ZIP 与校验等。`artifacts/qq-history/` 为私人导出，仅标识其存在，**未读取内容**。 |
| `vendor-downloads/` | 225 | NapCat/运行时下载 ZIP 与 `parts-v41828/` 分段缓存；不据文件名断言来源已核验。 |
| `tools/` 中另外 15 个未受 Git 跟踪的本地脚本 | 15 | 主要为历史消息导出/检查/试验工具；涉及私人数据的工具不运行也不把内容复制进仓库。 |
| `node_modules/`、`dist/`、`vendor/` 等 | 未逐一计数 | `.gitignore` 所排除的依赖、编译输出或第三方运行时；本轮不将其算入 207 个受管理文件。 |

**敏感数据警示：**打包目录的 NapCat 运行时子树可出现 `config.json`、`.db`/`.db-wal`、日志等本机数据。它们不等于可公开的发布素材；后续打包/上传前应另行核验许可、哈希与隐私边界。仓库根目录可见的本机历史导出文件也不在受管理清单中，本轮未读取。

## 后续任务的入口速查

| 需求 | 优先从这里定位 | 对应验证 |
| --- | --- | --- |
| QQ 登录/运行时 | `src/login.ts`、`src/login-memory.ts`、`src/runtime-verification.ts`、`src/onebot.ts` | `tests/login*.test.cjs`、`tests/external-runtime.test.cjs` |
| 回复触发、群聊/拟人化 | `src/config.ts`、`src/engine.ts`、`src/scheduler.ts`、`src/group-*.ts`、`src/shape.ts` | `tests/core.test.cjs`、`tests/group-*.test.cjs`、`tests/chat-experience.test.cjs` |
| 图片/表情包 | `src/media.ts`、`src/media-file.ts`、`src/onebot.ts`、`src/persona-layer.ts` | `tests/media.test.cjs`、`tests/sticker-media.test.cjs` |
| API 费用/余额 | `src/tracked-model.ts`、`src/budget.ts`、`src/usage-*.ts`、`src/api-account.ts` | `tests/p2-budget*.test.cjs`、`tests/usage-*.test.cjs` |
| 桌面与手机远程 | `src/main.ts`、`src/control.ts`、`src/web-server.ts`、`src/remote-access.ts`、`ui/`、`mobile/` | `tests/admin-mobile.test.cjs`、`tests/p2-idempotency.test.cjs`、`tests/p2-pwa-browser.browser.cjs` |
| 发布/升级 | `package.json`、`scripts/build-external-runtime.cjs`、`scripts/write-launcher-manifest.cjs`、`src/updater.ts` | `tests/external-runtime.test.cjs`、`tests/p1-release.test.cjs`、`tests/p2-release-report.test.cjs` |

## 需留意的当前不一致与未验证项

1. `package.json`/`package-lock.json` 是 **0.9.4**，但 `README.md` 页首仍写 **0.9.3**，`docs/current-release.md` 已更正为源码 **0.9.4** 且标明未重新打包；`docs/releases/v0.9.4.md` 是当时生成的发布报告。这些文本都不能替代检查**实际运行进程路径、ASAR 与启动清单**。本轮仅更新当前版本指引和审查报告，其他历史文档保持原样。
2. 多个 `scripts/verify-*-packaged.cjs` 写死 v0.2.0–v0.9.0 的历史包路径；不能不加区分地把它们当作当前 v0.9.4 的验收脚本。`tests/_probe.test.cjs` 是打印结果的调试探针，不是严格断言用例。
3. 本次 MCP 文件读取返回的部分早期“电脑操作”路径呈脱敏/乱码（例如 `tools/computer-use.json` 的 `toolRoot`、`scripts/check-computer-use.ps1` 的默认路径）；**不据此断言原文件损坏**，但在现场核实前也不依赖它们执行操作。`docs/mcp-whitelist-proactive-ui.md` 本身是一次 `read_files` 结果的粘贴封装，内容是历史 UI 方案。
4. 此索引只说明职责与依赖；本轮新增审查报告记录了已运行的离线测试，但仍不表示真实 QQ 扫码、DeepSeek 付费验证、Cloudflare 服务安装或 iPhone 蜂窝网络验收。后续改动时先读受影响文件、确认影响面，再用相关离线测试和诊断验证；真实外部/付费/系统级动作另行征得明确授权。
