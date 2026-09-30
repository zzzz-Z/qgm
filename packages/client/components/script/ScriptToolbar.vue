<template>
  <div class="tpl-bar">
    <!-- [fix-restore-templates] 模板按钮（删 draft-toolbar 时误删） -->
    <button
      v-for="t in templates" :key="t.id" v-tooltip="`模板：${t.label} — ${t.title}`" class="tpl-chip"
      @click="emit('applyTemplate', t.code)"
    >
      {{ t.label }}
    </button>
    <div class="tpl-spacer" />
    <button
      v-tooltip="'清空编辑器与附件'"
      aria-label="清空编辑器与附件" class="ghost-btn"
      :disabled="running || (!script && !attachedFilesCount)" @click="emit('clearAll')"
    >
      <svg
        class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>

    <button
      v-if="running || isLoopActive || autoTakeoverEnabled"
      v-tooltip="loopPaused ? '发送：结束本次循环，回到待发状态' : '暂停：不取 AI 脚本、不接收工作台结果'"
      :aria-label="loopPaused ? '发送脚本' : '暂停循环'"
      class="primary-btn stop head-run"
      :class="{ 'is-waiting': aiWaiting }"
      :aria-busy="aiWaiting"
      @click="emit('pauseAll')"
    >
      <svg
        class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <polygon v-if="loopPaused" points="6 4 20 12 6 20 6 4" />
        <template v-else>
          <line x1="9" y1="4" x2="9" y2="20" />
          <line x1="15" y1="4" x2="15" y2="20" />
        </template>
      </svg>
    </button>
    <button
      v-else
      v-tooltip="'开始：执行当前脚本，随后自动把结果发 AI 并执行下一轮'"
      aria-label="开始循环"
      class="primary-btn takeover head-run"
      :class="{ 'is-waiting': aiWaiting }"
      :aria-busy="aiWaiting"
      data-mark="[run-btn-copy-v1]"
      @click="emit('toggleAutoTakeover')"
    >
      <svg
        class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <polygon points="6 4 20 12 6 20 6 4" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
// [toolbar-props-v2] 去 props 变量绑定：模板直接用解构名，赋值给 props 会触发 unused-imports warning
defineProps<{
  templates: Template[]
  running: boolean
  isLoopActive: boolean
  autoTakeoverEnabled: boolean
  // [loop-paused-toggle-v1] 循环暂停标志：按钮在「暂停 / 恢复」间切换
  loopPaused: boolean
  script: string
  attachedFilesCount: number
  // [ai-wait-btn-v1] 等待 AI 回复中：主按钮显示 spinner，视觉反馈与顶部 banner 呼应
  aiWaiting: boolean
}>()

/** 派发 */
const emit = defineEmits<{
  applyTemplate: [code: string]
  clearAll: []
  pauseAll: []
  toggleAutoTakeover: []
}>()

interface Template { id: string, label: string, title: string, code: string }
</script>

<style scoped lang="scss">
// [chat-action-bar-v1] 工具条移到底部 action-bar 容器内；padding 归零交由父容器控制
.tpl-bar {
  display: flex !important;
  align-items: center !important;
  justify-content: flex-end !important;
  gap: 6px !important;
  padding: 0 !important;
  background: transparent !important;
  border-bottom: 0 !important;
  flex-shrink: 0 !important;
  min-height: auto !important;
  width: 100% !important;
}

.tpl-bar .ghost-btn:hover:not(:disabled),
.tpl-bar .primary-btn:hover:not(:disabled) {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border) !important;
}

.tpl-bar .ghost-btn:disabled,
.tpl-bar .primary-btn:disabled {
  opacity: 0.35 !important;
  cursor: not-allowed !important;
}

.tpl-bar .ghost-btn > svg,
.tpl-bar .ghost-btn > .ico-svg,
.tpl-bar .primary-btn > svg,
.tpl-bar .primary-btn > .ico-svg {
  display: inline-block !important;
  width: 14px !important;
  height: 14px !important;
  flex-shrink: 0 !important;
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 2 !important;
}

.tpl-bar .ghost-btn > span,
.tpl-bar .primary-btn > span {
  display: inline-block !important;
  white-space: nowrap !important;
  line-height: 1 !important;
}

