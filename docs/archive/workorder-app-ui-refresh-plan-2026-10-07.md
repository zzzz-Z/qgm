# UI 优化计划：对标成熟编程智能体（WO-20261007-02）

> **状态：计划待批——本文档只做诊断与方案，未动任何 UI 代码。**
> 发起：用户 2026-10-07 显式要求「参照成熟编程智能体优化当前应用 UI，先生成计划不要执行」。
> 范围：`packages/client` 纯 UI 层（样式/交互/可访问性/状态反馈）。**不改行为与数据流**。

## 一、现状取证（2026-10-07 00:12 实测）

证据两类：对运行中实例（127.0.0.1:5175）的 Playwright 截图 + 源码 `file:line`。

- 截图（运行态，不随库，位于 `.ai-runner/tmp/`）：
  - `ui-01-dark-1600.png` 暗色 1600×950 首屏
  - `ui-02-light-1600.png` 亮色同视口
  - `ui-03-1024.png` / `ui-04-720.png` 窄屏两档
- 界面身份：三栏 IDE 式（左 AI 站点 250px 常驻 / 中「执行记录 + 底部脚本编辑器」/ 右文件树+变更 320px 可拖拽），底部圆角大输入框。

### 实测发现（按严重度）

- **F1 窄屏断裂（截图实锤）**：720px 下主编辑区被挤成约 20px 细条，空态文字消失，输入不可用。右侧 SidePane 不收起、左侧 AiWindowList 固定 `flex: 0 0 250px` 无断点（`AiWindowList.vue:152-155`）。窄屏抽屉状态 `sideDrawerOpen` 有声明、有 backdrop（`SidePane.vue:83`），但**全仓无任何处置为 true 的入口**（`ScriptPanel.vue:76` 声明后零写入）——死状态。
- **F2 弹层无语义（4 处手写、无通用组件）**：文件详情弹窗（`FileTree.vue:403-428`）、确认弹窗（`ToastHost.vue:36-66`）、Diff 预览（`DiffOverlay.vue:28-44`）、@ 文件选择器（`ScriptEditor.vue:370-389`）。全部无 `role="dialog"` / `aria-modal` / 焦点陷阱；Esc 仅 3 处支持，确认弹窗不支持。
- **F3 设计令牌空转**：`--font-*` 全客户端使用率约 4%（约 120 处硬编码 `font-size`）；`--space-*` 定义于 `style.css:89-98` 但**零使用**；存在浏览器缩放产物 `11.375px`。辅助文本大量落在 9–10.5px（`ScriptCard.vue:150` 的 9px、多处 10.5px 卡片头）。
- **F4 `!important` 战争**：全客户端 190 处，其中 `App.scss` 一家 179 处——全局层与组件 scoped 层在打优先级战争，是样式不可预测的根因。
- **F5 状态反馈缺口**：TaskProgressPanel 首轮 poll 无 loading、失败静默直到连续 3 次失败（`TaskProgressPanel.vue:198-232, :269`）；AiWindowList 无 loading/empty/error 三态（失败仅 toast）；DiffViewer 异步高亮未就绪时静默回落。
- **F6 焦点与键盘缺口**：ScriptCard 可点击 div 无 role/tabindex/keydown（`ScriptCard.vue:61-65`）；树节点全部 `tabindex="0"` 无 roving tabindex（Tab 序爆炸）；A/M/D 变更徽章仅用色点区分（`FileList.vue:89-97`），语义只在 tooltip。
- **F7 spinner/骨架/按钮 6+2+3 套各自手写**：spinner 6 处、骨架屏 2 处复制、`.ghost-btn` 3 处独立定义——无原语组件。
- **F8 重复硬编码颜色**（有语义变量的不用）：`ScriptToolbar.vue:166`（#f0abfc）、`:229-230`（红系）、`TaskProgressPanel.vue:412/454/470/483`（#22c55e、#58a6ff→#3fb950 渐变、#d29922、#f85149）、`AiWindowList.vue:184/225/235`（rgba(88,166,255)）、`FileTree.vue:463`、`script-panel.scss:107`、`terminal-pane.scss:525` 等 15+ 处。
- **F9 空态无引导**：1600×950 首屏中央约 60% 面积为空，仅一行「还没有执行记录」+「点击 运行」；新用户无从知道「运行什么、去哪写、循环是什么」。左栏仅 2 个站点条目却常驻 250px。

### 实测确认的优点（保留，不动）

- 双主题令牌体系完备（暗/亮两套语义变量 + color-scheme 跟随 + reduced-motion 尊重），底子是好的。
- 文件树图标已是内联 SVG（`file-tree-icons.ts`，VSCode Seti 风格彩色 path）——不是 emoji，属风格选择。
- 树/列表有 role + 键盘（`FileTree` role=tree/treeitem、`AiWindowList` listbox/option）；等待条有 `aria-live="polite"`（`TerminalPane.vue:467`）；`v-tooltip` 指令自动补 aria-label（`directive.ts:49-53`）。
- ScriptPanel 逻辑下沉 6 个工厂，模板仅壳——组件架构健康。
- 无假进度条（离散步骤标记，符合后文反模式清单）；暂停/恢复/自动接管已实现「人在环路」。

