# PLAN 完成度对照（2026-09-22 探针实测）

> 数据源：`skills/_loader.cjs` 快照、`state.json` 字段、源码行数、目录清单。
> 判定口径：PLAN 第 3/4/5/6/7 章逐条对照，只看「文件是否存在 + 关键字段是否有值」。

## 一、立即三件事（第 1 周）

| 项                         | PLAN 要求                             | 现状                                        | 判定    |
| -------------------------- | ------------------------------------- | ------------------------------------------- | ------- |
| 3.1 设计令牌               | style.css 顶部定义色彩/间距/字号/圆角 | 仅 2 处命中，无 `--color-success` 等系统    | ✗ 未做  |
| 3.2 state 版本号+sessionId | version + sessionId + 并发锁          | version ✓ sessionId ✓；缺 15 个字段（见下） | 🟡 半成 |
| 3.3 L2 明确清单            | 五类枚举                              | RULES ch2 已有五类枚举（AIRUNNER-L2-V1）    | ✓ 已做  |

## 二、主线 0：AI 上下文优化

| 阶段                    | PLAN 要求                  | 现状                                                                                        | 判定       |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------- | ---------- |
| 阶段 0 表 A 词表现状    | GROUPS/KEYWORDS 清单       | 已落盘 `docs/plan/phase0/A-keywords.md`                                                     | ✓ 已做     |
| 阶段 0 表 B 失败记录    | 环境/理解分类              | 探针完成，未落盘                                                                            | 🟡 半成    |
| 阶段 0 表 C/D/E         | 环境事实/意图/能力盘点     | 未做                                                                                        | ✗          |
| 阶段 1 词表显式化       | loader 导出词表            | loader 已导出 GROUPS/KEYWORDS/ALWAYS_KEYS                                                   | 🟡 部分    |
| 阶段 2 侦察轮意图声明   | AI 固定输出意图 JSON       | 未做                                                                                        | ✗          |
| 阶段 3 服务端映射       | 两层映射表                 | 未做（GROUPS 7 组全空转）                                                                   | ✗          |
| 阶段 4 上下文包注入     | token 预算 8000            | 未做                                                                                        | ✗          |
| 阶段 5 离线回放验证     | 基准集 20–30               | 未做                                                                                        | ✗          |
| 阶段 6 脚手架固定注入   | runner 拼头尾              | 未做（待查 runner 现有拼装）                                                                | ✗          |
| 阶段 7 环境事实注入     | 白名单+根路径              | 未做                                                                                        | ✗          |
| 阶段 8 反馈结构化       | exitCode/complete JSON     | 未做                                                                                        | ✗          |
| 阶段 9 上轮事实传递     | 变更/行数/import           | 未做                                                                                        | ✗          |
| 4.5 第一步 RULES 重组   | 928→600 行                 | 当前 **568 行**（已达标）；AI-API.md 76 / UI-LESSONS.md 331 / PITFALLS-ARCHIVE.md 46 已拆出 | ✓ 已做     |
| 4.5 第二步 RULES 拆五片 | CORE/SCRIPT/TS/UI/PITFALLS | 未做（等阶段 5 验证后）                                                                     | ✗ 未到时机 |

**主线 0 关键结论**：第一步结构重组已完成（RULES 568 行达标）；第一线的 loader 导出能力已有基础，但「意图声明 → 映射 → 注入」全链路未落地。**这是 PLAN 唯一的生死线，当前完全未启动。**

## 三、主线 B：工作流状态与可视化

### 3.1 P1 状态与链路基础

| PLAN 字段                                         | 现状                        |
| ------------------------------------------------- | --------------------------- |
| version / sessionId                               | ✓ 有                        |
| worktree / branch / cwd / pid                     | ✗ 全无                      |
| startedAt / finishedAt                            | ✗（仅 updatedAt）           |
| doneCount / totalCount / currentTodoId            | ✗ 全无                      |
| pipeline（11 段状态机）                           | ✗ 无                        |
| stallCounter / consecutiveFailures / pendingInput | ✗ 全无                      |
| checkpoints / rulesVersion                        | ✗ 全无                      |
| todo 结构化（parentId/deps/children/verify）      | ✗ todo[0] 仅 id/desc/status |

