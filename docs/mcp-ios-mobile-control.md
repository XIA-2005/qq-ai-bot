# iPhone Safari/PWA 安全远程控制：当前实现与部署手册

日期：2026-09-23

工程：`<é¡¹ç®ç®å½>`

当前版本与入口以 [权威指引](current-release.md) 为准；原生客户端的早期设计另见 [`mcp-iphone-native-remote-architecture.md`](./mcp-iphone-native-remote-architecture.md)，**不是当前交付物**。

> 本文替代旧的 Quick Tunnel + 固定 PIN 方案。**当前是固定域名、一次性配对、逐设备授权的 Safari/PWA**；不是旧 PIN PWA，也不是已发布的 SwiftUI App。旧方案不得用于生产。

## 1. 当前交付边界

当前 v0.9.2 已实现以下安全后端及 PWA：

1. QQ 管理员改为独立 `adminIds`，与聊天好友白名单分离；
2. 删除固定 PIN 公网认证，旧 `/api/auth` 与未版本化 API 返回 `410`；
3. 桌面、托盘、QQ 管理指令和移动 API 共用 `ControlService`；
4. 提供 5 分钟一次性二维码配对和逐设备凭据（PWA Cookie / 受支持客户端的 Bearer Token）；
5. 移动源站只监听 `127.0.0.1:5188`；
6. 支持 Cloudflare Named Tunnel 固定 HTTPS 域名和 Windows 服务安装；
7. `/api/v1` 已实现限流、**24 小时跨重启写操作幂等收据**、审计、90 天过期和逐设备撤销；
8. 根地址提供 Safari/PWA 工作台及离线静态壳，手机令牌置于 HttpOnly、Secure、SameSite=Strict Cookie，不写入 localStorage。

当前**没有完成 SwiftUI 原生客户端**。`https://<固定域名>/` 是可用的 Safari/PWA 工作台，`/dashboard` 是独立用量页；断网时静态壳可能可见，但控制操作仍要求 Windows 程序和 Tunnel 在线。移动端不能替代桌面首次费用/范围知情确认。

QQ 管理指令仍可从 iPhone 的 QQ 私聊使用，但仅 `adminIds` 中的账号有管理权限。

## 2. 安全模型

数据路径：

```text
iPhone Safari / 主屏幕 PWA
  -> HTTPS 固定域名
  -> Cloudflare Named Tunnel（仅出站连接）
  -> http://127.0.0.1:5188
  -> MobileWebServer /api/v1
  -> RemoteAccess + ControlService
  -> 原有 Engine / Store / OneBot
```

关键约束：

- 不开放路由器端口，不把 `5188` 监听到局域网或公网网卡；
- 不使用 `*.trycloudflare.com`，不依赖每次重启都会变化的地址；
- 没有固定 PIN、共享管理员密码或 QQ 下发配对秘密的后门；
- 配对秘密只存在内存，5 分钟过期，成功交换后立即消费；
- 每台设备获得独立 32 字节随机 Token；PWA 配对成功后由服务端设置 HttpOnly + Secure + SameSite=Strict Cookie，浏览器脚本不持久化 Token；支持的独立客户端可使用 Bearer Token；
- 磁盘中的 `remote-devices.json` 只保存 SHA-256 哈希，不保存明文 Token；
- Token 默认 90 天到期，可在桌面逐台撤销或全部撤销；
- 首次风险同意只能在 Windows 桌面确认，移动端和 QQ 不能代替确认；
- 审计最多保留 500 条脱敏记录，不写入提示词正文、Token 或配对秘密；
- 没有 `Access-Control-Allow-Origin: *`，并启用 Host allowlist、安全响应头与 `no-store`。

## 3. Cloudflare Named Tunnel 一次性准备

需要用户自行准备：

- 一个 Cloudflare 账户；
- 一个已托管到 Cloudflare 的域名；
- 在 Cloudflare Zero Trust 中创建的 Named Tunnel；
- 该 Tunnel 的安装 Token；
- 一个固定子域名，例如 `bot.example.com`。

