// keyboard —— Esc 暂停 / Ctrl+Esc 回滚
import { activeLoop, isLoopActive, requestPause, stopAndRollback } from '../useAutoLoop.js'

let keyboardBound = false
// 键盘：Esc 暂停 / Ctrl+Esc 回滚
// 键盘绑定是全局的（每页一份），onKeydown 从 activeLoop 取当前实例
/**
 * 循环进行中的全局键盘处理：Escape 暂停 / Ctrl+Escape 回滚
 * [WHY] 急停入口需在循环运行时可立即响应；Ctrl 修饰区分"暂停"与"回滚"两档
 * [CONSTRAINT] 无活动循环时直接返回；两种分支都会 preventDefault 避免与浏览器冲突
 * [CHANGE-IMPACT] 与 pause-control / stop-and-finish 联动；改快捷键需同步 UI 提示文案
 * @param e 键盘事件；只关心 key='Escape' 的两档组合
 */
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
