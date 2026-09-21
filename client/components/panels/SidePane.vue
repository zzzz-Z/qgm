<script setup lang="ts">
import { computed, ref } from 'vue'
import FileTree from './FileTree.vue'
import FileList from './FileList.vue'
import TracePanel from './TracePanel.vue'
import TaskListPanel from './TaskListPanel.vue'

defineOptions({ name: 'SidePane' })

const model = defineModel<boolean>('sideDrawerOpen', { required: true })
const sideTab = ref<'tree' | 'changes' | 'trace' | 'tasks'>('tree')
const props = defineProps<{
  changes: { path: string, type: 'added' | 'modified' | 'deleted' }[]
  rolling: Record<string, boolean>
  busyAll: boolean
  previewFile: string | null
  result: { tools?: unknown[] } | null
  sideWidth: number
}>()

// [tab-width] 记录/任务 tab 加宽，显示更多信息
const WIDE_TABS = new Set(['trace', 'tasks'])
const WIDE_EXTRA = 240
const displayWidth = computed(() => {
  const base = props.sideWidth || 320
  return WIDE_TABS.has(sideTab.value) ? base + WIDE_EXTRA : base
})

// 收起状态（本地，不持久化）
const collapsed = ref(false)

const emit = defineEmits<{
  rollback: [file: string]
  rollbackAll: []
  save: [file?: string]
  preview: [file: string]
}>()
</script>

<template>
  <div v-if="model" class="side-drawer-backdrop bg-[rgb(15_30_60_/_35%)] inset-0 fixed z-30" @click="model = false" />
  <aside class="pane-side rounded-l-lg h-full relative overflow-hidden" :class="{ 'translate-x-0!': model, 'is-collapsed': collapsed }" :style="{ width: collapsed ? '40px' : `${displayWidth}px` }">
    <div class="side-tabs p-1.5 px-2 border-b border-[var(--border)] bg-[var(--surface)] flex shrink-0 gap-1.5 items-center">
      <button :class="{ 'side-tab-active': sideTab === 'tree' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="sideTab = 'tree'">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></span>
      </button>
      <button v-tooltip="'变更列表'" :class="{ 'side-tab-active': sideTab === 'changes' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="sideTab = 'changes'">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg></span><span v-if="props.changes.length" class="side-tab-badge text-[10px] text-[var(--bg)] leading-none font-bold px-1 rounded-full bg-[var(--primary)] inline-flex h-4 min-w-4 shadow-[0_0_0_2px_var(--surface)] items-center justify-center absolute tabular-nums -right-1 -top-1">{{ props.changes.length }}</span>
      </button>
      <button v-tooltip="'会话记录'" :class="{ 'side-tab-active': sideTab === 'trace' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="sideTab = 'trace'">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg></span>
      </button>
      <button
        v-tooltip="'任务清单'" type="button" :class="{ 'side-tab-active': sideTab === 'tasks' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]"
        aria-label="任务清单" @click="sideTab = 'tasks'"
      >
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg></span>
      </button>
      <!-- [fix-side-collapse] 收起/展开 -->
      <button
        v-tooltip="collapsed ? '展开侧栏' : '收起侧栏'"
        class="side-collapse-btn"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        @click="collapsed = !collapsed"
      >
        <!-- [fix-side-icon] 侧栏切换图标：圆角矩形 + 左竖线 -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="3" ry="3" />
          <line x1="9" y1="4" x2="9" y2="20" />
          <line v-if="collapsed" x1="13" y1="12" x2="17" y2="12" />
          <polyline v-else points="17 9 14 12 17 15" />
        </svg>
      </button>
    </div>
    <div v-show="sideTab === 'tree'" class="side-tree text-sm flex flex-col flex-1 min-h-0 overflow-hidden">
      <FileTree root draggable />
    </div>
    <div v-show="sideTab === 'changes'" class="side-changes p-4 flex flex-col flex-1 gap-3 min-h-0 overflow-hidden">
      <div v-if="!props.result && !props.changes.length" class="side-empty text-[var(--text-3)] p-8 border border-[var(--border-2)] rounded-8 border-dashed bg-[var(--surface)] flex flex-col flex-1 gap-4 items-center justify-center">
        <div class="side-empty-icon text-8">
          📋
        </div>
        <div class="side-empty-text text-sm">
          运行后显示变更
        </div>
      </div>
      <FileList
        v-if="props.changes.length" :changes="props.changes" :rolling="props.rolling" :busy-all="props.busyAll"
        :active-file="props.previewFile!" @rollback="(f) => emit('rollback', f)" @rollback-all="() => emit('rollbackAll')" @save="() => emit('save', '')"
        @preview="(f) => emit('preview', f)"
      />
    </div>
    <div v-show="sideTab === 'trace'" class="side-trace flex flex-col flex-1 min-h-0 overflow-hidden">
      <TracePanel v-if="sideTab === 'trace'" />
    </div>
    <div v-show="sideTab === 'tasks'" class="side-tasks flex flex-col flex-1 min-h-0 overflow-hidden">
      <TaskListPanel />
    </div>
  </aside>
</template>

<style scoped lang="scss">
.side-tab.side-tab-active {
  color: var(--primary);
  background: var(--surface-2);
  font-weight: 600;
}

.side-tab-icon {
  font-size: 14px;
  line-height: 1;
  display: inline-block;
}
.side-tab.side-tab-active .side-tab-icon {
  color: inherit;
}

.side-collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}
.side-collapse-btn:hover {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
}
.pane-side.is-collapsed {
  overflow: hidden;
}
.pane-side.is-collapsed > :not(.side-tabs) {
  display: none !important;
}
.pane-side.is-collapsed .side-tabs {
  flex-direction: column;
  padding: 6px 4px;
  gap: 4px;
}
.pane-side.is-collapsed .side-tab {
  flex-shrink: 0;
}
.pane-side.is-collapsed .side-collapse-btn {
  margin-left: 0;
  margin-top: 4px;
}

:deep(.changes) {
  flex: 1 1 auto;
  min-height: 100px;
}

:deep(.diff-viewer) {
  flex: 1 1 auto;
  min-height: 0;
}

@media (max-width: 1100px) {
  :deep(.changes) {
    max-height: 42%;
  }
}
</style>
