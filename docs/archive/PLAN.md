Airunner 优化实施报告（完整版）
一、项目背景与现状
Airunner 是一个 Vite 插件形态的 AI 编程工作台，核心能力是「AI 生成脚本 → 沙盒执行 → 结果回传 → 循环推进」。当前已打通「工作台 → 油猴 → 网页 AI → 油猴提取 → 工作台执行 → 回传」完整链路。

现有基础：tsc 全绿、test:unit 121 用例通过、lint 通过、页面冒烟通过。已有 src/post-run/index.ts barrel，src/utils/index.ts barrel 待落地，src/routes/run.ts imports 处于半收敛态（28 → 17）。

现存问题分四个维度：

AI 上下文：RULES 928 行全量加载，噪音稀释核心约束

工作流状态：state.json 只有位置信息，缺环境、时间、链路、进度，多会话无隔离

可视化：信息按数据来源分散在多个面板，颜色语义不统一，窄屏不可用

可控性：决策粒度只有「全自动」和「退出码 2 暂停」，干预语义不清

关键数据：ScriptPanel.vue 1631 行、App.vue 1451 行、useAutoLoop.ts 1201 行、FileTree.vue 1190 行、GeneratePanel.vue 1144 行——均超 HCLC 硬线。

二、核心目标与原则
可度量目标
AI 每轮读取规则量从 928 行降到 200–300 行，且高度相关

状态能回答「当前在第几段、走到哪一步、下一步是什么」

用户能看到链路、能干预、能回放

环境类错误率显著下降

六条原则
原则一：减少 AI 需要操心的内容，而非让 AI 生成得更聪明。 翻过的车几乎全是环境错误，约束环境比提升理解力 ROI 更高。

原则二：先验证后设计，先最小可用再扩展。 每阶段先做 30% 版本跑一周，看数据再决定是否做到 100%。

原则三：单一真相源。 state.json 是唯一权威状态，前端只读。

原则四：局部失败不扩散。 一段失败不改上游状态，用户看到「卡在哪」。

原则五：增量有配额。 每阶段定义「要删什么」，不只有「要加什么」。

原则六：能机械化的不靠 AI 记。 检查器比提示词硬，工具比规则可靠。

三、立即执行的三件事（第 1 周内完成）
3.1 定义设计令牌
在 client/style.css 顶部定义统一 CSS 变量层：

颜色令牌

css
--color-success: #22c55e;
--color-warning: #eab308;
--color-error: #ef4444;
--color-running: #3b82f6;
--color-pending: #6b7280;
--color-text-1: #f8fafc; /_主文本 */
--color-text-2: #cbd5e1; /* 次文本 */
--color-text-3: #94a3b8; /* 弱文本 */
--color-bg-1: #0f172a; /* 主背景 */
--color-bg-2: #1e293b; /* 次背景 */
--color-bg-3: #334155; /* 卡片背景_/
--color-border: #334155;
间距令牌：--space-1(4px) 到 --space-8(48px)，8 的倍数。

字号令牌：--font-xs(11px) / --font-sm(12px) / --font-md(14px) / --font-lg(16px) / --font-xl(20px)。

圆角令牌：--radius-sm(4px) / --radius-md(8px) / --radius-lg(12px)。

统一色语义（所有面板一致）：绿=正常/完成/通过，黄=注意/待定，红=错误/失败，蓝=进行中，灰=未开始。

验收：grep 全项目，组件样式中无裸色值（#fff、rgb(...)）和裸间距值。

3.2 state 加版本号和 sessionId
state.json 顶层加：

json
{
"version": 42,
"sessionId": "sess-20260922-a1b2c3",
...
}
version：单调递增整数，每次写入 +1

sessionId：每次 runner 启动生成，标识本次会话

并发控制：写入前检查版本，不匹配则拒绝并重读。关键操作（暂停、终止、回滚）走「写前锁定」——先写 pending 意图，其他操作看到 pending 就等。

目录组织：runs/<sessionId>/<run-id>/round-N.json。

多会话隔离：主状态只有一个「当前活跃 session」，历史 session 归档到 runs/archive/<sessionId>/。

验收：两个并发任务互不覆盖；刷新页面状态不丢。

3.3 L2 明确清单
把 L2 从描述改为枚举，五类明确列入：

生产环境操作：部署、发布、上生产

数据库 DDL：建表、改表、删表、加索引

删除核心配置：.env / 密钥 / 锁文件 / CI 配置

外部服务写操作：调用第三方 API 做写操作

修改 git 历史：rebase / reset / force push

其余归 L0/L1，由 AI 按可逆性自判。清单可演进，但必须有明确当前版本。

验收：AI 遇这五类自动暂停；其余操作不再滥用 L2。

