# Computer-use 本地接入记录

日期：2026-09-20。
工具源目录：<å·¥å·ç®å½>/computer-use。
已阅读 SKILL.md 和 Windows PowerShell/C# 源文件。

这是直接调用的本地脚本技能，不是 npm/Python 包或 MCP 服务。
通过现有 ShunCode MCP run_command 调用 powershell.exe -NoProfile -File。
未修改源工具、系统执行策略、PATH、注册表或开机启动项。

本项目配置：tools/computer-use.json。
无副作用检查：scripts/check-computer-use.ps1。
检查仅编译 C#、解析 PowerShell，并在 artifacts/computer-use 中生成合成图片验证标记；
不读取桌面，不点击，不输入，不读取或修改剪贴板。OCR 仅检查引擎可用性。

## 使用边界

- 仅在任务需要且目标已确定时操作 QQ AI Bot 等用户授权窗口。
- 默认不截全屏、不操作其他窗口；不读取密码或密钥。
- 截图必须原图查看；坐标来自当前截图，窗口移动或缩放后重新截取。
- 点击前画标记并查看，后台点击后复核光标及画面；失败不自动改为前台操作。
- 前台动作或可能覆盖剪贴板内容的输入需要当次确认。

## 源实现限制

- CaptureWindow 使用 CopyFromScreen 裁剪矩形，非后台窗口渲染；遮挡可能捕获其他应用。
- 标题按子串选择第一个匹配窗口，调用前需核对唯一窗口；不盲用宽泛标题。
- 标记函数返回字符串中的 Windows 路径未做 JSON 转义，不应直接假定为有效 JSON。
- 背景动作 PostMessage 返回码不等于目标应用已响应。
- type.ps1 只尝试保存文本剪贴板，不能保证恢复图片、文件等格式。
- SKILL.md 的 info 输出说明与当前实现略有差异；当前不输出句柄和前台窗口信息。

当前会话没有新增原生 computer-use 工具项，只能通过已有 MCP 命令工具调用。
截图回传需可用的图像通道；本次不声称已验证真实窗口截图/点击/输入的完整闭环。

## Validation result

5 C# modules compiled; 7 PowerShell scripts parsed; OCR engine available.
Synthetic image marking passed and source SHA-256 remained unchanged.
Check process exited with code 0. No desktop interaction performed.
