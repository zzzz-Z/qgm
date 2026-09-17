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
        <template v-if="isLoopActive">
          <span class="loop-status">
            <span class="loop-spin">⟳</span>
            第 {{ loopRound }}/{{ maxRounds }} 轮 · {{ loopState }}
            · tok {{ (tokenDelta / 1000).toFixed(1) }}k/{{ tokenBudget / 1000 }}k
            · 宽容 {{ toleranceLeft }}
          </span>
          <span class="loop-goal-text" :title="loopGoal">{{ loopGoal.slice(0, 40) }}</span>
          <div class="loop-actions">
            <button v-tooltip="'立即终止当前执行（不等本轮完成）'" class="loop-btn kill" @click="killCurrent">■ 停当前</button>
            <button v-tooltip="'Esc：当前轮跑完即停，不再发下一轮'" class="loop-btn" disabled>⏸ 暂停(Esc)</button>
            <button v-tooltip="'Ctrl+Esc：急停并 git reset 到循环起点'" class="loop-btn rollback" @click="stopAndRollback">⏹ 停止并回滚</button>
          </div>
        </template>
        <template v-else>
          <span class="loop-end-status">
            {{ loopState === 'interrupted' ? '⏹ 已中断' : '■ 已停止' }} · 第 {{ loopRound }}/{{ maxRounds }} 轮
            <em v-if="stopReason">（{{ stopReason }}）</em>
          </span>
          <button class="loop-btn" @click="loopState = 'idle'">收起</button>
        </template>
      </section>
      <!-- 终端 (上方) -->
      <section class="terminal card">
        <header class="bar term-bar">
          <div class="dots">
            <span class="dot d-red" /><span class="dot d-yellow" /><span class="dot d-green" />
          </div>
          <span class="file-badge term-title">终端输出</span>
          <div class="bar-actions">
            <button
              v-tooltip="copied ? '已发送' : `把本次运行的完整上下文（脚本 / 输出 / 变更 / 错误源码）拼成 prompt 复制并发给 AI`"
              class="term-btn copy"
              :class="{ done: copied }"
              :disabled="!hasAnyOutput && !changes.length"
              @click="copyOutput"
            >
              <svg v-if="copied" class="term-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg v-else class="term-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>{{ copied ? '已发送' : `复制并提问` }}</span>
            </button>
            <button
              v-tooltip="asking ? '正在请求 API' : '直接调用 API 询问（不打开网页）'"
              class="term-btn ask"
              :disabled="!result || asking"
              @click="askApi"
            >
              <svg class="term-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>{{ asking ? '请求中…' : '问 API' }}</span>
            </button>
            <button
              v-tooltip="'打开「问 AI」面板（拖文件 + 写问题 → 拼 prompt）'"
              class="term-btn ask-panel"
              @click="emit('open-ask')"
            >
              <svg class="term-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>问 AI</span>
            </button>
          </div>
        </header>

        <div class="term-body">
          <div v-if="running" class="term-empty term-running">
            <template v-if="runningCommand">
              <div class="term-shell-line">
                <span class="term-shell-prompt">$</span>
                <span class="term-shell-cmd">{{ runningCommand.replace(/^!/, '') }}</span>
                <span class="term-shell-wait">{{ waitFrames[waitFrameIdx] }}</span>
              </div>
              <pre v-if="liveStdout" class="term-live-out">{{ liveStdout }}</pre>
              <pre v-if="liveStderr" class="term-live-err">{{ liveStderr }}</pre>
            </template>
            <template v-else>
              <pre v-if="liveStdout" class="term-live-out">{{ liveStdout }}</pre>
              <pre v-if="liveStderr" class="term-live-err">{{ liveStderr }}</pre>
              <div class="run-status-row">
                <span class="run-frame" aria-hidden="true">{{ waitFrames[waitFrameIdx] }}</span>
                <span class="run-label">正在执行<span class="run-ico">▶</span></span>
              </div>
            </template>
          </div>
          <div v-else-if="!result" class="term-empty">
            <div class="empty-icon">
              ⚡
            </div>
            <div class="empty-title">
              准备就绪
            </div>
            <div class="empty-sub">
              按 <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>↵</kbd> 运行
            </div>
          </div>
          <div v-else-if="!showTerminalBody" class="term-empty">
            <div class="empty-icon dim">
              ∅
            </div>
            <div class="empty-title">
              无输出
            </div>
            <div class="empty-sub">
              脚本执行完成，未产生任何输出
            </div>
          </div>
          <section v-else class="term-sections">
            <div class="term-section term-status" :class="result.ok ? 'ok' : 'err'">
              <div class="term-label">
                <span class="prompt-char" :class="{ err: !result.ok }">{{ result.ok ? '✓' : '✗' }}</span>
                <span class="label-text" :class="{ err: !result.ok }">执行状态</span>
                <span class="term-status-detail">
                  {{ result.ok ? '执行成功' : '执行失败' }} · 退出码 {{ result.code }}<template v-if="lastDuration"> · 耗时 {{ lastDuration }}</template><template v-if="changes.length"> · {{ changes.length }} 个文件已变更</template>
                </span>
              </div>
            </div>
            <div v-if="hasStdout" class="term-section">
              <div class="term-label">
                <span class="prompt-char">$</span>
                <span class="label-text">stdout · 标准输出</span>
              </div>
              <pre class="term-content" v-html="renderCode(result.stdout)" />
            </div>
            <div v-if="hasStderr" class="term-section">
              <div class="term-label">
                <span class="prompt-char err">!</span>
                <span class="label-text err">stderr · 错误输出</span>
              </div>
              <pre class="term-content err" v-html="renderCode(result.stderr)" />
            </div>
            <div v-if="result.tools?.length" class="term-section">
              <div class="term-label">
                <span class="prompt-char">#</span>
                <span class="label-text">工具调用 · {{ result.tools.length }} 次</span>
              </div>
              <pre class="term-content">{{ toolsText }}</pre>
            </div>
            <div v-if="result.smoke?.ran" class="term-section">
              <div class="term-label">
                <span class="prompt-char" :class="{ err: !result.smoke.ok }">{{ result.smoke.ok ? 'OK' : 'X' }}</span>
                <span class="label-text" :class="{ err: !result.smoke.ok }">smoke · 页面冒烟</span>
              </div>
              <pre class="term-content" :class="{ err: !result.smoke.ok }">{{ smokeText }}</pre>
            </div>
            <LintBlock v-if="result.lint?.ran" :lint="result.lint" />
            <div v-if="result.test?.ran" class="term-section">
              <div class="term-label">
                <span class="prompt-char" :class="{ err: !result.test.ok }">{{ result.test.ok ? '$' : '!' }}</span>
                <span class="label-text" :class="{ err: !result.test.ok }">test · 单元测试</span>
              </div>
              <pre class="term-content" :class="{ err: !result.test.ok }">{{ testOutput }}</pre>
            </div>
            <div v-if="result.tsc" class="term-section">
              <div class="term-label">
                <span class="prompt-char" :class="{ err: !result.tsc.ok }">{{ result.tsc.ok ? '$' : '!' }}</span>
                <span class="label-text" :class="{ err: !result.tsc.ok }">tsc · 类型检查</span>
              </div>
              <pre class="term-content" :class="{ err: !result.tsc.ok }">{{ tscText }}</pre>
            </div>
            <div v-if="asking || askText || askError" class="term-section">
              <div class="term-label">
                <span class="prompt-char" :class="{ err: !!askError }">{{ askError ? '!' : '?' }}</span>
                <span class="label-text" :class="{ err: !!askError }">ask deepseek · 回复</span>
                <button
                  v-if="askText && !asking"
                  v-tooltip="'把 AI 回复（优先抽第一段代码块）填入脚本编辑器'"
                  class="ghost-btn apply-ask"
                  @click="applyAskToScript"
                >
                  应用到编辑器
                </button>
              </div>
              <pre class="term-content" :class="{ err: !!askError }">{{ askError || askText || '…' }}</pre>
            </div>
          </section>
        </div>
      </section>
      <!-- 编辑器 (下方) -->
      <section class="editor card" :class="{ 'is-running': running }">
        <header class="bar editor-bar">
          <div class="dots">
            <span class="dot d-red" /><span class="dot d-yellow" /><span class="dot d-green" />
          </div>
          <span class="file-badge">script.cjs</span>
          <div class="bar-actions">
            <span v-tooltip="'运行 / 保存'" class="kbd-hint">
              <kbd>⌘</kbd><span class="slash">/</span><kbd>Ctrl</kbd><span class="plus">+</span><kbd>↵</kbd>
            </span>
            <button v-tooltip="'清空编辑器内容（不落盘）'" class="ghost-btn" :disabled="running || !script" @click="script = ''">
              清空
            </button>
            <button
              v-if="pendingCount > 0"
              v-tooltip="`收件箱有 ${pendingCount} 条待取用脚本，点击覆盖当前编辑器`"
              class="ghost-btn inbox-badge"
              :disabled="running"
              @click="takeLatestFromInbox"
            >
              📥 {{ pendingCount }}
            </button>
            <button
              v-if="!running"
              v-tooltip="script.trim().startsWith('#!') ? '运行脚本（Ctrl\/Cmd + ↵）' : script.trim().startsWith('!') ? '运行 shell 命令（以 ! 开头）' : '把编辑器内容作为问题发给 AI（Ctrl\/Cmd + ↵）'"
              class="primary-btn run head-run"
              :disabled="!script.trim()"
              @click="runSmart"
            >
              <span class="ico">▶</span><span>运行</span><kbd class="btn-kbd">{{ runKbd }}</kbd>
            </button>
            <button
              v-if="!running && !isLoopActive"
              v-tooltip="'先运行当前脚本；成功后进入自动化接管：AI 回传脚本自动执行'"
              class="primary-btn takeover head-run"
              :disabled="!script.trim()"
              @click="runAndTakeover"
            >
              <span class="ico">⟳</span><span>运行并接管</span>
            </button>
            <button v-else v-tooltip="'停止当前运行'" class="primary-btn stop head-run" @click="stop">
              <span class="ico">■</span><span>停止</span>
            </button>
            <!-- status-moved -->
            <span v-if="statusText" class="status head-status" :class="statusClass">
              <span class="s-dot" />{{ statusText }}<template v-if="result"> · exit {{ result.code }}</template>
            </span>
            <span v-if="lastDuration" class="meta head-meta">{{ lastDuration }}</span>
          </div>
        </header>

        <div class="tpl-bar">
          <span class="tpl-label">模板</span>
          <button
            v-for="t in TEMPLATES"
            :key="t.id"
            v-tooltip="`模板：${t.label} — ${t.title}`"
            class="tpl-chip"
            @click="applyTemplate(t.code)"
          >
            {{ t.label }}
          </button>
        </div>
        <div class="editor-body">
          <div
            ref="cmHost"
            class="cm-host"
            tabindex="0"
            @keydown.ctrl.enter.prevent="runSmart"
            @keydown.meta.enter.prevent="runSmart"
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
v-if="changes.length"
      v-tooltip="'拖拽调整右侧面板宽度'"
      class="side-resize-handle"
      :class="{ active: resizingSide }"
      @pointerdown="onSideDown"
    />

    <!-- 右侧：变更列表 & Diff -->
    <!-- SIDE_VIF_CHANGES -->
    <aside v-if="changes.length" class="pane-side" :style="{ width: `${sideWidth}px` }">
      <!-- 空占位：无变更且未运行时，位于终端上方 -->
      <div v-if="!result && !changes.length" class="side-empty">
        <div class="side-empty-icon">
          📋
        </div>
        <div class="side-empty-text">
          运行后显示变更
        </div>
      </div>
      <!-- 变更列表 -->
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
const emit = defineEmits<{ 'open-ask': [] }>()
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRunner } from '../composables/useRunner'
import { useScriptInbox } from '../composables/useScriptInbox'
import { currentLoopContext, useAutoLoop } from '../composables/useAutoLoop'
import FileList from './FileList.vue'
import DiffViewer from './DiffViewer.vue'
import LintBlock from './LintBlock.vue'
import { copyAndFill } from '../composables/useDeepseekUrl'
import { useCodeCleaner } from '../composables/useCodeCleaner'
import { buildErrorContext, enforceBudget, parseErrorLocations } from '../utils/contextBuilder'
import { useToast } from '../composables/useToast'
import { useTraceLog } from '../composables/useTraceLog'
import { useSessionManager } from '../composables/useSessionManager'
import type { Change } from '../types'
import { basicSetup } from 'codemirror'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { EditorState, Prec, Compartment } from '@codemirror/state'
import { javascript as cmJavascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import * as hljsNs from 'highlight.js/lib/core'
const hljs: any = (hljsNs as any).default ?? hljsNs
import * as javascriptNs from 'highlight.js/lib/languages/javascript'
const javascript: any = (javascriptNs as any).default ?? javascriptNs
import * as typescriptNs from 'highlight.js/lib/languages/typescript'
const typescript: any = (typescriptNs as any).default ?? typescriptNs

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)

