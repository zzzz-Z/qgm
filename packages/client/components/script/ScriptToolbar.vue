<script setup lang="ts">
// 去 props 变量绑定：模板直接用解构名，赋值给 props 会触发 unused-imports warning
defineProps<{
  running: boolean
  autoTakeoverEnabled: boolean
  // [pause-really-stops-v1] 按钮文案已改「停止」；此 prop 保留仅为兼容「等待中」视觉
  loopPaused: boolean
  script: string
  attachedFilesCount: number
  // 等待 AI 回复中：主按钮显示 spinner，视觉反馈与顶部 banner 呼应
  aiWaiting: boolean
  // [deliver-window-v1] 回传窗未收口（结果已产出但还没发出去）：同样转 spinner，
  //   否则「脚本成功 → 几秒空白 → 突然发出去」这段在按钮上完全看不出来
  delivering?: boolean
}>()
/** 派发 */
const emit = defineEmits<{
  clearAll: []
  pauseAll: []
  toggleAutoTakeover: []
}>()
</script>

<template>
  <div class="tpl-bar">
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

    <!-- [pause-really-stops-v1] 两态：未运行 .takeover 蓝（开始）/ 运行中 .pause 琥珀（停止）。
          守卫见 tests/toolbar-ctrl-colors.node-test.ts -->
    <button
      v-if="running || autoTakeoverEnabled || aiWaiting || delivering"
      v-tooltip="'停止：终止后台脚本 + 暂停 AI 生成'"
      aria-label="停止运行"
      class="primary-btn pause head-run"
      :class="{ 'is-waiting': aiWaiting || delivering }"
      :aria-busy="aiWaiting || delivering"
      @click="emit('pauseAll')"
    >
      <svg
        class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
      </svg>
    </button>
    <button
      v-else
      v-tooltip="'开始：执行当前脚本，随后自动把结果发 AI 并执行下一轮'"
      aria-label="开始循环"
      class="primary-btn takeover head-run"
      :class="{ 'is-waiting': aiWaiting || delivering }"
      :aria-busy="aiWaiting || delivering"
      data-mark=""
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

<style scoped>
.tpl-bar {
  @apply flex items-center justify-end gap-1.5;
  padding: 0;
  background: transparent;
  border-bottom: 0;
  flex-shrink: 0;
  min-height: auto;
  width: 100%;
}
.tpl-bar .tpl-spacer {
  flex: 1 1 auto;
  min-width: 12px;
}
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
  white-space: nowrap;
  margin: 0;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.08s;
  accent-color: var(--primary);
}
.tpl-bar button.primary-btn > svg,
.tpl-bar button.ghost-btn > svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}
.tpl-bar button.ghost-btn:disabled,
.tpl-bar button.primary-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tpl-bar button.primary-btn:focus-visible,
.tpl-bar button.ghost-btn:focus-visible {
  outline: 2px solid var(--primary, #3b82f6);
  outline-offset: 2px;
}
.tpl-bar button.ghost-btn {
  background: transparent;
  border: 1px solid var(--border, #2a2d36);
  color: var(--text-2, #b6b8bf);
}
.tpl-bar button.ghost-btn:hover:not(:disabled) {
  background: var(--surface-2, rgb(127 127 127 / 8%));
  border-color: var(--border-strong, rgb(127 127 127 / 22%));
  color: var(--text);
}
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
.tpl-bar button.primary-btn.pause {
  background: transparent;
  border: 1px solid var(--danger);
  color: var(--danger);
  box-shadow: none;
}
.tpl-bar button.primary-btn.pause:hover:not(:disabled) {
  background: var(--danger-bg);
  border-color: var(--danger);
  color: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-bg);
}
.tpl-bar button.primary-btn.is-waiting > svg {
  display: none;
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
.primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--border, rgb(127 127 127 / 20%));
  border-radius: 10px;
  font-size: var(--font-12);
  font-weight: 500;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease;
  color: var(--text, inherit);
  background: var(--surface, var(--surface, rgb(127 127 127 / 5%)));
}
.primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary-btn:hover:not(:disabled) {
  background: var(--surface-2, rgb(127 127 127 / 8%));
}
.primary-btn.head-run,
.primary-btn.run {
  background: var(--primary, #4176e6);
  color: #fff;
  border-color: transparent;
}
.primary-btn.head-run:hover:not(:disabled),
.primary-btn.run:hover:not(:disabled) {
  filter: brightness(1.05);
}
/* [pause-really-stops-v1] 循环控制键配色的**唯一事实来源** = 上方两条：
   未运行态 `.takeover`（--primary 蓝 = 开始）/ 运行中 `.pause`（--warning 琥珀 = 停止）。
   全部走语义令牌，亮/暗两套自动生效。
   历史：① 旧版两态共用硬编码 #f0abfc 粉紫（语义不清 + 亮色对比度 1.65:1）；
   ② 2026-10-14 起「暂停」语义改为「真终止」（kill 脚本 + 停 AI 生成），
   恢复态不再存在 ⇒ 由三态收敛为两态（删除 `.resume`）。
   [CONSTRAINT] 禁止再引入裸 hex 到这里；新增状态请复用 --primary/--warning/--success/--danger。 */
.primary-btn .ico {
  font-size: var(--font-10);
  line-height: 1;
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
.ghost-btn:hover:not(:disabled) {
  background: var(--surface-2, rgb(127 127 127 / 8%));
  color: var(--text);
  border-color: var(--border, rgb(127 127 127 / 18%));
}
.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
</style>
