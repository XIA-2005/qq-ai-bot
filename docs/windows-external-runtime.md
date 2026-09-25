# Windows 安装器（仅桌面界面，不含 QQ 运行时）

**适用范围：** `QQ-AI-Bot-Setup-0.9.3-external-runtime.exe` 是单文件 Windows 10/11 x64 NSIS 安装器；可独立安装、打开当前版本的 Electron 桌面设置界面。**安装器不含 NapCat、QQ 本地 DLL、QQ 客户端、账户数据或 API Key。默认不能扫码登录 QQ、收消息或自动回复；桌面界面可用不等于 QQ 功能可用。** 未签名的安装器可能被 Windows SmartScreen 提醒，请先核对发布页 SHA-256，不要忽略来源风险。

## 想要启用 QQ 登录时

1. 先自行确认 NapCat 许可及 QQ 组件的使用条款，仅从有权使用的可信来源准备与 [`scripts/vendor-runtime.lock.json`](../scripts/vendor-runtime.lock.json) 匹配的完整 Windows Node 运行时（NapCat v4.18.28 及匹配的本机 QQ 辅助组件）。NapCat 官方项目：<https://github.com/NapNeko/NapCatQQ>。**仅下载 NapCat 官方 zip 通常不够：它可能不含本应用所需的 QQ DLL。项目方不会在 Release 分发腾讯 DLL，也不会提供规避许可的下载渠道。** 不要从陌生人处拼接文件、修改锁文件或关闭校验。
2. 将所需文件置于 `%APPDATA%\QQ AI Bot\external-runtime\`，例如 `%APPDATA%\QQ AI Bot\external-runtime\node.exe`、`index.js`、`wrapper.node`、`crypto.dll`、`ssl.dll`、`napcat\napcat.mjs`。这一路径会在应用的「QQ 连接」页显示。不能放在安装目录、`resources` 或源码仓库中；也不要把个人 QQ 资料、票据或 API Key 放入运行时目录。
3. **彻底退出并重开** QQ AI Bot。若缺少文件，登录按钮保持不可用；若关键哈希、文件数量或目录结构校验失败，登录时拒绝启动运行时。不会因此自动下载、安装或执行不匹配的文件。锁文件只校验关键文件和最少文件数，**不保证其余文件的来源与安全性**。
4. 登录前阅读应用内风险提示，自行确认 QQ 账号、费用、白名单及知情同意。恢复自动回复还须 QQ 已连接、API Key 和有效白名单；未满足条件不发消息。真实 QQ 登录和付费 API 调用**未经此仅界面安装器的公开发布流程验收**。

熟悉 Node 的开发者可以在源码根目录运行 `node scripts/preflight-runtime.cjs "%APPDATA%\QQ AI Bot\external-runtime"` 预检。完整本地包的 `npm run pack:win` / `npm run dist:win` 仍独立要求 `vendor/napcat-runtime/` 预检；公开的仅界面包使用 `npm run pack:external-win`，不附带任何 `vendor/` 文件。

请勿把两种安装器混淆：公开 Release 若标为 `external-runtime`，**保证的是桌面界面可打开，不保证可用 QQ 登录或自动回复**。