const { script, running, result, changes, rolling, busyAll, persistWarning, baselineRunId, liveStdout, liveStderr, run, stop, rollback, rollbackAll, save } = useRunner()
const { inbox, consume: consumeInbox } = useScriptInbox()
/** 当前 inbox 待取用条数（仅展示用，避免在模板里直接 inbox.value.length 触发响应式开销） */
const pendingCount = computed(() => inbox.value.length)
/** 取最新一条入队脚本，覆盖当前编辑器内容 */
function takeLatestFromInbox() {
  const item = consumeInbox()
  if (!item) return
  script.value = item.code
  toast(`已取用 · ${item.lang} · ${item.desc || '无说明'}`, 'success', 3000)
}

// —— 自动化循环（P2 useAutoLoop）——
const {
  loopState, loopRound, loopGoal, stopReason, toleranceLeft,
  tokenDelta, maxRounds, tokenBudget, isLoopActive,
  startTakeover, killCurrent, stopAndRollback,
} = useAutoLoop()
async function runAndTakeover() {
  if (!script.value.trim()) { toast('脚本为空', 'warn'); return }
  runningCommand.value = ''
  await run()
  const r = result.value
  if (!r || !r.ok) {
    toast('脚本运行失败，未进入接管', 'error', 4000)
    return
  }
  await startTakeover()
}

