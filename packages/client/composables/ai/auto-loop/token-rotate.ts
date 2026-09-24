// token 估算与自动轮转
import { LOOP_ROTATE_THRESHOLD } from '../loopLogic.js'
import { ref, watch } from 'vue'
import { useTraceLog } from '../../ui/useTraceLog.js'
import { activeLoop, isLoopActive } from '../useAutoLoop.js'
import { startHandoff } from './handoff.js'

const { addTrace } = useTraceLog()
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
 * 设置 Token Estimate
 * @param n - n
 */
export function setTokenEstimate(n: number): void {
  const v = Math.max(0, Number(n) || 0)
  const inst = activeLoop.value
  if (!inst) return
  inst.latestTokens.value = v
  if (!autoRotateSession.value) return
  if (!isLoopActive.value) return
  if (inst.state.value === 'handoff') return
  if (inst.state.value !== 'waiting') return
  if (v < LOOP_ROTATE_THRESHOLD) return
  addTrace({
    kind: 'loop',
    summary: `⚠ token 达 ${(v / 1000).toFixed(1)}k ≥ ${LOOP_ROTATE_THRESHOLD / 1000}k，自动触发轮转`,
    payload: { loopId: inst.id.value, loopRound: inst.round.value },
  })
  void startHandoff()
}
