<template>
  <div ref="paneRef" class="bg-\[var\(--bg\)\] flex pane h-screen overflow-hidden" :class="{ 'is-resizing-side': resizingSide }">
    <!-- 左侧主区域 -->
    <div
      ref="mainRef" class="flex flex-col pane-main flex-1 min-w-0 overflow-hidden" :class="{ 'is-success': fileSuccess }"
      @dragover="onHtmlDragOver" @drop="onHtmlDrop"
    >
      <!-- 自动化循环控制条（P2） -->
      <LoopBar v-model="showUserNote" />
      <NoteBar
        v-if="showUserNote && isLoopActive"
        @submit="submitUserNote"
        @cancel="showUserNote = false"
      />
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
        :templates="TEMPLATES"
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
            :templates="TEMPLATES"
            :selected-skill-names="selectedSkillNames"
            :skills-list="skillsList"
            :skills-loading="skillsLoading"
            :running="running"
            :is-loop-active="isLoopActive"
            :loop-paused="loopPaused"
            :auto-takeover-enabled="autoTakeoverEnabled"
            :auto-takeover-countdown="autoTakeoverCountdown"
            :script="script"
            :attached-files-count="attachedFiles.length"
            :on-load-skills="() => { if (!skillsList.length && !skillsLoading) void loadSkillsList() }"
            @apply-template="applyTemplate"
            @toggle-skill="toggleSkill"
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
import { lineClass, trimOutput } from './output-utils'
// [script-panel-utils-v2-extracted]
import { isBashScript, isInEditor, readAsDataUrl } from './script-panel-utils'
import { useTwDisplay } from '../../composables/ui/useTwDisplay'
import TerminalPane from './TerminalPane.vue'
import LoopBar from './LoopBar.vue'
import ScriptEditor from './ScriptEditor.vue'
// [abnormal-mount-v1]
import AbnormalView from '../panels/AbnormalView.vue'
import ScriptToolbar from './ScriptToolbar.vue'
import ScriptAttachBar from './ScriptAttachBar.vue'
import ScriptFooter from './ScriptFooter.vue'
import NoteBar from './NoteBar.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRunner } from '../../composables/runner/useRunner'
import { currentLoopContext, useAutoLoop } from '../../composables/ai/useAutoLoop'
import { copyAndFill, sendNewSession } from '../../composables/ai/useDeepseekUrl'
import { useAiWaiting } from '../../composables/ai/useAiWaiting'
import { useAutoTakeover } from '../../composables/ai/useAutoTakeover'
import { emit, setPendingAskKey, useEventBus } from '../../composables/ui/useEventStream'
import { useCodeCleaner } from '../../composables/runner/useCodeCleaner'
import { useSessionManager } from '../../composables/ai/useSessionManager'
import { fmtSize, readAsText } from '../../utils/format'
import { detectLang, parseScriptMeta } from '../../utils/scriptMeta'
import { LS_BASH_POLICY_KEY, LS_CMD_HISTORY_KEY, LS_DRAFT_ACTIVE_KEY, LS_DRAFT_SLOTS_KEY, LS_SIDE_WIDTH_KEY, LS_SKILLS_KEY } from '../../utils/storage'
import { isReadonlyResult, shouldIncludeChanges } from '../../composables/runner/useRunFeedback'
import { buildErrorContext, enforceBudget, parseErrorLocations } from '../../utils/contextBuilder'
import { readNdjson } from '../../utils/stream'
import { fnv1a8 } from '../../utils/hash'
import { useToast } from '../../composables/ui/useToast'
import { useTraceLog } from '../../composables/ui/useTraceLog'
import { setLastAutoFilled } from '../../composables/runner/useScriptInbox'
import SidePane from '../panels/SidePane.vue'
import DiffOverlay from '../diff/DiffOverlay.vue'
import type { FileNode, FilesReadResponse } from '../../types'
import { log } from '../../utils/log'

defineOptions({ name: 'ScriptPanel' })

// ── 类型 ──

interface SkillInfo { name: string, content?: string, source?: 'base' | 'user' | 'agents' }
interface AttachedFile {
  id: string
  name: string
  size: number
  kind: 'image' | 'text' | 'folder'
  content: string
  paths?: string[] // folder 专用：展开后的文件列表
}
interface DraftSlot { id: string, text: string, ts: number, name: string }

// ── 常量 ── [partition-scriptpanel-v1] 模块级常量集中区

