<script setup lang="ts">
// append* 系列已抽到 prompt-builder.ts

// 命令历史簇
import { createCmdHistory } from './cmd-history'
// 附件簇已抽到 attach-manager.ts
import { createAttachManager } from './attach-manager'
import type { AttachedFile } from './attach-manager'
// 树/目录/脚本拼装
import { createTreeAttach } from './tree-attach'
// 预览/撤回/变更类型已抽到 preview-manager.ts
import { createPreviewManager } from './preview-manager'
// [preview-diff-v1] 预览的变更类型直接复用面板同一套类型（避免本地再写一份字面量联合）
import type { ChangeType } from '../../types'
// 侧栏拖拽已抽到 side-resize.ts
import { createSideResize } from './side-resize'
// exec 全流程已抽到 exec-flow.ts
import { createExecFlow } from './exec-flow'
// [loop-consolidation-P3a] 原 roundMergePending（循环内轮末合并窗信号）随 auto-loop 退役；
//   留存路径的回传窗信号是 feedbackPending（feedback-merge 的 onFeedbackPending 回调）。
// 组件内定时器统一走 vueuse：随组件卸载自动清理，省去手动 clear
// [script-panel-utils-v2-extracted]
import TerminalPane from './TerminalPane.vue'
import ScriptEditor from './ScriptEditor.vue'
import ScriptToolbar from './ScriptToolbar.vue'
import ScriptAttachBar from './ScriptAttachBar.vue'
import { useScriptPanelActions } from './script-panel-actions'
import SidePane from '../panels/SidePane.vue'
// 左侧常驻多窗口面板
import AiWindowList from '../panels/AiWindowList.vue'
// [eventbus-name-clash-v1] 显式 import：与 @vueuse/core 的 useEventBus 同名，已在 vite
//   AutoImport.ignore 中屏蔽 auto-import 源，此处必须显式引入（tsc/vitest 无该插件）。
import { useEventBus } from '../../composables/ui/useEventStream'

defineOptions({ name: 'ScriptPanel' })

// [content-preview-lazy-v1] FileContentOverlay（含 hljs 高亮链）仅预览文件时才异步加载
const FileContentOverlay = defineAsyncComponent(() => import('../diff/FileContentOverlay.vue'))
/** 活动的 */
/** 键 */
const SIDE_WIDTH_KEY = LS_SIDE_WIDTH_KEY
/** 侧栏默认宽度（像素） */
const SIDE_WIDTH_DEFAULT = 320
// [side-width-stable-v1] 侧栏宽度**只由用户拖拽决定**（sideWidthBase ←→ localStorage），
//   不随「打开内容预览 / 切 tab」自动变化 —— 2026-10-09 用户指定：显示弹窗时 sidebar 宽度不要变化。
//   [WHY] 原先的 SIDE_WIDTH_DIFF=560 是「行级 diff 内嵌在侧栏」时代的配套动作：要看清 diff 得把侧栏撑宽。
//     预览早已改为独立浮层（FileContentOverlay，960px 宽），侧栏不再需要让位；留下的自动加宽只表现为
//     「一点文件列表，右侧面板就跳宽/回缩」，把用户自己拖好的宽度冲掉（截图取证）。
//   [CONSTRAINT] 宽度写入只允许两条路径：side-resize.ts 的拖拽、onMounted 的 localStorage 回填。
let runStartAt = 0
/** 编辑器 */
const editorRef = ref<{ insertText: (t: string) => void } | null>(null)
// ── 主状态 ref ──

const lastRunScript = ref('')
/** 技能列表 */
/** 技能加载中 */
/** 已选中技能名 */
/** 用户补充说明面板开关 */
/** 是否已复制到剪贴板 */
const copied = ref(false)
/** 附件拖入成功遮罩 */
const fileSuccess = ref(false)
/** 主区 DOM 引用 */
const mainRef = ref<HTMLElement | null>(null)
// ── 右侧面板 / 运行时长 / 内容预览 / 列表 ref ──

