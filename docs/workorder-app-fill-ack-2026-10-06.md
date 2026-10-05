# 直派工单 · 第九轮 WO-20261006-01（首问丢帧：新窗口三处静默丢弃点 → fill ACK 闭环）

> **派发方**：宿主侧（复核兼构建）
> **承接方**：应用端（网页端 AI）
> **本件路径**：`docs/workorder-app-fill-ack-2026-10-06.md`（已登记 `docs/DOCS-INDEX.md`）
> **性质**：缺陷修复（用户实测报告），不属于新功能——观察期约束不挡本轮。

---

## 段零 · 用户实测报告（派单依据）

用户经工作台 **「打开 AI 窗口」与「新会话」两个按钮** 开新窗口，现象两条：

1. **整条首问都没送达**（AI 站点侧什么都没收到）；
2. **首问里没有 SYSTEM.md 文本**。

## 段零之二 · 宿主侧真因取证（file:line 均已亲核，请独立复核）

**服务端无罪**（宿主侧 2026-10-06 00:1x 对 5175 活实例亲测）：

```text
GET  /__ai/preset/system  → 200，ok=true，content 15675 字符（SYSTEM.md 全文在）
POST /__ai/files/read {"paths":["AGENTS.md"]} → 200，AGENTS.md 8232 字符
```

**规则拼装链路也无罪**：`openAiSession(forceRules:true)`（App.vue:234/264、useAppStartup.ts:58）→
`copyAndFill` → `_prependFirstPromptRules`（useAiWindow.ts:98-108）→ `loadRulesBlock()`
（load-rules.ts，SYSTEM+AGENTS 都拼进 finalPrompt）→ 剪贴板 + sendFill。**规则确实在 finalPrompt 里。**

**真因 = 新窗口链路上三处静默丢弃点，任何一处命中，首问整条蒸发且工作台不知道**：

| #   | 位置                                                      | 问题                                                                                                      |
| :-- | :-------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| 1   | `packages/client/composables/ai/useAiWindow.ts:246`       | 新窗口只 `promiseTimeout(1500)` 固定等待，不轮询油猴就绪；站点加载 >1.5s 时 fill 必丢                     |
| 2   | `scripts/tampermonkey-session-id.user.js:968`             | `if (!box) { console.warn('未找到输入框'); return }` ——油猴已注入但输入框未渲染时**吞帧**，不回信、不重试 |
| 3   | `packages/client/composables/ai/useAiWindowSend.ts:75-77` | `postMessage` 发后不管：不抛异常恒返回 `true`，对端是否存在/是否处理完全不可知 → UI 显示「已发送」        |

**另一半现象是设计，不是丢规则**：工作台消息卡按 `[track-original-prompt]`（useAiWindow.ts:149-152）
刻意只显示原始 prompt、不显示规则头——用户在消息卡里看不到 SYSTEM.md 属预期；
但「站点侧整条没收到」是实打实的丢帧。两件事要在回复里分开说清。

## 段一 · P0：fill ACK 闭环（本轮主体）

三处丢弃点各自要一个「可感知」的出口，拼成完整闭环：

1. **油猴侧**（tampermonkey）：`ai-runner:fill` 分支的**每个 return 点**都必须回执
   `post({ type:'ai-runner:fill-ack', ok:false, reason:'…' })`（reason 取值建议：
   `no-input-box` / `empty-prompt` / `dedup-skip`）；`doSend` 调度后回 `ok:true`。
   注意走既有 `post()`（带 _pending 断链队列），不要裸 `window.opener.postMessage`。
2. **客户端发送侧**：`useAiWindowSend.ts` 新增 **`sendFillToAsync(sid, payload, timeoutMs=5000)`**——
   发出 fill 后监听 `ai-runner:fill-ack`（按 msgId 或最近一条匹配），超时未收到即返回 `failed`；
   旧同步 `sendFillTo` 保留（循环轮次等信内路径继续用，避免行为面扩大）。
3. **接线**：`copyAndFill` 的非 headless 分支（useAiWindow.ts:169/186/194 三处）改用 async 版本；
   `failed` 时 toast 明示：**「首问未送达（窗口未就绪/输入框未就绪）；完整内容已复制到剪贴板，请手动粘贴」**。
4. **就绪等待**：`openAiSession`（useAiWindow.ts:246）把固定 1500ms 改为轮询——
   每 300ms 检查一次「该窗口是否已回过任何 `ai-runner:*` 回信」
   （session-id / reply / fill-ack 任一即可作为就绪信号），上限 15s，就绪即发，不就绪超时走 failed toast。
   已知可复用信号：油猴启动即回 `ai-runner:session-id`（tampermonkey:128）。
5. **headless 分支不放大**：`transport.sendFill`（useAiTransport.ts:242）本轮不动；
   但请在回复里说明无头池侧页面就绪由谁保证（file:line），供下一轮决定是否需要同等 ACK。

**约束**：客户端/油猴两侧改动必须同轮完成（ACK 是协议，单侧改等于没修）；
`_seenInbound` 去重键是 msgId，客户端 fill 帧现在不带 msgId ⇒ 重试帧不会被误杀——保持现状并在注释里写明。

## 段二 · 回执纪律（延续 WO-08 段一，本轮又有实例）

- 你回执 `git status` 写「只有 6 项」，实测 **9 项**（含 `docs/DOCS-INDEX.md`、
  `docs/workorder-app-observe-metrics-2026-10-05.md`、`.workbuddy/memory/2026-10-05.md`）。
- 你回执 `pending=24 / total=101`，宿主侧实测时已是 **26/103**——差额正是你 DONE 里的踩坑被自动采集 +2。
  你自己总结的「数字类陈述必须当场重跑」教训，落地方式就是：**回执里凡数字必附「取数时刻 + 命令」**，
  并默认声明「此数为取数快照，提交采集后会自增」。
- 「已 X」类陈述继续按 WO-08 段一三件套（命令 + 退出码 + 原始输出一行）。

## 段三 · 延续项

- WO-08 段二三指标（M1/M2/M3）采集照旧，本轮回执里继续带当日数字。
- WO-08 段四（30 天重跑定界固化进 lessons）与段五（pending 26 条协作复核）状态回报一句即可。

## 段四 · 验收清单

- [ ] 段一 1-4 全部落地；油猴 fill 分支**无任何无回执的 return 路径**（附逐 return 清单）。
- [ ] 实测闭环证据：开新窗口（延迟 >1.5s 的场景，可用 DevTools 节流模拟）→ 首问送达且带 SYSTEM.md；
      以及失败路径：人为让输入框未就绪 → 工作台收到 failed toast 且剪贴板可手动兜底。
- [ ] 两侧同轮改完的说明（协议改动单侧 = 没修）。
- [ ] 段二：回执数字全部带取数命令；git status 全集列出。
- [ ] 全量闸门照常（vitest / eslint / tsc ×4 / docs:verify）；`git status` 不含运行态。
