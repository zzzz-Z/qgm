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
// 侧栏拖拽已抽到 side-resize.ts
import { createSideResize } from './side-resize'
// exec 全流程已抽到 exec-flow.ts
import { createExecFlow } from './exec-flow'
// [multi-script-v1] 同一条回复还有排队脚本时抑制中途回传（见 pending-scripts.ts 的 CONSTRAINT）
import { pendingScriptCount } from '../../composables/ai/auto-loop/pending-scripts'
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

defineOptions({ name: 'ScriptPanel' })

// [diff-lazy-v1] DiffOverlay（含 DiffViewer/hljs 高亮链）仅预览文件时才异步加载
const DiffOverlay = defineAsyncComponent(() => import('../diff/DiffOverlay.vue'))
/** 活动的 */
/** 键 */
const SIDE_WIDTH_KEY = LS_SIDE_WIDTH_KEY
/** 侧栏默认宽度（像素） */
const SIDE_WIDTH_DEFAULT = 320
/** 差异 */
const SIDE_WIDTH_DIFF = 560
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
// ── 右侧面板 / 运行时长 / Diff 预览 / 列表 ref ──

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
/** 侧栏标签页 */
const sideTab = ref<'tree' | 'changes'>('tree')
/** 窄屏抽屉开合 */
const sideDrawerOpen = ref(false)
/** Diff 预览文件 */
const previewFile = ref<string | null>(null)
/** 差异预览：变更前内容 */
const previewBefore = ref<string | null>(null)
/** 差异预览：变更后内容 */
const previewAfter = ref<string>('')
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

/** 当前时间戳（用于刷新相对时间显示） */

// 组合式函数：toast 在 script 早段被使用，此处集中初始化
const { toast, confirmDialog } = useToast()
// U.3: CodeMirror 全家桶懒加载——首建编辑器时才 await import，CM 打进独立 chunk