/** 面板引用 */
const paneRef = ref<HTMLElement | null>(null)
/** 当前侧栏宽度（像素） */
const sideWidth = ref(SIDE_WIDTH_DEFAULT)
/** 侧栏拖动起始宽度（像素） */
const sideWidthBase = ref(SIDE_WIDTH_DEFAULT)
/** 是否正在拖动侧栏 */
const resizingSide = ref(false)
/** 上次运行时长（显示用） */
const lastDuration = ref('')
/** 命令已运行秒数 */
const runningElapsed = ref('')
/** 当前正在执行的命令 */
const runningCommand = ref('')
/** 窄屏抽屉开合 */
const sideDrawerOpen = ref(false)
/** 预览中的文件路径 */
const previewFile = ref<string | null>(null)
// ── [preview-diff-v1] 预览数据：diff 需要**两侧**内容，不再只有「变更后」 ──
/** 预览的变更类型（决定 diff 口径：新增/删除不看另一侧，修改要两侧） */
const previewType = ref<ChangeType>('modified')
/** 变更后内容（当前磁盘内容） */
const previewAfter = ref<string>('')
/** 变更前内容（归属轮运行前快照） */
const previewBefore = ref<string>('')
/** [preview-diff-v1] 变更前快照缺失（git 基准 / 快照被回收）⇒ 只有上下文行，弹窗须显式说明 */
const previewBaselineMissing = ref(false)
/** 内容拉取中 */
const previewLoading = ref(false)
/** 树展开的 stream id 集合 */
const treeExpanded = ref<Set<number>>(new Set())
// ── 附件 / 命令历史 / 滚动 ref ──

/* [attachments] 附件：粘贴图片 / 拖文件 → tag 展示；发送时文本内容拼入脚本 */
/** 附件列表 */
const attachedFiles = ref<AttachedFile[]>([])
// ── 状态栏 ref ──

/** 状态文本（短暂提示，如「已发送」） */
const statusText = ref('')
/** 状态样式类（ok/err） */
const statusClass = ref('')
/**
 * [deliver-window-v1] 非循环自动回传合并窗内是否还有待出站结果。
 * [WHY] 由 exec-flow 的 feedbackMerge 经 onFeedbackPending 回调驱动（feedback-merge 刻意零 vue 依赖）。
 */
const feedbackPending = ref(false)

/** 当前时间戳（用于刷新相对时间显示） */

// 组合式函数：toast 在 script 早段被使用，此处集中初始化
const { toast, confirmDialog } = useToast()
// U.3: CodeMirror 全家桶懒加载——首建编辑器时才 await import，CM 打进独立 chunk

// 已删 persistWarning：文件内无消费点
const { script, lastRunCode, running, result, changes, rolling, busyAll, liveStdout, liveStderr, doneSummary, run, rollback, rollbackAll, save, autoFeedbackRequested, clearAutoFeedback, changeView, cumulativeLoading, cumulativeError, visibleChanges, setChangeView } = useRunner()
/**
 * [cumulative-baseline-v1] 视图切换的写入口必须收敛到 useRunner.setChangeView
 * [WHY] 若把 v-model 直接绑到 changeView，切换只改了值、不触发累积拉取——面板会停在上一次的
 *   累计上且没有任何报错。用可写 computed 做单一入口，也让「切换即加载」能在 node 测试里断言。
 */
const changeViewProxy = computed<'round' | 'cumulative'>({
  get: () => changeView.value,
  set: (v) => { setChangeView(v) },
})
// 已删除 countdown（延迟机制移除）
const { enabled: autoTakeoverEnabled, scheduleAutoRun } = useAutoTakeover()
// ── 领域 composable ──
// [loop-consolidation-P3b] softPause / loopPaused 已迁至 useAiWaiting（随 auto-loop 退役）
const { waiting: aiWaiting, startWaiting: startAiWaiting, softPause, loopPaused } = useAiWaiting()
const { events: busEvents } = useEventBus()
const { stripComments, stripBlankLines } = useCodeCleaner()
// [tw-removed-v1] 已删 useTwDisplay（打字机缓冲链）：twLines/twErrLines 解构后零消费，
//   twStdout/twStderr 也只被 TerminalPane 当作「有无输出」布尔用，逐字动画无真实消费者。
//   空态判定改为直接透传 useRunner 的 liveStdout / liveStderr。
// [loop-consolidation-P3b] 摘除 loopState（原从 useAutoLoop 取，恒 idle ⇒ watch 永不触发）
/**
 * [deliver-window-v1] 「脚本已跑完、结果还没发出去」的回传窗是否开著。
 * [WHY] 两条路径各有一段静默窗：循环路径 ROUND_MERGE_MS(1500ms)、非循环自动回传
 *   AUTO_FEEDBACK_MERGE_MS(3000ms)。这两段此前**零可视化**——running 已 false、
 *   startAiWaiting 又被挪到 flush 时点，界面上就是「显示成功 → 几秒空白 → 突然发出去」。
 * [CONSTRAINT] 只读派生，不反写两个窗；计时与 spinner 都按「含回传窗」口径走。
 */
