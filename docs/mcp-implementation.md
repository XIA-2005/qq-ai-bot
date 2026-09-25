# QQ AI Bot 第一版实施记录

日期：2026-09-20。目标目录：<é¡¹ç®ç®å½>。

## 架构与边界

Electron + TypeScript 桌面软件；OneBot 11 正向 WebSocket 连接 NapCat；
HTTPS POST https://api.deepseek.com/chat/completions 调用 deepseek-flash。
禁用思考、非流式输出，默认最多 1024 输出 Token、45 秒超时。
不封装 QQ 登录协议，不采集 QQ 密码，不包含 NapCat 或 QQ 客户端。
真实登录需用户在 NapCat 中完成，本程序通过 get_login_info / get_status 确认状态。

官方参考（本次已读取）：
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://napneko.github.io/guide/napcat
- https://napneko.github.io/config/basic
- https://napneko.github.io/guide/start-install

NapCat 文档确认正向 WebSocket 服务端支持事件和 API 双工、Array 消息格式、令牌。
这不是 QQ 官方授权声明，也不代表已经验证用户账号或 QQ 版本兼容性。

## 已实现

- 5 个页面：状态、QQ 连接、模型、规则、日志。
- 默认暂停；保存配置、掉线、退出都停止自动回复；重连不自动恢复回复。
- 仅白名单好友的 friend 私聊；仅白名单群中精确 @ self_id。
- 过滤自身消息、旧消息、黑名单、媒体空消息，最大输入 4000 字符。
- 上下文按私聊好友 / 群+发言人隔离；最多 100 会话、每会话 12 轮，仅内存。
- 消息串行、20 条队列、默认每会话 5 秒冷却及每分钟 10 请求上限。
- 10 分钟内最多 10000 ID 去重；重启不恢复旧上下文。
- 暂停取消模型请求并丢弃未发送回复；已发给 QQ 的消息不可撤回。
- 发送失败/确认超时不重试，避免重复消息。限流时丢弃，不补发。
- 模型返回只作为 text 段发送，不能注入 CQ at/image 等命令。
- 主进程保存密钥（Electron safeStorage，Windows DPAPI），渲染进程不回显密钥。
- 沙箱、上下文隔离、CSP、拒绝任意导航和权限、IPC 白名单和来源校验。
- OneBot 仅本机 ws，必填至少 16 字符令牌；模型地址仅允许 DeepSeek 官方地址；不跟随重定向。
- 仅脱敏运行日志，内存上限 150 条，不记录正文。

## 当前验证

本地 TypeScript 编译通过；17 项自动化检查通过。
包含真实本地 WebSocket 模拟 OneBot 服务端握手、Bearer 鉴权、收发与关闭测试。
模型测试使用模拟响应，没有消费 API 额度。
Windows 构建、界面验收与真实账号联调结果另行补充，不得以模拟通过代替真机验收。

## 未完成的用户联调条件

1. 用户安装并登录与当前 QQ 兼容的 NapCat，确认接受非官方接入风险。
2. 创建仅监听 127.0.0.1 的正向 WebSocket，配置令牌及 array 消息格式。
3. 用户在本地软件输入 API Key 并自行确认一次可能计费的模型验证。
4. 先对一个测试好友和一个测试群启用白名单，验收收发、掉线和暂停。

不自动安装 QQ 适配器、不登录账号、不发真实消息、不调用收费接口、不修改防火墙或公网端口。

## 补充验证

- Windows Node 24.15.0：TypeScript 编译及 17 项自动化检查通过。
- Windows Electron 40.10.2：隔离临时配置下真实窗口启动、沙箱预加载桥、IPC、
  默认暂停、DPAPI 加密保存与重新解密、密钥不回显、5 页导航、未连接启动拦截、
  删除测试密钥检查均通过。结果见 artifacts/electron-smoke.json。
- Chromium 界面模拟检查：5 页切换、取消确认不触发启动、白名单表单保存、
  900px 宽窗口无横向溢出、无页面脚本错误，均通过。模拟不代表真实 QQ 接入。
- npm audit --omit=dev：本次生产依赖审计报告 0 漏洞；不代表无未知漏洞。
- ShunCode 终端继承 ELECTRON_RUN_AS_NODE，初次冒烟启动受影响；清除此变量后通过。
  开发启动脚本 scripts/launch.cjs 已主动删除该变量，不改系统环境。

自动化检查没有登录真实 QQ、没有真实联系人消息，也没有真实 DeepSeek 调用。

## 交付范围

Windows x64 免安装目录：release/win-unpacked/。
根目录提供 启动机器人.cmd，清理仅子进程中的 ELECTRON_RUN_AS_NODE 后启动软件。
本次 NSIS 安装包构建阶段长时间未完成，已停止；未声称生成安装包。
运行时准备阶段改用 npm 已安装的同版本 Electron，避免重复下载。
没有安装软件到系统目录，没有改注册表、QQ 配置、防火墙或系统环境变量。
QQ 登录、模型真实调用、真实好友与群回复仍需用户在本地完成联调。

最终验收补充：Windows x64 目录打包命令退出码 0。
成品 release/win-unpacked/QQ AI Bot.exe 已启动，检测到标题为 QQ AI Bot 的窗口，Responding=true。
成品保持默认暂停，未配置或连接真实账号。散列见 artifacts/SHA256SUMS.txt。
Electron 开发态冒烟截图见 artifacts/desktop.png；已打包成品的进程窗口检查不代替真实账号联调。
