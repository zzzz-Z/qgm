<script setup lang="ts">
// [pipeline-wire-v1] 闭环 pipeline 数据的最后一公里：
//   WHY 服务端 run.ts 已写 state.json.pipeline 并由 /__ai/tasks 暴露，
//       但 PipelineGraph.vue 全仓无 import —— 数据被生产但无人消费（流程方向断点）。
//   本组件自取数据、渲染链路图，作为 SidePane 顶部的独立状态条。
import PipelineGraph from './PipelineGraph.vue'

let poller: ReturnType<typeof setInterval> | null = null
// [pipeline-poll-visible-v1] 1.5s 无条件轮询在后台标签页浪费 CPU；仅当前台可见时轮询。
// [WHY] 与 AiWindowList 同类优化；visibilitychange 切回前台时立即补一次。
let _pollVisible = typeof document !== 'undefined' ? document.visibilityState === 'visible' : true

const pipeline = ref<Record<string, { status?: string }> | null>(null)
const round = ref(0)
const visible = ref(true)

onMounted(() => {
  if (_pollVisible) void poll()
  poller = setInterval(() => { if (_pollVisible) void poll() }, 1500)
})
onBeforeUnmount(() => {
  if (poller) { clearInterval(poller); poller = null }
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
})

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)

async function poll() {
  try {
    const r = await fetch('/__ai/tasks', { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!r.ok) return
    const j = await r.json()
    pipeline.value = (j && j.pipeline) || null
    round.value = Number(j && j.round) || 0
  } catch { /* 服务端不可达时静默，下轮再试 */ }
}
function onVis() {
  _pollVisible = document.visibilityState === 'visible'
  if (_pollVisible) void poll()
}
</script>

<template>
  <div v-if="visible && pipeline" class="pipeline-strip">
    <PipelineGraph :pipeline="pipeline" :round="round" />
    <button class="pipeline-close" aria-label="关闭" @click="visible = false">
      ×
    </button>
  </div>
</template>

<style scoped>
.pipeline-strip {
  position: relative;
  border-bottom: 1px solid var(--border, #334155);
  background: var(--surface, #1e1e1e);
}
.pipeline-close {
  position: absolute;
  right: 6px;
  top: 6px;
  width: 18px;
  height: 18px;
  border: 0;
  background: transparent;
  color: var(--text-3, #94a3b8);
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
  padding: 0;
}
.pipeline-close:hover {
  color: var(--text, #e2e8f0);
}
</style>
