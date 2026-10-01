<template>
  <div ref="paneRef" class="bg-\[var\(--bg\)\] flex pane h-screen overflow-hidden" :class="{ 'is-resizing-side': resizingSide }">
    <!-- [ai-window-list-v1] 左侧常驻：多 AI 窗口列表（展示 + 激活切换） -->
    <AiWindowList />
    <!-- 左侧主区域 -->
    <div
      ref="mainRef" class="flex flex-col pane-main flex-1 min-w-0 overflow-hidden" :class="{ 'is-success': fileSuccess }"
      @dragover="onHtmlDragOver" @drop="onHtmlDrop"
    >
      <!-- 终端 (上方) -->
      <TerminalPane
        :running="running"
        :tw-stdout="twStdout"
        :tw-stderr="twStderr"
        :tw-lines="twLines"
        :tw-err-lines="twErrLines"
        :done-summary="doneSummary"
        :line-class="lineClass"
        :ai-waiting="aiWaiting"
        @apply-template="applyTemplate"
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
        <AbnormalView :result="result" />
        <template #action-bar>
          <ScriptToolbar
            :running="running"
            :is-loop-active="isLoopActive"
            :loop-paused="loopPaused"
            :auto-takeover-enabled="autoTakeoverEnabled"
            :script="script"
            :attached-files-count="attachedFiles.length"
            :ai-waiting="aiWaiting"
            @apply-template="applyTemplate"
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
      ref="sidePaneRef"
      v-model:side-drawer-open="sideDrawerOpen"
      :side-width="sideWidth"
      :changes="changes"
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
      v-if="changes.length && previewFile && previewBefore !== null"
      :file-name="previewFile"
      :before="previewBefore"
      :after="previewAfter"
      :change-type="getChangeType(previewFile)"
      @close="previewFile = null"
    />
  </div>
</template>

<script setup lang="ts">
import { lineClass } from './output-utils'
// [prompt-builder-v1] append* 系列已抽到 prompt-builder.ts
import {
  appendBaselineChanges,
  appendChangeList,
  appendClaimMismatch,
  appendDryRunFailure,
  appendFailedSourceFiles,
  appendFeedbackSummary,
  appendLintReport,
  appendRawOutputs,
  appendSmokeReport,
  appendTestReport,
  appendTscReport,
  trimPromptIfOverBudget,
} from './prompt-builder'
// [cmd-history-v1] 命令历史簇
import { createCmdHistory } from './cmd-history'
// [attach-manager-v1] 附件簇已抽到 attach-manager.ts
import { createAttachManager } from './attach-manager'
import type { AttachedFile } from './attach-manager'
// [tree-attach-v1] 树/目录/脚本拼装
import { createTreeAttach } from './tree-attach'
// [preview-manager-v1] 预览/撤回/变更类型已抽到 preview-manager.ts
import { createPreviewManager } from './preview-manager'
// [side-resize-v1] 侧栏拖拽已抽到 side-resize.ts
import { createSideResize } from './side-resize'
// [exec-flow-v1] exec 全流程已抽到 exec-flow.ts
import { createExecFlow } from './exec-flow'
// [vueuse-timers-v1] 组件内定时器统一走 vueuse：随组件卸载自动清理，省去手动 clear
import { useIntervalFn, useTimeoutFn } from '@vueuse/core'
// [script-panel-utils-v2-extracted]
import { useTwDisplay } from '../../composables/ui/useTwDisplay'
import TerminalPane from './TerminalPane.vue'
import ScriptEditor from './ScriptEditor.vue'
// [abnormal-mount-v1]
import AbnormalView from '../panels/AbnormalView.vue'
import ScriptToolbar from './ScriptToolbar.vue'
import ScriptAttachBar from './ScriptAttachBar.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRunner } from '../../composables/runner/useRunner'
import { useAutoLoop } from '../../composables/ai/useAutoLoop'
import { useAiWaiting } from '../../composables/ai/useAiWaiting'
import { copyAndFill } from '../../composables/ai/useAiWindow'
import { useAutoTakeover } from '../../composables/ai/useAutoTakeover'
import { emit as emitBus, useEventBus } from '../../composables/ui/useEventStream'
import { useCodeCleaner } from '../../composables/runner/useCodeCleaner'
import { LS_SIDE_WIDTH_KEY } from '../../utils/storage'
import { isReadonlyResult } from '../../composables/runner/useRunFeedback'
import { parseErrorLocations } from '../../utils/contextBuilder'
import { useToast } from '../../composables/ui/useToast'
import { setLastAutoFilled } from '../../composables/runner/useScriptInbox'
import SidePane from '../panels/SidePane.vue'
// [ai-window-list-v1] 左侧常驻多窗口面板
import AiWindowList from '../panels/AiWindowList.vue'
import DiffOverlay from '../diff/DiffOverlay.vue'