## 二、对标结论：成熟编程智能体收敛出的模式

来源：Claude Code / Cursor / Cline / Aider 的界面收敛（jacar.es《UI Design for Agents》）、AWS Cloudscape「Progressive steps」genAI 模式、agenticuxpatterns.com「Execution Progress View」、Anthropic frontend-design skill（2025-11 发布）。

- **模式 1 · Progress panel（四家产品独立收敛，视为有效）**：会话与任务进度分离；每步可折叠、可审计——「用户不想读每个中间输出，但出事时要能打开某一步查看」。本项目 TerminalPane + RoundCard + TaskProgressPanel 已是此形态雏形，差距在「步骤原语不统一」（三套行项视觉）与「三态不全」。
- **模式 2 · Review & approval（域语义审批）**：副作用动作前用领域视觉呈现（文件 → diff）。本项目走「预检 + 执行后回滚」路线，形态不同但目的相同；UI 层差距是 A/M/D 仅色点、Diff 弹层无语义。
- **模式 3 · Execution explorer（长任务可导航历史）**：线性日志不够，需要树/锚点导航。本项目 RoundDivider 时间线可加锚点导航，列 P2 探索。
- **等待分层（Cloudscape）**：<10s 用 spinner；>10s 显示当前阶段与已等待时长；错误必须带 retry；结果默认折叠可展开。本项目 wait-banner 有基础，无时长/阶段表达。
- **反模式清单（agenticuxpatterns）**：不做假平滑进度条（未违反）；不默认暴露全部微操作（未违反）；不用「Step 3: Processing」式含糊标签——**执行记录的每步标题须含具体动作对象**（脚本名/文件名），此点需在 F7 统一原语时一并校验。
- **Anthropic frontend-design 的取舍**：采纳其**纪律与清单**（SVG 图标、对比度 ≥4.5:1、cursor-pointer、四断点无横向滚动、hover 稳定不 scale、字重层级）；**不采纳**其「极端美学方向」主张（brutalist/retro-futuristic 等）——本产品是工程工具，克制即正确；其 checklist 恰好逐条命中 F1–F8。

## 三、设计方向判定（先想清楚再动手）

- **Purpose**：开发者监督 AI 自动改代码的工作台。核心动作链：写脚本 → 执行 → 看输出 → 审变更 → 回滚/回传。UI 的唯一任务是让这条链**可扫读、可审计、低惊吓**。
- **Tone**：GitHub / Linear 一脉的工程克制风。现状已在此方向上（暗色 #0f0f0f 系 + 亮色 GitHub 灰系），**保持并提纯**，不换方向。
- **Constraints**：Vue 3 + UnoCSS presets（无组件库）、双主题、面板常驻的性能开销、e2e 选择器耦合。
- **Differentiation**：执行全链路可审计（脚本 → 输出 → 变更 → 回滚）是本产品独有的完整闭环——UI 应把这条链做成视觉主角，而非让「文件树」「站点列表」抢戏。

## 四、实施计划（四阶段，顺序即依赖，每阶段独立可回滚）

### 阶段 A · 阻断修复（P0，先做）

- **A1 窄屏响应式修复（F1）**
  - 改动：`ScriptPanel.vue` / `script-panel.scss` / `SidePane.vue` / `AiWindowList.vue`。≤1100px 时 AiWindowList 收为图标条或并入抽屉；SidePane 断点内改 overlay 抽屉并接通 `sideDrawerOpen`（补一个悬浮触发钮）；主区设 `min-width` 下限。
  - 判据：Playwright 于 375 / 768 / 1024 / 1440 四档截图——无横向滚动，主编辑区可用宽度 ≥ 视口 50%；既有 e2e 全绿。
- **A2 弹层原语统一（F2+F7 弹层部分）**
  - 改动：新增 `components/feedback/AppModal.vue`（或 `useOverlay` 组合式）：`role="dialog"` + `aria-modal` + Esc 关闭 + Tab 焦点陷阱 + 关闭后焦点归还。替换上述 4 处手写 mask。
  - 判据：新增 node-test 断言 Esc/焦点行为；4 处替换后各弹层键盘可开、可关、可逃。

### 阶段 B · 视觉语言收口（P1）

