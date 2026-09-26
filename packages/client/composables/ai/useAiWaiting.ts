import { ref, watch } from 'vue'

/** 跨组件共享的「等待 AI 回复」 + 牛马模式守夜（单一数据源） */

// 3 分钟无回复则：若牛马模式开 → 重发提示并续订；否则仅复位 waiting
const WATCHDOG_MS = 180_000
/** 键 */
const NIumaKey = '__ai_niuma_mode'
// loopPaused 持久化到 sessionStorage：刷新后仍保持暂停态
const LS_LOOP_PAUSED = '__ai_loop_paused'

/** 是否处于等待 AI 回复状态 */
const waiting = ref(false)
/** 牛马模式开关（AI 持续自驱） */
export const niumaMode = ref(false)
/** 循环 */
export const loopPaused = ref(false) // 暂停闸：阻断续推/发脚本/等待

// 可观测状态
const fireCount = ref(0)
/** 上次看门狗触发的时间戳 */
const lastFiredAt = ref(0)
/** 下次看门狗触发的时间戳 */
const nextFireAt = ref(0)

let watchdogTimer: ReturnType<typeof setTimeout> | null = null
let resendHandler: (() => Promise<void> | void) | null = null

// 从 sessionStorage 恢复 loopPaused
try {
  if (sessionStorage.getItem(LS_LOOP_PAUSED) === '1') loopPaused.value = true
} catch { /* sessionStorage 不可用时按未暂停处理 */ }
watch(loopPaused, (v) => {
  try { sessionStorage.setItem(LS_LOOP_PAUSED, v ? '1' : '0') } catch { /* 持久化失败不影响运行态 */ }
})

// 从 localStorage 恢复 niumaMode
try { niumaMode.value = localStorage.getItem(NIumaKey) === '1' } catch { /* localStorage 不可用时按关闭处理 */ }
watch(niumaMode, (v) => {
  try { localStorage.setItem(NIumaKey, v ? '1' : '0') } catch { /* 持久化失败不影响运行态 */ }
})

/**
 * 启动 Waiting
 */
export function startWaiting(): void {
  waiting.value = true
  armWatchdog()
}

/**
 * 设置 Ai Waiting Watchdog
 * @param fn - fn
 */
export function setAiWaitingWatchdog(fn: () => Promise<void> | void): void {
  resendHandler = fn
}

/**
 * 清空 Watchdog
 */
function clearWatchdog(): void {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
}

/**
 * 武装 Watchdog
 */
function armWatchdog(): void {
  nextFireAt.value = Date.now() + WATCHDOG_MS
  clearWatchdog()
  watchdogTimer = setTimeout(async () => {
    watchdogTimer = null
    if (!waiting.value) return
    if (niumaMode.value) {
      try {
        if (resendHandler) await resendHandler()
        fireCount.value += 1
        lastFiredAt.value = Date.now()
      } catch { /* 重发失败不阻断后续守夜 */ }
      if (waiting.value) armWatchdog()
    } else {
      // 未开牛马：只复位，避免永久卡死
      waiting.value = false
    }
  }, WATCHDOG_MS)
}

/**
 * 组合式函数 Ai Waiting
 */
export function useAiWaiting() {
  return {
    loopPaused,
    waiting,
    niumaMode,
    fireCount,
    lastFiredAt,
    nextFireAt,
    startWaiting() {
      waiting.value = true
      armWatchdog()
    },
    stopWaiting() {
      waiting.value = false
      clearWatchdog()
    },
  }
}
