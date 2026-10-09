<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { renderFileContent } from '../../composables/useFileContentHtml'

/**
 * 文件内容预览浮层。
 * [WHY] 变更列表点开的是「改完长什么样」，不是行级差异；
 *   用 Teleport 挂到 body，避免被 .pane / .main 的 overflow:hidden 裁剪。
 * [CONSTRAINT] 焦点陷阱（Esc 关、Tab 内循环）是本仓浮层的统一判据，改这里需同步 FileTree 的弹窗。
 */
const props = defineProps<{
  fileName: string
  content: string
  /** 内容仍在加载：显示占位而非把空内容当「文件为空」 */
  loading?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

defineOptions({ name: 'FileContentOverlay' })

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const boxRef = ref<HTMLElement | null>(null)

/** 渲染后的 HTML；.md 走 markdown，其余走 hljs 高亮 */
const html = computed(() => renderFileContent(props.content, props.fileName))
/** markdown 需要普通块级排版（<pre> 会禁掉标题/列表样式），其余用 <pre> 保缩进 */
const isMd = computed(() => /\.(?:md|markdown)$/i.test(props.fileName))

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => {
    const box = boxRef.value
    const first = box?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first || box)?.focus?.()
  })
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'Tab') return
  const box = boxRef.value
  if (!box) return
  const nodes = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (!nodes.length) { e.preventDefault(); return }
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  const cur = document.activeElement as HTMLElement | null
  if (e.shiftKey && (cur === first || !box.contains(cur))) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus() }
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="boxRef"
      class="fco-mask"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      :aria-label="`${props.fileName} 的内容预览`"
      @click.self="emit('close')"
      @keydown="onKeydown"
    >
      <div class="fco-card">
        <div class="fco-head">
          <span class="fco-path" :title="props.fileName">{{ props.fileName }}</span>
          <button aria-label="关闭内容预览（Esc）" class="fco-btn" @click="emit('close')">
            ×
          </button>
        </div>
        <div class="fco-body">
          <div v-if="props.loading" class="fco-loading">
            加载中…
          </div>
          <div v-else-if="isMd" class="fco-md" v-html="html" />
          <pre v-else class="fco-pre" v-html="html" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
// [md-table-shared-v1] markdown 表格样式单点源，避免与对话流卡片 / FileTree 预览三处漂移
@use '../../styles/md-table.scss' as mdtable;
.fco-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: rgb(0 0 0 / 55%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.fco-card {
  width: min(960px, 92vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-10);
  box-shadow: 0 12px 40px rgb(0 0 0 / 40%);
  overflow: hidden;
}
.fco-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.fco-path {
  flex: 1;
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fco-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: transparent;
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: 0.12s;
}
.fco-btn:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-bg);
}
.fco-body {
  flex: 1;
  min-height: 0;
  padding: 12px 14px;
  overflow: auto;
}
.fco-loading {
  font-size: 13px;
  color: var(--text-3);
  padding: 12px 0;
}
.fco-pre {
  margin: 0;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
}
.fco-pre :deep(.hljs-keyword),
.fco-pre :deep(.hljs-literal) {
  color: #569cd6;
}
.fco-pre :deep(.hljs-string) {
  color: #ce9178;
}
.fco-pre :deep(.hljs-number) {
  color: #b5cea8;
}
.fco-pre :deep(.hljs-comment) {
  color: #6a9955;
  font-style: italic;
}
.fco-pre :deep(.hljs-function),
.fco-pre :deep(.hljs-title) {
  color: #dcdcaa;
}
.fco-pre :deep(.hljs-variable),
.fco-pre :deep(.hljs-params),
.fco-pre :deep(.hljs-attr) {
  color: #9cdcfe;
}
.fco-pre :deep(.hljs-built_in),
.fco-pre :deep(.hljs-type) {
  color: #4ec9b0;
}
.fco-md {
  margin: 0;
  font:
    13.5px/1.75 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  color: var(--text);
  word-break: break-word;
}
.fco-md :deep(p) {
  margin: 0 0 10px;
}
.fco-md :deep(p:last-child) {
  margin-bottom: 0;
}
.fco-md :deep(h1) {
  margin: 22px 0 12px;
  font-size: 20px;
  font-weight: 600;
}
.fco-md :deep(h2) {
  margin: 20px 0 10px;
  font-size: 18px;
  font-weight: 600;
}
.fco-md :deep(h3) {
  margin: 18px 0 8px;
  font-size: 16px;
  font-weight: 600;
}
.fco-md :deep(h4) {
  margin: 16px 0 6px;
  font-size: 14px;
  font-weight: 600;
}
.fco-md :deep(h1:first-child),
.fco-md :deep(h2:first-child),
.fco-md :deep(h3:first-child),
.fco-md :deep(h4:first-child) {
  margin-top: 0;
}
.fco-md :deep(a) {
  color: var(--primary);
  text-decoration: none;
}
.fco-md :deep(a:hover) {
  text-decoration: underline;
}
.fco-md :deep(strong) {
  font-weight: 600;
}
.fco-md :deep(em) {
  font-style: italic;
}
.fco-md :deep(ul),
.fco-md :deep(ol) {
  margin: 6px 0 10px;
  padding-left: 22px;
}
.fco-md :deep(li) {
  margin: 3px 0;
}
.fco-md :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--border);
  color: var(--text-2);
}
.fco-md :deep(hr) {
  margin: 14px 0;
  border: 0;
  border-top: 1px solid var(--border);
}
.fco-md :deep(.md-pre) {
  margin: 10px 0;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre;
}
.fco-md :deep(.md-pre code) {
  font:
    12px/1.6 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: var(--text-2);
}
.fco-md :deep(.md-inline) {
  padding: 1px 6px;
  background: rgb(110 118 129 / 25%);
  border-radius: 4px;
  font:
    12px/1.5 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}
// [md-table-shared-v1] 表格样式改由共享 mixin 提供，与对话流卡片 / FileTree 预览同构
@include mdtable.md-table('.fco-md');
</style>
