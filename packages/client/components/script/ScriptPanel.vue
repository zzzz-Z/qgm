<template>
  <div ref="paneRef" class="bg-\[var\(--bg\)\] flex pane h-screen overflow-hidden" :class="{ 'is-resizing-side': resizingSide }">
    <!-- 左侧主区域 -->
    <div
      ref="mainRef" class="flex flex-col pane-main flex-1 min-w-0 overflow-hidden" :class="{ 'is-success': fileSuccess }"
      @dragover="onHtmlDragOver" @drop="onHtmlDrop"
    >
      <!-- 终端 (上方) -->
      <TerminalPane
        :main-status="mainStatus"
        :status-active="statusActive"
        :bar-meta="barMeta"
        :phase-elapsed="phaseElapsed"
        :running="running"
        :tw-stdout="twStdout"
        :tw-stderr="twStderr"
        :tw-lines="twLines"
        :tw-err-lines="twErrLines"
        :done-summary="doneSummary"
        :line-class="lineClass"
        :chat-items="[]"
        :templates="[]"
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
        <!-- [abnormal-mount-v1] -->
        <AbnormalView :result="result" />
        <template #tpl-bar>
          <ScriptToolbar
            v-model:niuma-mode="niumaMode"
            :templates="[]"
            :running="running"
            :is-loop-active="isLoopActive"
            :loop-paused="loopPaused"
            :auto-takeover-enabled="autoTakeoverEnabled"
            :auto-takeover-countdown="autoTakeoverCountdown"
            :script="script"
            :attached-files-count="attachedFiles.length"
            @apply-template="applyTemplate"
            @clear-all="clearAll"
            @pause-all="pauseAll"
            @toggle-auto-takeover="toggleAutoTakeover"
          />
        </template>
        <template #attach-bar>
          <ScriptAttachBar :files="attachedFiles" @remove="removeAttach" />
        </template>
        <template #foot>
          <ScriptFooter :persist-warning="persistWarning" :result="result" />
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
// [draft-slots-v1] 草稿槽位读写/防抖持久化已抽到 draft-slots.ts
import { createDraftSlots } from './draft-slots'
// [side-resize-v1] 侧栏拖拽已抽到 side-resize.ts
import { createSideResize } from './side-resize'
// [exec-flow-v1] exec 全流程已抽到 exec-flow.ts
import { createExecFlow } from './exec-flow'
import type { DraftSlot } from './draft-slots'
// [script-panel-utils-v2-extracted]
import { useTwDisplay } from '../../composables/ui/useTwDisplay'
import TerminalPane from './TerminalPane.vue'
import ScriptEditor from './ScriptEditor.vue'
// [abnormal-mount-v1]
import AbnormalView from '../panels/AbnormalView.vue'
import ScriptToolbar from './ScriptToolbar.vue'
import ScriptAttachBar from './ScriptAttachBar.vue'
import ScriptFooter from './ScriptFooter.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRunner } from '../../composables/runner/useRunner'
import { currentLoopContext, useAutoLoop } from '../../composables/ai/useAutoLoop'
import { useAiWaiting } from '../../composables/ai/useAiWaiting'
import { useAutoTakeover } from '../../composables/ai/useAutoTakeover'
import { useEventBus } from '../../composables/ui/useEventStream'
import { useCodeCleaner } from '../../composables/runner/useCodeCleaner'
import { useSessionManager } from '../../composables/ai/useSessionManager'
import { detectLang, parseScriptMeta } from '../../utils/scriptMeta'
import { LS_SIDE_WIDTH_KEY } from '../../utils/storage'
import { isReadonlyResult } from '../../composables/runner/useRunFeedback'
import { parseErrorLocations } from '../../utils/contextBuilder'
import { fnv1a8 } from '../../utils/hash'
import { useToast } from '../../composables/ui/useToast'
import { useTraceLog } from '../../composables/ui/useTraceLog'
import { setLastAutoFilled } from '../../composables/runner/useScriptInbox'
import SidePane from '../panels/SidePane.vue'
import DiffOverlay from '../diff/DiffOverlay.vue'

defineOptions({ name: 'ScriptPanel' })

/** 活动的 */
const ACTIVE_CLS = new Set(['running', 'waiting', 'loop'])
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
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let runStartAt = 0
/** 侧栏标签页 */
const sideTab = ref<'tree' | 'changes' | 'trace' | 'tasks'>('tree')
/** 窄屏抽屉开合 */
const sideDrawerOpen = ref(false)
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

// ── 附件 / 命令历史 / 草稿 / 滚动 ref ──