const delivering = computed(() => feedbackPending.value)
/** 含回传窗的忙碌口径：脚本执行中 + 结果等待出站 */
const busyOrDelivering = computed(() => running.value || delivering.value)
// 运行计时器：组件级 scope，卸载自动清理（等价原 onBeforeUnmount clearInterval）
const { pause: pauseElapsed, resume: resumeElapsed } = useIntervalFn(() => {
  const s = (performance.now() - runStartAt) / 1000
  runningElapsed.value = `${s.toFixed(1)}s`
}, 100, { immediate: false })
// fileSuccess 闪烁复位：1500ms 后置 false；重复 start 内部自动重启
const { start: scheduleFileSuccessReset } = useTimeoutFn(() => {
  fileSuccess.value = false
}, 1500, { immediate: false })

// [factory-after-refs] 领域工厂在上方 refs / composables 之后初始化
// WHY: 工厂入参（script/attachedFiles/paneRef/previewFile/softPause…）是上方声明的 const 绑定，
//   提前引用会命中 TDZ，组件初始化即抛 ReferenceError
// 命令历史簇
const { pushCmdHistory, cmdHistoryPrev, cmdHistoryNext } = createCmdHistory({ script })
// 附件簇（attachedFiles 由本组件持有，供 addTreePaths 等共享）
const { removeAttach, clearAll, onEditorPaste, onDesktopDrop } = createAttachManager({ attachedFiles, script, fileSuccess })
// 树拖入 / 目录展开 / 脚本拼装（attachedFiles 由本组件持有）
// [ui-p2a-drag-bus-wire-v1] V12：drop 通道改显式订阅；ai-runner:auto-run 全局无派发方，dead 监听一并删除
const { registerTreeDrop, buildPromptWithAttachments } = createTreeAttach({ attachedFiles })
/** V12 显式通道取消订阅句柄；onMounted 赋值、onBeforeUnmount 释放 */
let unsubscribeTreeDrop: (() => void) | undefined
// 预览/撤回（previewFile/previewType/previewBefore/previewAfter/previewLoading 由本组件持有）
// [cumulative-baseline-v1] 这里传 visibleChanges（随视图切换）而非 changes：
//   面板显示的是哪套变更集，预览取内容就必须跟同一套口径（含 deleted 的归属轮 runId）
const { onPreviewFile, onRollback, onRollbackAll, closePreview } = createPreviewManager({
  changes: visibleChanges,
  result,
  previewFile,
  previewType,
  previewBefore,
  previewAfter,
  previewBaselineMissing,
  previewLoading,
  rollback,
  rollbackAll,
})
// 侧栏拖拽（paneRef/sideWidth/sideWidthBase/resizingSide 由本组件持有）
const { onSideDown, dispose: disposeSideResize } = createSideResize({
  paneRef,
  sideWidth,
  sideWidthBase,
  resizingSide,
  persistWidth: (w) => { try { localStorage.setItem(SIDE_WIDTH_KEY, String(w)) } catch { /* ignore */ } },
})
// exec 全流程（refs 由本组件持有）
// [use-script-panel-actions-wired-v1] 运行逻辑簇已抽到 useScriptPanelActions；先装配后注入 createExecFlow
// [use-script-panel-actions-wired-v2] toggleAutoTakeover / pauseAll 亦下沉到 composable
// [ui-p2a-drag-bus-wire-consumer-v1] V12：onAutoRun 死变量删除（全仓无 ai-runner:auto-run 派发方）
const {
  buildAiPrompt,
  runSmart,
  onGlobalKey,
  toggleAutoTakeover,
  pauseAll,
} = useScriptPanelActions({
  script,
  attachedFiles,
  result,
  changes,
  running,
  runningCommand,
  lastRunScript,
  stripComments,
  stripBlankLines,
  autoTakeoverEnabled,
  scheduleAutoRun,
  run,
  startAiWaiting,
  buildPromptWithAttachments,
})