/** 键 */
const SKILLS_KEY = LS_SKILLS_KEY
/** 挂载 */
const MAX_ATTACH_BYTES = 500 * 1024 // 单文件 500KB
/** 活动的 */
const ACTIVE_CLS = new Set(['running', 'waiting', 'loop'])
/** 键 */
const SIDE_WIDTH_KEY = LS_SIDE_WIDTH_KEY
/** 侧栏默认宽度（像素） */
const SIDE_WIDTH_DEFAULT = 320
/** 差异 */
const SIDE_WIDTH_DIFF = 560
/** 键 */
const CMD_HISTORY_KEY = LS_CMD_HISTORY_KEY
/** 键 */
const DRAFT_SLOTS_KEY = LS_DRAFT_SLOTS_KEY
/** 活动的键 */
const DRAFT_ACTIVE_KEY = LS_DRAFT_ACTIVE_KEY

// [templates-onboard-v1] 首次体验：空态示例卡片
// 注意：js 脚本的 code 字段用真实源码字符串；bash 用单行命令；ask 用自然语言问题。
/** 模板列表 */
const TEMPLATES: Array<{ id: string, label: string, title: string, code: string }> = [
  {
    id: 'check',
    label: '项目巡检',
    title: '跑 tsc + lint + 冒烟，一键确认仓库健康度',
    code: '#!/usr/bin/env node\\n// @desc: 项目巡检 - 类型 + lint + 冒烟\\n// @why: 快速确认仓库健康度\\nconst { execSync } = require(\'node:child_process\')\\nfunction run(label, cmd) {\\n  try { execSync(cmd, { stdio: \'inherit\' }) ; log.info(\'✓ \' + label) }\\n  catch { log.error(\'✗ \' + label) ; process.exitCode = 1 }\\n}\\nrun(\'tsc\', \'npx tsc -p tsconfig.json --noEmit\')\\nrun(\'lint\', \'npx eslint .\')\\nrun(\'smoke\', \'node bin/check-status.cjs\')',
  },
  {
    id: 'bash',
    label: 'shell 命令',
    title: '直接执行 shell（白名单内），如 git status / ls',
    code: 'git status --short && echo "---" && ls -1 | head -20',
  },
  {
    id: 'ask',
    label: '问 AI',
    title: '把问题发给 AI 并等待回复，不占用循环',
    code: '请阅读当前仓库结构，给出三条针对 v3-template 项目的优化建议。',
  },
]

/** 编辑器 */
const editorRef = ref<{ insertText: (t: string) => void } | null>(null)

// ── 主状态 ref ──

const lastRunScript = ref('')
/** 技能列表 */
const skillsList = ref<SkillInfo[]>([])
/** 技能加载中 */
const skillsLoading = ref(false)
/** 已选中技能名 */
const selectedSkillNames = ref<string[]>(loadSelectedSkillNames())
/** 用户补充说明面板开关 */
const showUserNote = ref(false)
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
/** 命令历史记录 */
const cmdHistory = ref<string[]>(loadCmdHistory())
let cmdHistoryIndex = -1
let cmdHistoryDraft = ''
// [P2-2b] draft slots API
/** 草稿槽位列表（多份草稿切换） */
const draftSlots = ref<DraftSlot[]>([])
/** 活动草稿 id */
const activeDraftId = ref<string>('default')
/** 终端自动滚动开关 */
const autoScroll = ref(true)

// ── 模块级可变状态（let）──

/** 命令执行策略覆盖（内部临时变量） */
let execPolicyOverride: string | null = null
/** 最近一次自动回传 AI 的 runKey（防重复） */
let lastAutoAskedRunId = ''
// [P2-2b] auto-persist active slot（debounce 400ms）
let draftPersistTimer: ReturnType<typeof setTimeout> | null = null
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
  userNote,
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
/**
 * 加载 Selected Skill Names
 */
function loadSelectedSkillNames(): string[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY)
    if (raw === null) return ['gen-script-rules']
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return ['gen-script-rules'] }
}
watch(selectedSkillNames, (v) => {
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(v)) } catch { }
}, { deep: true })
/**
 * 加载 Skills List
 */
async function loadSkillsList(): Promise<void> {
  skillsLoading.value = true
  try {
    const res = await fetch('/__ai/skills')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    skillsList.value = Array.isArray(data) ? data : []
    ; (window as unknown as { __ai_skills?: unknown }).__ai_skills = skillsList.value
  } catch (e) {
    log.error('[ai-runner] loadSkillsList failed:', e)
    skillsList.value = []
  } finally { skillsLoading.value = false }
}
/**
 * 切换 Skill
 * @param name - name
 */
function toggleSkill(name: string): void {
  const i = selectedSkillNames.value.indexOf(name)
  if (i >= 0) selectedSkillNames.value = selectedSkillNames.value.filter(n => n !== name)
  else selectedSkillNames.value = [...selectedSkillNames.value, name]
}
void loadSkillsList()
/**
 * 执行 submit User Note
 * @param text - text
 */
function submitUserNote(text: string) {
  userNote.value = text
  showUserNote.value = false
  if (userNote.value) toast('补充说明已记录，将在下一轮反馈带上', 'success', 3000)
}