defineOptions({ name: 'ScriptPanel' })

/** 活动的 */
/** 键 */
const SIDE_WIDTH_KEY = LS_SIDE_WIDTH_KEY
/** 侧栏默认宽度（像素） */
const SIDE_WIDTH_DEFAULT = 320
/** 差异 */
const SIDE_WIDTH_DIFF = 560

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
let runStartAt = 0
/** 侧栏标签页 */
const sideTab = ref<'tree' | 'changes'>('tree')
/** 窄屏抽屉开合 */
const sideDrawerOpen = ref(false)
// [side-tab-facade-v1] 供 App.vue header 按钮触达 SidePane 的 selectTab
// [WHY] 用户要求工作日志入口从弹窗改为侧栏 tab；父组件需通过 ref 调子组件方法，无需新增事件总线
// [CONSTRAINT] SidePane 未挂载（如无工作区）时 sidePaneRef.value 为 null，需静默兜底
// [CHANGE-IMPACT] 依赖 SidePane 的 defineExpose({ selectTab })
const sidePaneRef = ref<{ selectTab: (t: 'tree' | 'changes' | 'worklog') => void } | null>(null)

/** 打开侧栏并切到指定 tab；侧栏已收起时自动展开 */
function openSideTab(tab: 'tree' | 'changes' | 'worklog'): void {
  sideDrawerOpen.value = true
  sidePaneRef.value?.selectTab(tab)
}

// [side-tab-facade-v1] 对外暴露给 App.vue 的 header 按钮使用
defineExpose({ openSideTab })
/** Diff 预览文件 */
const previewFile = ref<string | null>(null)
/** 差异预览：变更前内容 */
const previewBefore = ref<string | null>(null)
/** 差异预览：变更后内容 */
const previewAfter = ref<string>('')
/** 终端聊天列表 DOM 引用 */
const chatListRef = ref<HTMLElement | null>(null)
/** 树展开的 stream id 集合 */
const treeExpanded = ref<Set<number>>(new Set())

// ── 附件 / 命令历史 / 滚动 ref ──

/* [attachments] 附件：粘贴图片 / 拖文件 → tag 展示；发送时文本内容拼入脚本 */
/** 附件列表 */
const attachedFiles = ref<AttachedFile[]>([])
/** 终端自动滚动开关 */
const autoScroll = ref(true)

/** 滚动锁时间戳（防高频 scrollTo） */
let _scrollLock = 0

// ── 状态栏 ref ──

/** 状态文本（短暂提示，如「已发送」） */
const statusText = ref('')
/** 状态样式类（ok/err） */
const statusClass = ref('')
/** 当前时间戳（用于刷新相对时间显示） */

// 组合式函数：toast 在 script 早段被使用，此处集中初始化
const { toast, confirmDialog } = useToast()
// U.3: CodeMirror 全家桶懒加载——首建编辑器时才 await import，CM 打进独立 chunk

