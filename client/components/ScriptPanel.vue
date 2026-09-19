<template>
  <div ref="paneRef" class="pane" :class="{ 'is-resizing-side': resizingSide }">
    <!-- 左侧主区域 -->
    <div
      ref="mainRef"
      class="pane-main"
      :class="{ 'is-dragging': fileDragging, 'is-success': fileSuccess }"
      @dragover="onHtmlDragOver"
      @drop="onHtmlDrop"
    >
      <!-- 自动化循环控制条（P2） -->
      <section v-if="loopState !== 'idle'" class="loop-bar card" :class="`is-${loopState}`">
<template v-if="loopState === 'budget-limited'">
          <span class="loop-status">
            <span>⏸</span>
            预算已用尽 · 第 {{ loopRound }}/{{ maxRounds }} 轮
          </span>
          <span class="loop-goal-text" :title="loopGoal">{{ loopGoal.slice(0, 40) }}</span>
          <div class="loop-actions">
            <button v-tooltip="'从当前轮次继续（token 基线重置）'" class="loop-btn" @click="resumeLoop">▶ 继续</button>
            <button v-tooltip="'急停并 git reset 到循环起点'" class="loop-btn rollback" @click="stopAndRollback">⏹ 停止并回滚</button>
          </div>
        </template>
        <template v-else-if="loopState === 'waiting-input'">
          <span class="loop-status">
            <span>⏸</span>
            决策点 · 第 {{ loopRound }}/{{ maxRounds }} 轮
          </span>
          <span class="loop-goal-text" :title="pendingDecision?.question">{{ pendingDecision?.question || '（缺问题文本）' }}</span>
          <div class="loop-actions decision-actions">
            <button
              v-for="opt in (pendingDecision?.options || [])"
              :key="opt.id"
              v-tooltip="`选择「${opt.label}」并回填 AI`"
              class="loop-btn decision-btn"
              @click="submitDecision(opt.id)"
            >
{{ opt.label }}
</button>
            <button v-tooltip="'取消决策点，结束循环'" class="loop-btn" @click="submitDecision('__cancel__')">取消</button>
<button v-tooltip="'输入自定义答案'" class="loop-btn" @click="decisionCustomOpen = !decisionCustomOpen">✎ 自定义</button>
          </div>
          <div v-if="decisionCustomOpen" class="decision-custom">
            <input
              v-model="decisionCustomText"
              class="decision-input"
              placeholder="输入答案后回车发送"
              @keydown.enter.prevent="submitDecisionCustom"
            />
            <button class="loop-btn primary" :disabled="!decisionCustomText.trim()" @click="submitDecisionCustom">发送</button>
          </div>
        </template>
        <template v-else-if="isLoopActive">
          <span class="loop-status">
            <span class="loop-spin">{{ stateIcon }}</span>
            <span class="loop-stage-badge" :class="stageClass">{{ stageLabel }}</span>
            第 {{ loopRound }}/{{ maxRounds }} 轮 · {{ loopState }}
            · tok {{ (tokenDelta / 1000).toFixed(1) }}k/{{ tokenBudget / 1000 }}k
            <template v-if="loopCost !== null"> · {{ formatCost(loopCost) }}（{{ (loopUsage.prompt_tokens / 1000).toFixed(1) }}k / {{ (loopUsage.completion_tokens / 1000).toFixed(1) }}k）</template>
            · 宽容 {{ toleranceLeft }}
          </span>
          <span v-if="loopState === 'waiting'" class="loop-waiting-progress" :title="`等待 AI 回复（已等 ${waitingElapsed}s / 总 ${Math.round(roundTimeoutMs / 1000)}s，超时即熔断）`">
            <span class="loop-waiting-text">⏱ {{ waitingElapsed }}s / {{ Math.round(roundTimeoutMs / 1000) }}s</span>
            <span class="loop-waiting-bar"><span class="loop-waiting-fill" :style="{ width: waitingPct + '%' }" /></span>
          </span>
          <span class="loop-round-bar" :title="`轮次 ${loopRound}/${maxRounds}`">
            <span class="loop-round-fill" :style="{ width: roundPct + '%' }" />
          </span>
          <span class="loop-goal-text" :title="loopGoal">{{ loopGoal.slice(0, 40) }}</span>
          <div class="loop-actions">
            <button v-tooltip="'立即终止当前执行（不等本轮完成）'" class="loop-btn kill" @click="killCurrent">■ 停当前</button>
            <button v-tooltip="'Esc：当前轮跑完即停，不再发下一轮'" class="loop-btn" disabled>⏸ 暂停(Esc)</button>
            <button v-tooltip="'Ctrl+Esc：急停并 git reset 到循环起点'" class="loop-btn rollback" @click="stopAndRollback">⏹ 停止并回滚</button>
            <button v-tooltip="'请求 AI 总结当前会话，切到新会话继续循环'" class="loop-btn" @click="startHandoff">🔄 轮转</button>
            <button v-tooltip="'给 AI 补充说明（下一轮反馈时带上）'" class="loop-btn" @click="showUserNote = !showUserNote">📝 补充</button>
          </div>
        </template>
        <template v-else>
          <span class="loop-end-status">
            {{ loopState === 'interrupted' ? '⏹ 已中断' : '■ 已停止' }} · 第 {{ loopRound }}/{{ maxRounds }} 轮
            <em v-if="stopReason">（{{ stopReason }}）</em>
          </span>
          <button v-if="lastGoal" v-tooltip="`用相同目标重跑：${lastGoal.slice(0, 60)}`" class="loop-btn" @click="startLoop(lastGoal)">🔄 再来一次</button>
          <button class="loop-btn" @click="loopState = 'idle'">收起</button>
        </template>
      </section>
      <section v-if="showUserNote && isLoopActive" class="note-bar card">
        <textarea
          v-model="userNoteDraft"
          class="note-input"
          rows="2"
          placeholder="给 AI 的补充说明（提交后下一轮反馈时带上，提交后清空）"
        />
        <div class="note-actions">
          <button class="loop-btn" @click="showUserNote = false; userNoteDraft = ''">取消</button>
          <button class="loop-btn primary" :disabled="!userNoteDraft.trim()" @click="submitUserNote">保存</button>
        </div>
      </section>
      <!-- 终端 (上方) -->
      <section class="terminal card">
        <header class="bar term-bar">
          <div class="bar-actions">

          </div>
        </header>

        <div ref="termBodyRef" class="term-body">
          <div class="chat-list">
            <template v-for="e in chatItems" :key="e.id">
              <div
                v-if="e.kind === 'ai:stream'"
                class="chat-think"
                @click="toggleTreeNode(e.id)"
              >
                <span class="think-icon">🧠</span>
                <span class="think-label">已思考（{{ fmtTreeTime(e.ts) }}）</span>
                <span class="think-caret" :class="{ open: treeExpanded.has(e.id) }">▸</span>
              </div>
              <div
                v-if="e.kind === 'ai:stream' && treeExpanded.has(e.id)"
                class="chat-bubble bubble-left bubble-think"
                v-html="renderMarkdown(e.summary)"
              />
              <div v-else-if="e.role === 'user'" class="chat-msg chat-msg-user">
                <div class="bubble-head">👤 我 · {{ fmtTreeTime(e.ts) }}</div>
                <div class="bubble-body" v-html="renderUserBubble(e)" />
              </div>
              <div v-else-if="e.role === 'step'" class="chat-step" :class="'state-' + stepStateOf(e)">
                <span class="step-dot" />
                <span class="step-icon">{{ stepIconOf(e) }}</span>
                <span class="step-title">{{ stepTitleOf(e) }}</span>
                <span class="step-time">{{ fmtTreeTime(e.ts) }}</span>
                <span class="step-state">{{ stepLabelOf(e) }}</span>
              </div>
              <div v-else-if="e.role === 'ai'" class="chat-msg chat-msg-ai">
                <div class="bubble-head">🤖 AI · {{ fmtTreeTime(e.ts) }}</div>
                <div class="bubble-body" v-html="renderAiBubble(e)" />
              </div>
              <div v-else class="chat-sys">
                <span class="sys-tag">{{ treeIcon(e.kind) }} {{ e.summary }}</span>
                <span class="sys-time">{{ fmtTreeTime(e.ts) }}</span>
              </div>
            </template>
            <div v-if="aiWaiting" class="chat-msg chat-msg-ai chat-waiting">
              <div class="bubble-head">
                <span class="msg-avatar">🤖</span>
                <span class="msg-name">AI</span>
              </div>
              <div class="bubble-body">
                <span class="waiting-dots"><i /><i /><i /></span>
                <span class="waiting-text">正在思考…</span>
              </div>
            </div>
            <div v-if="!chatItems.length" class="tree-empty">
              <div class="empty-title">还没有会话记录</div>
              <div class="empty-sub">点击「运行」开始自动化循环</div>
            </div>
          </div>
        </div>
      </section>
      <!-- 编辑器 (下方) -->
      <section class="editor card" :class="{ 'is-running': running }">

        <div class="tpl-bar">
          <span v-tooltip="'运行 / 保存'" class="kbd-hint">
            <kbd>⌘</kbd><span class="slash">/</span><kbd>Ctrl</kbd><span class="plus">+</span><kbd>↵</kbd>
          </span>
          <span class="tpl-divider" />
          <button
            v-for="t in TEMPLATES"
            :key="t.id"
            v-tooltip="`模板：${t.label} — ${t.title}`"
            class="tpl-chip"
            @click="applyTemplate(t.code)"
          >
            {{ t.label }}
          </button>
          <div class="tpl-spacer" />
          <button v-tooltip="'清空编辑器内容（不落盘）'" class="ghost-btn" :disabled="running || !script" @click="script = ''">
            清空
          </button>
          <button
            v-if="running || isLoopActive || autoTakeoverEnabled"
            v-tooltip="'暂停：停止当前执行并关闭自动接管'"
            class="primary-btn stop head-run"
            @click="pauseAll"
          >
            <svg class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="4" x2="9" y2="20" /><line x1="15" y1="4" x2="15" y2="20" /></svg>
            <span>{{ autoTakeoverCountdown > 0 ? '暂停 · ' + autoTakeoverCountdown + 's' : '暂停' }}</span>
          </button>
          <button
            v-else
            v-tooltip="'运行：执行脚本 → 结果自动发 AI → AI 回复后自动执行下一轮'"
            class="primary-btn takeover head-run"
            @click="toggleAutoTakeover"
          >
            <svg class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4" /></svg><span>运行</span>
          </button>
        </div>
        <div class="editor-body">
          <!-- @FILE_PICKER_V1 -->
          <div v-if="pickerOpen" ref="pickerRef" class="file-picker" :style="pickerStyle">
            <input
              ref="pickerInputRef"
              v-model="pickerQuery"
              class="fp-input"
              placeholder="搜索文件，Enter 选择，Esc 取消"
              @keydown.down.prevent="pickerMove(1)"
              @keydown.up.prevent="pickerMove(-1)"
              @keydown.enter.prevent="pickerConfirm"
              @keydown.esc.prevent="pickerClose"
            />
            <div class="fp-list">
              <div
                v-for="(f, i) in pickerFiltered"
                :key="f"
                class="fp-item"
                :class="{ active: i === pickerIndex }"
                @mousedown.prevent="pickerPick(f)"
              >
                {{ f }}
              </div>
              <div v-if="!pickerFiltered.length" class="fp-empty">
                无匹配文件
              </div>
            </div>
          </div>
          <div
            ref="cmHost"
            class="cm-host"
            tabindex="0"
          />
        </div><footer class="editor-foot">
          <span v-if="persistWarning" v-tooltip="persistWarning" class="persist-warning">⚠ 会话存储已满</span>
          <div class="foot-spacer" />

          <span
            v-if="result?.error"
            v-tooltip="result.error"
            class="req-err-badge"
          >
            ⛔ 请求失败
          </span>
          <span
            v-if="result?.dryRunFailed"
            v-tooltip="result.dryRunReason || '预检未通过，磁盘零改动'"
            class="dry-badge"
          >
            ⚠ 预检失败 · 未改动文件（本想改 {{ result.dryRunChangeCount ?? 0 }}）
          </span>
          <span v-if="result?.git?.after?.commit" v-tooltip="`已提交：${result.git.after.commit}`" class="git-after">
            ⎇ {{ result.git.after.commit }}
          </span>
        </footer>
      </section>

      <!-- 拖拽浮层 -->
      <div v-if="fileDragging" class="overlay drop">
        <div class="overlay-card drop">
          <div class="overlay-icon">
            📥
          </div>
          <div class="overlay-text">
            松开插入路径
          </div>
        </div>
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
      v-tooltip="'拖拽调整右侧面板宽度'"
      class="side-resize-handle"
      :class="{ active: resizingSide }"
      @pointerdown="onSideDown"
    />

    <!-- 右侧：变更列表 & Diff -->
    <!-- SIDE_VIF_CHANGES -->
    <button
      v-tooltip="sideDrawerOpen ? '收起变更面板' : '展开变更面板'"
      aria-label="切换变更面板"
      class="side-drawer-toggle"
      :class="{ 'drawer-open': sideDrawerOpen }"
      @click="sideDrawerOpen = !sideDrawerOpen"
    >
{{ sideDrawerOpen ? '›' : '‹' }}
</button>
    <div v-if="sideDrawerOpen" class="side-drawer-backdrop" @click="sideDrawerOpen = false" />
    <aside class="pane-side" :class="{ 'drawer-open': sideDrawerOpen }" :style="{ width: `${sideWidth}px` }">
      <div class="side-tabs">
        <button
          :class="{ active: sideTab === 'tree' }"
          class="side-tab"
          @click="sideTab = 'tree'"
        >
<svg class="side-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
</button>
        <button
          :class="{ active: sideTab === 'changes' }"
          class="side-tab"
          @click="sideTab = 'changes'"
        >
<svg class="side-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h6" /></svg><span v-if="changes.length" class="side-tab-badge">{{ changes.length }}</span>
</button>
      </div>
      <div v-show="sideTab === 'tree'" class="side-tree">
        <FileTree root draggable />
      </div>
      <div v-show="sideTab === 'changes'" class="side-changes">
        <div v-if="!result && !changes.length" class="side-empty">
          <div class="side-empty-icon">
            📋
          </div>
          <div class="side-empty-text">
            运行后显示变更
          </div>
        </div>
        <FileList
          v-if="changes.length"
          :changes="changes"
          :rolling="rolling"
          :busy-all="busyAll"
          :active-file="previewFile!"
          @rollback="onRollback"
          @rollback-all="onRollbackAll"
          @save="save"
          @preview="onPreviewFile"
        />
      </div>
    </aside>
    <div
      v-if="changes.length && previewFile && previewBefore !== null"
      class="diff-overlay"
      @click.self="previewFile = null"
    >
      <div class="diff-overlay-panel">
        <button v-tooltip="'关闭 diff 预览（Esc）'" class="diff-overlay-close" @click="previewFile = null">
          ×
        </button>
        <DiffViewer
          :file-name="previewFile"
          :before="previewBefore"
          :after="previewAfter"
          :change-type="getChangeType(previewFile)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ScriptPanel' })
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { useRunner } from '../composables/useRunner'
import { currentLoopContext, useAutoLoop } from '../composables/useAutoLoop'
import FileList from './FileList.vue'
import DiffViewer from './DiffViewer.vue'
import FileTree from './FileTree.vue'
import { copyAndFill } from '../composables/useDeepseekUrl'
import { formatCost } from '../utils/pricing'
import { useAiWaiting } from '../composables/useAiWaiting'
import { useAutoTakeover } from '../composables/useAutoTakeover'
import { useEventBus, emit } from '../composables/useEventStream'
import { useCodeCleaner } from '../composables/useCodeCleaner'
import { buildErrorContext, enforceBudget, parseErrorLocations } from '../utils/contextBuilder'
import { readNdjson } from '../utils/stream'
import { fnv1a8 } from '../utils/hash'
import hljs from 'highlight.js/lib/common'
import { useToast } from '../composables/useToast'
import { useTraceLog } from '../composables/useTraceLog'
import { setLastAutoFilled } from '../composables/useScriptInbox'
import type { Change, RunResponse } from '../types'
// U.3: CodeMirror 全家桶懒加载——首建编辑器时才 await import，CM 打进独立 chunk
interface CMModule {
  EditorView: any
  EditorState: any
  keymap: any
  placeholder: any
  Decoration: any
  ViewPlugin: any
  Prec: any
  Compartment: any
  RangeSetBuilder: any
  basicSetup: any
  cmJavascript: any
  oneDark: any
}
let CM: CMModule | null = null
async function ensureCM(): Promise<CMModule> {
  if (CM) return CM
  const [v, s, j, t, c] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/lang-javascript'),
    import('@codemirror/theme-one-dark'),
    import('codemirror'),
  ])
  CM = {
    EditorView: v.EditorView,
    keymap: v.keymap,
    placeholder: v.placeholder,
    Decoration: v.Decoration,
    ViewPlugin: v.ViewPlugin,
    EditorState: s.EditorState,
    Prec: s.Prec,
    Compartment: s.Compartment,
    RangeSetBuilder: s.RangeSetBuilder,
    basicSetup: (c as any).basicSetup,
    cmJavascript: j.javascript,
    oneDark: t.oneDark,
  }
  return CM
}


const { script, running, result, changes, rolling, busyAll, persistWarning, liveStdout, liveStderr, run, stop, rollback, rollbackAll, save, autoFeedbackRequested, clearAutoFeedback } = useRunner()
const { enabled: autoTakeoverEnabled, countdown: autoTakeoverCountdown, enable: enableAutoTakeover, disable: disableAutoTakeover, scheduleAutoRun, cancelAutoRun } = useAutoTakeover()
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

