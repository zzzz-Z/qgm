// token 估算与自动轮转
import { LOOP_ROTATE_THRESHOLD } from '../loopLogic.js'
import { ref, watch } from 'vue'
import { activeLoop, isLoopActive } from '../useAutoLoop.js'
import { startHandoff } from './handoff.js'

/** 键 */
const KEY_AUTO_ROTATE = '__ai_auto_rotate_session'
// 已移至 loopLogic.ts，见下方 import
function loadBoolSetting(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch { return fallback }
}
/** 会话 */
export const autoRotateSession = ref<boolean>(loadBoolSetting(KEY_AUTO_ROTATE, true))
watch(autoRotateSession, (v) => {
  try { localStorage.setItem(KEY_AUTO_ROTATE, v ? '1' : '0') } catch { }
})

/**
 * 更新本轮 token 估算值，并在超阈值时触发会话轮转
 * [WHY] 长会话触及上下文上限前主动 handoff 到新会话，避免被服务端截断
 * [CONSTRAINT] 五重前置判定（有活动循环 / autoRotateSession 开启 / 循环活动中 / 非 handoff / 处于 waiting）；
 * 只响应 waiting 态 —— 其他状态刷新估值不触发轮转
 * [CHANGE-IMPACT] 触发 startHandoff 会改变 inst.state；阈值 LOOP_ROTATE_THRESHOLD 由 loopLogic 提供
 * @param n 本轮累计 token 估算值；负数与 NaN 会被兜底为 0
 */
export function setTokenEstimate(n: number): void {
  const v = Math.max(0, Number(n) || 0)
  const inst = activeLoop.value
  if (!inst) return
  if (!autoRotateSession.value) return
  if (!isLoopActive.value) return
  if (inst.state.value === 'handoff') return
  if (inst.state.value !== 'waiting') return
  if (v < LOOP_ROTATE_THRESHOLD) return
  void startHandoff()
}
