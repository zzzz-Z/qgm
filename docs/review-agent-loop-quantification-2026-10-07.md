# 对齐通用编码智能体循环 · 量化反馈

> 目标：为 `plan-agent-loop-alignment.md` 与 `review-agent-loop-alignment-2026-10-07.md` 提供实测数据，判定「P0 自动续跑」与「H1 冻结播报解耦」的优先级。
> 取证方式：读 `.ai-runner/logs/**` 现有日志（**只读，未改代码，未起新日志**）。
> 数据窗口：2026-10-07 全天（北京时间 UTC+8）。
> 结论：**无法量化 plain 占比**——日志系统缺 reply kind 字段；代理信号**倾向支持 P0 但不足以裁决**；建议先补日志字段再观察。

## §0 结论速览

- **直接量化不可行**：`send.jsonl` 只记录「工作台 → AI」的出站内容，不记录「AI → 工作台」的 reply kind；`runner.jsonl` 只记录脚本执行，AI 回 plain 时无痕迹。
- **代理信号**：send 间隔分布中 `5-15s` 占 47.5%（正常回传节奏），`gt60s` 占 11.4%（可能含超时痕迹）；`run/send = 1.17`（多数 AI 回复含脚本）。
- **倾向判断**：如果 plain 是主要痛点，应能看到大量「90s+ 干等 + 用户手动重启」的模式；现有 11.4% 的 60s+ 间隔**可能**含此模式，但无法与「用户思考暂停」区分。
- **裁决建议**：先补日志字段（在 plain 分支与 finish 时记录），积累 3~7 天数据后再决定修 H1 还是 P0。**当前不应凭代理信号拍板**。

## §1 数据源与局限

### 1.1 数据源

- `.ai-runner/logs/send.jsonl`（2556 行）：每次工作台出站到 AI 的 prompt 内容（`promptHead` 前 300 字符）。
- `.ai-runner/logs/runner.jsonl`（12190 行）：每次脚本执行的 runId / exit / durationMs / changeCount。
- `.ai-runner/logs/reject.jsonl`（669 行）：服务端前置拦截的脚本（语法错 / 脚本头契约违规）。
- `.ai-runner/logs/board.jsonl`（360 行）：任务板 push/start/complete/fail 事件。
- `.ai-runner/logs/2026-10-07.jsonl`（1075 行）：当日 run 的完整脚本原文与 desc/why。

### 1.2 核心局限（诚实声明）

- **无 reply kind 字段**：`send.jsonl` 记录的是「工作台发给 AI 的内容」，不是「AI 回复的内容」。AI 回 plain / script / done 在服务端日志中**零痕迹**。
- **无 finish reason 字段**：`finish(inst, reason)` 只在客户端内存里传递 reason，不落盘。`board.jsonl` 的 `clear=finish` 今日 = 0，说明任务板清空未记录到日志（或被 `[taskboard-sid-guard-v1]` 拦下）。
- **无循环生命周期事件**：`loop:finish` 事件只存在于客户端 localStorage 事件流，服务端日志无副本。

### 1.3 因此能测与不能测

能测：

- 出站 prompt 的类型分布（脚本结果 / 合并结果 / 控制类 / 用户输入）
- 出站间隔分布（正常节奏 vs 长间隔）
- 脚本执行次数、拒收率、每日 run 峰值

不能测：

- AI 回复的 kind 分布（plain / script / done 占比）
- plain 后是否 90s 超时终止
- 「AI 想先解释再执行」的真实案例数
- §8 冻结播报是否发生过

## §2 实测数据

### 2.1 出站 prompt 类型（2026-10-07）

- 回传-脚本结果：1850 条
- 回传-合并结果：162 条
- 回传-其他（控制类 / PLAN 续跑 / 自检失败）：162 条
- 合计：2174 条

### 2.2 出站间隔分布（同日）

- `lt5s`：65 条（3.0%）
- `5-15s`：1032 条（47.5%）——正常节奏（脚本执行 + 拼装 + 发送）
- `15-60s`：828 条（38.1%）——较慢的脚本或人工介入
- `gt60s`：249 条（11.4%）——**可能含超时痕迹**（90s / 180s），也可能含用户思考暂停

### 2.3 脚本执行间隔分布（同日）

- `lt30s`：2047 条（80.4%）——正常连续执行
- `30-60s`：242 条（9.5%）
- `60-120s`：150 条（5.9%）
- `gt120s`：105 条（4.1%）——可能是长脚本、也可能是循环终止后重启

### 2.4 脚本执行与出站比

- run 总数（今日）：2545
- send 总数（今日）：2174
- `run/send = 1.17`——**多数 AI 回复含至少一个脚本**（若 plain 占比很高，该比值会 < 1）