公开源码用 `https://qqbot.example.com` **作示例**，不是可直接使用的生产地址。先使用自己控制的域名，核对 DNS 迁移、已有网站记录和 Public Hostname，再修改 `scripts/setup-remote-tunnel.ps1` 中的 `$domain` / `$publicHost` 并审查部署步骤；示例见 [`remote-deployment.md`](./remote-deployment.md)。在 Cloudflare 配置完成以前不要创建或转发配对二维码。

### 3.1 Cloudflare 控制台配置

在 Cloudflare Zero Trust 的 **Networks -> Tunnels** 中：

1. 新建 Cloudflared Tunnel，选择 Windows 连接器；
2. 复制 Cloudflare 给出的 Tunnel Token；
3. 在该 Tunnel 的 Public Hostname 中添加固定子域名；
4. Service 类型选 `HTTP`；
5. Service URL 填 `127.0.0.1:5188`；
6. 保存后确认 DNS 记录由 Cloudflare 管理。

固定公网地址必须是 HTTPS 根地址，例如：

```text
https://bot.example.com
```

程序会拒绝 HTTP、带端口、带用户名密码、带路径/查询/片段以及 `*.trycloudflare.com`。

### 3.2 在 Windows 安装服务（先替换本仓库的 `example.com` 示例）

**唯一推荐入口**：将脚本示例域名换为自己的域名，确认 Cloudflare DNS 和相应 Public Hostname 已就绪后，在项目根目录以**管理员身份、无参数**运行：

```bat
配置iPhone固定远程.cmd
```

脚本检查名称服务器、固定域名和本机服务；只使用 `%ProgramFiles%\cloudflared\cloudflared.exe`，**不运行 PATH 中碰巧存在的同名程序**。下载源锁定为 Cloudflare 官方 GitHub Release **2026.9.1** 的 `cloudflared-windows-amd64.exe`，执行前校验 SHA-256：

```text
2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712
```

已有二进制哈希不符时停止，不静默覆盖；下载文件哈希不符时删除临时文件并拒绝执行。安装/卸载入口会在无真实 Token、无管理员权限的离线测试中校验解析、假下载与篡改拒绝。要升级锁定版本，先核对官方发布资产与独立计算的哈希，修改 `scripts/cloudflare-verified.ps1`，再重跑测试。

**仅在脚本的 `Read-Host -AsSecureString` 提示里粘贴“纯 Token”**，不能传入 CMD 参数、完整 `service install` 命令、QQ 消息、Git 或截图。旧 `scripts\install-cloudflare-tunnel.cmd` 拒绝 Token 参数并转发到同一交互脚本；根目录旧“一键开启手机远程”迁移提示入口已删除。脚本自身不在项目或日志中打印 Token；但是上游 `cloudflared service install` **仍将 Token 作为子进程参数**，Windows 服务注册表也可能保留它。安装后检查脚本的服务注册表 ACL 告警、限制本机可登录用户；怀疑泄漏时应在 Cloudflare Zero Trust 轮换连接器 Token，再安全卸载/重装服务。不能声称 Token 绝不落盘。

验证服务与固定域名（不显示 Token）：

```bat
sc query cloudflared
curl.exe https://qqbot.example.com/api/v1/health
```

健康检查应返回 `ok: true` 和 `apiVersion: 1`；只有 QQ AI Bot 桌面程序正在运行时，源站才会响应。卸载需管理员权限且会验证同一锁定二进制：

```bat
scripts\uninstall-cloudflare-tunnel.cmd
```

其他版本二进制因无法核对哈希会被拒绝，须先人工确认来源。卸载本机服务不自动删除 Cloudflare 控制台里的 Tunnel、Public Hostname 或 DNS 记录；不再使用时应删除或轮换 Token。本仓库脚本固定 `example.com`；其他域名要人工修改主机名与 DNS 配置，不能照搬脚本。