// [unused-cleanup-v1] 已删 persistWarning：文件内无消费点
const { script, lastRunCode, running, result, changes, rolling, busyAll, liveStdout, liveStderr, doneSummary, run, stop, rollback, rollbackAll, save, autoFeedbackRequested, clearAutoFeedback } = useRunner()
// [no-delay-v2] 已删除 countdown（延迟机制移除）
const { enabled: autoTakeoverEnabled, enable: enableAutoTakeover, disable: disableAutoTakeover, scheduleAutoRun, cancelAutoRun } = useAutoTakeover()
// [cmd-history-v1] 命令历史簇
const { pushCmdHistory, cmdHistoryPrev, cmdHistoryNext } = createCmdHistory({ script })
// [attach-manager-v1] 附件簇（attachedFiles 由本组件持有，供 addTreePaths 等共享）
const { removeAttach, clearAll, onEditorPaste, onDesktopDrop } = createAttachManager({ attachedFiles, script, fileSuccess })
// [tree-attach-v1] 树拖入 / 目录展开 / 脚本拼装（attachedFiles 由本组件持有）
const { onTreeDrop, buildPromptWithAttachments } = createTreeAttach({ attachedFiles })
// [preview-manager-v1] 预览/撤回（previewFile/Before/After 由本组件持有）
const { getChangeType, onPreviewFile, onRollback, onRollbackAll } = createPreviewManager({
  changes,
  result,
  previewFile,
  previewBefore,
  previewAfter,
  rollback,
  rollbackAll,
})
// [side-resize-v1] 侧栏拖拽（paneRef/sideWidth/sideWidthBase/resizingSide 由本组件持有）
const { onSideDown, dispose: disposeSideResize } = createSideResize({
  paneRef,
  sideWidth,
  sideWidthBase,
  resizingSide,
  persistWidth: (w) => { try { localStorage.setItem(SIDE_WIDTH_KEY, String(w)) } catch { /* ignore */ } },
})

// ── 领域 composable ──
// [unused-cleanup-v1] 已删 maybeRotateSession：文件内无消费点
const { waiting: aiWaiting, startWaiting: startAiWaiting } = useAiWaiting()
const { events: busEvents } = useEventBus()
const { stripComments, stripBlankLines } = useCodeCleaner()

// [script-panel-tw-extracted-v1] 初始化打字机
const { twStdout, twStderr, twLines, twErrLines } = useTwDisplay(liveStdout, liveStderr)
const {
  loopState,
  isLoopActive,
  // [sp-autopause-v1] 回车/发送后进入暂停态：暴露 loopPaused 与 requestPause
  requestPause,
  // [soft-pause-v1] 发送给 AI 后软暂停（不发 stop、不静音，避免取消刚发出的 fill）
  softPause,
  // [loop-paused-toggle-v1] 真暂停/恢复
  loopPaused,
  // [pause-to-idle-v2] 暂停点击 = 完全结束循环，回到待发状态（不再软恢复等待）
  exitPauseToIdle,
  // [sp-send-after-softpause-v1] 无活跃循环时复位 softPause 残留
  clearSoftPause,
} = useAutoLoop()
// [vueuse-timers-v1] 运行计时器：组件级 scope，卸载自动清理（等价原 onBeforeUnmount clearInterval）
const { pause: pauseElapsed, resume: resumeElapsed } = useIntervalFn(() => {
  const s = (performance.now() - runStartAt) / 1000
  runningElapsed.value = `${s.toFixed(1)}s`
}, 100, { immediate: false })

// [vueuse-timers-v1] fileSuccess 闪烁复位：1500ms 后置 false；重复 start 内部自动重启
const { start: scheduleFileSuccessReset } = useTimeoutFn(() => {
  fileSuccess.value = false
}, 1500, { immediate: false })

// [exec-flow-v1] exec 全流程（refs 由本组件持有）
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
})

// [user-run-wait] 点运行 → 立即置“等待 AI 回复”loading

