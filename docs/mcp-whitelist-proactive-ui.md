=== READ_FILES BEGIN ===
=== FILE BEGIN ===
path: "docs/mcp-whitelist-proactive-ui.md"
status: success
lines: 1-84
total_lines: 84
truncated: false
has_more: false
next_start_line: null
version: sha256:039a3c8cb5898b58f370f3f1f54fd1e9dd84c462804a70de742df0b72c4f49b2
--- CONTENT BEGIN ---
1: # 白名单与主动接话群动态行编辑器 UI 对齐实现方案
2:
3: ## 1. 概述与问题分析
4:
5: 在 QQ AI Bot 前序版本中，规则设置页面存在以下两类 UI 及交互问题：
6:
7: 1. **白名单面板与行高不一致**：
8:    - 「私聊好友白名单」与「群白名单」各自添加一行后，两张卡片及单行的垂直与水平尺寸存在偏差。
9:    - 根因分析：
10:      - `.whitelist-grid` 默认使用了 `align-items: start;`，网格两列各自由自身内容撑开，无法自动填补高度差。
11:      - 副标题文案字数不对称（原好友副标题 16 字为 1 行，群副标题 42 字换行为 2~3 行），导致下方输入区域起始 Y 坐标不同。
12:      - 每行内部的摘要信息（`.row-profile-summary`）在群模式下有额外的「方式继承全局」或「持续参与」，导致在窄屏幕下折行。
13:      - 成本摘要（`.row-cost-summary`）在空行状态下高度为 0，输入账号后增加一行文字，导致单行高度跳动。
14:      - 底部操作栏（`.whitelist-footer`）采用 `margin-top: 12px;` 而非弹性自适应贴底，使得卡片底边未水平对齐。
15:
16: 2. **主动接话群缺少动态行管理**：
17:    - 「允许主动接话的群」此前采用普通 `<textarea id="proactiveGroups">`，用户需手动换行或用逗号分隔，容易输入格式错误且无法单独增删单行。
18:    - 缺乏行号指示、号码合法性实时校验，以及未加入群白名单时的关联提示。
19:
20: ---
21:
22: ## 2. 详细改造与体验优化方案
23:
24: ### 2.1 UI 长度与对称性完全对齐
25:
26: 1. **容器高度与布局对称 (`ui/whitelist-rows.css`)**：
27:    - 将 `.whitelist-grid` 设置为 `align-items: stretch;`，强制左右两列卡片等高。
28:    - `.whitelist-editor` 设置为 `display: flex; flex-direction: column; height: 100%; box-sizing: border-box;`。
29:    - `.whitelist-editor>small` 设定 `min-height: 38px; line-height: 1.45;`，确保无论文案是否折行，标题区占据一致高度。
30:    - `.whitelist-list` 设置 `flex: 1 1 auto; align-content: start;`，内容区域自动填满剩余空间。
31:    - `.whitelist-footer` 设置 `margin-top: auto; padding-top: 12px;`，操作按钮与计数器永远对齐在卡片底部。
32:
33: 2. **单行条目高度恒定 (`ui/workspace.css`)**：
34:    - `.whitelist-entry` 声明 `box-sizing: border-box;`。
35:    - `.row-profile-summary` 与 `.row-cost-summary` 统一设置 `min-height: 16px; line-height: 1.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`。
36:    - 即使新建空行尚未计算成本，预留的 16px 行高也能杜绝高度突变，使好友行与群行高度严格维持在 131px。
37:
38: 3. **文案对称平衡 (`ui/index.html`)**：
39:    - 私聊好友白名单：`一个 QQ 号一行，仅处理好友私聊；独立设置可选专属人设与记忆`
40:    - 群白名单：`一个群号一行，默认明确 @ 本账号才触发；单独设置可选持续参与`
41:
42: ### 2.2 主动接话群动态行编辑器实现
43:
44: 1. **组件扩展 (`ui/whitelist-rows.js`)**：
45:    - `mount` 接口新增 `kind: 'proactive'` 支持，共享序号、账号输入、删除行、粘贴拆行（Enter/Paste）以及上限管控（最多 200 行）。
46:    - 摘要区域（`.row-proactive-summary`）提供智能感知：
47:      - 若群号未填，不显示提示；
48:      - 若号码格式非 5–16 位数字，提示「号码格式无效（须为 5–16 位数字）」；
49:      - 若该群尚未在群白名单中，高亮显示琥珀色警告「提示：该群尚未加入上方群白名单，保存时将无法通过验证」；
50:      - 若已在白名单中，自动关联并显示群备注名 `群 · 备注名 (群号)`。
51:    - 新增 `setDisabled` 支持及 DOM 属性代理 `Object.defineProperty(container, 'disabled', ...)`，向下兼容所有调用方。
52:
53: 2. **交互与用户体验细节优化**：
54:    - **`getValues()` 解耦只读查询**：避免在主动接话群组件内部动态监听查询群白名单时误触发 HTML5 表单校验聚焦弹窗。
55:    - **Datalist 原生下拉补全建议**：为每个主动接话群输入框配置 `list="proactive-group-suggestions"`，从上方群白名单动态注入选项（包含备注名），支持点击直接补全，免去手动输入群号。
56:    - **群白名单即时双向联动 (`onChange`)**：群白名单增删改或更新备注时，立即通过 `onChange` 驱动接话列表摘要及下拉建议刷新，零延迟感知。
57:    - **全角数字自动半角化 (`cleanDigits`)**：兼容中文输入法全角数字（`０-９`），输入或粘贴时无损自动转换为半角数字，并保留光标位置。
58:    - **键盘流体验优化 (空行 Backspace 快速删除)**：光标在空行时按下 `Backspace`，自动删除该空行并平滑对焦上一行，对齐现代文档编辑器习惯。
59:    - **失焦自动修剪空格 (`blur trim`)**：失焦时自动清理首尾空格，防止复制误带空白导致号码失效。
60:    - **状态徽章增强**：实时提示重复群号（保存时自动合并）、群是否已在上方停用（防止用户误以为接话未生效）、以及独立配置已开启接话的模式提示。
61:    - **更精准的计数指示与占位符**：接话群专有计数后缀 `x 个接话群 · y / 200 行`，占位符更新为 `填写或从群白名单选择`。
62:    - **禁用态视觉统一**：未勾选主动接话时，容器追加 `.disabled` 灰度半透明样式。
63:
64: 3. **应用集成 (`ui/app.js`)**：
65:    - 挂载 `proactiveEditor`，关联群白名单动态获取函数 `getGroups` 与 `getProfiles`，通过 `onChange` 实时感知群变更。
66:    - `fill(v)` 读取 `v.config.proactiveGroups` 进行动态行初始化，并同步启用/禁用状态。
67:    - `read()` 通过 `proactiveEditor.get()` 获取去重、校验过滤后的纯群号数组保存入配置。
68:    - 勾选 `proactiveEnabled` 时动态切换整个行编辑器内所有控件的禁用状态。
69:
70: ---
71:
72: ## 3. 测试与验证结果
73:
74: 1. **单元与集成测试**：
75:    - `npm test` 执行并通过全部 163 个测试套件，零失败。
76:    - 覆盖动态行挂载、输入解析、增删行、禁用态、校验过滤、Datalist 建议、双向广播、全角转换、退格删除、重复与停用状态提示，以及 CSS 结构对称性测试 (`tests/proactive-and-whitelist-ui.test.cjs`)。
77:
78: 2. **打包真实运行时验证**：
79:    - 运行 `npm run pack:win` 构建打包应用。
80:    - `node scripts/verify-group-session-packaged.cjs` 13 项打包校验全部通过。
81:    - `node scripts/verify-whitelist-proactive-packaged.cjs` 7 项 CDP 运行时视觉及布局尺寸校验全部通过：
82:      - 初始状态下两侧 fieldset 的 offsetHeight/clientWidth 像素级完全一致。
83:      - 分别点击「+ 添加一行」后，两侧外框高度和单个 entry 条目高度均保持完全相同。
84:      - 截图生成于 `artifacts/whitelist-proactive-aligned-v0.9.0.png` 与 `artifacts/whitelist-top-v0.9.0.png`。
--- CONTENT END ---
=== FILE END ===
=== SUMMARY ===
requested: 1
succeeded: 1
failed: 0
skipped: 0
truncated: 0
=== READ_FILES END ===