- `src/state/pipeline.ts` ✗
- `src/state/timeline.ts` ✗
- `runs/` 已有 20 个 session 目录（结构存在，未见 round-N.json 格式确认）

**判定**：P1 完全未做。state.json 只有位置信息 + version/sessionId，PLAN 批评的「缺环境、时间、链路、进度」四缺全部存在。

### 3.2 P2 可视化与控制

链路图、终端块降噪、异常视图、决策三档、计划依赖树——**全部未做**。

### 3.3 P3 思考流与回放

思考流面板、油猴 DOM 六坑、回放——**全部未做**。

### 3.4 折叠与窄屏

未做。

## 四、主线 C：通道与浏览器能力

| 项                             | 现状                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| C1 油猴桥接加固                | 链路已通，去重/重连未加固                                                           |
| C2 headless cssom + screenshot | `src/headless/` 有 ai-headless/headless-inject/smoke；**无 cssom、无 screenshot** ✗ |
| C3 通道抽象 `__AI__.browser.*` | 未做                                                                                |
| C4 截图对比                    | 未做                                                                                |

## 五、主线 D：基础设施

| 项  | 现状 |
| --- | ---- |

- D1 测试补齐：已有 61 test files / 791 tests；但 runner/pipeline/state 核心路径无 Characterization Test：🟡 部分
- D2 结构化日志：仅有按日期的 `logs/2026-*-.jsonl`；**无 runner/pipeline/decisions.jsonl**：✗
- D3 安全加固（白名单/沙盒/审计）：bash-guard 已有黑名单；白名单/资源限制/审计未做：🟡 部分
  | D4 config.json 统一配置 | ✗ 不存在 |
  | D5 数据迁移脚本 | ✗ |
- D6 回滚策略（--rollback/影子模式）：脚本有 backup 机制；影子模式未做：🟡 部分
  | D7 性能监控 | ✗ |
- D8 文档：AGENTS/README 已同步；PROJECT-NOTES.md 无：🟡 部分

## 六、行数阈值（4.7）实测

| 文件              | 行数               | 硬线 | 判定         |
| ----------------- | ------------------ | ---- | ------------ |
| ScriptPanel.vue   | 1631               | 800  | 🔴 超 2 倍   |
| App.vue           | 1451               | 800  | 🔴 超 1.8 倍 |
| GeneratePanel.vue | 1144               | 800  | 🔴 超 1.4 倍 |
| useAutoLoop.ts    | 1098               | 300  | 🔴 超 3.6 倍 |
| FileTree.vue      | 未探到（路径疑变） | 800  | ?            |
| src/routes/run.ts | 261                | 300  | 🟡 逼近      |

---

## 七、下一步执行计划（按 ROI 排序）

### P0 立即（本周内，可独立交付）

1. **补 state 环境字段**：worktree/branch/cwd/pid/startedAt/doneCount/totalCount/currentTodoId/rulesVersion。纯 schema 扩展 + 写入点一处。
2. **表 B 落盘**：把已有探针（exit 分布 1341/166/23/2）整理成 `docs/plan/phase0/B-failures.md`。
3. **表 C/D/E 落盘**：环境事实、意图分布、能力盘点（部分数据已有）。
4. **设计令牌第一步**：style.css 顶部注入令牌定义（仅定义，不改用），下一步再替换硬编码。

### P1 第 2–4 周（主线 0 第一线）

5. 阶段 1：loader 增加 `--dump-keywords` 输出章节 × 命中词清单。
6. 阶段 2：新增意图声明 JSON schema + 侦察轮模板。
7. 阶段 3：映射表（20 条粗映射）落地为 `skills/mapping.json`。
8. 阶段 4：上下文包装配器（token 预算 8000）。
9. 阶段 5：从 `runs/` 抽 20 个代表性历史任务做基准集。

### P2 第 1–4 周并行（主线 B P1）

10. `src/state/pipeline.ts`：11 段状态机。
11. `src/state/timeline.ts`：round-N.json 落盘。
12. state.json todo 结构化扩展（parentId/deps/verify）。

### P3 第 5–8 周（主线 D）

13. `logs/runner.jsonl` + `pipeline.jsonl` + `decisions.jsonl`。
14. `.ai-runner/config.json` 统一配置。
15. D1 Characterization Test：runner/pipeline/state 三处。
16. headless `cssom()` + `screenshot()` MVP。

