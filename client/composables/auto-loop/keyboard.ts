// [refactor-auto-loop] keyboard —— Esc 暂停 / Ctrl+Esc 回滚
import { activeLoop, isLoopActive, requestPause, stopAndRollback } from '../useAutoLoop.js'

let keyboardBound = false
// ============================================================================
// 键盘：Esc 暂停 / Ctrl+Esc 回滚（v6 §6.6）
// 键盘绑定是全局的（每页一份），onKeydown 从 activeLoop 取当前实例
// ============================================================================
export function onKeydown(e: KeyboardEvent) {
  const inst = activeLoop.value
  if (!inst || !isLoopActive.value) return
  if (e.key === 'Escape') {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      void stopAndRollback()
    } else {
      e.preventDefault()
      requestPause()
    }
  }
}
export function bindKeyboard() {
  if (keyboardBound) return
  keyboardBound = true
  window.addEventListener('keydown', onKeydown)
}
export function unbindKeyboard() {
  if (!keyboardBound) return
  keyboardBound = false
  window.removeEventListener('keydown', onKeydown)
}
