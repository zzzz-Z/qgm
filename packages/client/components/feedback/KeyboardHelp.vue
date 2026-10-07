<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

interface KbItem { keys: readonly string[], desc: string }
interface KbSection { title: string, items: readonly KbItem[] }

const emit = defineEmits<{ close: [] }>()

defineOptions({ name: 'KeyboardHelp' })

const SECTIONS: readonly KbSection[] = [
  {
    title: '循环控制',
    items: [
      { keys: ['Esc'], desc: '暂停当前循环（保留状态，可恢复）' },
      { keys: ['Ctrl', 'Esc'], desc: '停止循环并回滚本轮改动' },
      { keys: ['Alt', 'R'], desc: '智能发送：立即执行编辑器内容' },
    ],
  },
  {
    title: '界面',
    items: [
      { keys: ['Shift', '?'], desc: '打开 / 关闭本快捷键帮助' },
      { keys: ['Esc'], desc: '关闭当前浮层（Diff 预览 / 文件预览等）' },
      { keys: ['Ctrl', 'Enter'], desc: '工作日志提交框内：提交变更' },
      { keys: ['Enter'], desc: '文件树 / 卡片：展开或预览（视焦点而定）' },
    ],
  },
]

const boxRef = ref<HTMLElement | null>(null)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => boxRef.value?.focus?.())
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <div class="kb-mask" role="dialog" aria-modal="true" aria-label="键盘快捷键帮助" @click.self="emit('close')">
    <div ref="boxRef" class="kb-box" tabindex="-1">
      <header class="kb-head">
        <h2>键盘快捷键</h2>
        <button class="kb-close" aria-label="关闭快捷键帮助" @click="emit('close')">
          ×
        </button>
      </header>
      <div class="kb-body">
        <section v-for="s in SECTIONS" :key="s.title" class="kb-section">
          <h3>{{ s.title }}</h3>
          <div v-for="it in s.items" :key="it.desc" class="kb-row">
            <span class="kb-keys">
              <kbd v-for="k in it.keys" :key="k">{{ k }}</kbd>
            </span>
            <span class="kb-desc">{{ it.desc }}</span>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* [kb-help-v1] 快捷键帮助浮层：4px 网格 + DESIGN.md token，卡片无阴影仅边框 */
.kb-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 50%);
}
.kb-box {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-12);
  box-shadow: var(--shadow-lg);
  outline: none;
}
.kb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.kb-head h2 {
  margin: 0;
  font-size: var(--font-14);
  font-weight: 600;
  color: var(--text);
}
.kb-close {
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-6);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}
.kb-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.kb-body {
  padding: 8px 16px 16px;
}
.kb-section {
  margin-top: 12px;
}
.kb-section h3 {
  margin: 0 0 8px;
  font-size: var(--font-11);
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-3);
}
.kb-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}
.kb-keys {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  min-width: 120px;
}
.kb-keys kbd {
  font-family: var(--mono);
  font-size: var(--font-11);
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-4);
  padding: 2px 6px;
  min-width: 20px;
  text-align: center;
}
.kb-desc {
  font-size: var(--font-12);
  color: var(--text-2);
}
</style>