四、主线 0：AI 上下文优化
4.1 阶段 0：盘家底（第 1 周，纯查不改）
表 A ｜词表现状：loader 的 KEYWORDS/GROUPS 结构，每章节命中词，死词与冗余同义词。

表 B ｜失败记录：从历史时间线抽所有失败轮次，按错误模式归类。每条标注「环境类」还是「理解类」——这个分类决定后续投入分配。如果理解类占比超 30%，第二线优先级下调。

表 C ｜环境事实：可用命令白名单、项目根路径、工作目录约定、通道接口形态。

表 D ｜意图分布：历史任务的意图频次与共现关系。

表 E ｜现有能力盘点：列出「已经有的、能做到 60% 的、完全缺失的」三类。能改的不建，能复用的不重写。

验收：五份清单就位，后续所有映射和预置从这里出发。

4.2 第一线：意图声明 + 服务端按需加载（第 2–4 周）
阶段 1 ｜词表显式化
loader 增加「导出词表」能力，按章节分组。匹配逻辑不变，只把可匹配词暴露出来。

验收：一键输出「第八章 UI 踩坑 ← 命中词：vue / css / 样式…」清单。

阶段 2 ｜侦察轮固定输出意图清单（核心）
侦察轮 AI 产出从「随便看看」变成「固定结构的意图声明」：

json
{
"files": [
{ "path": "client/components/script/ScriptEditor.vue", "type": "vue",
"actions": ["改样式", "改逻辑"] }
],
"taskIntent": ["修 bug"],
"notes": "walk 函数参数类型错误"
}
约束：意图词只能从词表选；每词标理由；允许「无匹配词」。

关键：AI 只做「已知信息结构化报备」，服务端消费报备，AI 不负责决定加载什么。

阶段 3 ｜服务端映射（两层设计）
第一层：意图 → 章节组，粗粒度映射（约 20 条，人维护）。

意图 文件类型 加载章节
改样式 .vue UI 章节 + UnoCSS 语法 + Vue SFC 约定
改逻辑 .ts TS 架构 + R1–R3 协议
重构 任意 HCLC 章节 + 重构安全协议
修 bug 任意 踩坑库 + 输出结构规则
加测试 .ts 测试约定 + Characterization
第二层：章节内具体条目，细粒度匹配（由现有 loader 自动完成）。

人只维护 20 条粗映射，不维护几百条细映射。

每轮记录「加载了什么、因为哪些意图词」，事后可查。

阶段 4 ｜注入后续每轮上下文
把「基础规则 + 本任务 skill + 环境事实」合成上下文包。

token 预算上限：8000。超预算按优先级截断，标注「因预算限制未加载 X 章节」，AI 可主动请求。

阶段 5 ｜离线回放验证（分级判断）
从时间线自动抽 20–30 个有代表性的历史任务作为基准集。每个任务人工标注一次「应该加载的章节」。这个标注集作为长期回归测试。

分级判断：

命中率提升 > 20% 且成功率不降 → 全速推进第二线

命中率提升 5–20% → 保留第一线，先修映射表

命中率不提升 → 暂停第一线，回到阶段 0 检查

失败案例分析：新机制在某任务上表现更差，要看是「词表缺词」「映射错配」还是「AI 声明偏差」。

阶段 5.5 ｜灰度切换
按任务类型灰度：

第一周：只让「改样式」类任务走新机制（低风险、易验证）

第二周：扩展到「改逻辑」

第三周：全量

每次灰度保留旧机制开关，一键回退。旧机制对 AI 透明——AI 只看新机制，兜底由服务端自动切换。

4.3 第二线：生成环境预置（第 5–7 周）
阶段 6 ｜脚手架固定注入
先看 runner 现在怎么拼脚本——很可能已有部分注入逻辑。扩展比新建成本低。

每轮脚本头尾由 runner 拼接时补上，AI 不写：

bash

## !/usr/bin/env bash

## @desc: {AI 填}

## @why: {AI 填}

## @plan: {AI 填}

set -u
cd /Users/apple/vite-plugin-ai-runner
AI 写的脚本只含核心逻辑。

验收：CWD 迷路、输出截断类错误消失。

阶段 7 ｜环境事实注入
写脚本前喂给 AI：

可用命令白名单（ls, grep, wc, node, pnpm, ...）

项目根路径（写死）

上一轮关键事实（ScriptEditor.vue 当前 538 行）

本轮要改的文件 + 内容（若已侦察）

验收：探索性脚本显著减少；路径空跑明显减少。

阶段 8 ｜反馈结构化
执行后反馈改为结构化输出：

json
{
"exitCode": 0,
"complete": true,
"truncated": false,
"stderrClass": null,
"errorCategory": null
}
exit code、是否截断、stderr 分类

完整性标记：截断时明确标 [COMPLETE: false]，强制下轮补全

错误归因：常见错误直接标类别（CWD / 引号 / 语法 / 类型）

