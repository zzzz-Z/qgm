<script setup lang="ts">
import { sidePaneRevealTick, sidePaneTab } from '../../composables/ui/useSidePaneTab'
import FileTree from './FileTree.vue'
import FileList from './FileList.vue'
import type { ChangeEntry } from '../../types'

/** 标签页类型：从 _tabAllowed 派生，保证与运行时白名单一致 */
// [WHY] TS 类型别名编译期惰性求值，`typeof _tabAllowed` 引用后置 const 无 TDZ 风险
type SideTab = typeof _tabAllowed[number]

const props = defineProps<{
  changes: ChangeEntry[]
  rolling: Record<string, boolean>
  busyAll: boolean
  previewFile: string | null
  result: { tools?: unknown[] } | null
  sideWidth: number
  /** [cumulative-baseline-v1] 累积视图加载中 */
  cumulativeLoading: boolean
  /** [cumulative-baseline-v1] 累积视图加载失败原因（空串 = 无错） */
  cumulativeError: string
}>()
const emit = defineEmits<{
  rollback: [file: string]
  rollbackAll: []
  save: [file?: string]
  preview: [file: string]
}>()

/**
 * [cumulative-baseline-v1] 变更视图（本轮 / 累积）双向绑定
 * [WHY] 「本轮 / 累积」切换必须常驻可见——放在 FileList 头部时，列表为空就没有切换入口，
 *   用户会卡在累积视图（列表空）回不到本轮，看起来像「功能坏了」
 */
const changeView = defineModel<'round' | 'cumulative'>('changeView', { required: true })
const model = defineModel<boolean>('sideDrawerOpen', { required: true })

defineOptions({ name: 'SidePane' })

const _tabAllowed = ['tree', 'changes', 'worklog', 'kb', 'terminal', 'video'] as const
const WorklogPane = defineAsyncComponent(() => import('./WorklogPane.vue'))
// [kb-panel-side-v1] 知识库面板：接入右侧栏第四 tab，懒加载（与 worklog 同范式）
const KnowledgePanel = defineAsyncComponent(() => import('./KnowledgePanel.vue'))
// [terminal-panel-v1] 终端面板：vue-web-terminal + /__ai/exec，懒加载同 worklog 范式
const TerminalPanel = defineAsyncComponent(() => import('./TerminalPanel.vue'))
// [video-panel-v1] 视频生成面板：首切才加载，之后 v-show 保活
const VideoGenerationPanel = defineAsyncComponent(() => import('./VideoGenerationPanel.vue'))
/**
 * [side-drawer-narrow-v1] 是否处于「抽屉形态」（≤1100px）。
 * [WHY] 断点只在 CSS 里，JS 侧需要同一判据来决定遮罩是否渲染——
 *   桌面端面板在文档流内，铺全屏遮罩会挡住主区却不关面板。
 * [CONSTRAINT] 与 script-panel.scss 的 @media (max-width: 1100px) 保持同值，改一处必须同步。
 */
const NARROW_QUERY = '(max-width: 1100px)'

// [worklog-lazy-v1] WorklogPane（含 markdown-it 渲染链）仅首次切到 worklog tab 才加载
// [WHY] worklogLoaded 闸门 v-if 保证 defineAsyncComponent 的 loader 到首切才触发；
//       加载后 v-if 恒真、由 v-show 保活，保留结果/展开状态（不能只用 v-if，否则切走即丢状态）
// [CHANGE-IMPACT] 首切 tab 多一次 chunk 请求；WorklogPane 自身 watch 改 immediate 以适配"挂载即激活"
const worklogLoaded = shallowRef(false)
const kbLoaded = shallowRef(false)
const terminalLoaded = shallowRef(false)
const videoLoaded = shallowRef(false)
const isNarrow = ref(typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches)

// 折叠 + tab 选择持久化（PLAN 5.4）
const fold = useFoldState('default', 'side-pane')

const sideTab = computed<SideTab>({
  get: () => {
    // fold.all 的存储槽位类型为 boolean，实际承载 SideTab 字符串；
    // 用 typeof 收窄替代 `as unknown as string`，保留类型安全的同时给出清晰失败回退
    const raw: unknown = fold.all.value.tab
    if (typeof raw === 'string' && (_tabAllowed as readonly string[]).includes(raw)) {
      return raw as SideTab
    }
    return 'tree'
  },
  // 存储槽位签名是 boolean，实际承载 SideTab 字符串；
  // 语义清晰无需进一步抽象，保留双重强转但注明理由
  set: (v: SideTab) => fold.setOpen('tab', v as unknown as boolean),
})
const displayWidth = computed(() => props.sideWidth || 320)
const collapsed = computed({
  get: () => !fold.isOpen('expanded', true),
  set: (v: boolean) => fold.setOpen('expanded', !v),
})

