<script setup lang="ts">
// PLAN 5.2 链路图（五段聚合）
import { computed } from 'vue'

type SegStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'manual'
interface Props {
  /** 内部 11 段状态 */
  pipeline?: Record<string, { status?: string } | undefined>
  round?: number
  elapsedMs?: number
}

/** 组件接收的 props 定义 */
const props = withDefaults(defineProps<Props>(), {
  pipeline: () => ({}),
  round: 0,
  elapsedMs: 0,
})
// 五段聚合：内部 11 段 → 用户视角 5 段
/** 流水线阶段名称列表 */
const STAGES: Array<{ key: string, label: string, segs: string[] }> = [
  { key: 'ask', label: '提问', segs: ['ASK_LOCAL', 'ASK_RELAY', 'ASK_INJECT'] },
  { key: 'gen', label: '生成', segs: ['AI_GENERATE', 'AI_COMPLETE'] },
  { key: 'ext', label: '提取', segs: ['EXTRACT', 'SCRIPT_VALIDATE'] },
  { key: 'exe', label: '执行', segs: ['EXECUTE', 'COLLECT'] },
  { key: 'back', label: '回传', segs: ['RESULT_RELAY', 'RESULT_INJECT'] },
]
/** 图标 */
const ICON: Record<SegStatus, string> = {
  pending: '·',
  running: '●',
  ok: '✓',
  failed: '✗',
  skipped: '!',
  manual: '⚠',
}

/** 流水线各阶段状态列表 */
const stages = computed(() => STAGES.map((st) => {
  const ss = st.segs.map(k => norm(props.pipeline?.[k]?.status))
  return { ...st, status: agg(ss) }
}))
/** 当前阶段索引 */
const currentIdx = computed(() => stages.value.findIndex(s => s.status === 'running'))
/** 是否含 */
const hasAny = computed(() => stages.value.some(s => s.status !== 'pending'))
/** 格式化已用时长 */
const fmtElapsed = computed(() => {
  const ms = props.elapsedMs
  if (!ms) return ''
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`
})

/**
 * 聚合多个子段状态为本阶段单一状态
 * [WHY] 阶段由多个 seg 组成，UI 只展示一个状态；优先级 failed > running > ok > pending
 * [CONSTRAINT] 任一子段 failed 即整段 failed（错误优先）；全 ok/skipped 才 ok
 * [CHANGE-IMPACT] 结果被 currentIdx 用于高亮当前阶段；改优先级会改变高亮位置
 * @param states 子段状态列表；空数组返回 pending
 */
function agg(states: Array<SegStatus>): SegStatus {
  if (states.some(s => s === 'failed')) return 'failed'
  if (states.some(s => s === 'running')) return 'running'
  if (states.every(s => s === 'ok' || s === 'skipped')) return 'ok'
  if (states.some(s => s === 'ok')) return 'running'
  return 'pending'
}
/**
 * 把服务端下发的原始状态字符串规范化到 SegStatus 枚举
 * [CONSTRAINT] 只接受 ok / running / failed 三个字面量；其余（含 undefined）一律回落 pending
 * [WHY] 服务端可能新增状态值，此处做白名单过滤避免 UI 展示异常值
 * @param raw 原始状态字符串；undefined 视为 pending
 */
function norm(raw?: string): SegStatus {
  const s = String(raw || 'pending')
  if (s === 'ok' || s === 'running' || s === 'failed') return s
  return 'pending'
}
</script>

<template>
  <div v-if="!hasAny" class="pg-empty">
    <span>暂无链路数据</span>
  </div>
  <div v-else class="pg">
    <div class="pg-head">
      <span v-if="round">第 {{ round }} 轮</span>
      <span v-if="currentIdx >= 0" class="pg-cur">当前第 {{ currentIdx + 1 }} 段</span>
      <span v-if="fmtElapsed" class="pg-el">{{ fmtElapsed }}</span>
    </div>
    <div class="pg-row">
      <template v-for="(s, i) in stages" :key="s.key">
        <div class="pg-node" :class="[`pg-${s.status}`]" :title="s.label">
          <span class="pg-icon">{{ ICON[s.status] }}</span>
          <span class="pg-label">{{ s.label }}</span>
        </div>
        <span v-if="i < stages.length - 1" class="pg-link" :class="{ 'pg-link-ok': s.status === 'ok' }" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.pg-empty {
  padding: 12px;
  text-align: center;
  color: var(--text-3, #94a3b8);
  font-size: 12px;
}
.pg {
  padding: 10px 12px;
  font-family: var(--mono, monospace);
}
.pg-head {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-3, #94a3b8);
  margin-bottom: 8px;
}
.pg-cur {
  color: #3b82f6;
}
.pg-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pg-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--surface-2, #252525);
  min-width: 44px;
  font-size: 10px;
}
.pg-icon {
  font-size: 14px;
  line-height: 1;
}
.pg-label {
  color: var(--text-2, #cbd5e1);
}
.pg-pending .pg-icon {
  color: #6b7280;
}
.pg-running .pg-icon {
  color: #3b82f6;
  animation: pg-pulse 1.2s ease-in-out infinite;
}
.pg-ok .pg-icon {
  color: #22c55e;
}
.pg-failed .pg-icon {
  color: #ef4444;
}
.pg-link {
  flex: 1;
  height: 1px;
  background: var(--border, #334155);
  min-width: 8px;
}
.pg-link-ok {
  background: #22c55e;
}
/* PLAN 5.4 窄屏（<768px）链路图纵向 */
/* PLAN 5.4 中屏（768-1200）链路图横向滚动 */
@media (min-width: 769px) and (max-width: 1200px) {
  .pg-row {
    overflow-x: auto;
    overflow-y: hidden;
    flex-wrap: nowrap;
    padding-bottom: 4px;
  }
  .pg-node {
    flex-shrink: 0;
  }
  .pg-link {
    flex-shrink: 0;
  }
}

@media (max-width: 768px) {
  .pg-row {
    flex-direction: column;
    align-items: stretch;
  }
  .pg-link {
    width: 1px;
    height: 8px;
    min-width: 0;
    margin: 0 auto;
  }
  .pg-node {
    flex-direction: row;
    justify-content: center;
    min-width: 0;
  }
}

@keyframes pg-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