验收：静默漏洞消失，下轮输入可信。

阶段 9 ｜上轮关键事实传递
每轮结束抽取关键事实，注入下一轮：

变更文件列表

关键文件当前行数

新增的 import

变更的函数签名

AI 不靠记忆维持上下文。

4.4 第三线：闭环维护（全程并行）
阶段 10 ｜规则演进
记录四类缺口：

「AI 想声明但词表没有」的意图词 → 词表缺口

「加载了没用上」的章节 → 映射冗余

「从没被加载」的章节 → 候选删除

「翻过但规则没覆盖」的错误 → 规则缺口

聚类与优先级：同一类失败自动合并，按频次和影响排序。每周只看 Top 10。

硬上限：累积超过 50 条自动归档最旧的 30 条。

触发机制：每次失败自动生成待 review 记录，累积 N 条批量处理。

AI 反思轮（每 10 轮一次）
AI 用一轮专门做三件事：

回顾这几轮自己的失败，按环境/理解分类

提出对词表/映射/脚手架的改进建议

建议哪些规则可以删

输入：过去 10 轮的失败记录摘要、加载记录、决策记录。

输出：结构化建议列表，每条带「建议类型 / 具体内容 / 理由」。

建议进闭环由人审定。

4.5 RULES 分两步重组
第一步（第 1 周）｜结构重组
移出内容：

API 手册 → skills/AI-API.md

ScriptPanel 复盘 → skills/UI-LESSONS.md

已修复的坑（T2 chmod / T3 mtime / T5 timeout / T7 interceptor bug / T8 正则转义 / P5 git rm cached）→ skills/PITFALLS-ARCHIVE.md

Discriminated Unions 示例代码 → 删除

常用命令清单 → AGENTS.md

合并重复：三层反馈摘要与硬检查、跨轮累积与变更列表。

验收：RULES 从 928 行降到 600 行左右。

第二步（阶段 5 之后）｜拆五片
CORE.md（150 行，必读）：输出契约、AI 行为准则、R1–R3 原则、HCLC 核心

SCRIPT.md（写脚本时加载）：脚本头部模板、通道选择细节、输出符号规范

TS.md（改 TS 时加载）：HCLC 完整版、Discriminated Unions、satisfies、依赖分级

UI.md（改 UI 时加载）：UI 章节 1–7 节踩坑、Vue SFC 约定、UnoCSS 语法

PITFALLS.md（报错时加载）：完整踩坑库

RULES.md 变索引，指向这五片。AI 每轮读 CORE + 当前任务相关的一到两片。

每轮读的从 600 行降到 200–300 行。

RULES 加版本号
格式：version: 2026-09-22-a1b2c3（日期 + 短哈希）。

每轮时间线记录当时的 RULES 版本，回放时按当时版本渲染。

4.6 健壮性检查六条
行数解决「可读」，健壮性解决「不出错」。六条具体：

第一条｜外部输入：所有外部输入（HTTP 参数、文件内容、用户输入）先校验再使用。使用 Schema 在边界验证，禁止直接使用。

第二条｜空值处理：可能为空的值，使用前显式判断。禁止用 ! 强断言逃避空值检查。

第三条｜错误处理：所有可能抛异常的调用有 try/catch 或 Result 类型包裹。禁止裸调用。

Result 模式：

ts
type Success<T> = { kind: 'success'; value: T }
type Failure<E> = { kind: 'failure'; error: E }
type Result<T, E> = Success<T> | Failure<E>
第四条｜类型完备：公共 API 的输入输出类型显式声明，不用 any。使用 Readonly / ReadonlyArray 表达不可变数据。

第五条｜断言：关键假设用 assert 锁定，不靠注释说明。

第六条｜组件 Props/Emits：所有 Props 用 defineProps<Props>() 类型化，Emits 用 defineEmits<Events>() 类型化。Props 向下流，事件向上走，不直接修改 Prop。双向绑定用 defineModel()。

验收：这六条对应检查器落地，RULES 里只留索引。

4.7 行数阈值与拆分结构约定
阈值表
文件类型 软线（提示拆分） 硬线（拒绝写入） 依据
Vue SFC 总计 400 800 社区共识 200–500 行
Vue SFC script 300 500 ESLint max-lines 默认 300
Vue SFC template 200 400 vue/max-lines-per-block
Vue SFC style 200 400 同上
TS / JS 单文件 200 300 ESLint 默认 300
触发行
写文件前：检查当前文件行数。已超硬线，本次改动必须先拆分。

写文件后：超硬线拒绝写入；软线至硬线之间提示「建议拆分」；逼近软线提示「考虑边界」。

确实需要超线：必须在 @why 中说明理由。

