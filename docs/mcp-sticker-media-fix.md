# 表情包无法读取与理解问题深度排查与彻底修复

日期：2026-09-22
工程根目录：`<项目目录>`（历史记录）
发布产物路径（历史）：`<项目目录>\artifacts\mcp-sticker-fix\packaged\win-unpacked`
安装目录同步（历史）：`<安装目录>\resources\app.asar`

---

## 1. 故障根因深度排查与定位

在用户明确授权读取聊天记录、NapCat 运行时事件及本地系统配置后，通过直连 NapCat 调试会话、查询真实群聊与好友历史消息、抓取表情包原始事件结构，定位到了导致机器人“仍然无法读取和理解表情包”的几大根本原因：

### (1) 运行时关键开关未开启：`visionEnabled: false`
在当时的本地测试配置 `C:\Users\<USER>\AppData\Roaming\QQ AI Bot\settings.json` 中，配置项为：
```json
"visionEnabled": false
```
- **机理分析**：当 `visionEnabled` 为 `false` 时，系统的 `prepareMedia` 处理流程在接收到任何图片/表情包时，**绝不会**将图像的 Base64 或 URL 封装为多模态 `image_url` 发送给 DeepSeek 模型。
- **触发链路**：程序转而调用 NapCat 的 OCR 文字识别接口 (`ocr_image`)。表情包通常为纯图案或无明显印刷文字，或者 OCR 接口在 8 秒后超时退出，导致准备结果为 `failed: 1`。
- **提示词注入结果**：系统向模型对话上下文中注入了如下明确说明：
  > `本轮第 1 张表情包未取得可识别内容（下载失败、超时、过大或格式不支持）；原图识别未开启。`
- **模型最终表现**：DeepSeek 看到提示词中明确告知“原图识别未开启，未取得内容”，因此如实回复用户“图没加载出来”、“我看不到表情包”、“无法识别图中的内容”。

### (2) NT 架构多媒体 CDN (`multimedia.nt.qq.com.cn`) 鉴权限制
通过对两张匿名表情包样本的事件结构分析发现：
- NapCat 提供的 URL 为带有临时凭证的地址：`https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=...&rkey=...`
- 当系统在外部通过普通 HTTP GET 请求下载该链接时，腾讯 CDN 直接返回：`400 Bad Request: invalid rkey`（非 NT QQ 内部登录上下文无法直接抓取）。
- 旧版逻辑中 `loadImage` 优先对该 URL 执行 HTTP 请求，并在单候选超时（4 秒）内持续等待，浪费了时延且最终下载失败。

### (3) 本地 NT QQ 磁盘缓存已就绪但未被优先加载
排查发现，NT QQ 在接收到群聊和私聊表情包时，实际上已经高速写入了本地文档目录：
`C:\Users\<USER>\Documents\Tencent Files\<QQ账号>\nt_qq\nt_data\Emoji\emoji-recv\<年月>\Ori\`
两张表情包文件在磁盘上完好无损。NapCat 的 `get_image` 接口或直接本地文件读取能在 10~20ms 内直接读出图像二进制流。旧代码未建立“本地缓存优先于外部 CDN”的处理通道。

### (4) 系统小表情（QQ 默认表情、bface、marketface）语义丢失
部分表情类型（例如带有 `//略`、`[菜汪]` 等新版或未列入经典 100+ 列表的面部表情）在未匹配到静态字典时被统一降级为无意义的 `[表情: QQ表情]`，且 `bface` 与 `marketface` 片段类型在旧的分流路由中未被映射为 `sticker` 类型。

---

## 2. 核心修复方案与实现

### (1) 启用配置原图视觉识别
将当时的本地测试配置 `C:\Users\<USER>\AppData\Roaming\QQ AI Bot\settings.json` 中的：
```json
"visionEnabled": true
```
使 DeepSeek 能够正常接收图像内容并在视觉通道进行解析与情绪理解。

