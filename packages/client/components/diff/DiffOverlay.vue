<script setup lang="ts">
import DiffViewer from './DiffViewer.vue'

/** 组件接收的 props 定义 */
const props = defineProps<{
  fileName: string
  before: string
  after: string
  changeType: 'added' | 'modified' | 'deleted'
}>()
/** 派发 */
const emit = defineEmits<{ close: [] }>()

defineOptions({ name: 'DiffOverlay' })

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// [diff-overlay-esc-v1] 报告 §2.22：aria-label 承诺 Esc 关窗，但原实现无任何 keydown 处理
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <div
    class="diff-overlay"
    @click.self="emit('close')"
  >
    <div class="diff-overlay-panel">
      <!-- [close-btn-no-tooltip] tooltip 是 fixed 浮层，紧贴光标弹出会盖住 header 的 badge/stats；aria-label 保留无障碍语义 -->
      <button aria-label="关闭 diff 预览（Esc）" class="diff-overlay-close" @click="emit('close')">
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

  /* [close-overlay-badge-fix] 关闭按钮绝对定位在右上，会压住 header 的 badge/stats。
     通过 CSS 变量向 DiffViewer 内部穿透 header 右侧内边距（作用域继承，不受 scoped 限制）
     [WHY] 早先用 :deep(.diff-header)+!important 实测未生效（选择器特异性+!important 本应胜出），
     疑似 scoped :deep 与打包器组合存在兼容问题；变量穿透不依赖选择器机制，最稳
     [CONSTRAINT] 40px = 按钮宽 24 + right 8 + 间隙 8；改按钮尺寸需同步此值
     [CHANGE-IMPACT] 仅覆盖本 overlay 内嵌的 DiffViewer；独立使用 DiffViewer 时变量未声明，
     走 fallback 12px 保持原视觉 */
  --diff-header-pr: 40px;
}

.diff-overlay-panel :deep(.diff-viewer) {
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-10);
  background: var(--surface);
}

/* [close-overlay-badge-fix] .diff-overlay-close 是 top/right 绝对定位，脱离 flex 流，
   不会被 .diff-header 的 padding 推走；必须给 .diff-header 预留右侧空间才能避免压住 badge/stats
   [CONSTRAINT] 40px = 按钮宽 24px + 右侧 offset 8px + 间隙 8px；改按钮尺寸需同步此值
   [WHY-important] Vue scoped 编译后本规则特异性为 (0,2,0)，与 DiffViewer 内 .diff-header[data-v-B]
     的 (0,2,0) 相同；CSS 注射顺序由打包器决定，不加 !important 会被 padding: 8px 12px 覆盖
   [CHANGE-IMPACT] 仅作用于 overlay 内嵌的 DiffViewer；DiffViewer 独立使用（无 overlay）时不会多留空白 */
.diff-overlay-panel :deep(.diff-header) {
  padding-right: 40px !important;
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
