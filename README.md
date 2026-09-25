# QQ AI Bot

本机运行的 QQ 白名单自动回复助手。基于 Electron + TypeScript，通过 NapCat（OneBot 11）收发消息，调用 DeepSeek 生成回复。

配置、聊天记忆和用量统计保存在本机用户数据目录；生成回复时，相关消息内容（启用视觉后还可能包括图片）会发送到所配置的 DeepSeek API。启用手机远程后，手机请求经你配置的 HTTPS 隧道转发到本机。不要把“本机存储”理解为“消息不会离开本机”。

> **版本**：0.9.2 ｜ **平台**：Windows 10/11 x64 ｜ **许可**：MIT

> **这是源码仓库，不是完整的 Windows 安装包。** NapCat/QQ 第三方运行时和 `release-v*/` 打包目录不提交至 GitHub。根目录的 `启动机器人.exe` 是选包启动器，单独下载它或源码不能直接运行；须先按下文从有权使用的可信来源恢复运行时、校验并在本地打包。本仓库的测试通过不等于真实 QQ 或打包版验收。

---

## 请先阅读

这个项目会用你的 QQ 账号自动发消息，并花你自己的 API 余额。使用前请确认你接受以下几点：

- **账号风险**：自动回复可能导致 QQ 账号被限制或封禁。**强烈建议使用小号**，不要用主力账号。
- **费用风险**：每次生成回复都会消耗 DeepSeek Token，由你自己的 API Key 付费。
- **群追问机制**：机器人在白名单群发言后的 **90 秒**内，群里其他人的消息（即使没有 @ 它）也可能被送去让模型判断要不要接话。**即使最终选择不回复，这次判断也已经产生费用。** 把积极度调成 0 并不会关闭这个机制。
- **费用护栏**：默认开启软件层面的估算护栏 —— 每日全局 ¥2、每个好友/群 ¥0.50，超出后阻断调用。这是本软件自己的估算，**不等于 DeepSeek 账户的硬性消费上限**，请另行在服务商侧设置。
- **发出去的消息撤不回**：暂停只能停下还没发送的内容。
- **保存配置会解除手动暂停**：桌面「保存配置」成功后保持当前 QQ 登录；QQ 已连接且 API Key、有效白名单及本版本知情确认齐备时会自动开启回复，条件不足时安全等待。如不想继续自动回复，请在保存后再次点击「暂停回复」。

软件内显示的所有金额都是**按 Token 与参考单价估算的结果，不是实际账单**，可能与真实扣款有出入。请以 DeepSeek 官方账单为准。

---

## 准备工作

**1. Node.js ≥ 22.12.0**（仅开发和打包需要；用打包好的应用不需要装 Node）

**2. DeepSeek API Key**