// —— 自动化循环（P2 useAutoLoop）——
const {
  loopState, loopRound, loopGoal, stopReason, toleranceLeft, stage,
  tokenDelta, maxRounds, tokenBudget,
  roundTimeoutMs, waitingElapsed, isLoopActive,
  loopUsage, loopCost,
  killCurrent, stopAndRollback, startHandoff, resumeLoop,
  startLoop, lastGoal, userNote,
  pendingDecision, submitDecision,
} = useAutoLoop()
// 倒计时进度百分比：waitingElapsed / roundTimeoutMs
const showUserNote = ref(false)
const userNoteDraft = ref('')
function submitUserNote() {
  userNote.value = userNoteDraft.value.trim()
  showUserNote.value = false
  userNoteDraft.value = ''
  if (userNote.value) toast('补充说明已记录，将在下一轮反馈带上', 'success', 3000)
}

const decisionCustomOpen = ref(false)
const decisionCustomText = ref('')
function submitDecisionCustom() {
  const t = decisionCustomText.value.trim()
  if (!t) return
  void submitDecision('__custom__', t)
  decisionCustomOpen.value = false
  decisionCustomText.value = ''
}

function pauseAll() {
  cancelAutoRun()
  disableAutoTakeover()
  stop()
  if (isLoopActive.value) {
    void killCurrent()
  }
}

const waitingPct = computed(() => {
  if (loopState.value !== 'waiting' || !roundTimeoutMs.value) return 0
  return Math.min(100, Math.round((waitingElapsed.value * 1000 / roundTimeoutMs.value) * 100))
})

const stageLabel = computed(() => {
  const s = stage.value
  if (s === 'plan') return '规划'
  if (s === 'verify') return '验证'
  return '实现'
})
const stageClass = computed(() => 'stage-' + (stage.value || 'plan'))
const stateIcon = computed(() => {
  const s = loopState.value
  if (s === 'waiting') return '⏱'
  if (s === 'executing') return '⚙'
  if (s === 'feedback') return '📤'
  if (s === 'parsing') return '🧩'
  if (s === 'handoff') return '🔄'
  if (s === 'budget-limited') return '💰'
  if (s === 'waiting-input') return '⏸'
  return '⟳'
})
const roundPct = computed(() => {
  const max = maxRounds.value || 8
  return Math.min(100, Math.round((loopRound.value / max) * 100))
})

const mainRef = ref<HTMLElement | null>(null)

const copied = ref(false)
const fileDragging = ref(false)
const fileSuccess = ref(false)
const statusText = ref('')
const statusClass = ref('')

const { waiting: aiWaiting, startWaiting: startAiWaiting } = useAiWaiting()

// [loop-loading] 循环态统一触发等待 loading，确保从发问起有「等待 AI」提示
watch(loopState, (v, old) => {
  if ((v === 'waiting' || v === 'preparing') && v !== old) {
    startAiWaiting()
  }
})

// 分栏比例（终端占比）

// 右侧面板宽度
const SIDE_WIDTH_KEY = '__ai_runner_side_width'
const SIDE_WIDTH_DEFAULT = 320
const SIDE_WIDTH_DIFF = 560
const paneRef = ref<HTMLElement | null>(null)
const sideWidth = ref(SIDE_WIDTH_DEFAULT)
const sideWidthBase = ref(SIDE_WIDTH_DEFAULT)
const resizingSide = ref(false)

// 上次运行时长
const lastDuration = ref('')
const runningElapsed = ref('')
const runningCommand = ref('')
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let runStartAt = 0

// Diff 预览
const sideTab = ref<'tree' | 'changes'>('tree')
// U.12: 窄屏抽屉开合
const sideDrawerOpen = ref(false)
const previewFile = ref<string | null>(null)
const previewBefore = ref<string | null>(null)
const previewAfter = ref<string>('')

const hasStdout = computed(() => !!result.value?.stdout?.trim())
const hasStderr = computed(() => !!result.value?.stderr?.trim())
const { events: busEvents } = useEventBus()
const termBodyRef = ref<HTMLElement | null>(null)

type ChatRole = 'user' | 'ai' | 'sys' | 'step'
function chatRole(kind: string): ChatRole {
  if (kind === 'ai:ask') return 'user'
  if (kind === 'ai:script' || kind === 'run:start' || kind === 'run:end' || kind === 'run:error' || kind === 'run:stage') return 'step'
  if (kind === 'ai:done' || kind === 'ai:plain' || kind === 'ai:multi' || kind === 'ai:summary' || kind === 'ai:feedback' || kind === 'ai:decision' || kind === 'ai:need-files') return 'ai'
  return 'sys'
}
const chatItems = computed(() => busEvents.value
  .filter((e) => e.kind !== 'ai:token')
  .map((e) => ({ ...e, role: chatRole(e.kind) }))
  .filter((e) => {
    // 过滤无内容的 AI 气泡：脚本到达已由步骤条显示，纯文本空回复不显示
    if (e.role !== 'ai') return true
    const p = (e.payload || {}) as Record<string, unknown>
    if (String(p.text || '').trim()) return true
    if (String(p.desc || '').trim()) return true
    return false
  }))

const treeExpanded = ref<Set<number>>(new Set())
function toggleTreeNode(id: number) {
  const s = new Set(treeExpanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  treeExpanded.value = s
}
function treeIcon(kind: string): string {
  if (kind === 'ai:ask') return '👤'
  if (kind === 'ai:feedback') return '📤'
  if (kind === 'ai:script') return '📥'
  if (kind === 'ai:done') return '✓'
  if (kind === 'ai:plain' || kind === 'ai:multi') return '💬'
  if (kind === 'ai:stream') return '🤖'
  if (kind === 'ai:summary') return '📋'
  if (kind === 'ai:token') return '🔢'
  if (kind === 'ai:decision') return '⏸'
  if (kind === 'ai:need-files') return '📂'
  if (kind === 'run:start') return '▶'
  if (kind === 'run:end') return '■'
  if (kind === 'run:error') return '✗'
  if (kind === 'run:stage') return '⚙'
  if (kind === 'loop:round') return '⟳'
  if (kind === 'loop:static') return '⚠'
  if (kind === 'loop:finish') return '⏹'
  return '·'
}
function stepStateOf(e: { kind: string, payload?: Record<string, unknown> }): 'pending' | 'running' | 'done' | 'error' {
  if (e.kind === 'run:start') {
    const phase = String((e.payload && (e.payload as Record<string, unknown>).phase) || '')
    if (phase === 'done') return 'done'
    if (phase === 'error') return 'error'
    return 'running'
  }
  if (e.kind === 'run:error') return 'error'
  if (e.kind === 'run:end') return e.payload && e.payload.ok === false ? 'error' : 'done'
  if (e.kind === 'run:stage') {
    const phase = String((e.payload && (e.payload as Record<string, unknown>).phase) || '')
    if (phase === 'done') return 'done'
    if (phase === 'error') return 'error'
    return 'running'
  }
  return 'pending'
}
function stepIconOf(e: { kind: string, payload?: Record<string, unknown> }): string {
  if (e.kind === 'ai:script') return '📥'
  if (e.kind === 'run:start') {
    const phase = String((e.payload && (e.payload as Record<string, unknown>).phase) || '')
    if (phase === 'done') return '■'
    if (phase === 'error') return '✗'
    return '▶'
  }
  if (e.kind === 'run:end') return '■'
  if (e.kind === 'run:error') return '✗'
  if (e.kind === 'run:stage') return '⚙'
  return '·'
}
function stepTitleOf(e: { kind: string, summary?: string, payload?: Record<string, unknown> }): string {
  const p = e.payload || {}
  if (e.kind === 'ai:script') return String(p.desc || '脚本到达')
  if (e.kind === 'run:start') {
    const desc = String(p.desc || '').trim() || '脚本'
    const why = String(p.why || '').trim()
    const plan = String(p.plan || '').trim()
    const lines: string[] = []
    if (desc) lines.push('**' + desc + '**')
    if (why) lines.push('为什么：' + why)
    if (plan) lines.push('计划：' + plan)
    return lines.join('\n')
  }
  if (e.kind === 'run:end') {
    const exit = p.exit !== undefined ? ' · exit ' + p.exit : ''
    const changes = Array.isArray(p.changes) ? p.changes.length : 0
    const desc = String(p.desc || '').trim()
    const head = desc ? '执行脚本：' + desc : '执行完成'
    return head + exit + (changes ? ' · ' + changes + ' 文件' : '')
  }
  if (e.kind === 'run:error') return String(e.summary || '执行失败')
  if (e.kind === 'run:stage') {
    const p = e.payload || {}
    const name = String(p.name || 'stage')
    const ms = typeof p.ms === 'number' ? ' · ' + p.ms + 'ms' : ''
    const files = typeof p.files === 'number' && p.files > 0 ? ' · ' + p.files + ' 文件' : ''
    const extra: string[] = []
    if (p.tscOk === false) extra.push('tsc 失败')
    if (p.testOk === false) extra.push('test 失败')
    return name + files + ms + (extra.length ? ' · ' + extra.join(' / ') : '')
  }
  return String(e.summary || '')
}
function stepLabelOf(e: { kind: string, payload?: Record<string, unknown> }): string {
  if (e.kind === 'ai:script') return '待执行'
  if (e.kind === 'run:start') {
    const phase = String((e.payload && (e.payload as Record<string, unknown>).phase) || '')
    if (phase === 'pending') return '等待中'
    if (phase === 'done') return '已完成'
    if (phase === 'error') return '失败'
    return '执行中'
  }
  if (e.kind === 'run:end') return e.payload && e.payload.ok === false ? '失败' : '已完成'
  if (e.kind === 'run:error') return '失败'
  if (e.kind === 'run:stage') {
    const phase = String((e.payload && (e.payload as Record<string, unknown>).phase) || '')
    if (phase === 'done') return '完成'
    if (phase === 'error') return '失败'
    return '处理中'
  }
  return ''
}

function fmtTreeTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function escapeHtmlMd(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] as string))
}

/** 极简 markdown：代码块（折叠）/ 标题 / 列表 / 行内 code / 粗体 / 段落 */
/** 用 highlight.js 着色；语言不可用则回退 auto，再失败转纯 escape */
function highlightCode(code: string, lang: string): string {
  const source = String(code ?? '')
  const l = String(lang || '').toLowerCase()
  try {
    if (l && hljs.getLanguage(l)) return hljs.highlight(source, { language: l, ignoreIllegals: true }).value
    return hljs.highlightAuto(source).value
  } catch {
    return escapeHtmlMd(source)
  }
}

function renderMarkdown(text: string): string {
  const s = String(text ?? '')
  if (!s) return ''
  const lines = s.split('\n')
  const out: string[] = []
  const inline = (t: string): string => escapeHtmlMd(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    const fence = l.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      const lang = fence[1] || 'code'
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      const codeId = 'c' + Math.random().toString(36).slice(2, 8)
      const body = highlightCode(buf.join('\n'), lang)
      const bar = '<div class="md-code-bar"><span class="md-code-lang">' + escapeHtmlMd(lang) + ' · ' + buf.length + ' 行</span><span class="md-code-acts"><button class="md-code-copy" data-code-id="' + codeId + '" onclick="(function(b){var p=b.closest(\'.md-code\').querySelector(\'pre\');navigator.clipboard.writeText(p.textContent||\'\');b.textContent=\'已复制\';setTimeout(function(){b.textContent=\'复制\'},1200)})(this)">复制</button><button class="md-code-dl" data-code-id="' + codeId + '" onclick="(function(b){var p=b.closest(\'.md-code\').querySelector(\'pre\');var a=document.createElement(\'a\');a.href=URL.createObjectURL(new Blob([p.textContent||\'\'],{type:\'text/plain\'}));a.download=\'snippet.txt\';a.click();URL.revokeObjectURL(a.href)})(this)">下载</button></span></div>'
      out.push('<details class="md-code" open><summary>' + bar + '</summary><pre>' + body + '</pre></details>')
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      const n = h[1].length + 2
      out.push('<h' + n + ' class="md-h">' + escapeHtmlMd(h[2]) + '</h' + n + '>')
      i++
      continue
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>')
        i++
      }
      out.push('<ul class="md-ul">' + items.join('') + '</ul>')
      continue
    }
    if (/^\s*$/.test(l)) { i++; continue }
    out.push('<p class="md-p">' + inline(l) + '</p>')
    i++
  }
  return out.join('')
}

function renderUserBubble(e: { kind: string, payload?: Record<string, unknown> }): string {
  if (!e.payload) return ''
  if (e.kind === 'ai:ask' && e.payload.question) return renderMarkdown(String(e.payload.question))
  if (e.kind === 'ai:feedback') {
    const cnt = Array.isArray(e.payload.changes) ? e.payload.changes.length : 0
    const exit = e.payload.exit ?? '?'
    return renderMarkdown(`回传 AI · exit ${exit} · ${cnt} 文件`)
  }
  return ''
}

function renderAiBubble(e: { kind: string, payload?: Record<string, unknown>, summary?: string }): string {
  if (!e.payload) return ''
  if (e.kind === 'ai:script') {
    const desc = String(e.payload.desc || '').trim()
    const why = String(e.payload.why || '').trim()
    const plan = String(e.payload.plan || '').trim()
    const parts: string[] = []
    if (desc) parts.push('**' + desc + '**')
    if (why) parts.push('为什么：' + why)
    if (plan) parts.push('计划：' + plan)
    return parts.length ? renderMarkdown(parts.join('\n\n')) : ''
  }
  if (e.kind === 'ai:done' || e.kind === 'ai:plain' || e.kind === 'ai:multi') {
    const text = e.payload.text !== undefined ? String(e.payload.text).trim() : ''
    return text ? renderMarkdown(text) : ''
  }
  return ''
}

function renderPayload(p: unknown): string {
  if (!p || typeof p !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (v === null || v === undefined || v === '') continue
    if (typeof v === 'string') {
      parts.push('### ' + k + '\n\n' + v)
    } else if (Array.isArray(v)) {
      const ls = v.map((x) => typeof x === 'object' ? '- ' + JSON.stringify(x) : '- ' + String(x)).join('\n')
      parts.push('### ' + k + '\n\n' + ls)
    } else if (typeof v === 'object') {
      parts.push('### ' + k + '\n\n```json\n' + JSON.stringify(v, null, 2) + '\n```')
    } else {
      parts.push('### ' + k + '\n\n' + String(v))
    }
  }
  return renderMarkdown(parts.join('\n\n'))
}
/** 最新的 AI 流式文本（取最后一条 ai:stream 事件） */

const hasAnyOutput = computed(() => hasStdout.value || hasStderr.value || (result.value?.tools?.length || 0) > 0 || !!result.value?.smoke?.ran || !!result.value?.tsc)
function getChangeType(p: string) {
  const c = changes.value.find(x => x.path === p)
  return c ? c.type : 'modified'
}

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
  } catch (e) { console.error('Diff load failed', e); previewBefore.value = '' }
}

async function onRollback(file: string) {
  const data = await rollback(file)
  if (data && !data.ok) toast(`撤回失败：${data.error || '未知'}`, 'error')
  if (previewFile.value === file) previewFile.value = null
}

async function onRollbackAll() {
  await rollbackAll()
  previewFile.value = null
}

function shouldIncludeChanges(
  changes: Change[],
  errorLocs: Map<string, Set<number>>,
): boolean {
  if (!changes.length) return true
  if (changes.length > 1) return true
  const c = changes[0]
  const locs = errorLocs.get(c.path) || errorLocs.get(`./${c.path}`)
  if (locs && locs.size > 0) {
    const total = c.afterLines ?? 0
    for (const n of locs) {
      if (n <= total + 200) return false
    }
  }
  return true
}
function isReadonlyResult(r: RunResponse | null): boolean {
  if (!r || !r.ok) return false
  if (r.runId === '') return false
  if ((r.changes || []).length > 0) return false
  if (isLoopActive.value) return false
  return true
}