// [loop-paused-toggle-v1] 真暂停：已暂停则恢复；否则置 paused（不终止循环）
/**
 * 执行 pause All
 */
function pauseAll() {
  cancelAutoRun()
  // [autotakeover-stop-v1] 纯 autoTakeover（无 loop）场景：点击即关闭接管
  if (autoTakeoverEnabled.value && !isLoopActive.value && !running.value) {
    disableAutoTakeover()
    clearSoftPause()
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

// [script-panel-utils-v2-extracted]
async function addAttachedFile(file: File): Promise<void> {
  if (file.size > MAX_ATTACH_BYTES) {
    toast(`附件 ${file.name} 超 ${fmtSize(MAX_ATTACH_BYTES)}，已跳过`, 'warn', 4000)
    return
  }
  const isImage = file.type.startsWith('image/')
  try {
    const content = isImage ? await readAsDataUrl(file) : await readAsText(file)
    attachedFiles.value.push({
      id: `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: file.name || (isImage ? 'pasted-image' : 'file'),
      size: file.size,
      kind: isImage ? 'image' : 'text',
      content,
    })
  } catch {
    /* ignore */
  }
}
/**
 * 移除 Attach
 * @param id - id
 */
function removeAttach(id: string): void {
  attachedFiles.value = attachedFiles.value.filter(f => f.id !== id)
}
/**
 * 清空 All
 */
function clearAll(): void {
  script.value = ''
  attachedFiles.value = []
}
/**
 * 响应 Editor Paste
 * @param e - e
 */
async function onEditorPaste(e: ClipboardEvent): Promise<void> {
  const items = Array.from(e.clipboardData?.items || [])
  const images: File[] = []
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) images.push(f)
    }
  }
  if (!images.length) return // 普通文本粘贴交给 CodeMirror 处理
  e.preventDefault()
  for (const f of images) await addAttachedFile(f)
}
/**
 * 响应 Desktop Drop
 * @param e - e
 */
async function onDesktopDrop(e: DragEvent): Promise<void> {
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  e.preventDefault()
  for (const f of files) await addAttachedFile(f)
  fileSuccess.value = true
  setTimeout(() => { fileSuccess.value = false }, 1500)
}
// [script-panel-utils-v2-extracted]
/**
 * 拉取 Tree Paths
 * @param rootPath - root Path
 */
async function fetchTreePaths(rootPath: string): Promise<string[]> {
  const out: string[] = []
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes || []) {
      if (n.type === 'file') out.push(String(n.path || ''))
      else if (n.children) walk(n.children)
    }
  }
  try {
    const res = await fetch(`/__ai/files/tree?path=${encodeURIComponent(rootPath)}`)
    const data = await res.json() as { tree?: FileNode[] }
    walk(data.tree || [])
  } catch { /* ignore */ }
  return out.filter(Boolean)
}
/**
 * 添加 Tree Paths
 * @param paths - paths
 */
async function addTreePaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (!p) continue
    if (attachedFiles.value.some(a => a.name === p)) continue
    const tree = await fetchTreePaths(p)
    if (tree.length) {
      // 文件夹：只加一个 tag，发送时展开
      attachedFiles.value.push({
        id: `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: p,
        size: tree.length,
        kind: 'folder',
        content: '',
        paths: tree,
      })
      continue
    }
    // 单文件：直接读源码
    try {
      const res = await fetch('/__ai/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [p] }),
      })
      const data = await res.json()
      const f = (data.files || [])[0]
      if (!f) continue
      if (f.error) {
        continue
      }
      const content = String(f.content || '')
      attachedFiles.value.push({
        id: `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: p,
        size: content.length,
        kind: 'text',
        content,
      })
    } catch {
      /* ignore */
    }
  }
}
/**
 * 响应 Tree Drop
 * @param e - e
 */
function onTreeDrop(e: Event) {
  const d = (e as CustomEvent).detail as { paths: string[], x: number, y: number }
  if (!d || !isInEditor(d.x, d.y)) return
  void addTreePaths(d.paths || [])
}
// [script-panel-utils-v2-extracted]
/**
 * 拉取 Folder Contents
 * @param paths - paths
 */
async function fetchFolderContents(paths: string[]): Promise<Array<{ path: string, content: string }>> {
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    const data = await res.json() as FilesReadResponse
    return (data.files || []).filter(f => !f.error).map(f => ({ path: String(f.path), content: String(f.content || '') }))
  } catch { return [] }
}
/**
 * 构建 Script With Attachments
 * @param scriptText - script Text
 * @param files - files
 */
async function buildScriptWithAttachments(scriptText: string, files: AttachedFile[]): Promise<string> {
  if (!files.length) return scriptText
  const isBash = isBashScript(scriptText)
  const p = isBash ? '#' : '//'
  const parts: string[] = []
  for (const f of files) {
    if (f.kind === 'folder' && f.paths && f.paths.length) {
      parts.push(`${p} ═════ 附件目录 ${f.name} (${f.paths.length} 文件) ═════`)
      const contents = await fetchFolderContents(f.paths)
      for (const cf of contents) {
        parts.push(`${p} ----- ${cf.path} -----`)
        for (const line of cf.content.split('\n')) parts.push(`${p} ${line}`)
      }
    } else if (f.kind === 'image') {
      parts.push(`${p} ═════ 附件图片 ${f.name} (${fmtSize(f.size)}) ═════`)
      parts.push(`${p} [图片数据无法嵌入，请在 AI 站点单独粘贴]`)
    } else {
      parts.push(`${p} ═════ 附件 ${f.name} (${fmtSize(f.size)}) ═════`)
      for (const line of f.content.split('\n')) parts.push(`${p} ${line}`)
    }
  }
  parts.push('')
  return parts.join('\n') + scriptText
}

// ── computed（状态栏 / 元信息 / 阶段耗时 / 流标识）──

/** 最新的 AI 流式文本（取最后一条 ai:stream 事件） */

/**
 * 获取 Change Type
 * @param p - p
 */
function getChangeType(p: string) {
  const c = changes.value.find(x => x.path === p)
  return c ? c.type : 'modified'
}

/**
 * 响应 Preview File
 * @param p - p
 */
async function onPreviewFile(p: string) {
  if (previewFile.value === p && previewBefore.value !== null) { previewFile.value = null; return }
  previewFile.value = p
  try {
    const resAfter = await fetch('/__ai/files/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [p] }) })
    const dataAfter = await resAfter.json()
    previewAfter.value = dataAfter.files?.[0]?.content || ''

    if (!result.value?.runId) { previewBefore.value = ''; return }
    const resBefore = await fetch('/__ai/files/before', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: result.value.runId, file: p }) })
    const dataBefore = await resBefore.json()
    previewBefore.value = dataBefore.content ?? ''
  } catch (e) { log.error('Diff load failed', e); previewBefore.value = '' }
}

/**
 * 响应 Rollback
 * @param file - file
 */
async function onRollback(file: string) {
  const data = await rollback(file)
  if (data && !data.ok) toast(`撤回失败：${data.error || '未知'}`, 'error')
  if (previewFile.value === file) previewFile.value = null
}

/**
 * 响应 Rollback All
 */
async function onRollbackAll() {
  await rollbackAll()
  previewFile.value = null
}

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

  await appendFailedSourceFiles(p, errorLocs)
  appendFeedbackSummary(p)
  appendChangeList(p)
  appendDryRunFailure(p)
  appendSmokeReport(p)
  appendTscReport(p)
  appendLintReport(p)
  appendTestReport(p)
  await appendBaselineChanges(p, errorLocs)
  appendClaimMismatch(p)
  appendRawOutputs(p)

  const text = p.join('\n')
  return trimPromptIfOverBudget(text)
}

/** 失败时把相关文件源码块追加到 prompt 数组（去重后取前 5 个路径） */
async function appendFailedSourceFiles(p: string[], errorLocs: ReturnType<typeof parseErrorLocations>): Promise<void> {
  const r = result.value
  if (!r || r.ok) return
  const changedPaths = changes.value.filter(c => c.type !== 'deleted').map(c => c.path)
  const errorPaths = r.errorFiles ?? []
  const mergedPaths = [...new Set([...errorPaths, ...changedPaths])].slice(0, 5)
  if (mergedPaths.length === 0) return
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: mergedPaths }),
    })
    const data = await res.json()
    if (data.files?.length) {
      p.push('# 相关文件源码（失败时自动附加，含报错涉及的文件）')
      p.push(buildErrorContext(data.files, errorLocs, {
        stripComments: stripComments.value,
        stripBlankLines: stripBlankLines.value,
      }))
      p.push('')
    }
  } catch (e) {
    p.push(`# ⚠️ 获取变更文件源码失败: ${String(e)}`)
    p.push('')
  }
}

/** 追加三层反馈摘要（行为层 → 类型层 → 代码层，含通过项） */
function appendFeedbackSummary(p: string[]): void {
  const r = result.value
  if (!r) return
  const issues: string[] = []
  const okLine: string[] = []
  if (r.test?.ran) {
    if (!r.test.ok) issues.push('行为层: 单测失败（见下 # 单元测试）')
    else okLine.push('test ✓')
  }
  if (r.smoke?.ran && !r.smoke.ok) issues.push('行为层: 冒烟失败（见下 # 页面冒烟）')
  if (r.dryRunFailed) issues.push('行为层: 脚本运行中断，磁盘零改动')
  if (r.code !== 0 && !r.dryRunFailed && r.code !== -1) {
    issues.push(`行为层: 退出码 ${r.code}`)
  }
  if (r.tsc) {
    if (r.tsc.ok === false) issues.push('类型层: tsc 报错（见下 # 类型检查）')
    else okLine.push('tsc ✓')
  }
  if (r.lint?.ran) {
    if (!r.lint.ok) issues.push('代码层: eslint 报错（见下 # 代码格式化）')
    else okLine.push('lint ✓')
  }
  p.push('# 三层反馈摘要')
  if (issues.length === 0) {
    p.push(`✓ 无阻塞问题${okLine.length ? `（${okLine.join(' / ')}）` : ''}`)
  } else {
    p.push('按优先级：')
    for (const i of issues) p.push(`- ${i}`)
    if (okLine.length) p.push(`已通过：${okLine.join(' / ')}`)
  }
  p.push('')
}

/** 追加变更文件列表（有变更时） */
function appendChangeList(p: string[]): void {
  if (!changes.value.length) return
  p.push('# 变更')
  p.push('```')
  changes.value.forEach(c => p.push(`${c.type} ${c.path}`))
  p.push('```')
  p.push('')
}

/** 追加预检失败块（dryRunFailed 时） */
function appendDryRunFailure(p: string[]): void {
  const r = result.value
  if (!r?.dryRunFailed) return
  p.push('# ⚠ 预检失败：脚本未通过校验，磁盘零改动', '')
  p.push(`- 脚本本想改动 ${r.dryRunChangeCount ?? 0} 个文件，但执行中途失败，磁盘上没有任何变化`)
  p.push(`- 原因：${r.dryRunReason || '脚本运行时错误（非类型错误）'}`)
  if (r.wantChanges?.length) {
    p.push('- 脚本声称/尝试的改动：')
    for (const c of r.wantChanges.slice(0, 20)) p.push(`  - [${c.type}] ${c.path}`)
    if (r.wantChanges.length > 20) p.push(`  - ... 共 ${r.wantChanges.length} 个`)
  }
  p.push('- 请基于下方 stderr 定位根因，重新生成完整脚本；不要再给出会中途抛错的版本')
  p.push('')
}

/** 追加页面冒烟结果（smoke.ran 时） */
function appendSmokeReport(p: string[]): void {
  const r = result.value
  if (!r?.smoke?.ran) return
  p.push('# 页面冒烟')
  if (r.smoke.error) {
    p.push(`启动失败: ${r.smoke.error}`)
  } else {
    for (const pg of r.smoke.pages) {
      p.push(`${pg.ok ? '✓' : '✗'} ${pg.url}`)
      for (const e of pg.errors) p.push(`  ${e}`)
    }
  }
  p.push('')
}

/** 追加类型检查报告（tsc 时） */
function appendTscReport(p: string[]): void {
  const r = result.value
  if (!r?.tsc) return
  p.push('# 类型检查 (tsc)')
  p.push(r.tsc.ok ? '✓ 通过' : '✗ 存在类型错误')
  p.push('```')
  p.push((r.tsc.stdout || '') + (r.tsc.stderr ? `\n${r.tsc.stderr}` : ''))
  p.push('```')
  p.push('')
}

/** 追加 eslint 报告（lint.ran 且失败时） */
function appendLintReport(p: string[]): void {
  const r = result.value
  if (!r?.lint?.ran || r.lint.ok) return
  p.push('# 代码格式化 (eslint)')
  p.push('✗ 存在 lint 错误')
  p.push('```')
  p.push((r.lint.stdout || '') + (r.lint.stderr ? `\n${r.lint.stderr}` : ''))
  p.push('```')
  p.push('')
}

/** 追加单元测试报告（test.ran 且失败时） */
function appendTestReport(p: string[]): void {
  const r = result.value
  if (!r?.test?.ran || r.test.ok) return
  p.push('# 单元测试')
  p.push('✗ 存在测试失败')
  p.push('```')
  p.push((r.test.stdout || '') + (r.test.stderr ? `\n${r.test.stderr}` : ''))
  p.push('```')
  p.push('')
}

/** 追加跨轮累积变更（baselineRunId 存在且与当前 runId 不同时） */
async function appendBaselineChanges(p: string[], errorLocs: ReturnType<typeof parseErrorLocations>): Promise<void> {
  const r = result.value
  const baseline = r?.baselineRunId
  if (!r || !baseline || baseline === r.runId) return
  try {
    const res = await fetch('/__ai/diff-from-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineRunId: baseline }),
    })
    const data = await res.json()
    const acc = data.changes || []
    if (acc.length && shouldIncludeChanges(acc, errorLocs)) {
      p.push(`# 跨轮累积变更（基准 ${baseline}）`)
      p.push('```')
      for (const c of acc) p.push(`${c.type} ${c.path}`)
      p.push('```')
      p.push('')
    }
  } catch { /* ignore */ }
}

/** 追加脚本声明 vs 实际改动差异块（claimMismatch 时） */
function appendClaimMismatch(p: string[]): void {
  const cm = result.value?.claimMismatch
  if (!cm) return
  if (cm.missing.length || cm.extra.length || !cm.actual.length) {
    p.push('# 脚本声明的改动 vs 实际改动')
    p.push(`声明：${cm.claimed.join(', ') || '（无）'}`)
    p.push(`实际：${cm.actual.join(', ') || '（无）'}`)
    if (cm.extra.length) p.push(`⚠ 未声明但改动：${cm.extra.join(', ')}`)
    if (!cm.actual.length) p.push('⚠ 脚本未产生任何文件改动')
    p.push('')
  }
}

/** 追加 stderr / stdout 原始输出块 */
function appendRawOutputs(p: string[]): void {
  const r = result.value
  if (!r) return
  if (r.stderr) p.push('# 错误输出 (stderr)', '```', trimOutput(r.stderr, r.ok, 3000, 12000, r.scriptCtx), '```', '')
  if (r.stdout) p.push('# Stdout', '```', trimOutput(r.stdout, r.ok, 3000, 12000, r.scriptCtx), '```', '')
}

/** 预算裁剪：超预算时对「相关文件源码」块做二次裁剪 */
function trimPromptIfOverBudget(text: string): string {
  const budget = enforceBudget(text)
  if (budget.ok) return text
  const marker = '# 相关文件源码'
  const idx = text.indexOf(marker)
  if (idx < 0) {
    toast(`prompt 超预算：${budget.size} / ${budget.budget} 字节`, 'warn', 4000)
    return text
  }
  const head = text.slice(0, idx)
  const tail = text.slice(idx)
  const tailLines = tail.split('\n')
  const keep = tailLines.slice(0, 200).join('\n')
  const keepRest = tailLines.slice(200)
  const trimmed = `${head + keep}\n// …（prompt 超预算，已省略 ${keepRest.length} 行源码）\n`
  const after = enforceBudget(trimmed)
  if (after.ok) {
    toast(`prompt 超预算，已裁剪源码块到 ${after.size} 字节`, 'warn', 4000)
  } else {
    toast(`prompt 仍超预算（${after.size} 字节），请减少附加文件`, 'error', 5000)
  }
  return trimmed
}

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

/**
 * 加载 Cmd History
 */
function loadCmdHistory(): string[] {
  try {
    const raw = localStorage.getItem(CMD_HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
/**
 * 执行 push Cmd History
 * @param cmd - cmd
 */
function pushCmdHistory(cmd: string) {
  const arr = cmdHistory.value.filter(c => c !== cmd)
  arr.unshift(cmd)
  cmdHistory.value = arr.slice(0, 100)
  try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(cmdHistory.value)) } catch { }
  cmdHistoryIndex = -1
  cmdHistoryDraft = ''
}
/**
 * 执行 cmd History Prev
 */
function cmdHistoryPrev() {
  if (!cmdHistory.value.length) return
  if (cmdHistoryIndex === -1) cmdHistoryDraft = script.value
  cmdHistoryIndex = Math.min(cmdHistoryIndex + 1, cmdHistory.value.length - 1)
  script.value = cmdHistory.value[cmdHistoryIndex]
}
/**
 * 执行 cmd History Next
 */
function cmdHistoryNext() {
  if (cmdHistoryIndex === -1) return
  cmdHistoryIndex--
  if (cmdHistoryIndex < 0) script.value = cmdHistoryDraft
  else script.value = cmdHistory.value[cmdHistoryIndex]
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
  // 无 shebang：默认问 AI
  void askAi(text)
}

// 用户手选 + 后端按 question 自动匹配
/**
 * 加载 Skills For Ask
 * @param question - question
 */
async function loadSkillsForAsk(question: string): Promise<string> {
  const parts: string[] = []

  // 1. 用户手选
  let selected: string[] = ['gen-script-rules']
  try {
    const raw = localStorage.getItem(LS_SKILLS_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) selected = arr
    }
  } catch { }
  if (selected.length) {
    try {
      const res = await fetch('/__ai/skills')
      const all = await res.json() as SkillInfo[]
      if (Array.isArray(all)) {
        const picked = all.filter(s => selected.includes(s.name))
        if (picked.length) parts.push(picked.map(s => s.content).join('\n\n---\n\n'))
      }
    } catch { }
  }

  // 2. 后端按 question 自动匹配（常驻 4 条 + 关键词命中）
  try {
    const res = await fetch('/__ai/skills/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: question }),
    })
    if (res.ok) {
      const data = await res.json()
      const auto = String(data?.content || '').trim()
      if (auto) parts.push(auto)
    }
  } catch { }

  return parts.join('\n\n---\n\n')
}

/**
 * 执行 expand At Refs
 * @param text - text
 */
async function expandAtRefs(text: string): Promise<string> {
  const re = /(?:^|\n)\s*@([\w./-]+)/g
  const paths: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const p = m[1]
    if (!seen.has(p)) { seen.add(p); paths.push(p) }
  }
  if (!paths.length) return ''
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    const data = await res.json()
    const parts: string[] = []
    for (const f of data.files || []) {
      if (f.error) parts.push(`<file path="${f.path}" error="${f.error}"></file>`)
      else parts.push(`<file path="${f.path}">` + `\n${f.content}\n` + `</file>`)
    }
    return parts.join('\n\n')
  } catch (e) {
    return `（读取文件失败：${String(e)}）`
  }
}

