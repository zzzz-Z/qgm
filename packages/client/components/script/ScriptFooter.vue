<template>
  <footer class="editor-foot">
    <span v-if="persistWarning" v-tooltip="persistWarning" class="persist-warning">⚠ 会话存储已满</span>
    <div class="foot-spacer" />

    <span v-if="result?.error" v-tooltip="result.error" class="req-err-badge">
      ⛔ 请求失败
    </span>
    <span v-if="result?.dryRunFailed" v-tooltip="result.dryRunReason || '预检未通过，磁盘零改动'" class="dry-badge">
      ⚠ 预检失败 · 未改动文件（本想改 {{ result.dryRunChangeCount ?? 0 }}）
    </span>
    <span v-if="result?.git?.after?.commit" v-tooltip="`已提交：${result.git.after.commit}`" class="git-after">
      ⎇ {{ result.git.after.commit }}
    </span>
  </footer>
</template>

<script setup lang="ts">
import type { RunResponse } from '../../types'

defineProps<{
  persistWarning: string | null | undefined
  result: RunResponse | null | undefined
}>()
</script>

<style scoped lang="scss">
.foot-spacer {
  flex: 1;
}

.git-after {
  font-family: var(--mono, monospace);
  font-size: var(--font-11);
  color: var(--success, #059669);
  margin-right: 8px;
  cursor: help;
}

.persist-warning {
  font-size: var(--font-11);
  color: var(--danger);
  margin-right: 8px;
  cursor: help;
}

.req-err-badge {
  padding: 2px 8px;
  border-radius: var(--radius-10);
  font-size: var(--font-11);
  font-weight: 600;
  color: #fff;
  background: var(--danger, #ef4444);
  margin-right: 8px;
  cursor: help;
}

.editor .editor-foot {
  padding: 3px 10px !important;
}

.editor-foot {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 6px 14px !important;
  background: var(--surface) !important;
  border-top: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
  min-height: 28px !important;
  font-size: 11px !important;
}

.editor-foot .foot-spacer {
  flex: 1 !important;
  min-width: 8px !important;
}

.editor-foot .persist-warning,
.editor-foot .req-err-badge,
.editor-foot .dry-badge,
.editor-foot .git-after {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 2px 8px !important;
  border-radius: var(--radius-4) !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  cursor: help !important;
  white-space: nowrap !important;
  line-height: 1.4 !important;
}

.editor-foot .persist-warning {
  color: var(--warning) !important;
  background: var(--warning-bg) !important;
}

.editor-foot .req-err-badge {
  color: var(--danger) !important;
  background: var(--danger-bg) !important;
  font-weight: 600 !important;
}

.editor-foot .dry-badge {
  color: var(--warning) !important;
  background: var(--warning-bg) !important;
}

.editor-foot .git-after {
  color: var(--success) !important;
  background: var(--success-bg) !important;
  font-weight: 600 !important;
}
</style>