到 [platform.deepseek.com](https://platform.deepseek.com) 注册并创建，形如 `sk-xxxxxxxx`，在应用内填写。

**3. NapCat 运行时**（关键一步）

`vendor/napcat-runtime/` **不在本仓库内**，因为它是第三方二进制分发物。你需要自行从 NapCatQQ 官方渠道获取 Windows Node 运行时，放到 `vendor/napcat-runtime/`，然后校验：

```bash
npm run preflight:runtime
```

该命令会按 `scripts/vendor-runtime.lock.json` 里记录的 SHA-256 校验关键可执行文件并检查文件完整性。**校验不通过就不要继续打包。** 注意它只验证文件是否与记录一致，不能替你判断来源是否可信 —— 请只从官方渠道获取。

清单还校验 QQ 组件；若所获运行时缺文件或哈希不符，不要从不可信来源拼接、修改清单或绕过校验。NapCat 与 QQ 组件的权利归属及分发边界见 [第三方声明](THIRD-PARTY-NOTICES.md)，不要将本机获取的运行时、QQ 文件或账号资料提交到公开仓库。

---

## 开始使用

```bash
npm ci               # 按锁文件安装依赖
npm run build        # 编译 TypeScript
npm test             # 运行离线自动化测试（数量随源码变化）
npm start            # 本地启动
```

## 打包

```bash
npm run pack:win     # 免安装目录 -> release-v<版本>/win-unpacked/
npm run dist:win     # NSIS 安装包 -> release-v<版本>/QQ-AI-Bot-Setup-<版本>.exe
```

打包前需先完成上面的 NapCat 运行时校验，否则 `pack:win` 会中止。

> **注意**：`dist:win` **不会**生成 `launch-manifest.json`。根目录的 `启动机器人.exe` 依赖这个清单来校验并选择版本，缺少它会导致启动器跳过这个版本、回退到旧版本。用 `dist:win` 出包后请补一句：
>
> ```bash
> node scripts/write-launcher-manifest.cjs
> ```
>
> `pack:win` 已包含这一步，无需额外操作。

### 启动方式

根目录的 **`启动机器人.exe`** 是日常启动入口：它会扫描 `release-v*` 目录，挑选**版本号最高且通过 SHA-256 完整性校验**的完整包。公开源码副本不包含 `release-v*/` 和第三方运行时；只下载源码或单独复制这个启动器不能直接运行，请先按上文恢复运行时并打包。

`启动机器人.exe` 是编译好的 .NET 启动器，可用 `scripts/build-launcher.cmd` 从 `scripts/Launcher.cs` 重新生成。

手机远程文档和 `scripts/setup-remote-tunnel.ps1` 中的 `example.com` / `qqbot.example.com` **只是示例域名**。安装连接器前，必须先改为你拥有且已接入 Cloudflare 的域名，并重新审查 DNS、Public Hostname 与脚本中的 `$domain` / `$publicHost`；不要原样运行示例配置或提交 Tunnel Token。

---

## 功能

- **白名单控制** —— 好友 / 群逐个启用，非白名单一律不回
- **人设** —— 全局提示词 + 每个对象的独立人设
- **主动接话** —— 0–100 积极度调节；设为 0 不关闭机器人发言后 90 秒的群追问模型判断
- **图片与表情包识别** —— 可开关的视觉理解
- **消息合并与拟人化** —— 合并连发消息、分句发送、冷却与限流
- **群会话窗口** —— 按群维护上下文，空闲自动结束
- **手机远程控制** —— PWA，需扫码配对设备，走 HTTPS 隧道
- **用量后台** —— 累计费用、按模型 / 用途 / 对象拆分、按天与小时趋势图、逐次调用明细、CSV 导出

用量后台在应用启动后，通过已配对设备访问 `/dashboard`。

## 项目结构

```
src/        主进程、引擎、模型调用、用量统计
ui/         桌面窗口界面
mobile/     手机 PWA 与用量后台页面
tests/      测试（node:test，307 项）
scripts/    构建、打包、校验、探针脚本
docs/       设计与交付文档
```

几个入口文件：`src/main.ts` 主进程装配，`src/engine.ts` 回复引擎，`src/model.ts` DeepSeek 调用，`src/usage-ledger.ts` 与 `src/usage-analytics.ts` 用量与费用统计，`src/web-server.ts` 设备 API 与后台。

## 测试

```bash
npm test            # 全部测试
npm run typecheck   # 仅类型检查
npm run ci:offline  # 类型 + 静态检查 + 格式 + 测试
```

测试全部使用临时用户目录、假 Key 和进程内桩，**不会连接真实 QQ、不会调用付费 API、不会发出真实消息**。

---

## 隐私

- API Key、聊天记忆、用量统计只写在本机用户数据目录。
- 用量明细只记录对象号码、用途、模型名、Token 数和金额，**不保存聊天正文，也不保存 API Key**。
- 仓库内的 QQ 号、群号均为示例占位值，非真实账号。

## 第三方组件

见 `THIRD-PARTY-NOTICES.md`。NapCat 运行时按其自身许可证分发，不包含在本仓库中。

## 许可证

MIT，见 `LICENSE`。

本项目与腾讯 QQ、DeepSeek、NapCatQQ 均无隶属关系。使用者需自行承担账号与费用风险，并遵守相关服务条款。
