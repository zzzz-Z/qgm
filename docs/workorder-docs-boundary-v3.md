# 工单 · 文档边界重构 v3（SYSTEM.md / AGENTS.md 职责再划分）

> **性质**：本次会话的边界重构计划 + 进度。落盘为工作区级事实（不是应用级规则）。
> **目标**：把本工作区两份常驻注入文档（`packages/core/SYSTEM.md` 应用级 / `AGENTS.md` 工作区级）的职责边界做一次完整对齐——删除 2026-10-14 §4 迁移的同病理遗留，集中收敛重复的反伪造规则，把端点注册表外置。

## §0 边界准则（四问）

新增任何内容前先回答四问，按序裁决：

一、换一个工作区这条内容还成立吗？不成立 → AGENTS.md / docs/。
二、它是行为指令还是事实陈述？事实（路径/端口/命令/文件名）→ AGENTS.md。
三、AI 每轮都需要还是触达场景才需要？每轮 → SYSTEM.md 正文；触达才需要 → 附录或手册层。
四、是稳定结论还是带证据的踩坑实例？实例 → .ai-runner/lessons.md。

最强检验：任何只有打开本仓库才成立的内容，都不属于系统提示词——哪怕它看起来像规则。

## §1 七步执行计划（按消依赖违例 → 消重复 → 体验优化排序）

步骤一（P0）· 补 DOCS-INDEX 收录缺口

- 磁盘有 md 但索引未收录：`docs/架构.md` + 8 个技能/指南文件（pm-agent-usage-guide / qa-agent-usage-guide / skills/**）。
- 处置：全部登记进 `docs/DOCS-INDEX.md`，`pnpm docs:verify` 双向守。
- 状态：**已完成（2026-10-15）**。

步骤二（P0）· 归档 docs/plan 已实施工单

- `docs/plan/plan-multi-workspace-2026-10-11.md` 是草稿区坟场（功能已上线，且被 `workspace-scope.ts` 注释引用为设计依据）。
- 处置：就地加「已实施（2026-10-15 复核）」封条，保留为设计依据；不移动（移动会失引用）。
- 状态：**已完成（2026-10-15）**。

步骤三（P0）· 端点注册表外置

- `AGENTS.md`「本项目独有约束」内 14 个 `/__ai/*` 端点契约，本质是 API reference 而非约束。
- 处置：整段迁出到 `docs/routes-registry.md`；AGENTS.md 只留登记义务 + 通用语义 + 链接。
- 状态：**待执行**。

步骤四（P0）· SYSTEM.md §14/§15/§16 剥离项目命令引用块

- 三节开头的引用块含本仓命令与路径（`pnpm check-regression` / `pnpm verify` / `pnpm test:e2e` / `.ai-runner/baseline.json` / `visual.spec.ts-snapshots/` / `.ai-runner/lessons.md`），违反 §0 边界准则问一+问二。
- 处置：删引用块（AGENTS.md 已完整收录），三节只保留通用方法论。
- 状态：**待执行**。

步骤五（P0）· SYSTEM.md §0.1 去实现路径与日期戳

- 机制表每条含具体源码文件路径（`useAiReplyHandlers.ts` / `post-run/overlay.ts` / `headless/discover-targets.ts` 等）与复核日期（2026-10-06）。实现路径属工作区级事实。
- 处置：SYSTEM.md 侧保留机制语义 + 未运行时等效行为；文件路径迁入 AGENTS.md 新建「宿主机制实现索引」。
- 状态：**待执行**。

步骤六（P1）· AGENTS.md 独有约束按五域重组

- 当前 15+ 项无分类、粒度悬殊（端点表 ~2000 字 vs 单行规则）。
- 处置：按「构建与工具链 / 文档与规范 / 端点与集成 / 运维与运行时 / 输出与预算」五域重排，每条保持「一行规则 + 详情链接」的统一粒度。
- 状态：**待执行**。

步骤七（P2）· SYSTEM.md 新增快速索引 + 附录

- 快速索引：「我要做 X → 看 §Y」映射表（成本约 10 行，新会话冷启动效率提升）。
- 附录 A：契约名注册表（集中索引 ~30 个 `-vN` 契约名 + 一句话定义 + 详见章节）。
- 附录 B：常见拒收场景速查表（从 §1/§8/§10 提取，如 MISSING_DESC / 截断 / SHELL_METACHAR_UNSUPPORTED / UNSUPPORTED_LANG 等）。
- 状态：**待执行**。

## §2 本次不做（避免纯 churn）

- 不移动 `scripts/tampermonkey-session-id.user.js`（多处守卫锚定其路径，移动收益为零、断链风险大）。
- 不重组 `packages/core/src/routes/`（30 文件）与 `post-run/`（26 文件）——内聚良好，HCLC 明确反对为分而分。
- 不重排 `packages/client/tests/` 的 80 个平铺测试文件——命名已自描述。

## §3 处置原则

- 每步独立提交、独立验证（`pnpm docs:verify` 守链接、`pnpm session:start` 守锚点）。
- 锚点若被改段落触及，须同步更新 `scripts/anchors.json`（`anchors:verify` 是独立闸门，vitest 不覆盖）。
- 结尾必跑 `pnpm session:start` + `pnpm docs:verify` 双闸门。
