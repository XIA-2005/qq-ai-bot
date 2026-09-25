# 历史阻塞记录（现已解决）

2026-09-20 补充：crypto.dll 与 ssl.dll 缺失已补齐，真实运行时与打包 EXE 均已通过
二维码生成、刷新和停止验收。详见 docs/mcp-integrated-login.md 的最终验收章节。
以下保留当时的排查记录，不代表当前交付状态。

# 一体化扫码版阻塞记录

2026-09-20

## 已落盘到用户电脑

<é¡¹ç®ç®å½>/src/login.ts 等 v0.2.0 源码与 UI 已同步，依赖已安装，编译通过。
NapCat v4.18.28 Windows Node 运行时已分片下载到 vendor/napcat-runtime，zip SHA-256 与 GitHub 上游 digest 一致。
22 项本地自动化检查通过，Windows npm test 退出码 0；真实 Electron v0.2.0 和最终打包尚未验证。
旧版产物 release/win-unpacked 保留，根目录启动脚本尚未切换到新版本。

## 真实扫码测试失败

scripts/login-smoke.cjs 在用户 Windows 上执行。进程启动后退出，未生成二维码、未登录账号、未发送消息。
诊断输出：
```
[NapCat] [Process] 启动失败: Error: The specified module could not be found.
<é¡¹ç®ç®å½>\vendor\napcat-runtime\wrapper.node
```
PacketHandler、Napi2NativeLoader、FFmpeg Native Addon 均已加载。
说明可能为 wrapper.node 的 DLL 依赖或搜索路径问题，并非 npm TypeScript 构建问题。

## 下一步（尚未验证的候选修复）

上游 napcat.bat 在运行时根目录启动 node.exe；原集成使用独立 profile 作为 cwd。
本工作区 src/login.ts 已改为 cwd=runtime，并将 runtime 加入子进程 PATH。
此候选修改尚未同步到用户电脑，也没有验证效果，不能称为已修复。
应同步后重新编译、运行 scripts/login-smoke.cjs；若仍失败，用轻量 PE 导入表检查定位缺失 DLL，避免大规模 pefile 解析。

## 操作环境故障

本次后半段辅助 Linux 构建环境内存耗尽，bash/进程执行接口持续超时；读写文件仍可用。
因此无法继续调用通过 bash 中转的远端 MCP。用户 Windows 上的诊断进程已正常结束。
不能宣称已交付一体化可扫码成品，不能生成假二维码，不要求用户回到手动 OneBot 配置。

## 后续交付验收

1. 原始运行时确实生成 QQ 登录二维码。
2. Electron 登录页面显示真实二维码并能刷新、停止。
3. 未手动填令牌；扫码成功后自动连接本机 OneBot；默认仍暂停回复。
4. 新版打包到 release-v0.2.0/win-unpacked，不覆盖旧版。
5. 更新启动机器人.cmd 指向新版。保留所有现有 API 设置，不执行任何真实联系人测试消息。
6. 本人手机扫码确认和真实账号风控验证由用户完成。