Vue 拆分结构（Feature-Based）
text
src/features/<feature>/
├── components/
│ ├── <Feature>.vue # 父组件，保留编排职责
│ └── <SubComponent>.vue # 子组件
├── composables/
│ └── use<Feature>.ts # 共享逻辑
├── stores/ # Pinia store（按需）
├── api/ # 该 feature 的请求
└── types.ts # 类型定义
跨 feature 共享的 UI 和工具放 src/shared/。

TS 模块拆分
text
routes/run.ts → routes/run/
├── index.ts # 对外暴露边界
├── handler.ts # 主逻辑
├── helpers.ts # 辅助函数
└── types.ts # 类型定义
调用方只认 run/，不认内部文件。

五、主线 B：工作流状态与可视化
5.1 P1 ｜状态与链路基础（第 1–4 周）
先做 30% 版本：只加 pipeline 字段 + todo 加 status，两周内能跑。观察一周真实数据，再决定是否做到 70%。

70% 版本：加时间线落盘、会话字段、环境字段。

100% 版本：全字段补全 + 迁移脚本 + 前端 API。

state 字段补全（主状态，每轮写）
json
{
"version": 42,
"sessionId": "sess-20260922-a1b2c3",
"worktree": "/Users/apple/vite-plugin-ai-runner",
"branch": "master",
"cwd": "/Users/apple/vite-plugin-ai-runner",
"pid": 12345,
"round": 42,
"status": "running",
"mode": "auto",
"startedAt": "2026-09-22T10:00:00Z",
"updatedAt": "2026-09-22T10:05:00Z",
"finishedAt": null,
"goal": "ScriptEditor.vue any 收敛",
"doneCount": 5,
"totalCount": 8,
"currentTodoId": "t6",
"pipeline": {
"ASK_LOCAL": { "status": "ok", "durationMs": 12 },
"ASK_RELAY": { "status": "ok", "durationMs": 145 },
"ASK_INJECT": { "status": "ok", "durationMs": 320 },
"AI_GENERATE": { "status": "ok", "durationMs": 18200 },
"AI_COMPLETE": { "status": "ok", "durationMs": 1200 },
"EXTRACT": { "status": "ok", "durationMs": 85 },
"SCRIPT_VALIDATE": { "status": "ok", "durationMs": 45 },
"EXECUTE": { "status": "running", "startedAt": "..." },
"COLLECT": { "status": "pending" },
"RESULT_RELAY": { "status": "pending" },
"RESULT_INJECT": { "status": "pending" }
},
"stallCounter": 0,
"consecutiveFailures": 0,
"pendingInput": null,
"checkpoint": "abc123",
"checkpoints": [],
"rulesVersion": "2026-09-22-a1b2c3"
}
todo 结构化
json
{
"id": "t6",
"desc": "收敛 walk 函数类型",
"status": "doing",
"parentId": "t1",
"deps": ["t5"],
"children": [],
"verify": "pnpm tsc --noEmit",
"startedAt": "2026-09-22T10:04:00Z",
"finishedAt": null,
"result": null
}
status 取值：pending / doing / done / skipped / failed / blocked

时间线（冷数据，每轮追加）
runs/<sessionId>/<run-id>/round-N.json，包含：

本轮 todo 快照

脚本内容与 hash

每段链路的输入输出

stdout / stderr 路径

变更文件列表与 diff 引用

硬检查 / 软检查结果

决策及其结果

耗时

当时 RULES 版本

链路状态机（11 段 × 4 状态）
11 段：ASK_LOCAL / ASK_RELAY / ASK_INJECT / AI_GENERATE / AI_COMPLETE / EXTRACT / SCRIPT_VALIDATE / EXECUTE / COLLECT / RESULT_RELAY / RESULT_INJECT

4 状态：pending / running / ok / failed

每段带 startedAt / finishedAt / durationMs / error / retries。

主要改动文件：src/state/snapshot.ts、src/routes/run.ts、新增 src/state/pipeline.ts 和 src/state/timeline.ts。

验收：刷新状态不丢；state 能回答「当前在第几段」；每轮有完整快照；并发任务互不覆盖。

5.2 P2 ｜可视化与控制（第 5–8 周）
链路图（五段聚合，非 11 段直显）
用户视角五段——「提问 → AI 生成 → 提取脚本 → 执行 → 回传」。内部仍 11 段，前端聚合。点开某段看内部细分。

text
顶部：第 N 轮 · 当前第 X 段 · 耗时 Ys

[提问]─[生成]─[提取]─[执行]─[回传]
✓ ✓ ✓ ● ·
↑ 当前段（蓝色脉冲）

颜色：灰=待办 蓝=进行 绿=完成 红=失败 黄=需人工
卡片可点开看详情。失败段操作：重试 / 跳过 / 终止。历史轮次折叠在上方。

