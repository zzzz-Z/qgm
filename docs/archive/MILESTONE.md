# MILESTONE｜四主线并行交付小结

> 日期：2026-09-22（第 8 期更新）
> 会话：sess_95a36a59
> 轮次：339

## 一、已交付范围（四条主线）

### 主线 0：AI 上下文优化

- 阶段0 五表：`docs/plan/phase0/{A,B,C,D,E}-*.md`
- 意图声明：`docs/plan/intent-schema.json` + `intent-recon-template.md`
- 映射表：`skills/mapping.json`（22 条）
- 装配器：`scripts/context-pack.cjs`（token 预算 8000）
- 基准集：`docs/plan/baseline.json`（30 样本）
- loader 显式导出：`skills/_loader.cjs --dump-keywords`
- RULES 结构重组：928 → 568 行
- **阻塞**：阶段5 命中率验证需人工标注 baseline

### 主线 B：工作流状态与可视化

**P1 纯逻辑层**：

- `src/state/pipeline.ts`（11 段 × 4 状态 + retry）
- `src/state/timeline.ts`（round-N.json 落盘）
- `src/state/perf.ts`（基线累积 + 2x 慢标记）

**P2 可视化层**：

- `client/components/panels/PipelineGraph.vue`（五段聚合 + 窄屏纵向）
- `client/components/panels/DecisionPolicySwitch.vue`（三档 + 7 类）
- `client/components/panels/TaskTree.vue`（拓扑 + 双视图）
- `client/components/panels/AbnormalView.vue`（严重度排序）
- `client/composables/ui/useTwDisplay.ts`（打字机 + 降噪）
- `client/composables/ui/useFoldState.ts`（localStorage 持久化）
- `client/composables/ui/useDecisionPolicy.ts`
- `client/components/script/output-utils.ts`

**数据链路**：state.json.pipeline / state.todo → tasks-routes → useTasks → 组件

### 主线 C：通道与浏览器能力

- `src/headless/cssom-screenshot.ts`（CDP cssom + screenshot）
- `bin/headless-cli.cjs`（自包含 CLI，cssom/screenshot/diff）
- `src/state/screenshot-diff.ts`（三层阈值）
- `scripts/tampermonkey-session-id.user.js`（msgId 去重 + 断链队列 + DOM 存活）
- `__AI__.browser.{cssom,screenshot}` 通道抽象
- **实测通过**：cssom 66 规则 / screenshot 13KB / diff identical

### 主线 D：基础设施

- `test/server/{pipeline,timeline,bash-whitelist,perf}.node-test.ts`（41 用例）
- `src/state/snapshot.ts::writeChannelLog`（三通道日志）
- `.ai-runner/config.json`（统一配置）
- `scripts/migrate-state.cjs`（v11→v12 迁移）
- `src/process/bash-guard.ts::checkBashWhitelist`（灰度接线）
- `PROJECT-NOTES.md`（架构决策文档）

## 二、全量状态

- **测试**：65 文件 / 832 用例全绿
- **tsc + eslint**：0 error
- **页面冒烟**：/ 与 /__ai/ 通过

## 三、未完成（PLAN 剩余）

| 项                         | 状态       | 阻塞原因                  |
| -------------------------- | ---------- | ------------------------- |
| 阶段5 命中率验证           | 🚫 阻塞    | 需人工标注 baseline 30 条 |
| 阈值整改 App.vue           | 🟡 1451 行 | 需 ~6 轮拆分              |
| 阈值整改 useAutoLoop.ts    | 🟡 1098 行 | 依赖闭包，需重构          |
| 阈值整改 ScriptPanel.vue   | 🟡 1562 行 | 已拆 2 步，续拆 ROI 低    |
| 中屏（768-1200）布局       | ⏳ 未做    | 优先级低                  |
| 阈值整改 GeneratePanel.vue | 🟡 1144 行 | 未启动                    |

## 四、下一步建议

1. **解锁阶段5**（唯一生死线）：人工标注 `docs/plan/baseline.json` 的 30 条 `pendingHumanChapters`。
2. 标注后跑 `scripts/context-pack.cjs` 对比，得权威 Jaccard。
3. 若 Jaccard ≥ 60%：进入 5.5 灰度（先「改样式」类）。
4. 若 Jaccard < 60%：继续修 `skills/mapping.json`。
5. 阈值整改在阶段5 解锁后再启（避免抢上下文）。

## 五、关键约束

- **单一真相源**：`.ai-runner/state.json`（前端只读）
- **配置唯一**：`.ai-runner/config.json`
- **三通道日志**：`logs/{runner,pipeline,decisions}.jsonl`
- **L2 五类**：生产/DDL/删核心配置/外部写/git 历史 → 暂停等确认