/**
 * 执行 ask Ai
 * @param question - question
 */
async function askAi(question: string) {
  startAiWaiting()
  if (!question) { toast('@ 后没有内容', 'warn'); return }
  const skills = await loadSkillsForAsk(question)
  const fileBlocks = await expandAtRefs(question)
  const cleanQuestion = question.replace(/(?:^|\n)[ \t]*@[\w./-]+[ \t]*/g, '').trim()
  const segs: string[] = []
  if (skills) segs.push(`# 规则\n\n${skills}`)
  if (fileBlocks) segs.push(`# 相关文件\n\n${fileBlocks}`)
  if (cleanQuestion) segs.push(`# 问题\n\n${cleanQuestion}`)
  const prompt = segs.join('\n\n')
  const r = await copyAndFill(prompt)
  // [sp-autopause-v2] 发送脚本给 AI 后进入暂停态；用 softPause 避免 sendStop 取消刚发出的 fill
  if (r) softPause()
  if (r === 'failed') {
    toast('发送失败，已复制到剪贴板', 'warn', 4000)
    return
  }
  const askKey = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  // [askcount-unify] 计数已下沉到 copyAndFill；此处仅做阈值轮转
  // 阈值轮转
  {
    const rr = maybeRotateSession(summary => sendNewSession({ summary }))
    if (rr.fired) {
      if (rr.sent) {
        toast(`已达 ${rr.overCount} 次提问，已请求开启新对话`, 'info', 4000)
      } else {
        toast(`已达 ${rr.overCount} 次提问，但 AI 窗口未就绪（请点右上角「打开 AI 窗口」）`, 'warn', 6000)
      }
    }
  }
  setPendingAskKey(askKey)
  emit('ai:ask', question.slice(0, 100), { payload: { question, prompt, phase: 'pending' }, updateKey: askKey })
  statusText.value = '✅ 已发送'
  statusClass.value = 'ok'
  // [P2-2c] 保留编辑器内容（不清空）：script.value = ''
  startAiWaiting()
  setTimeout(() => { statusText.value = ''; statusClass.value = '' }, 1500)
}
/**
 * 执行 Cmd Internal
 * @param cmd - cmd
 * @param policy - policy
 * @param cmdText - cmd Text
 */
