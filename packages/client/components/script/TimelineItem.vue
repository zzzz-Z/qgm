<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdown } from '../../composables/useMarkdown.js'

interface Item {
  kind?: string
  role?: string
  ts?: number
  payload?: Record<string, unknown>
}

/** 组件接收的 props 定义 */
const props = defineProps<{ item: Item }>()

/** 是否展开 */
const expanded = ref(false)

/** 节点角色（辅助无障碍识别） */
const role = computed(() => {
  const r = props.item && props.item.role
  return (typeof r === 'string' && r) ? r : 'sys'
})
/** 是否为 */
const isUser = computed(() => role.value === 'user')
/** 是否为AI */
const isAi = computed(() => role.value === 'ai')
/** 条目上的徽标文本 */
const badge = computed(() => {
  const k = String((props.item && props.item.kind) || '')
  if (role.value === 'user') return '你'
  if (k.indexOf('ai:') === 0) return 'AI'
  if (k.indexOf('run:') === 0) return 'RUN'
  if (k.indexOf('loop:') === 0) return 'LOOP'
  if (role.value === 'step') return 'STEP'
  return 'SYS'
})
/** 条目标题 */
const title = computed(() => {
  const p = (props.item && props.item.payload) || {}
  const cand = [p.desc, p.text, p.question, p.prompt, props.item && props.item.kind]
  let i = 0
  while (i < cand.length) {
    const v = cand[i]
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim()
      return s.length > 240 ? `${s.slice(0, 240)}…` : s
    }
    i = i + 1
  }
  return '(空)'
})
/** 文本 */
const bodyText = computed(() => {
  const p = (props.item && props.item.payload) || {}
  const cand = [p.text, p.prompt, p.stdout, p.stderr, p.question]
  let i = 0
  while (i < cand.length) {
    const v = cand[i]
    if (typeof v === 'string' && v.trim()) return v
    i = i + 1
  }
  return ''
})
/** 是否含 */
const hasBody = computed(() => bodyText.value.trim().length > 0)
/** 已渲染的正文 HTML */
const bodyHtml = computed(() => renderMarkdown(bodyText.value))
/** 标签 */
const tsLabel = computed(() => {
  const t = props.item && props.item.ts
  if (!t) return ''
  try {
    const d = new Date(t)
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  } catch { return '' }
})

/**
 * 切换
 */
function toggle(): void {
  if (!hasBody.value) return
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="tl-row" :class="{ 'is-user': isUser, 'is-ai': isAi }">
    <div class="tl-bubble">
      <div class="tl-head" @click="toggle">
        <span class="tl-badge">{{ badge }}</span>
        <span class="tl-title">{{ title }}</span>
        <span v-if="tsLabel" class="tl-time">{{ tsLabel }}</span>
        <span v-if="hasBody" class="tl-fold">{{ expanded ? '▾' : '▸' }}</span>
      </div>
      <div v-if="expanded && hasBody" class="tl-body" v-html="bodyHtml" />
    </div>
  </div>
</template>

<style scoped>
/* dsh 风格气泡：AI 左对齐，user 右对齐 */
.tl-row {
  display: flex;
  width: 100%;
  padding: 4px 8px;
  box-sizing: border-box;
}
.tl-row.is-user {
  justify-content: flex-end;
}
.tl-row.is-ai,
.tl-row:not(.is-user) {
  justify-content: flex-start;
}

.tl-bubble {
  max-width: min(720px, 82%);
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  border-radius: 22px;
  background: var(--dsw-specific-input-major, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgba(15, 17, 21, 0.06));
  overflow: hidden;
}
.tl-row.is-user .tl-bubble {
  background: var(--dsw-specific-bubble, rgb(237, 243, 254));
  border-color: transparent;
}

.tl-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  user-select: none;
}

.tl-badge {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  letter-spacing: 0.02em;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-secondary, inherit);
}
.tl-row.is-ai .tl-badge {
  background: rgba(65, 118, 230, 0.12);
  color: var(--dsw-alias-state-business-primary, #4176e6);
}
.tl-row.is-user .tl-badge {
  background: rgba(65, 118, 230, 0.16);
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

.tl-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  line-height: 1.55;
  color: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tl-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--dsw-alias-label-caption, rgba(127, 127, 127, 0.7));
}

.tl-fold {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.7));
  width: 12px;
  text-align: center;
}

.tl-body {
  padding: 4px 14px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
  font-size: 14px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary, inherit);
  white-space: pre-wrap;
  word-break: break-word;
}
.tl-body :deep(.md-pre) {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  overflow-x: auto;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre;
}
.tl-body :deep(.md-pre) code {
  font-family: inherit;
  background: none;
  padding: 0;
  color: inherit;
}
.tl-body :deep(.md-inline) {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.92em;
}
.tl-body :deep(strong) {
  font-weight: 600;
}
.tl-body :deep(p) {
  margin: 4px 0;
}
</style>
