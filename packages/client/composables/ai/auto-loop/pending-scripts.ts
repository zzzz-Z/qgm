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