async function execCmdInternal(cmd: string, policy: string, cmdText: string): Promise<void> {
  execPolicyOverride = policy
  try {
    await execCmd(cmdText)
  } finally {
    execPolicyOverride = null
  }
}
/**
 * 执行 Cmd
 * @param text - text
 */
async function execCmd(text: string) {
  const raw = text.trim()
  if (!raw || running.value) return
  if (!raw.startsWith('!')) return
  // [P2-2c] 保留编辑器内容（不清空）：script.value = ''
  pushCmdHistory(raw)
  runningCommand.value = raw
  const cmd = raw.slice(1).trim()
  running.value = true
  result.value = null
  changes.value = []
  liveStdout.value = ''
  liveStderr.value = ''
  let exitCode = -1
  try {
    const res = await fetch('/__ai/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, bashPolicy: execPolicyOverride || (() => { try { return localStorage.getItem(LS_BASH_POLICY_KEY) || 'on-request' } catch { return 'on-request' } })() }),
    })
    if (!res.ok || !res.body) {
      let approval = null
      try { approval = await res.clone().json() } catch { }
      if (approval && approval.needsApproval) {
        const go = await confirmDialog(`bash 命中黑名单：${approval.blacklistHit}\n\n${cmd}\n\n是否继续执行？`, { type: 'danger', okText: '继续执行', cancelText: '取消' })
        if (!go) {
          result.value = { runId: '', code: -1, ok: false, stdout: '', stderr: '用户拒绝执行', changes: [], error: '用户拒绝执行' }
          running.value = false
          return
        }
        return execCmdInternal(cmd, 'always', runningCommand.value)
      }
      let detail = ''
      try { detail = await res.text() } catch { }
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`)
    }
    await readNdjson<{ stream?: string, data?: string, code?: number }>(res.body, (j) => {
      if (j.stream === 'stdout') liveStdout.value += String(j.data || '')
      else if (j.stream === 'stderr') liveStderr.value += String(j.data || '')
      else if (j.stream === 'exit') exitCode = j.code ?? -1
    })
    result.value = {
      runId: '',
      code: exitCode,
      ok: exitCode === 0,
      stdout: liveStdout.value,
      stderr: liveStderr.value,
      changes: [],
    }
  } catch (e) {
    result.value = {
      runId: '',
      code: -1,
      ok: false,
      stdout: liveStdout.value,
      stderr: `请求异常：${String(e)}`,
      changes: [],
      error: `请求异常：${String(e)}`,
    }
  } finally {
    running.value = false
  }
}
/**
 * 复制 Output
 * @param force - force
 */
async function copyOutput(force = false) {
  if (!result.value) return
  try {
    const runKey = result.value.runId || `${result.value.code}|${(result.value.stderr || '').slice(0, 64)}`
    if (!force && lastAutoAskedRunId === runKey) return
    lastAutoAskedRunId = runKey
    const text = await buildAiPrompt()
    if (!text) return
    const r = await copyAndFill(text)
    // [sp-autopause-v1] 发送成功即进入暂停态；用 softPause 避免 sendStop 取消 fill
    if (r) softPause()
    if (r === 'failed') {
      toast('发送失败，已复制到剪贴板', 'warn', 4000)
      return
    }
    emit('ai:feedback', `📤 回传 AI：${changes.value.length} 文件 · exit ${result.value?.code ?? -1}`, { payload: { prompt: text.slice(0, 8000), changes: changes.value.map(c => ({ path: c.path, type: c.type })), exit: result.value?.code ?? -1, ok: result.value?.ok ?? false } })
    // 回传也计入 askCount，需与手动提问一致做阈值轮转
    try { maybeRotateSession(summary => sendNewSession({ summary })) } catch { /* ignore */ }
    copied.value = true
    startAiWaiting()
    setTimeout(() => { copied.value = false }, 2000)
  } catch (e) { log.error(e) }
}

// stderr 里把 file.ts:12:34 变成可点击（点击复制路径）
// ponytail: 不做跨文件跳转（无 Monaco，行号可能失准），只复制路径。

/**
 * 读取 Draft Slots
 */
function readDraftSlots(): DraftSlot[] {
  try {
    const raw = localStorage.getItem(DRAFT_SLOTS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr.filter((s: unknown): s is DraftSlot => {
          const o = s as Record<string, unknown>
          return typeof o?.id === 'string' && typeof o?.text === 'string'
        })
      : []
  } catch { return [] }
}
/**
 * 执行 persist Draft Slots
 */
function persistDraftSlots(): void {
  try { localStorage.setItem(DRAFT_SLOTS_KEY, JSON.stringify(draftSlots.value)) } catch { /* ignore */ }
  try { localStorage.setItem(DRAFT_ACTIVE_KEY, activeDraftId.value) } catch { /* ignore */ }
}
/**
 * 执行 upsert Draft Slot
 * @param id - id
 * @param text - text
 * @param name - name
 */
function upsertDraftSlot(id: string, text: string, name?: string): void {
  const i = draftSlots.value.findIndex(s => s.id === id)
  const item: DraftSlot = { id, text, ts: Date.now(), name: name || (i >= 0 ? draftSlots.value[i].name : id) }
  if (i >= 0) draftSlots.value[i] = item
  else draftSlots.value.push(item)
  persistDraftSlots()
}
watch(script, (v) => {
  if (draftPersistTimer) clearTimeout(draftPersistTimer)
  draftPersistTimer = setTimeout(() => {
    upsertDraftSlot(activeDraftId.value, String(v || ''))
  }, 400)
})
/**
 * 响应 Side Down
 * @param e - e
 */
function onSideDown(e: PointerEvent) {
  resizingSide.value = true
  window.addEventListener('pointermove', onSideMove)
  window.addEventListener('pointerup', onSideUp)
  e.preventDefault()
}
/**
 * 响应 Side Move
 * @param e - e
 */
function onSideMove(e: PointerEvent) {
  if (!paneRef.value) return
  const rect = paneRef.value.getBoundingClientRect()
  // handle 宽 14px，取中心作为分界
  const w = rect.right - e.clientX - 7
  sideWidth.value = Math.max(280, Math.min(rect.width * 0.6, w))
}
/**
 * 响应 Side Up
 */
function onSideUp() {
  resizingSide.value = false
  sideWidthBase.value = sideWidth.value
  try { localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidth.value)) } catch { /* ignore */ }
  window.removeEventListener('pointermove', onSideMove)
  window.removeEventListener('pointerup', onSideUp)
}

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
  // preload-skills-on-mount
  void loadSkillsList()
  // [P2-2b] 草稿槽位恢复
  try {
    draftSlots.value = readDraftSlots()
    const activeSaved = localStorage.getItem(DRAFT_ACTIVE_KEY)
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
  window.removeEventListener('pointermove', onSideMove)
  window.removeEventListener('pointerup', onSideUp)
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