async function buildAiPrompt() {
  if (!result.value) return ''
  const errorLocs = parseErrorLocations(`${result.value.stderr || ''}\n${result.value.stdout || ''}`)
  const p: string[] = []
  p.push('# 脚本执行结果')
  p.push(`状态: ${result.value.ok ? '✅ 成功' : '❌ 失败'}`)
  p.push(`退出码: ${result.value.code}`)
  p.push(`变更数: ${changes.value.length}`)
  p.push('')

  if (!result.value.ok) {
    // 变更文件 + 报错涉及的文件，去重后取前 5 个
    const changedPaths = changes.value.filter(c => c.type !== 'deleted').map(c => c.path)
    const errorPaths = result.value.errorFiles ?? []
    const mergedPaths = [...new Set([...errorPaths, ...changedPaths])].slice(0, 5)
    if (mergedPaths.length > 0) {
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
  }

  if (changes.value.length) {
    p.push('# 变更')
    p.push('```')
    changes.value.forEach(c => p.push(`${c.type} ${c.path}`))
    p.push('```')
    p.push('')
  }
  if (result.value.dryRunFailed) {
    p.push('# ⚠ 预检失败：脚本未通过校验，磁盘零改动', '')
    p.push(`- 脚本本想改动 ${result.value.dryRunChangeCount ?? 0} 个文件，但执行中途失败，磁盘上没有任何变化`)
    p.push(`- 原因：${result.value.dryRunReason || '脚本运行时错误（非类型错误）'}`)
    if (result.value.wantChanges?.length) {
      p.push('- 脚本声称/尝试的改动：')
      for (const c of result.value.wantChanges.slice(0, 20)) p.push(`  - [${c.type}] ${c.path}`)
      if (result.value.wantChanges.length > 20) p.push(`  - ... 共 ${result.value.wantChanges.length} 个`)
    }
    p.push('- 请基于下方 stderr 定位根因，重新生成完整脚本；不要再给出会中途抛错的版本')
    p.push('')
  }
  if (result.value.tools && result.value.tools.length) {
    p.push('# 工具调用序列')
    p.push('```')
    for (const t of result.value.tools) {
      const label = t.op === 'write' ? 'writeFile' : 'deleteFile'
      p.push(`${label} ${t.path} (${t.size}B)`)
    }
    p.push('```')
    p.push('')
  }
  if (result.value.smoke?.ran) {
    p.push('# 页面冒烟')
    if (result.value.smoke.error) {
      p.push(`启动失败: ${result.value.smoke.error}`)
    } else {
      for (const pg of result.value.smoke.pages) {
        p.push(`${pg.ok ? '✓' : '✗'} ${pg.url}`)
        for (const e of pg.errors) p.push(`  ${e}`)
      }
    }
    p.push('')
  }
  if (result.value.tsc) {
    p.push('# 类型检查 (tsc)')
    p.push(result.value.tsc.ok ? '✓ 通过' : '✗ 存在类型错误')
    p.push('```')
    p.push((result.value.tsc.stdout || '') + (result.value.tsc.stderr ? `\n${result.value.tsc.stderr}` : ''))
    p.push('```')
    p.push('')
  }
  if (result.value.lint?.ran && !result.value.lint.ok) {
    p.push('# 代码格式化 (eslint)')
    p.push('✗ 存在 lint 错误')
    p.push('```')
    p.push((result.value.lint.stdout || '') + (result.value.lint.stderr ? `\n${result.value.lint.stderr}` : ''))
    p.push('```')
    p.push('')
  }
  if (result.value.test?.ran && !result.value.test.ok) {
    p.push('# 单元测试')
    p.push('✗ 存在测试失败')
    p.push('```')
    p.push((result.value.test.stdout || '') + (result.value.test.stderr ? `\n${result.value.test.stderr}` : ''))
    p.push('```')
    p.push('')
  }
  const baseline = result.value.baselineRunId
  if (baseline && baseline !== result.value.runId) {
    try {
      const r = await fetch('/__ai/diff-from-baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baselineRunId: baseline }),
      })
      const data = await r.json()
      const acc = data.changes || []
      if (acc.length && shouldIncludeChanges(acc, errorLocs)) {
        p.push(`# 跨轮累积变更（基准 ${baseline}）`)
        p.push('```')
        for (const c of acc) p.push(`${c.type} ${c.path}`)
        p.push('```')
        p.push('')
      }
    } catch { }
  }
  if (result.value.claimMismatch) {
    const cm = result.value.claimMismatch
    if (cm.missing.length || cm.extra.length || !cm.actual.length) {
      p.push('# 脚本声明的改动 vs 实际改动')
      p.push(`声明：${cm.claimed.join(', ') || '（无）'}`)
      p.push(`实际：${cm.actual.join(', ') || '（无）'}`)
      const instruction = !result.value.ok
        ? '结合上方源码和错误信息诊断根因，给出最小修复方案，生成脚本。不要回退无关代码。'
        : isReadonlyResult(result.value)
          ? '这是只读诊断脚本的输出。基于上方 stdout 分析现状，给出下一步建议或修改脚本。'
          : '确认改动。'
      p.push('# 指令', instruction)
      if (cm.extra.length) p.push(`⚠ 未声明但改动：${cm.extra.join(', ')}`)
      if (!cm.actual.length) p.push('⚠ 脚本未产生任何文件改动')
      p.push('')
    }
  }
  if (result.value.stderr) { p.push('# 错误输出 (stderr)', '```', result.value.stderr.slice(-3000), '```', '') }
  if (result.value.stdout) { p.push('# Stdout', '```', result.value.stdout.slice(-3000), '```', '') }
  p.push('# 指令', result.value.ok ? '确认改动。' : '结合上方源码和错误信息诊断根因，给出最小修复方案，生成脚本。不要回退无关代码。')
  let text = p.join('\n')
  const budget = enforceBudget(text)
  if (!budget.ok) {
    // smart-trim：对相关文件源码块做二次裁剪（只对失败时附加的源码块生效）
    const marker = '# 相关文件源码'
    const idx = text.indexOf(marker)
    if (idx >= 0) {
      const head = text.slice(0, idx)
      const tail = text.slice(idx)
      // 粗暴按行裁剪 tail：保留前 200 行
      const tailLines = tail.split('\n')
      const keep = tailLines.slice(0, 200).join('\n')
      const keepRest = tailLines.slice(200)
      text = `${head + keep}\n// …（prompt 超预算，已省略 ${keepRest.length} 行源码）\n`
      const after = enforceBudget(text)
      if (after.ok) {
        toast(`prompt 超预算，已裁剪源码块到 ${after.size} 字节`, 'warn', 4000)
      } else {
        toast(`prompt 仍超预算（${after.size} 字节），请减少附加文件`, 'error', 5000)
      }
    } else {
      toast(`prompt 超预算：${budget.size} / ${budget.budget} 字节`, 'warn', 4000)
    }
  }
  return text
}

// URL 长度安全上限。超过就打开首页，靠剪贴板兜底。
/* __ai_removed: DEEPSEEK_URL_MAX */
// URL 从全局 composable 读，在 App.vue 的 header 里配置
/* __ai_removed: deepseekUrl ref */
const { stripComments, stripBlankLines } = useCodeCleaner()
const { toast, confirmDialog } = useToast()
const { addTrace } = useTraceLog()

const TEMPLATES = [
  {
    id: 'cjs',
    label: 'cjs',
    title: 'CommonJS 脚本（#!/usr/bin/env node）',
    code: '#!/usr/bin/env node\n',
  },
  {
    id: 'bash',
    label: 'bash',
    title: 'Bash 脚本（#!/usr/bin/env bash）',
    code: '#!/usr/bin/env bash\n',
  },
  {
    id: 'ask',
    label: '问',
    title: '提问题给 AI（@ 开头）',
    code: [
      '@【问题】',
      '',
      '【背景】',
      '',
      '【期望】',
      '',
      '【相关文件】',
    ].join('\n'),
  },
]

function applyTemplate(code: string) {
  script.value = code
}

const CMD_HISTORY_KEY = '__ai_cmd_history'
function loadCmdHistory(): string[] {
  try {
    const raw = localStorage.getItem(CMD_HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
const cmdHistory = ref<string[]>(loadCmdHistory())
let cmdHistoryIndex = -1
let cmdHistoryDraft = ''
function pushCmdHistory(cmd: string) {
  const arr = cmdHistory.value.filter(c => c !== cmd)
  arr.unshift(cmd)
  cmdHistory.value = arr.slice(0, 100)
  try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(cmdHistory.value)) } catch { }
  cmdHistoryIndex = -1
  cmdHistoryDraft = ''
}
function cmdHistoryPrev() {
  if (!cmdHistory.value.length) return
  if (cmdHistoryIndex === -1) cmdHistoryDraft = script.value
  cmdHistoryIndex = Math.min(cmdHistoryIndex + 1, cmdHistory.value.length - 1)
  script.value = cmdHistory.value[cmdHistoryIndex]
}
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

function onGlobalKey(e: KeyboardEvent) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault()
    runSmart()
  }
}
function runSmart(opts?: { bypassAutoGuard?: boolean }) {
  if (autoTakeoverEnabled.value && !opts?.bypassAutoGuard) {
    toast('自动接管中，请先关闭接管再手动运行', 'warn', 2500)
    return
  }
  const text = script.value.trim()
  if (!text) return
  const firstLine = text.split('\n', 1)[0].trim()
  const isNode = /^#!\s*\/usr\/bin\/(env\s+)?node\b/.test(firstLine)
  const isBash = /^#!\s*\/usr\/bin\/(env\s+)?bash\b/.test(firstLine)
  if (isNode) {
    runningCommand.value = ''
    run()
    return
  }
  if (isBash) {
    runningCommand.value = ''
    run()
    return
  }
  if (text.startsWith('!')) {
    execCmd(text)
    return
  }
  // 无 shebang：默认问 AI
  void askAi(text)
}

async function loadSkillsForAsk(): Promise<string> {
  let selected: string[] = ['gen-script-rules']
  try {
    const raw = localStorage.getItem('__ai_selected_skills')
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) selected = arr
    }
  } catch { }
  if (!selected.length) return ''
  try {
    const res = await fetch('/__ai/skills')
    const all = await res.json()
    if (!Array.isArray(all)) return ''
    const picked = all.filter((s: any) => selected.includes(s.name))
    if (!picked.length) return ''
    return picked.map((s: any) => s.content).join('\n\n---\n\n')
  } catch {
    return ''
  }
}
async function askAi(question: string) {
  if (!question) { toast('@ 后没有内容', 'warn'); return }
  const skills = await loadSkillsForAsk()
  const prompt = skills
    ? `# 规则\n\n${skills}\n\n# 问题\n
${question}`
    : question
  const r = await copyAndFill(prompt)
  if (r === 'failed') {
    toast('发送失败，已复制到剪贴板', 'warn', 4000)
    return
  }
  emit('ai:ask', `👤 提问：${question.slice(0, 80)}`, { payload: { question, prompt } })
  statusText.value = '✅ 已发送'
  statusClass.value = 'ok'
  script.value = ''
  startAiWaiting()
  setTimeout(() => { statusText.value = ''; statusClass.value = '' }, 1500)
}
let execPolicyOverride: string | null = null
async function execCmdInternal(cmd: string, policy: string, cmdText: string): Promise<void> {
  execPolicyOverride = policy
  try {
    await execCmd(cmdText)
  } finally {
    execPolicyOverride = null
  }
}
async function execCmd(text: string) {
  const raw = text.trim()
  if (!raw || running.value) return
  if (!raw.startsWith('!')) return
  script.value = ''
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
      body: JSON.stringify({ cmd, bashPolicy: execPolicyOverride || (() => { try { return localStorage.getItem('__ai_bash_policy') || 'on-request' } catch { return 'on-request' } })() }),
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
let lastAutoAskedRunId = ''
async function copyOutput() {
  if (!result.value) return
  try {
    const runKey = result.value.runId || `${result.value.code}|${(result.value.stderr || '').slice(0, 64)}`
    if (lastAutoAskedRunId === runKey) return
    lastAutoAskedRunId = runKey
    const text = await buildAiPrompt()
    if (!text) return
    const r = await copyAndFill(text)
    if (r === 'failed') {
      toast('发送失败，已复制到剪贴板', 'warn', 4000)
      return
    }
    emit('ai:feedback', `📤 回传 AI：${changes.value.length} 文件 · exit ${result.value?.code ?? -1}`, { payload: { prompt: text.slice(0, 8000), changes: changes.value.map(c => ({ path: c.path, type: c.type })), exit: result.value?.code ?? -1, ok: result.value?.ok ?? false } })
    copied.value = true
    startAiWaiting()
    setTimeout(() => { copied.value = false }, 2000)
  } catch (e) { console.error(e) }
}

// stderr 里把 file.ts:12:34 变成可点击（点击复制路径）
// ponytail: 不做跨文件跳转（无 Monaco，行号可能失准），只复制路径。





// ---------- 分栏拖拽 ----------

// ---------- 右侧面板宽度拖拽 ----------
const cmHost = ref<HTMLDivElement | null>(null)
let cmView: any = null
let editableComp: any = null

/* @FILE_PICKER_V1 */
const pickerOpen = ref(false)
const pickerQuery = ref('')
const pickerIndex = ref(0)
const pickerPos = ref(0)
const pickerAnchor = ref(0)
const pickerX = ref(0)
const pickerY = ref(0)
const pickerRef = ref<HTMLDivElement | null>(null)
const pickerInputRef = ref<HTMLInputElement | null>(null)
const pickerFiles = ref<string[]>([])
const pickerStyle = computed(() => ({ left: pickerX.value + 'px', top: pickerY.value + 'px' }))

async function pickerLoadFiles() {
  if (pickerFiles.value.length) return
  try {
    const res = await fetch('/__ai/files?depth=6')
    const data = await res.json()
    const flat: string[] = []
    const walk = (nodes: any[]) => {
      for (const n of nodes || []) {
        if (n.type === 'file') flat.push(n.path)
        else if (n.children) walk(n.children)
      }
    }
    walk(data.tree || [])
    pickerFiles.value = flat
  } catch { pickerFiles.value = [] }
}

const pickerFiltered = computed(() => {
  const q = pickerQuery.value.toLowerCase()
  const all = pickerFiles.value
  if (!q) return all.slice(0, 200)
  return all.filter(p => p.toLowerCase().includes(q)).slice(0, 200)
})

function pickerOpenAt(atPos: number) {
  pickerOpen.value = true
  pickerQuery.value = ''
  pickerIndex.value = 0
  pickerPos.value = atPos
  pickerAnchor.value = atPos + 1
  if (cmView) {
    const coords = cmView.coordsAtPos(atPos)
    if (coords) {
      pickerX.value = coords.left
      pickerY.value = coords.bottom + 4
    }
  }
  void pickerLoadFiles()
  nextTick(() => pickerInputRef.value?.focus())
}

function pickerClose() {
  pickerOpen.value = false
  pickerQuery.value = ''
  pickerIndex.value = 0
}

function pickerMove(d: number) {
  const n = pickerFiltered.value.length
  if (!n) return
  pickerIndex.value = (pickerIndex.value + d + n) % n
}

function pickerConfirm() {
  const f = pickerFiltered.value[pickerIndex.value]
  if (f) pickerPick(f)
}

function pickerPick(filePath: string) {
  if (!cmView) return
  pickerOpen.value = false
  const insertText = '@' + filePath + ' '
  const from = pickerPos.value
  const to = cmView.state.selection.main.head
  cmView.dispatch({ changes: { from, to, insert: insertText }, selection: { anchor: from + insertText.length } })
  pickerQuery.value = ''
  pickerIndex.value = 0
  cmView.focus()
}

function onEditorUpdate(u: any) {
  if (!u.docChanged) return
  const pos = u.state.selection.main.head
  if (pos < 1) return
  const ch = u.state.sliceDoc(pos - 1, pos)
  if (ch === '@') {
    pickerOpenAt(pos - 1)
    return
  }
  if (pickerOpen.value) {
    if (pos <= pickerPos.value) { pickerClose(); return }
    const q = u.state.sliceDoc(pickerAnchor.value, pos)
    if (/^[\w./-]*$/.test(q)) pickerQuery.value = q
    else pickerClose()
  }
}

let fileTagPlugin: any = null
async function createEditor() {
  if (!cmHost.value || cmView) return
  const m = await ensureCM()
  if (!editableComp) editableComp = new m.Compartment()
  if (!fileTagPlugin) {
    fileTagPlugin = m.ViewPlugin.fromClass(class {
      decorations: any
      constructor(view: any) { this.decorations = this.build(view) }
      update(u: any) { if (u.docChanged) this.decorations = this.build(u.view) }
      build(view: any) {
        const builder = new m.RangeSetBuilder()
        const text = view.state.doc.toString()
        const re = /@[\w./-]+/g
        let match: RegExpExecArray | null
        while ((match = re.exec(text)) !== null) {
          const from = match.index
          const to = match.index + match[0].length
          const after = text[to]
          if (after === undefined || after === ' ' || after === '\n' || after === '\t') {
            builder.add(from, to, m.Decoration.mark({ class: 'cm-file-tag' }))
          }
        }
        return builder.finish()
      }
    }, { decorations: (v: any) => v.decorations })
  }
  const state = m.EditorState.create({
    doc: script.value,
    extensions: [
      m.basicSetup,
      m.cmJavascript(),
      m.oneDark,
      /* editor-no-h-scroll */
      m.EditorView.lineWrapping,
      editableComp.of(m.EditorView.editable.of(!isLoopActive.value)),
      m.placeholder('写脚本，或 !命令 走 shell · @问题 发给 AI · ⌘/Ctrl + ↵ 运行'),
      m.EditorView.theme({
        '&': { height: '100%', fontSize: '12px' },
        '.cm-scroller': { fontFamily: 'var(--mono, monospace)', lineHeight: '20px', overflowX: 'hidden', overflowY: 'auto' },
        '.cm-content': { caretColor: '#528bff' },
        '&.cm-focused': { outline: 'none' },
      }),
      m.Prec.highest(m.keymap.of([
        { key: 'Mod-Enter', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Alt-r', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Alt-ArrowUp', preventDefault: true, run: () => { cmdHistoryPrev(); return true } },
        { key: 'Alt-ArrowDown', preventDefault: true, run: () => { cmdHistoryNext(); return true } },

        { key: 'Enter', run: () => {
          const text = script.value.trim()
          if (text.startsWith('!') && !text.includes('\n')) {
            runSmart()
            return true
          }
          return false
        } },
      ])),
      m.EditorView.updateListener.of((u: any) => {
        if (u.docChanged) {
          script.value = u.state.doc.toString()
          onEditorUpdate(u)
        }
      }),
      fileTagPlugin,
    ],
  })
  cmView = new m.EditorView({ state, parent: cmHost.value })
}
watch(isLoopActive, (v) => {
  if (!cmView || !CM || !editableComp) return
  cmView.dispatch({ effects: editableComp.reconfigure(CM.EditorView.editable.of(!v)) })
})
watch(script, (v) => {
  if (!cmView) return
  const cur = cmView.state.doc.toString()
  if (cur === v) return
  cmView.dispatch({ changes: { from: 0, to: cur.length, insert: v } })
})
function onSideDown(e: PointerEvent) {
  resizingSide.value = true
  window.addEventListener('pointermove', onSideMove)
  window.addEventListener('pointerup', onSideUp)
  e.preventDefault()
}
function onSideMove(e: PointerEvent) {
  if (!paneRef.value) return
  const rect = paneRef.value.getBoundingClientRect()
  // handle 宽 14px，取中心作为分界
  const w = rect.right - e.clientX - 7
  sideWidth.value = Math.max(280, Math.min(rect.width * 0.6, w))
}
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

watch(previewFile, (v) => {
  if (resizingSide.value) return
  sideWidth.value = v
    ? Math.max(sideWidthBase.value, SIDE_WIDTH_DIFF)
    : sideWidthBase.value
})

function scrollTermToBottom() {
  nextTick(() => {
    const el = termBodyRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
  })
}
// watch 监听数组引用，覆盖 updateKey 覆盖更新（如 ai:stream 长度不变也能触发）
watch(busEvents, scrollTermToBottom)

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

  void createEditor()
  scrollTermToBottom()
  window.addEventListener('ai-runner:auto-run', onAutoRun)
  window.addEventListener('keydown', onGlobalKey) })

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onSideMove)
  window.removeEventListener('pointerup', onSideUp)
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }

  window.removeEventListener('ai-runner:auto-run', onAutoRun)
  window.removeEventListener('keydown', onGlobalKey)
  cmView?.destroy()
  cmView = null })

