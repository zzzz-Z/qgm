<template>
  <section class="terminal">
    <!-- [flow-timeline] 全流程时间线 -->
    <div class="flow-timeline">
      <!-- [statusbar] 常驻状态栏：左 主状态+元信息 · 右 时间 -->
      <div class="unified-status-bar" :class="[`is-${mainStatus.cls}`, { 'is-active': statusActive }]">
        <div class="usb-left">
          <!-- [usb-optimize-v1] desc 常驻：即使未提供也保留占位，布局稳定 -->
          <span class="usb-meta usb-desc" :class="{ 'is-empty': !barMeta.desc }" :title="barMeta.desc || '（未提供说明）'"><b>desc</b>{{ barMeta.desc || '（未提供说明）' }}</span>
          <span v-if="barMeta.why" class="usb-meta" :title="barMeta.why"><b>why</b>{{ barMeta.why }}</span>
          <span v-if="barMeta.plan" class="usb-meta" :title="barMeta.plan"><b>plan</b>{{ barMeta.plan }}</span>
        </div>
        <div class="usb-right">
          <!-- [usb-optimize-v2] 主状态 pill + 分隔 + 时间：分层清晰 -->
          <span class="usb-main" :class="`is-${mainStatus.cls}`">
            <span class="usb-icon">{{ mainStatus.icon }}</span>
            <span class="usb-text">{{ mainStatus.text }}</span>
          </span>
          <span class="usb-divider" aria-hidden="true" />
          <span class="usb-time" title="当前阶段耗时">{{ phaseElapsed }}</span>
        </div>
      </div>

      <!-- [done-summary-channel-v1] DONE 总结：独立全文区块 -->
      <section v-if="doneSummary" class="done-summary">
        <div class="done-summary-head">
          任务完成 · 总结
        </div>
        <pre class="done-summary-body">{{ doneSummary }}</pre>
      </section>

      <div ref="chatListRef" class="chat-list" @scroll="onChatScroll">
        <!-- [raw-output-fold-v1] 原始输出折叠块 -->
        <template v-if="running || twStdout || twStderr">
          <div v-if="rawTotal > 0" class="raw-fold" :class="{ 'has-err': rawHasError }">
            <button class="raw-fold-head" type="button" @click="rawExpanded = !rawExpanded">
              <span class="raw-fold-icon">{{ rawExpanded ? '▾' : '▸' }}</span>
              <span class="raw-fold-title">原始输出</span>
              <span class="raw-fold-count">stdout {{ rawStdoutLines.length }} · stderr {{ rawStderrLines.length }}</span>
            </button>
            <div v-if="rawExpanded" class="raw-fold-body">
              <pre v-if="twStdout" class="raw-pre">{{ twStdout }}</pre>
              <pre v-if="twStderr" class="raw-pre err">{{ twStderr }}</pre>
            </div>
          </div>
          <!-- [live-typewriter] 当前脚本实时输出（打字机） -->
          <div class="live-stream">
            <pre v-if="twStdout" class="live-pre"><span v-for="(l, i) in twLines" :key="i" :class="lineClass(l)">{{ l }}{{ i < twLines.length - 1 ? '\n' : '' }}</span><span v-if="running" class="live-cursor" /></pre>
            <pre v-if="twStderr" class="live-pre err"><span v-for="(l, i) in twErrLines" :key="i" :class="lineClass(l)">{{ l }}{{ i < twErrLines.length - 1 ? '\n' : '' }}</span><span v-if="running" class="live-cursor" /></pre>
          </div>
        </template>

        <div v-else class="tree-empty">
          <div class="empty-title">
            还没有会话记录
          </div>
          <div class="empty-sub">
            点击「运行」开始自动化循环
          </div>
          <div class="empty-cards">
            <button
              v-for="t in templates" :key="t.id" v-tooltip="t.title" class="empty-card"
              @click="applyTemplate(t.code)"
            >
              <span class="empty-card-ico">{{ t.id === 'bash' ? '🖥' : t.id === 'ask' ? '💬' : '📝' }}</span>
              <span class="empty-card-title">{{ t.label }}</span>
              <span class="empty-card-desc">{{ t.title }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
// [raw-output-fold-v1] PLAN 5.2 第四层：原始输出折叠
import { useFoldState } from '../../composables/ui/useFoldState';

/** 组件接收的 props 定义 */
const props = defineProps<{
  mainStatus: { icon: string, text: string, cls: string }
  statusActive: boolean
  barMeta: { desc?: string, why?: string, plan?: string }
  phaseElapsed: string
  running: boolean
  twStdout: string
  twStderr: string
  twLines: string[]
  twErrLines: string[]
  doneSummary?: string // [done-summary-channel-v1]
  lineClass: (line: string) => string
  chatItems: unknown[]
  templates: Array<{ id: string, label: string, title: string, code: string }>
}>()

/** 派发 */
const emit = defineEmits<{ (e: 'applyTemplate', code: string): void }>()

// [raw-output-fold-v1]
/** 折叠 */
const fold = useFoldState('default', 'terminal-raw')
/** 已展开 */
const rawExpanded = computed({
  get: () => fold.isOpen('raw-output', false),
  set: (v: boolean) => fold.setOpen('raw-output', v),
})
/** 行集合 */
const rawStdoutLines = computed(() => (props.twStdout || '').split('\n'))
/** 行集合 */
const rawStderrLines = computed(() => (props.twStderr || '').split('\n'))
/** 总数 */
const rawTotal = computed(() => rawStdoutLines.value.length + rawStderrLines.value.length)
/** 错误 */
const rawHasError = computed(() => (props.twStderr || '').length > 0)

/** 列表 */
const chatListRef = ref<HTMLElement | null>(null)
/**
 * 响应 Chat Scroll
 */
function onChatScroll(): void { /* 由父组件按需注入滚动处理 */ }
/**
 * 应用 Template
 * @param code - code
 */
function applyTemplate(code: string): void { emit('applyTemplate', code) }
</script>

<style scoped>
/* [out-dim-css] 折叠行样式 */
/* [raw-output-fold-v1] 样式 */
.raw-fold {
  margin: 6px 0;
  border: 1px solid var(--border, #334155);
  border-radius: 4px;
  overflow: hidden;
  font-family: var(--mono, monospace);
}
.raw-fold.has-err {
  border-color: var(--danger, #ef4444);
}
.raw-fold-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  background: var(--surface-2, #252525);
  border: 0;
  color: var(--text-3, #94a3b8);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}
.raw-fold-icon {
  font-size: 10px;
  width: 10px;
}
.raw-fold-title {
  flex: 1;
}
.raw-fold-count {
  font-size: 10px;
}
.raw-fold-body {
  padding: 4px 8px;
}
.raw-pre {
  margin: 0;
  padding: 4px 6px;
  background: var(--surface, #1a1a1a);
  border-radius: 3px;
  font-size: 10px;
  color: var(--text-2, #cbd5e1);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow: auto;
}
.raw-pre.err {
  color: var(--danger, #ef4444);
}

.live-pre .out-dim {
  color: var(--text-3);
  font-style: italic;
}

.status.err {
  color: var(--danger);
}

.unified-status-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 14px;
  margin: 0 0 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-6);
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-2);
  transition:
    border-color 0.2s,
    background 0.2s;
}

/* [usb-optimize-v1] 主状态 pill：底色 + 边框 + 加粗，各状态醒目 */
.usb-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
  letter-spacing: 0.4px;
  transition: all 0.2s;
}

.usb-icon {
  font-size: 13px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
}

.usb-main.is-running .usb-icon,
.usb-main.is-loop .usb-icon {
  animation: usb-spin 1.4s linear infinite;
  display: inline-block;
}

.usb-main.is-waiting .usb-icon {
  animation: usb-pulse 1.2s ease-in-out infinite;
}

.usb-main.is-paused .usb-icon {
  animation: usb-blink 1.4s ease-in-out infinite;
}

.usb-main.is-warn .usb-icon {
  animation: usb-pulse 0.9s ease-in-out infinite;
}

.usb-main.is-stop .usb-icon {
  animation: usb-fade 2s ease-in-out infinite;
}

.usb-main.is-idle .usb-icon {
  animation: usb-breathe 3s ease-in-out infinite;
}

.usb-text {
  letter-spacing: 0.3px;
}

/* [usb-optimize-v1] 各状态独立底色 + 边框，让状态一眼可辨 */
.usb-main.is-running {
  color: #58a6ff;
  background: rgb(88 166 255 / 12%);
  border-color: rgb(88 166 255 / 45%);
  box-shadow: 0 0 0 2px rgb(88 166 255 / 8%);
}

.usb-main.is-waiting {
  color: #58a6ff;
  background: rgb(88 166 255 / 10%);
  border-color: rgb(88 166 255 / 40%);
  animation: waiting-pulse 1.8s ease-in-out infinite;
}

.usb-main.is-loop {
  color: #3fb950;
  background: rgb(63 185 80 / 12%);
  border-color: rgb(63 185 80 / 45%);
  box-shadow: 0 0 0 2px rgb(63 185 80 / 8%);
}

.usb-main.is-paused {
  color: #e0a875;
  background: rgb(224 168 117 / 12%);
  border-color: rgb(224 168 117 / 45%);
}

.usb-main.is-warn {
  color: #e0a875;
  background: rgb(224 168 117 / 12%);
  border-color: rgb(224 168 117 / 45%);
  box-shadow: 0 0 0 2px rgb(224 168 117 / 8%);
}

.usb-main.is-stop {
  color: #e06c75;
  background: rgb(224 108 117 / 12%);
  border-color: rgb(224 108 117 / 45%);
}

/* [usb-optimize-v2] idle 更醒目：靛青淡底 + 描边光晕，保持中性观感 */
.usb-main.is-idle {
  color: #9aa5b8;
  background: rgb(154 165 184 / 10%);
  border-color: rgb(154 165 184 / 35%);
  box-shadow: 0 0 0 2px rgb(154 165 184 / 6%);
}

.usb-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.usb-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* [usb-optimize-v2] 状态与时间之间的竖线分隔 */
.usb-divider {
  display: inline-block;
  width: 1px;
  height: 14px;
  background: var(--border);
  opacity: 0.7;
  flex-shrink: 0;
}

/* [usb-optimize-v1] desc 常驻样式：空值时用占位色 */
/* [usb-optimize-v2] desc 常驻：更克制溢出，空值斜体占位 */
.usb-desc {
  flex-shrink: 1;
  min-width: 0;
  max-width: 420px;
  opacity: 0.95;
}

.usb-desc.is-empty {
  color: var(--text-3);
  font-style: italic;
  opacity: 0.7;
}

.usb-meta {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}

.usb-meta b {
  color: var(--text-3);
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
}

.usb-meta.usb-idle {
  color: var(--text-3);
  font-style: italic;
}

.usb-time {
  font-family: var(--mono, monospace);
  font-size: 11px;
  color: var(--text-3);
  flex-shrink: 0;
  letter-spacing: 0.5px;
}

/* [usb-optimize-v2] 活跃态：更明显的边框 + 轻微外发光 */
.unified-status-bar.is-active {
  border-color: var(--primary);
  background: var(--primary-bg);
  box-shadow:
    0 0 0 1px rgb(77 107 254 / 20%),
    inset 0 0 12px rgb(77 107 254 / 6%);
}

.flow-timeline {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 8px 16px !important;
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
  font-size: 11px !important;
  min-height: 36px !important;
}

.flow-step.error {
  background: rgb(248 81 73 / 10%) !important;
  border-color: rgb(248 81 73 / 30%) !important;
  color: var(--danger) !important;
}

.terminal {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
  background: var(--bg) !important;
}

.chat-list {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 14px !important;
  padding: 16px 24px 24px !important;
  font: 13px/1.65 var(--mono, monospace) !important;
  color: var(--text) !important;
  background: transparent !important;
  max-width: 900px !important;
  margin: 0 auto !important;
  width: 100% !important;
}

.live-stream {
  display: flex !important;
  flex-direction: column !important;
  gap: 6px !important;
  padding: 10px 14px !important;
  background: var(--surface) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-8) !important;
  margin: 8px 0 !important;
}

.live-pre {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  color: var(--text-2) !important;
  font: 12px/1.55 var(--mono, monospace) !important;
  white-space: pre-wrap !important;
  word-break: break-all !important;
}

.live-pre.err {
  color: var(--danger) !important;
}

.live-cursor {
  display: inline-block !important;
  width: 6px !important;
  height: 12px !important;
  background: var(--primary) !important;
  vertical-align: middle !important;
  margin-left: 2px !important;
  animation: cursor-blink 1s steps(2) infinite !important;
}

.tree-empty {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 14px !important;
  padding: 40px 24px !important;
  color: var(--text-3) !important;
  text-align: center !important;
  flex: 1 1 0 !important;
}

.empty-title {
  font-size: 14px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
}

.empty-sub {
  font-size: 12px !important;
  color: var(--text-3) !important;
}

.empty-cards {
  display: flex !important;
  flex-wrap: wrap !important;
  justify-content: center !important;
  gap: 10px !important;
  margin-top: 10px !important;
}

.empty-card {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 12px 18px !important;
  min-width: 110px !important;
  background: var(--surface) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-10) !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
  color: var(--text-2) !important;
  font-family: inherit !important;
}

.empty-card:hover {
  border-color: var(--primary) !important;
  background: var(--surface-2) !important;
  color: var(--text) !important;
  transform: translateY(-1px) !important;
}

.empty-card-ico {
  font-size: 20px !important;
  margin-bottom: 4px !important;
  line-height: 1 !important;
}

.empty-card-title {
  font-size: 12px !important;
  font-weight: 600 !important;
  color: var(--text) !important;
}

.empty-card-desc {
  font-size: 10px !important;
  color: var(--text-3) !important;
  line-height: 1.4 !important;
  max-width: 120px !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

.terminal,
.term-body,
.flow-timeline {
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
}

.flow-timeline {
  display: flex !important;
  flex-direction: column !important;
  flex-wrap: nowrap !important;
  align-items: stretch !important;
  gap: 6px !important;
  padding: 12px 16px !important;
  border-bottom: 1px solid var(--border) !important;
  min-height: auto !important;
}

.flow-timeline {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
}

.chat-list {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow-y: auto !important;
}

.flow-timeline .flow-step {
  background: transparent !important;
  border: 0 !important;
  padding: 8px 12px !important;
  border-radius: 0 !important;
  font-size: 12px !important;
  color: var(--text-2) !important;
  gap: 10px !important;
}

.flow-timeline .flow-step.run {
  color: var(--primary) !important;
}

.flow-timeline .flow-step.ok {
  color: var(--success) !important;
}

.flow-timeline .flow-step.err {
  color: var(--danger) !important;
}

.flow-timeline .flow-step .flow-icon {
  font-size: 14px !important;
  width: 16px !important;
  height: 16px !important;
}

.flow-timeline .flow-step .flow-label {
  font-size: 12px !important;
}

.chat-list {
  padding: 8px 0 8px 12px !important;
  margin: 0 !important;
  max-width: none !important;
  align-items: stretch !important;
  text-align: left !important;
  border: 0 !important;
  border-radius: 0 !important;
}

.live-stream {
  padding: 0 !important;
  margin: 0 !important;
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
}

.live-pre {
  padding: 0 !important;
  margin: 0 !important;
  background: transparent !important;
  border: 0 !important;
  text-align: left !important;
  font-family: var(--mono, monospace) !important;
  font-size: 12px !important;
  line-height: 1.55 !important;
  white-space: pre-wrap !important;
  word-break: break-all !important;
}

.chat-list > *,
.live-stream > * {
  margin-left: 0 !important;
  text-align: left !important;
}

.script-header .sm-state.is-waiting,
.script-header .sm-state.is-executing,
.script-header .sm-state.is-parsing,
.script-header .sm-state.is-interrupted,
.script-header .sm-state.is-stopped,
.live-pre .out-step {
  color: var(--primary) !important;
  font-weight: 600 !important;
}

.live-pre .out-ok {
  color: var(--success) !important;
}

.live-pre .out-err {
  color: var(--danger) !important;
}

.live-pre .out-warn {
  color: var(--warning) !important;
}

.flow-timeline {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: 8px !important;
  padding: 8px 14px !important;
  border-bottom: 1px solid var(--border) !important;
  min-height: 36px !important;
  overflow-x: auto !important;
  overflow-y: hidden !important;
  background: transparent !important;
}

.flow-timeline .script-header {
  display: inline-flex !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  flex: 0 0 auto !important;
}

.flow-timeline .script-header .sm-state {
  margin-left: 0 !important;
}

.flow-timeline .flow-step {
  display: inline-flex !important;
  flex: 0 0 auto !important;
  width: auto !important;
  padding: 4px 10px !important;
  background: transparent !important;
  border: 0 !important;
  color: var(--text-2) !important;
  font-size: 12px !important;
  gap: 8px !important;
}

.flow-timeline .flow-step.run {
  color: var(--primary) !important;
}

.flow-timeline .flow-step.ok {
  color: var(--success) !important;
}

.flow-timeline .flow-step.err {
  color: var(--danger) !important;
}

.flow-timeline .flow-icon {
  font-size: 14px !important;
  width: 16px !important;
  height: 16px !important;
  flex-shrink: 0 !important;
}

.chat-list .tree-empty {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  margin: auto !important;
  padding: 40px 24px !important;
  gap: 16px !important;
}

.chat-list .tree-empty .empty-title {
  font-size: 15px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
}

.chat-list .tree-empty .empty-sub {
  font-size: 12px !important;
  color: var(--text-3) !important;
}

.chat-list .tree-empty .empty-cards {
  display: flex !important;
  flex-wrap: wrap !important;
  justify-content: center !important;
  gap: 10px !important;
  margin-top: 8px !important;
}

.flow-timeline {
  justify-content: center !important;
  align-items: center !important;
}

.flow-timeline .flow-icon,
.flow-timeline .flow-spinner,
.flow-timeline .flow-glyph {
  font-size: 0 !important;
  line-height: 0 !important;
  width: 8px !important;
  height: 8px !important;
  min-width: 8px !important;
  position: relative !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  overflow: hidden !important;
  border: 0 !important;
  background: transparent !important;
}

.flow-timeline .flow-icon::before,
.flow-timeline .flow-glyph::before {
  content: '' !important;
  display: block !important;
  width: 6px !important;
  height: 6px !important;
  border-radius: 50% !important;
  background: currentColor !important;
  opacity: 0.55 !important;
}

.flow-timeline .flow-step.run .flow-icon::before,
.flow-timeline .flow-step.run .flow-glyph::before {
  opacity: 1 !important;
  box-shadow: 0 0 6px currentColor !important;
  animation: dot-pulse 1.4s ease-in-out infinite !important;
}

.flow-timeline .flow-step.ok .flow-icon::before,
.flow-timeline .flow-step.ok .flow-glyph::before {
  opacity: 1 !important;
}

.flow-timeline .flow-step.err .flow-icon::before,
.flow-timeline .flow-step.err .flow-glyph::before {
  opacity: 1 !important;
}

.flow-timeline .flow-spinner {
  border: 0 !important;
  animation: dot-pulse 1.4s ease-in-out infinite !important;
}

.flow-timeline .flow-step {
  align-items: center !important;
  justify-content: center !important;
}

.flow-timeline .script-header {
  align-items: center !important;
  justify-content: center !important;
}

.flow-timeline {
  display: flex !important;
  flex-direction: column !important;
  flex-wrap: nowrap !important;
  align-items: stretch !important;
  justify-content: flex-start !important;
  gap: 0 !important;
  padding: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  min-height: 0 !important;
  overflow: hidden !important;
  background: transparent !important;
  flex: 1 1 0 !important;
}

.flow-timeline .script-header {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 8px !important;
  padding: 8px 14px !important;
  margin: 0 !important;
  border: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  flex: 0 0 auto !important;
  width: 100% !important;
}

.flow-timeline .flow-step {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 8px !important;
  padding: 6px 14px !important;
  margin: 0 !important;
  border: 0 !important;
  flex: 0 0 auto !important;
  width: 100% !important;
  background: transparent !important;
}

.flow-timeline .term-body {
  display: flex !important;
  flex-direction: column !important;
  flex: 0 0 auto !important;
  width: 100% !important;
  padding: 0 !important;
  margin: 0 !important;
}

.flow-timeline .chat-list {
  display: flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  justify-content: flex-start !important;
  text-align: left !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  width: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 10px 14px !important;
  gap: 8px !important;
  overflow-y: auto !important;
  background: transparent !important;
}

.flow-timeline .chat-list .tree-empty {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  margin: auto !important;
  width: 100% !important;
  padding: 40px 24px !important;
}

.flow-timeline .chat-list .live-stream {
  align-self: stretch !important;
  text-align: left !important;
  margin: 0 !important;
}

.flow-timeline .chat-list .live-pre {
  text-align: left !important;
  padding: 0 !important;
  margin: 0 !important;
}

.chat-list .tree-empty {
  padding: 64px 24px !important;
  gap: 24px !important;
}

.chat-list .tree-empty .empty-title {
  font-size: 16px !important;
  font-weight: 600 !important;
  letter-spacing: 0.2px;
}

.chat-list .tree-empty .empty-sub {
  font-size: 12.5px !important;
  opacity: 0.9;
}

.chat-list .tree-empty .empty-cards {
  margin-top: 12px !important;
  gap: 14px !important;
}

.chat-list .tree-empty .empty-card {
  padding: 18px 26px !important;
  min-width: 138px !important;
  background: linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%) !important;
  border-color: var(--border-2, var(--border)) !important;
  box-shadow: 0 2px 6px rgb(0 0 0 / 18%);
}

.chat-list .tree-empty .empty-card:hover {
  border-color: var(--primary) !important;
  box-shadow: 0 6px 18px rgb(77 107 254 / 22%);
  transform: translateY(-2px) !important;
}

.chat-list .tree-empty .empty-card-ico {
  font-size: 28px !important;
  margin-bottom: 6px !important;
  filter: drop-shadow(0 2px 6px rgb(0 0 0 / 25%));
}

.chat-list .tree-empty .empty-card-title {
  font-size: 13px !important;
  letter-spacing: 0.3px;
}

.chat-list .tree-empty .empty-card-desc {
  font-size: 11px !important;
  max-width: 140px !important;
}

/* [done-summary-channel-v1] DONE 总结区块 */
.done-summary {
  margin: 8px 14px;
  padding: 10px 14px;
  border: 1px solid rgb(63 185 80 / 35%);
  background: rgb(63 185 80 / 8%);
  border-radius: 8px;
}
.done-summary-head {
  font-size: 12px;
  font-weight: 700;
  color: #3fb950;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.done-summary-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12px/1.6 var(--mono, monospace);
  color: var(--text);
  max-height: 320px;
  overflow-y: auto;
}
</style>
