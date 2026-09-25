# QQ AI Bot v0.9.3 · Windows 桌面界面预发布

**这是仅含桌面界面的 Windows 10/11 x64 安装器。** 下载 `QQ-AI-Bot-Setup-0.9.3-external-runtime.exe` 即可安装并打开新版桌面设置界面；**不附带 NapCat、腾讯 QQ DLL、QQ 客户端、账户资料或 API Key**。在你自行合法准备、安装与锁定清单匹配的第三方运行时之前，**无法扫码登录 QQ，也无法接收消息或自动回复**。不要将“界面可打开”理解为“QQ 功能已开箱即用”。

## 下载校验

安装器大小：**94,762,197 字节**。SHA-256：

```text
56adc5418f02a0d9dd4404efaf285b5f8765f532ca57084e10c019b1ea2c7d0e  QQ-AI-Bot-Setup-0.9.3-external-runtime.exe
```

发布页另附 `SHA256SUMS.txt`。安装器**未做 Authenticode 代码签名**，Windows SmartScreen 可能提示；核对来源与哈希后再决定是否安装。

## 如需启用 QQ 功能

按照 [Windows 仅界面安装器与外部运行时说明](https://github.com/XIA-2005/qq-ai-bot/blob/v0.9.3/docs/windows-external-runtime.md)，从你有权使用的可信来源自行准备完整运行时，放在应用显示的本机用户数据路径（通常为 `%APPDATA%\QQ AI Bot\external-runtime\`），彻底退出并重开。登录前会按随安装器附带的清单校验关键文件 SHA-256 与最少文件数；不匹配时不会执行该运行时。**NapCat 官方压缩包单独下载不保证具备所需 QQ 原生组件；本项目不提供腾讯组件的再分发。**

开启回复仍须 QQ 已连接、API Key、有效白名单及本版本的知情确认。群内发言后的 90 秒追问判断即使未 @、即使最终不回复也可能产生模型费用；积极度 0 不关闭追问。完整风险及默认预算请阅读 [README](https://github.com/XIA-2005/qq-ai-bot/blob/v0.9.3/README.md)。

## 验收边界

- 离线测试 **317/317**，浏览器测试 **3/3**；Windows 构建的 `app.asar`、附加资源及 NSIS 内嵌程序经离线审计，不含 NapCat/QQ 运行时或凭据。
- 在**隔离的用户数据目录**中启动了此版本的打包桌面程序，确认新版界面加载、缺少运行时的提示显示及 QQ 登录按钮禁用；没有启动旧项目、连接真实 QQ 或调用付费 API。
- 从 NSIS 安装器提取出的桌面程序和 `app.asar` 与上述隔离验收的文件逐字节一致。为避免修改主机已有安装与快捷方式，**没有在这台主机上执行 NSIS 安装/卸载流程**；真实 QQ 扫码登录和付费 API 功能也未经过本次端到端验收。

这是**预发布版**，不是声称已完成 QQ 登录或全流程验收的完整包。