const mainRef = ref<HTMLElement | null>(null)

const copied = ref(false)
const asking = ref(false)
const askText = ref('')
const askError = ref('')
const fileDragging = ref(false)
const fileSuccess = ref(false)
const statusText = ref('')
const statusClass = ref('')

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
const waitFrames = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
  '⣾',
  '⣽',
  '⣻',
  '⢿',
  '⡿',
  '⣟',
  '⣯',
  '⣷',
  '◐',
  '◓',
  '◑',
  '◒',
  '|',
  '/',
  '-',
  '\\',
]
const waitFrameIdx = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let runStartAt = 0

// Diff 预览
const previewFile = ref<string | null>(null)
const previewBefore = ref<string | null>(null)
const previewAfter = ref<string>('')

const runKbd = computed(() => /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘↵' : 'Ctrl↵')
const hasStdout = computed(() => !!result.value?.stdout?.trim())
const hasStderr = computed(() => !!result.value?.stderr?.trim())
const showTerminalBody = computed(() => hasStdout.value || hasStderr.value || result.value?.lint?.ran || result.value?.test?.ran || (result.value?.tools?.length || 0) > 0 || !!result.value?.smoke?.ran || !!result.value?.tsc || asking.value || !!askText.value || !!askError.value)
const hasAnyOutput = computed(() => hasStdout.value || hasStderr.value || (result.value?.tools?.length || 0) > 0 || !!result.value?.smoke?.ran || !!result.value?.tsc || asking.value || !!askText.value || !!askError.value)
const testOutput = computed(() => { const t = result.value?.test; return t ? (t.stdout || t.stderr || '(无)') : '' })
const tscText = computed(() => {
  const t = result.value?.tsc
  if (!t) return ''
  return (t.stdout || '') + (t.stderr ? `\n${t.stderr}` : '')
})
const smokeText = computed(() => {
  const s = result.value?.smoke
  if (!s) return ''
  if (s.error) return `启动失败: ${s.error}`
  const lines: string[] = []
  for (const p of s.pages) {
    lines.push(`${p.ok ? '✓' : '✗'} ${p.url}`)
    for (const e of p.errors) lines.push(`    ${e}`)
  }
  return lines.join('\n')
})
const toolsText = computed(() => {
  const t = result.value?.tools
  if (!t || !t.length) return ''
  return t.map((x) => {
    const label = x.op === 'write' ? 'writeFile' : 'deleteFile'
    return `${label} ${x.path} (${x.size}B)`
  }).join('\n')
})

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
      if (cm.missing.length) p.push(`⚠ 声明但未改动：${cm.missing.join(', ')}`)
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
const { toast } = useToast()
const { addTrace } = useTraceLog()
const { trackMessage } = useSessionManager()

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
function onGlobalKey(e: KeyboardEvent) {
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault()
    runSmart()
  }
}
function runSmart() {
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
  statusText.value = '✅ 已发送'
  statusClass.value = 'ok'
  script.value = ''
  setTimeout(() => { statusText.value = ''; statusClass.value = '' }, 1500)
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
      body: JSON.stringify({ cmd }),
    })
    if (!res.ok || !res.body) {
      let detail = ''
      try { detail = await res.text() } catch { }
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder('utf8')
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const j = JSON.parse(line)
          if (j.stream === 'stdout') liveStdout.value += j.data
          else if (j.stream === 'stderr') liveStderr.value += j.data
          else if (j.stream === 'exit') exitCode = j.code
        } catch { }
      }
    }
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
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
    if (r === 'failed') toast('发送失败，已复制到剪贴板', 'warn', 4000)
  } catch (e) { console.error(e) }
}

