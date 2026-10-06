// [multi-script-v1] 同一条 AI 回复里的「后续脚本」排队区
// [WHY] onScriptArrival 只在 waiting/preparing 态接收脚本。一条回复携带多个脚本时，
//   首块执行期间到达的第 2、3 块会被守卫直接 return 掉（静默丢弃）；
//   而页面侧现在会逐块推送（`extractLatestScript` 取「首个尚未推送的块」）——
//   两侧不同步就会「推了但收不下」，等于多段执行没生效。
// [CONSTRAINT] 按 loopId 隔离；模块级单例（自动循环本身即单例）。
//   队列未清空前**不应**把中间结果回传 AI：否则 AI 会在批量脚本执行到一半时被唤醒并产生新回复，
//   与排队块互相踩踏（消费方 ScriptPanel 依据 pendingScriptCount 抑制回传）。
import { ref } from 'vue'
import type { InboxItem } from '../../runner/useScriptInbox'
import type { RoundOutcome } from './types.js'

/** loopId → 排队待执行的脚本（先进先出 = 与 AI 书写顺序一致） */
const queues = new Map<string, InboxItem[]>()

/** 待执行脚本总数（跨实例求和）。UI 据此判断「这批还没跑完」，抑制中途回传。 */
export const pendingScriptCount = ref(0)

/** 依据各队列长度重算总计数（唯一写入口，避免多处自增导致漂移） */
function syncCount(): void {
  let n = 0
  for (const q of queues.values()) n += q.length
  pendingScriptCount.value = n
}

/**
 * 入队一个后续脚本
 * [CONSTRAINT] 同 hash 不重复入队：页面侧可能因 DOM 重排重推同一块
 * @returns 入队后该队列的长度（1 表示此前为空，调用方可据此措辞）
 */
export function enqueueScript(loopId: string, item: InboxItem): number {
  const q = queues.get(loopId) || []
  if (!item.hash || q.some(it => it.hash === item.hash)) return q.length
  q.push(item)
  queues.set(loopId, q)
  syncCount()
  return q.length
}

/** 取队首（先进先出）；空队列返回 null */
export function shiftScript(loopId: string): InboxItem | null {
  const q = queues.get(loopId)
  if (!q || q.length === 0) return null
  const item = q.shift() || null
  if (q.length === 0) queues.delete(loopId)
  syncCount()
  return item
}

/** 清空某实例的队列（循环已终止 / 暂停时调用，避免残留计数永久抑制回传） */
export function clearScripts(loopId: string): void {
  cancelRoundMerge(loopId)
  if (queues.delete(loopId)) syncCount()
}

/** 是否仍有排队脚本 */
export function hasPendingScripts(loopId: string): boolean {
  const q = queues.get(loopId)
  return Boolean(q && q.length > 0)
}

/** 测试/诊断用：只看不取 */
export function peekPendingScripts(loopId: string): InboxItem[] {
  return [...(queues.get(loopId) || [])]
}

// ==================== [round-merge-v1] 轮内结果合并窗 ====================
//
// 背景（2026-10-06 实盘复算，见 .ai-runner/tmp/reject-cascade-probe.cjs）：
//   `reply-handlers` 原先用「本块执行完时队列是否为空」判断「这条回复的块跑完了吗」。该判据的有效前提是
//   **下一块在被判定的那一刻已经入队**，而页面侧是逐块推送的、块间固定 80ms
//   （scripts/tampermonkey-session-id.user.js:668 `if (hasMoreUnseenBlocks()) setTimeout(classifyAndPost, 80)`）。
//   ⇒ 任何耗时 < 80ms 的块（拒收几乎瞬时：reject.jsonl 的 start==end）结束时，下一块还没推送，
//     判据恒为「队列空」⇒ 该块立刻回传。实测 10-06 同 sid 亚秒级拒收级联 63 条、最长 13 块，
//     其中 146 次出站是**同一条回复的非首块**（纯放大器）。
// 修法：不再依赖「队列瞬时快照」，改为「块末静默 Δ 后仍未等到新块 ⇒ 收口」。Δ 取 1500ms
//   （实测同回复块间空闲 p50=91ms / p90=819ms / p95=1166ms / max=1421ms，与审计脚本 IDLE_MS 同口径）。
// 语义：
//   - 窗口只在「最后一块完成」后计时；期间任何新块完成都会重新计时 ⇒ N 块合成 1 条回传；
//   - 队列里仍有待执行块时不在这里收口（交给该块完成时重新计时），避免慢块把回复切成多次回传；
//   - flush 返回 false（已暂停 / 实例失活）即**丢弃**，绝不补发 —— 与「暂停 = 冻结」语义一致，
//     也保证用户点了停止之后不会再有迟到出站。

/** 轮内合并窗口（ms）。见上方注释的实测分位。 */
export const ROUND_MERGE_MS = 1500

/** 合并槽：同一 loopId 下本回复已完成的块结果 + 待触发的窗口定时器 */
interface MergeSlot {
  outcomes: RoundOutcome[]
  timer: ReturnType<typeof setTimeout> | null
  flush: ((outcomes: RoundOutcome[]) => boolean) | null
}

const merges = new Map<string, MergeSlot>()

/** 到点：队列空则交给 flush 出站，否则原地等待（由待执行块的完成事件重新计时） */
function fireRoundMerge(loopId: string): void {
  const slot = merges.get(loopId)
  if (!slot) return
  slot.timer = null
  if (hasPendingScripts(loopId)) return
  const outcomes = slot.outcomes.splice(0, slot.outcomes.length)
  const flush = slot.flush
  merges.delete(loopId)
  if (!flush || outcomes.length === 0) return
  // 返回值语义：true=已出站；false=守卫拒绝（暂停/失活）→ 丢弃，不重排定时器（防迟到出站）
  flush(outcomes)
}

/**
 * 记入一个已完成块的结果，并把本回复的合并窗顺延 Δ
 * @param loopId 循环实例 id（该 id 即「本回复」的作用域）
 * @param outcome 本块执行结果
 * @param flush 窗口到点时的出站回调；返回 true 表示已发出（调用方在回调内自行判守卫）
 */
export function stageRoundOutcome(
  loopId: string,
  outcome: RoundOutcome,
  flush: (outcomes: RoundOutcome[]) => boolean,
): void {
  const slot = merges.get(loopId) || { outcomes: [], timer: null, flush: null }
  slot.outcomes.push(outcome)
  slot.flush = flush
  if (slot.timer) clearTimeout(slot.timer)
  slot.timer = setTimeout(() => { fireRoundMerge(loopId) }, ROUND_MERGE_MS)
  merges.set(loopId, slot)
}

/** 取消并丢弃某实例的合并窗（循环终止 / 暂停 / 队列清空时调用） */
export function cancelRoundMerge(loopId: string): void {
  const slot = merges.get(loopId)
  if (!slot) return
  if (slot.timer) clearTimeout(slot.timer)
  merges.delete(loopId)
}

/** 测试/诊断用：本实例尚未出站的块结果 */
export function peekRoundOutcomes(loopId: string): RoundOutcome[] {
  return [...(merges.get(loopId)?.outcomes || [])]
}
