<script setup lang="ts">
import { computed } from 'vue'
import FileTree from './FileTree.vue'
import FileList from './FileList.vue'
import WorklogPane from './WorklogPane.vue'
import { useFoldState } from '../../composables/ui/useFoldState'

defineOptions({ name: 'SidePane' })

const model = defineModel<boolean>('sideDrawerOpen', { required: true })

const props = defineProps<{
  changes: { path: string, type: 'added' | 'modified' | 'deleted' }[]
  rolling: Record<string, boolean>
  busyAll: boolean
  previewFile: string | null
  result: { tools?: unknown[] } | null
  sideWidth: number
}>()

const emit = defineEmits<{
  rollback: [file: string]
  rollbackAll: []
  save: [file?: string]
  preview: [file: string]
}>()

/** 标签页类型：从 _tabAllowed 派生，保证与运行时白名单一致 */
// [WHY] TS 类型别名编译期惰性求值，`typeof _tabAllowed` 引用后置 const 无 TDZ 风险
type SideTab = typeof _tabAllowed[number]

const _tabAllowed = ['tree', 'changes', 'worklog'] as const

// [side-fold-v1] 折叠 + tab 选择持久化（PLAN 5.4）
const fold = useFoldState('default', 'side-pane')

const sideTab = computed<SideTab>({
  get: () => {
    // [no-double-cast-v1] fold.all 的存储槽位类型为 boolean，实际承载 SideTab 字符串；
    // 用 typeof 收窄替代 `as unknown as string`，保留类型安全的同时给出清晰失败回退
    const raw: unknown = fold.all.value.tab
    if (typeof raw === 'string' && (_tabAllowed as readonly string[]).includes(raw)) {
      return raw as SideTab
    }
    return 'tree'
  },
  // [no-double-cast-v1] 存储槽位签名是 boolean，实际承载 SideTab 字符串；
  // 语义清晰无需进一步抽象，保留双重强转但注明理由
  set: (v: SideTab) => fold.setOpen('tab', v as unknown as boolean),
})

const displayWidth = computed(() => props.sideWidth || 320)

const collapsed = computed({
  get: () => !fold.isOpen('expanded', true),
  set: (v: boolean) => fold.setOpen('expanded', !v),
})

function selectTab(tab: (typeof sideTab)['value']): void {
  sideTab.value = tab
  if (collapsed.value)
    collapsed.value = false
}

// [side-worklog-tab-v1] 供父组件（App.vue）从 header 按钮直接切到指定 tab；
// [CHANGE-IMPACT] 依赖 Vue 3 的 defineExpose；父组件通过 ref 调用，无需额外事件通道
defineExpose({ selectTab })
</script>

<template>
  <div v-if="model" class="side-drawer-backdrop bg-[rgb(15_30_60_/_35%)] inset-0 fixed z-30" @click="model = false" />
  <aside class="pane-side rounded-l-lg h-full relative overflow-hidden" :class="{ 'translate-x-0!': model, 'is-collapsed': collapsed }" :style="{ width: collapsed ? '40px' : `${displayWidth}px` }">
    <div class="side-tabs p-1.5 px-2 border-b border-[var(--border)] bg-[var(--surface)] flex shrink-0 gap-1.5 items-center">
      <button :class="{ 'side-tab-active': sideTab === 'tree' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('tree')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></span>
      </button>
      <button v-tooltip="'变更列表'" :class="{ 'side-tab-active': sideTab === 'changes' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('changes')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg></span><span v-if="props.changes.length" class="side-tab-badge text-[10px] text-[var(--bg)] leading-none font-bold px-1 rounded-full bg-[var(--primary)] inline-flex h-4 min-w-4 shadow-[0_0_0_2px_var(--surface)] items-center justify-center absolute tabular-nums -right-1 -top-1">{{ props.changes.length }}</span>
      </button>
      <!-- [side-worklog-tab-v1] 工作日志 tab：VSCode 源码管理风格（提交框 + 变更列表 + 行级 diff）
           [WHY] 用户要求把原 WorklogDialog 弹窗改为侧栏 tab，与树/变更列表并列
           [CHANGE-IMPACT] 内容由 WorklogPane.vue 提供；active 由 sideTab 派生，非活动时不发请求 -->
      <button v-tooltip="'工作日志'" :class="{ 'side-tab-active': sideTab === 'worklog' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('worklog')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg></span>
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
    <!-- [side-worklog-tab-v1] 工作日志面板：内部自行按需拉取 /__ai/git/worklog -->
    <div v-show="sideTab === 'worklog'" class="side-worklog flex flex-col flex-1 min-h-0 overflow-hidden">
      <WorklogPane :active="sideTab === 'worklog'" />
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
  display: none;
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
