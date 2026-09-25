# iPhone 原生远程控制与跨网络架构方案

> **历史设计方案，未交付 SwiftUI 原生 App。** 当前远程客户端为安全配对的 Safari/PWA；详见 [权威版本指引](current-release.md) 和 [现行手机部署手册](mcp-ios-mobile-control.md)。下文为当时提案，不是当前操作步骤。

日期：2026-09-22

## 1. 结论

项目应采用“Windows 常驻机器人后端 + iPhone 原生 SwiftUI 控制端 + 稳定加密隧道”的前后端分离架构。

- NapCatQQ、OneBot 长连接、DeepSeek 调用、会话调度和本地密钥继续在 Windows 主机运行。
- iPhone App 只负责查看状态和发出经过授权的管理操作，不在手机后台维持 QQ 协议。
- Windows 主机通过 Cloudflare Named Tunnel 主动连接云端，iPhone 使用固定 HTTPS 域名访问，因此不要求同一 Wi-Fi、不要求公网 IP，也不开放路由器端口。
- 如果 Windows 主机关机、休眠或断网，远程控制和机器人都会离线。这是物理约束，不能由 iPhone App 绕过。需要 24 小时在线时，应使用常开 Windows 主机或 Windows 云主机；当前 Electron、NapCat Windows 运行时和 DPAPI 方案不能原样迁移到 Linux VPS。

截至 2026-09-22，Quick Tunnel、固定 PIN 和旧 PWA 控制面板已从正式入口停用；安全后端前 7 项已经实现。SwiftUI 原生 App 仍属于下一阶段，当前不能宣称 iPhone 客户端已经交付。

## 2. 改造前基线与当前项目状态

当前工程是 Electron 40 + TypeScript 5.9 的 Windows x64 QQ AI 助手：

- `src/main.ts` 负责 Electron 主进程、生命周期和 IPC。
- `src/login.ts`、`src/login-memory.ts` 管理 NapCatQQ 启动、扫码和账号恢复。
- `src/onebot.ts` 通过本机 OneBot WebSocket 收发 QQ 事件。
- `src/engine.ts`、`src/scheduler.ts` 实现白名单路由、会话隔离、限流、排队和暂停。
- `src/model.ts`、`src/api-account.ts`、`src/usage-ledger.ts` 负责 DeepSeek 调用、账户状态和用量。
- `src/web-server.ts` 现为只监听 `127.0.0.1:5188` 的版本化设备 API，不再提供固定 PIN/PWA 控制面板。
- `src/admin.ts` 使用独立 `adminIds` 和统一 `ControlService`，不再把聊天白名单当管理员。
- `src/remote-access.ts` 提供一次性配对、逐设备 Token 哈希、90 天过期、撤销和脱敏审计。
- `scripts/install-cloudflare-tunnel.cmd` 和卸载脚本负责 Named Tunnel Windows 服务；旧根目录脚本只显示迁移提示。

改造前基线验证结果（用于记录，不代表当前实现）：

- `npm test`：260 项通过，0 失败。
- `src` 范围 VS Code/TypeScript 诊断：0 个 error，0 个 warning。
- 当时的 Quick Tunnel 公网页面可以访问，但这只证明临时链路通，不代表达到生产安全和可用性要求。

当前实现及操作手册见 [`mcp-ios-mobile-control.md`](./mcp-ios-mobile-control.md)。实际 Cloudflare Tunnel、固定域名和 Token 仍必须由用户在自己的 Cloudflare 账户中创建。

## 3. 改造前移动端原型的关键问题（现已止险）

### 3.1 它不是原生 iPhone App

`src/web-server.ts` 返回带 iOS meta 标签和 manifest 的网页。添加到主屏幕后有独立窗口外观，但仍是 Home Screen Web App，不是 SwiftUI 原生 App，也没有 Xcode 工程、Keychain 配对、原生生物识别或原生发布链路。

### 3.2 Quick Tunnel 只适合开发验证

TryCloudflare 每次启动产生随机域名，没有正常生产 SLA，域名会变化。它适合演示和临时联调，不适合 iPhone 长期安装、收藏或 API 固定基址。

正式环境应使用 Cloudflare 账户下的 Named Tunnel 和固定域名，例如 `https://bot.example.com`，并把 `cloudflared` 安装成 Windows 服务随系统启动。

### 3.3 当前鉴权强度不足

现状包括固定短 PIN、无失败次数限制、无登录冷却、单个进程级 Bearer Token、Token 无单设备标识和撤销界面。PIN 提示和使用说明还会暴露默认值。公网管理接口不应依赖这种机制。

### 3.4 当前 QQ 管理员边界错误

`AdminCommandHandler.isAdmin()` 当前把所有私聊白名单好友都视作管理员。白名单的含义本应只是“允许 AI 回复”，不能自动获得添加群、修改人设、暂停/启动和查看面板凭据的权限。