// [loop-loading] 循环态统一触发等待 loading，确保从发问起有「等待 AI」提示
watch(loopState, (v, old) => {
  if ((v === 'waiting' || v === 'preparing') && v !== old) {
    startAiWaiting()
  }
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
watch(lastStreamId, (id) => {
  if (!id) return
  const s2 = new Set(treeExpanded.value)
  if (!s2.has(id)) {
    s2.add(id)
    treeExpanded.value = s2
  }
})
/**
 * 切换 Auto Takeover
 */
function toggleAutoTakeover() {
  if (autoTakeoverEnabled.value) {
    disableAutoTakeover()
    cancelAutoRun()
    toast('已关闭自动接管', 'info', 3000)
  } else {
    if (!script.value.trim()) {
      toast('请先在输入提问再开启接管', 'warn', 3000)
      return
    }
    enableAutoTakeover()
    toast('已开启自动接管：立即执行当前脚本 → 结果发 AI → AI 回填后  自动执行', 'success', 6000)
    void runSmart()
  }
}
/** 当前 inbox 待取用条数（仅展示用，避免在模板里直接 inbox.value.length 触发响应式开销） */
/** 取最新一条入队脚本，覆盖当前编辑器内容 */

/** 最后一个运行脚本 */

// [loop-paused-toggle-v1] 真暂停：已暂停则恢复；否则置 paused（不终止循环）
/**
 * 执行 pause All
 */
function pauseAll() {
  if (autoTakeoverEnabled.value) {
    disableAutoTakeover()
    toast('已关闭自动接管', 'info', 3000)
    return
  }
  if (loopPaused.value) {
    // [pause-to-idle-v2] 有活跃循环 + 暂停态：点击即完全退出循环，复位到待发状态
    if (isLoopActive.value || running.value) {
      void exitPauseToIdle()
      return
    }
    // [sp-send-after-softpause-v1] 无活跃循环但 loopPaused 被 softPause 残留置真：
    // 视为用户点「发送」——复位 paused，走重新发送路径（等价 toggleAutoTakeover 的 else 分支）
    clearSoftPause()
    if (autoTakeoverEnabled.value) disableAutoTakeover()
    if (!script.value.trim()) {
      toast('请先在编辑器写脚本再发送', 'warn', 3000)
      return
    }
    enableAutoTakeover()
    toast('已开启自动接管：立即执行当前脚本 → 结果发 AI → AI 回填后 3-10s 自动执行', 'success', 6000)
    void runSmart()
    return
  }
  if (isLoopActive.value || running.value || autoTakeoverEnabled.value) {
    requestPause()
    return
  }
  // 无活动循环：退化到立即停（旧行为）
  disableAutoTakeover()
  stop()
}

async function buildAiPrompt(): Promise<string> {
  if (!result.value) return ''
  const errorLocs = parseErrorLocations(`${result.value.stderr || ''}\n${result.value.stdout || ''}`)
  const p: string[] = []
  p.push('# 脚本执行结果')
  p.push(`状态: ${result.value.ok ? '✅ 成功' : '❌ 失败'}`)
  p.push(`退出码: ${result.value.code}`)
  p.push(`变更数: ${changes.value.length}`)
  p.push('')

  const r = result.value
  await appendFailedSourceFiles(p, r, changes.value, { stripComments: stripComments.value, stripBlankLines: stripBlankLines.value, errorLocs })
  appendFeedbackSummary(p, r)
  appendChangeList(p, changes.value)
  appendDryRunFailure(p, r)
  appendSmokeReport(p, r)
  appendTscReport(p, r)
  appendLintReport(p, r)
  appendTestReport(p, r)
  await appendBaselineChanges(p, r, errorLocs)
  appendClaimMismatch(p, r)
  appendRawOutputs(p, r)

  const text = p.join('\n')
  return trimPromptIfOverBudget(text, toast)
}

// [prompt-builder-v1] append* 系列已抽到 prompt-builder.ts

/**
 * 应用模板：把 code 写入编辑器 script
 * [WHY] 模板按钮与"AI 回填"共用此入口；写值直接触发 watch 触发自动填充判定
 * [CONSTRAINT] 不校验 code 是否合法，调用方负责保证
 * @param code 待写入编辑器的主体代码
 */
function applyTemplate(code: string) {
  script.value = code
}

/**
 * [ai-autorun-server-exec-v1] 自动接管：AI 回填脚本后，延迟 3-10s 交服务端执行（非再发回 AI）
 * [CONSTRAINT] 依赖 autoTakeoverEnabled；running 中跳过并 toast；空脚本跳过
 * [CHANGE-IMPACT] 会清空 script，跑后由 scheduleAutoRun 回填 lastRunScript
 */
function onAutoRun() {
  if (!autoTakeoverEnabled.value) return
  if (running.value) { toast('脚本运行中，跳过本次自动执行', 'warn', 2000); return }
  scheduleAutoRun(() => {
    if (!autoTakeoverEnabled.value || running.value) return
    const text = script.value.trim()
    if (!text) {
      toast('AI 回填为空，跳过自动执行', 'warn', 2000)
      return
    }
    // [clear-after-run-v1] 与手动路径一致：跑后清空编辑器
    runningCommand.value = ''
    lastRunScript.value = text
    script.value = ''
    run({ script: text })
  })
}

/**
 * 全局键盘快捷键：Alt+R 触发智能发送
 * [WHY] 挂在 window 级监听上，Alt+R 让用户不离开编辑器即可发送
 * [CONSTRAINT] 只在无 ctrl / meta / shift 时响应，避免与浏览器快捷键冲突
 */
function onGlobalKey(e: KeyboardEvent) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault()
    runSmart()
  }
}
/**
 * 发送编辑器内容到 AI 网页
 */
