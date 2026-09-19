import { ref } from 'vue'

const KEY = '__ai_auto_takeover'

function loadBool(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

const enabled = ref(loadBool())
const countdown = ref(0)
let timer: ReturnType<typeof setTimeout> | null = null
let ticker: ReturnType<typeof setInterval> | null = null

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null }
  countdown.value = 0
}

export function useAutoTakeover() {
  return {
    enabled,
    countdown,
    enable() {
      enabled.value = true
      try { localStorage.setItem(KEY, '1') } catch { /* ignore */ }
    },
    disable() {
      enabled.value = false
      if (timer) { clearTimeout(timer); timer = null }
      stopTicker()
      try { localStorage.setItem(KEY, '0') } catch { /* ignore */ }
    },
    scheduleAutoRun(fn: () => void) {
      if (timer) clearTimeout(timer)
      stopTicker()
      const delayMs = 3000 + Math.random() * 7000
      const targetTs = Date.now() + delayMs
      countdown.value = Math.ceil(delayMs / 1000)
      ticker = setInterval(() => {
        const left = Math.max(0, Math.ceil((targetTs - Date.now()) / 1000))
        countdown.value = left
        if (left <= 0) stopTicker()
      }, 200)
      timer = setTimeout(() => {
        timer = null
        stopTicker()
        fn()
      }, delayMs)
    },
    cancelAutoRun() {
      if (timer) { clearTimeout(timer); timer = null }
      stopTicker()
    },
  }
}