### 2.5 服务端拒收率

- 今日拒收 226 条，`reject/run = 0.09`（9%）
- 分类：`syntax` 86 条 / `head-contract` 140 条
- 拒收是**另一类问题**（脚本格式错误），与 plain 无关

## §3 代理信号分析

### 3.1 对「plain 是主要痛点」的证伪线索

- `run/send = 1.17 > 1`：如果 AI 频繁回 plain（不执行脚本），run 数应显著低于 send 数。实际 run 数**高于** send 数（因为一条回复可含多块），暗示**多数 AI 回复含脚本**。
- 正常节奏（`5-15s`）占 47.5%：说明大部分轮次是「回传 → AI 回脚本 → 执行 → 回传」的顺畅循环。

### 3.2 对「plain 是主要痛点」的证实线索

- `gt60s` 占 11.4%（249 条）：其中若有相当比例对应「AI 回 plain → 干等 90s → 终止 → 用户手动重启」，则说明 plain 是**真实高频问题**。
- `runner.jsonl` 的 `gt120s`（105 条，4.1%）：若这些 gap 对应「循环终止后用户重新发起」，则频率不低。

### 3.3 无法裁决的原因

- `gt60s` 的 249 条无法区分：正常长脚本？用户思考暂停？循环终止后重启？
- 需要日志补一条字段：finish 时记录 `reason`（含 `round-timeout` / `no-script-reply` / `interrupted`），才能反推。

## §4 建议

### 4.1 前置建议（最高优先级）

- **补日志字段**：在 `finish(inst, reason)` 落盘一条 `loop-finish.jsonl`（含 ts / sid / reason / round / goal），成本约 5 行代码（`stop-and-finish.ts` 内一次 fetch 调用）。**这是唯一的裁决依据**。
- **补 reply kind 记录**：在 `reply-handlers.ts` 的 `onNonScriptReply` 入口落盘一条 `loop-reply.jsonl`（含 ts / sid / kind / state / round），成本约 5 行。
- **补跑观察窗口**：字段落地后，积累 3~7 天数据，统计 kind=plain 占比与 reason=round-timeout 占比。

### 4.2 据数据分支（字段落地后再执行）

- **若 kind=plain 占比 < 5%**：P0 收益有限，优先级应低于其它活跃工单。
- **若 plain 集中在 §8 冻结播报**：先修 H1（TEXT 播报与循环终止解耦），再做 P0。
- **若 plain 是「AI 想先解释再执行」且占比 > 10%**：P0 值得做，按评审 S1-S5 顺序实施。

### 4.3 当前不建议

- **不建议凭代理信号拍板**：§3 的两组线索互相抵消（run/send > 1 提示 plain 少；gt60s 11.4% 提示 plain 可能不少），无法裁决。
- **不建议先做 P1**：评审已指出成本被低估（三处同构 + 对拍守卫），且 P1 依赖 P0 的观察结论。

### 4.4 与评审的呼应

- 评审 H1 / H2 / H3 / H4 四个隐患：本次量化**未推翻**任何一条，也未新增证据。它们仍是 P0 实施的前置条款。
- 评审 §6 建议的三件事量化：本次完成第 1 件（plain 频率）——结论是「当前无法测」，需先补字段。另两件（超时终止占比 / 真实案例数）同样受限于字段缺失。

## §5 本次量化的局限（诚实边界）

- **未实跑验证**：所有数据来自历史日志，未起新实例复现 plain 场景。
- **未做人工标注**：gt60s 的 249 条间隔中，哪些是「超时终止」、哪些是「用户思考」，未逐条核对。
- **窗口仅 1 天**：2026-10-07 单日数据，未跨多日对比。
- **未考虑会话分布**：所有数据混合多个 sid，未按会话拆分。
- **未测 §8 冻结播报**：没有日志字段能识别该形态，无法验证评审 H1 的真实发生率。

## §6 取证方式

读盘核验：

- `.ai-runner/logs/send.jsonl`（2556 行，采样首末行 + 全量分类）
- `.ai-runner/logs/runner.jsonl`（12190 行，按日统计 + 间隔分布）
- `.ai-runner/logs/reject.jsonl`（669 行，按 kind 分类）
- `.ai-runner/logs/board.jsonl`（360 行，查 clear=finish）
- `.ai-runner/logs/2026-10-07.jsonl`（1075 行，采样）
- `packages/client/composables/ai/auto-loop/stop-and-finish.ts`（finish 实现，确认无落盘）
- `packages/client/composables/ai/auto-loop/waiting.ts`（enterWaiting 超时回调）

未做（诚实边界）：

- 未实跑 e2e
- 未起 5175 实例验证真实时序
- 未做人工标注
- 未跨多日对比