// 已删 persistWarning：文件内无消费点
const { script, lastRunCode, running, result, changes, rolling, busyAll, liveStdout, liveStderr, doneSummary, run, stop, rollback, rollbackAll, save, autoFeedbackRequested, clearAutoFeedback, changeView, cumulativeLoading, cumulativeError, visibleChanges, setChangeView } = useRunner()
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
const { enabled: autoTakeoverEnabled, enable: enableAutoTakeover, disable: disableAutoTakeover, scheduleAutoRun, cancelAutoRun } = useAutoTakeover()
// ── 领域 composable ──
const { waiting: aiWaiting, startWaiting: startAiWaiting } = useAiWaiting()
const { events: busEvents } = useEventBus()
const { stripComments, stripBlankLines } = useCodeCleaner()
// [tw-removed-v1] 已删 useTwDisplay（打字机缓冲链）：twLines/twErrLines 解构后零消费，
//   twStdout/twStderr 也只被 TerminalPane 当作「有无输出」布尔用，逐字动画无真实消费者。
//   空态判定改为直接透传 useRunner 的 liveStdout / liveStderr。
const {
  loopState,
  isLoopActive,
  // [pause-resume-v1] 软暂停：不打断已发出的 fill，仅拦后续脚本与结果
  softPause,
  loopPaused,
  // [pause-resume-v1] 从暂停态恢复到 waiting（替代旧 exitPauseToIdle）
  resumeFromPause,
  // 无活跃循环时复位 softPause 残留
  clearSoftPause,
} = useAutoLoop()
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
// 预览/撤回（previewFile/Before/After 由本组件持有）
// [cumulative-baseline-v1] 这里传 visibleChanges（随视图切换）而非 changes：
//   getChangeType 与「改动前」内容的取用都必须跟面板显示的是同一套口径
const { getChangeType, onPreviewFile, onRollback, onRollbackAll } = createPreviewManager({
  changes: visibleChanges,
  result,
  previewFile,
  previewBefore,
  previewAfter,
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

const { copyOutput } = createExecFlow({
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
  isLoopActive,
})

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

// [loop-loading] 循环态统一触发等待 loading，确保从发问起有「等待 AI」提示
watch(loopState, (v, old) => {
  if ((v === 'waiting' || v === 'preparing') && v !== old) {
    startAiWaiting()
  }
})
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
  (len, prevLen) => {
    if (len === 0) {
      previewFile.value = null
      previewBefore.value = null
      previewAfter.value = ''
    }
    if (len > 0 && (!prevLen || prevLen === 0)) {
      sideTab.value = 'changes'
    }
  },
)
watch(sideTab, () => {
  if (resizingSide.value) return
  sideWidth.value = previewFile.value
    ? Math.max(sideWidthBase.value, SIDE_WIDTH_DIFF)
    : sideWidthBase.value
})
watch(previewFile, (v) => {
  if (resizingSide.value) return
  sideWidth.value = v
    ? Math.max(sideWidthBase.value, SIDE_WIDTH_DIFF)
    : sideWidthBase.value
})
watch(running, (v) => {
  if (v) {
    runStartAt = performance.now()
    statusText.value = '运行中…'
    statusClass.value = ''
    lastDuration.value = ''
    runningElapsed.value = '0.0s'
    // resume 等价 setInterval 启动；重复 resume 幂等（内部判断 isActive）
    resumeElapsed()
  } else if (result.value) {
    pauseElapsed()
    runningElapsed.value = ''
    const ms = performance.now() - runStartAt
    lastDuration.value = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
    // [multi-script-v1] 同一条 AI 回复还有排队脚本未跑完 → 本轮不做中途回传
    // [WHY] 批量脚本执行到一半就把中间结果塞给 AI，会在 AI 侧开启新一轮回复，
    //   与仍在排队/执行中的块互相踩踏；等队列清空后由最后一块统一回传。
    // [CONSTRAINT] 只在循环内生效：非循环路径没有队列概念，行为保持原样
    const midBatch = isLoopActive.value && pendingScriptCount.value > 0
    if (result.value.dryRunFailed) {
      statusText.value = '⚠ 预检失败 · 未落盘'
      statusClass.value = 'err'
      toast(
        `预检未通过：脚本本想改 ${result.value.dryRunChangeCount ?? 0} 个文件，已丢弃，磁盘零改动；错误已入 prompt`,
        'warn',
        5000,
      )
      if (midBatch) {
        // 队列未清空：等最后一块跑完统一回传，避免在批量中途把 AI 唤醒
      } else if (autoTakeoverEnabled.value) {
        scheduleAutoRun(() => { void copyOutput(autoFeedbackRequested.value) })
      } else {
        void copyOutput(autoFeedbackRequested.value)
      }
    } else {
      statusText.value = result.value.ok ? '✅ 成功' : '❌ 失败'
      statusClass.value = result.value.ok ? 'ok' : 'err'
      // autoAskOnResult: 失败或只读诊断（成功无改动、非循环）时延迟 3s 自动复制并发给 AI（主动停止除外）
      const isReadonlyProbe = isReadonlyResult(result.value, isLoopActive.value)
      const forceFeedback = autoFeedbackRequested.value
      const shouldAutoAsk
        = forceFeedback
          || autoTakeoverEnabled.value
          || !result.value.ok
          || isReadonlyProbe
          || result.value.tsc?.ok === false
          || result.value.lint?.ok === false
          || result.value.test?.ok === false
      if (shouldAutoAsk && !midBatch && result.value.error !== '已取消') {
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
  }
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
      />
      <!-- 编辑器 (下方) -->
      <ScriptEditor
        ref="editorRef"
        v-model="script"
        :is-loop-active="isLoopActive"
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
            :is-loop-active="isLoopActive"
            :loop-paused="loopPaused"
            :auto-takeover-enabled="autoTakeoverEnabled"
            :script="script"
            :attached-files-count="attachedFiles.length"
            :ai-waiting="aiWaiting"
            @clear-all="clearAll"
            @pause-all="pauseAll"
            @toggle-auto-takeover="toggleAutoTakeover"
          />
        </template>
        <template #attach-bar>
          <ScriptAttachBar :files="attachedFiles" @remove="removeAttach" />
        </template>
      </ScriptEditor>

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

    <DiffOverlay
      v-if="visibleChanges.length && previewFile && previewBefore !== null"
      :file-name="previewFile"
      :before="previewBefore"
      :after="previewAfter"
      :change-type="getChangeType(previewFile)"
      @close="previewFile = null"
    />
  </div>
</template>

<style scoped lang="scss" src="./script-panel.scss"></style>