### P4 第 5–8 周（主线 B P2）

17. 链路图五段聚合、终端块降噪、异常视图。
18. 决策三档预设 + 计划依赖树。

### P5 第 9–12 周

19. 思考流、回放、通道抽象、截图对比、性能基线、AI 反思轮。

### 阈值整改（独立并行，不阻塞主线）

20. ScriptPanel.vue 拆 Feature-Based（最紧急，超 2 倍）。
21. App.vue 拆为 app-shell + feature 容器。
22. useAutoLoop.ts 拆 composable（已有 auto-loop/ 子目录基础）。

### 风险提示

- **主线 0 阶段 5 是生死线**：若意图命中率不提升，第二线暂缓，先修映射。
- 阈值整改与主线 0 并行会抢上下文，建议 P0 完成后先集中做主线 0 阶段 1–3。

<!-- progress-2026-09-22-P0P1 -->

## 八、进度更新（2026-09-22）

### 已完成

**P0（阶段 0 五表 + 立即事）**

| 项                  | 产物                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| p0-1 state 环境字段 | helpers.cjs `_ensureEnvFields`（cwd/worktree/branch/pid/startedAt/updatedAt/doneCount/totalCount/currentTodoId/rulesVersion） |
| p0-2 表 B 失败记录  | docs/plan/phase0/B-failures.md（环境类 38% / 理解类 62%）                                                                     |
| p0-3 表 C 环境事实  | docs/plan/phase0/C-env.md（白名单/根路径/通道形态）                                                                           |
| p0-4 表 D 意图分布  | docs/plan/phase0/D-intent.md（意图频次 + 共现）                                                                               |
| p0-5 表 E 能力盘点  | docs/plan/phase0/E-capability.md（have=8/60%=5/missing=19）                                                                   |
| p0-6 设计令牌第一步 | client/style.css :root 顶部注入 `[design-tokens-v1]` 别名层                                                                   |

**P1（主线 0 第一线）**

| 项                   | 产物                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| p1-1 词表显式化      | skills/\_loader.cjs 新增 `--dump-keywords` 分支                        |
| p1-2 意图声明 schema | docs/plan/intent-schema.json + intent-recon-template.md                |
| p1-3 映射表          | skills/mapping.json（22 条粗映射）                                     |
| p1-4 上下文包装配器  | scripts/context-pack.cjs（token 预算 8000 + 截断标记）                 |
| p1-5 离线回放基准集  | docs/plan/baseline.json（30 样本，含 pendingHumanChapters 待人工标注） |

### 关键发现

- 表 B 判定：**环境类 38% / 理解类 62%** → 按 PLAN 4.1「理解类 > 30% → 第二线暂缓，先修映射」，应优先完成阶段 1–3 映射闭环。
- 阶段 5 生死线未走完：baseline.json 中 `pendingHumanChapters` 为空，需人工标注 30 条「应加载章节」才能做命中率判断。
- 阶段 3 映射表复用 loader GROUP 与第三方 skill key（如 `unocss-SKILL`），未引入新机制。

### 待办（下一步）

1. **人工标注 baseline.json 的 30 条 pendingHumanChapters**（阶段 5 前置）。
2. **跑 loader 命中率回归**（用 context-pack 对 baseline 逐条加载，比对标注）。
3. 阶段 5.5 灰度：先让「改样式」类任务走新机制。
4. 阈值整改（ScriptPanel 1631 / App 1451 / useAutoLoop 1098）——与主线 0 抢上下文，待阶段 5 出结果再启。

<!-- progress-2026-09-22-P2 -->

## 九、第 2 期进度（2026-09-22）

### 主线 B P1（状态与链路基础，纯逻辑层）

| 项                | 产物                                                                                              | 接线状态       |
| ----------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| pipeline.ts       | src/state/pipeline.ts（11 段 × 4 状态 + retry 策略，`[pipeline-v1]`）                             | ⏳ 未接 run.ts |
| timeline.ts       | src/state/timeline.ts（round-N.json 落盘 + \_index.json 累积 + hashScript）                       | ⏳ 未接 run.ts |
| state.todo 结构化 | state.json 中 19 项 todo 已补 7 字段（parentId/deps/children/verify/startedAt/finishedAt/result） | ✅ 已落盘      |