async function runSmart() {
  const rawScript = script.value.trim()
  if (!rawScript) {
    toast('请先在编辑器写内容再发送', 'warn', 3000)
    return
  }
  const text = attachedFiles.value.length
    ? await buildPromptWithAttachments(rawScript, attachedFiles.value)
    : rawScript
  // [image-channel-v2] 图片走独立 images 通道；prompt 只带位置提示，接收端负责转粘贴
  // [CONSTRAINT] filter 只取 kind==='image'；content 为 readAsDataUrl 返回值
  // [CHANGE-IMPACT] images 数组为空时传 undefined，保持旧行为（无图片路径零变化）
  const images = attachedFiles.value.filter(f => f.kind === 'image').map(f => f.content)
  const r = await copyAndFill(text, images.length ? { images } : undefined)
  if (r === 'failed') {
    toast('发送失败：AI 窗口未打开或已关闭', 'warn', 4000)
    return
  }
  // [ask-display-v1] 提问上屏：发送成功后写 ai:ask 事件，由 TerminalPane.timelineItems 渲染
  // [CONSTRAINT] 必须在 copyAndFill 成功后（失败已 return）；payload.text 用 rawScript 原文而非拼接后 text
  // [CHANGE-IMPACT] 与 TerminalPane 的 ai:ask 渲染分支成对；kind 已在 EventKind 白名单
  emitBus('ai:ask', rawScript.slice(0, 40), { payload: { text: rawScript } })
  startAiWaiting()
  // [clear-after-send-v3] 发送成功后清空编辑器；草稿槽位功能已移除
  // [WHY] 用户明确不需要草稿；清空即为最终状态，不再被 onMounted 回填
  // [CONSTRAINT] 仅在 copyAndFill 成功后执行（失败分支已提前 return，不误清用户内容）
  // [CHANGE-IMPACT] 移除了对 draft-slots 的依赖；AI 回填仍走 inbox.applyToEditor 的 current==='' 安全覆盖分支
  script.value = ''
}

watch(
  () => changes.value.length,
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

/**
 * 执行 scroll Term To Bottom
 */
function scrollTermToBottom() {
  nextTick(() => {
    const el = chatListRef.value
    if (!el || !autoScroll.value) return
    // 双帧兜底：内容渲染后高度可能还在变，连滚两帧
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      if (el && autoScroll.value) el.scrollTop = el.scrollHeight
    })
  })
}/**
 * 执行 locked Scroll
 */
function _lockedScroll() {
  _scrollLock = Date.now()
  scrollTermToBottom()
}
// 内容变化即滚底（打字机感）
watch(busEvents, _lockedScroll)
watch(liveStdout, _lockedScroll)
watch(liveStderr, _lockedScroll)
// 窗口尺寸变化后也保持贴底
if (typeof window !== 'undefined') {
  window.addEventListener('resize', _lockedScroll)
  onBeforeUnmount(() => window.removeEventListener('resize', _lockedScroll))
}

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

  scrollTermToBottom()
  window.addEventListener('ai-runner:auto-run', onAutoRun)
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('ai-runner:drop', onTreeDrop)
})