必须新增独立的 `adminIds` 配置，默认不从 `friends` 推导；QQ 管理操作必须只允许明确登记的管理员账号。

### 3.5 远程入口绕过了桌面端安全守卫

桌面 IPC 在启动回复、修改配置、人设变更时有同意、忙碌状态、密钥、连接和白名单检查。当前 Web 与 QQ 管理代码直接调用 `engine.start()`、`engine.pause()`、`store.save()` 和 `engine.updateConfig()`，没有完整复用这些守卫，容易造成不同入口行为不一致。

应把业务操作抽成唯一的 `RemoteControlService` 或 `ControlService`。Electron IPC、QQ 管理指令、PWA API 和 iOS API 都调用同一服务，不再各自直接修改引擎与配置。

### 3.6 网络暴露范围过大

移动 Web 服务当前绑定 `0.0.0.0`，同一局域网内任何设备都能访问登录入口。采用 Tunnel 后，源站只需监听 `127.0.0.1`，由本机 `cloudflared` 访问，不应同时在局域网裸露。

## 4. 目标拓扑

```text
iPhone SwiftUI App
  | HTTPS / TLS
  | 固定域名 + 设备令牌
  v
Cloudflare Edge
  | Named Tunnel（仅入站代理，不开放家庭路由器端口）
  v
cloudflared Windows 服务
  | http://127.0.0.1:5188
  v
Remote API / ControlService
  |-- 状态、余额、审计事件
  |-- 启动/暂停
  |-- 白名单和对象设置
  |-- 人设更新
  v
既有 Engine / Store / OneBot / DeepSeek / UsageLedger
```

关键原则：

1. 公网只看到 Cloudflare；Windows 不监听公网网卡，也不做端口映射。
2. QQ 登录令牌、OneBot Token、DeepSeek API Key 永不发送到 iPhone。
3. App 只获得最小化管理 API，不获得任意文件、命令执行或通用 IPC 能力。
4. 所有变更操作复用桌面端业务规则并产生脱敏审计记录。

## 5. 推荐的配对与鉴权模型

### 5.1 首次配对

1. 用户在 Windows 桌面端打开“移动设备”。
2. 桌面端生成一次性 256 位随机配对秘密，有效期 5 分钟且只能使用一次。
3. 桌面端显示二维码，内容只包含固定 HTTPS 域名、配对 ID 和一次性秘密。
4. iPhone App 扫码并通过 HTTPS 调用 `POST /api/v1/pair/exchange`。
5. 服务端签发独立的设备访问令牌；配对秘密立即作废。

不得使用固定默认 PIN，不得把长期令牌显示在日志、QQ 消息、URL 查询参数或二维码历史中。

### 5.2 令牌存储与撤销

- iPhone：令牌保存在 Keychain，可选 Face ID 解锁 App。
- Windows：只保存令牌哈希、设备 ID、设备名称、创建时间、最近使用时间和权限；敏感持久化使用 Windows DPAPI。
- 每台设备单独令牌，支持在桌面端查看和一键撤销。
- 长期访问令牌使用至少 256 位随机值，并支持轮换；短期会话令牌可设置 15–60 分钟有效期。
- 若需要更高等级，可在第二阶段改为 CryptoKit Curve25519/Ed25519 设备签名，每个请求加入时间戳和 nonce 防重放。

### 5.3 边缘层

Named Tunnel 负责稳定域名和传输加密。可再叠加 Cloudflare Access 作为第二层身份验证，但不能把 Cloudflare Service Token 客户端密钥硬编码进公开发布的 iOS App。

## 6. API 设计

建议统一使用版本化 JSON API：

- `GET /api/v1/health`：不含隐私的存活状态。
- `POST /api/v1/pair/exchange`：一次性配对。
- `GET /api/v1/state`：连接、运行、队列、余额摘要和安全状态。
- `POST /api/v1/reply/start`：经过完整前置检查后启动。
- `POST /api/v1/reply/pause`：暂停并取消未发送工作。
- `GET /api/v1/targets`：返回脱敏后的好友/群目标与对象策略。
- `POST /api/v1/targets`、`PATCH /api/v1/targets/:id`、`DELETE /api/v1/targets/:id`：通过统一配置服务修改目标。
- `PUT /api/v1/persona/global`：更新全局人设，保留原有备份和记忆清理语义。
- `GET /api/v1/devices`、`DELETE /api/v1/devices/:id`：查看并撤销已配对设备。
- `GET /api/v1/events`：可选 SSE 状态推送；首版也可以每 5–15 秒前台轮询。

所有失败返回稳定错误码，不把异常堆栈、文件路径、密钥状态或 QQ 原始消息正文返回公网客户端。

## 7. 服务端必须补齐的安全控制