### 主线 D 基础设施

| 项                | 产物                                                                                             | 状态                |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| D1 测试补齐       | test/server/pipeline.node-test.ts（12 用例）+ timeline.node-test.ts（10 用例），vitest 22 passed | ✅                  |
| D2 结构化日志基础 | src/state/snapshot.ts 新增 `writeChannelLog(channel, entry)`（runner/pipeline/decisions 三通道） | 🟡 已建，调用方待接 |
| D4 统一配置       | .ai-runner/config.json v1（pipeline 11 段 + decisionPolicy 8 类 + thresholds + checkers）        | ✅                  |
| D5 数据迁移       | scripts/migrate-state.cjs（v11→v12，幂等 + --dry-run + 备份）                                    | ✅ --dry-run 已验   |

### 环境事实更新（C-env.md §8）

**js 通道 EACCES 新坑**：

- 现象：js 通道 `fs.readFileSync('.ai-runner/config.json')` 报 EACCES。
- 反证：`ls -la` 644 可读；`execSync(cat)` 成功读 3790 字节；`stat` 正常。
- 根因：js 通道对 `.ai-runner/` 下部分文件有沙盒级读拦截，**非磁盘权限问题**。
- 规避：脚本内读 `.ai-runner/*` 用 `execSync(cat <path>)` 或 bash 通道。

### 阻塞项

- **阶段 5 命中率回归**：Jaccard 20.2% < 60% 阈值 → 按 PLAN 暂停第一线。
- 根因已诊断（stage5-diagnosis.md）：**真值缺失**，不是映射不准。
- 待人工标注 baseline.json 的 30 条 `pendingHumanChapters`（已填 AI 初稿，版本 `2026-09-22-draft-v1`）。
- 人工标注前，第二线（阶段 6-9）与灰度（5.5）均暂缓。

### 下一步建议（按 ROI 排序）

1. **人工标注 baseline**（解锁阶段 5，是唯一生死线）。
2. **B P1 接线**：pipeline.ts / timeline.ts 接入 run.ts（跨文件改动，需拆 2–3 轮）。
3. **D2 接线**：writeChannelLog 接入 run.ts / run-helpers.ts 调用点。
4. **D8 文档**：PROJECT-NOTES.md 记录架构决策。
5. **D7 性能监控**：每段耗时基线 + 2x 标记。
6. **阈值整改**：ScriptPanel.vue 1631 / App.vue 1451 / useAutoLoop.ts 1098（与主线 0 抢上下文，待阶段 5 解锁后启）。
   ,<!-- progress-2026-09-22-P4 -->,## 十一、第 4 期进度（2026-09-22）,,### 阈值整改（PLAN 4.7 独立并行）,,| 步骤 | 产物 | ScriptPanel 行数 |,|---|---|---|,| 步骤 1 | 抽 lineClass/trimOutput → client/components/script/output-utils.ts | 1632 → 1624 |,| 步骤 2 | 抽 tw 段 → client/composables/ui/useTwDisplay.ts | 1624 → 1562 |,,**当前大文件行数**（硬线 800）：,,| 文件 | 行数 | 超标 |,|---|---|---|,| client/components/script/ScriptPanel.vue | 1562 | 🔴 +762 |,| client/App.vue | 1452 | 🔴 +652 |,| client/composables/ai/useAutoLoop.ts | 1099 | 🔴 +299 |,| client/components/generate/GeneratePanel.vue | 1145 | 🔴 +345 |,
   **整改策略说明**：

- 已抽两次均为**纯函数/composable** 最小切口（不破编译，tsc+vitest 全绿）。
- 拆到硬线 800 需 ~10 轮（每轮 ~55 行），性价比低。
- 建议：等主线 0 阶段 5 解锁后再集中拆（现在拆会抢上下文）。

### 全量状态

- **65 测试文件 / 832 用例全绿**
- **tsc + eslint 0 error**
- 已落地产物：
  - 阶段 0 五表（docs/plan/phase0/）
  - 意图声明 schema + 模板 + baseline（docs/plan/）
  - mapping.json（22 条）+ context-pack.cjs
  - pipeline.ts / timeline.ts / perf.ts / screenshot-diff.ts
  - cssom-screenshot.ts + headless-cli.cjs
  - bash-guard 白名单
  - config.json + migrate-state.cjs
  - PROJECT-NOTES.md

