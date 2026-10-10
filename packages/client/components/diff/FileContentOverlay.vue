<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import DiffViewer from './DiffViewer.vue'
import { renderFileContent } from '../../composables/useFileContentHtml'

const emit = defineEmits<{ close: [] }>()

defineOptions({ name: 'FileContentOverlay' })

/**
 * 文件浮层：两种渲染模式，共用外壳（Teleport 到 body / 焦点陷阱 / Esc 关闭 / 点遮罩关闭）。
 *   mode='diff'    变更**前后行级 diff**（新增 / 删除 + 统计）。变更列表点开走这条。
 *   mode='content' 只看**当前内容**（hljs / markdown）。工作日志点开走这条：git 变更列表的
 *                  「变更前」在 git 对象里，拿不到内容副本，硬做 diff 只能给出错误结果。
 *
 * [preview-diff-v1] 2026-10-09 用户指定：变更预览弹窗内容展示 diff，新增、删除。
 * [WHY] 变更列表要回答「这一轮到底改了什么」。只给改完后的完整内容，读的人得自己在脑子里做 diff；
 *   整份文件只动两三行时尤其明显。行级 diff 直接把新增/删除标出来并给出 +N/−M 计数。
 * [CONSTRAINT] diff 渲染复用 DiffViewer（与 WorklogPane 的行级 diff 同一实现），本组件不自己算 diff。
 * [CONSTRAINT] 用 Teleport 挂到 body，避免被 .pane / .main 的 overflow:hidden 裁剪。
 * [CONSTRAINT] 焦点陷阱（Esc 关、Tab 内循环）是本仓浮层的统一判据，改这里需同步 FileTree 的弹窗。
 */
const props = withDefaults(defineProps<{
  fileName: string
  /** 渲染模式：diff=变更前后差异；content=当前内容 */
  mode?: 'diff' | 'content'
  /** [mode=diff] 变更前内容（归属轮运行前快照） */
  before?: string
  /** [mode=diff] 变更后内容（当前磁盘内容） */
  after?: string
  /** [mode=diff] 变更类型：决定 diff 口径（新增/删除只看一侧）与徽标 */
  changeType?: 'added' | 'modified' | 'deleted'
  /** [mode=diff] 变更前快照缺失 ⇒ before===after，只有上下文行，须显式说明 */
  baselineMissing?: boolean
  /** [mode=content] 当前文件内容 */
  content?: string
  /** 内容仍在加载：显示占位，而非把空内容当「文件为空」/「无变更」 */
  loading?: boolean
}>(), {
  mode: 'diff',
  before: '',
  after: '',
  changeType: 'modified',
  baselineMissing: false,
  content: '',
  loading: false,
})
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const boxRef = ref<HTMLElement | null>(null)

/** [mode=content] 渲染后的 HTML；.md 走 markdown，其余走 hljs 高亮 */
const html = computed(() => renderFileContent(props.content || '', props.fileName))
/** [mode=content] markdown 需要普通块级排版（<pre> 会禁掉标题/列表样式），其余用 <pre> 保缩进 */
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
      :aria-label="props.mode === 'diff' ? `${props.fileName} 的变更 diff` : `${props.fileName} 的内容预览`"
      @click.self="emit('close')"
      @keydown="onKeydown"
    >
      <div class="fco-card">
        <!-- [close-overlay-badge-fix] 关闭按钮绝对定位在卡片右上；表头右侧内边距由 CSS 变量穿透
             （见 .fco-card 的 --diff-header-pr），否则按钮会压住表头的徽标 / 增删统计 / 文件名 -->
        <button aria-label="关闭文件预览（Esc）" class="fco-btn" @click="emit('close')">
          ×
        </button>

        <!-- diff 模式：表头由 DiffViewer 提供（文件名 + 变更徽标 + 增删统计） -->
        <template v-if="props.mode === 'diff'">
          <div v-if="props.loading" class="fco-loading">
            加载中…
          </div>
          <template v-else>
            <div v-if="props.baselineMissing" class="fco-note">
              未找到变更前快照（该轮以 git 为回滚基准，或快照已被回收）——以下只显示变更后内容，无法标出新删
            </div>
            <DiffViewer
              :file-name="props.fileName"
              :before="props.before"
              :after="props.after"
              :change-type="props.changeType"
            />
          </template>
        </template>

        <!-- content 模式：只看当前内容 -->
        <template v-else>
          <div class="fco-head">
            <span class="fco-path" :title="props.fileName">{{ props.fileName }}</span>
          </div>
          <div class="fco-body">
            <div v-if="props.loading" class="fco-loading">
              加载中…
            </div>
            <div v-else-if="isMd" class="fco-md" v-html="html" />
            <pre v-else class="fco-pre" v-html="html" />
          </div>
        </template>
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
  position: relative;
  width: min(960px, 92vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-10);
  box-shadow: 0 12px 40px rgb(0 0 0 / 40%);
  overflow: hidden;

  /* [close-overlay-badge-fix] 关闭按钮脱离文档流（absolute），不会被表头 padding 推走，
     必须给表头预留右侧空间。作用域继承可穿透 scoped ⇒ DiffViewer 的 .diff-header 与
     本组件的 .fco-head 都读这个变量，两种模式表头右内边距一致。
     [CONSTRAINT] 40px = 按钮宽 24 + right 8 + 间隙 8；改按钮尺寸需同步此值 */
  --diff-header-pr: 40px;
}
/* diff 视图撑满卡片：不再叠加嵌套边框，滚动交给 DiffViewer 内部的 .diff-body */
.fco-card :deep(.diff-viewer) {
  flex: 1;
  min-height: 0;
  border: 0;
  border-radius: 0;
}
.fco-note {
  flex-shrink: 0;
  padding: 7px 12px;
  font-size: var(--font-12);
  line-height: 1.5;
  color: var(--warning);
  background: var(--warning-bg);
  border-bottom: 1px solid var(--border);
}
.fco-head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 右侧预留关闭按钮：与 .fco-card 的变量同源 */
  padding: 8px var(--diff-header-pr, 12px) 8px 12px;
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
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: var(--z-base);
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
  padding: 12px 14px;
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