- 源站默认绑定 `127.0.0.1`，局域网模式必须由用户单独显式开启。
- `/pair`、登录和所有写操作分别限流；连续失败后指数退避或短时锁定。
- CORS 默认同源；不再使用 `Access-Control-Allow-Origin: *`。
- 增加 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。
- 限制 JSON 大小、字段、方法和 Content-Type；所有 ID 使用现有账号校验规则。
- 写操作使用幂等键或请求 ID，避免移动网络重试造成重复变更。
- 审计日志只记录设备、操作、结果和时间，不记录聊天正文、配对秘密、令牌或 API Key。
- 配置写入继续使用现有原子保存和验证路径；不得让移动 API 绕过 profile、proactiveGroups、同意状态和会话清理规则。
- 删除硬编码管理员账号、固定 PIN 和固定公网地址。

## 8. iPhone 原生 App 范围

首版 SwiftUI App 建议包含：

1. 扫码配对、Keychain 凭据、Face ID 应用锁。
2. 首页：Windows 在线状态、QQ 连接状态、自动回复状态、队列、错误摘要、余额和累计用量。
3. 一键暂停/启动，危险操作二次确认。
4. 好友与群目标管理，保留对象启用状态和独立策略，不只编辑裸号码数组。
5. 全局人设查看/编辑，明确提示会暂停、清理受影响记忆和保存上一版。
6. 已配对设备与退出登录。
7. 断网、主机离线、令牌撤销和版本不兼容的明确提示。

首版不应包含：DeepSeek API Key 查看、OneBot Token 查看、任意系统命令、任意文件访问、聊天正文全量同步或在 iPhone 后台运行 QQ 协议。

发布顺序建议：先用开发签名或 TestFlight 真机验收，再决定 App Store。App Store 审核是否通过取决于最终功能、隐私说明、账号体系和审核时政策，不能预先保证；但“iPhone 只做远程管理，机器人后端在用户自己的 Windows 主机运行”在技术上不需要 iOS 常驻后台。

## 9. 分阶段实施计划

### 阶段 A：立即止险和统一业务层

- **已完成**：新增独立管理员列表，停止把所有白名单好友当管理员。
- **已完成**：停用固定 PIN，增加一次性设备配对和可撤销令牌。
- **已完成**：将服务绑定改为 `127.0.0.1`。
- **已完成**：抽取 `ControlService`，让桌面、QQ 指令、托盘和未来 iOS 复用同一安全守卫。
- **已完成**：为权限、限流、撤销、幂等和配置不变量增加测试。

### 阶段 B：稳定跨网络链路

- **代码与脚本已完成**：Named Tunnel 固定域名配置、健康检查、版本化 API 和 Windows 服务安装/卸载脚本。
- **需要用户账户操作**：在自己的 Cloudflare 账户创建 Tunnel、Public Hostname、DNS 和 Token，并执行安装脚本。
- Quick Tunnel 已从正式入口停用，不保留固定 PIN 兼容后门。

### 阶段 C：原生 iOS 客户端

- 新建 SwiftUI 工程，完成二维码扫描、Keychain、Face ID、URLSession API 层和状态页面。
- 完成目标、人设、暂停/启动和设备管理。
- 使用真实 iPhone 在 Wi-Fi 与 4G/5G 之间切换测试，验证请求幂等、弱网提示和令牌撤销。

### 阶段 D：交付与运维

- TestFlight 分发、隐私清单、支持页面和恢复流程。
- Windows 常驻、睡眠策略、断网重连、升级后隧道恢复测试。
- 如需电脑关机后仍在线，迁移到 Windows 云主机并重新验证 QQ 登录、图形运行时和风控；不能把当前产物直接宣称可部署到 Linux。

## 10. 当前可用性与最终选择

当前安全后端和 Named Tunnel 部署能力已完成，旧临时 PWA 与固定 PIN 已停用。SwiftUI 客户端、Keychain 和 Face ID 仍待后续阶段实现。

本项目的正式选择为：

> SwiftUI 原生 iPhone App + Windows 本地 Remote API + Cloudflare Named Tunnel + 二维码一次性配对 + Keychain/DPAPI 单设备令牌。

这一路线同时满足“iPhone 软件”和“不在同一网络也能使用”，并保持现有 QQ、DeepSeek、调度、隐私与 Windows 登录能力不被重写。

## 11. 官方参考

- Cloudflare Quick Tunnels（明确用于测试/开发）：`https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/`
- Cloudflare Tunnel：`https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/`
- Apple Home Screen Web Apps：`https://developer.apple.com/videos/play/wwdc2023/10120/`
- Apple App Review Guidelines：`https://developer.apple.com/app-store/review/guidelines/`
- Apple CryptoKit Curve25519 Signing：`https://developer.apple.com/documentation/cryptokit/curve25519/signing/privatekey`