// ---------- 运行时长 ----------
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
      if (autoTakeoverEnabled.value) scheduleAutoRun(() => { void copyOutput() })
      else setTimeout(() => { void copyOutput() }, 3000)
    } else {
      statusText.value = result.value.ok ? '✅ 成功' : '❌ 失败'
      statusClass.value = result.value.ok ? 'ok' : 'err'
      // autoAskOnResult: 失败或只读诊断（成功无改动、非循环）时延迟 3s 自动复制并发给 AI（主动停止除外）
      const isReadonlyProbe = isReadonlyResult(result.value)
      const AUTO_ASK_DELAY_MS = 3000
      const forceFeedback = autoFeedbackRequested.value
      const shouldAutoAsk =
        forceFeedback ||
        autoTakeoverEnabled.value ||
        !result.value.ok ||
        isReadonlyProbe ||
        result.value.tsc?.ok === false ||
        result.value.lint?.ok === false ||
        result.value.test?.ok === false
      if (shouldAutoAsk && result.value.error !== '已取消') {
        if (forceFeedback) clearAutoFeedback()
        if (autoTakeoverEnabled.value) scheduleAutoRun(() => { void copyOutput() })
        else setTimeout(() => { void copyOutput() }, AUTO_ASK_DELAY_MS)
      }
      // U.8: 运行后保留编辑器内容（便于重跑 / 微调）
      const scriptSnapshot = script.value
      // 把跑过的脚本记为「已消费」，让后续 AI 回填能直接覆盖（不误伤手动编辑）
      setLastAutoFilled(scriptSnapshot)
      const r = result.value
      // 兼容旧脚本只写 // @desc；新脚本可能 // 或 #，从 result.value.scriptDesc/scriptWhy 拿（server 已解析）
      const descMatch = scriptSnapshot.match(/^\s*(?:\/\/|#)\s*@desc\s*:\s*(.+)$/m)
      const desc = r.scriptDesc || (descMatch ? descMatch[1].trim() : '')
      const whyMatch = scriptSnapshot.match(/^\s*(?:\/\/|#)\s*@why\s*:\s*(.+)$/m)
      const why = r.scriptWhy || (whyMatch ? whyMatch[1].trim() : '')
      const lang: 'js' | 'bash' = /^\s*#\s*(@desc|@why)/m.test(scriptSnapshot) ? 'bash' : 'js'
      // 计算 hash（与油猴脚本一致：FNV-1a 8 hex）
      const hash = fnv1a8(scriptSnapshot)
      addTrace({
        kind: 'run',
        summary: desc
          ? `${desc} · ${r.ok ? '成功' : '失败'} exit ${r.code} · ${changes.value.length} 文件变更`
          : `运行脚本 · ${r.ok ? '成功' : '失败'} exit ${r.code} · ${changes.value.length} 文件变更`,
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

// ---------- 文件拖入 ----------
function onHtmlDragOver(e: DragEvent) {
  e.preventDefault()
  fileDragging.value = true
}
function onHtmlDrop(e: DragEvent) {
  e.preventDefault()
  fileDragging.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  const text = files.map(f => `// 📄 ${(f as any).path || f.name}`).join('\n')
  const view = cmView
  if (view) {
    const pos = view.state.selection.main.head
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    })
    view.focus()
  } else {
    script.value += text
  }
  fileSuccess.value = true
  setTimeout(() => { fileSuccess.value = false }, 1500)
}
</script>

<style scoped lang="scss">
/* ============ Layout ============ */
.pane {
  display: flex;
  gap: 0;
  height: 100%;
  overflow: hidden;
}

/* 拖拽条：调整右侧面板宽度 */
.side-resize-handle {
  flex-shrink: 0;
  width: 14px;
  cursor: col-resize;
  position: relative;
  z-index: 1;
}
/* U.12: 窄屏抽屉 toggle 与 backdrop（桌面不显示） */
.side-drawer-toggle {
  display: none;
  position: fixed;
  right: 8px;
  top: 50%;
  z-index: 40;
  width: 28px;
  height: 44px;
  transform: translateY(-50%);
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-2);
  border-radius: 6px 0 0 6px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.side-drawer-toggle.drawer-open {
  right: 320px;
  border-radius: 0 6px 6px 0;
}
.side-drawer-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 30;
  background: rgb(15 30 60 / 35%);
}
.side-resize-handle::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background: transparent;
  transform: translateX(-50%);
  transition:
    background 0.15s,
    width 0.15s;
}
.side-resize-handle:hover::after,
.side-resize-handle.active::after {
  background: var(--primary);
  width: 2px;
}
.pane.is-resizing-side,
.pane.is-resizing-side * {
  user-select: none !important;
  cursor: col-resize !important;
}
.side-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.side-tab {
  flex: 1;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: var(--font-12);
  cursor: pointer;
  border-radius: var(--radius-4);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-family: inherit;
}
.side-tab:hover {
  background: var(--surface);
  color: var(--text);
}
.side-tab.active {
  background: var(--surface);
  color: var(--primary);
  font-weight: 600;
}
.side-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  background: var(--primary-bg);
  color: var(--primary);
  border-radius: var(--radius-8);
  font-size: var(--font-10);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.side-tree {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 6px;
}
.side-changes {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  /* no-h-scroll */
  overflow-x: hidden;
  overflow-y: hidden;
  position: relative;
  gap: 0;
}
.pane-side {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* no-h-scroll */
  overflow-x: hidden;
  overflow-y: hidden;
  transition: width 0.15s ease;
  height: 100%;
}
.pane.is-resizing-side .pane-side {
  transition: none;
}
/* 变更列表：按内容伸缩，最多占 45% */
.pane-side :deep(.changes) {
  flex: 1 1 auto;
  min-height: 100px;
}
/* Diff 查看器：撑满剩余空间 */
.pane-side :deep(.diff-viewer) {
  flex: 1 1 auto;
  min-height: 0;
}

/* @FILE_PICKER_V1 */
.file-picker {
  position: fixed;
  z-index: 9999;
  min-width: 260px;
  max-width: 440px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  box-shadow: 0 8px 24px rgb(15 30 60 / 15%);
}
.fp-input {
  border: 0;
  border-bottom: 1px solid var(--border);
  padding: 8px 10px;
  font: 12px var(--mono);
  outline: none;
  background: transparent;
  color: var(--text);
}
.fp-list {
  overflow-y: auto;
  padding: 4px 0;
}
.fp-item {
  padding: 5px 10px;
  font: 11px/1.4 var(--mono);
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-item.active {
  background: var(--primary-bg);
  color: var(--primary);
}
.fp-empty {
  padding: 10px;
  text-align: center;
  color: var(--text-3);
  font-size: var(--font-11);
}
:deep(.cm-file-tag) {
  background: var(--primary-bg);
  color: var(--primary);
  border-radius: var(--radius-4);
  padding: 1px 4px;
  margin: 0 1px;
}

/* ============ Card ============ */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-10);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 1px 2px rgb(15 30 60 / 4%);
}

/* ============ Bar (共用) ============ */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  /* tighten-spacing */
  height: 34px;
  padding: 0 10px;
  flex-shrink: 0;
}
.editor-bar {
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.term-bar {
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.dots {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
}
.d-red {
  background: #ff5f57;
}
.d-yellow {
  background: #febc2e;
}
.d-green {
  background: #28c840;
}

.file-badge {
  font: 12px/1 var(--mono, monospace);
  color: var(--text);
  font-weight: 600;
  letter-spacing: 0.1px;
}
.term-title {
  font-weight: 500;
  color: var(--text-2);
}
.meta {
  font-size: var(--font-11);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.bar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ============ 编辑器 ============ */
.editor {
  flex: 4 1 0;
  min-height: 100px;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.editor:focus-within {
  border-color: rgb(37 99 235 / 40%);
  box-shadow: 0 0 0 3px rgb(37 99 235 / 8%);
}
.editor.is-running {
  border-color: rgb(37 99 235 / 40%);
}
.editor-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  background: var(--surface);
}
.cm-host {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  /* editor-no-h-scroll */
}
.gutter {
  width: 44px;
  padding: 10px 0;
  background: var(--surface-2);
  border-right: 1px solid var(--border);
  overflow: hidden;
  user-select: none;
  flex-shrink: 0;
}
.gutter-num {
  padding: 0 8px 0 0;
  font: 12px/20px var(--mono, monospace);
  color: var(--text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.editor-textarea {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
  font: 12px/20px var(--mono, monospace);
  color: var(--text);
  background: transparent;
  border: 0;
  outline: 0;
  resize: none;
  overflow: auto;
  tab-size: 2;
  caret-color: var(--primary);
}
.editor-textarea::placeholder {
  color: var(--text-3);
  opacity: 0.75;
}

.editor-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  /* tighten-spacing */
  padding: 5px 10px;
  background: var(--surface-2);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.foot-spacer {
  flex: 1;
}
.loc-link {
  color: var(--success);
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
}
.loc-link:hover {
  color: var(--success);
  background: rgb(5 150 105 / 10%);
}
.meta-running {
  color: var(--success);
  font-variant-numeric: tabular-nums;
}
.git-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-11);
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.git-toggle input {
  margin: 0;
}
.git-after {
  font-family: var(--mono, monospace);
  font-size: var(--font-11);
  color: var(--success, #059669);
  margin-right: 8px;
  cursor: help;
}
.persist-warning {
  font-size: var(--font-11);
  color: var(--danger);
  margin-right: 8px;
  cursor: help;
}
.req-err-badge {
  padding: 2px 8px;
  border-radius: var(--radius-10);
  font-size: var(--font-11);
  font-weight: 600;
  color: #fff;
  background: var(--danger, #ef4444);
  margin-right: 8px;
  cursor: help;
}

/* ============ 按钮 ============ */
.primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 0;
  border-radius: var(--radius-6);
  font-size: var(--font-12);
  font-weight: 500;
  cursor: pointer;
  transition: 0.12s;
  color: #fff;
}
.primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary-btn .ico {
  font-size: var(--font-10);
  line-height: 1;
}

.primary-btn.run {
  background: var(--primary, #2563eb);
  box-shadow: 0 1px 2px rgb(37 99 235 / 30%);
}
.btn-kbd {
  display: inline-block;
  padding: 0 4px;
  margin-left: 6px;
  background: rgb(255 255 255 / 18%);
  border: 1px solid rgb(255 255 255 / 28%);
  border-bottom-width: 2px;
  border-radius: var(--radius-3);
  font: 10px/1.5 var(--mono, monospace);
  color: rgb(255 255 255 / 92%);
  vertical-align: middle;
}
.primary-btn.head-run {
  padding: 5px 14px;
  font-size: var(--font-12);
  font-weight: 600;
}
.primary-btn.takeover {
  background: var(--surface);
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: var(--primary-bg);
  color: var(--primary);
}
.primary-btn.run:hover:not(:disabled) {
  background: var(--primary-hover, #1d4ed8);
}
.primary-btn.stop {
  background: #ef4444;
  box-shadow: 0 1px 2px rgb(239 68 68 / 30%);
}
.primary-btn.stop:hover:not(:disabled) {
  background: #dc2626;
}
.term-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: var(--radius-6);
  border: 1px solid transparent;
  background: transparent;
  font-size: var(--font-12);
  font-weight: 500;
  cursor: pointer;
  transition: 0.14s;
  line-height: 1.3;
  font-family: inherit;
  white-space: nowrap;
}
.term-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.term-ico {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.term-btn.copy {
  color: #60a5fa;
  border-color: rgb(96 165 250 / 45%);
}
.term-btn.copy:hover:not(:disabled) {
  background: rgb(96 165 250 / 14%);
  border-color: #60a5fa;
  color: #93c5fd;
}
.term-btn.copy.done {
  color: var(--success);
  border-color: rgb(5 150 105 / 50%);
  background: rgb(5 150 105 / 12%);
}
.term-btn.copy.loading {
  color: #60a5fa;
  border-color: rgb(96 165 250 / 50%);
  background: rgb(96 165 250 / 10%);
  cursor: progress;
}
.term-ico.spin {
  animation: loop-spin 0.9s linear infinite;
}

.term-btn.ask-panel {
  color: var(--primary, #2563eb);
  border-color: var(--primary, #2563eb);
  background: var(--primary-bg, #eaf2ff);
}
.term-btn.ask-panel:hover:not(:disabled) {
  background: var(--primary, #2563eb);
  border-color: var(--primary, #2563eb);
  color: #fff;
}

.ghost-btn {
  padding: 4px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-4);
  color: var(--text-2);
  font-size: var(--font-12);
  cursor: pointer;
  transition: 0.12s;
}
.ghost-btn:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}
.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ============ 快捷键提示 ============ */
.kbd-hint {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--font-11);
  color: var(--text-3);
  user-select: none;
}
.kbd-hint kbd {
  display: inline-block;
  padding: 1px 5px;
  min-width: 18px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-bottom-width: 2px;
  border-radius: var(--radius-4);
  font: 10px/1 var(--mono, monospace);
  color: var(--text-2);
  text-align: center;
}
.kbd-hint .slash,
.kbd-hint .plus {
  color: var(--text-3);
  font-size: var(--font-10);
}

/* ============ 状态 ============ */
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-12);
  color: var(--text-3);
}
.status.ok {
  color: var(--success);
}
.status.err {
  color: var(--danger);
}
.s-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
/* status-moved */
.head-status {
  padding: 2px 8px;
  border-radius: var(--radius-10);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.head-status.ok {
  color: var(--success);
  background: var(--success-bg);
  border-color: transparent;
}
.head-status.err {
  color: var(--danger);
  background: var(--danger-bg);
  border-color: transparent;
}
.head-meta {
  font-variant-numeric: tabular-nums;
}

/* ============ 拖拽条 ============ */
.split-handle {
  flex-shrink: 0;
  height: 8px;
  cursor: row-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: background 0.15s;
}
.split-handle:hover,
.split-handle.active {
  background: rgb(37 99 235 / 6%);
}
.split-grip {
  width: 36px;
  height: 3px;
  border-radius: var(--radius-2);
  background: var(--border-2);
  transition: 0.15s;
}
.split-handle:hover .split-grip,
.split-handle.active .split-grip {
  background: var(--primary);
  width: 52px;
}

/* 键盘控制时：禁止选中 */
.is-resizing,
.is-resizing * {
  user-select: none !important;
  cursor: row-resize !important;
}

/* ============ 终端 ============ */
.terminal {
  flex: 6 1 0;
  min-height: 200px;
  background: #1e1e1e;
  border-color: #2a2a2a;
  margin-bottom: 8px;
}
.terminal .term-bar {
  background: #252526;
  border-bottom: 1px solid #333;
}
.terminal .term-bar .file-badge {
  color: #d4d4d4;
}
.terminal .term-bar .meta {
  color: #808080;
}
.terminal .term-bar .ghost-btn {
  color: #9d9d9d;
}
.terminal .term-bar .ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 8%);
  color: #e0e0e0;
}

.exit-badge {
  padding: 2px 8px;
  border-radius: var(--radius-10);
  font: 11px/1.4 var(--mono, monospace);
  font-weight: 600;
}
.exit-badge.ok {
  background: rgb(46 160 67 / 18%);
  color: var(--success);
}
.exit-badge.err {
  background: rgb(248 81 73 / 18%);
  color: #f48771;
}

.term-body {
  flex: 1;
  min-height: 0;
  /* no-h-scroll */
  overflow-x: hidden;
  overflow-y: auto;
  /* tighten-spacing */
  padding: 0;
  background: #181818;
  color: #d4d4d4;
}
.term-body::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.term-body::-webkit-scrollbar-thumb {
  background: rgb(255 255 255 / 12%);
  border-radius: var(--radius-4);
}
.term-body::-webkit-scrollbar-thumb:hover {
  background: rgb(255 255 255 / 20%);
}

/* 空状态 */
.term-ai-thinking {
  padding: 10px 14px;
  background: rgb(255 255 255 / 2%);
  border-left: 3px solid #60a5fa;
  margin: 4px 0;
}
.term-ai-label {
  gap: 6px;
  padding: 0 0 6px;
}
.term-ai-label .run-spinner {
  width: 10px;
  height: 10px;
}
.term-ai-text {
  margin: 0;
  padding: 0;
  font: 12px/1.65 var(--mono, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  color: #d4d4d4;
  max-height: 200px;
  overflow: auto;
}
.term-ai-caret {
  display: inline-block;
  color: #60a5fa;
  animation: ai-caret-blink 1s steps(2, start) infinite;
}
@keyframes ai-caret-blink { to { visibility: hidden; } }

.chat-list { display: flex; flex-direction: column; gap: 12px; padding: 14px 18px 20px; font: 13px/1.65 var(--mono, monospace); }
.chat-bubble { max-width: 84%; padding: 10px 14px; border-radius: 12px; word-break: break-word; line-height: 1.7; box-shadow: 0 1px 2px rgb(0 0 0 / 25%); }
.bubble-right { align-self: flex-end; background: linear-gradient(180deg, rgb(37 99 235 / 26%), rgb(37 99 235 / 18%)); border: 1px solid rgb(37 99 235 / 45%); border-bottom-right-radius: 4px; }
.bubble-left { align-self: flex-start; background: rgb(255 255 255 / 6%); border: 1px solid rgb(255 255 255 / 10%); border-bottom-left-radius: 4px; }
.bubble-think { background: rgb(0 0 0 / 30%); border-left: 3px solid #6a737d; color: #9d9d9d; font-size: 12px; border-radius: 8px; }
.bubble-head { margin-bottom: 6px; color: #7a8694; font-size: 11px; font-weight: 600; letter-spacing: 0.3px; }
.bubble-body { color: #dbe2ea; }
.bubble-body .md-h { margin: 6px 0 3px; font-size: 12px; color: #79b8ff; text-transform: none; letter-spacing: 0.3px; }
.bubble-body .md-p { margin: 2px 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.bubble-body .md-ul { margin: 2px 0; padding-left: 18px; }
.bubble-body code { padding: 1px 4px; background: rgb(255 255 255 / 8%); border-radius: 3px; font: 11px var(--mono, monospace); color: #9cdcfe; }
.bubble-body strong { color: #dcdcaa; }
.bubble-body .md-code { margin: 6px 0; border: 1px solid #2f2f2f; border-radius: var(--radius-4); overflow: hidden; background: rgb(0 0 0 / 25%); }
.bubble-body .md-code-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; background: rgb(255 255 255 / 4%); border-bottom: 1px solid #2f2f2f; }
.bubble-body .md-code-lang { color: #9d9d9d; font: 11px var(--mono, monospace); }
.bubble-body .md-code-acts { display: flex; gap: 6px; }
.bubble-body .md-code-acts button { padding: 1px 8px; border: 1px solid #3a3a3a; border-radius: var(--radius-3); background: transparent; color: #9d9d9d; font: 10px var(--mono, monospace); cursor: pointer; }
.bubble-body .md-code-acts button:hover { color: #d4d4d4; border-color: #d4d4d4; }
.bubble-body .md-code summary { list-style: none; padding: 0; }
.bubble-body .md-code summary::-webkit-details-marker { display: none; }
.bubble-body :deep(.hljs-keyword), .bubble-body :deep(.hljs-literal), .tree-body :deep(.hljs-keyword), .tree-body :deep(.hljs-literal) { color: #569cd6; }
.bubble-body :deep(.hljs-string), .tree-body :deep(.hljs-string) { color: #ce9178; }
.bubble-body :deep(.hljs-number), .tree-body :deep(.hljs-number) { color: #b5cea8; }
.bubble-body :deep(.hljs-comment), .tree-body :deep(.hljs-comment) { color: #6a9955; font-style: italic; }
.bubble-body :deep(.hljs-function), .bubble-body :deep(.hljs-title), .tree-body :deep(.hljs-function), .tree-body :deep(.hljs-title) { color: #dcdcaa; }
.bubble-body :deep(.hljs-variable), .bubble-body :deep(.hljs-params), .bubble-body :deep(.hljs-attr), .tree-body :deep(.hljs-variable), .tree-body :deep(.hljs-params), .tree-body :deep(.hljs-attr) { color: #9cdcfe; }
.bubble-body :deep(.hljs-built_in), .bubble-body :deep(.hljs-type), .tree-body :deep(.hljs-built_in), .tree-body :deep(.hljs-type) { color: #4ec9b0; }
.bubble-body :deep(.hljs-meta), .tree-body :deep(.hljs-meta) { color: #569cd6; }
.bubble-body :deep(.hljs-section), .tree-body :deep(.hljs-section) { color: #4ec9b0; }
.bubble-body :deep(.hljs-symbol), .bubble-body :deep(.hljs-bullet), .tree-body :deep(.hljs-symbol), .tree-body :deep(.hljs-bullet) { color: #d7ba7d; }

.bubble-body .md-code pre { margin: 0; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 11px/1.55 var(--mono, monospace); color: #c9d1d9; }
.chat-think { align-self: flex-start; display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: rgb(0 0 0 / 22%); border-left: 3px solid #6a737d; border-radius: 8px; color: #9d9d9d; font-size: 12px; cursor: pointer; max-width: 84%; transition: background 0.15s; }
.chat-think:hover { background: rgb(255 255 255 / 6%); color: #c9d1d9; }
.chat-step {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  margin: 2px 0;
  border-radius: var(--radius-8);
  background: rgb(255 255 255 / 3%);
  border: 1px solid rgb(255 255 255 / 6%);
  border-left: 3px solid #6a737d;
  font: 12px/1.4 var(--mono, monospace);
  color: #c9d1d9;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.chat-step:hover { background: rgb(255 255 255 / 5%); }
.chat-step.state-pending { border-left-color: #6a737d; }
.chat-step.state-running { border-left-color: #60a5fa; background: rgb(96 165 250 / 6%); }
.chat-step.state-done { border-left-color: #10b981; }
.chat-step.state-error { border-left-color: #f87171; background: rgb(248 113 113 / 8%); }
.chat-step .step-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6a737d;
  flex-shrink: 0;
}
.chat-step.state-running .step-dot { background: #60a5fa; animation: step-pulse 1s ease-in-out infinite; }
.chat-step.state-done .step-dot { background: #10b981; }
.chat-step.state-error .step-dot { background: #f87171; }
.chat-step .step-icon { font-size: 12px; flex-shrink: 0; }
.chat-step .step-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-step .step-time { font-size: 11px; color: #6a737d; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.chat-step .step-state {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3px;
  padding: 1px 8px;
  border-radius: 10px;
  background: rgb(255 255 255 / 6%);
  color: #9d9d9d;
  flex-shrink: 0;
}
.chat-step.state-running .step-state { background: rgb(96 165 250 / 22%); color: #93c5fd; }
.chat-step.state-done .step-state { background: rgb(16 185 129 / 18%); color: #6ee7b7; }
.chat-step.state-error .step-state { background: rgb(248 113 113 / 22%); color: #fca5a5; }
@keyframes step-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.chat-sys { align-self: center; display: flex; align-items: center; gap: 8px; padding: 2px 10px; color: #5b6673; font-size: 10px; opacity: 0.85; max-width: 90%; }
.sys-tag { padding: 1px 8px; border: 1px dashed rgb(255 255 255 / 12%); border-radius: 10px; color: #7a8694; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; }
.sys-time { color: #4f5a66; flex-shrink: 0; }

.session-tree { padding: 8px 12px; font: 12px/1.6 var(--mono, monospace); }
.tree-node { margin-bottom: 1px; }
.tree-head { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: var(--radius-4); cursor: pointer; }
.tree-head:hover { background: rgb(255 255 255 / 5%); }
.tree-caret { font-size: 10px; color: #6a737d; transition: transform 0.15s; }
.tree-caret.open { transform: rotate(90deg); }
.tree-icon { flex-shrink: 0; width: 18px; text-align: center; }
.tree-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d4d4d4; }
.tree-time { flex-shrink: 0; color: #6a737d; font-size: 10px; }
.tree-node.is-ai .tree-title { color: #9cdcfe; }
.tree-node.is-run .tree-title { color: #b5cea8; }
.tree-node.is-loop .tree-title { color: #dcdcaa; }
.tree-node.is-other .tree-title { color: #808080; }
.tree-node.is-stream { margin-left: 0; }
.think-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: pointer; color: #808080; font-size: 11px; border-radius: var(--radius-4); }
.think-row:hover { background: rgb(255 255 255 / 4%); }
.think-icon { font-size: 12px; }
.think-label { flex: 1; min-width: 0; color: #9d9d9d; }
.think-caret { transition: transform 0.15s; }
.think-caret.open { transform: rotate(90deg); }
.think-body { margin: 2px 0 8px 24px; padding: 8px 12px; background: rgb(0 0 0 / 15%); border-left: 2px solid #6a737d; border-radius: var(--radius-4); font: 11px/1.6 var(--mono, monospace); color: #9d9d9d; }
.think-body .md-p, .think-body .md-ul { color: #9d9d9d; }
.think-body .md-h { color: #9d9d9d; }
.md-code-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; background: rgb(255 255 255 / 4%); border-bottom: 1px solid #2f2f2f; }
.md-code-lang { color: #9d9d9d; font: 11px var(--mono, monospace); }
.md-code-acts { display: flex; gap: 6px; }
.md-code-acts button { padding: 1px 8px; border: 1px solid #3a3a3a; border-radius: var(--radius-3); background: transparent; color: #9d9d9d; font: 10px var(--mono, monospace); cursor: pointer; }
.md-code-acts button:hover { color: #d4d4d4; border-color: #d4d4d4; }
.md-code summary { list-style: none; padding: 0; }
.md-code summary::-webkit-details-marker { display: none; }
.tree-node.is-ask .tree-title { color: #d4d4d4; background: rgb(0 0 0 / 20%); padding: 4px 8px; border-radius: var(--radius-4); }

.tree-body { margin: 4px 0 8px 24px; padding: 8px 12px; background: rgb(0 0 0 / 20%); border-radius: var(--radius-6); }
.tree-body .md-h { margin: 8px 0 4px; font-size: 12px; font-weight: 700; color: #79b8ff; letter-spacing: 0.3px; text-transform: none; }
.tree-body .md-h:first-child { margin-top: 0; }
.tree-body .md-p { margin: 2px 0; color: #d4d4d4; font: 12px/1.65 var(--mono, monospace); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.tree-body .md-ul { margin: 2px 0; padding-left: 18px; color: #d4d4d4; font: 12px/1.65 var(--mono, monospace); }
.tree-body code { padding: 1px 4px; background: rgb(255 255 255 / 8%); border-radius: 3px; font: 11px var(--mono, monospace); color: #9cdcfe; }
.tree-body strong { color: #dcdcaa; }
.tree-body .md-code { margin: 6px 0; border: 1px solid #2f2f2f; border-radius: var(--radius-4); overflow: hidden; background: rgb(0 0 0 / 25%); }
.tree-body .md-code summary { padding: 4px 10px; cursor: pointer; color: #808080; font: 11px var(--mono, monospace); background: rgb(255 255 255 / 3%); user-select: none; }
.tree-body .md-code summary:hover { color: #d4d4d4; }
.tree-body .md-code[open] summary { border-bottom: 1px solid #2f2f2f; }
.tree-body .md-code pre { margin: 0; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 11px/1.55 var(--mono, monospace); color: #c9d1d9; }
.tree-empty { padding: 60px 20px; text-align: center; color: #808080; }

.term-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  padding: 24px 16px;
  text-align: center;
}
.empty-icon {
  font-size: 28px;
  opacity: 0.6;
  margin-bottom: 4px;
}
.empty-icon.dim {
  opacity: 0.35;
}
.empty-title {
  font:
    13px/1.4 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  font-weight: 600;
  color: #d4d4d4;
}
.empty-sub {
  font-size: var(--font-11);
  color: #808080;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: center;
}
.empty-sub kbd {
  display: inline-block;
  padding: 1px 5px;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-bottom-width: 2px;
  border-radius: var(--radius-3);
  font: 10px/1 var(--mono, monospace);
  color: #d4d4d4;
}
.empty-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  max-width: 620px;
  width: 100%;
  margin-top: 8px;
}
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 14px;
  background: #252526;
  border: 1px solid #2f2f2f;
  border-radius: var(--radius-6);
  text-align: left;
}
.empty-card-ico {
  font-size: 16px;
  opacity: 0.85;
}
.empty-card-title {
  font-size: var(--font-12);
  font-weight: 600;
  color: #d4d4d4;
}
.empty-card-desc {
  font-size: var(--font-11);
  color: #808080;
  line-height: 1.5;
}
.empty-card-desc code {
  padding: 0 4px;
  background: #2a2a2a;
  border-radius: var(--radius-3);
  font-family: var(--mono, monospace);
  font-size: 10px;
  color: #d4d4d4;
}
.term-running.term-empty {
  align-items: flex-start;
  justify-content: flex-start;
  text-align: left;
  padding: 14px 16px;
}
.term-running .empty-title {
  color: var(--success);
}
.term-running .empty-sub {
  color: var(--success);
  opacity: 0.85;
}
.term-shell-line {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 0 4px;
  font: 13px/1.6 var(--mono, monospace);
  color: #d4d4d4;
}
.term-shell-prompt {
  flex-shrink: 0;
  color: var(--success);
  font-weight: 700;
}
.term-shell-cmd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.term-shell-wait {
  flex-shrink: 0;
  color: var(--success);
  font-size: var(--font-14);
  font-variant-numeric: tabular-nums;
}
.term-live-out,
.term-live-err {
  align-self: stretch;
  margin: 8px 0 0;
  padding: 8px 10px;
  font: 11px/1.6 var(--mono, monospace);
  /* no-h-scroll */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  color: #e6edf3;
  background: rgb(255 255 255 / 3%);
  border-radius: var(--radius-6);
}
.term-live-err {
  color: #f48771;
  background: rgb(248 81 73 / 8%);
}
.run-ico {
  display: inline-block;
  margin-left: 4px;
  font-size: var(--font-10);
  animation: run-pulse 1s ease-in-out infinite;
}
.run-status-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  align-self: flex-start;
}
.run-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgb(255 255 255 / 25%);
  border-top-color: var(--success);
  border-radius: 50%;
  animation: run-spin 0.7s linear infinite;
  vertical-align: middle;
  flex-shrink: 0;
}
@keyframes run-spin { to { transform: rotate(360deg); } }
.run-frame {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  font: 14px/1 var(--mono, monospace);
  color: var(--success);
  text-shadow: 0 0 8px rgb(5 150 105 / 55%);
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.run-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-11);
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--success);
  text-shadow: 0 0 8px rgb(5 150 105 / 35%);
}
.run-elapsed {
  margin-top: 6px;
  font-size: var(--font-11);
  color: #7a8694;
  letter-spacing: 0.3px;
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}
@keyframes run-pulse {
  0%,
  100% {
    opacity: 1;
    transform: translateX(0);
  }
  50% {
    opacity: 0.4;
    transform: translateX(3px);
  }
}

/* 段落 */
.term-sections {
  display: flex;
  flex-direction: column;
}
.term-status {
  padding-bottom: 4px;
}
.term-status.ok .term-status-detail {
  color: var(--success);
}
.term-status.err .term-status-detail {
  color: #f48771;
}
.term-status-detail {
  margin-left: auto;
  font-size: var(--font-11);
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  color: #9d9d9d;
  font-variant-numeric: tabular-nums;
  user-select: text;
}
.term-summary { padding-bottom: 4px; }
.term-summary .term-label { gap: 6px; }
.term-summary-text {
  margin-left: 4px;
  color: #9d9d9d;
  font-size: var(--font-11);
  letter-spacing: 0;
  text-transform: none;
  font-family: var(--mono, monospace);
}
.term-summary-line {
  flex: 1;
  min-width: 0;
  color: #d4d4d4;
  font: 12px/1.5 var(--mono, monospace);
  letter-spacing: 0;
  text-transform: none;
}
.term-line-summary.err .term-summary-line { color: #f48771; }
.term-line-value { margin-left: auto; color: #9d9d9d; font-size: var(--font-11); font-family: var(--mono, monospace); letter-spacing: 0; text-transform: none; }
.term-line-value.err { color: #f48771; }
.term-section + .term-section {
  border-top: 1px solid #2a2a2a;
  /* tighten-spacing */
  margin-top: 5px;
  padding-top: 8px;
}
.term-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 8px;
  font: 11px/1 var(--mono, monospace);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.prompt-char {
  color: var(--success);
  font-size: var(--font-12);
}
.prompt-char.err {
  color: #f48771;
}
.label-text {
  color: #9d9d9d;
}
.label-text.err {
  color: #f48771;
}

/* ============ Side ============ */
.side-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--surface);
  border: 1px dashed var(--border-2);
  border-radius: var(--radius-10);
  color: var(--text-3);
}
.side-empty-icon {
  font-size: 28px;
  opacity: 0.5;
}
.side-empty-text {
  font-size: var(--font-12);
}

/* ============ Overlay ============ */
.overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  border-radius: var(--radius-10);
}
.overlay.drop {
  background: rgb(37 99 235 / 8%);
}
.overlay.success {
  background: rgb(5 150 105 / 10%);
  animation: fade-in 0.15s ease-out;
}
.overlay-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 28px;
  background: #fff;
  border-radius: var(--radius-10);
  box-shadow: 0 6px 24px rgb(15 30 60 / 18%);
  animation: pop-in 0.2s ease-out;
}
.overlay-card.drop {
  border: 2px dashed var(--primary);
}
.overlay-card.success {
  border: 2px solid var(--success);
}
.overlay-icon {
  font-size: 26px;
}
.overlay-text {
  font-size: var(--font-13);
  font-weight: 600;
}
.overlay-card.drop .overlay-text {
  color: var(--primary);
}
.overlay-card.success .overlay-text {
  color: var(--success);
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
@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (max-width: 1100px) {
  .pane {
    flex-direction: column;
    overflow: visible;
  }
  .side-resize-handle {
    display: none;
  }
  .side-drawer-toggle {
    display: inline-flex;
  }
  .side-drawer-backdrop {
    display: block;
  }
  /* U.12: 窄屏 pane-side 改右侧抽屉 */
  .pane-side {
    position: fixed !important;
    top: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 320px !important;
    height: 100vh !important;
    z-index: 35 !important;
    transform: translateX(100%) !important;
    transition: transform 0.22s ease !important;
    background: var(--surface);
    border-left: 1px solid var(--border);
    padding: 8px;
    box-sizing: border-box;
  }
  .pane-side.drawer-open {
    transform: translateX(0) !important;
  }
  .pane-side :deep(.changes) {
    max-height: 42%;
  }
  .editor-bar,
  .term-bar {
    gap: 6px;
  }
  .kbd-hint {
    display: none;
  }
}
@media (max-width: 720px) {
  .pane-side {
    height: 260px;
  }
  .bar {
    padding: 0 8px;
    gap: 6px;
  }
  .gutter {
    width: 34px;
  }
  .gutter-num {
    padding-right: 6px;
    font-size: var(--font-11);
  }
  .editor-textarea {
    padding: 8px 10px;
  }
  .tpl-bar {
    padding: 4px 8px;
  }
}

.tpl-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  /* tighten-spacing */
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
  overflow-x: auto;
}
.tpl-label {
  font-size: var(--font-11);
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.3px;
  flex-shrink: 0;
  margin-right: 2px;
}
.tpl-chip {
  padding: 3px 10px;
  border: 1px solid var(--border-2);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--font-11);
  cursor: pointer;
  white-space: nowrap;
  transition: 0.12s;
  font-family: inherit;
  flex-shrink: 0;
}
.draft-select {
  max-width: 120px;
  padding: 3px 8px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-2);
  font: 11px/1.4 var(--mono, monospace);
  cursor: pointer;
  outline: 0;
}
.draft-select:focus {
  border-color: var(--primary);
}
.draft-del {
  padding: 2px 6px;
  font-size: 14px;
  line-height: 1;
}
.tpl-chip:hover {
  background: var(--primary-bg);
  color: var(--primary);
  border-color: var(--primary);
}
.diff-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgb(15 30 60 / 45%);
  animation: overlay-in 0.15s ease-out;
}
.diff-overlay-panel {
  position: relative;
  width: min(1100px, 100%);
  max-height: min(720px, 100%);
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgb(15 30 60 / 26%);
  border-radius: var(--radius-10);
  overflow: hidden;
}
.diff-overlay-panel :deep(.diff-viewer) {
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-10);
  background: var(--surface);
}
.diff-overlay-close {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 2;
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
.diff-overlay-close:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-bg);
}
@keyframes overlay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* —— P2 自动化循环控制条 —— */
.loop-bar {
  display: flex;
  flex-direction: row;
  /* U.12: 窄屏按钮换行，不再一行硬挤 */
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 6px 12px;
  margin-bottom: 6px;
  min-height: 0;
  max-height: 88px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-left-style: solid;
  border-left-color: var(--border-2);
  border-radius: var(--radius-8);
}
.loop-bar .loop-status {
  flex-shrink: 0;
  white-space: nowrap;
}
.loop-bar .loop-goal-text {
  flex: 1 1 auto;
  min-width: 0;
}
.loop-bar .loop-actions {
  flex-shrink: 0;
  margin-left: auto;
}
.loop-bar.is-waiting, .loop-bar.is-running { border-left-color: #409eff; }
.loop-bar.is-executing, .loop-bar.is-parsing, .loop-bar.is-feedback { border-left-color: #e6a23c; }
.loop-bar.is-interrupted { border-left-color: var(--danger); }
.loop-bar.is-stopped { border-left-color: var(--text-3); }
.loop-bar.is-budget-limited { border-left-color: #e6a23c; }
/* 倒计时进度条（waiting 状态） */
.loop-waiting-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-11);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.loop-waiting-bar {
  display: inline-block;
  width: 80px;
  height: 4px;
  background: var(--border-color, #dcdfe6);
  border-radius: var(--radius-2);
  overflow: hidden;
}
.loop-waiting-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #67c23a 0%, #e6a23c 70%, var(--danger) 100%);
  transition: width 0.9s linear;
}
.loop-goal-input {
  flex: 1 1 320px;
  min-width: 200px;
  padding: 6px 10px;
  border: 1px solid var(--border-color, #dcdfe6);
  border-radius: var(--radius-6);
  font-size: var(--font-12);
  background: var(--input-bg, #fff);
  color: inherit;
}
.loop-status { font-size: var(--font-12); font-variant-numeric: tabular-nums; white-space: nowrap; }
.loop-goal-text {
  flex: 1 1 160px;
  font-size: var(--font-12);
  opacity: .7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.loop-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.loop-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text-2);
  font: 500 12px/1 inherit;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 1px 1px rgb(15 30 60 / 4%);
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.08s ease;
}
.loop-btn:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-bg);
}
.loop-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: none;
}
.loop-btn:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 3px rgb(37 99 235 / 18%);
}
.loop-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  background: var(--surface-2);
  color: var(--text-3);
  box-shadow: none;
}
.loop-btn.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  box-shadow: 0 1px 2px rgb(37 99 235 / 28%);
}
.loop-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
  color: #fff;
  box-shadow: 0 3px 8px rgb(37 99 235 / 24%);
}
.loop-btn.kill,
.loop-btn.rollback {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  box-shadow: 0 1px 2px rgb(239 68 68 / 28%);
}
.loop-btn.kill:hover:not(:disabled),
.loop-btn.rollback:hover:not(:disabled) {
  background: #dc2626;
  border-color: var(--danger);
  color: #fff;
  box-shadow: 0 3px 8px rgb(239 68 68 / 32%);
}
.note-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
}
.note-input {
  width: 100%;
  min-height: 40px;
  padding: 6px 10px;
  font: 12px/1.5 var(--mono);
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  outline: 0;
  resize: vertical;
}
.note-input:focus { border-color: var(--primary); }
.note-actions { display: flex; gap: 6px; justify-content: flex-end; }
.decision-actions { flex-wrap: wrap; }
.decision-custom {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  margin-top: 4px;
}
.decision-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface-2);
  color: var(--text);
  font: 12px/1.5 var(--mono, monospace);
  outline: 0;
}
.decision-input:focus { border-color: var(--primary); }
.decision-btn {
  background: var(--primary-bg);
  color: var(--primary);
  border-color: var(--primary);
  font-weight: 600;
}
.decision-btn:hover:not(:disabled) {
  background: var(--primary);
  color: #fff;
}
.loop-end-status { flex: 1; font-size: var(--font-12); }
.loop-end-status em { opacity: .65; font-style: normal; }
.loop-spin { display: inline-block; animation: loop-spin 1.6s linear infinite; }
.loop-stage-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius-10);
  font-size: var(--font-10);
  font-weight: 700;
  letter-spacing: 0.5px;
  margin: 0 4px;
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  color: var(--text-2);
}
.loop-stage-badge.stage-plan { background: var(--primary-bg); color: var(--primary); border-color: var(--primary); }
.loop-stage-badge.stage-implement { background: var(--warning-bg, rgba(230, 162, 60, 0.12)); color: var(--warning, #e6a23c); border-color: var(--warning, #e6a23c); }
.loop-stage-badge.stage-verify { background: var(--success-bg, rgba(16, 185, 129, 0.12)); color: var(--success, #10b981); border-color: var(--success, #10b981); }
.loop-round-bar {
  display: inline-block;
  width: 80px;
  height: 4px;
  background: var(--border-color, #dcdfe6);
  border-radius: var(--radius-2);
  overflow: hidden;
  margin: 0 4px;
}
.loop-round-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--primary, #2563eb) 0%, var(--warning, #e6a23c) 70%, var(--danger) 100%);
  transition: width 0.3s ease;
}
@keyframes loop-spin { to { transform: rotate(360deg); } }
.inbox-badge { color: #409eff; border-color: #409eff; }


/* ═══════════════════════════════════════════════════════════
   [terminal-theme-override] 终端区主题化
   覆盖上方硬编码深色值，浅色主题下终端同样清晰可读
   ═══════════════════════════════════════════════════════════ */
.terminal { background: var(--term-bg); border-color: var(--term-border); }
.terminal .term-bar { background: var(--term-bar-bg); border-bottom-color: var(--term-border); }
.terminal .term-bar .file-badge { color: var(--term-text); }
.terminal .term-bar .meta { color: var(--term-text-3); }
.terminal .term-bar .ghost-btn { color: var(--term-text-2); }
.terminal .term-bar .ghost-btn:hover:not(:disabled) { background: var(--term-chip-bg-2); color: var(--term-text); }
.term-raw { color: var(--term-text); background: var(--term-chip-bg); }
.term-loading { color: var(--term-accent); background: var(--term-chip-bg); border-bottom-color: var(--term-chip-border); }
.term-loading-spinner { border-color: var(--term-chip-border); border-top-color: var(--term-accent); }
.term-body { color: var(--term-text); }
.term-ai-thinking { background: var(--term-chip-bg); border-left-color: var(--term-accent); }
.term-ai-text { color: var(--term-text); }
.term-ai-caret { color: var(--term-accent); }
.chat-list { color: var(--term-text); }
.chat-bubble { box-shadow: 0 1px 2px var(--term-shadow); }
.chat-bubble.bubble-right { background: var(--term-user-bg); border: 1px solid var(--term-user-border); }
.chat-bubble.bubble-left { background: var(--term-ai-bg); border: 1px solid var(--term-ai-border); }
.bubble-think { background: var(--term-think-bg); border-left-color: var(--term-accent); color: var(--term-text-2); }
.bubble-head { color: var(--term-text-3); }
.bubble-body { color: var(--term-text); }
.bubble-body .md-h { color: var(--term-accent); }
.bubble-body code { background: var(--term-chip-bg-2); color: var(--term-code-color); }
.bubble-body .md-code { background: var(--term-code-bg); border-color: var(--term-sep); }
.bubble-body .md-code-bar { background: var(--term-chip-bg); border-bottom-color: var(--term-sep); }
.bubble-body .md-code-lang { color: var(--term-text-2); }
.bubble-body .md-code-acts button { border-color: var(--term-chip-border); color: var(--term-text-2); }
.bubble-body .md-code-acts button:hover { color: var(--term-text); border-color: var(--term-text); }
.bubble-body .md-code pre { color: var(--term-text); }
.chat-think { background: var(--term-think-bg); border-left-color: var(--term-accent); color: var(--term-text-2); }
.chat-think:hover { background: var(--term-chip-hover); color: var(--term-text); }
.chat-sys { color: var(--term-text-3); }
.sys-tag { border-color: var(--term-chip-border-2); color: var(--term-text-3); }
.sys-time { color: var(--term-text-3); }
.chat-step { background: var(--term-chip-bg); border-color: var(--term-chip-border); color: var(--term-text); }
.chat-step:hover { background: var(--term-chip-hover); }
.chat-step .step-time { color: var(--term-text-3); }
.chat-step .step-state { background: var(--term-chip-bg-2); color: var(--term-text-2); }
.think-row { color: var(--term-text-3); }
.think-row:hover { background: var(--term-chip-bg-2); }
.think-label { color: var(--term-text-2); }
.think-body { background: var(--term-chip-bg); border-left-color: var(--term-accent); color: var(--term-text-2); }
.think-body .md-p, .think-body .md-ul { color: var(--term-text-2); }
.think-body .md-h { color: var(--term-text-2); }
.tree-head:hover { background: var(--term-chip-bg-2); }
.tree-title { color: var(--term-text); }
.tree-node.is-other .tree-title { color: var(--term-text-3); }
.tree-node.is-ask .tree-title { color: var(--term-text); background: var(--term-chip-bg-2); }
.tree-body .md-p, .tree-body .md-ul { color: var(--term-text); }
.tree-body code { background: var(--term-chip-bg-2); color: var(--term-code-color); }
.tree-empty { color: var(--term-text-3); }
.tree-empty .empty-title { color: var(--term-text); }
.tree-empty .empty-sub { color: var(--term-text-2); }
.md-code-bar { background: var(--term-chip-bg); border-bottom-color: var(--term-sep); }
.md-code-lang { color: var(--term-text-2); }
.md-code-acts button { border-color: var(--term-chip-border); color: var(--term-text-2); }
.md-code-acts button:hover { color: var(--term-text); border-color: var(--term-text); }


/* [button-icons] SVG 按钮图标 */
.primary-btn .ico-svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: inline-block;
  vertical-align: -1px;
}
.primary-btn .ico-svg + span { margin-left: 2px; }

/* ═══════════════════════════════════════════════════════════
   [ui-polish] 去外壳 + 按钮圆角 + tab 一体化
   ═══════════════════════════════════════════════════════════ */

/* 1. 去外壳：terminal / editor 去 card 边框、背景、阴影 */
.pane-main > .terminal.card,
.pane-main > .editor.card {
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  overflow: visible !important;
}

/* 2. 顶栏 bar 加圆角，与内容视觉一体 */
.pane-main .terminal .term-bar,
.pane-main .editor .editor-bar {
  border-radius: 10px 10px 0 0;
}

/* 3. 按钮圆角统一（原 6px → 8px） */
.primary-btn,
.loop-btn,
.ghost-btn,
.term-btn,
.btn,
.tpl-chip,
.draft-select,
.side-tab {
  border-radius: 8px;
}

/* 4. side-tabs 图标化 + 与内容一体 */
.side-tabs {
  padding: 4px;
  gap: 4px;
  background: var(--surface-2);
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
}
.side-tab {
  padding: 6px 10px;
}
.side-tab.active {
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(15 30 60 / 6%);
}
.side-tab-icon {
  width: 14px;
  height: 14px;
  display: inline-block;
  vertical-align: -2px;
  flex-shrink: 0;
}


/* ═══════════════════════════════════════════════════════════
   [dark-compact] 紧凑深色：步骤小字 + 气泡收紧
   ═══════════════════════════════════════════════════════════ */

/* 对话区整体收紧 */
.chat-list {
  gap: 2px !important;
  padding: 8px 12px 14px !important;
  font: 12px/1.55 var(--mono, monospace) !important;
}

/* 步骤行（脚本执行过程）—— 小字日志风 */
.chat-step {
  padding: 2px 8px !important;
  margin: 0 !important;
  gap: 6px !important;
  font: 11px/1.5 var(--mono, monospace) !important;
  border-radius: 3px !important;
  border: 0 !important;
  border-left: 2px solid #6a737d !important;
  background: transparent !important;
  color: var(--text-2) !important;
  min-height: 0 !important;
}
.chat-step:hover { background: var(--term-chip-bg-2) !important; }
.chat-step.state-pending { border-left-color: #6a737d !important; }
.chat-step.state-running { border-left-color: #60a5fa !important; background: rgb(96 165 250 / 6%) !important; }
.chat-step.state-done { border-left-color: #10b981 !important; }
.chat-step.state-error { border-left-color: #f87171 !important; background: rgb(248 113 113 / 8%) !important; }
.chat-step .step-dot { width: 4px !important; height: 4px !important; }
.chat-step .step-icon { font-size: 11px !important; }
.chat-step .step-title { font-size: 11px !important; }
.chat-step .step-time { font-size: 10px !important; }
.chat-step .step-state {
  font-size: 9px !important;
  padding: 0 6px !important;
  line-height: 1.5 !important;
  border-radius: 3px !important;
}

/* 用户/AI 气泡收紧，别太占地方 */
.chat-bubble {
  padding: 6px 10px !important;
  border-radius: 8px !important;
  font-size: 12px !important;
  line-height: 1.55 !important;
  margin: 3px 0 !important;
  max-width: 88% !important;
}
.bubble-head {
  margin-bottom: 3px !important;
  font-size: 10px !important;
  letter-spacing: 0.2px !important;
}
.bubble-body { font-size: 12px !important; }
.bubble-body .md-h { margin: 3px 0 2px !important; font-size: 11px !important; }
.bubble-body .md-p { margin: 1px 0 !important; }
.bubble-body .md-code { margin: 4px 0 !important; }

/* 系统小提示行紧凑 */
.chat-sys {
  padding: 1px 8px !important;
  font-size: 10px !important;
  gap: 6px !important;
}
.sys-tag { padding: 0 6px !important; font-size: 10px !important; }

/* 思考行紧凑 */
.chat-think {
  padding: 3px 8px !important;
  font-size: 11px !important;
  gap: 6px !important;
  max-width: 100% !important;
}


/* ═══════════════════════════════════════════════════════════
   [button-theme] 按钮配色重做：暖橙强调 + 灰阶次按钮
   参考 Claude Code / Codex 克制配色
   ═══════════════════════════════════════════════════════════ */

/* ——— 次按钮：透明底 + 细边框，hover 时淡淡提亮 ——— */
.ghost-btn {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  padding: 4px 10px !important;
  font-size: var(--font-12) !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 8%) !important;
}
.ghost-btn:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }

/* ——— 终端内按钮 ——— */
.term-btn {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.term-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.term-btn:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }
.term-btn.copy, .term-btn.ask-panel { color: var(--text-2) !important; border-color: rgb(255 255 255 / 8%) !important; }
.term-btn.copy:hover:not(:disabled), .term-btn.ask-panel:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important; color: var(--text) !important; border-color: rgb(255 255 255 / 14%) !important;
}

/* ——— 芯片 / 下拉 / tab ——— */
.tpl-chip {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
}
.tpl-chip:hover {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.draft-select {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
}
.draft-select:hover { border-color: rgb(255 255 255 / 14%) !important; }

/* ——— primary 系列（运行/主操作）：暖橙实底 ——— */
.primary-btn.run {
  background: var(--primary) !important;
  color: #fff !important;
  box-shadow: none !important;
  border: 0 !important;
}
.primary-btn.run:hover:not(:disabled) { background: var(--primary-hover) !important; box-shadow: none !important; }

/* 运行按钮（takeover 态）：暖橙描边，非实心，更克制 */
.primary-btn.takeover {
  background: transparent !important;
  color: var(--primary) !important;
  border: 1px solid var(--primary) !important;
  box-shadow: none !important;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(217 119 87 / 12%) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
}

/* 停止 / 暂停：柔和红描边 */
.primary-btn.stop {
  background: transparent !important;
  color: var(--danger) !important;
  border: 1px solid var(--danger) !important;
  box-shadow: none !important;
}
.primary-btn.stop:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  color: #fff !important;
  border-color: var(--danger) !important;
}

/* ——— loop-btn 系列 ——— */
.loop-btn {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  box-shadow: none !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.loop-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.loop-btn:active:not(:disabled) { box-shadow: none !important; }
.loop-btn:focus-visible { outline: 0 !important; box-shadow: 0 0 0 2px rgb(217 119 87 / 30%) !important; }
.loop-btn:disabled { opacity: 0.4 !important; background: transparent !important; color: var(--text-3) !important; }

.loop-btn.primary {
  background: var(--primary) !important;
  border-color: var(--primary) !important;
  color: #fff !important;
  box-shadow: none !important;
}
.loop-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  color: #fff !important;
  box-shadow: none !important;
}
.loop-btn.kill, .loop-btn.rollback {
  background: transparent !important;
  border-color: rgb(224 108 117 / 55%) !important;
  color: var(--danger) !important;
  box-shadow: none !important;
}
.loop-btn.kill:hover:not(:disabled), .loop-btn.rollback:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  border-color: var(--danger) !important;
  color: #fff !important;
  box-shadow: none !important;
}

/* ——— 决策按钮 ——— */
.decision-btn {
  background: rgb(217 119 87 / 12%) !important;
  color: var(--primary) !important;
  border-color: var(--primary) !important;
  font-weight: 600 !important;
}
.decision-btn:hover:not(:disabled) {
  background: var(--primary) !important;
  color: #fff !important;
  border-color: var(--primary) !important;
}

/* ——— 焦点环统一暖橙 ——— */
.primary-btn:focus-visible, .term-btn:focus-visible, .ghost-btn:focus-visible, .tpl-chip:focus-visible, .draft-select:focus-visible {
  outline: 0 !important;
  box-shadow: 0 0 0 2px rgb(217 119 87 / 35%) !important;
}

/* ——— 图标按钮（App 头部）——— */
.theme-toggle, .trace-toggle, .settings-toggle, .ask-toggle, .timeline-toggle {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: var(--text-2) !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.theme-toggle:hover, .trace-toggle:hover, .settings-toggle:hover, .ask-toggle:hover, .timeline-toggle:hover {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 10%) !important;
}

/* ——— 主色大按钮（FileList.save-btn / GeneratePanel.btn-primary）——— */
.save-btn, .btn-primary {
  background: var(--primary) !important;
  color: #fff !important;
  border: 0 !important;
  box-shadow: none !important;
  border-radius: 6px !important;
}
.save-btn:hover:not(:disabled), .btn-primary:hover:not(:disabled) {
  background: var(--primary-hover) !important;
  box-shadow: none !important;
}

/* ——— FileList 撤回按钮 ——— */
.undo-btn {
  background: transparent !important;
  border: 0 !important;
  color: var(--text-3) !important;
}
.undo-btn:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  color: var(--danger) !important;
}

/* ——— FileTree 刷新 ——— */
.refresh { background: transparent !important; border: 0 !important; color: var(--text-3) !important; }
.refresh:hover:not(:disabled) { background: rgb(255 255 255 / 6%) !important; color: var(--text) !important; }


/* ═══════════════════════════════════════════════════════════
   [button-theme-v2] 主按钮去实底，静默态灰
   ═══════════════════════════════════════════════════════════ */

/* run 态（P2 主操作）—— 透明底 + 橙描边 */
.primary-btn.run {
  background: transparent !important;
  color: var(--primary) !important;
  border: 1px solid var(--primary) !important;
  box-shadow: none !important;
}
.primary-btn.run:hover:not(:disabled) {
  background: var(--primary-bg) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  box-shadow: none !important;
}

/* takeover 态（运行按钮）—— 同样透明底 + 橙描边 */
.primary-btn.takeover {
  background: transparent !important;
  color: var(--primary) !important;
  border: 1px solid var(--primary) !important;
  box-shadow: none !important;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: var(--primary-bg) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
}

/* stop 态（暂停）—— 透明底 + 柔红描边 */
.primary-btn.stop {
  background: transparent !important;
  color: var(--danger) !important;
  border: 1px solid var(--danger) !important;
  box-shadow: none !important;
}
.primary-btn.stop:hover:not(:disabled) {
  background: rgb(224 108 117 / 12%) !important;
  color: var(--danger) !important;
  border-color: var(--danger) !important;
}

/* loop-btn 主态：透明橙描边 */
.loop-btn.primary {
  background: transparent !important;
  color: var(--primary) !important;
  border-color: var(--primary) !important;
}
.loop-btn.primary:hover:not(:disabled) {
  background: var(--primary-bg) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
}


/* ═══════════════════════════════════════════════════════════
   [side-connected] 树/变更 tab 与内容一体
   ═══════════════════════════════════════════════════════════ */

/* 1. 去掉 tab 与内容之间的间距 */
.pane-side {
  gap: 0 !important;
  background: var(--surface) !important;
  border: 1px solid var(--border) !important;
  border-radius: 10px !important;
  overflow: hidden !important;
}

/* 2. tab 条紧贴内容，去圆角只留顶部，统一底色 */
.side-tabs {
  background: var(--surface-2) !important;
  border-radius: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  padding: 4px !important;
  gap: 4px !important;
  flex-shrink: 0 !important;
}

/* 3. 内容区透明无边框，融入外层圆角 */
.side-tree,
.side-changes {
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  padding: 8px 10px !important;
  gap: 0 !important;
}

/* 4. tab 激活态更柔和 */
.side-tab.active {
  background: var(--surface) !important;
  color: var(--text) !important;
  box-shadow: none !important;
}
.side-tab {
  color: var(--text-3) !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}
.side-tab:hover {
  background: rgb(255 255 255 / 4%) !important;
  color: var(--text-2) !important;
}

/* 5. 项目结构标题行去底部留白 */
.side-tree .tree-head {
  margin-bottom: 4px !important;
  padding: 0 4px 6px !important;
}


/* ═══════════════════════════════════════════════════════════
   [tab-badge] 变更 tab 徽章：实心橙底白字，醒目显示数量
   ═══════════════════════════════════════════════════════════ */
.side-tab-badge {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 18px !important;
  height: 18px !important;
  padding: 0 5px !important;
  margin-left: 3px !important;
  background: var(--primary) !important;
  color: #fff !important;
  border-radius: 9px !important;
  font-size: 10px !important;
  font-weight: 700 !important;
  font-variant-numeric: tabular-nums !important;
  line-height: 1 !important;
  box-shadow: 0 0 0 2px var(--surface-2) !important;
  transition: transform 0.15s ease !important;
}
/* 变更 tab 被激活时，徽章反色（白底橙字） */
.side-tab.active .side-tab-badge {
  background: var(--primary-bg) !important;
  color: var(--primary) !important;
  box-shadow: 0 0 0 2px var(--surface) !important;
}


/* ═══════════════════════════════════════════════════════════
   [run-steps] 运行时实时步骤 + 执行中 loading
   ═══════════════════════════════════════════════════════════ */

.chat-step.state-running .step-dot {
  width: 10px !important;
  height: 10px !important;
  background: transparent !important;
  border: 2px solid var(--term-chip-border-2, rgb(255 255 255 / 20%)) !important;
  border-top-color: #60a5fa !important;
  border-right-color: #60a5fa !important;
  border-radius: 50% !important;
  animation: step-spin 0.75s linear infinite !important;
  box-shadow: none !important;
}
@keyframes step-spin { to { transform: rotate(360deg); } }

.chat-step.state-running .step-title { color: var(--term-text) !important; font-weight: 500 !important; }
.chat-step .step-title { font-variant-numeric: tabular-nums; }

.chat-step.state-running .step-state {
  background: rgb(96 165 250 / 18%) !important;
  color: #93c5fd !important;
}


/* ═══════════════════════════════════════════════════════════
   [msg-center-v2] 消息居中 + 精简
   ═══════════════════════════════════════════════════════════ */
.chat-msg {
  display: block;
  width: fit-content;
  max-width: min(720px, 92%);
  margin: 6px auto !important;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--term-chip-bg, rgb(255 255 255 / 4%));
  border: 1px solid var(--term-chip-border, rgb(255 255 255 / 6%));
  font: 12px/1.6 var(--mono, monospace);
  color: var(--term-text, var(--text));
  text-align: left;
}
.chat-msg-user {
  background: rgb(99 102 241 / 8%);
  border-color: rgb(99 102 241 / 18%);
}
.chat-msg-ai {
  background: var(--term-chip-bg, rgb(255 255 255 / 4%));
}
.chat-msg .bubble-head {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  margin-bottom: 4px;
  font-size: 10px;
  color: var(--term-text-3, var(--text-3));
  font-weight: 500;
  letter-spacing: 0.3px;
}
.chat-msg .bubble-body {
  color: var(--term-text, var(--text));
  word-break: break-word;
}
.chat-msg .bubble-body strong {
  color: var(--term-accent, var(--primary));
  font-weight: 600;
}
.chat-msg .bubble-body p {
  margin: 2px 0;
  white-space: pre-wrap;
  word-break: break-word;
}
/* 强制覆盖旧左右分栏位置 */
.chat-list .chat-msg {
  align-self: auto !important;
}


/* ═══════════════════════════════════════════════════════════
   [step-dashed] 步骤行：无背景，虚线边框 + 字色
   ═══════════════════════════════════════════════════════════ */
.chat-step {
  background: transparent !important;
  border: 1px dashed var(--term-chip-border-2, rgb(255 255 255 / 18%)) !important;
  border-left: 1px dashed var(--term-chip-border-2, rgb(255 255 255 / 18%)) !important;
  color: var(--term-text-2, var(--text-2)) !important;
}
.chat-step:hover {
  background: rgb(255 255 255 / 3%) !important;
  border-color: rgb(255 255 255 / 28%) !important;
  border-left-color: rgb(255 255 255 / 28%) !important;
}

/* 状态色：只改边框和字色 */
.chat-step.state-pending {
  border-color: rgb(255 255 255 / 14%) !important;
  border-left-color: rgb(255 255 255 / 14%) !important;
  color: var(--term-text-3, var(--text-3)) !important;
}
.chat-step.state-running {
  border-color: rgb(96 165 250 / 55%) !important;
  border-left-color: rgb(96 165 250 / 55%) !important;
  color: #93c5fd !important;
}
.chat-step.state-running .step-dot {
  border-color: rgb(96 165 250 / 35%) !important;
  border-top-color: #93c5fd !important;
  border-right-color: #93c5fd !important;
}
.chat-step.state-running .step-title { color: #93c5fd !important; }
.chat-step.state-running .step-state {
  background: transparent !important;
  color: #93c5fd !important;
  padding: 0 !important;
}

.chat-step.state-done {
  border-color: rgb(16 185 129 / 45%) !important;
  border-left-color: rgb(16 185 129 / 45%) !important;
  color: #6ee7b7 !important;
}
.chat-step.state-done .step-dot { background: #10b981 !important; }
.chat-step.state-done .step-title { color: #6ee7b7 !important; }
.chat-step.state-done .step-state {
  background: transparent !important;
  color: #6ee7b7 !important;
  padding: 0 !important;
}

.chat-step.state-error {
  border-color: rgb(224 108 117 / 55%) !important;
  border-left-color: rgb(224 108 117 / 55%) !important;
  color: #fca5a5 !important;
}
.chat-step.state-error .step-dot { background: #e06c75 !important; }
.chat-step.state-error .step-title { color: #fca5a5 !important; }
.chat-step.state-error .step-state {
  background: transparent !important;
  color: #fca5a5 !important;
  padding: 0 !important;
}

/* 时间戳跟字色同系 */
.chat-step .step-time { color: inherit !important; opacity: 0.6; }


/* ═══════════════════════════════════════════════════════════
   [step-center] 步骤内容聚中
   ═══════════════════════════════════════════════════════════ */
.chat-step {
  display: inline-flex !important;
  justify-content: center !important;
  align-items: center !important;
  gap: 8px !important;
  width: auto !important;
  max-width: 92% !important;
  margin: 4px auto !important;
  padding: 4px 14px !important;
}
.chat-list {
  text-align: center !important;
}
.chat-list > .chat-step {
  display: inline-flex !important;
}
/* 步骤标题不再 flex:1 撑开 */
.chat-step .step-title {
  flex: 0 0 auto !important;
  min-width: 0 !important;
  max-width: 60ch !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  text-align: left !important;
}
.chat-step .step-time,
.chat-step .step-state {
  flex: 0 0 auto !important;
}


/* ═══════════════════════════════════════════════════════════
   [waiting-bubble] AI 等待气泡 + typing 动画
   ═══════════════════════════════════════════════════════════ */
.chat-waiting {
  display: inline-flex !important;
  align-items: center !important;
  gap: 10px !important;
  padding: 6px 16px !important;
  margin: 6px auto !important;
  background: var(--term-chip-bg, rgb(255 255 255 / 4%)) !important;
  border: 1px dashed var(--term-chip-border-2, rgb(255 255 255 / 18%)) !important;
}
.chat-waiting .bubble-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 !important;
  font-size: 11px;
  color: var(--term-text-3, var(--text-3));
}
.chat-waiting .bubble-body {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--term-text-2, var(--text-2));
  font-size: 11px;
}
.waiting-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 12px;
}
.waiting-dots i {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--term-accent, var(--primary));
  opacity: 0.6;
  animation: waiting-bounce 1.2s infinite ease-in-out;
}
.waiting-dots i:nth-child(2) { animation-delay: 0.15s; }
.waiting-dots i:nth-child(3) { animation-delay: 0.30s; }
@keyframes waiting-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-4px); opacity: 1; }
}
.waiting-text {
  font-family: var(--mono, monospace);
}


/* ═══════════════════════════════════════════════════════════
   [user-step-style] 用户提问样式与步骤条一致
   ═══════════════════════════════════════════════════════════ */
.chat-msg-user {
  display: inline-flex !important;
  flex-direction: row !important;
  align-items: center !important;
  gap: 10px !important;
  width: auto !important;
  max-width: 92% !important;
  margin: 4px auto !important;
  padding: 4px 14px !important;
  background: transparent !important;
  border: 1px dashed var(--term-chip-border-2, rgb(255 255 255 / 18%)) !important;
  border-radius: 3px !important;
  font: 11px/1.5 var(--mono, monospace) !important;
  color: var(--term-text-2, var(--text-2)) !important;
}
.chat-msg-user .bubble-head {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  margin: 0 !important;
  padding: 0 !important;
  font-size: 11px !important;
  color: var(--term-text-3, var(--text-3)) !important;
  font-weight: 500 !important;
  letter-spacing: 0 !important;
  flex: 0 0 auto !important;
  white-space: nowrap !important;
}
.chat-msg-user .bubble-body {
  display: inline !important;
  color: var(--term-text-2, var(--text-2)) !important;
  font-size: 11px !important;
  line-height: 1.5 !important;
  word-break: break-word !important;
  max-width: 60ch !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
.chat-msg-user .bubble-body p {
  display: inline !important;
  margin: 0 !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
.chat-msg-user .bubble-body strong {
  color: var(--term-text, var(--text)) !important;
  font-weight: 500 !important;
}


/* ═══════════════════════════════════════════════════════════
   [align-left] 容器居中 + 内容左对齐
   ═══════════════════════════════════════════════════════════ */

/* 步骤条：宽度自适应居中；内容左对齐 */
.chat-step {
  display: inline-flex !important;
  justify-content: flex-start !important;
  align-items: center !important;
  width: auto !important;
  max-width: 92% !important;
  margin: 4px auto !important;
  text-align: left !important;
}
.chat-step .step-title {
  flex: 0 1 auto !important;
  min-width: 0 !important;
  text-align: left !important;
}
.chat-step .step-time,
.chat-step .step-state,
.chat-step .step-icon,
.chat-step .step-dot {
  flex: 0 0 auto !important;
}

/* 用户消息：同款 */
.chat-msg-user {
  display: inline-flex !important;
  flex-direction: row !important;
  justify-content: flex-start !important;
  align-items: center !important;
  width: auto !important;
  max-width: 92% !important;
  margin: 4px auto !important;
  text-align: left !important;
}
.chat-msg-user .bubble-head {
  flex: 0 0 auto !important;
  text-align: left !important;
}
.chat-msg-user .bubble-body {
  flex: 0 1 auto !important;
  text-align: left !important;
}

/* AI 消息：同款 */
.chat-msg-ai {
  display: inline-flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  width: auto !important;
  max-width: min(720px, 92%) !important;
  margin: 4px auto !important;
  text-align: left !important;
}
.chat-msg-ai .bubble-head,
.chat-msg-ai .bubble-body {
  align-self: stretch !important;
  text-align: left !important;
}

/* chat-list 容器保持居中排列、不强制 text-align */
.chat-list {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  text-align: left !important;
}

/* 等待气泡也遵循 */
.chat-waiting {
  display: inline-flex !important;
  justify-content: flex-start !important;
  align-items: center !important;
  width: auto !important;
  margin: 4px auto !important;
  text-align: left !important;
}


/* ═══════════════════════════════════════════════════════════
   [no-shell] 彻底去掉卡片外壳边框
   ═══════════════════════════════════════════════════════════ */
.pane-main > .terminal,
.pane-main > .editor {
  background: transparent !important;
  border: 0 !important;
  border-top: 0 !important;
  border-left: 0 !important;
  border-right: 0 !important;
  border-bottom: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  outline: 0 !important;
  overflow: visible !important;
}
.pane-main > .terminal .term-bar,
.pane-main > .editor .editor-bar {
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}
.pane-main > .terminal .term-bar .dots,
.pane-main > .editor .editor-bar .dots {
  display: none !important;
}


/* ═══════════════════════════════════════════════════════════
   [bg-tune] 背景层次：编辑器/终端统一深色，融入整体
   ═══════════════════════════════════════════════════════════ */
.pane-main {
  background: var(--bg, #181818) !important;
}

/* 终端区：更深的 bg，微边框区分 */
.terminal {
  background: var(--bg, #181818) !important;
}
.terminal .term-body {
  background: var(--bg, #181818) !important;
}

/* 编辑器区：稍亮 surface，形成层次 */
.editor {
  background: var(--surface, #1f1f1f) !important;
}
.editor .editor-body,
.editor .cm-host,
.editor .cm-editor,
.editor .cm-scroller,
.editor .cm-content {
  background: var(--surface, #1f1f1f) !important;
}
.editor .cm-gutters {
  background: var(--surface, #1f1f1f) !important;
  border-right: 1px solid var(--border, #2a2a2a) !important;
}

/* 顶栏淡背景 */
.terminal .term-bar,
.editor .editor-bar {
  background: var(--surface-2, #252526) !important;
}


/* [toolbar-refactor] tpl-bar 撑开 */
.tpl-spacer { flex: 1; min-width: 8px; }
.tpl-bar { gap: 6px; align-items: center; }


/* ═══════════════════════════════════════════════════════════
   [purple-run] tpl-bar 一行 + 运行按钮紫色
   ═══════════════════════════════════════════════════════════ */

/* tpl-bar 一行紧凑 */
.tpl-bar {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 6px 12px !important;
  border-bottom: 1px solid var(--border, #2a2a2a) !important;
  background: var(--surface-2, #252526) !important;
}
.tpl-bar .kbd-hint {
  flex: 0 0 auto !important;
  margin-right: 2px !important;
}
.tpl-bar .tpl-divider {
  width: 1px;
  height: 14px;
  background: var(--border, #2a2a2a);
  flex: 0 0 auto;
  margin: 0 4px;
}
.tpl-bar .tpl-spacer { flex: 1 1 auto !important; min-width: 8px !important; }

/* 运行按钮紫色 */
.primary-btn.takeover {
  background: transparent !important;
  color: #a78bfa !important;
  border: 1px solid #a78bfa !important;
  box-shadow: none !important;
  font-weight: 600 !important;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(167 139 250 / 14%) !important;
  color: #c4b5fd !important;
  border-color: #c4b5fd !important;
  box-shadow: 0 0 0 3px rgb(167 139 250 / 10%) !important;
}

/* 暂停按钮紫红系（与运行按钮一致色系但区分） */
.primary-btn.stop {
  background: transparent !important;
  color: #f0abfc !important;
  border: 1px solid #f0abfc !important;
  box-shadow: none !important;
  font-weight: 600 !important;
}
.primary-btn.stop:hover:not(:disabled) {
  background: rgb(240 171 252 / 14%) !important;
  color: #f5d0fe !important;
  border-color: #f5d0fe !important;
}

/* tpl-chip hover 也走紫色 */
.tpl-chip:hover {
  color: #c4b5fd !important;
  border-color: #a78bfa !important;
  background: rgb(167 139 250 / 8%) !important;
}


/* ═══════════════════════════════════════════════════════════
   [hide-scrollbar] 隐藏所有滚动条
   ═══════════════════════════════════════════════════════════ */
.pane-main *::-webkit-scrollbar,
.terminal ::-webkit-scrollbar,
.editor ::-webkit-scrollbar,
.term-body::-webkit-scrollbar,
.chat-list::-webkit-scrollbar,
.cm-scroller::-webkit-scrollbar,
.cm-host::-webkit-scrollbar,
.pane-side ::-webkit-scrollbar,
.side-tree ::-webkit-scrollbar,
.side-changes ::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  background: transparent !important;
  display: none !important;
}
.pane-main *,
.term-body,
.chat-list,
.cm-scroller,
.cm-host,
.pane-side * {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}

/* ═══════════════════════════════════════════════════════════
   [purple-fix] 运行按钮紫色改偏红
   ═══════════════════════════════════════════════════════════ */
.primary-btn.takeover {
  color: #c084fc !important;
  border-color: #c084fc !important;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(192 132 252 / 14%) !important;
  color: #d8b4fe !important;
  border-color: #d8b4fe !important;
  box-shadow: 0 0 0 3px rgb(192 132 252 / 10%) !important;
}
.primary-btn.stop {
  color: #f0abfc !important;
  border-color: #f0abfc !important;
}
.primary-btn.stop:hover:not(:disabled) {
  background: rgb(240 171 252 / 14%) !important;
  color: #f5d0fe !important;
  border-color: #f5d0fe !important;
}
.tpl-chip:hover {
  color: #c084fc !important;
  border-color: #c084fc !important;
  background: rgb(192 132 252 / 8%) !important;
}


/* [pending-loading] 等待/执行中状态均显示 loading */
.chat-step.state-running .step-dot,
.chat-step.state-pending .step-dot {
  width: 10px !important;
  height: 10px !important;
  background: transparent !important;
  border: 2px solid rgb(255 255 255 / 20%) !important;
  border-top-color: #60a5fa !important;
  border-right-color: #60a5fa !important;
  border-radius: 50% !important;
  animation: step-spin 0.75s linear infinite !important;
  box-shadow: none !important;
}


/* ═══════════════════════════════════════════════════════════
   [ui-polish-v3] UI 精修：统一间距/字号/圆角/对比度
   位置：最后加载，覆盖前面所有补丁块
   ═══════════════════════════════════════════════════════════ */

/* ─── 统一字号 ─── */
.chat-list { font-size: 11.5px !important; }
.chat-step .step-title,
.chat-step .step-time,
.chat-step .step-state,
.chat-step .step-icon { font-size: 11px !important; }
.chat-step .step-state { font-size: 9.5px !important; letter-spacing: 0.3px !important; }
.chat-msg-user .bubble-head,
.chat-msg-user .bubble-body,
.chat-msg-ai .bubble-head,
.chat-msg-ai .bubble-body { font-size: 11.5px !important; }

/* ─── 统一间距 ─── */
.chat-list { gap: 3px !important; padding: 10px 14px 16px !important; }
.chat-step,
.chat-msg-user,
.chat-msg-ai,
.chat-waiting { margin: 3px auto !important; }

/* ─── 统一 padding ─── */
.chat-step,
.chat-msg-user,
.chat-waiting { padding: 3px 12px !important; }
.chat-msg-ai { padding: 6px 12px !important; }

/* ─── 统一圆角（虚线块用小圆角）─── */
.chat-step,
.chat-msg-user,
.chat-msg-ai,
.chat-waiting { border-radius: 4px !important; }

/* ─── 统一边框（虚线 + 同色）─── */
.chat-step,
.chat-msg-user,
.chat-waiting {
  border: 1px dashed var(--term-chip-border-2, rgb(255 255 255 / 22%)) !important;
}
.chat-msg-ai {
  border: 1px solid var(--term-chip-border, rgb(255 255 255 / 10%)) !important;
}

/* ─── 统一图标尺寸 ─── */
.chat-step .step-icon { font-size: 12px !important; }
.chat-step .step-dot { width: 5px !important; height: 5px !important; }

/* ─── 步骤状态色（统一色系）─── */
.chat-step.state-pending {
  border-color: rgb(255 255 255 / 16%) !important;
  color: var(--term-text-3) !important;
}
.chat-step.state-running {
  border-color: rgb(192 132 252 / 55%) !important;
  color: #d8b4fe !important;
}
.chat-step.state-running .step-state {
  background: rgb(192 132 252 / 14%) !important;
  color: #d8b4fe !important;
}
.chat-step.state-done {
  border-color: rgb(74 222 128 / 45%) !important;
  color: #86efac !important;
}
.chat-step.state-done .step-state {
  background: rgb(74 222 128 / 12%) !important;
  color: #86efac !important;
}
.chat-step.state-error {
  border-color: rgb(248 113 113 / 55%) !important;
  color: #fca5a5 !important;
}
.chat-step.state-error .step-state {
  background: rgb(248 113 113 / 14%) !important;
  color: #fca5a5 !important;
}

/* ─── 时间戳弱化 ─── */
.chat-step .step-time,
.chat-msg-user .bubble-head,
.chat-msg-ai .bubble-head { color: var(--term-text-3) !important; opacity: 0.75; }

/* ─── 顶栏统一高度 ─── */
.term-bar,
.editor-bar,
.tpl-bar {
  min-height: 32px !important;
  padding: 0 12px !important;
}

/* ─── 底部工具栏对齐 ─── */
.tpl-bar { padding: 5px 12px !important; }
.tpl-bar .tpl-chip { padding: 2px 10px !important; font-size: 11px !important; }
.tpl-bar .kbd-hint { font-size: 10.5px !important; }
.tpl-bar .ghost-btn { padding: 3px 10px !important; font-size: 11px !important; }
.tpl-bar .primary-btn.head-run { padding: 4px 14px !important; font-size: 11.5px !important; }

/* ─── 编辑器区顶部留白 ─── */
.editor-body { border-top: 1px solid var(--border) !important; }

/* ─── 终端区与编辑器区分隔 ─── */
.terminal + .editor,
.terminal + .split-handle,
.editor { border-top: 1px solid var(--border) !important; }


/* ═══════════════════════════════════════════════════════════
   [step-multiline] 步骤标题多行展示（完整 desc/why/plan）
   ═══════════════════════════════════════════════════════════ */
.chat-step {
  flex-wrap: wrap !important;
  align-items: flex-start !important;
}
.chat-step .step-title {
  white-space: pre-wrap !important;
  overflow: visible !important;
  text-overflow: clip !important;
  max-width: none !important;
  flex: 1 1 auto !important;
  text-align: left !important;
  line-height: 1.5 !important;
}
.chat-step .step-time,
.chat-step .step-state,
.chat-step .step-icon,
.chat-step .step-dot {
  margin-top: 1px !important;
}


/* ═══════════════════════════════════════════════════════════
   [msg-align] 用户右 / AI 左 / 步骤条居中
   ═══════════════════════════════════════════════════════════ */
.chat-msg-user {
  align-self: flex-end !important;
  margin-right: 4px !important;
  margin-left: auto !important;
}
.chat-msg-user .bubble-head,
.chat-msg-user .bubble-body {
  text-align: right !important;
}
.chat-msg-ai {
  align-self: flex-start !important;
  margin-left: 4px !important;
  margin-right: auto !important;
}
.chat-msg-ai .bubble-head,
.chat-msg-ai .bubble-body {
  text-align: left !important;
}
.chat-step,
.chat-waiting {
  align-self: center !important;
}


/* ═══════════════════════════════════════════════════════════
   [center-v2] 全部消息居中 + 内容左对齐（撤销右/左分布）
   色系：中性灰为主 + 单一强调色（紫）+ 语义色仅状态
   ═══════════════════════════════════════════════════════════ */

/* 撤销 [msg-align] 的左右分布 */
.chat-msg-user,
.chat-msg-ai {
  align-self: center !important;
  margin: 4px auto !important;
}
.chat-msg-user .bubble-head,
.chat-msg-user .bubble-body,
.chat-msg-ai .bubble-head,
.chat-msg-ai .bubble-body {
  text-align: left !important;
}

/* 统一容器宽度和居中 */
.chat-msg-user,
.chat-msg-ai,
.chat-step,
.chat-waiting {
  margin-left: auto !important;
  margin-right: auto !important;
}

/* 消息块：中性边框，去掉彩色底 */
.chat-msg-user,
.chat-msg-ai {
  background: var(--term-chip-bg, rgb(255 255 255 / 3%)) !important;
  border: 1px solid var(--border, #333) !important;
  border-radius: 6px !important;
}
.chat-msg-user { border-color: rgb(255 255 255 / 8%) !important; }
.chat-msg-ai   { border-color: rgb(255 255 255 / 8%) !important; }

/* 头行弱化 */
.chat-msg-user .bubble-head,
.chat-msg-ai .bubble-head {
  color: var(--text-3, #7a7a7a) !important;
  font-size: 10.5px !important;
  margin-bottom: 4px !important;
}
.chat-msg-user .bubble-body,
.chat-msg-ai .bubble-body {
  color: var(--text, #e0e0e0) !important;
  font-size: 11.5px !important;
  line-height: 1.55 !important;
}
.chat-msg-ai .bubble-body strong {
  color: #c084fc !important;  /* 单一强调色 */
  font-weight: 600 !important;
}

/* 步骤条：中性底 + 虚线，状态靠左竖线区分 */
.chat-step {
  background: var(--term-chip-bg, rgb(255 255 255 / 3%)) !important;
  border: 1px dashed rgb(255 255 255 / 12%) !important;
  border-left: 2px solid var(--text-3, #7a7a7a) !important;
  border-radius: 4px !important;
  color: var(--text-2, #b0b0b0) !important;
}
.chat-step .step-title { color: var(--text, #e0e0e0) !important; }
.chat-step .step-time  { color: var(--text-3, #7a7a7a) !important; opacity: 0.7; }
.chat-step .step-state {
  background: transparent !important;
  color: var(--text-3, #7a7a7a) !important;
  border: 0 !important;
  padding: 0 !important;
}

/* 状态色：只改左边竖线和 state 文字 */
.chat-step.state-pending {
  border-left-color: rgb(255 255 255 / 20%) !important;
  color: var(--text-3, #7a7a7a) !important;
}
.chat-step.state-running {
  border-left-color: #c084fc !important;
  background: rgb(192 132 252 / 6%) !important;
}
.chat-step.state-running .step-title { color: #d8b4fe !important; }
.chat-step.state-running .step-state { color: #c084fc !important; }
.chat-step.state-running .step-dot {
  border-color: rgb(192 132 252 / 30%) !important;
  border-top-color: #c084fc !important;
  border-right-color: #c084fc !important;
}

.chat-step.state-done {
  border-left-color: #4ade80 !important;
}
.chat-step.state-done .step-state { color: #86efac !important; }
.chat-step.state-done .step-dot   { background: #4ade80 !important; }

.chat-step.state-error {
  border-left-color: #f87171 !important;
  background: rgb(248 113 113 / 6%) !important;
}
.chat-step.state-error .step-title { color: #fca5a5 !important; }
.chat-step.state-error .step-state { color: #f87171 !important; }

/* 等待气泡：与步骤条一致 */
.chat-waiting {
  background: var(--term-chip-bg, rgb(255 255 255 / 3%)) !important;
  border: 1px dashed rgb(255 255 255 / 12%) !important;
  border-left: 2px solid #c084fc !important;
  border-radius: 4px !important;
}
.chat-waiting .waiting-text { color: var(--text-2, #b0b0b0) !important; }
.chat-waiting .waiting-dots i { background: #c084fc !important; }
.chat-waiting .bubble-head,
.chat-waiting .msg-name { color: var(--text-3, #7a7a7a) !important; }

/* chat-list 统一 gap */
.chat-list { gap: 4px !important; }

/* 隐藏旧左右气泡 */
.chat-bubble.bubble-left,
.chat-bubble.bubble-right { display: none !important; }


/* ═══════════════════════════════════════════════════════════
   [center-uniform] 统一宽度居中 + 左对齐
   ═══════════════════════════════════════════════════════════ */

/* chat-list 容器：限制最大宽度居中 */
.chat-list {
  max-width: 780px !important;
  margin: 0 auto !important;
  padding: 12px 16px 20px !important;
  gap: 5px !important;
}

/* 所有消息块：统一宽度占满 chat-list */
.chat-msg-user,
.chat-msg-ai,
.chat-step,
.chat-waiting {
  width: 100% !important;
  max-width: 100% !important;
  align-self: stretch !important;
  margin: 0 !important;
  box-sizing: border-box !important;
  text-align: left !important;
}

/* user 和 ai 消息块：内部对齐由 head+body 控制 */
.chat-msg-user .bubble-head,
.chat-msg-ai .bubble-head {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  justify-content: flex-start !important;
  text-align: left !important;
  padding-bottom: 3px !important;
  margin-bottom: 3px !important;
  border-bottom: 1px solid rgb(255 255 255 / 5%) !important;
}
.chat-msg-user .bubble-body,
.chat-msg-ai .bubble-body {
  text-align: left !important;
  word-break: break-word !important;
}
.chat-msg-ai .bubble-body strong {
  color: #c084fc !important;
  font-weight: 600 !important;
}

/* 步骤条：完整展示 desc/why/plan，多行不折叠 */
.chat-step {
  display: flex !important;
  align-items: flex-start !important;
  gap: 8px !important;
  padding: 6px 12px !important;
  line-height: 1.55 !important;
}
.chat-step .step-title {
  white-space: pre-wrap !important;
  text-align: left !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: visible !important;
  text-overflow: clip !important;
}
.chat-step .step-time,
.chat-step .step-state,
.chat-step .step-icon,
.chat-step .step-dot {
  flex: 0 0 auto !important;
  align-self: flex-start !important;
  margin-top: 4px !important;
}

/* 用户消息：淡灰底 */
.chat-msg-user {
  background: rgb(255 255 255 / 4%) !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  border-radius: 6px !important;
  padding: 6px 12px !important;
}

/* AI 消息：稍深底 */
.chat-msg-ai {
  background: rgb(192 132 252 / 6%) !important;
  border: 1px solid rgb(192 132 252 / 18%) !important;
  border-radius: 6px !important;
  padding: 6px 12px !important;
}


/* ═══════════════════════════════════════════════════════════
   [step-tidy] 步骤条紧凑化：标题加粗 + 次级弱化 + 时间/状态右对齐
   ═══════════════════════════════════════════════════════════ */

/* 布局：图标[dot+icon] + 内容[title flex:1] + 右侧[time+state] */
.chat-step {
  display: flex !important;
  flex-wrap: nowrap !important;
  align-items: flex-start !important;
  gap: 8px !important;
  padding: 6px 12px !important;
  line-height: 1.55 !important;
}

/* step-dot + step-icon 固定左列，紧贴 */
.chat-step .step-dot,
.chat-step .step-icon {
  flex: 0 0 auto !important;
  margin-top: 5px !important;
  line-height: 1 !important;
}

/* 内容区：占满 */
.chat-step .step-title {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  white-space: pre-wrap !important;
  text-align: left !important;
  overflow: visible !important;
  text-overflow: clip !important;
  padding-right: 8px !important;
}

/* 首行 desc：加粗为标题 */
.chat-step .step-title strong {
  display: block !important;
  font-weight: 600 !important;
  font-size: 12px !important;
  color: var(--text, #e0e0e0) !important;
  margin-bottom: 2px !important;
}

/* 时间 + 状态：固定右侧，同基线 */
.chat-step .step-time {
  flex: 0 0 auto !important;
  align-self: flex-start !important;
  margin-top: 4px !important;
  font-size: 10.5px !important;
  color: var(--text-3, #7a7a7a) !important;
  opacity: 0.7 !important;
  padding-right: 6px !important;
}
.chat-step .step-state {
  flex: 0 0 auto !important;
  align-self: flex-start !important;
  margin-top: 3px !important;
  padding: 1px 8px !important;
  border-radius: 10px !important;
  font-size: 10px !important;
  font-weight: 500 !important;
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text-3, #7a7a7a) !important;
}

/* why/plan 行弱化 */
.chat-step.state-done .step-title {
  color: var(--text-2, #b0b0b0) !important;
}
.chat-step.state-done .step-title strong {
  color: var(--text, #e0e0e0) !important;
}

/* 状态徽章色 */
.chat-step.state-running .step-state { background: rgb(192 132 252 / 14%) !important; color: #c084fc !important; }
.chat-step.state-done .step-state { background: rgb(74 222 128 / 12%) !important; color: #86efac !important; }
.chat-step.state-error .step-state { background: rgb(248 113 113 / 14%) !important; color: #fca5a5 !important; }
.chat-step.state-pending .step-state { background: rgb(255 255 255 / 5%) !important; color: var(--text-3, #7a7a7a) !important; }

</style>
<!-- tooltip-audit -->
