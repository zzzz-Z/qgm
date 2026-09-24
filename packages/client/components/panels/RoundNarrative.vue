<script setup lang="ts">
// [tier1c-4] 叙事性：最近动作时间线（做了什么 + 为什么/结果），最多 6 条
import { computed } from 'vue'

interface Decision { t?: string, c?: string, r?: string, rej?: string[] }

interface Props { decisions?: Decision[] }

/** 组件接收的 props 定义 */
const props = withDefaults(defineProps<Props>(), { decisions: () => [] })

/** 列表 */
const list = computed(() => {
  const arr = Array.isArray(props.decisions) ? props.decisions : []
  return arr.slice(-6).reverse()
})

/**
 * 执行 fmt Time
 * @param iso - iso
 */
function fmtTime(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  } catch { return '' }
}
</script>

<template>
  <div v-if="list.length" class="rn">
    <div class="rn-head">
      最近动作
    </div>
    <ol class="rn-list">
      <li v-for="(d, i) in list" :key="i" class="rn-item">
        <span class="rn-time">{{ fmtTime(d.t) }}</span>
        <span class="rn-dot" />
        <div class="rn-body">
          <div class="rn-title">
            {{ d.c || '（无摘要）' }}
          </div>
          <div v-if="d.r" class="rn-reason">
            {{ d.r }}
          </div>
          <div v-if="d.rej && d.rej.length" class="rn-rej">
            拒：{{ d.rej.join(' · ') }}
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.rn {
  padding: 8px 12px;
  font-size: 11px;
  font-family: var(--mono, monospace);
}
.rn-head {
  color: var(--text-3, #94a3b8);
  font-weight: 600;
  margin-bottom: 6px;
}
.rn-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rn-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 0;
  position: relative;
}
.rn-time {
  flex-shrink: 0;
  color: var(--text-3, #94a3b8);
  font-size: 10px;
  width: 38px;
}
.rn-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary, #3b82f6);
  margin-top: 5px;
}
.rn-body {
  flex: 1;
  min-width: 0;
}
.rn-title {
  color: var(--text-2, #cbd5e1);
  line-height: 1.4;
  word-break: break-word;
}
.rn-reason {
  color: var(--text-3, #94a3b8);
  font-size: 10px;
  margin-top: 1px;
}
.rn-rej {
  color: #eab308;
  font-size: 10px;
  margin-top: 1px;
}
</style>