const { copyOutput, feedbackMerge } = createExecFlow({
  running,
  result,
  changes,
  liveStdout,
  liveStderr,
  copied,
  runningCommand,
  pushCmdHistory,
  buildAiPrompt,
  confirmDialog,
  startAiWaiting,
  softPause,
  // [deliver-window-v1] 回传窗开关 → 面板的 delivering 状态
  onFeedbackPending: (v) => { feedbackPending.value = v },
})
// [auto-feedback-merge-v1] 组件卸载时撤合并窗：缓冲里的未发结果随面板销毁丢弃，
//   防止卸载后迟到出站（flush 的 isActive 守卫只挡循环接管，挡不了组件已销毁）。

// 分栏比例（终端占比）

/* 自动展开最后一个 ai:stream */
/** 最后一个流标识 */
const lastStreamId = computed(() => {
  const ev = busEvents.value
  for (let i = ev.length - 1; i >= 0; i--) {
    if (ev[i].kind === 'ai:stream') return ev[i].id
  }
  return 0
})

// [user-run-wait] 点运行 → 立即置“等待 AI 回复”loading

// [loop-consolidation-P3b] 摘除 watch(loopState)：循环状态恒 idle，该 loading 触发条件不可达；
//   「等待 AI」提示由 runSmart / copyOutput 的 startAiWaiting 直接承担。
watch(lastStreamId, (id) => {
  if (!id) return
  const s2 = new Set(treeExpanded.value)
  if (!s2.has(id)) {
    s2.add(id)
    treeExpanded.value = s2
  }
})
watch(
  () => visibleChanges.value.length,
  (len) => {
    // [side-width-stable-v1] 这里原先还有一句 `sideTab.value = 'changes'`（变更出现时切到变更 tab）：
    //   ScriptPanel 的 sideTab 是**本地 ref、从未绑定给 SidePane**（SidePane 的 tab 由
    //   useSidePaneTab + useFoldState 自己管）⇒ 那句赋值一直是空转，宽度联动删掉后一并清除。
    //   若日后真要「变更出现自动切 tab」，正确入口是 useSidePaneTab 的 sidePaneTab + reveal tick。
    if (len === 0) closePreview()
  },
)
/**
 * 脚本跑完的结果分支：成功/失败文案 + 自动回传判定。
 * [deliver-window-v1] 计时收口**不在这里**（见下方 watch(busyOrDelivering)）：
 *   脚本跑完 ≠ 本轮结束，回传窗那几秒同样算「执行中」。
 */
function handleRunResult(): void {
  const r = result.value
  if (!r) return
  // [loop-consolidation-P2] 摘除 midBatch：原为「循环内队列未清空时抑制中途回传」，
  //   isLoopActive 恒 false ⇒ 该守卫失效。pendingScriptCount 属循环内队列信号，留存路径无队列概念。
  if (r.dryRunFailed) {
    // [ui-icon-discipline-v1] chrome 层去 emoji：语义由 statusClass 承担（'err' 已上色）
    statusText.value = '预检失败 · 未落盘'
    statusClass.value = 'err'
    toast(
      `预检未通过：脚本本想改 ${r.dryRunChangeCount ?? 0} 个文件，已丢弃，磁盘零改动；错误已入 prompt`,
      'warn',
      5000,
    )
    if (autoTakeoverEnabled.value) {
      scheduleAutoRun(() => { void copyOutput(autoFeedbackRequested.value) })
    } else {
      void copyOutput(autoFeedbackRequested.value)
    }
    return
  }
  // [ui-icon-discipline-v1] 同上：成功/失败由 statusClass('ok'/'err') 上色表达
  statusText.value = r.ok ? '成功' : '失败'
  statusClass.value = r.ok ? 'ok' : 'err'
  // autoAskOnResult: 失败或只读诊断（成功无改动、非循环）时延迟 3s 自动复制并发给 AI（主动停止除外）
  // [loop-consolidation-P2] isLoopActive 恒 false（非循环路径始终按非循环口径判定只读）
  const isReadonlyProbe = isReadonlyResult(r, false)
  const forceFeedback = autoFeedbackRequested.value
  const shouldAutoAsk
    = forceFeedback
      || autoTakeoverEnabled.value
      || !r.ok
      || isReadonlyProbe
      || r.tsc?.ok === false
      || r.lint?.ok === false
      || r.test?.ok === false
  // [loop-feedback-authority-v2] 循环活动时回传权归循环引擎，ScriptPanel 一律不再发：
  //   本块执行完时循环引擎也会发（且已按队列是否清空合并成一次），两处都发即为同轮双发。
  if (shouldAutoAsk && r.error !== '已取消') {
    if (forceFeedback) clearAutoFeedback()
    if (autoTakeoverEnabled.value) scheduleAutoRun(() => { void copyOutput(forceFeedback) })
    else void copyOutput(forceFeedback)
  }
  // 清空编辑区模式：脚本快照从 lastRunScript 取（script 已清空）
  const scriptSnapshot = lastRunCode.value || lastRunScript.value || script.value
  // 把跑过的脚本记为「已消费」，让后续 AI 回填能直接覆盖（不误伤手动编辑）
  setLastAutoFilled(scriptSnapshot)
  // 已删 desc/why/lang/hash 块：grep 证实在文件内无第二消费点
}

