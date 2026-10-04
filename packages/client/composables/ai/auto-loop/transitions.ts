// [transitions-v1] 循环状态机显式转移表：把散落在 24 处的 `state.value = X` 收敛为可校验的事件语义
// [WHY] 原实现是裸赋值，非法转移（如 stopped → parsing）无任何提示；集中表格可供开发期守卫与未来纯函数化
// [CONSTRAINT] assertTransition 只 log.warn 不 throw：运行时仍需容忍边缘路径，避免因单点非法转移阻塞整个循环
import type { LoopInstance, LoopState } from './types.js'

/** 触发状态转移的事件语义（与旧代码的赋值点一一对应） */
export type LoopEvent
  = | 'START' // idle → running
    | 'PREPARE' // running → preparing
    | 'FILL' // preparing|running → waiting（首轮 fill 后）
    | 'NEXT_ROUND' // feedback → waiting（轮后回等待）
    | 'SCRIPT' // waiting → parsing（收到脚本）
    | 'EXECUTE' // parsing → executing
    | 'FEEDBACK' // executing → feedback
    | 'DECISION' // waiting → waiting-input（决策点）
    | 'DECISION_ACK' // waiting-input → waiting
    | 'HANDOFF' // waiting|feedback|limit → handoff
    | 'HANDOFF_OK' // handoff → waiting
    | 'HANDOFF_FAIL' // handoff → stopped
    | 'PAUSE' // waiting → paused
    | 'RESUME' // paused|budget-limited → waiting
    | 'BUDGET' // waiting → budget-limited
    | 'STOP' // 任意活动态 → stopped（自然终止/服务端终止）
    | 'INTERRUPT' // 任意活动态 → interrupted（用户急停）
    | 'RESTORE' // 任意活动态 → stopped（刷新恢复降级）

/** 活动态集合：可以触发 STOP/INTERRUPT/RESTORE 的状态 */
const ACTIVE: LoopState[] = ['running', 'preparing', 'waiting', 'parsing', 'executing', 'feedback', 'handoff', 'waiting-input', 'paused', 'budget-limited']

/** 终态集合：不再转移 */
const TERMINAL: LoopState[] = ['stopped', 'interrupted']

/** 状态 × 事件 → 目标态；未定义的组合视为非法转移 */
export const TRANSITIONS: Record<LoopState, Partial<Record<LoopEvent, LoopState>>> = {
  'idle': { START: 'running', FILL: 'waiting', RESTORE: 'stopped', STOP: 'stopped', INTERRUPT: 'interrupted' },
  'running': { PREPARE: 'preparing', FILL: 'waiting', HANDOFF: 'handoff', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'preparing': { FILL: 'waiting', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'waiting': { SCRIPT: 'parsing', DECISION: 'waiting-input', FEEDBACK: 'feedback', PAUSE: 'paused', BUDGET: 'budget-limited', HANDOFF: 'handoff', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'parsing': { EXECUTE: 'executing', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'executing': { FEEDBACK: 'feedback', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'feedback': { NEXT_ROUND: 'waiting', FILL: 'waiting', HANDOFF: 'handoff', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'waiting-input': { DECISION_ACK: 'waiting', FILL: 'waiting', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'handoff': { HANDOFF_OK: 'waiting', HANDOFF_FAIL: 'stopped', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'paused': { RESUME: 'waiting', FILL: 'waiting', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'budget-limited': { RESUME: 'waiting', FILL: 'waiting', STOP: 'stopped', INTERRUPT: 'interrupted', RESTORE: 'stopped' },
  'stopped': { START: 'running', FILL: 'waiting', RESTORE: 'stopped', STOP: 'stopped', INTERRUPT: 'interrupted' },
  'interrupted': { START: 'running', FILL: 'waiting', RESTORE: 'stopped', STOP: 'stopped', INTERRUPT: 'interrupted' },
}

/**
 * 查询状态转移的目标态
 * [CONSTRAINT] 非法组合返回 null；调用方决定是否降级处理
 */
export function transition(from: LoopState, event: LoopEvent): LoopState | null {
  return TRANSITIONS[from]?.[event] ?? null
}

/**
 * 断言一次转移是否合法；非法时输出警告但**不阻断**运行时
 * [WHY] 旧代码在边缘路径上有历史包袱；直接 throw 会把潜在 bug 变成硬故障
 * [CONSTRAINT] 仅 dev 环境告警，生产静默；避免污染控制台
 * @returns 目标态；若非法返回原态
 */
export function assertTransition(from: LoopState, event: LoopEvent): LoopState {
  const next = transition(from, event)
  if (next === null) {
    if (typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      console.warn(`[transitions] 非法转移: ${from} --${event}--> ?`)
    }
    return from
  }
  return next
}

/** 判断是否处于活动态（可被终止/恢复） */
export function isActiveState(s: LoopState): boolean {
  return ACTIVE.includes(s)
}

/** 判断是否处于终态 */
export function isTerminalState(s: LoopState): boolean {
  return TERMINAL.includes(s)
}

/**
 * 应用一次状态转移：非法则告警并保持原态，合法则写回 inst.state.value
 * [WHY] 收敛 24 处裸写 `inst.state.value = X` 到统一入口，杜绝非法转移无感知
 * [CONSTRAINT] 不负责 persist / 副作用；调用方在转移后自行 persist 以匹配原行为
 * [CHANGE-IMPACT] 返回新态；调用方可据此分支（如 from === to 表示被拒）
 * @param inst 循环实例（含 state ref）
 * @param event 语义事件；决定目标态
 * @returns 写入后的当前态（= 目标态或原态）
 */
export function setLoopState(inst: LoopInstance, event: LoopEvent): LoopState {
  const from = inst.state.value
  const next = transition(from, event)
  if (next === null) {
    assertTransition(from, event)
    return from
  }
  inst.state.value = next
  return next
}