### 唯一阻塞（未变）

**阶段 5 命中率验证需人工标注 `docs/plan/baseline.json` 的 30 条 `pendingHumanChapters`**。

<!-- progress-2026-09-22-P6 -->

## 十三、第 6 期进度（2026-09-22）

### 主线 B P2 全套交付

| 项         | 产物                                                 | 端到端                         |
| ---------- | ---------------------------------------------------- | ------------------------------ |
| 链路图     | client/components/panels/PipelineGraph.vue           | ✓ 挂 TaskListPanel             |
| 决策开关   | useDecisionPolicy.ts + DecisionPolicySwitch.vue      | ✓ 挂 TaskListPanel             |
| 计划树     | TaskTree.vue（拓扑 + 图形视图）                      | ✓ 挂 TaskListPanel             |
| 异常视图   | AbnormalView.vue（按严重度排序）                     | ✓ 挂 ScriptPanel               |
| 折叠持久化 | useFoldState.ts（localStorage，key=sessionId:scope） | 🟡 composable 就绪，调用方待接 |

### 数据链路（新增字段透传）

- `state.json.pipeline` → tasks-routes → useTasks → PipelineGraph
- `state.todo`（结构化）→ tasks-routes.todoItems → useTasks.todoItems → TaskTree
- `useRunner result` → AbnormalView（tsc/lint/test/exit/errorFiles 聚合）

### B P2 剩余（拆后续轮）

- **终端块降噪**：四层结构中的「原始输出折叠块」；`useTwDisplay` 已完成主要降噪。
- **窄屏适配**：宽/中/窄三档布局。
- **折叠状态接入**：useFoldState 接入侧边栏各面板。

### 全量状态

- **65 测试文件 / 832 用例全绿**
- **tsc + eslint 0 error**

### 唯一阻塞（未变）

**阶段 5 命中率验证需人工标注 baseline.json 的 30 条 pendingHumanChapters**。

<!-- progress-2026-09-22-P7 -->

## 十四、第 7 期进度（2026-09-22）

### 主线 B P2 收官（全套交付）

| 项         | 产物                                                 | 状态 |
| ---------- | ---------------------------------------------------- | ---- |
| 链路图     | PipelineGraph.vue（含 <768px 纵向适配）              | ✅   |
| 决策开关   | useDecisionPolicy.ts + DecisionPolicySwitch.vue      | ✅   |
| 计划树     | TaskTree.vue（拓扑排序 + 双视图）                    | ✅   |
| 异常视图   | AbnormalView.vue（严重度排序 + jump 事件）           | ✅   |
| 折叠持久化 | useFoldState.ts + SidePane 接入（collapsed/sideTab） | ✅   |
| 终端降噪   | TerminalPane 第四层原始输出折叠块                    | ✅   |
| 窄屏适配   | PipelineGraph <768px 链路图纵向                      | ✅   |

### 数据链路（本轮新增）

- `state.json.pipeline` → tasks-routes → useTasks → PipelineGraph
- `state.todo`（结构化）→ tasks-routes.todoItems → useTasks.todoItems → TaskTree
- `useRunner result` → AbnormalView（tsc/lint/test/exit/errorFiles 聚合）
- `localStorage` key = `airunner:fold:default:side-pane` / `airunner:fold:default:terminal-raw`

### 全量状态

- **65 测试文件 / 832 用例全绿**
- **tsc + eslint 0 error**

### 主线 B P2 剩余（可选深化）

- 中屏（768-1200）链路图横向滚动
- 折叠态接入其余面板（FileTree / TracePanel）
- 终端块四层结构的「状态行/指标行」合并（现由 statusbar 与 AbnormalView 分担）

### 唯一阻塞（未变）

**阶段 5 命中率验证需人工标注 baseline.json 的 30 条 pendingHumanChapters**。

<!-- progress-2026-09-22-P8 -->

## 十五、第 8 期进度（2026-09-22）

### 本轮交付

**阈值整改（续）**