/* [attachments] 附件：粘贴图片 / 拖文件 → tag 展示；发送时文本内容拼入脚本 */
/** 附件列表 */
const attachedFiles = ref<AttachedFile[]>([])
// [P2-2b] draft slots API
/** 草稿槽位列表（多份草稿切换） */
const draftSlots = ref<DraftSlot[]>([])
/** 活动草稿 id */
const activeDraftId = ref<string>('default')
/** 终端自动滚动开关 */
const autoScroll = ref(true)

// ── 模块级可变状态（let）──

/** 命令执行策略覆盖（内部临时变量） */
/** 最近一次自动回传 AI 的 runKey（防重复） */
// [P2-2b] auto-persist active slot（debounce 400ms）
/** 滚动锁时间戳（防高频 scrollTo） */
let _scrollLock = 0

// ── 状态栏 ref ──

/** 状态文本（短暂提示，如「已发送」） */
const statusText = ref('')
/** 状态样式类（ok/err） */
const statusClass = ref('')
/** 当前时间戳（用于刷新相对时间显示） */
const _now = ref(Date.now())
/** 阶段启动时间戳 */
const _phaseStart = ref(Date.now())
let _nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { _nowTimer = setInterval(() => { _now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (_nowTimer) clearInterval(_nowTimer) })

// 组合式函数：toast 在 script 早段被使用，此处集中初始化
const { toast, confirmDialog } = useToast()
// U.3: CodeMirror 全家桶懒加载——首建编辑器时才 await import，CM 打进独立 chunk

const { script, lastRunCode, running, result, changes, rolling, busyAll, persistWarning, liveStdout, liveStderr, doneSummary, run, stop, rollback, rollbackAll, save, autoFeedbackRequested, clearAutoFeedback } = useRunner()
const { enabled: autoTakeoverEnabled, countdown: autoTakeoverCountdown, enable: enableAutoTakeover, disable: disableAutoTakeover, scheduleAutoRun, cancelAutoRun } = useAutoTakeover()
const { addTrace } = useTraceLog()
// [cmd-history-v1] 命令历史簇
const { pushCmdHistory, cmdHistoryPrev, cmdHistoryNext } = createCmdHistory({ script })
// [attach-manager-v1] 附件簇（attachedFiles 由本组件持有，供 addTreePaths 等共享）
const { removeAttach, clearAll, onEditorPaste, onDesktopDrop } = createAttachManager({ attachedFiles, script, fileSuccess })
// [tree-attach-v1] 树拖入 / 目录展开 / 脚本拼装（attachedFiles 由本组件持有）
const { onTreeDrop, buildScriptWithAttachments } = createTreeAttach({ attachedFiles })
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
// [draft-slots-v1] 草稿槽位（script/draftSlots/activeDraftId 由本组件持有）
const { readDraftSlots, readActiveDraftId, upsertDraftSlot } = createDraftSlots({ script, draftSlots, activeDraftId })
// [side-resize-v1] 侧栏拖拽（paneRef/sideWidth/sideWidthBase/resizingSide 由本组件持有）
const { onSideDown, dispose: disposeSideResize } = createSideResize({
  paneRef,
  sideWidth,
  sideWidthBase,
  resizingSide,
  persistWidth: (w) => { try { localStorage.setItem(SIDE_WIDTH_KEY, String(w)) } catch { /* ignore */ } },
})

// ── 领域 composable ──
const { maybeRotateSession } = useSessionManager()
const { waiting: aiWaiting, niumaMode, startWaiting: startAiWaiting } = useAiWaiting()
const { pendingMeta: autoPendingMeta } = useAutoTakeover()
const { events: busEvents } = useEventBus()
const { stripComments, stripBlankLines } = useCodeCleaner()

// [script-panel-tw-extracted-v1] 初始化打字机
const { twStdout, twStderr, twLines, twErrLines } = useTwDisplay(liveStdout, liveStderr)
const {
  loopState,
  stopReason,
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
// [exec-flow-v1] exec 全流程（refs 由本组件持有）
const { execCmdInternal, execCmd, copyOutput } = createExecFlow({
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

// ── computed（状态栏 / 元信息 / 阶段耗时 / 流标识）──

// [statusbar] 主状态：图标 + 文本 + 语义色
/** 状态 */
// [usb-main-status-text-v1] 各状态文本简短醒目，配合 pill 样式
const mainStatus = computed(() => {
  if (running.value) return { icon: '\u2699\uFE0F', text: '脚本执行中', cls: 'running' }
  if (aiWaiting.value) return { icon: '\u23F3', text: '等待 AI', cls: 'waiting' }
  if (loopState.value === 'waiting-input') return { icon: '\u23F8\uFE0F', text: '待决策', cls: 'paused' }
  if (loopState.value === 'budget-limited') return { icon: '\u26A0\uFE0F', text: '预算耗尽', cls: 'warn' }
  if (isLoopActive.value) return { icon: '\u{1F504}', text: '循环中', cls: 'loop' }
  if (stopReason.value) return { icon: '\u23F9\uFE0F', text: '已停止', cls: 'stop' }
  return { icon: '\u25CB', text: '待命', cls: 'idle' }
})

// [status-active] 状态栏活跃态：运行/等待/循环时高亮
/** 状态活动的 */
const statusActive = computed(() => ACTIVE_CLS.has(mainStatus.value.cls))

// [script-meta-row] 从当前脚本内容解析 @desc/@why/@plan/@done
/** 脚本元信息 */
const scriptMeta = computed(() => parseScriptMeta(String((script && script.value) || '')))
// [statusbar] 优先展示待执行脚本（到达未执行），否则用编辑器内容
/** 栏元信息 */
const barMeta = computed(() => {
  const p = autoPendingMeta.value
  if (p && (p.desc || p.why || p.plan)) return { desc: p.desc, why: p.why, plan: p.plan }
  return scriptMeta.value
})
// [statusbar] 阶段耗时：mainStatus 变化时重置，每秒更新
/** 阶段 */
const phaseElapsed = computed(() => {
  const ms = _now.value - _phaseStart.value
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
})

// [statusbar] 阶段切换时重置计时
watch(() => mainStatus.value.cls, () => { _phaseStart.value = Date.now() })

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
      toast('请先在编辑器写脚本再开启接管', 'warn', 3000)
      return
    }
    enableAutoTakeover()
    toast('已开启自动接管：立即执行当前脚本 → 结果发 AI → AI 回填后 3-10s 自动执行', 'success', 6000)
    void runSmart({ bypassAutoGuard: true })
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
    void runSmart({ bypassAutoGuard: true })
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

/** 是否已复制到剪贴板 */
/** 文件成功 */

// [attach-manager-v1] 附件簇函数已抽到 attach-manager.ts

// [tree-attach-v1] 树/目录/脚本拼装已抽到 tree-attach.ts

// ── computed（状态栏 / 元信息 / 阶段耗时 / 流标识）──

/** 最新的 AI 流式文本（取最后一条 ai:stream 事件） */

// [preview-manager-v1] 预览/撤回/变更类型已抽到 preview-manager.ts

/**
 * 构建 Ai Prompt
 */
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

// URL 长度安全上限。超过就打开首页，靠剪贴板兜底。
/* __ai_removed: DEEPSEEK_URL_MAX */
// URL 从全局 composable 读，在 App.vue 的 header 里配置
/* __ai_removed: deepseekUrl ref */

/**
 * 应用 Template
 * @param code - code
 */
function applyTemplate(code: string) {
  script.value = code
}

/** 自动接管：收到 AI 脚本回填后，随机 3-10s 后自动运行 */
function onAutoRun() {
  if (!autoTakeoverEnabled.value) return
  if (running.value) { toast('脚本运行中，跳过本次自动执行', 'warn', 2000); return }
  scheduleAutoRun(() => {
    if (!autoTakeoverEnabled.value || running.value) return
    void runSmart({ bypassAutoGuard: true })
  })
}

/**
 * 响应 Global Key
 * @param e - e
 */
function onGlobalKey(e: KeyboardEvent) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault()
    runSmart()
  }
}
/**
 * 运行 Smart
 * @param opts - opts
 */
async function runSmart(opts?: { bypassAutoGuard?: boolean }) {
  if (autoTakeoverEnabled.value && !opts?.bypassAutoGuard) {
    toast('自动接管中，请先关闭接管再手动运行', 'warn', 2500)
    return
  }
  const rawScript = script.value.trim()
  if (!rawScript) return
  const text = attachedFiles.value.length ? await buildScriptWithAttachments(rawScript, attachedFiles.value) : rawScript
  const firstLine = text.split('\n', 1)[0].trim()
  const isNode = /^#!\s*\/usr\/bin\/(?:env\s+)?node\b/.test(firstLine)
  const isBash = /^#!\s*\/usr\/bin\/(?:env\s+)?bash\b/.test(firstLine)
  if (isNode || isBash) {
    runningCommand.value = ''
    lastRunScript.value = text
    // [clear-after-run-v1] 运行后清空编辑器
    script.value = ''
    run({ script: text })
    return
  }
  if (text.startsWith('!')) {
    execCmd(text)
    return
  }
  // 无 shebang：交给 interceptor 自动补 #! /usr/bin/env node 后走沙盒执行
  runningCommand.value = ''
  lastRunScript.value = text
  script.value = ''
  run({ script: text })
}

// 用户手选 + 后端按 question 自动匹配

// [exec-flow-v1] exec 全流程已抽到 exec-flow.ts

// stderr 里把 file.ts:12:34 变成可点击（点击复制路径）
// ponytail: 不做跨文件跳转（无 Monaco，行号可能失准），只复制路径。

// [draft-slots-v1] 草稿槽位读写已抽到 draft-slots.ts

// [side-resize-v1] 侧栏拖拽已抽到 side-resize.ts

// 预览 diff 时自动加宽（尊重用户手动拖过的基准宽度）
// changes 为空时清空 diff 状态，避免残留
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

watch(sideTab, (v) => {
  if (resizingSide.value) return
  if (v === 'trace') {
    sideWidth.value = Math.max(sideWidthBase.value, SIDE_WIDTH_DIFF)
  } else {
    sideWidth.value = previewFile.value
      ? Math.max(sideWidthBase.value, SIDE_WIDTH_DIFF)
      : sideWidthBase.value
  }
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
  // [P2-2b] 草稿槽位恢复
  try {
    draftSlots.value = readDraftSlots()
    const activeSaved = readActiveDraftId()
    if (activeSaved) activeDraftId.value = activeSaved
    const cur = draftSlots.value.find(s => s.id === activeDraftId.value)
    if (cur && !script.value) script.value = cur.text
    // 首启：当前 script 内容入 default 槽
    if (!draftSlots.value.some(s => s.id === activeDraftId.value)) {
      upsertDraftSlot(activeDraftId.value, script.value || '')
    }
  } catch { /* ignore */ }
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
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }

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
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => {
      const s = (performance.now() - runStartAt) / 1000
      runningElapsed.value = `${s.toFixed(1)}s`
    }, 100)
  } else if (result.value) {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
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
      const r = result.value
      // 兼容旧脚本只写 // @desc；新脚本可能 // 或 #，从 result.value.scriptDesc/scriptWhy 拿（server 已解析）
      const sm = parseScriptMeta(scriptSnapshot)
      const desc = r.scriptDesc || sm.desc
      const why = r.scriptWhy || sm.why
      const lang = detectLang(scriptSnapshot)
      // 计算 hash（与油猴脚本一致：FNV-1a 8 hex）
      const hash = fnv1a8(scriptSnapshot)
      addTrace({
        kind: 'run',
        summary: desc || `运行脚本 · exit ${r.code}`,
        payload: {
          script: scriptSnapshot.slice(0, 4000),
          stdout: (r.stdout || '').slice(-4000),
          stderr: (r.stderr || '').slice(-4000),
          exit: r.code,
          ok: r.ok,
          changes: changes.value.map(x => ({ path: x.path, type: x.type })),
          desc,
          why,
          lang,
          hash,
          ...currentLoopContext(),
        },
      })
    }
  }
})