## 4. 桌面配置与配对流程

1. 启动 QQ AI Bot；
2. 在管理页填写**QQ 管理员账号**，保存配置；
3. 填写与 Cloudflare Public Hostname 完全相同的固定地址，例如 `https://bot.example.com`；
4. 先保存配置，再点击“创建一次性配对二维码”；
5. 二维码 5 分钟有效，新建二维码会使上一个失效；
6. 用 iPhone **系统相机**扫描二维码，在 Safari 打开固定域名的 `/pair/<配对 ID>#<一次性片段>`；PWA 一次性兑换并删除地址栏片段，成功后可通过 Safari 分享菜单「添加到主屏幕」。不要把二维码、URL 片段截图转发；
7. 配对成功后，桌面会显示设备名称、创建时间、最近使用和到期时间；
8. 手机丢失或不再信任时，立即点击该设备的“撤销”；必要时选择“撤销全部设备”。

内部配对载荷版本为 1，结构如下；**实际扫码地址是带一次性 URL 片段的 HTTPS 链接**，不是要求手动粘贴下方 JSON：

```json
{
  "type": "qq-ai-bot-pairing",
  "version": 1,
  "baseUrl": "https://bot.example.com",
  "pairingId": "UUID",
  "secret": "一次性随机秘密",
  "expiresAt": 1800000000000
}
```

二维码本身就是短期凭据。不要截图转发，不要在直播、远程会议或公开场所展示。

## 5. `/api/v1` 契约摘要

除健康检查和配对交换外，PWA 通过同源的 Secure/HttpOnly Cookie 鉴权；受支持的独立客户端可携带：

```http
Authorization: Bearer <device-token>
```

所有写请求还必须携带 8–128 字符的：

```http
Idempotency-Key: <本次操作唯一值>
```

同一设备、同一 Key 与同一请求指纹在**创建收据后 24 小时内**不会重复执行副作用：同进程完成操作可重放内存响应；进程重启后已完成操作仅返回 `replayed/recovered` 的最小回执，客户端需再读取当前状态。进程内执行中返回 `409 IDEMPOTENCY_IN_PROGRESS`，PWA 短暂等待并**使用原 Key** 重试；重启后遗留未确认操作返回 `409 IDEMPOTENCY_UNCERTAIN`，不能换 Key 盲目重做。同一 Key 用于不同方法/路径/正文返回 `409 IDEMPOTENCY_CONFLICT`。设备自撤销后令牌失效，重试返回 `401` 并重新配对。磁盘日志只含键哈希、指纹、时间和状态，不含 Token、Key 原文、聊天正文或桌面完整响应。

| 方法 | 路径 | 鉴权 | 作用 |
|---|---|---:|---|
| `GET` | `/api/v1/health` | 否 | 版本化健康检查 |
| `POST` | `/api/v1/pair/exchange` | 一次性秘密 | 换取设备 Token，仅成功返回一次 |
| `GET` | `/api/v1/state` | 是 | 状态、余额、用量和目标列表 |
| `POST` | `/api/v1/reply/start` | 是 | 启动自动回复，不能代替桌面首次同意 |
| `POST` | `/api/v1/reply/pause` | 是 | 暂停并执行与桌面一致的副作用 |
| `POST` | `/api/v1/targets` | 是 | 添加好友或群目标 |
| `DELETE` | `/api/v1/targets/:kind/:id` | 是 | 删除目标并清理关联配置 |
| `PUT` | `/api/v1/persona/global` | 是 | 更新全局人设 |
| `DELETE` | `/api/v1/devices/current` | 是 | 当前设备自撤销 |

统一响应：

```json
{"ok":true,"data":{}}
```

```json
{"ok":false,"error":{"code":"ERROR_CODE","message":"可显示信息"}}
```

服务限制：

