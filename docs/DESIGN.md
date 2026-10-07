# DESIGN.md · UI 设计规范

> 本文件是 AI Runner 工作台的 UI 设计 SSOT。所有组件改动前先读此文件。
> 落地依据：2026-10-07 会话对标 Claude Code / Codex / Cursor / Devin 的 UI 调研。
> token 事实源：`packages/client/style.css`（147 个 CSS 变量），本文档是索引与规则。

## §1 核心原则（对标优秀编程智能体）

1. **输出优先，非装饰优先**：终端与 Agent 转录是体验中心，侧栏/工具栏退后。
2. **可观察的自主性**：脚本执行流式展示 stdout/stderr，用户边看边判断方向。
3. **4px 网格**：所有间距是 4 的倍数；TLBR 内边距对称；只选一种阴影策略。
4. **灰度建结构，颜色传含义**：层级靠灰度，强调色只给焦点/状态。
5. **动效如器械，非装饰**：fast 150ms / base 200ms / slow 300ms。

## §2 间距与网格

基准：`4px`。常用档位：`4 / 8 / 12 / 16 / 24 / 32`。

- 控件内间距：`4` / `8`
- 卡片内间距：`8` / `12`
- 面板内间距：`12` / `16`
- 区块间距：`16` / `24`

反例：`6` / `10` / `14` 等非 4 倍数（历史遗留，新代码禁用）。

## §3 色彩

### 灰度层（建立结构）

- `--bg` `#0f0f0f` 页面底
- `--surface` `#1a1a1a` 卡片/面板
- `--surface-2` `#252525` 抬升表面
- `--border` `#2a2a2a` / `--border-2` `#333333` 细边框
- `--text` `#ececec` / `--text-2` `#c5c5c5` / `--text-3` `#9a9a9a` 三级文字

### 语义层（传达含义）

- `--primary` `#4d6bfe` 焦点/链接/运行中
- `--success` `#4ade80` / `--warning` `#fbbf24` / `--danger` `#f87171`

规则：**状态色只用于状态点、图标、徽章文字**，不做大面积填充。

## §4 字体

- 正文：系统无衬线（`--font-12` `12px` / `--font-13` `13px`）
- 元信息：`--font-11` `11px`（辅助下限，不得更小）
- 等宽：`--mono`；**数字/ID/时间戳/耗时/退出码** 一律等宽 + `tabular-nums`

## §5 圆角

- 徽章/标签：`--radius-full`（pill）
- 小控件：`--radius-6` `6px`
- 卡片：`--radius-8` `8px`
- 面板：`--radius-12` `12px`

## §6 阴影与聚焦

- 卡片：**无阴影**，仅边框
- 浮层：`--shadow-md`
- 聚焦：`outline: 2px solid var(--primary)` + `outline-offset: 2px`（不用 `box-shadow` 伪装）

## §7 动效

**事实 token**（`style.css` 定义，已被消费，禁止改值）：

- `--transition-fast: 0.12s ease` —— hover / focus / 边框色
- `--transition-base: 0.18s ease` —— 背景色 / 文字色 / 展开折叠

**新增动效取值档**（与 token 对齐）：

- 快速反馈：`120ms`（= fast）
- 标准过渡：`180ms`（= base）
- 慢速展开（面板尺寸）：`300ms`

规则：

- **优先用 token**（`var(--transition-fast)` / `var(--transition-base)`），禁止硬编码 `0.15s` 这类非档位值。
- 旋转指示器（spinner）用 `linear`，其余统一 `ease`。
- 例外：`animation` 时长（如 `1.4s` 脉冲）不属 `transition` 范畴，不强制归档。

**历史遗留**：全仓有 `0.08s`–`0.3s` 共 20+ 种过渡时长（`0.1s` / `0.14s` / `0.15s` 居多）。**不强制批量统一**——逐组件新改时改用 token，存量不动。

## §8 信息流降噪（对标成熟智能体）

- 长文本：默认预览（`clampTextPreview`），按需展开
- 原始输出：只留尾部（`tailTextPreview`），省略行数显式标注
- 脚本卡：默认折叠尾部，头部显示 desc + 状态徽章 + 时间
- 日志区：按轮次分组，完成轮次可折叠
- **执行日志输出区**：噪声行（进度条残留、重复分隔线、空行）在渲染前过滤

## §9 组件规则速查

- `ScriptCard`：头部 4px 网格；状态色点 6px；徽章 pill；why 用 `--text-3`
- `TaskProgressPanel`：进度条单色（禁渐变）；分组标签 uppercase `--font-11`
- `TerminalPane`：状态徽章（running/done/error）+ 执行摘要行
- `WorklogPane`：按轮次分组，事件图标灰度，仅错误用语义色