// stderr 里把 file.ts:12:34 变成可点击（点击复制路径）
// ponytail: 不做跨文件跳转（无 Monaco，行号可能失准），只复制路径。
async function askApi() {
  if (!result.value || asking.value) return
  asking.value = true
  askText.value = ''
  askError.value = ''
  try {
    const prompt = await buildAiPrompt()
    if (!prompt) return
    const res = await fetch('/__ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { }
      askError.value = `HTTP ${res.status}${detail ? `：${detail.slice(0, 300)}` : ''}`
      return
    }
    const reader = res.body!.getReader()
    const dec = new TextDecoder('utf8')
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          if (j.delta) askText.value += j.delta
          if (j.error) askError.value = String(j.error)
        } catch { }
      }
    }
  } catch (e) {
    askError.value = String(e)
  } finally {
    if (askText.value) trackMessage('assistant', askText.value)
    asking.value = false
  }
}

function applyAskToScript() {
  const text = askText.value.trim()
  if (!text) return
  const m = text.match(/```[a-z]*\n([\s\S]*?)```/i)
  script.value = m ? m[1].trim() : text
  statusText.value = '✓ 已应用到编辑器'
  statusClass.value = 'ok'
  setTimeout(() => { statusText.value = ''; statusClass.value = '' }, 1500)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[ch] as string))
}

