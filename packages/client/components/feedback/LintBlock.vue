<script setup lang="ts">
import { computed } from 'vue'
import type { LintResult } from '../../types'

defineOptions({ name: 'LintBlock' })

/** 组件接收的 props 定义 */
const props = defineProps<{
  lint: LintResult
}>()

/** 是否含 */
const hasDetails = computed(() => !!(props.lint.stdout || props.lint.stderr))
/** 文本 */
const detailText = computed(() => props.lint.stdout || props.lint.stderr || '')
/** 摘要 */
const summary = computed(() => {
  if (props.lint.ok) {
    return props.lint.stdout?.includes('warning')
      ? `已格式化 ${props.lint.files} 个文件（有 warning）`
      : `已格式化 ${props.lint.files} 个文件`
  }
  return `格式化失败 · ${props.lint.files} 个文件`
})
</script>

<template>
  <div class="lint-section">
    <div class="lint-label">
      <span class="lint-mark" :class="lint.ok ? 'ok' : 'err'">{{ lint.ok ? '✓' : '✗' }}</span>
      <span class="label-text" :class="{ err: !lint.ok }">eslint</span>
      <span class="lint-summary">{{ summary }}</span>
    </div>
    <pre v-if="hasDetails" class="lint-content" :class="{ err: !lint.ok }">{{ detailText }}</pre>
  </div>
</template>

<style scoped>
.lint-section + .lint-section {
  border-top: 1px solid #21262d;
  margin-top: 8px;
  padding-top: 12px;
}
.lint-section {
  border-top: 1px solid #21262d;
  margin-top: 8px;
  padding-top: 12px;
}

.lint-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 8px;
  font: 11px/1 var(--mono);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.lint-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  font-size: 9px;
  font-weight: 700;
}
.lint-mark.ok {
  color: #3fb950;
  background: rgb(46 160 67 / 18%);
}
.lint-mark.err {
  color: #f85149;
  background: rgb(248 81 73 / 18%);
}

.label-text {
  color: #7d8590;
}
.label-text.err {
  color: #f85149;
}

.lint-summary {
  margin-left: auto;
  text-transform: none;
  letter-spacing: 0;
  color: #7d8590;
  font-size: 11px;
}

.lint-content {
  margin: 0;
  padding: 0 16px;
  font: 12px/1.65 var(--mono);
  white-space: pre-wrap;
  word-break: break-word;
  color: #c9d1d9;
}
.lint-content.err {
  color: #ffa198;
}
</style>
