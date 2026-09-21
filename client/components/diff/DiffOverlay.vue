<script setup lang="ts">
import DiffViewer from './DiffViewer.vue'

defineOptions({ name: 'DiffOverlay' })

const props = defineProps<{
  fileName: string
  before: string
  after: string
  changeType: 'added' | 'modified' | 'deleted'
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div
    class="diff-overlay"
    @click.self="emit('close')"
  >
    <div class="diff-overlay-panel">
      <button v-tooltip="'关闭 diff 预览（Esc）'" aria-label="关闭 diff 预览（Esc）" class="diff-overlay-close" @click="emit('close')">
        ×
      </button>
      <DiffViewer
        :file-name="props.fileName" :before="props.before" :after="props.after"
        :change-type="props.changeType"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.diff-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgb(15 30 60 / 45%);
  animation: overlay-in 0.15s ease-out;
}

.diff-overlay-panel {
  position: relative;
  width: min(1100px, 100%);
  max-height: min(720px, 100%);
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgb(15 30 60 / 26%);
  border-radius: var(--radius-10);
  overflow: hidden;
}

.diff-overlay-panel :deep(.diff-viewer) {
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-10);
  background: var(--surface);
}

.diff-overlay-close {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 2;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: 0.12s;
}

.diff-overlay-close:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-bg);
}
</style>
