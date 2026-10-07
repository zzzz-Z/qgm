# UI 状态出口校准审计（2026-10-07）

> **性质**：对应用端《静默窗可视化》汇报中「无出口状态盘点表」的**独立复核与校准**。
> **不是新工单**——校准后的清单**建议暂不派发**（理由见文末）。

## 一、复核方法

逐项落盘：读 `ScriptPanel.vue` / `TerminalPane.vue` 的 template 段（`lastIndexOf('</template>')` 取根模板）与全仓 grep，核对「是否真有渲染消费」。

## 二、原盘点 8 项 → 校准结果

### 误判项（应用端说错，2 项）

- **`TerminalPane` 的 `running` prop「声明后零消费」——不成立**：`TerminalPane.vue:452` 的 `v-if="!running && !liveStdout && !liveStderr && timelineItems.length === 0"` 消费了它（空态判断条件之一）。
- **「90s 轮超时倒计时仅 ≥30s 变文案、无倒计时」——已过时**：`ScriptPanel.vue:119` 明写「已删除 countdown（延迟机制移除）」。倒计时已被删，不存在此缺口。

### 成立项（应用端说对）

- **`statusText` / `statusClass` / `runningElapsed` / `lastDuration` 只写不读**：原 4 处（`ScriptPanel:302/320/350` 赋值 + `:93/95/68/70` 定义）template 段零引用。**已于 2026-10-07 修复**（`[status-bar-v1]` 接线 + 承重判据）。
- **`pendingScriptCount` 无常驻显示**：`ScriptPanel:299` 仅用于 `midBatch` 逻辑判定，无渲染出口。
- **循环 `stage`（plan/implement/verify）组件层零消费**：`after-round.ts:24` 声明，`components/script/` 内无消费点。
- **`stopRequest` 窗口（点停止→生效）无可视化**：只有 `paused` 有徽章。
- **hard-rounds(50) / hard-timeout(30min) 余量无显示**。
- **selfcheck 连续失败计数（1/2）只有 toast**。

> **补核（2026-10-07 晚）**：上三项**已独立复核，均成立**——
>
> - `stopRequest`：`after-round.ts:69/75`、`pause-control.ts:150/164`、`reply-handlers.ts:111` 消费逻辑，**`components/` 内零渲染**。
> - hard 余量：`after-round.ts:61-66` 用 `LOOP_HARD_MAX_MS`/`LOOP_HARD_MAX_ROUNDS` 判 `finish()`，**无 UI 显示**。
> - selfcheck 计数：`reply-handlers` 的 `_selfcheckFailCount` 存在，**组件层无消费**（`TaskProgressPanel` 的「连续失败」是另一件事：任务板拉取失败，非 selfcheck）。
>   ⇒ **原盘点 8 项：2 误判 + 6 成立**。

## 三、裁决：剩余 5 项建议**暂不派发**

理由三条：

- **非缺陷，是 UI 取舍**：这 5 项**功能都正常工作**，只是「没显示」。与 `statusText` 族（写了完整状态机却零渲染 = 误导性死代码）性质不同。
- **撞 WO-20261006-05 判例**：「已写全再补属假强制」——为已有功能补纯展示，收益需先论证；不能用它凑「状态全可视化」的完整度。
- **工作区 81 项未提交 + 并行会话在改同批文件**：继续叠加会加剧撞车与归因困难。**先收口，再谈扩展**。

## 四、若将来要做：优先级（应用端自判）

- **`pendingScriptCount` 常驻**：批量执行时用户不知还剩几块，是**真实痛点**——若要做，这一项优先。
- 其余 4 项（`stage` / `stopRequest` / hard 余量 / selfcheck 计数）：价值递减，建议登记观察。

## 五、可复现

读 `TerminalPane.vue` 的 L452；读 `ScriptPanel.vue` 的 L119（countdown 已删）；grep `stage` 于 `components/script/`（无循环 stage 消费）；`status-bar-v1` 接线见 `ScriptPanel.vue:494`。
