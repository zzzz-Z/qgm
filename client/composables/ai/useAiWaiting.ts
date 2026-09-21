import { ref, watch } from 'vue'

/** 跨组件共享的「等待 AI 回复」 + 牛马模式守夜（单一数据源） */

const waiting = ref(false)

// 3 分钟无回复则：若牛马模式开 → 重发「继续工作」并续订；否则仅复位 waiting
const WATCHDOG_MS = 180_000
const NIumaKey = '__ai_niuma_mode'
export const niumaMode = ref(false)
export const loopPaused = ref(false) // [loop-paused] 暂停闸：阻断续推/发脚本/等待
// 可观测状态
const fireCount = ref(0)
const lastFiredAt = ref(0)
const nextFireAt = ref(0)
try { niumaMode.value = localStorage.getItem(NIumaKey) === '1' } catch { /* ignore */ }
watch(niumaMode, (v) => {
  try { localStorage.setItem(NIumaKey, v ? '1' : '0') } catch { /* ignore */ }
})

let watchdogTimer: ReturnType<typeof setTimeout> | null = null
let resendHandler: (() => Promise<void> | void) | null = null

export function startWaiting(): void {
  waiting.value = true
  armWatchdog()
}

export function setAiWaitingWatchdog(fn: () => Promise<void> | void): void {
  resendHandler = fn
}

function clearWatchdog(): void {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
}

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
      } catch { /* ignore */ }
      if (waiting.value) armWatchdog()
    } else {
      // 未开牛马：只复位，避免永久卡死
      waiting.value = false
    }
  }, WATCHDOG_MS)
}

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
