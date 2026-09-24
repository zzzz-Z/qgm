// [use-tw-display-v1] 从 ScriptPanel.vue 抽出（PLAN 4.7 阈值整改）
// 打字机式实时输出 + 降噪（关键节点行 + 尾部 N 行）
import type { Ref } from 'vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

/** Tailwind 尾部字符标记 */
const TW_TAIL = 5
/** Tailwind 需要保留的正则（防止误删） */
const TW_KEEP_RE = /^[▶✓✗!⚠⋯]/

/**
 * 组合式函数 Tw Display
 * @param liveStdout - live Stdout
 * @param liveStderr - live Stderr
 */
export function useTwDisplay(liveStdout: Ref<string>, liveStderr: Ref<string>) {
  const twStdout = ref('')
  const twStderr = ref('')
  let twRaf: number | null = null

  function twStep() {
    twRaf = null
    const tOut = (liveStdout && liveStdout.value) || ''
    const tErr = (liveStderr && liveStderr.value) || ''
    let more = false
    if (twStdout.value.length < tOut.length) {
      const step = Math.max(1, Math.min(80, Math.ceil((tOut.length - twStdout.value.length) / 12)))
      twStdout.value = tOut.slice(0, twStdout.value.length + step)
      more = true
    } else if (twStdout.value !== tOut) { twStdout.value = tOut }
    if (twStderr.value.length < tErr.length) {
      const step = Math.max(1, Math.min(80, Math.ceil((tErr.length - twStderr.value.length) / 12)))
      twStderr.value = tErr.slice(0, twStderr.value.length + step)
      more = true
    } else if (twStderr.value !== tErr) { twStderr.value = tErr }
    if (more) twRaf = requestAnimationFrame(twStep)
  }

  function twKick() {
    if (twRaf === null) twRaf = requestAnimationFrame(twStep)
  }

  watch(liveStdout, twKick)
  watch(liveStderr, twKick)
  onBeforeUnmount(() => { if (twRaf !== null) cancelAnimationFrame(twRaf) })

  const twLines = computed<string[]>(() => {
    const raw = (twStdout.value || '').split('\n')
    if (raw.length <= 6) return raw
    const keep = new Set<number>()
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i].replace(/^\s+/, '')
      if (TW_KEEP_RE.test(t)) keep.add(i)
    }
    for (let i = Math.max(0, raw.length - TW_TAIL); i < raw.length; i++) keep.add(i)
    if (keep.size < 3) return raw
    const out: string[] = []
    let folded = 0
    for (let i = 0; i < raw.length; i++) {
      if (keep.has(i)) {
        if (folded > 0) { out.push(`⋯ ${folded} 行省略`); folded = 0 }
        out.push(raw[i])
      } else {
        folded++
      }
    }
    if (folded > 0) out.push(`⋯ ${folded} 行省略`)
    return out
  })

  const twErrLines = computed(() => (twStderr.value || '').split('\n'))

  return { twStdout, twStderr, twLines, twErrLines }
}
