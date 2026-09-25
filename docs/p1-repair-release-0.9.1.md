# v0.9.1 · P1 整改与离线交付说明

日期：2026-09-23。**本页是 v0.9.1 历史交付记录，不是当前启动指引**；此前记载的两个 CMD 启动入口已从公开源码副本移除。当前入口及版本请看 [权威指引](current-release.md)。`mcp-project-improvement-review.md` 和旧版时间线也是历史记录。

## 七项整改

| 编号 | 当前处理 |
|---|---|
| P1-1 | Engine 的取消信号贯通 OneBot：拟人化等待、分句间隔及每段发送前均可取消；在途 QQ 发送不能撤回，因此不自动重试未知状态。 |
| P1-2 | **保留默认追问**：机器人在白名单群发言后 90 秒内，任何成员未 @ 的新消息可能连同近期群聊文字、机器人发言交由 DeepSeek 判断；即使沉默也可能计费，连续 3 次判断无关会关闭窗口。积极度 0 不关闭此能力。桌面/移动端已更正说明；旧版同意需在 Windows 主窗口重新确认，手机/QQ 不可代确认。只有真实成功发言能重开窗口。 |
| P1-3 | 暂停、清空、断线/停用对象清除追问窗口；清空也清除机器人旧消息引用 ID。 |
| P1-4 | 操作结果与安全审计写盘分离；写盘失败显示告警并暂存最近 500 条于内存，恢复后补写；**进程退出前仍未恢复的记录可能丢失**。配对、鉴权失败和设备自撤销路径也保留正确结果。 |
| P1-5 | 根目录 EXE、`scripts/launcher.exe` 及两个 CMD 共用最高版本选择逻辑。`npm run pack:win` 生成 `release-v0.9.1/win-unpacked/launch-manifest.json`，包含实际 app.asar 版本及 EXE/ASAR SHA-256；启动器核对完整资源、版本和哈希，同版本择最近构建，缺失/损坏时拒绝或回退。桌面概览显示**实际运行**版本和 EXE 路径。 |
| P1-6 | Cloudflare 安装只推荐无参数运行 `配置iPhone固定远程.cmd`；锁定 cloudflared **2026.9.1** 官方 Windows AMD64 EXE，SHA-256 `2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712`（已独立核对下载），不信任 PATH 或不匹配的旧 EXE。旧入口拒绝命令行 Token，卸载也拒绝未验证的二进制。 |
| P1-7 | 版本和 lockfile 对齐为 0.9.1；`npm ci`/`npm test` 不依赖真实 QQ 或付费 API；Windows 离线假 EXE、假 Cloudflare 下载可重跑；对忽略的 NapCat/Node 运行时核对 8 个关键 SHA-256 及资源数量，打包后再检查 ASAR 入口、移动资源、许可和包清单。历史/私人文件不纳入提交。 |

## 从源码复现（Windows x64，Node ≥22.12）

```bat
npm ci
set "CI=1"
npm test
```

Git **不包含** `vendor/napcat-runtime/`、`release-v*/` 或 `artifacts/` 的大型第三方/生成文件。要打包，先从你已审阅的上游发行物或本机上一版受信任包的 `win-unpacked\resources\napcat-runtime` 恢复运行时；不要复制 QQ userData、聊天记录或私有 Token。可先对候选目录只读验收：

```bat
node scripts\preflight-runtime.cjs "<旧包目录>\win-unpacked\resources\napcat-runtime"
```

`8` 个关键文件 SHA-256、最低文件数量和说明见 `scripts/vendor-runtime.lock.json`；其中 Node/NapCat/QQ 辅助文件必须全部匹配。该检查**不是**第三方代码签名/全量供应链保证；仍须自行核对发行来源、许可 `THIRD-PARTY-NOTICES.md`，并保留可信副本。将审核通过的目录复制为 `vendor\napcat-runtime` 后：

```bat
npm run preflight:runtime
npm run pack:win
```

脚本会在缺少或不匹配关键资源时**拒绝**打包，打包完成后写入并验证 `launch-manifest.json`。如确需启用原有 `artifacts/mcp-secure-remote/packaged/win-unpacked`，先从受信任来源审查，再执行 `npm run manifest:legacy`；无清单的历史目录不会被启动器默默采用。源码更改 `scripts/Launcher.cs` 时在 Windows 运行 `scripts\build-launcher.cmd`，再离线测试：

```bat
bash scripts/launcher-check.sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-cloudflare-verified.ps1
```

以上测试仅使用假 EXE/假下载、无真实服务或 Token。运行包 `.exe` 已从同一份 `Launcher.cs` 重编译，并只因用户明确允许才与源码一并提交。需要启动软件时先彻底退出旧进程，再双击根目录 `启动机器人.exe` 或 `启动机器人.cmd`；不要继续使用旧版安装目录或旧桌面快捷方式。

## Cloudflare Token 的剩余风险与人工验收

交互式 `Read-Host -AsSecureString` 可避免把 Token 写入脚本参数、项目文件和命令历史；但上游 `cloudflared service install` **仍要求把 Token 作为子进程参数**，Windows 服务注册信息也可能长期保存它。脚本不会打印 Token，安装后会提示检查服务注册表 ACL；这**不等于**令牌不会暴露。限制本机可登录账号，查看服务权限；怀疑泄露时在 Cloudflare Zero Trust 轮换连接器 Token、卸载旧服务并重新安装。不要将 Token 发到 QQ/聊天或写在命令行。域名 DNS、固定 Public Hostname、服务 ACL、设备配对及蜂窝网络访问需由管理员自行验收。

本轮**未**安装或卸载真实服务、未登录真实 QQ、未触发真实 DeepSeek 计费、未操作 Cloudflare DNS，也未以真实用户会话启动打包应用。这些不能由离线单测代替。