function renderCode(text: string): string {
  if (!text) return ''
  try {
    return hljs.highlightAuto(text, ['javascript', 'typescript']).value
  } catch {
    return escapeHtml(text)
  }
}

async function saveDraft() {
  if (!script.value) return
  try {
    const res = await fetch('/__ai/script/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: script.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    statusText.value = '✓ 已保存草稿'
    statusClass.value = 'ok'
    setTimeout(() => { statusText.value = ''; statusClass.value = '' }, 1500)
  } catch (e) {
    statusText.value = '✗ 保存失败'
    statusClass.value = 'err'
    setTimeout(() => { statusText.value = ''; statusClass.value = '' }, 2000)
  }
}

// ---------- 分栏拖拽 ----------

// ---------- 右侧面板宽度拖拽 ----------
const cmHost = ref<HTMLDivElement | null>(null)
let cmView: EditorView | null = null
const editableComp = new Compartment()
function createEditor() {
  if (!cmHost.value || cmView) return
  const state = EditorState.create({
    doc: script.value,
    extensions: [
      basicSetup,
      cmJavascript(),
      oneDark,
      /* editor-no-h-scroll */
      EditorView.lineWrapping,
      editableComp.of(EditorView.editable.of(!isLoopActive.value)),
      placeholder('写脚本，或 !命令 走 shell · @问题 发给 AI · ⌘/Ctrl + ↵ 运行'),
      EditorView.theme({
        '&': { height: '100%', fontSize: '12px' },
        '.cm-scroller': { fontFamily: 'var(--mono, monospace)', lineHeight: '20px', overflowX: 'hidden', overflowY: 'auto' },
        '.cm-content': { caretColor: '#528bff' },
        '&.cm-focused': { outline: 'none' },
      }),
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Ctrl-Enter', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Cmd-Enter', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Alt-r', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Alt-ArrowUp', preventDefault: true, run: () => { cmdHistoryPrev(); return true } },
        { key: 'Alt-ArrowDown', preventDefault: true, run: () => { cmdHistoryNext(); return true } },
        { key: 'Mod-s', preventDefault: true, run: () => { saveDraft(); return true } },
        { key: 'Enter', run: () => {
          const text = script.value.trim()
          if (text.startsWith('!') && !text.includes('\n')) {
            runSmart()
            return true
          }
          return false
        } },
      ])),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) script.value = u.state.doc.toString()
      }),
    ],
  })
  cmView = new EditorView({ state, parent: cmHost.value })
}
watch(isLoopActive, (v) => {
  if (!cmView) return
  cmView.dispatch({ effects: editableComp.reconfigure(EditorView.editable.of(!v)) })
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
  (len) => {
    if (len === 0) {
      previewFile.value = null
      previewBefore.value = null
      previewAfter.value = ''
    }
  },
)

watch(previewFile, (v) => {
  if (resizingSide.value) return
  sideWidth.value = v
    ? Math.max(sideWidthBase.value, SIDE_WIDTH_DIFF)
    : sideWidthBase.value
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

  createEditor()
  window.addEventListener('keydown', onGlobalKey) })

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onSideMove)
  window.removeEventListener('pointerup', onSideUp)
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }

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
      waitFrameIdx.value = (waitFrameIdx.value + 1) % waitFrames.length
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
    } else {
      statusText.value = result.value.ok ? '✅ 成功' : '❌ 失败'
      statusClass.value = result.value.ok ? 'ok' : 'err'
      // autoAskOnFailure: 失败时延迟 3s 再自动复制并发给 AI（主动停止除外）
      const FAIL_ASK_DELAY_MS = 3000
      if (!result.value.ok && result.value.error !== '已取消') {
        setTimeout(() => { void copyOutput() }, FAIL_ASK_DELAY_MS)
      }
      // 清空编辑器（成功 / 失败均清空）
      script.value = ''
      const r = result.value
      // 兼容旧脚本只写 // @desc；新脚本可能 // 或 #，从 result.value.scriptDesc/scriptWhy 拿（server 已解析）
      const descMatch = script.value.match(/^\s*(?:\/\/|#)\s*@desc\s*:\s*(.+)$/m)
      const desc = r.scriptDesc || (descMatch ? descMatch[1].trim() : '')
      const whyMatch = script.value.match(/^\s*(?:\/\/|#)\s*@why\s*:\s*(.+)$/m)
      const why = r.scriptWhy || (whyMatch ? whyMatch[1].trim() : '')
      const lang: 'cjs' | 'bash' = /^\s*#\s*(@desc|@why)/m.test(script.value) ? 'bash' : 'cjs'
      // 计算 hash（与油猴 / useScriptInbox 一致：FNV-1a 8 hex）
      let hash = ''
      try {
        let h = 0x811c9dc5
        for (let i = 0; i < script.value.length; i++) {
          h = Math.imul(h ^ script.value.charCodeAt(i), 0x1000193) >>> 0
        }
        hash = (h >>> 0).toString(16).padStart(8, '0')
      } catch { /* ignore */ }
      addTrace({
        kind: 'run',
        summary: desc
          ? `${desc} · ${r.ok ? '成功' : '失败'} exit ${r.code} · ${changes.value.length} 文件变更`
          : `运行脚本 · ${r.ok ? '成功' : '失败'} exit ${r.code} · ${changes.value.length} 文件变更`,
        payload: {
          script: script.value.slice(0, 4000),
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

/* ============ Card ============ */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
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
  font-size: 11px;
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
  color: #059669;
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
}
.loc-link:hover {
  color: #059669;
  background: rgb(5 150 105 / 10%);
}
.meta-running {
  color: #059669;
  font-variant-numeric: tabular-nums;
}
.git-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
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
  font-size: 11px;
  color: var(--success, #059669);
  margin-right: 8px;
  cursor: help;
}
.persist-warning {
  font-size: 11px;
  color: var(--danger);
  margin-right: 8px;
  cursor: help;
}
.req-err-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
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
  border-radius: 6px;
  font-size: 12px;
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
  font-size: 10px;
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
  border-radius: 3px;
  font: 10px/1.5 var(--mono, monospace);
  color: rgb(255 255 255 / 92%);
  vertical-align: middle;
}
.primary-btn.head-run {
  padding: 5px 14px;
  font-size: 12px;
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
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  font-size: 12px;
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
  color: #059669;
  border-color: rgb(5 150 105 / 50%);
  background: rgb(5 150 105 / 12%);
}

.term-btn.ask {
  color: #a0a8b2;
  border-color: rgb(255 255 255 / 14%);
}
.term-btn.ask:hover:not(:disabled) {
  background: rgb(255 255 255 / 8%);
  border-color: rgb(255 255 255 / 26%);
  color: #e0e5eb;
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

.ghost-btn.apply-ask {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--primary, #2563eb);
  border: 1px solid var(--border-2);
  border-radius: 4px;
}
.ghost-btn.apply-ask:hover:not(:disabled) {
  background: var(--primary-bg, #eaf2ff);
}

.ghost-btn {
  padding: 4px 10px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--text-2);
  font-size: 12px;
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
  font-size: 11px;
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
  border-radius: 4px;
  font: 10px/1 var(--mono, monospace);
  color: var(--text-2);
  text-align: center;
}
.kbd-hint .slash,
.kbd-hint .plus {
  color: var(--text-3);
  font-size: 10px;
}

/* ============ 状态 ============ */
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
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
  border-radius: 10px;
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
  border-radius: 2px;
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
  border-radius: 10px;
  font: 11px/1.4 var(--mono, monospace);
  font-weight: 600;
}
.exit-badge.ok {
  background: rgb(46 160 67 / 18%);
  color: #059669;
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
  padding: 8px 0;
  background: #1e1e1e;
  color: #d4d4d4;
}
.term-body::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.term-body::-webkit-scrollbar-thumb {
  background: rgb(255 255 255 / 12%);
  border-radius: 4px;
}
.term-body::-webkit-scrollbar-thumb:hover {
  background: rgb(255 255 255 / 20%);
}

/* 空状态 */
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
  font-size: 11px;
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
  border-radius: 3px;
  font: 10px/1 var(--mono, monospace);
  color: #d4d4d4;
}
.term-running.term-empty {
  align-items: flex-start;
  justify-content: flex-start;
  text-align: left;
  padding: 14px 16px;
}
.term-running .empty-title {
  color: #059669;
}
.term-running .empty-sub {
  color: #059669;
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
  color: #059669;
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
  color: #059669;
  font-size: 14px;
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
  border-radius: 6px;
}
.term-live-err {
  color: #f48771;
  background: rgb(248 81 73 / 8%);
  max-height: 360px;
  overflow: auto;
}
.run-ico {
  display: inline-block;
  margin-left: 4px;
  font-size: 10px;
  animation: run-pulse 1s ease-in-out infinite;
}
.run-status-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  align-self: flex-start;
}
.run-frame {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  font: 14px/1 var(--mono, monospace);
  color: #059669;
  text-shadow: 0 0 8px rgb(5 150 105 / 55%);
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.run-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: #059669;
  text-shadow: 0 0 8px rgb(5 150 105 / 35%);
}
.run-elapsed {
  margin-top: 6px;
  font-size: 11px;
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
  color: #059669;
}
.term-status.err .term-status-detail {
  color: #f48771;
}
.term-status-detail {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  color: #9d9d9d;
  font-variant-numeric: tabular-nums;
  user-select: text;
}
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
  color: #059669;
  font-size: 12px;
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

.term-content {
  margin: 0;
  padding: 0 16px;
  font: 12px/1.65 var(--mono, monospace);
  /* no-h-scroll */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  color: #d4d4d4;
}
.term-content.err {
  color: #f48771;
  max-height: 400px;
  /* no-h-scroll */
  overflow-x: hidden;
  overflow-y: auto;
}
.term-content :deep(.hljs-keyword),
.term-content :deep(.hljs-literal) {
  color: #569cd6;
}
.term-content :deep(.hljs-string) {
  color: #ce9178;
}
.term-content :deep(.hljs-number) {
  color: #b5cea8;
}
.term-content :deep(.hljs-comment) {
  color: #6a9955;
  font-style: italic;
}
.term-content :deep(.hljs-function),
.term-content :deep(.hljs-title) {
  color: #dcdcaa;
}
.term-content :deep(.hljs-variable),
.term-content :deep(.hljs-params),
.term-content :deep(.hljs-attr) {
  color: #9cdcfe;
}
.term-content :deep(.hljs-built_in),
.term-content :deep(.hljs-type) {
  color: #4ec9b0;
}
.term-content .hl-ok {
  color: #059669;
}
.term-content .hl-err {
  color: #f48771;
}
.term-content .hl-warn {
  color: #fbbf24;
}
.term-content .hl-info {
  color: #60a5fa;
}
.term-content::-webkit-scrollbar {
  width: 8px;
}
.term-content::-webkit-scrollbar-thumb {
  background: rgb(255 255 255 / 12%);
  border-radius: 4px;
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
  border-radius: 10px;
  color: var(--text-3);
}
.side-empty-icon {
  font-size: 28px;
  opacity: 0.5;
}
.side-empty-text {
  font-size: 12px;
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
  border-radius: 10px;
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
  border-radius: 10px;
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
  font-size: 13px;
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
  .pane-side {
    width: 100% !important;
    height: 300px;
    flex-shrink: 0;
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
    font-size: 11px;
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
  font-size: 11px;
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
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: 0.12s;
  font-family: inherit;
  flex-shrink: 0;
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
  background: rgb(15 30 60 / 38%);
  backdrop-filter: blur(2px);
  animation: overlay-in 0.15s ease-out;
}
.diff-overlay-panel {
  position: relative;
  width: min(1100px, 100%);
  max-height: min(720px, 100%);
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgb(15 30 60 / 26%);
  border-radius: 10px;
  overflow: hidden;
}
.diff-overlay-panel :deep(.diff-viewer) {
  flex: 1;
  min-height: 0;
  border-radius: 10px;
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
  border-radius: 6px;
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
  flex-wrap: nowrap;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 6px 12px;
  margin-bottom: 6px;
  min-height: 0;
  max-height: 44px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-left-style: solid;
  border-left-color: var(--border-2);
  border-radius: 8px;
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
.loop-goal-input {
  flex: 1 1 320px;
  min-width: 200px;
  padding: 6px 10px;
  border: 1px solid var(--border-color, #dcdfe6);
  border-radius: 6px;
  font-size: 12px;
  background: var(--input-bg, #fff);
  color: inherit;
}
.loop-status { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.loop-goal-text {
  flex: 1 1 160px;
  font-size: 12px;
  opacity: .7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.loop-actions { display: flex; gap: 6px; }
.loop-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-color, #dcdfe6);
  border-radius: 6px;
  background: var(--btn-bg, #fff);
  font-size: 12px;
  cursor: pointer;
  color: inherit;
  white-space: nowrap;
}
.loop-btn:hover:not(:disabled) { border-color: #409eff; }
.loop-btn:disabled { opacity: .5; cursor: default; }
.loop-btn.primary { background: #409eff; border-color: #409eff; color: #fff; }
.loop-btn.kill { border-color: #f56c6c; color: #f56c6c; }
.loop-btn.rollback { border-color: #f56c6c; color: #f56c6c; }
.loop-end-status { flex: 1; font-size: 12px; }
.loop-end-status em { opacity: .65; font-style: normal; }
.loop-spin { display: inline-block; animation: loop-spin 1.6s linear infinite; }
@keyframes loop-spin { to { transform: rotate(360deg); } }
.inbox-badge { color: #409eff; border-color: #409eff; }
</style>
<!-- tooltip-audit -->