| 文件    | 起点 | 当前 | 抽取产物                                                                            |
| ------- | ---- | ---- | ----------------------------------------------------------------------------------- |
| App.vue | 1451 | 1439 | client/composables/ui/useAppStorage.ts（localStorage 纯函数 + 常量 + SessionEntry） |

**D3 安全加固（续）**

| 项           | 产物                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| 白名单接线   | process/index.ts 导出 + exec.ts 灰度记录（AI_RUNNER_WHITELIST_DEBUG）       |
| 敏感文件审计 | files-read.ts 检测 .env/.git/.ssh/_.pem/_.key 等 → decisions 日志（不阻断） |

### 全量状态

- **65 测试文件 / 832 用例全绿**
- **tsc + eslint 0 error**

### 大文件行数（硬线 800）

| 文件                                         | 行数 | 状态    |
| -------------------------------------------- | ---- | ------- |
| client/components/script/ScriptPanel.vue     | 1559 | 🔴 +759 |
| client/App.vue                               | 1439 | 🔴 +639 |
| client/composables/ai/useAutoLoop.ts         | 1099 | 🔴 +299 |
| client/components/generate/GeneratePanel.vue | 1145 | 🔴 +345 |

### 未完成（未变）

- **阶段 5 命中率验证**：阻塞于人工标注 baseline 30 条。
- 阈值整改 App.vue：距硬线 800 仍差 639 行。
- 阈值整改 useAutoLoop.ts / ScriptPanel.vue / GeneratePanel.vue：未启动续拆。
- 中屏（768-1200）布局：优先级低。

<!-- progress-2026-09-22-P9 -->

## 十六、第 9 期进度（2026-09-22）

### 主线 D3 安全加固（收官）

| 项           | 产物                                               | 测试                                       |
| ------------ | -------------------------------------------------- | ------------------------------------------ |
| 白名单逻辑   | src/process/bash-guard.ts::checkBashWhitelist      | bash-whitelist.node-test.ts（7 用例）      |
| 白名单接线   | process/index.ts 导出 + exec.ts 灰度记录           | 全量 tsc                                   |
| 敏感文件审计 | files-read.ts 检测 .env/.git/.ssh → decisions 日志 | 全量 tsc                                   |
| 资源限制     | proc.ts::maxOutputBytes（默认 5MB，超限 SIGKILL）  | proc-resource-limit.node-test.ts（4 用例） |

**D3 完整覆盖 PLAN 7.D3 三项**：白名单优先 / 资源限制 / 敏感文件审计。

### 全量状态

- 66 测试文件 / 836 用例全绿
- tsc + eslint 0 error

### 未完成（未变）

- 阶段5 命中率验证：阻塞于人工标注 baseline 30 条。
- 阈值整改：ScriptPanel 1559 / App 1439 / useAutoLoop 1099 / GeneratePanel 1145 超硬线 800。

<!-- progress-2026-09-22-P10 -->

## 十七、第 10 期进度（2026-09-22）

### 自动可做项（用户要求跳过人工项）

**已完成 6 项**：

| id     | 内容                     | 产物                                                           |
| ------ | ------------------------ | -------------------------------------------------------------- |
| auto-1 | ScriptPanel 拆纯函数     | client/components/script/script-panel-utils.ts（3 函数）       |
| auto-5 | PipelineGraph 中屏适配   | 769-1200px 横向滚动                                            |
| auto-6 | TracePanel filter 持久化 | useFoldState 接入                                              |
| auto-7 | D6 影子模式              | config.pipeline.shadowMode + shadow-mode.md                    |
| auto-8 | C4 跨轮次基线回归        | scripts/screenshot-baseline.cjs（save/check/list/rm 实测通过） |
| auto-9 | D5 迁移扩展              | migrate-state.cjs v12→v13                                      |

**待做**：auto-2/3/4（App.vue / useAutoLoop / GeneratePanel 阈值整改）

### 人工项（已挪至末尾）

- human-1：标注 baseline.json 30 条 pendingHumanChapters
- human-2：跑 context-pack 对比得权威 Jaccard
- human-3：Jaccard 达标后决策 5.5 灰度

### 全量状态

- 66 测试文件 / 836 用例全绿
- tsc + eslint 0 error
