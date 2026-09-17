import { ref } from 'vue'

/**
 * 跨组件共享的「等待 AI 回复」状态
 *
 * 使用场景：
 * - 用户点击「发送给 AI」按钮（copyOutput / copyPrompt / askAi）后，按钮进入 loading
 * - AI 回复通过 Tampermonkey → postMessage(`ai-runner:reply`) 到达 App.vue，此时复位
 * - 90 秒安全兜底：若 AI 一直未回复（窗口关闭 / 网络异常），自动复位避免永久卡死
 *
 * 单例模式：模块级 ref，所有调用方共享同一状态
 */

const waiting = ref(false)
let safetyTimer: ReturnType<typeof setTimeout> | null = null
/** 安全兜底超时：与 auto-loop 单轮 90s 对齐 */
const SAFETY_TIMEOUT_MS = 90_000

function clearSafety() {
  if (safetyTimer) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
}

export function useAiWaiting() {
  return {
    waiting,
    /** 发送 prompt 后调用：进入 loading，启动 90s 兜底 */
    startWaiting() {
      waiting.value = true
      clearSafety()
      safetyTimer = setTimeout(() => {
        waiting.value = false
      }, SAFETY_TIMEOUT_MS)
    },
    /** 收到 AI 回复后调用：退出 loading，清除兜底计时器 */
    stopWaiting() {
      waiting.value = false
      clearSafety()
    },
  }
}