终端块降噪（四层结构）
text
第一层 状态行 ✅ 3 文件 · tsc ✓ · 8.3s
第二层 关键指标 tsc ✓ · lint ✓ · test 121/121
第三层 变更列表 ● ScriptEditor.vue +12/-3
第四层 原始输出 [折叠] 有输出 47 行
降噪规则：

全绿不占独立块，并进指标行

跨轮累积移出，放到页面顶部

三层反馈摘要取消，内容并入状态行与指标行

文件源码只在失败时附加，只附错误行 ±5 行

stdout 超 20 行只显示首尾各 5 行

连续多轮全通过折叠成一行

异常视图
只显示本轮所有异常，按严重程度排序，每条带「跳到相关位置」链接。默认隐藏，失败时自动打开。

决策开关（三档预设 + 七类精细配置）
三档预设（默认「协作模式」）：

信任模式：全部全自动

协作模式：默认全自动，但脚本生成和熔断判定需要确认

监工模式：默认我确认，只有格式化类全自动

七类精细配置（高级用户展开）：

决策类型 信任 协作 监工
技术选型 自动 自动 我确认
计划拆解 自动 自动 我确认
计划调整 自动 自动 我确认
脚本生成 自动 我确认 我确认
错误修复 自动 自动 我确认
分级判定 自动 我确认 我确认
熔断判定 自动 我确认 我确认
通道选择 自动 自动 我确认
三层控制：全局 + 按类型 + 单次覆盖。

决策流程：

text
AI 遇到决策点
│
├─ 查 decisionPolicy
│
├─[全自动]──► 静默执行，记 decisions
│
├─[半自动]──► 呈现 AI 建议 + 理由 + 备选
│ └─ 用户：确认 / 改写 / 交给 AI
│
└─[全手动]──► 暂停，不给建议
└─ 用户自己输入或选择
计划依赖树
默认显示依赖维度（有向图），父子维度折叠为默认分组。90% 的场景是「按什么顺序做」。

todo 项结构：

json
{
"id": "t6",
"desc": "...",
"status": "pending",
"parentId": "t1",
"deps": ["t5"],
"children": [],
"verify": "pnpm tsc --noEmit",
"result": null
}
父子 = 组成关系（子全完成 → 父自动完成）
依赖 = 顺序关系（B 完成前 A 不能开始）

执行顺序 = 拓扑排序 + 依赖满足：可执行 = 「所有依赖已完成 且 状态为 pending」。

删除语义：

情况 处理
叶子 + pending 直接移除
叶子 + doing / done 需确认
父节点 级联删除，先给影响评估
被依赖项 拒绝删除，要求先解除依赖
替代方案 标记 skipped，保留在树里
编辑操作：插入（指定父节点或「在 A 之后」）/ 删除 / 移动 / 拆分 / 合并 / 重排序。

所有编辑走 state 更新，记入 decisions。删除和合并需评估影响。

可视化：树形缩进视图 + 依赖图视图，可切换。

异常处理三层
第一层｜可重试（自动）：ASK*RELAY / ASK_INJECT / AI_COMPLETE / EXTRACT / RESULT*\*

段 超时 重试次数 间隔
ASK_RELAY 3s 2 1s / 3s
ASK_INJECT 5s 1 2s
AI_GENERATE 120s 0（会重复生成） -
AI_COMPLETE 30s 3 2s
EXTRACT 5s 2 1s
SCRIPT_VALIDATE 5s 0 -
EXECUTE js 60s / bash 120s 0（副作用不可重复） -
COLLECT 60s 1 3s
RESULT_RELAY 5s 2 1s
RESULT_INJECT 5s 1 2s
第二层｜需人工（暂停等决定）：脚本预检拦截 / exit 2 / 同 hash 连续两次。

策略：暂停 + pendingInput，三选项（跳过 / 终止 / 改后重试）。

第三层｜链路断裂（暂停等恢复）：桥断 / 页面关闭 / WS 断开。

策略：暂停 + 三条恢复路径（重连 / 手动打开 / 终止）。

干预语义明确化（写进 tooltip）
「跳过本段」= 本段标记 skipped，下游视为已满足

「终止」= 当前轮停止，state 保留，可从当前点恢复

「回滚到第 N 轮」= state 恢复到第 N 轮快照，后续轮次归档

「暂停」= 当前段跑完就停，可恢复

默认恢复模式「续跑」（跳过已完成），「重放」需显式选择

断线重连
断线期间请求排队，上限 10 条

重连后按序补发

超上限拒绝新请求，明确告诉用户「链路已断，请稍后重试」

不静默丢弃——用户会以为发出去了

5.3 P3 ｜思考流与回放（第 9–12 周）
思考流面板
右侧抽屉，默认收起。

分粒度：

粗粒度事件常显：「正在读 ScriptEditor.vue」「跑 tsc」

细粒度思考默认折叠：推理过程

关键节点高亮：

