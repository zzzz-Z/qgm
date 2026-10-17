<script setup lang="ts">
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/vue'

defineOptions({ name: 'TooltipHost' })

interface VirtualElement {
  getBoundingClientRect: () => {
    x: number
    y: number
    top: number
    right: number
    bottom: number
    left: number
    width: number
    height: number
  }
  contextElement?: Element
}

const { state } = useTooltip()

/**
 * 虚拟参考元素：位置跟随鼠标光标（0×0 矩形）。
 * getBoundingClientRect 每次调用都读取最新光标坐标，
 * 配合 update() 在 mousemove 时重新定位。
 */
const referenceRef = ref<VirtualElement>({
  getBoundingClientRect() {
    const cursorX = state.value.x
    const cursorY = state.value.y
    return {
      x: cursorX,
      y: cursorY,
      top: cursorY,
      left: cursorX,
      right: cursorX,
      bottom: cursorY,
      width: 0,
      height: 0,
    }
  },
})

/** 引用 */
const floatingRef = ref<HTMLElement | null>(null)

const { floatingStyles, update } = useFloating(referenceRef, floatingRef, {
  // 光标右下方弹出，贴近原 translate(12px, 14px) 的视觉效果
  placement: 'bottom-start',
  strategy: 'fixed',
  // offset: 距光标 12px；flip: 下方空间不足时翻到上方；shift: 水平触边时自动内移
  middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 })],
  // 滚动 / 窗口尺寸变化时自动重算
  whileElementsMounted: autoUpdate,
})

// 光标移动或显隐切换时，手动触发重新定位
watch(
  () => [state.value.x, state.value.y, state.value.visible] as const,
  () => update(),
)
</script>

<template>
  <Teleport to="body">
    <Transition name="tt-fade">
      <div
        v-if="state.visible"
        ref="floatingRef"
        class="tt-host"
        :style="floatingStyles"
        role="tooltip"
      >
        {{ state.text }}
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tt-host {
  z-index: var(--z-toast);
  max-width: 360px;
  padding: 6px 10px;
  background: rgb(15 23 42 / 96%);
  color: #f8fafc;
  border-radius: var(--radius-6);
  font:
    12px/1.5 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  box-shadow: 0 8px 24px rgb(15 30 60 / 28%);
  pointer-events: none;
  word-break: break-word;
  white-space: normal;
}
html[data-theme='dark'] .tt-host {
  background: rgb(36 45 58 / 96%);
  color: #e8eef5;
}
</style>