.tpl-bar .ghost-btn.ghost,
.tpl-bar .ghost-btn.head-run {
  color: var(--text-2) !important;
}

.tpl-bar .ghost-btn.ghost:hover:not(:disabled),
.tpl-bar .ghost-btn.head-run:hover:not(:disabled) {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border-2) !important;
}

.tpl-bar .primary-btn.stop,
.tpl-bar .primary-btn.stop.head-run {
  color: var(--primary) !important;
  border-color: var(--primary) !important;
  background: transparent !important;
  font-weight: 600 !important;
}

.tpl-bar .primary-btn.stop:hover:not(:disabled),
.tpl-bar .primary-btn.stop.head-run:hover:not(:disabled) {
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  background: var(--primary-bg) !important;
}

.tpl-bar .tpl-chip {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  height: 26px !important;
  padding: 0 12px !important;
  border-radius: 6px !important;
  border: 1px solid transparent !important;
  background: transparent !important;
  color: var(--text-3) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
  flex-shrink: 0 !important;
}

.tpl-bar .tpl-chip:hover {
  color: var(--text) !important;
  background: var(--surface-2) !important;
}

.tpl-bar .tpl-spacer {
  flex: 1 1 auto !important;
  min-width: 12px !important;
}

.tpl-bar button.ghost-btn,
.tpl-bar button.primary-btn,
.tpl-bar button.tpl-chip,
.tpl-bar button.ghost-btn > svg,
.tpl-bar button.primary-btn > svg,
.tpl-bar button.ghost-btn > span,
.tpl-bar button.primary-btn > span,
.tpl-bar button.ghost-btn,
.tpl-bar button.primary-btn,
.tpl-bar button.ghost-btn > *,
.tpl-bar button.primary-btn > *,
.tpl-bar button.ghost-btn > svg,
.tpl-bar button.primary-btn > svg,
.tpl-bar button.ghost-btn > span,
.tpl-bar button.primary-btn > span {
  accent-color: var(--primary);
  cursor: pointer;
  margin: 0;
}

.tpl-bar {
  padding: 0 !important;
  gap: 6px !important;
}

.primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 0;
  border-radius: var(--radius-6);
  font-size: var(--font-12);
  font-weight: 500;
  cursor: pointer;
  transition: 0.12s;
  color: #fff;
}

.primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.primary-btn .ico {
  font-size: var(--font-10);
  line-height: 1;
}

.primary-btn.head-run {
  padding: 5px 14px;
  font-size: var(--font-12);
  font-weight: 600;
}

.primary-btn.ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border-2);
  box-shadow: none;
}

.primary-btn.ghost:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}

.ghost-btn {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-6);
  color: var(--text-2);
  font-size: var(--font-12);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  width: auto;
  min-width: auto;
  flex-wrap: nowrap;
}

.primary-btn .ico-svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: inline-block;
  vertical-align: -1px;
}

.primary-btn .ico-svg + span {
  margin-left: 2px;
}

.ghost-btn:hover:not(:disabled) {
  // [chat-input-v4] 用 CSS 变量替代硬编码深色，浅色模式下 hover 可见
  background: var(--surface-hover, rgba(127, 127, 127, 0.08));
  color: var(--text);
  border-color: var(--border, rgba(127, 127, 127, 0.18));
}

.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.primary-btn.run {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
}

.primary-btn.takeover {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
  font-weight: 600;
  border-color: var(--primary);
}

.primary-btn.stop {
  background: transparent;
  color: #f0abfc;
  border: 1px solid #f0abfc;
  box-shadow: none;
  font-weight: 600;
  border-color: #f0abfc;
}

.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(88 166 255 / 14%);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
  box-shadow: 0 0 0 3px rgb(88 166 255 / 10%);
}

.primary-btn.stop:hover:not(:disabled) {
  background: rgb(88 166 255 / 14%);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
}

.ghost-btn > .ico-svg,
.ghost-btn > svg {
  display: inline-block;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin: 0;
  vertical-align: middle;
  fill: none;
  stroke: currentColor;
}

.ghost-btn > span {
  display: inline-block;
  white-space: nowrap;
}

