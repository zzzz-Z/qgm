// keyboard —— Esc 暂停 / Ctrl+Esc 回滚
import { activeLoop, isLoopActive, requestPause, stopAndRollback } from '../useAutoLoop.js'
// [interaction-log-v1] 交互记录
import { recordInteraction } from '../useInteractionLog.js'

let keyboardBound = false
// ============================================================================
// 键盘：Esc 暂停 / Ctrl+Esc 回滚（v6 §6.6）
// 键盘绑定是全局的（每页一份），onKeydown 从 activeLoop 取当前实例
// ============================================================================
/**
 * 响应 Keydown
 * @param e - e
 */
export function onKeydown(e: KeyboardEvent) {
  const inst = activeLoop.value
  if (!inst || !isLoopActive.value) return
  if (e.key === 'Escape') {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      recordInteraction('rollback', 'keyboard')
      void stopAndRollback()
    } else {
      e.preventDefault()
      recordInteraction('pause', 'keyboard')
      requestPause()
    }
  }
}
/**
 * 绑定 Keyboard
 */
export function bindKeyboard() {
  if (keyboardBound) return
  keyboardBound = true
  window.addEventListener('keydown', onKeydown)
}
/**
 * 执行 unbind Keyboard
 */
export function unbindKeyboard() {
  if (!keyboardBound) return
  keyboardBound = false
  window.removeEventListener('keydown', onKeydown)
}
