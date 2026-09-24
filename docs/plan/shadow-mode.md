<!-- [shadow-mode-v1] -->

# 影子模式（PLAN 7.D6）

> pipeline 状态机上线后的渐进策略：**先记录不控制，观察数据再启用控制**。

## 当前状态

`pipeline` 处于**影子模式**（`config.pipeline.shadowMode = true`）：

- **记录**：run.ts 每轮 `markRunning/markOk/markFailed` → 写入 `state.json.pipeline` 与 `logs/runner.jsonl`。
- **不控制**：pipeline 的失败/重试状态**不改变主流程**（不触发自动重试、不阻断返回）。
- **前端展示**：PipelineGraph 只读渲染。

## 切控制模式的前提

1. 累积 ≥ 100 轮真实 pipeline 数据。
2. 各段 `durationMs` 基线稳定（`logs/runner.jsonl` 可分析）。
3. 段级 timeout/retry 策略经基线验证（`config.pipeline.timeouts/retries`）。
4. 前端有「段失败 → 重试/跳过/终止」交互入口。

## 切换动作

改 `config.pipeline.shadowMode = false`，然后在 run.ts 中：

- 段 `failed` 时按 `canRetry` + `nextRetryDelay` 自动重试。
- 超 `maxRetry` 后暂停并写 `pendingInput`。
- 前端 `PipelineGraph` 显示重试/跳过/终止按钮。

## 不改动

切影子模式不影响：

- 现有执行流程（`runScript`/`runEslint`/`runTsc`）
- 现有超时（`BASH_TIMEOUT_MS` / `60_000`）
- 现有熔断（exit 码 + stall counter）