watch(running, (v) => {
  if (v) {
    runStartAt = performance.now()
    statusText.value = '运行中…'
    statusClass.value = ''
    lastDuration.value = ''
    runningElapsed.value = '0.0s'
    // resume 等价 setInterval 启动；重复 resume 幂等（内部判断 isActive）
    resumeElapsed()
    return
  }
  handleRunResult()
})

/**
 * [deliver-window-v1] 计时收口：脚本执行完 **且** 回传窗已收口 才算本轮跑完。
 * [WHY] 循环路径有 ROUND_MERGE_MS(1500ms)、非循环自动回传有 AUTO_FEEDBACK_MERGE_MS(3000ms)
 *   两段静默窗；此前计时在 running 落 false 的那一刻就停，界面显示「成功」而结果还没发出去。
 * [CONSTRAINT] runStartAt 归零后才允许重算，避免「从未起跑」时把 0 当起点算出巨大耗时。
 */
watch(busyOrDelivering, (v) => {
  if (v) return
  pauseElapsed()
  runningElapsed.value = ''
  if (!runStartAt) return
  const ms = performance.now() - runStartAt
  lastDuration.value = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
  runStartAt = 0
})

onMounted(() => {
  try {
    const savedW = localStorage.getItem(SIDE_WIDTH_KEY)
    if (savedW) {
      const n = Number(savedW)
      if (Number.isFinite(n)) {
        sideWidthBase.value = Math.max(280, n)
        sideWidth.value = sideWidthBase.value
      }
    }
  } catch { /* ignore */ }

  unsubscribeTreeDrop = registerTreeDrop()
  window.addEventListener('keydown', onGlobalKey)
})
onBeforeUnmount(() => {
  disposeSideResize()
  // elapsedTimer 已由 useIntervalFn 内部在组件卸载时自动 pause，无需手动清理
  // [auto-feedback-merge-v1] 撤合并窗：防组件销毁后缓冲迟到出站
  feedbackMerge.cancel()

  unsubscribeTreeDrop?.()
  window.removeEventListener('keydown', onGlobalKey)
})

/**
 * 拖拽悬停：阻止默认行为以允许 drop 事件
 * [CONSTRAINT] 必须 preventDefault，否则浏览器默认在新标签页打开拖入的文件
 */
function onHtmlDragOver(e: DragEvent) {
  e.preventDefault()
}
/**
 * 处理从桌面拖入的文件：把文件名以注释形式插入编辑器
 * [WHY] 只插文件名注释，不读文件内容 —— 内容由用户后续通过附件功能引入
 * [CONSTRAINT] editorRef 为空时回落到 script.value 直接拼接；fileSuccess 标志 1.5s 后自动清除
 */
function onHtmlDrop(e: DragEvent) {
  e.preventDefault()
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  const text = files.map(f => `// 📄 ${f.name}`).join('\n')
  const view = editorRef.value
  if (view) {
    view.insertText(text)
  } else {
    script.value += text
  }
  fileSuccess.value = true
  scheduleFileSuccessReset()
}
</script>

