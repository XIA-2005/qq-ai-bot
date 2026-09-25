# 一体化扫码改造 / 2026-09-20

## 目标

取代原来的外置 NapCat 手动配置流程。软件提供真实二维码、自动令牌、动态本机端口及运行时生命周期管理。
用户只需扫码、输入自己的 DeepSeek API Key、选择白名单并启用回复。

## 参考和运行时

- https://napneko.github.io/guide/boot/Shell
- https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.28
- 上游 packages/napcat-webui-backend/src/api/QQLogin.ts / api/Auth.ts / router/QQLogin.ts
- 上游 LICENSE：Limited Redistribution License for NapCat，非商业限制，随附完整许可。
- 未修改上游运行时代码，不使用快速登录参数，不采集密码、不更改设备标识或绕过风控。
- 固定 NapCat.Shell.Windows.Node.zip SHA-256：
  fb64fa3b036ad2df1a5d7c204c482694c20e4b763978c8a4968fd3474c05b4a8。

## 实现

- src/login.ts：启动独立 node.exe，随机两组令牌与本机端口，自动写入专属配置。
- 官方管理接口 auth/login（sha256(token+'.napcat')）与 QQLogin/CheckLoginStatus / RefreshQRcode。
- 本地 qrcode 库生成 PNG Data URI，渲染页不连接任何远端 WebUI。
- OneBot 仅在服务报告已在线后连接；扫码或连接成功不会开启自动回复。
- 移除面向用户的 OneBot Token、WebSocket 地址输入和手工配置步骤。
- 保存模型/白名单设置只暂停回复，不破坏 QQ 登录。
- 退出时终止本软件的子进程，不按 QQ.exe 名称杀死其他 QQ 进程。
- 禁用上游 bypass、自动时间同步及 FFmpeg 自动下载；不触发设备验证绕过。
- 上游日志可能含扫码链接或内部令牌，因此不转发原始 stdout/stderr，也不记录二维码正文。

## 数据与边界

API Key 保持 DPAPI 加密。NapCat 读取的临时接口令牌保存在其独立工作目录 JSON 中，不能声称全部密钥均加密。
子进程设置独立用户环境和工作目录，但 Windows 原生 QQ 组件的完整数据隔离未经证明，不作承诺。
停止进程不等于 QQ 服务端撤销授权。切换账号需要手机上选择目标账号并重新扫码。
运行时只在本次用户电脑内使用，不公开打包分发腾讯组件或修改版 NapCat。

## 验证进度

- 本地 TypeScript 编译及 22 项自动化测试通过。
- UI 五页导航、表单、确认取消、900px 布局检查通过。
- 真实运行时二维码和打包 EXE 验收均通过，详见下节。
- 本人扫码确认、真实账号登录和真实好友/群收发不能用模拟测试代替。

## 最终修复与交付验收

- 缺失的直接依赖为 crypto.dll 和 ssl.dll。只从用户已有官方 QQ 更新包
  <QQå®è£ç®å½>/versions/9.9.35-52892.zip 的 resources/app/ 提取到机器人专属运行时，
  没有修改用户安装的 QQ；来源及 SHA-256 记录在运行时 supplemental-dlls.json。
- 启动 cwd 与 PATH 改为运行时目录。上游 NapCat 程序代码未修改。
- Windows TypeScript 构建及 22 项自动化测试全部通过。
- scripts/login-smoke.cjs：REAL_QR_GENERATED，真实运行时生成二维码，未扫码。
- scripts/desktop-login-smoke.cjs：DESKTOP_QR_PASS。真实 Electron 显示二维码、
  刷新生成不同的二维码、停止后清除二维码并关闭自有进程。无手工 Token/端口输入框。
- Windows x64 免安装目录打包退出码 0。
- scripts/verify-packaged.cjs：PACKAGED_ACCEPTANCE_PASS。直接运行产物 EXE，
  再次验证完整运行时、自有 UI、真实二维码显示、不同二维码刷新及停止。
  测试用 localhost 调试端口只用于本次验收，测试进程已关闭，正常入口不携带调试参数。
- 上述测试没有确认任何真实账号登录，没有发送 QQ 消息，也没有调用收费模型。
  用户手机扫码确认、风控验证以及登录后的真实好友/群消息仍由用户最后验收。

交付：release-v0.2.0/win-unpacked/QQ AI Bot.exe（需整个目录）。
根目录启动机器人.cmd 已切换到新版；旧版目录 release/ 保留。
使用说明见 README.md。第三方许可见 THIRD-PARTY-NOTICES.md。

最终普通启动检查：新版窗口标题 QQ AI Bot，Responding=true，无 remote-debugging-port 参数。