- **B1 图标与状态符号纪律**：UI chrome 层清 emoji（`statusText` 的 ✅/❌/⚠️、空态 📋 等）→ 单色 SVG + 语义色；**文件树彩色品牌图标保留**（VSCode 同款惯例，是特色不是缺陷）；日志/脚本正文内的 emoji 属内容层，不动。
- **B2 字号令牌落地（F3）**：先改 6 个高频文件（script 四件 + panels 两件）：`font-size` 硬编码 → `var(--font-*)`；正文下限 12px、辅助下限 11px（9/10/10.5px 全部上调）；消灭 11.375px。
- **B3 硬编码颜色归位（F8）**：上列 15+ 处 → 既有语义变量（--success/--warning/--danger/--primary/--danger-bg）；hljs 主题色单独抽 `--code-*` 令牌组（`DiffViewer.vue:392-415`）。
- **B4 `!important` 消减（F4）**：App.scss 179 处按 header / layout / 按钮三批迁入对应组件 scoped，全局层只留 reset + 令牌 + 工具类。每批跑 e2e 再提交，单批可回滚。
- **B5 交互原语合并（F7 其余）**：spinner → `AppSpinner.vue`；骨架屏 → `AppSkeleton.vue`；`.ghost-btn` → uno shortcut（`btn-ghost` 已存在，直接收敛）。

### 阶段 C · Agent-UX 对标（P2，按模式逐项）

- **C1 空态升级（F9）**：中央空区改「三入口引导」（运行第一个脚本 / 开启自动循环 / 选择 AI 站点），每入口一句具体说明 + 快捷动作按钮；左栏 250px 收窄为 200px 或可折叠。
- **C2 步骤原语统一（模式 1）**：定义 `StepItem` 视觉规范（单色状态图标 + 具体动作标题 + 耗时 + 可展开输出），ScriptCard / RoundCard / TaskProgressPanel 行项先统一 token 级视觉，**不合并组件本体**。同步校验反模式：每步标题含具体对象（脚本名/文件名），禁「处理中…」式含糊标签。
- **C3 等待分层（Cloudscape）**：wait-banner（`TerminalPane.vue:467` 基础上）>10s 时追加「已等待 Ns + 当前阶段」；TaskProgressPanel 失败态加显式 retry。
- **C4 三态补齐（F5）**：TaskProgressPanel 首轮 poll 骨架；AiWindowList loading/empty/error；DiffViewer 高亮未就绪时显示占位而非静默。
- **C5 键盘与双通道（F6）**：树 roving tabindex；ScriptCard 可点击 div 补 `role="button"` + `tabindex` + Enter/Space；A/M/D 徽章改「字母 + 色」双通道（GitHub 同款）。
- **C6（探索项，可砍）**：RoundDivider 时间线加锚点导航（execution explorer 模式），点击圆点滚动定位到对应轮次。

## 五、明确不做

- 不引入组件库（Naive/Element/Arco）：与既有 UnoCSS shortcuts 体系风格断裂且增体积；原语自建。
- 不做激进美学改造：不换字体、不上重动效、不追 Anthropic skill 的「极端 Tone」——工具型产品的正确答案是克制。
- 不改行为与数据流：循环引擎、看板语义、后端路由、`complete`=移除语义等一律不碰；「执行后回滚 → 执行前审批」属行为级改造，不在本单。
- 不合并 ScriptCard / RoundCard / TaskProgressPanel 组件本体（只统一视觉原语，避免大重构风险）。

## 六、验收清单（每阶段完成时逐项打勾）

- UI chrome 无 emoji 图标（SVG only）；文件树彩色 SVG 与日志正文 emoji 不在清缴范围。
- 暗/亮双主题正文对比度 ≥ 4.5:1（B2 提字号下限后重点复测亮色）。
- 375 / 768 / 1024 / 1440 四档无横向滚动，主输入区可用。
- 所有弹层：Esc 可关、焦点陷阱、`role="dialog"`、关闭后焦点归还。
- 可点击元素 `cursor-pointer` + 键盘可达；hover 为稳定过渡（无 scale 位移）。
- 所有异步面板 loading / empty / error 三态齐备，错误可 retry。
- 步骤标题均含具体动作对象，无「处理中…」式含糊标签。
- 工程闸门：`pnpm verify`（四套 tsc + lint + 单测）与 e2e 全绿；注意宿主侧跑 eslint 须剥 `NODE_OPTIONS` 垫片。
- 每阶段开工前 `pnpm git:archive -- --path packages/client` 落兜底；改 DOM 结构前先 grep `packages/client/e2e/` 确认选择器耦合。

## 七、风险与顺序约束

- **e2e 选择器耦合**是最大返工源：A1/A2/C1 都动 DOM 结构，动前必须核对 e2e。
- **B4（!important 消减）最易引入视觉回归**：排在 B1–B3 之后、C 之前，三小批各带 e2e；若某批回归无法快速定位，回滚该批并记录，不强攻。
- 阶段 A 必须最先：F1 是可用性阻断，且 A2 的弹层原语是 B/C 多项的前置依赖。
- 观察期说明：本单为用户 2026-10-07 显式发起的 UI 专项，不新增后端/循环功能，不违反阶段 4 约束。