/* [toolbar-btn-polish] 工具栏按钮统一视觉：尺寸对齐 + 主次层级 + 交互反馈 */
.tpl-bar button.primary-btn,
.tpl-bar button.ghost-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  line-height: 1;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.08s;
  white-space: nowrap;
}
.tpl-bar button.primary-btn > svg,
.tpl-bar button.ghost-btn > svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* 运行：实心主色 */
.tpl-bar button.primary-btn.takeover {
  background: var(--primary, #3b82f6);
  border: 1px solid var(--primary, #3b82f6);
  color: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
}
.tpl-bar button.primary-btn.takeover:hover:not(:disabled) {
  background: var(--primary-hover, #60a5fa);
  border-color: var(--primary-hover, #60a5fa);
  color: #fff;
  box-shadow: 0 4px 12px rgb(88 166 255 / 35%);
  transform: translateY(-1px);
}
.tpl-bar button.primary-btn.takeover:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgb(0 0 0 / 30%);
}

/* 暂停：品红描边 */
.tpl-bar button.primary-btn.stop {
  background: transparent;
  border: 1px solid #f0abfc;
  color: #f0abfc;
  box-shadow: none;
}
.tpl-bar button.primary-btn.stop:hover:not(:disabled) {
  background: rgb(240 171 252 / 14%);
  border-color: #f5c6ff;
  color: #f5c6ff;
  box-shadow: 0 0 0 3px rgb(240 171 252 / 12%);
}

/* 清空：次要描边 */
.tpl-bar button.ghost-btn {
  background: transparent;
  border: 1px solid var(--border, #2a2d36);
  color: var(--fg-2, #b6b8bf);
}
.tpl-bar button.ghost-btn:hover:not(:disabled) {
  // [chat-input-v4] 硬编码深色假设改 CSS 变量，浅色模式 hover 可见
  background: var(--surface-hover, rgba(127, 127, 127, 0.08));
  border-color: var(--border-hover, rgba(127, 127, 127, 0.22));
  color: var(--text);
}
.tpl-bar button.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 键盘焦点环 */
.tpl-bar button.primary-btn:focus-visible,
.tpl-bar button.ghost-btn:focus-visible {
  outline: 2px solid var(--primary, #3b82f6);
  outline-offset: 2px;
}

/* ============================================================
 * [ai-wait-btn-v1] 等待 AI 回复时按钮 spinner
 * [WHY] 用户需要从按钮本身感知等待态；与 TerminalPane 顶部 wait-banner 形成"按钮 + 顶部条"双反馈
 * [CONSTRAINT] 不禁用按钮 —— 用户在等待期仍可点击暂停/中断；spinner 仅替换图标不改按钮尺寸
 * [CHANGE-IMPACT] 与 ScriptPanel 的 :ai-waiting 透传成对；去掉后 is-waiting 永不生效
 * ============================================================ */
.tpl-bar button.primary-btn.is-waiting > svg {
  display: none !important;
}
.tpl-bar button.primary-btn.is-waiting::after {
  content: '';
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: tb-spin 0.85s linear infinite;
  box-sizing: border-box;
  flex-shrink: 0;
}
@keyframes tb-spin {
  to {
    transform: rotate(360deg);
  }
}

/* [chat-input-v4] 圆角从 999px 收敛到 10px：与输入卡片的 20px 圆角同族，不抢视觉 */
.primary-btn {
  border-radius: 10px;
  background: var(--dsw-specific-input-major, var(--bg-2, rgba(127, 127, 127, 0.05)));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  color: var(--dsw-alias-label-primary, inherit);
  transition:
    background 120ms ease,
    border-color 120ms ease;
}
.primary-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
}
.primary-btn.head-run,
.primary-btn.run {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  color: #fff;
  border-color: transparent;
}
.primary-btn.head-run:hover:not(:disabled),
.primary-btn.run:hover:not(:disabled) {
  filter: brightness(1.05);
}
.primary-btn.stop {
  background: rgb(242 90 90 / 12%);
  color: rgb(236, 19, 19);
  border-color: transparent;
}

/* [decision-in-header-v1] 决策开关与模板条同行对齐 */
</style>