决策点：「发现锚点不匹配，暂停」

异常点：「tsc 失败，准备修」

请求点：「判断 L2，请求确认」

静音模式（默认）：只冒泡关键事件。切完整模式看全过程。

操作：暂停、打断、改指令。

油猴 DOM 监听六坑
选择器稳定性：按结构找（对话列表最后一个子元素），不写死 class

消息边界：AI 消息有稳定结构特征，区分用户消息和 AI 回复

完整拼接：维护「当前消息」状态，同一轮 mutation 累积到同一条记录

增量 vs 全量：记住上次发送的文本，只推新增部分

去抖：50–100ms 节流，合并这段时间的 mutation

重挂载：定期检查目标节点是否还在文档，不在就重新绑定

回放
读 runs/<sessionId>/<run-id>/round-N.json 时间线。

功能：

按轮次走时间线

看每轮：计划树 / 脚本 / 每段输入输出 / 变更 / 决策

支持跳转、快进、对比两轮

按当时 RULES 版本渲染

计划 vs 实际报告
内容：

按计划完成的 / 中途调整的 / 跳过的 / 新增的 / 超时的

加一维：哪些 AI 决定、哪些用户决定，结果对比

5.4 折叠状态与窄屏
折叠状态持久化
用户在任务里的展开状态存到 localStorage，key 为 <sessionId>:<file-path>。刷新后恢复。

窄屏适配（优先级布局）
宽屏（>1200px）：完整布局

中屏（768–1200px）：链路图横向滚动，侧边抽屉收起

窄屏（<768px）：默认只显示「状态行 + 关键指标」，详情通过抽屉展开；链路图从横向切为纵向

六、主线 C：通道与浏览器能力
6.1 C1 ｜油猴桥接加固（第 5–6 周）
链路已打通，只加固：

提取可靠性：提示词约束「只返回一个代码块」已定

DOM 变化容错：定期检查目标节点是否还在文档，不在就重新绑定

断线重连：见 5.2 节

消息去重与幂等：每条消息带唯一 id

6.2 C2 ｜无头浏览器通道（第 7–8 周）
基于已有 @playwright/test 与 src/headless/ 骨架。

第一批只做两个能力
cssom()：用 CDP 的 CSS.getMatchedStylesForNode 拿「哪条规则生效、来自哪个文件哪一行」，直接替代第八章的 DevTools 人肉排查。

screenshot()：元素级截图，支持 mask，用于「改完 UI 到底变没变」。

完整 API 清单（分三批）
读取类：eval / query / queryAll / text / attr / style / rect / cssom / html / value / storage / cookies

断言类：exists / visible / hidden / hasText / hasClass / hasStyle / count / noConsoleErrors

交互类：click / dblclick / hover / fill / type / press / scrollTo / scrollIntoView / focus / blur / drag / select / upload

导航类：goto / reload / back / forward / url / waitForSelector / waitForFunction / waitForLoadState

截图类：screenshot / screenshotDiff / saveScreenshot

网络与日志：consoleLogs / networkLog / errors / intercept / mock

会话管理：open / close / switchTo / listSessions

批次划分：

第一批（MVP）：eval / query / style / rect / cssom / screenshot / click / fill / press / waitForSelector / consoleLogs / errors

第二批：断言类 / 视觉对比 / 网络日志 / 会话管理

第三批：请求 mock / 多标签页 / 性能指标 / 并行会话

6.3 C3 ｜通道抽象（第 9–10 周）
**AI**.browser.\* 定义统一 API，js/bash/browser 三通道并列。油猴侧和无头侧暴露同一套接口。

6.4 C4 ｜截图对比（第 11–12 周）
两种模式
轮次内 before/after：改动前后各截一张，对比。回答「我刚才改了什么视觉变化」。这是 AI 自检的核心

跨轮次基线回归：维护稳定基线，每次改动后对比。回答「我有没有破坏已有的东西」

优先做模式一，不依赖预先定义基线，立刻可用。

三层阈值
像素级：pixelmatch 默认 0.1，允许单像素颜色轻微差异

区域级：变化面积占比 < 0.5% 视为「视觉等价」

结构级：变化区域是否集中在预期位置

动态内容处理
屏蔽（mask）：Playwright 的 screenshot 支持 mask 选项，传入 selector

冻结：注入脚本停掉动画、固定时间（Date.now 打桩）、等字体加载

等待稳定：等 document.getAnimations() 全部结束、等网络 idle、等连续两帧无变化

ScriptEditor 有光标闪烁，必须走冻结或 mask。

输出结构化
json
{
"diffPercent": 0.23,
"regions": [{ "x": 100, "y": 200, "w": 50, "h": 30, "change": 0.8 }],
"paths": {
"baseline": ".ai-runner/screenshots/xxx/baseline.png",
"current": ".ai-runner/screenshots/xxx/current.png",
"diff": ".ai-runner/screenshots/xxx/diff.png"
},
"status": "minor"
}
status：identical / minor / major。