/**
 * 响应 Html Drag Over
 * @param e - e
 */
function onHtmlDragOver(e: DragEvent) {
  e.preventDefault()
}
/**
 * 响应 Html Drop
 * @param e - e
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
  setTimeout(() => { fileSuccess.value = false }, 1500)
}
</script>

<style scoped lang="scss">
.pane.is-resizing-side,
.pane.is-resizing-side * {
  user-select: none !important;
  cursor: col-resize !important;
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
    gap: 0 !important;
    height: 100%;
    overflow: hidden;
    padding: 0 !important;
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
  background: var(--bg) !important;
  color: var(--text) !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 0 !important;
  padding: 0 !important;
  min-width: 0 !important;
  overflow: hidden !important;
}

/* usb-spin → 已迁至全局 style.css ([global-keyframes-v1]) */
/* usb-pulse → 已迁至全局 style.css ([global-keyframes-v1]) */
/* usb-blink → 已迁至全局 style.css ([global-keyframes-v1]) */
/* usb-fade → 已迁至全局 style.css ([global-keyframes-v1]) */
/* usb-breathe → 已迁至全局 style.css ([global-keyframes-v1]) */

/* waiting-pulse → 已迁至全局 style.css ([global-keyframes-v1]) */

/* cursor-blink → 已迁至全局 style.css ([global-keyframes-v1]) */

.overlay {
  position: absolute !important;
  inset: 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  z-index: 50 !important;
  pointer-events: none !important;
  background: rgb(13 17 23 / 70%) !important;
}

.overlay-card {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 24px 32px !important;
  border-radius: var(--radius-12) !important;
  background: var(--surface-2) !important;
  border: 2px dashed var(--primary) !important;
  color: var(--text) !important;
}

.overlay.success .overlay-card {
  border-style: solid !important;
  border-color: var(--success) !important;
}

.overlay-icon {
  font-size: 32px !important;
}
.overlay-text {
  font-size: 13px !important;
  color: var(--text-2) !important;
}

/* dot-pulse → 已迁至全局 style.css ([global-keyframes-v1]) */
</style>