onBeforeUnmount(() => {
  disposeSideResize()
  // [vueuse-timers-v1] elapsedTimer 已由 useIntervalFn 内部在组件卸载时自动 pause，无需手动清理

  window.removeEventListener('ai-runner:auto-run', onAutoRun)
  window.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('ai-runner:drop', onTreeDrop)
})

watch(running, (v) => {
  if (v) {
    runStartAt = performance.now()
    statusText.value = '运行中…'
    statusClass.value = ''
    lastDuration.value = ''
    runningElapsed.value = '0.0s'
    // [vueuse-timers-v1] resume 等价 setInterval 启动；重复 resume 幂等（内部判断 isActive）
    resumeElapsed()
  } else if (result.value) {
    pauseElapsed()
    runningElapsed.value = ''
    const ms = performance.now() - runStartAt
    lastDuration.value = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
    if (result.value.dryRunFailed) {
      statusText.value = '⚠ 预检失败 · 未落盘'
      statusClass.value = 'err'
      toast(
        `预检未通过：脚本本想改 ${result.value.dryRunChangeCount ?? 0} 个文件，已丢弃，磁盘零改动；错误已入 prompt`,
        'warn',
        5000,
      )
      if (autoTakeoverEnabled.value) scheduleAutoRun(() => { void copyOutput(autoFeedbackRequested.value) })
      else void copyOutput(autoFeedbackRequested.value)
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
      if (shouldAutoAsk && result.value.error !== '已取消') {
        if (forceFeedback) clearAutoFeedback()
        if (autoTakeoverEnabled.value) scheduleAutoRun(() => { void copyOutput(forceFeedback) })
        else void copyOutput(forceFeedback)
      }
      // 清空编辑区模式：脚本快照从 lastRunScript 取（script 已清空）
      const scriptSnapshot = lastRunCode.value || lastRunScript.value || script.value
      // 把跑过的脚本记为「已消费」，让后续 AI 回填能直接覆盖（不误伤手动编辑）
      setLastAutoFilled(scriptSnapshot)
      // [dead-code-v3] 已删 desc/why/lang/hash 块：grep 证实在文件内无第二消费点
    }
  }
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

<style scoped lang="scss">
.pane.is-resizing-side,
.pane.is-resizing-side * {
  user-select: none;
  cursor: col-resize;
}

.pane.is-resizing-side .pane-side {
  transition: none;
}

@keyframes pop-in {
  from {
    transform: scale(0.9);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@media (max-width: 1100px) {
  .pane {
    display: flex;
    flex-direction: row;
    gap: 0;
    height: 100%;
    overflow: hidden;
    padding: 0;
  }
}

@media (max-width: 720px) {
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 8px;
    flex-shrink: 0;
  }
}

@keyframes overlay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.side-resize-handle {
  flex-shrink: 0;
  width: 8px;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 5;
  transition: background 0.15s;
}

.side-resize-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 24px;
  border-radius: var(--radius-2);
  background: var(--border);
  transition:
    background 0.15s,
    height 0.15s;
}

.side-resize-handle:hover::after,
.side-resize-handle.active::after {
  background: var(--primary);
  height: 40px;
}

.pane-main {
  background: var(--bg);
  color: var(--text);
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  min-width: 0;
  overflow: hidden;
}

/* waiting-pulse / cursor-blink / dot-pulse 已迁至全局 style.css ([global-keyframes-v1]) */

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  pointer-events: none;
  background: rgb(13 17 23 / 70%);
}

.overlay-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 32px;
  border-radius: var(--radius-12);
  background: var(--surface-2);
  border: 2px dashed var(--primary);
  color: var(--text);
}

.overlay.success .overlay-card {
  border-style: solid;
  border-color: var(--success);
}

.overlay-icon {
  font-size: 32px;
}
.overlay-text {
  font-size: 13px;
  color: var(--text-2);
}
</style>