关键约束
截图必须在真实磁盘状态上做（overlay flush 后），否则读到的是内存 overlay，对比结果不可信。

存储与生命周期
存到 .ai-runner/screenshots/<run-id>/，随 run 生命周期管理

基线存到 .ai-runner/baselines/，受 .gitignore 覆盖

轮次内截图保留最近 N 轮，基线保留到显式更新

diff 图只在有变化时保留，无变化时只留数字记录

七、主线 D：基础设施（全程并行）
D1 ｜测试补齐
核心路径（runner、pipeline、state）单元测试。

引入 Characterization Test 作为过渡：不追求正确性，只锁定当前行为。执行现有函数，记录输入输出，写成快照。这样就有「测试」了，可以开始重构。

现有测试文件 9 个：

text
client/test/error-fingerprint.node-test.ts
client/test/loopLogic.node-test.ts
client/test/sessionManager.node-test.ts
client/test/useAiTransport.node-test.ts
client/test/codeCleaner.node-test.ts
client/test/niumaBypass.node-test.ts
src/interceptor.test.cjs
src/process/proc.test.cjs
src/post-run/shebang.node-test.ts
验收：核心路径（runner、pipeline、state）有测试覆盖。

D2 ｜结构化日志
logs/runner.jsonl：每轮一段 JSON

logs/pipeline.jsonl：每段状态变更

logs/decisions.jsonl：决策记录

日志是回放、审计、失败画像的数据源。

D3 ｜安全加固
bash 白名单优先——只允许已知安全的命令，未知命令需确认

脚本执行沙盒加资源限制（内存、CPU、文件描述符）

敏感文件访问审计：读 .env、git 目录等记录日志

D4 ｜配置管理
统一到 .ai-runner/config.json：

json
{
"pipeline": {
"timeouts": { "ASK_RELAY": 3000, "AI_GENERATE": 120000, ... },
"retries": { "ASK_RELAY": 2, ... }
},
"decisionPolicy": {
"global": "collaborative",
"byType": { ... }
},
"thresholds": {
"vueSfc": { "soft": 400, "hard": 800 },
"tsJs": { "soft": 200, "hard": 300 }
},
"checkers": {
"any": true,
"imports": true,
"complexity": true
}
}
配置可覆盖、可继承、可版本化。

D5 ｜数据迁移
state schema 会变更多次。每次变更走迁移脚本：

旧字段保留，新字段追加

前端读新字段失败时降级读旧字段

提供 migrate 命令，一次性升级

D6 ｜回滚策略
所有改动走脚本，脚本带 --rollback

链路状态机上线后先跑「影子模式」——只记录不启用控制

可视化改动先上后端，前端切换时保留旧视图入口，一周后下线

D7 ｜性能监控
每段耗时基线。超过基线 2 倍自动标记「慢」。基线随运行积累自动更新。

D8 ｜文档
AGENTS.md 保持更新

PROJECT-NOTES.md 记录架构决策

新增 docs/ 目录存设计与流程文档

八、关键设计决策
hash 去重只针对修改类脚本。查询类、诊断类脚本不参与去重。脚本头部加类型标记，或由 runner 判断有无写操作。

stall 判定标准：进展 = 产生了新的、可验证的状态变更（文件行数变了、测试通过数变了、todo 完成项增加了）。其他都算 stall。

检查器与 RULES 的关系：RULES 里每条可机械化的规则，必须对应一个检查器；没有检查器的规则，RULES 里标注「软约束」。AI 能区分「硬约束」（会被拦截）和「软约束」（靠自觉）。

责任边界：声明是 AI 的，映射是服务端的，结果是共担的。AI 声明错误进词表缺口；服务端映射错误进映射表修正；两者都对齐但结果错了，说明规则本身有问题。

多会话隔离：state.json 按 sessionId 分片。主状态只有一个「当前活跃 session」，历史 session 归档。

旧机制对 AI 透明：AI 只看新机制，兜底由服务端自动切换。AI 不需要知道「现在走的是新机制还是旧机制」。

九、时间线与里程碑
第 1 周
三件立即执行的事完成（设计令牌、state 版本号、L2 清单）

阶段 0 五份表完成

RULES 结构重组完成

主线 D 的 D1/D2/D5 启动

第 4 周末
state 30% 版本（pipeline 字段）跑通

主线 0 阶段 1–4 完成，进入阶段 5 验证

核心路径有测试覆盖

结构化日志就位

RULES 从 928 行降到 600 行

第 8 周末
主线 0 第一线验收完成、第二线阶段 6–8 完成

用户能看到链路（五段聚合）、能干预

决策开关三档预设可用