<template>
  <div ref="paneRef" class="bg-\[var\(--bg\)\] flex pane h-screen overflow-hidden" :class="{ 'is-resizing-side': resizingSide }">
    <!-- 左侧常驻：多 AI 窗口列表（展示 + 激活切换） -->
    <AiWindowList />
    <!-- [ui-responsive-v1] 窄屏抽屉触发钮：≤1100px 显示（桌面端 scss 隐藏），
         把右侧面板从文档流列变为可滑入浮层，修复窄屏主区被挤成细条（F1）。
         此前 sideDrawerOpen 是**死状态**（声明后零写入）。 -->
    <button
      type="button"
      class="side-drawer-trigger"
      aria-label="打开右侧面板"
      :aria-expanded="sideDrawerOpen"
      @click="sideDrawerOpen = !sideDrawerOpen"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
    <!-- 左侧主区域 -->
    <div
      ref="mainRef" class="flex flex-col pane-main flex-1 min-w-0 overflow-hidden" :class="{ 'is-success': fileSuccess }"
      @dragover="onHtmlDragOver" @drop="onHtmlDrop"
    >
      <!-- 终端 (上方) -->
      <TerminalPane
        :running="running"
        :live-stdout="liveStdout"
        :live-stderr="liveStderr"
        :done-summary="doneSummary"
        :ai-waiting="aiWaiting"
        :delivering="delivering"
      />
      <!-- 编辑器 (下方) -->
      <ScriptEditor
        ref="editorRef"
        v-model="script"
        :is-running="running"
        :on-run="() => { void runSmart() }"
        :on-history-prev="cmdHistoryPrev"
        :on-history-next="cmdHistoryNext"
        @paste="onEditorPaste"
        @drop="onDesktopDrop"
      >
        <template #action-bar>
          <ScriptToolbar
            :running="running"
            :loop-paused="loopPaused"
            :auto-takeover-enabled="autoTakeoverEnabled"
            :script="script"
            :attached-files-count="attachedFiles.length"
            :ai-waiting="aiWaiting"
            :delivering="delivering"
            @clear-all="clearAll"
            @pause-all="pauseAll"
            @toggle-auto-takeover="toggleAutoTakeover"
          />
        </template>
        <template #attach-bar>
          <ScriptAttachBar :files="attachedFiles" @remove="removeAttach" />
        </template>
      </ScriptEditor>

      <!-- [status-bar-v1] 执行状态条：接入此前零渲染出口的 statusText/statusClass/runningElapsed/lastDuration -->
      <div
        v-if="statusText || runningElapsed || lastDuration"
        class="status-bar text-11px px-12px py-4px flex gap-8px items-center"
        :class="statusClass === 'err' ? 'text-red-400' : statusClass === 'ok' ? 'text-green-400' : 'text-[var(--text-3)]'"
      >
        <span v-if="statusText">{{ statusText }}</span>
        <span v-if="runningElapsed" class="font-mono">{{ runningElapsed }}</span>
        <span v-else-if="lastDuration" class="font-mono opacity-70">耗时 {{ lastDuration }}</span>
      </div>

      <div v-if="fileSuccess" class="overlay success">
        <div class="overlay-card success">
          <div class="overlay-icon">
            ✓
          </div>

          <div class="overlay-text">
            已插入
          </div>
        </div>
      </div>
    </div>

    <!-- 拖拽条：调整右侧面板宽度 -->
    <div
      v-tooltip="'拖拽调整右侧面板宽度'" class="side-resize-handle" :class="{ active: resizingSide }"
      @pointerdown="onSideDown"
    />

    <!-- 右侧：变更列表 & Diff -->
    <!-- SIDE_VIF_CHANGES -->
    <SidePane
      v-model:side-drawer-open="sideDrawerOpen"
      v-model:change-view="changeViewProxy"
      :side-width="sideWidth"
      :changes="visibleChanges"
      :cumulative-loading="cumulativeLoading"
      :cumulative-error="cumulativeError"
      :rolling="rolling"
      :busy-all="busyAll"
      :preview-file="previewFile"
      :result="result"
      @rollback="onRollback"
      @rollback-all="onRollbackAll"
      @save="save"
      @preview="onPreviewFile"
    />

    <!-- [preview-diff-v1] 变更预览浮层：展示该文件变更前后的行级 diff（新增 / 删除） -->
    <FileContentOverlay
      v-if="previewFile"
      :file-name="previewFile"
      :before="previewBefore"
      :after="previewAfter"
      :change-type="previewType"
      :baseline-missing="previewBaselineMissing"
      :loading="previewLoading"
      @close="closePreview"
    />
  </div>
</template>

<style scoped lang="scss" src="./script-panel.scss"></style>