- JSON 请求体最大 16 KiB；
- 配对、读取和写入分别限流；
- 非允许 Host 返回 `421`；
- 非 JSON 写请求返回 `415`；
- 无效/已撤销/已过期 Cookie/Token 返回 `401`；
- 旧 `/api/auth` 和旧 `/api/*` 返回 `410 LEGACY_API_REMOVED`。

## 6. QQ 管理员指令

管理员必须显式配置在 `adminIds`，聊天好友白名单不会自动获得管理员权限。

| 指令 | 作用 |
|---|---|
| `#帮助` | 查看命令 |
| `#余额` | 查询余额 |
| `#状态` | 查看运行状态和目标 |
| `#加群 <群号>` / `#退群 <群号>` | 修改群白名单 |
| `#加好友 <QQ号>` / `#删好友 <QQ号>` | 修改好友白名单 |
| `#暂停` / `#启动` | 统一控制自动回复 |
| `#人设` / `#人设 <内容>` | 查看或更新全局人设 |
| `#面板` | 仅返回已配置的固定域名和桌面扫码提示 |

`#面板` 不返回 PIN、配对秘密或设备 Token，也不会发现或启动 Quick Tunnel。

## 7. 运维、应急与故障排查

### iPhone 丢失或设备凭据疑似泄露

1. 在 Windows 桌面立即撤销对应设备；
2. 无法确认设备时撤销全部设备；
3. 检查桌面审计中的失败鉴权和异常操作；
4. 若 Tunnel Token 也可能泄露，在 Cloudflare 控制台轮换连接器 Token，并重新安装服务。

### 外网无法访问

依次检查：

1. QQ AI Bot 是否正在运行；
2. 本机 `curl.exe http://127.0.0.1:5188/api/v1/health` 是否成功；
3. `sc query cloudflared` 是否为 `RUNNING`；
4. Public Hostname 是否指向 `http://127.0.0.1:5188`；
5. 桌面保存的固定域名是否与 Public Hostname 完全一致；
6. Cloudflare DNS 是否仍为代理状态；
7. 系统时间是否准确。

### 关于关机和 VPS

Windows 关机、休眠或 QQ AI Bot 退出后，iPhone 无法控制机器人。可设置合盖不休眠并保证电源和网络稳定。

该项目当前依赖 Windows Electron、NapCat 和本机安全存储，**不能原样复制到 Linux VPS**。若要云端常驻，需要单独设计 Windows 主机部署或拆分运行时，不能把“购买 Linux VPS”当作已完成方案。

## 8. 验收与弃用项

源代码验收：

```bat
npm run build
node --test tests\admin-mobile.test.cjs
npm run ci:offline
npm run test:browser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-cloudflare-verified.ps1
```

离线测试覆盖假 NapCat/WS 登录状态机、一次性配对、浏览器级 Cookie 和撤销、PWA 错误恢复、响应丢失同 Key 重试、24 小时跨重启收据、只存 Token 哈希、90 天过期、旧同意重新确认、审计写盘失败、loopback 绑定、旧 PIN API `410` 和安全响应头。PowerShell 离线假文件测试校验版本/哈希和篡改拒绝。没有登录真实 QQ、使用付费 API 或安装服务；真实 iPhone 外网访问须用户另行确认后手动验收。

明确弃用：

- `cloudflared tunnel --url ...` Quick Tunnel；
- `*.trycloudflare.com` 临时域名；
- 固定 PIN 登录；
- 把好友白名单当管理员列表；
- 将源站绑定到 `0.0.0.0`；
- 通过 QQ 发送配对秘密或设备 Token；
- 把旧固定 PIN PWA 误认为当前安全配对 PWA；
- 声称自动化测试已安装服务或验证真实 QQ/DeepSeek。

旧文件 `一键开启手机远程(免同一网络).cmd` 已删除；不要使用历史 Quick Tunnel、固定 PIN 说明。当前固定远程安装入口见上文 3.2 节。
