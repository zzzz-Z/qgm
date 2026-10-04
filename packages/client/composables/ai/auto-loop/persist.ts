// AIRUNNER-BATCH5-0D-PERSIST: 从 useAutoLoop.ts 抽出的持久化逻辑（sessionStorage 单 key）
// 刷新后不自动续跑：活动态在 restore 时降级为 stopped，供用户「再来一次」。

import type { LoopInstance, LoopState } from './types.js'
import { setLoopState } from './transitions.js'

/** sessionStorage 中持久化的循环快照结构；只存恢复所需的标量字段，不存窗口/定时器引用 */
interface PersistShape {
  loopId: string
  loopGoal: string
  loopRound: number
  loopStartCommit: string
  stopReason: string
  state: LoopState
}

/** sessionStorage 键；[CONSTRAINT] 与 restore 严格配对，改名会丢失既有循环恢复能力 */
const STORAGE_KEY = '__ai_runner_loop'

/**
 * 把循环关键状态写入 sessionStorage
 * [WHY] 只存恢复所需字段（id / goal / round / startCommit / reason / state）；
 * 窗口引用与定时器无法跨刷新，持久化只会带来误以为可续跑的错觉
 * [CONSTRAINT] state='idle' 视为无活动循环，直接移除存储项（避免脏数据）
 * [CHANGE-IMPACT] 会被 restore 消费；改字段名或结构会破坏刷新恢复
 * @param inst 循环实例；读取其 id/goal/round/startCommit/stopReason/state
 */
export function persist(inst: LoopInstance) {
  if (inst.state.value === 'idle') {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* swallow: 无存储权限时仅内存态为 idle，不阻断 */ }
    return
  }
  const snap: PersistShape = {
    loopId: inst.id.value,
    loopGoal: inst.goal.value,
    loopRound: inst.round.value,
    loopStartCommit: inst.startCommit.value,
    stopReason: inst.stopReason.value,
    state: inst.state.value,
  }
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch { /* swallow: 配额/隐私模式，持久化失败仅丢失刷新恢复能力 */ }
}

/**
 * 从 sessionStorage 恢复循环状态（页面刷新后调用）
 * [WHY] 刷新会丢失窗口引用，无法续跑；此处把活动态降级为 'stopped'，
 * 并把已完成轮数写入 stopReason，用户据此判断是否「再来一次」
 * [CONSTRAINT] 只处理活动态（running/waiting/parsing/executing/feedback）；
 * 已是 stopped 的快照不覆盖当前内存态，避免破坏用户手动操作
 * [CHANGE-IMPACT] 会调用 persist 回写一次（state 已被改为 stopped）
 * @param inst 循环实例；就地恢复字段
 */
export function restore(inst: LoopInstance) {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const snap = JSON.parse(raw) as PersistShape
    // 活动中的循环在刷新后无法续跑（窗口引用丢失）→ 标记 stopped 供用户查看
    // [restore-active-states-v1] 补齐 preparing / handoff / waiting-input / paused / budget-limited：
    // 刷新时非终态应恢复为 stopped 供用户查看；原集合只覆盖 5 态导致这些状态下刷新无提示（隐藏 bug）
    const activeStates: LoopState[] = ['running', 'preparing', 'waiting', 'parsing', 'executing', 'feedback', 'handoff', 'waiting-input', 'paused', 'budget-limited']
    if (activeStates.includes(snap.state)) {
      inst.id.value = snap.loopId
      inst.goal.value = snap.loopGoal
      inst.round.value = snap.loopRound
      inst.startCommit.value = snap.loopStartCommit
      // [U4] 携带进度信息，方便用户判断是否「再来一次」
      inst.stopReason.value = `页面刷新中断 · 已完成 ${snap.loopRound} 轮 · 可点「再来一次」继续`
      // [transitions-v1] RESTORE 事件：任意活动态 → stopped（刷新降级）
      setLoopState(inst, 'RESTORE')
      persist(inst)
    }
  } catch { /* swallow: JSON 损坏 / 结构不符，保持 idle 由用户手动启动 */ }
}