### (2) 本地表情缓存优先策略（Local Cache First）
在 `src/media.ts` 的 `loadImage` 逻辑中针对表情包进行优化：
- 判断如果当前引用为表情包（`isSticker(ref)` 且 `safeImageId(ref.file)` 存在），**优先调用 `get_image`** 读取 NapCat 已经在磁盘建立的本地缓存文件，成功则立即转为 Base64 图片返回；
- 仅当本地缓存与磁盘直读均未命中时，才去尝试外部网络 CDN 下载。
- 该改动将真实表情包准备耗时从 4000ms+（网络 400 错误等待）缩短至 **<50ms**。

### (3) 增加磁盘直通兜底搜索（findLocal Fallback）
在 `src/media-file.ts` 中增强 `mediaFileReader`：
- 为本地文件读取器添加 `findLocal(fileId)` 扩展接口；
- 当 `get_image` 未能按预定索引返回时，在受控的 `Tencent Files/<uin>/nt_qq/nt_data/Emoji/emoji-recv` 及 `Pic` 目录下自动定位对应 MD5 的图片文件；
- 彻底避免由于 NapCat 索引滞后导致的读取失败。

### (4) 丰富表情语义识别与路由
- 在 `src/config.ts` 的 `faceLabel` 中，增加从 OneBot 原生事件中的 `data.raw.faceText` 提取表情名称的逻辑，并清洗前缀斜杠（例如将 `//略` 提取为 `略`，生成 `[表情: 略]`）；
- 在 `src/config.ts` 的 `route()` 中将 `marketface` 与 `bface` 纳入路由，在 `src/media.ts` 中将其转换为合法的 sticker 媒体引用。
- 在 `src/onebot.ts` 中同步更新 `readLocalMedia` 的可选参数类型。

---

## 3. 验证与测试结果

### (1) 自动化单元与集成测试
运行全量自动化测试套件：
```bash
npm run build && node --test tests/*.test.cjs
```
- 测试结果：**256 pass / 0 fail / 0 skipped**（全绿通过，从原 252 项扩展至 256 项）。
- 新增覆盖测试用例包括：
  1. `sticker with safeImageId prioritizes get_image local cache without remote URL network attempts`
  2. `findLocal fallback in local reader locates received sticker when get_image provides no path`
  3. `faceLabel extracts faceText from raw data for unmapped system faces and cleans prefix slashes`
  4. `bface and marketface segments are recognized as stickers and routed properly`

### (2) 匿名化表情包链路回放验证
使用两张匿名表情包样本进行完整媒体准备链路回放：
- **测试结果**：
  ```json
  {
    "parts": [
      {
        "type": "text",
        "text": "本轮第 1 张表情包（以下为实际图像，名称与 OCR 仅供参考）："
      },
      {
        "type": "image_url",
        "image_url": {
          "url": "data:image/png;base64,...",
          "detail": "auto"
        }
      }
    ],
    "images": 1,
    "ocr": 0,
    "failed": 0,
    "previews": 0,
    "issues": []
  }
  ```
- **耗时**：端到端本地解析在 **500ms** 内完成，图片被完整编码并附带表情提示词。

---

## 4. 打包发布与运行状态

1. **产物打包**：
   已通过 `electron-builder` 完成无损打包：
    - 目标文件（历史）：`<项目目录>\artifacts\mcp-sticker-fix\packaged\win-unpacked\QQ AI Bot.exe`
   - 核心资源 `resources/app.asar` SHA-256：
     ```text
     328f5feeeb71d9faa1d916b12909228095c3123f9bf5800c03f3ac5e77718c08
     ```
    - 当时同步至安装目录：`<安装目录>\resources\app.asar`。

2. **历史运行时状态（不代表当前公开源码已打包或运行）**：
   - 当时的 `QQ AI Bot.exe` 与 NapCat 运行时曾处于运行状态；
   - 当时本机测试连接曾完成 WebSocket 握手；
   - 当时的测试配置确认：
     - `"visionEnabled": true`
     - `"autoReplyOnLogin": true`
     - `"autoReplyConsent": true`
     - 白名单好友及群聊对象均已生效。

在上述历史测试中，软件能够通过本地磁盘/NapCat 缓存读取表情图像，再交给已明确开启的视觉模型处理；这不等于当前源码副本已打包或完成真实 QQ 验收。