计划依赖树可用（依赖优先）

无头浏览器 cssom + screenshot 可用

配置统一到 .ai-runner/config.json

第 12 周末
能回放任意一轮（按当时 RULES 版本）

思考流可用

通道抽象完成

截图对比集成

性能基线可用

AI 反思轮上线

第 12 周后
四条主线全部完成

扩展项按需启动

十、风险与对策
风险 对策
意图词表覆盖度不够 阶段 5 分级判断；不够则先修映射
服务端映射错误比不加载更糟 每轮记录加载依据，出错可反查
AI 声明意图漏报 「宁多勿漏」，服务端做交集判断
预置脚手架僵化 允许声明「本轮需自定义头部」覆盖
文件类型 ≠ 变更类型 AI 必须拿到文件内容，不只文件名
侦察不可信则全盘皆错 阶段 0 定「真实磁盘读取」为标准动作
state.json 膨胀 主状态只存当前，历史进时间线，超 100 轮归档
所有决策都要人确认 默认协作模式，手动需主动开启
自动重试掩盖真问题 连续 3 次升级为「需人工」
多会话冲突 P1 就加 sessionId 隔离
规则演进累积爆炸 加聚类、优先级、硬上限
重试掩盖真问题 每次重试记录，连续 3 次升级
依赖树拆得过细 默认粗粒度，用户主动收紧时才变细
油猴 DOM 变化导致提取失败 强化 EXTRACT 段校验与重试，失败升级为「需人工」
十一、砍掉的扩展项（放最后）
以下不属于核心，等四条主线稳定后再评估：

多智能体分工：探索者 / 修改者 / 验证者三类角色。依赖状态共享机制先行

skill 版本化与冲突检测：独立版本 + 依赖声明 + 冲突检测。依赖 skill 加载机制稳定

全量思考流默认展开：默认静音模式。等用户明确需要

终端块深度定制：自定义指标、折叠规则、配色。体验打磨，非核心

浏览器通道扩展：网络拦截、请求 mock、多标签页。等 cssom/screenshot 稳定

十二、判断标准
对每个优化点问一句：

它是在减少 AI 需要操心的内容，还是在让 AI 生成得更聪明？

前者收益确定、风险低；后者收益不确定。

十三、一句话总结
主线 0 让 AI 上场前结构化报备意图，服务端据此装配约束集——AI 仍自由写代码，但写在一个服务端保证正确的约束集上。

主线 B 让状态从黑盒变透明——每步可见、可干预、可回放。

主线 C 让 AI 从「只能改代码」升级到「能看结果」——cssom 定位样式来源、截图确认视觉变化。

主线 D 让前面三条跑得稳——测试、日志、安全、配置、迁移、回滚、性能、文档。

四条主线并行，各阶段独立交付。主线 0 阶段 5 是唯一的生死线：加载命中率不提升，第二线暂缓，先修映射。

贯穿全案的六条底线：设计令牌统一视觉、state 加版本号保一致性、L2 明确清单守安全闸门、健壮性六条保代码质量、行数阈值与拆分结构控复杂度、RULES 五片分层控上下文。

十四、交互式选择通道（待做）

问题：AI 需要用户做选择时，目前只有两条路——
一是脚本输出编号/关键字，用户在聊天框回一条消息（本质仍是输入）；
二是直接假设默认值继续跑，牺牲准确性。

为什么 bash / js 都做不到「脚本自己弹窗」：
脚本跑在 Node（runner 进程），弹窗跑在浏览器，是两个运行时。
脚本拿不到 window、transport、sendFill 等前端对象，
也无法「等待用户点击再继续」。stdout 是单向文本流，面板只当日志渲染。

可行方案（桥接，非直接调用）：

1. 脚本向 runner 发 ask 请求（HTTP 到 /\_\_ai/ask，或写约定文件）
2. runner 把请求广播给前端（复用现有事件流 / SSE）
3. 前端组件监听到 → 弹出选择框（按钮 / 单选项）
4. 用户点选 → 前端直接调发送函数（sendFill / copyAndFill）
5. 脚本侧 fire-and-forget，触发即退出，不等待结果

关键取舍：

- 脚本不等结果（推荐）：链路最短，用户选完前端直接发送，AI 下一轮自然接上。
- 脚本要等结果：需加回传协议（sleep + 轮询结果文件 / 长连接），复杂度陡增，收益低。

现状缺口：

- 前端没有 ask 请求监听组件
- runner 没有 /\_\_ai/ask 端点
- 没有约定的事件类型

结论：方向可行，分工干净（前端弹窗 + 前端发送）。
缺的是中间那条短通道，不是能力问题。
最小实现 = 脚本 POST → runner 广播 → 前端弹窗 → 用户点 → 前端发，脚本不等。
属于独立开发任务，与现有循环机制无冲突，可并行推进。
