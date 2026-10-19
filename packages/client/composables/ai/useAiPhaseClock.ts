// [phase-clock-v1] AI 阶段计时：waiting / feedback 两个阶段共用同一套秒表。
// [WHY] 原实现由 TerminalPane 内部持有 waitElapsed，顶部阶段条拿不到 ⇒ 两处各显示一半。
//   抽成模块级单例后，阶段条与时间线读同一个值，来源唯一。
import { computed, ref, watch } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { useRuntime } from './useRuntime'

const { state: runtimeState } = useRuntime()

/** 进入等待/回传阶段的累计秒数；离开该阶段归零 */
const waitElapsed = ref(0)

/** 是否处于「等 AI 回包」或「回传窗」阶段 */
const waitBanner = computed(() => {
  const k = runtimeState.value.kind
  return k === 'waiting' || k === 'feedback'
})

/** 阶段文案：feedback 阶段 AI 已答完、在回传，不能仍说「思考中」 */
const waitText = computed(() => {
  const k = runtimeState.value.kind
  if (k === 'feedback') return '回传中'
  return waitElapsed.value >= 30 ? 'AI 仍在处理' : 'AI 思考中'
})

const { pause, resume } = useIntervalFn(() => { waitElapsed.value += 1 }, 1000, { immediate: false })

watch(waitBanner, (v) => {
  if (v) { waitElapsed.value = 0; resume() }
  else { pause(); waitElapsed.value = 0 }
}, { immediate: true })

/** 供组件消费的只读视图 */
export function useAiPhaseClock() {
  return { waitElapsed, waitBanner, waitText }
}