watch(sideTab, (tab) => {
  if (tab === 'worklog') worklogLoaded.value = true
  if (tab === 'kb') kbLoaded.value = true
  if (tab === 'terminal') terminalLoaded.value = true
  if (tab === 'video') videoLoaded.value = true
}, { immediate: true })
// [side-pane-tab-v1] 外部请求（工具栏按钮）→ 切 tab + 展开；collapsed 由 revealTick watch 控制
watch(sidePaneRevealTick, () => {
  sideTab.value = sidePaneTab.value
  if (collapsed.value)
    collapsed.value = false
})

if (typeof window !== 'undefined') {
  const mq = window.matchMedia(NARROW_QUERY)
  const onChange = (e: MediaQueryListEvent) => { isNarrow.value = e.matches }
  mq.addEventListener('change', onChange)
  onBeforeUnmount(() => mq.removeEventListener('change', onChange))
}

function selectTab(tab: (typeof sideTab)['value']): void {
  sideTab.value = tab
  sidePaneTab.value = tab
  if (collapsed.value)
    collapsed.value = false
}

defineExpose({ selectTab })
</script>

<template>
  <!-- [side-drawer-backdrop-v1] 遮罩只在「抽屉形态」（窄屏）下出现：桌面端面板在文档流里，铺全屏遮罩会挡住主区却关不掉面板 -->
  <div v-if="model && isNarrow" class="side-drawer-backdrop bg-[rgb(15_30_60_/_35%)] inset-0 fixed z-30" @click="model = false" />
  <aside class="pane-side rounded-l-lg h-full relative overflow-hidden" :class="{ 'translate-x-0!': model, 'is-collapsed': collapsed }" :style="{ width: collapsed ? '40px' : `${displayWidth}px` }">
    <div class="side-tabs p-1.5 px-2 border-b border-[var(--border)] bg-[var(--surface)] flex shrink-0 gap-1.5 items-center">
      <button aria-label="文件树" :class="{ 'side-tab-active': sideTab === 'tree' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('tree')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></span>
      </button>
      <!-- <button v-tooltip="'变更列表'" aria-label="变更列表" :class="{ 'side-tab-active': sideTab === 'changes' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('changes')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg></span><span v-if="props.changes.length" class="side-tab-badge text-[10px] text-[var(--bg)] leading-none font-bold px-1 rounded-full bg-[var(--primary)] inline-flex h-4 min-w-4 shadow-[0_0_0_2px_var(--surface)] items-center justify-center absolute tabular-nums -right-1 -top-1">{{ props.changes.length }}</span>
      </button> -->
      <!-- 工作日志 tab：VSCode 源码管理风格（提交框 + 变更列表 + 行级 diff）
           [WHY] 用户要求把原 WorklogDialog 弹窗改为侧栏 tab，与树/变更列表并列
           [CHANGE-IMPACT] 内容由 WorklogPane.vue 提供；active 由 sideTab 派生，非活动时不发请求 -->
      <button v-tooltip="'工作日志'" aria-label="工作日志" :class="{ 'side-tab-active': sideTab === 'worklog' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('worklog')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg></span>
      </button>

      <!-- [kb-panel-side-v1] 知识库 tab：经验台账 / 项目文档 / 外部 Wiki 检索（懒加载，同 worklog 范式） -->
      <button v-tooltip="'知识库'" aria-label="知识库" :class="{ 'side-tab-active': sideTab === 'kb' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('kb')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg></span>
      </button>

      <!-- [terminal-panel-v1] 终端 tab：本地 shell，执行走 /__ai/exec（懒加载同 kb 范式） -->
      <button v-tooltip="'终端'" aria-label="终端" :class="{ 'side-tab-active': sideTab === 'terminal' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('terminal')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg></span>
      </button>
      <!-- [video-panel-v1] 视频生成 tab：主题提交 + 任务进度（懒加载，同 kb 范式） -->
      <button v-tooltip="'视频生成'" aria-label="视频生成" :class="{ 'side-tab-active': sideTab === 'video' }" class="side-tab text-[var(--text-3)] p-0 border-0 rounded-md bg-transparent inline-flex gap-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center relative hover:text-[var(--text-2)] hover:bg-[rgb(255_255_255_/_6%)]" @click="selectTab('video')">
        <span class="side-tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg></span>
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
    <div v-show="sideTab === 'changes'" class="side-changes p-3 flex flex-col flex-1 gap-3 min-h-0 overflow-hidden">
      <!-- [cumulative-baseline-v1] 视图切换常驻在列表之外：列表为空时也必须能切回「本轮」 -->
      <!-- [seg-control-v1] 两个独立描边按钮 → 单轨道分段控件：视觉上「二选一」一目了然，
           旧写法两个平级方框看不出互斥关系，且与面板里其他按钮（撤回/确认）同形，层级混淆。 -->
      <div class="view-seg" role="group" aria-label="变更视图">
        <button
          v-tooltip="'只看最近一次运行的改动'" class="seg-btn" :class="{ active: changeView === 'round' }"
          :aria-pressed="changeView === 'round'" @click="changeView = 'round'"
        >
          本轮
        </button>
        <button
          v-tooltip="'看自本会话第一次运行以来的全部改动（含各轮归属）'" class="seg-btn" :class="{ active: changeView === 'cumulative' }"
          :aria-pressed="changeView === 'cumulative'" @click="changeView = 'cumulative'"
        >
          累积
        </button>
        <span v-if="changeView === 'cumulative' && props.cumulativeLoading" class="seg-hint">
          <span class="seg-spinner" aria-hidden="true" />加载中
        </span>
      </div>
      <div v-if="!props.changes.length" class="side-empty text-[var(--text-3)] p-8 border border-[var(--border-2)] rounded-8 border-dashed bg-[var(--surface)] flex flex-col flex-1 gap-4 items-center justify-center">
        <!-- [ui-icon-discipline-v1] chrome 层去 emoji：单色 SVG（currentColor 继承父色） -->
        <div class="side-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <path d="M9 12h6M9 16h4" />
          </svg>
        </div>
        <div class="side-empty-text text-sm">
          {{ changeView === 'cumulative' ? (props.cumulativeError || '累积视图暂无变更（基准就绪后显示跨轮改动）') : '运行后显示变更' }}
        </div>
        <div v-if="changeView === 'cumulative' && props.cumulativeError && !props.result" class="side-empty-text text-xs">
          运行一轮即可重新锚定累积基准
        </div>
      </div>
      <FileList
        v-if="props.changes.length" :changes="props.changes" :rolling="props.rolling" :busy-all="props.busyAll" :view="changeView"
        :active-file="props.previewFile!" @rollback="(f) => emit('rollback', f)" @rollback-all="() => emit('rollbackAll')" @save="() => emit('save', '')"
        @preview="(f) => emit('preview', f)"
      />
    </div>
    <!-- 工作日志面板：内部自行按需拉取 /__ai/git/worklog -->
    <div v-show="sideTab === 'worklog'" class="side-worklog flex flex-col flex-1 min-h-0 overflow-hidden">
      <WorklogPane v-if="worklogLoaded" :active="sideTab === 'worklog'" />
    </div>
    <!-- [kb-panel-side-v1] 知识库面板：首切才加载（v-if 闸门触发 loader），之后 v-show 保活 -->
    <div v-show="sideTab === 'kb'" class="side-kb flex flex-col flex-1 min-h-0 overflow-y-auto">
      <KnowledgePanel v-if="kbLoaded" />
    </div>
    <!-- [terminal-panel-v1] 终端面板：首切才加载，之后 v-show 保活 -->
    <div v-show="sideTab === 'terminal'" class="side-terminal flex flex-col flex-1 min-h-0 overflow-hidden">
      <TerminalPanel v-if="terminalLoaded" />
    </div>
    <!-- [video-panel-v1] 视频生成面板：首切才加载，之后 v-show 保活 -->
    <div v-show="sideTab === 'video'" class="side-video flex flex-col flex-1 min-h-0 overflow-y-auto">
      <VideoGenerationPanel v-if="videoLoaded" />
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
/* [pane-side-base-v1] 面板基础布局：flex 列容器。
 * [WHY] 原先只有 .pane-side.is-collapsed 变体，没有基础规则 ⇒ aside 是块级流容器，
 *   内部 flex:1 的内容区拿不到高度来源，窄屏改为 position:fixed 后内容区直接塌陷为 0 高，
 *   表现就是「只有遮罩、面板一片空白」。
 * [CONSTRAINT] 必须 flex-direction: column：子项纵向堆叠（tabs 在上、内容在下）。 */
.pane-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
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

/* [cumulative-baseline-v1] 变更视图切换：常驻在列表上方，列表为空时也可用 */
/* [seg-control-v1] 单轨道分段控件：轨道 = surface-2 底 + 1px 边框，激活块 = 主色淡底 + 内阴影，
   与面板整体（surface）形成「凹槽 + 凸起选中块」的层级，不再像两个互相独立的按钮。 */
.view-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  align-self: flex-start;
  flex: 0 0 auto;
  padding: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
}
.seg-btn {
  padding: 3px 12px;
  font-size: var(--font-12);
  line-height: 16px;
  color: var(--text-3);
  background: transparent;
  border: 0;
  border-radius: var(--radius-6);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}
.seg-btn:hover {
  color: var(--text);
}
.seg-btn.active {
  color: var(--primary);
  background: var(--primary-bg);
  box-shadow: var(--shadow-sm);
}
.seg-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 6px 0 4px;
  font-size: var(--font-11);
  color: var(--text-3);
  white-space: nowrap;
}
.seg-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--radius-full);
  animation: spin 0.7s linear infinite;
}
</style>
