<script setup lang="ts">
// @desc @ask 弹窗 UI：问题正文（Markdown）+ 快捷选项 + 自由文本输入
// @why 承接 SYSTEM.md §1.5 交互提问通道；选项点击即提交，无选项时仅暴露文本输入
// @change-impact 依赖 useAsk 单例（状态源）与 renderMarkdown（正文渲染）；样式 tokens 复用全局变量

import { computed, nextTick, ref, watch } from 'vue'
import { useAsk } from '../../composables/ui/useAsk'
import { renderMarkdown } from '../../composables/useMarkdown'

const { askState, resolveAsk } = useAsk()
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

const questionHtml = computed(() => renderMarkdown(askState.value?.question || ''))
const hasOptions = computed(() => (askState.value?.options.length || 0) > 0)
const canConfirm = computed(() => draft.value.trim().length > 0)

// [CONSTRAINT] 每次打开重置 draft 并聚焦输入框（无选项场景需默认可打字）
watch(() => askState.value, async (v) => {
  if (v) {
    draft.value = ''
    await nextTick()
    inputRef.value?.focus()
  }
})

/** 快捷选项点击 → 以按钮文本作答并关闭 */
function chooseOption(label: string): void { resolveAsk(label) }

/** 提交自由文本；[CONSTRAINT] 空白文本视为无效，不提交 */
function confirm(): void {
  const t = draft.value.trim()
  if (!t) return
  resolveAsk(t)
}

/** 取消/遮罩点击/Esc → resolve(null) */
function cancel(): void { resolveAsk(null) }

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') cancel()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="askState"
        class="ask-mask"
        tabindex="-1"
        @click.self="cancel"
        @keydown="onKey"
      >
        <div class="ask-card">
          <div class="ask-head">
            <span class="ask-badge">ASK</span>
            <span class="ask-title">AI 需要你的回答</span>
          </div>
          <div v-if="questionHtml" class="ask-body" v-html="questionHtml" />
          <div v-if="hasOptions" class="ask-options">
            <button
              v-for="o in askState.options" :key="o.id"
              class="ask-opt" type="button"
              @click="chooseOption(o.label)"
            >
              {{ o.label }}
            </button>
          </div>
          <div class="ask-input-row">
            <input
              ref="inputRef"
              v-model="draft"
              class="ask-input"
              :placeholder="hasOptions ? '或输入自定义回答…' : '输入你的回答…'"
              @keydown.enter.prevent="confirm"
            >
          </div>
          <div class="ask-actions">
            <button class="ask-btn ghost" type="button" @click="cancel">
              取消
            </button>
            <button
              class="ask-btn primary" type="button"
              :disabled="!canConfirm"
              @click="confirm"
            >
              提交回答
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ask-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background: rgb(15 30 60 / 32%);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ask-card {
  min-width: 360px;
  max-width: 560px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius-12);
  box-shadow: 0 20px 60px rgb(15 30 60 / 24%);
  overflow: hidden;
  animation: ask-in 0.18s ease-out;
}
@keyframes ask-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.ask-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px 8px;
  border-bottom: 1px solid var(--border, #e5e9f0);
}
.ask-badge {
  padding: 2px 6px;
  font: 700 10px/1 var(--mono, monospace);
  color: #fff;
  background: var(--primary, #2563eb);
  border-radius: var(--radius-4, 4px);
  letter-spacing: 0.5px;
}
.ask-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #1f2d3d);
}
.ask-body {
  flex: 1;
  min-height: 0;
  padding: 12px 20px;
  overflow-y: auto;
  font: 13px/1.65 var(--mono, monospace);
  color: var(--text, #1f2d3d);
}
.ask-body :deep(p) {
  margin: 0 0 8px;
}
.ask-body :deep(p:last-child) {
  margin-bottom: 0;
}
.ask-body :deep(h1),
.ask-body :deep(h2),
.ask-body :deep(h3) {
  margin: 8px 0 6px;
  font-size: 14px;
  font-weight: 700;
}
.ask-body :deep(ul),
.ask-body :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 20px;
}
.ask-body :deep(.md-pre) {
  margin: 6px 0;
  padding: 8px 10px;
  background: var(--surface-2, #f3f5f9);
  border: 1px solid var(--border, #e5e9f0);
  border-radius: var(--radius-4, 4px);
  overflow-x: auto;
  white-space: pre;
}
.ask-body :deep(.md-inline) {
  padding: 1px 5px;
  background: var(--surface-2, #f3f5f9);
  border-radius: 3px;
}
.ask-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 20px 12px;
}
.ask-opt {
  padding: 8px 12px;
  text-align: left;
  background: var(--surface-2, #f3f5f9);
  border: 1px solid var(--border, #e5e9f0);
  border-radius: var(--radius-8);
  color: var(--text, #1f2d3d);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ask-opt:hover {
  border-color: var(--primary, #2563eb);
  color: var(--primary, #2563eb);
}
.ask-input-row {
  padding: 0 20px 12px;
}
.ask-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--border-2, #d0d7de);
  border-radius: var(--radius-8);
  color: var(--text, #1f2d3d);
  /* [ask-input-font-fix] 原 `font: 13px/1.4 inherit` 是非法简写：
     CSS-wide 关键字 inherit 不能与其他值混用，浏览器整条丢弃该声明，
     input 回退到 UA 默认字体 → 字号/行盒与 .ask-opt / .ask-body 不一致，视觉错位。
     改为显式声明三属性并让 family 继承面板字体。 */
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  outline: none;
}
.ask-input:focus {
  border-color: var(--primary, #2563eb);
}
.ask-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 20px 20px;
}
.ask-btn {
  padding: 7px 16px;
  border-radius: var(--radius-8);
  border: 1px solid var(--border-2, #d0d7de);
  background: var(--surface);
  color: var(--text, #1f2d3d);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ask-btn.ghost:hover {
  background: var(--surface-2, #f3f5f9);
}
.ask-btn.primary {
  background: var(--primary);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 6px rgb(37 99 235 / 28%);
}
.ask-btn.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgb(37 99 235 / 32%);
}
.ask-btn.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}
</style>
