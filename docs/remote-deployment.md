# 固定远程部署清单（`qqbot.example.com` 示例，勿原样执行）

> 本文保留一份脱敏的 DNS 迁移示例。`example.com`、示例名称服务器和网站记录不代表读者当前的真实域名或实时查询结果。部署前请逐项核对自己的注册商/DNS/已有网站，替换 `scripts/setup-remote-tunnel.ps1` 中的 `$domain`、`$publicHost`，确认 Cloudflare Public Hostname 后再考虑运行安装脚本。**不得将实际 Tunnel Token 写入本仓库。**

日期：2026-09-23

远程程序：`<项目目录>`

现有网站：`<网站目录>`

固定地址：`https://qqbot.example.com`

## 1. 示例状态（不能代替现场核验）

- 假设 `https://example.com` 是 GitHub Pages 网站，不可用远程控制服务覆盖；
- 假设迁移前名称服务器是 `ns1.dnsowl.com`、`ns2.dnsowl.com`、`ns3.dnsowl.com`；实际以你的注册商为准；
- GitHub Pages 站点可能使用 4 条 A 记录：`185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`；实际以你的网站控制台为准；
- 示例中的 `www` 指向 `example-user.github.io`，不是可直接复用的 CNAME；
- 示例查询未发现 MX、TXT、AAAA、CAA 或 DS 记录；你的域名迁移前仍必须在原 DNS 控制台核对全部记录，公网查询不能代替控制台清单；
- 示例中的 `qqbot.example.com` 尚未添加 DNS 记录；
- 如另有本地网站 Git 工作区，先检查未提交变化；不要为部署机器人覆盖网站文件。

远程 API 使用独立子域名，因此网站文件不需要加入 Token、API 页面或 Tunnel 配置。主站继续由 GitHub Pages 提供，`qqbot` 才进入本机 Tunnel。

## 2. 无中断迁移 DNS 到 Cloudflare

1. 登录 Cloudflare，选择 **Add a domain / 添加域**，输入 `example.com`，选择 Free 计划；
2. 在 Cloudflare 分配名称服务器之前，先核对导入记录；至少应有：

| 类型 | 名称 | 内容 | 代理状态 |
|---|---|---|---|
| A | `@` | `185.199.108.153` | DNS only（灰云） |
| A | `@` | `185.199.109.153` | DNS only（灰云） |
| A | `@` | `185.199.110.153` | DNS only（灰云） |
| A | `@` | `185.199.111.153` | DNS only（灰云） |
| CNAME | `www` | `example-user.github.io` | DNS only（灰云） |

3. 如果原 DNS 控制台还有邮件、域名验证或其他记录，全部复制到 Cloudflare；不要只复制上表；
4. 先保存记录，再到域名注册商把**自己域名当前使用的**名称服务器替换成 Cloudflare 分配的名称服务器；`dnsowl` 只是上文示例，不得照搬；
5. 不要提前删除原 DNS 记录。等待 Cloudflare 显示域名为 **Active**；
6. 验证 `https://example.com` 和 `https://www.example.com` 仍能正常打开；
7. 用以下命令确认权威 DNS 已切换：

```powershell
Resolve-DnsName example.com -Type NS
```

结果应为 Cloudflare 分配的 `*.ns.cloudflare.com`，而不是你域名原来的名称服务器。

## 3. 创建固定 Named Tunnel

在 Cloudflare Zero Trust 控制台进入 **Networks -> Tunnels**：

1. 新建 Cloudflared Tunnel，建议名称 `qq-ai-bot-example`；
2. 连接器选择 Windows；
3. 添加 Public Hostname：
   - Subdomain：`qqbot`
   - Domain：`example.com`
   - Path：留空
   - Type：`HTTP`
   - URL：`127.0.0.1:5188`
4. 保存，确认 Cloudflare 自动创建 `qqbot` 对应的 Tunnel DNS 记录；
5. 复制 Windows 连接器的 Tunnel Token，但**不要把 Token 发到 QQ、聊天、Git 或截图里**。

这个架构不需要路由器端口映射，也不要创建指向家庭公网 IP 的 A 记录。`5188` 始终只监听本机 `127.0.0.1`。

## 4. 安装 Windows 连接器

将示例域名改为自己的域名，DNS 和 Public Hostname 生效后，在 `<项目目录>` 中右键：

```text
配置iPhone固定远程.cmd
```

选择“以管理员身份运行”，在本机提示框中粘贴 Tunnel Token。脚本会检查：

- 名称服务器是否已经是 Cloudflare；
- `qqbot.example.com` 是否能解析；
- cloudflared Windows 服务是否安装并运行；
- 本机和公网 `/api/v1/health` 是否返回 API v1。

脚本只从官方固定版本 **cloudflared 2026.9.1** 下载，并校验 SHA-256 `2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712`；不信任 PATH，已有文件哈希不符直接停止。只在交互提示输入纯 Token，不能作为 CMD 参数。脚本本身不写入项目文件，但上游 Windows 服务安装仍需把 Token 交给子进程参数，服务注册表**也可能长期保存**；完成后检查 ACL 告警并限制本机账号，疑似泄露应在 Cloudflare Zero Trust 轮换 Token。

## 5. QQ AI Bot 配置和验收

1. 启动当前安全版 QQ AI Bot；
2. 在“iPhone 安全远程控制”中填写并保存：

```text
https://qqbot.example.com
```

3. 本机验证：

```bat
curl.exe http://127.0.0.1:5188/api/v1/health
```

4. 用 iPhone 关闭 Wi-Fi、只使用蜂窝网络验证：

```text
https://qqbot.example.com/api/v1/health
```

5. 两处都应返回 `ok: true` 和 `apiVersion: 1`；
6. 确认公网健康检查成功后，才在桌面创建 5 分钟一次性配对二维码。

健康检查不授予控制权限；PWA 通过安全的逐设备 HttpOnly Cookie 授权，受支持的独立客户端可用 Bearer Token。不要给 `qqbot.example.com` 额外套 Cloudflare Access 登录页，否则 iPhone Safari 无法直接完成一次性二维码配对；本项目使用自身的配对与设备令牌体系。实际部署状态请在用户完成 DNS/服务安装后人工核实。

## 6. 回滚

如果 Tunnel 有问题，不要回滚主站 DNS。先运行：

```bat
scripts\uninstall-cloudflare-tunnel.cmd
```

卸载脚本只执行固定哈希的本机二进制；若已安装其他版本会拒绝，需要先人工核查来源。然后在 Cloudflare 删除 `qqbot` Public Hostname 或暂停 Tunnel。根域名和 `www` 的 GitHub Pages 记录保持不变，主站可继续运行。
