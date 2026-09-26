<script setup lang="ts">
defineOptions({ name: 'KeyboardHelp' })

/** 派发 */
const emit = defineEmits<{ close: [] }>()

interface Shortcut { keys: string, label: string, group: string }

/** 快捷键集合 */
const shortcuts: Shortcut[] = [
  { group: '通用', keys: 'Shift + ?', label: '打开/关闭本帮助面板' },
  { group: '通用', keys: 'Esc', label: '关闭弹窗；循环中软暂停' },
  { group: '通用', keys: 'Ctrl/Cmd + Shift + A', label: '打开 AI Runner 面板' },
  { group: '循环', keys: 'Ctrl/Cmd + Esc', label: '急停当前执行' },
  { group: '循环', keys: 'Esc', label: '软暂停（当前轮完成即停）' },
  { group: '脚本', keys: 'Ctrl/Cmd + Enter', label: '运行编辑器内容' },
  { group: '脚本', keys: 'Alt + R', label: '打开规则/追加规则' },
  { group: '脚本', keys: 'Ctrl/Cmd + Enter', label: '提示词面板内复制' },
]

/** 按分组聚合后的列表 */
const grouped = shortcuts.reduce<Record<string, Shortcut[]>>((acc, s) => {
  ;(acc[s.group] ||= []).push(s)
  return acc
}, {})
</script>

<template>
  <Teleport to="body">
    <div class="kb-overlay" @click.self="emit('close')">
      <div class="kb-panel" role="dialog" aria-modal="true" aria-label="快捷键一览">
        <div class="kb-head">
          <span class="kb-title">⌨ 快捷键一览</span>
          <button
            class="kb-close"
            type="button"
            aria-label="关闭快捷键面板"
            @click="emit('close')"
          >
            ×
          </button>
        </div>
        <div class="kb-body">
          <section v-for="(list, group) in grouped" :key="group" class="kb-section">
            <h3 class="kb-group">
              {{ group }}
            </h3>
            <ul class="kb-list">
              <li v-for="s in list" :key="s.keys + s.label" class="kb-item">
                <kbd class="kb-key">{{ s.keys }}</kbd>
                <span class="kb-label">{{ s.label }}</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.kb-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(15 30 60 / 55%);
  animation: kb-in 0.15s ease-out;
}
@keyframes kb-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.kb-panel {
  width: min(560px, 90vw);
  max-height: min(620px, 85vh);
  display: flex;
  flex-direction: column;
  background: var(--surface-1, #1e1e2e);
  color: var(--text, #e0e0e0);
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 45%);
}
.kb-head {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}
.kb-title {
  font-weight: 600;
}
.kb-close {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font-size: 18px;
  padding: 0 4px;
}
.kb-close:focus-visible {
  outline: 2px solid var(--accent, #58a6ff);
  outline-offset: 1px;
}
.kb-body {
  padding: 12px 16px;
  overflow-y: auto;
}
.kb-section {
  margin-bottom: 12px;
}
.kb-group {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.7;
}
.kb-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.kb-item {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 12px;
  padding: 4px 0;
  font-size: 13px;
}
.kb-key {
  display: inline-block;
  padding: 2px 6px;
  background: rgb(255 255 255 / 6%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 4px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  text-align: center;
}
.kb-label {
  opacity: 0.9;
  align-self: center;
}
</style>
