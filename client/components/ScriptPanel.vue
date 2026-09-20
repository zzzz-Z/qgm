<template>
  <div ref="paneRef" class="bg-\[var\(--bg\)\] flex pane h-screen overflow-hidden" :class="{ 'is-resizing-side': resizingSide }">
    <!-- 左侧主区域 -->
    <div
      ref="mainRef" class="flex flex-col pane-main flex-1 min-w-0 overflow-hidden" :class="{ 'is-dragging': fileDragging, 'is-success': fileSuccess }"
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
      <section class="terminal">
        <!-- [flow-timeline] 全流程时间线 -->
        <div class="flow-timeline">
          <div class="script-header">
            <span v-if="scriptMeta.desc" class="sm-item"><b>desc</b><em>{{ scriptMeta.desc }}</em></span>
            <span v-if="scriptMeta.why" class="sm-item"><b>why</b><em>{{ scriptMeta.why }}</em></span>
            <span v-if="scriptMeta.plan" class="sm-item"><b>plan</b><em>{{ scriptMeta.plan }}</em></span>
          </div>

          <div ref="termBodyRef" class="term-body">
            <!-- [terminal-status] 循环状态条 -->
            <div v-if="isLoopActive || (loopState && loopState !== 'idle')" class="ts-bar">
              <span class="ts-chip" :class="{ 'is-active': isLoopActive }"><b>状态</b>{{ loopState }}</span>
              <span class="ts-chip"><b>轮次</b>{{ loopRound }}/{{ maxRounds }}</span>
              <span v-if="loopGoal" class="ts-chip"><b>目标</b>{{ loopGoal.slice(0, 40) }}</span>
              <span v-if="stage" class="ts-chip"><b>阶段</b>{{ stage }}</span>
              <span class="ts-chip"><b>token</b>{{ (latestTokens / 1000).toFixed(1) }}k（Δ{{ (tokenDelta
                / 1000).toFixed(1)
              }}k）</span>
              <span v-if="toleranceLeft !== undefined" class="ts-chip"><b>宽容</b>{{ toleranceLeft }}</span>
              <span v-if="stopReason" class="ts-chip"><b>结束</b>{{ stopReason }}</span>
            </div>
          </div>
          <div class="chat-list">
            <!-- [live-typewriter] 当前脚本实时输出（打字机） -->
            <div v-if="running || twStdout || twStderr" class="live-stream">
              <pre v-if="twStdout" class="live-pre"><span v-for="(l, i) in twLines" :key="i" :class="lineClass(l)">{{ l }}{{ i < twLines.length - 1 ? '\n' : '' }}</span><span v-if="running" class="live-cursor" /></pre>
              <pre v-if="twStderr" class="live-pre err"><span v-for="(l, i) in twErrLines" :key="i" :class="lineClass(l)">{{ l }}{{ i < twErrLines.length - 1 ? '\n' : '' }}</span><span v-if="running" class="live-cursor" /></pre>
            </div>

            <div v-if="!chatItems.length" class="tree-empty">
              <div class="empty-title">
                还没有会话记录
              </div>
              <div class="empty-sub">
                点击「运行」开始自动化循环
              </div>
              <div class="empty-cards">
                <button
                  v-for="t in TEMPLATES" :key="t.id" v-tooltip="t.title" class="empty-card"
                  @click="applyTemplate(t.code)"
                >
                  <span class="empty-card-ico">{{ t.id === 'bash' ? '🖥' : t.id === 'ask' ? '💬' : '📝' }}</span>
                  <span class="empty-card-title">{{ t.label }}</span>
                  <span class="empty-card-desc">{{ t.title }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
      <!-- 编辑器 (下方) -->
      <section class="editor card" :class="{ 'is-running': running, 'is-dragging': fileDragging }">
        <div class="tpl-bar">
          <button
            v-for="t in TEMPLATES" :key="t.id" v-tooltip="`模板：${t.label} — ${t.title}`" class="tpl-chip"
            @click="applyTemplate(t.code)"
          >
            {{ t.label }}
          </button>
          <div class="tpl-spacer" />
          <button
            ref="skillTriggerRef"
            v-tooltip="'选择要注入 AI 提示词的规则（skills）'" aria-label="选择要注入 AI 提示词的规则（skills）" data-skill-trigger class="skill-trigger"
            @mousedown.prevent="toggleSkillMenu"
          >
            <span class="skill-trigger-label">📋 规则</span>
            <span class="skill-badge" :class="{ 'skill-badge-empty': !selectedSkillNames.length }">{{
              selectedSkillNames.length }}</span>
            <span class="skill-count" :title="`可用规则共 ${skillsList.length} 个`">/{{ skillsList.length }}</span>
          </button>
          <Teleport to="body">
            <div v-if="skillMenuOpen" data-skill-menu class="skill-menu-fixed" :style="skillMenuPos" @mousedown.stop>
              <div class="skill-menu-head">
                共 {{ skillsList.length }} 个可用规则
              </div>
              <div v-if="skillsLoading" class="skill-row skill-loading">
                加载中…
              </div>
              <div v-else-if="!skillsList.length" class="skill-row skill-empty">
                无可用规则
              </div>
              <label v-for="sk in skillsList" :key="sk.name" class="skill-row">
                <input type="checkbox" :checked="selectedSkillNames.includes(sk.name)" @change="toggleSkill(sk.name)">
                <span class="skill-name">{{ sk.name }}</span>
                <span class="skill-src" :class="`src-${sk.source || 'base'}`">{{ sk.source === 'user' ? '用户'
                  : (sk.source
                    === 'agents' ? '全局' : '系统') }}</span>
              </label>
              <div class="skill-hint">
                选择后，点「运行」发送给 AI 的 prompt 会带上这些规则
              </div>
            </div>
          </Teleport>
          <button
            v-tooltip="'清空编辑器内容 + 全部附件'"
            aria-label="清空编辑器内容 + 全部附件" class="ghost-btn"
            :disabled="running || (!script && !attachedFiles.length)" @click="clearAll"
          >
            <svg
              class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
            <span>清空</span>
          </button>
          <button
            v-tooltip="'把全项目文件路径（@path）插入到编辑器'"
            aria-label="把全项目文件路径（@path）插入到编辑器" class="primary-btn ghost head-run" :disabled="addingAllToEditor"
            @click="onAddAllClick"
          >
            <svg
              class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            <span>{{ addingAllToEditor ? '添加中…' : '添加全部' }}</span>
          </button>
          <button
            v-if="running || isLoopActive || autoTakeoverEnabled"
            v-tooltip="'暂停：停止当前执行并关闭自动接管'" aria-label="暂停：停止当前执行并关闭自动接管"
            class="primary-btn stop head-run" @click="pauseAll"
          >
            <svg
              class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <line x1="9" y1="4" x2="9" y2="20" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
            <span>{{ autoTakeoverCountdown > 0 ? `暂停 · ${autoTakeoverCountdown}s` : '暂停' }}</span>
          </button>
          <button
            v-else
            v-tooltip="'运行：执行脚本 → 结果自动发 AI → AI 回复后自动执行下一轮'" aria-label="运行：执行脚本 → 结果自动发 AI → AI 回复后自动执行下一轮" class="primary-btn takeover head-run"
            @click="toggleAutoTakeover"
          >
            <svg
              class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg><span>运行</span>
          </button>
        </div>
        <div v-if="attachedFiles.length" class="attach-bar">
          <div v-for="f in attachedFiles" :key="f.id" class="attach-tag" :class="`kind-${f.kind}`">
            <img v-if="f.kind === 'image'" :src="f.content" :alt="f.name" class="attach-img">
            <span v-else-if="f.kind === 'folder'" class="attach-ico">📁</span>
            <span v-else class="attach-ico">📄</span>
            <span class="attach-name" :title="f.name">{{ f.name }}</span>
            <span class="attach-size">{{ f.kind === 'folder' ? `${f.size} 文件` : fmtSize(f.size) }}</span>
            <button v-tooltip="'移除'" aria-label="移除" class="attach-del" @click="removeAttach(f.id)">
              ×
            </button>
          </div>
        </div>
        <!-- [P2-2b2] draft slots toolbar -->
        <div class="draft-toolbar">
          <select
            v-tooltip="'切换草稿槽位'"
            class="draft-select"
            :value="activeDraftId"
            @change="switchDraftSlot(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="s in draftSlots" :key="s.id" :value="s.id">
              {{ s.name }}<template v-if="s.text">
                ({{ s.text.length }})
              </template>
            </option>
          </select>
          <button
            v-tooltip="'新建草稿槽位'"
            aria-label="新建草稿槽位"
            class="ghost-btn draft-btn"
            type="button"
            @click="newDraftSlot"
          >
            ＋
          </button>
          <button
            v-tooltip="'删除当前草稿槽位'"
            aria-label="删除当前草稿槽位"
            class="ghost-btn draft-btn"
            type="button"
            :disabled="activeDraftId === 'default'"
            @click="deleteDraftSlot(activeDraftId)"
          >
            ×
          </button>
        </div>
        <div class="editor-body" @paste.capture="onEditorPaste" @dragover.prevent @drop="onDesktopDrop">
          <!-- @FILE_PICKER_V1 -->
          <div v-if="pickerOpen" ref="pickerRef" class="file-picker" :style="pickerStyle">
            <input
              ref="pickerInputRef" v-model="pickerQuery" class="fp-input" placeholder="搜索文件，Enter 选择，Esc 取消"
              @keydown.down.prevent="pickerMove(1)" @keydown.up.prevent="pickerMove(-1)"
              @keydown.enter.prevent="pickerConfirm" @keydown.esc.prevent="pickerClose"
            >
            <div class="fp-list">
              <div
                v-for="(f, i) in pickerFiltered" :key="f" class="fp-item" :class="{ active: i === pickerIndex }"
                @mousedown.prevent="pickerPick(f)"
              >
                {{ f }}
              </div>
              <div v-if="!pickerFiltered.length" class="fp-empty">
                无匹配文件
              </div>
            </div>
          </div>
          <div ref="cmHost" class="cm-host" tabindex="0" />
        </div>
        <!-- [script-meta-row] [meta-row-bottom] 当前脚本元信息（desc/why/plan/done） -->
        <div v-if="hasScriptMeta" class="meta-row">
          <span v-if="scriptMeta.desc" class="meta-item"><b>desc</b><span :title="scriptMeta.desc">{{ scriptMeta.desc
          }}</span></span>
          <span v-if="scriptMeta.why" class="meta-item"><b>why</b><span :title="scriptMeta.why">{{ scriptMeta.why
          }}</span></span>
          <span v-if="scriptMeta.plan" class="meta-item"><b>plan</b><span :title="scriptMeta.plan">{{ scriptMeta.plan
          }}</span></span>
          <span v-if="scriptMeta.done" class="meta-item"><b>done</b><span :title="scriptMeta.done">{{ scriptMeta.done
          }}</span></span>
        </div>
        <footer class="editor-foot">
          <span v-if="persistWarning" v-tooltip="persistWarning" class="persist-warning">⚠ 会话存储已满</span>
          <div class="foot-spacer" />

          <span v-if="result?.error" v-tooltip="result.error" class="req-err-badge">
            ⛔ 请求失败
          </span>
          <span v-if="result?.dryRunFailed" v-tooltip="result.dryRunReason || '预检未通过，磁盘零改动'" class="dry-badge">
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
import DiffOverlay from './DiffOverlay.vue'
import LoopBar from './LoopBar.vue'
import NoteBar from './NoteBar.vue'
import SidePane from './SidePane.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRunner } from '../composables/useRunner'
import { currentLoopContext, useAutoLoop } from '../composables/useAutoLoop'
import { copyAndFill } from '../composables/useDeepseekUrl'
import { useAiWaiting } from '../composables/useAiWaiting'
import { useAutoTakeover } from '../composables/useAutoTakeover'
import { emit, setPendingAskKey, useEventBus } from '../composables/useEventStream'
import { useCodeCleaner } from '../composables/useCodeCleaner'
import { buildErrorContext, enforceBudget, parseErrorLocations } from '../utils/contextBuilder'
import { readNdjson } from '../utils/stream'
import { fnv1a8 } from '../utils/hash'
import { useToast } from '../composables/useToast'
import { useTraceLog } from '../composables/useTraceLog'
import type { TraceEntry } from '../composables/useTraceLog'
import { setLastAutoFilled } from '../composables/useScriptInbox'
import type { Change, RunResponse } from '../types'

defineOptions({ name: 'ScriptPanel' })

// 组合式函数：toast 在 script 早段被使用，此处集中初始化
const { toast, confirmDialog } = useToast()
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

const { script, lastRunCode, running, result, changes, rolling, busyAll, persistWarning, liveStdout, liveStderr, run, stop, rollback, rollbackAll, save, autoFeedbackRequested, clearAutoFeedback } = useRunner()
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
  loopState,
  loopRound,
  loopGoal,
  stopReason,
  toleranceLeft,
  stage,
  tokenDelta,
  maxRounds,
  isLoopActive,
  killCurrent,
  userNote,
} = useAutoLoop()
const lastRunScript = ref('')
const SKILLS_KEY = '__ai_selected_skills'
interface SkillInfo { name: string, content?: string, source?: 'base' | 'user' | 'agents' }
const skillsList = ref<SkillInfo[]>([])
const skillsLoading = ref(false)
const skillTriggerRef = ref<HTMLElement | null>(null)
const skillMenuPos = ref<{ top: string, left: string }>({ top: '0px', left: '0px' })
const skillMenuOpen = ref(false)
function toggleSkillMenu() {
  const el = skillTriggerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  skillMenuPos.value = { top: `${rect.bottom + 4}px`, left: `${rect.left}px` }
  skillMenuOpen.value = !skillMenuOpen.value
  if (skillMenuOpen.value && !skillsList.value.length && !skillsLoading.value) void loadSkillsList()
}
function onGlobalMousedown(e: MouseEvent) {
  if (!skillMenuOpen.value) return
  const t = e.target as HTMLElement | null
  if (t && (t.closest('[data-skill-menu]') || t.closest('[data-skill-trigger]'))) return
  skillMenuOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onGlobalMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onGlobalMousedown))
function loadSelectedSkillNames(): string[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY)
    if (raw === null) return ['gen-script-rules']
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return ['gen-script-rules'] }
}
const selectedSkillNames = ref<string[]>(loadSelectedSkillNames())
watch(selectedSkillNames, (v) => {
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(v)) } catch { }
}, { deep: true })
async function loadSkillsList(): Promise<void> {
  skillsLoading.value = true
  try {
    const res = await fetch('/__ai/skills')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    skillsList.value = Array.isArray(data) ? data : []
    ; (window as any).__ai_skills = skillsList.value
  } catch (e) {
    console.error('[ai-runner] loadSkillsList failed:', e)
    skillsList.value = []
  } finally { skillsLoading.value = false }
}
function toggleSkill(name: string): void {
  const i = selectedSkillNames.value.indexOf(name)
  if (i >= 0) selectedSkillNames.value = selectedSkillNames.value.filter(n => n !== name)
  else selectedSkillNames.value = [...selectedSkillNames.value, name]
}
void loadSkillsList()
const showUserNote = ref(false)
function submitUserNote(text: string) {
  userNote.value = text
  showUserNote.value = false
  if (userNote.value) toast('补充说明已记录，将在下一轮反馈带上', 'success', 3000)
}

function pauseAll() {
  cancelAutoRun()
  disableAutoTakeover()
  stop()
  if (isLoopActive.value) {
    void killCurrent()
  }
}

const mainRef = ref<HTMLElement | null>(null)

const copied = ref(false)
const fileDragging = ref(false)
const fileSuccess = ref(false)
/* [attachments] 附件：粘贴图片 / 拖文件 → tag 展示；发送时文本内容拼入脚本 */
interface AttachedFile {
  id: string
  name: string
  size: number
  kind: 'image' | 'text' | 'folder'
  content: string
  paths?: string[] // folder 专用：展开后的文件列表
}
const attachedFiles = ref<AttachedFile[]>([])
const MAX_ATTACH_BYTES = 500 * 1024 // 单文件 500KB
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}
function readAsText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result || ''))
    r.onerror = rej
    r.readAsText(file)
  })
}
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result || ''))
    r.onerror = rej
    r.readAsDataURL(file)
  })
}
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
  } catch (e) {
    toast(`附件读取失败：${String(e)}`, 'error', 4000)
  }
}
function removeAttach(id: string): void {
  attachedFiles.value = attachedFiles.value.filter(f => f.id !== id)
}
function clearAll(): void {
  script.value = ''
  attachedFiles.value = []
}
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
async function onDesktopDrop(e: DragEvent): Promise<void> {
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  e.preventDefault()
  for (const f of files) await addAttachedFile(f)
  fileSuccess.value = true
  setTimeout(() => { fileSuccess.value = false }, 1500)
}
/* [tree-drop] 从文件树拖到编辑区 → 附件 */
function isInEditor(x: number, y: number): boolean {
  try {
    const el = document.elementFromPoint(x, y)
    if (!el) return false
    return Boolean((el as HTMLElement).closest('.editor'))
  } catch { return false }
}
async function fetchTreePaths(rootPath: string): Promise<string[]> {
  const out: string[] = []
  const walk = (nodes: any[]) => {
    for (const n of nodes || []) {
      if (n.type === 'file') out.push(String(n.path || ''))
      else if (n.children) walk(n.children)
    }
  }
  try {
    const res = await fetch(`/__ai/files/tree?path=${encodeURIComponent(rootPath)}`)
    const data = await res.json()
    walk(data.tree || [])
  } catch { /* ignore */ }
  return out.filter(Boolean)
}
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
      toast(`已附加文件夹 ${p}（${tree.length} 个文件）`, 'success', 2000)
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
        toast(`附件 ${p} 读取失败：${f.error}`, 'warn', 4000)
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
      toast(`已附加 ${p}`, 'success', 1500)
    } catch (e) {
      toast(`附件读取失败：${String(e)}`, 'error', 4000)
    }
  }
}
function onTreeDrag(e: Event) {
  const d = (e as CustomEvent).detail as { x: number, y: number }
  if (!d) return
  fileDragging.value = isInEditor(d.x, d.y)
}
function onTreeDragCancel() {
  fileDragging.value = false
}
function onTreeDrop(e: Event) {
  const d = (e as CustomEvent).detail as { paths: string[], x: number, y: number }
  fileDragging.value = false
  if (!d || !isInEditor(d.x, d.y)) return
  void addTreePaths(d.paths || [])
}
function isBashScript(scriptText: string): boolean {
  const first = (scriptText.split('\n', 1)[0] || '').trim()
  return /^#!\s*\/usr\/bin\/(env\s+)?bash\b/.test(first)
}
async function fetchFolderContents(paths: string[]): Promise<Array<{ path: string, content: string }>> {
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    const data = await res.json()
    return (data.files || []).filter((f: any) => !f.error).map((f: any) => ({ path: String(f.path), content: String(f.content || '') }))
  } catch { return [] }
}
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
const statusText = ref('')
const statusClass = ref('')

// [user-run-wait] 点运行 → 立即置“等待 AI 回复”loading
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
const sideTab = ref<'tree' | 'changes' | 'trace' | 'tasks'>('tree')
// U.12: 窄屏抽屉开合
const sideDrawerOpen = ref(false)
const previewFile = ref<string | null>(null)
const previewBefore = ref<string | null>(null)
const previewAfter = ref<string>('')

const { events: busEvents } = useEventBus()

// [flow-timeline] 全流程时间线计算
// [flow-tag-v3] 生命周期状态 → 中文字面
function statusOf(s: string): string {
  if (s === 'run') return '进行中'
  if (s === 'ok') return '已完成'
  if (s === 'err') return '失败'
  return '待开始'
}
const flowStages = computed(() => {
  const ev = (busEvents && busEvents.value) || []
  let startIdx = -1
  for (let i = ev.length - 1; i >= 0; i--) { if (ev[i].kind === 'run:start') { startIdx = i; break }
  }
  const stageEvts: Array<{ payload?: Record<string, unknown> }> = []
  let endEvt: { payload?: Record<string, unknown> } | null = null
  if (startIdx >= 0) {
    for (let i = startIdx + 1; i < ev.length; i++) {
      const k = ev[i].kind
      if (k === 'run:stage') { stageEvts.push(ev[i] as { payload?: Record<string, unknown> })
      }
      else if (k === 'run:end' || k === 'run:error') { endEvt = ev[i] as { payload?: Record<string, unknown> }; break }
    }
  }
  const s = String(loopState.value || 'idle')
  const isWait = s === 'waiting' || s === 'running' || s === 'feedback' || running.value || aiWaiting.value
  const isParse = s === 'parsing'
  const isExec = s === 'executing'
  const isFinal = s === 'stopped' || s === 'done' || s === 'budget-limited' || s === 'interrupted' || s === 'handoff'
  let waitState = 'idle'
  if (isWait && !isParse && !isExec && !isFinal) waitState = 'run'
  else if (isParse || isExec || isFinal) waitState = 'ok'
  const waitDetail = s === 'waiting' ? '等待回复中' : (s === 'feedback' ? '已发反馈' : '')
  let parseState = 'idle'
  if (isParse) parseState = 'run'
  else if (isExec || isFinal) parseState = 'ok'
  let execState = 'idle'
  if (isExec) execState = 'run'
  else if (isFinal && result.value && result.value.ok === false) execState = 'err'
  else if (isFinal && result.value && result.value.ok === true) execState = 'ok'
  const execDetail = stageEvts.length
    ? stageEvts.slice(-5).map(e => String((e.payload && e.payload.name) || '')).filter(Boolean).join(' · ')
    : ''
  let resState = 'idle'
  let resDetail = ''
  if (isFinal || endEvt) {
    const okFlag = result.value ? result.value.ok === true : (endEvt && endEvt.payload ? endEvt.payload.ok === true : false)
    if (okFlag) { resState = 'ok'; resDetail = '成功' }
    else { resState = 'err'; resDetail = (result.value && result.value.error) || '失败' }
  }
  return [
    { key: 'wait', icon: '💬', label: '等待 AI 回复', state: waitState, detail: waitDetail, status: statusOf(waitState) },
    { key: 'parse', icon: '📝', label: '脚本准备', state: parseState, detail: '', status: statusOf(parseState) },
    { key: 'exec', icon: '⚙', label: '执行', state: execState, detail: execDetail, status: statusOf(execState) },
    { key: 'result', icon: '✓', label: '结果', state: resState, detail: resDetail, status: statusOf(resState) },
  ]
})

// [single-stage] 只显示当前活跃阶段

const termBodyRef = ref<HTMLElement | null>(null)

type ChatRole = 'user' | 'ai' | 'sys' | 'step'
function chatRole(kind: string): ChatRole {
  if (kind === 'ai:ask') return 'step'
  if (kind === 'ai:script' || kind === 'run:start' || kind === 'run:end' || kind === 'run:error' || kind === 'run:stage') return 'step'
  if (kind === 'ai:done' || kind === 'ai:plain' || kind === 'ai:multi' || kind === 'ai:summary' || kind === 'ai:feedback' || kind === 'ai:decision' || kind === 'ai:need-files') return 'ai'
  return 'sys'
}
const chatItems = computed(() => busEvents.value
  .filter(e => e.kind !== 'ai:token')
  .map(e => ({ ...e, payload: ((e.payload || {}) as TraceEntry['payload']), role: chatRole(e.kind) }))
  .filter((e) => {
    // 过滤无内容的 AI 气泡：脚本到达已由步骤条显示，纯文本空回复不显示
    if (e.role !== 'ai') return true
    const p = (e.payload || {}) as Record<string, unknown>
    if (String(p.text || '').trim()) return true
    if (String(p.desc || '').trim()) return true
    return false
  }))

const treeExpanded = ref<Set<number>>(new Set())

/* [auto-expand-stream] 自动展开最后一个 ai:stream */
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

/** 最新的 AI 流式文本（取最后一条 ai:stream 事件） */

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

  // [P3-7] 三层反馈摘要：代码层（lint/结构）→ 类型层（tsc）→ 行为层（test/smoke/runtime）
  // [fix-issues-okline-v1] 声明累积数组
  const issues = []
  const okLine = []
  {
    // 行为层（优先级最高）
    if (result.value.test?.ran) {
      if (!result.value.test.ok) issues.push('行为层: 单测失败（见下 # 单元测试）')
      else okLine.push('test ✓')
    }
    if (result.value.smoke?.ran && !result.value.smoke.ok) issues.push('行为层: 冒烟失败（见下 # 页面冒烟）')
    if (result.value.dryRunFailed) issues.push('行为层: 脚本运行中断，磁盘零改动')
    if (result.value.code !== 0 && !result.value.dryRunFailed && result.value.code !== -1) {
      issues.push(`行为层: 退出码 ${result.value.code}`)
    }
    // 类型层
    if (result.value.tsc) {
      if (result.value.tsc.ok === false) issues.push('类型层: tsc 报错（见下 # 类型检查）')
      else okLine.push('tsc ✓')
    }
    // 代码层
    if (result.value.lint?.ran) {
      if (!result.value.lint.ok) issues.push('代码层: eslint 报错（见下 # 代码格式化）')
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
async function runSmart(opts?: { bypassAutoGuard?: boolean }) {
  if (autoTakeoverEnabled.value && !opts?.bypassAutoGuard) {
    toast('自动接管中，请先关闭接管再手动运行', 'warn', 2500)
    return
  }
  const rawScript = script.value.trim()
  if (!rawScript) return
  const text = attachedFiles.value.length ? await buildScriptWithAttachments(rawScript, attachedFiles.value) : rawScript
  const firstLine = text.split('\n', 1)[0].trim()
  const isNode = /^#!\s*\/usr\/bin\/(env\s+)?node\b/.test(firstLine)
  const isBash = /^#!\s*\/usr\/bin\/(env\s+)?bash\b/.test(firstLine)
  if (isNode || isBash) {
    runningCommand.value = ''
    lastRunScript.value = text
    // [P2-2c] 保留编辑器内容（不清空）：script.value = ''
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

async function askAi(question: string) {
  startAiWaiting()
  if (!question) { toast('@ 后没有内容', 'warn'); return }
  const skills = await loadSkillsForAsk()
  const fileBlocks = await expandAtRefs(question)
  const cleanQuestion = question.replace(/(?:^|\n)[ \t]*@[\w./-]+[ \t]*/g, '').trim()
  const segs: string[] = []
  if (skills) segs.push(`# 规则\n\n${skills}`)
  if (fileBlocks) segs.push(`# 相关文件\n\n${fileBlocks}`)
  if (cleanQuestion) segs.push(`# 问题\n\n${cleanQuestion}`)
  const prompt = segs.join('\n\n')
  const r = await copyAndFill(prompt)
  if (r === 'failed') {
    toast('发送失败，已复制到剪贴板', 'warn', 4000)
    return
  }
  const askKey = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  setPendingAskKey(askKey)
  emit('ai:ask', question.slice(0, 100), { payload: { question, prompt, phase: 'pending' }, updateKey: askKey })
  statusText.value = '✅ 已发送'
  statusClass.value = 'ok'
  // [P2-2c] 保留编辑器内容（不清空）：script.value = ''
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
async function copyOutput(force = false) {
  if (!result.value) return
  try {
    const runKey = result.value.runId || `${result.value.code}|${(result.value.stderr || '').slice(0, 64)}`
    if (!force && lastAutoAskedRunId === runKey) return
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
const pickerStyle = computed(() => ({ left: `${pickerX.value}px`, top: `${pickerY.value}px` }))

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
  const insertText = `@${filePath} `
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
        '&': {
          height: '100%',
          fontSize: '12px',
          backgroundColor: 'var(--surface)',
          color: 'var(--text)',
        },
        '.cm-scroller': {
          fontFamily: 'var(--mono, monospace)',
          lineHeight: '20px',
          overflowX: 'hidden',
          overflowY: 'auto',
        },
        '.cm-content': {
          caretColor: 'var(--primary)',
          backgroundColor: 'var(--surface)',
          color: 'var(--text)',
        },
        '.cm-line': {
          color: 'var(--text)',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--surface)',
          color: 'var(--text-3)',
          borderRight: '1px solid var(--border)',
        },
        '.cm-gutterElement': {
          color: 'var(--text-3)',
        },
        '.cm-lineNumbers .cm-gutterElement': {
          color: 'var(--text-3)',
        },
        '.cm-activeLine': {
          backgroundColor: 'rgb(88 166 255 / 5%)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'rgb(88 166 255 / 8%)',
          color: 'var(--text-2)',
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: 'var(--primary)',
        },
        '.cm-selectionBackground, ::selection': {
          backgroundColor: 'rgb(88 166 255 / 25%)',
        },
        '&.cm-focused .cm-selectionBackground': {
          backgroundColor: 'rgb(88 166 255 / 30%)',
        },
        '.cm-panels': {
          backgroundColor: 'var(--surface-2)',
          color: 'var(--text)',
        },
        '.cm-tooltip': {
          backgroundColor: 'var(--surface-2)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
        },
        '&.cm-focused': {
          outline: 'none',
        },
      }, { dark: true }),
      m.Prec.highest(m.keymap.of([
        { key: 'Mod-Enter', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Alt-r', preventDefault: true, run: () => { runSmart(); return true } },
        { key: 'Alt-ArrowUp', preventDefault: true, run: () => { cmdHistoryPrev(); return true } },
        { key: 'Alt-ArrowDown', preventDefault: true, run: () => { cmdHistoryNext(); return true } },

        {
          key: 'Enter',
          run: () => {
            const text = script.value.trim()
            if (text.startsWith('!') && !text.includes('\n')) {
              runSmart()
              return true
            }
            return false
          }
        },
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
// [P2-2b] draft slots API
const DRAFT_SLOTS_KEY = '__ai_script_drafts'
const DRAFT_ACTIVE_KEY = '__ai_script_draft_active'
interface DraftSlot { id: string, text: string, ts: number, name: string }
const draftSlots = ref<DraftSlot[]>([])
const activeDraftId = ref<string>('default')
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
function persistDraftSlots(): void {
  try { localStorage.setItem(DRAFT_SLOTS_KEY, JSON.stringify(draftSlots.value)) } catch { /* ignore */ }
  try { localStorage.setItem(DRAFT_ACTIVE_KEY, activeDraftId.value) } catch { /* ignore */ }
}
function upsertDraftSlot(id: string, text: string, name?: string): void {
  const i = draftSlots.value.findIndex(s => s.id === id)
  const item: DraftSlot = { id, text, ts: Date.now(), name: name || (i >= 0 ? draftSlots.value[i].name : id) }
  if (i >= 0) draftSlots.value[i] = item
  else draftSlots.value.push(item)
  persistDraftSlots()
}
function switchDraftSlot(id: string): void {
  if (id === activeDraftId.value) return
  upsertDraftSlot(activeDraftId.value, script.value)
  const next = draftSlots.value.find(s => s.id === id)
  activeDraftId.value = id
  script.value = next ? next.text : ''
  persistDraftSlots()
}
function deleteDraftSlot(id: string): void {
  if (id === 'default') return
  draftSlots.value = draftSlots.value.filter(s => s.id !== id)
  if (activeDraftId.value === id) {
    activeDraftId.value = 'default'
    const d = draftSlots.value.find(s => s.id === 'default')
    script.value = d ? d.text : ''
  }
  persistDraftSlots()
}
function newDraftSlot(): void {
  upsertDraftSlot(activeDraftId.value, script.value)
  const id = `draft-${Date.now().toString(36)}`
  draftSlots.value.push({ id, text: '', ts: Date.now(), name: id })
  activeDraftId.value = id
  // [P2-2c] 保留编辑器内容（不清空）：script.value = ''
  persistDraftSlots()
}

// [P2-2b] auto-persist active slot（debounce 400ms）
let draftPersistTimer: ReturnType<typeof setTimeout> | null = null
watch(script, (v) => {
  if (draftPersistTimer) clearTimeout(draftPersistTimer)
  draftPersistTimer = setTimeout(() => {
    upsertDraftSlot(activeDraftId.value, String(v || ''))
  }, 400)
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

  void createEditor()
  scrollTermToBottom()
  window.addEventListener('ai-runner:auto-run', onAutoRun)
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('ai-runner:drag', onTreeDrag)
  window.addEventListener('ai-runner:drop', onTreeDrop)
  window.addEventListener('ai-runner:drag-cancel', onTreeDragCancel)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onSideMove)
  window.removeEventListener('pointerup', onSideUp)
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }

  window.removeEventListener('ai-runner:auto-run', onAutoRun)
  window.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('ai-runner:drag', onTreeDrag)
  window.removeEventListener('ai-runner:drop', onTreeDrop)
  window.removeEventListener('ai-runner:drag-cancel', onTreeDragCancel)
  cmView?.destroy()
  cmView = null
})

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
      if (autoTakeoverEnabled.value) scheduleAutoRun(() => { void copyOutput(autoFeedbackRequested.value) })
      else void copyOutput(autoFeedbackRequested.value)
    } else {
      statusText.value = result.value.ok ? '✅ 成功' : '❌ 失败'
      statusClass.value = result.value.ok ? 'ok' : 'err'
      // autoAskOnResult: 失败或只读诊断（成功无改动、非循环）时延迟 3s 自动复制并发给 AI（主动停止除外）
      const isReadonlyProbe = isReadonlyResult(result.value)
      const AUTO_ASK_DELAY_MS = 0 // [hardpause] 立即执行
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
      const descMatch = scriptSnapshot.match(/^\s*(?:\/\/|#)\s*@desc\s*:\s*(.+)$/m)
      const desc = r.scriptDesc || (descMatch ? descMatch[1].trim() : '')
      const whyMatch = scriptSnapshot.match(/^\s*(?:\/\/|#)\s*@why\s*:\s*(.+)$/m)
      const why = r.scriptWhy || (whyMatch ? whyMatch[1].trim() : '')
      const lang: 'js' | 'bash' = /^\s*#\s*(@desc|@why)/m.test(scriptSnapshot) ? 'bash' : 'js'
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

const addingAllToEditor = ref(false)
async function onAddAllClick() {
  if (!cmView) { toast('编辑器未就绪', 'warn'); return }
  if (addingAllToEditor.value) return
  addingAllToEditor.value = true
  try {
    const res = await fetch('/__ai/files?depth=6')
    const data = await res.json()
    if (data.error) { toast(`加载失败：${data.error}`, 'error'); return }
    const paths: string[] = []
    const walk = (nodes: any[]) => {
      for (const n of nodes || []) {
        if (n.type === 'file') paths.push(n.path)
        else if (n.children?.length) walk(n.children)
      }
    }
    walk(data.tree || [])
    const filtered = paths.filter(p => /\.(ts|tsx|vue|js|jsx|mjs|cjs|md|json|css|scss|html)$/i.test(p))
    if (!filtered.length) { toast('未找到可插入的文件', 'warn'); return }
    const insert = `${filtered.map(p => `@${p} `).join('\n')}\n`
    const view = cmView
    const pos = view.state.selection.main.head
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } })
    view.focus()
    toast(`已插入 ${filtered.length} 个文件路径`, 'success', 3000)
  } catch (e) {
    toast(`插入失败：${String(e)}`, 'error')
  } finally {
    addingAllToEditor.value = false
  }
}

// [live-typewriter] 打字机式实时输出（terminal 内）
const twStdout = ref('')
const twStderr = ref('')
let twRaf: number | null = null
function twStep() {
  twRaf = null
  const tOut = (liveStdout && liveStdout.value) || ''
  const tErr = (liveStderr && liveStderr.value) || ''
  let more = false
  if (twStdout.value.length < tOut.length) {
    const step = Math.max(1, Math.min(80, Math.ceil((tOut.length - twStdout.value.length) / 12)))
    twStdout.value = tOut.slice(0, twStdout.value.length + step)
    more = true
  } else if (twStdout.value !== tOut) { twStdout.value = tOut }
  if (twStderr.value.length < tErr.length) {
    const step = Math.max(1, Math.min(80, Math.ceil((tErr.length - twStderr.value.length) / 12)))
    twStderr.value = tErr.slice(0, twStderr.value.length + step)
    more = true
  } else if (twStderr.value !== tErr) { twStderr.value = tErr }
  if (more) twRaf = requestAnimationFrame(twStep)
}
function twKick() { if (twRaf === null) twRaf = requestAnimationFrame(twStep) }
watch(liveStdout, twKick)
watch(liveStderr, twKick)
onBeforeUnmount(() => { if (twRaf !== null) cancelAnimationFrame(twRaf) })

// [script-meta-row] 从当前脚本内容解析 @desc/@why/@plan/@done
const scriptMeta = computed(() => {
  const code = String((script && script.value) || '')
  const pick = (name: string): string => {
    const re = new RegExp(`^[ \\t]*(?://|#)[ \\t]*@${name}[ \\t]*:[ \\t]*(.+)$`, 'm')
    const m = code.match(re)
    return m ? m[1].trim() : ''
  }
  return {
    desc: pick('desc'),
    why: pick('why'),
    plan: pick('plan'),
    done: pick('done'),
  }
})
const twLines = computed(() => (twStdout.value || '').split('\n'))
const twErrLines = computed(() => (twStderr.value || '').split('\n'))
function lineClass(line: string): string {
  const t = String(line).replace(/^\s+/, '')
  if (t.startsWith('▶')) return 'out-step'
  if (t.startsWith('✓')) return 'out-ok'
  if (t.startsWith('✗')) return 'out-err'
  if (t.startsWith('!')) return 'out-warn'
  if (t.startsWith('⚠')) return 'out-warn'
  return ''
}
const hasScriptMeta = computed(() => {
  const m = scriptMeta.value
  return !!(m.desc || m.why || m.plan || m.done)
})

// [latest-tokens-fix] ts-bar 引用 latestTokens，此处补解构（useAutoLoop 返回 computed）
const { latestTokens } = useAutoLoop()
</script>

<style scoped lang="scss">
/* ============ Layout ============ */

/* 拖拽条：调整右侧面板宽度 */

/* U.12: 窄屏抽屉 toggle 与 backdrop（桌面不显示） */

.pane.is-resizing-side,
.pane.is-resizing-side * {
  user-select: none !important;
  cursor: col-resize !important;
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

.dot {
  width: 11px;
  height: 11px;
  border-radius: var(--radius-full);
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

.meta {
  font-size: var(--font-11);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* ============ 编辑器 ============ */
.editor {
  flex: 1 1 300px;
  min-height: 0;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  background: var(--surface) !important;
  border-top: 1px solid var(--border) !important;
}

.editor.is-running {
  border-color: rgb(88 166 255 / 40%);
}

.foot-spacer {
  flex: 1;
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

.primary-btn.head-run {
  padding: 5px 14px;
  font-size: var(--font-12);
  font-weight: 600;
}

.primary-btn.ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border-2);
  box-shadow: none;
}

.primary-btn.ghost:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}

.ghost-btn {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-6);
  color: var(--text-2);
  font-size: var(--font-12);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  width: auto;
  min-width: auto;
  flex-wrap: nowrap;
}

/* ============ 快捷键提示 ============ */

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

/* 键盘控制时：禁止选中 */
.is-resizing,
.is-resizing * {
  user-select: none !important;
  cursor: row-resize !important;
}

@keyframes ai-caret-blink {
  to {
    visibility: hidden;
  }
}

.bubble-head {
  margin-bottom: 3px;
  color: var(--term-text-3);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.bubble-body .md-h {
  margin: 3px 0 2px;
  font-size: 11px;
  color: var(--term-accent);
  text-transform: none;
  letter-spacing: 0.3px;
}

.bubble-body code {
  padding: 1px 4px;
  background: var(--term-chip-bg-2);
  border-radius: var(--radius-2);
  font: 11px var(--mono, monospace);
  color: var(--term-code-color);
}

.bubble-body strong {
  color: var(--warning);
}

.bubble-body .md-code {
  margin: 4px 0;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius-4);
  overflow: hidden;
  background: var(--term-code-bg);
  border-color: var(--term-sep);
}

.bubble-body .md-code-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--term-chip-bg);
  border-bottom: 1px solid var(--surface-2);
  border-bottom-color: var(--term-sep);
}

.bubble-body .md-code-lang {
  color: var(--term-text-2);
  font: 11px var(--mono, monospace);
}

.bubble-body .md-code-acts {
  display: flex;
  gap: 6px;
}

.bubble-body .md-code-acts button {
  padding: 1px 8px;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius-3);
  background: transparent;
  color: var(--term-text-2);
  font: 10px var(--mono, monospace);
  cursor: pointer;
  border-color: var(--term-chip-border);
}

.bubble-body .md-code summary {
  list-style: none;
  padding: 0;
}

.bubble-body .md-code summary::-webkit-details-marker {
  display: none;
}

.bubble-body :deep(.hljs-keyword),
.bubble-body :deep(.hljs-literal),
.tree-body :deep(.hljs-keyword),
.tree-body :deep(.hljs-literal) {
  color: #569cd6;
}

.bubble-body :deep(.hljs-string),
.tree-body :deep(.hljs-string) {
  color: #ce9178;
}

.bubble-body :deep(.hljs-number),
.tree-body :deep(.hljs-number) {
  color: #b5cea8;
}

.bubble-body :deep(.hljs-comment),
.tree-body :deep(.hljs-comment) {
  color: #6a9955;
  font-style: italic;
}

.bubble-body :deep(.hljs-function),
.bubble-body :deep(.hljs-title),
.tree-body :deep(.hljs-function),
.tree-body :deep(.hljs-title) {
  color: var(--warning);
}

.bubble-body :deep(.hljs-variable),
.bubble-body :deep(.hljs-params),
.bubble-body :deep(.hljs-attr),
.tree-body :deep(.hljs-variable),
.tree-body :deep(.hljs-params),
.tree-body :deep(.hljs-attr) {
  color: #9cdcfe;
}

.bubble-body :deep(.hljs-built_in),
.bubble-body :deep(.hljs-type),
.tree-body :deep(.hljs-built_in),
.tree-body :deep(.hljs-type) {
  color: #4ec9b0;
}

.bubble-body :deep(.hljs-meta),
.tree-body :deep(.hljs-meta) {
  color: #569cd6;
}

.bubble-body :deep(.hljs-section),
.tree-body :deep(.hljs-section) {
  color: #4ec9b0;
}

.bubble-body :deep(.hljs-symbol),
.bubble-body :deep(.hljs-bullet),
.tree-body :deep(.hljs-symbol),
.tree-body :deep(.hljs-bullet) {
  color: #d7ba7d;
}

.bubble-body .md-code pre {
  margin: 0;
  padding: 8px 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font: 11px/1.55 var(--mono, monospace);
  color: var(--term-text);
}

.chat-step .step-time {
  font-size: 11px !important;
  color: var(--text-3, var(--text-3)) !important;
  font-variant-numeric: tabular-nums !important;
  flex-shrink: 0;
  flex: 0 0 auto !important;
  align-self: flex-start !important;
  margin-top: 0 !important;
  opacity: 0.9 !important;
  padding-right: 6px !important;
}

@keyframes step-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.45;
  }
}

.md-code-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--term-chip-bg);
  border-bottom: 1px solid var(--surface-2);
  border-bottom-color: var(--term-sep);
}

.md-code-lang {
  color: var(--term-text-2);
  font: 11px var(--mono, monospace);
}

.md-code-acts {
  display: flex;
  gap: 6px;
}

.md-code-acts button {
  padding: 1px 8px;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius-3);
  background: transparent;
  color: var(--term-text-2);
  font: 10px var(--mono, monospace);
  cursor: pointer;
  border-color: var(--term-chip-border);
}

.md-code summary {
  list-style: none;
  padding: 0;
}

.md-code summary::-webkit-details-marker {
  display: none;
}

@keyframes run-spin {
  to {
    transform: rotate(360deg);
  }
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

/* ============ Side ============ */

/* ============ Overlay ============ */

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
    display: flex;
    flex-direction: row;
    gap: 0 !important;
    height: 100%;
    overflow: hidden;
    padding: 0 !important;
  }

  /* U.12: 窄屏 pane-side 改右侧抽屉 */

  .pane-side :deep(.changes) {
    max-height: 42%;
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

.skill-menu-fixed {
  position: fixed;
  z-index: 9999;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  box-shadow: 0 8px 24px rgb(15 30 60 / 15%);
}

.skill-menu-fixed .skill-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-4);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.skill-menu-fixed .skill-row:hover {
  background: var(--surface-2);
}

.skill-menu-fixed .skill-row input {
  margin: 0;
  accent-color: var(--primary);
}

.skill-menu-fixed .skill-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-menu-fixed .skill-src {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: var(--radius-2);
  font-size: 10px;
  font-weight: 600;
}

.skill-menu-fixed .skill-src.src-base {
  background: var(--primary-bg);
  color: var(--primary);
}

.skill-menu-fixed .skill-src.src-agents {
  background: var(--warning-bg, #fffbeb);
  color: var(--warning, #d97706);
}

.skill-menu-fixed .skill-src.src-user {
  background: var(--success-bg);
  color: var(--success);
}

.skill-menu-fixed .skill-loading,
.skill-menu-fixed .skill-empty {
  color: var(--text-3);
  font-style: italic;
  cursor: default;
}

.skill-menu-fixed .skill-hint {
  margin-top: 4px;
  padding: 6px 8px 4px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-3);
  line-height: 1.5;
}

.skill-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-12);
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--font-12);
  font-weight: 500;
  user-select: none;
  cursor: pointer;
  transition: 0.12s;
  flex-shrink: 0;
}

.skill-trigger:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-bg);
}

.skill-count {
  padding: 0 5px;
  font-size: 10px;
  color: var(--text-3);
  background: var(--surface-2);
  border-radius: var(--radius-2);
  line-height: 14px;
  flex-shrink: 0;
}

.skill-menu-head {
  padding: 4px 8px;
  margin-bottom: 4px;
  font-size: 10px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
}

.skill-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  background: var(--primary);
  color: #fff;
  border-radius: var(--radius-8);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  flex-shrink: 0;
}

.skill-badge-empty {
  background: var(--border-2);
  color: var(--text-3);
}

.skill-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 9999;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  box-shadow: 0 8px 24px rgb(15 30 60 / 15%);
}

.skill-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-4);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.skill-row:hover {
  background: var(--surface-2);
}

.skill-row input {
  margin: 0;
  accent-color: var(--primary);
}

.skill-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-src {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: var(--radius-2);
  font-size: 10px;
  font-weight: 600;
}

.skill-src.src-base {
  background: var(--primary-bg);
  color: var(--primary);
}

.skill-src.src-user {
  background: var(--success-bg);
  color: var(--success);
}

.skill-loading,
.skill-empty {
  color: var(--text-3);
  font-style: italic;
  cursor: default;
}

.skill-loading:hover,
.skill-empty:hover {
  background: transparent;
}

.skill-hint {
  margin-top: 4px;
  padding: 6px 8px 4px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-3);
  line-height: 1.5;
}

@keyframes overlay-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}
/* 倒计时进度条（waiting 状态） */

@keyframes loop-spin {
  to {
    transform: rotate(360deg);
  }
}

.bubble-body {
  color: var(--term-text);
  font-size: 12px;
}

.bubble-body .md-code-acts button:hover {
  color: var(--term-text);
  border-color: var(--term-text);
}

.chat-step {
  background: transparent !important;
  border-color: var(--term-chip-border);
  color: var(--text-2, var(--text-2)) !important;
  padding: 10px 14px !important;
  margin: 0 !important;
  gap: 10px !important;
  font: 11px/1.5 var(--mono, monospace) !important;
  border-radius: var(--radius-4) !important;
  border: 1px solid var(--border, var(--border)) !important;
  border-left: 2px solid var(--text-3, var(--text-3)) !important;
  min-height: 24px !important;
  display: flex !important;
  justify-content: flex-start !important;
  align-items: center !important;
  width: auto !important;
  max-width: 92% !important;
  text-align: left !important;
  flex-wrap: nowrap !important;
  line-height: 1.55 !important;
  cursor: pointer !important;
  position: relative !important;
  transition:
    background 0.12s,
    border-color 0.12s !important;
  font-size: 12px !important;
  border-left-width: 2px !important;
  flex-direction: row !important;
}

.md-code-acts button:hover {
  color: var(--term-text);
  border-color: var(--term-text);
}

/* [button-icons] SVG 按钮图标 */
.primary-btn .ico-svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: inline-block;
  vertical-align: -1px;
}

.primary-btn .ico-svg + span {
  margin-left: 2px;
}

/* ═══════════════════════════════════════════════════════════
   [ui-polish] 去外壳 + 按钮圆角 + tab 一体化
   ═══════════════════════════════════════════════════════════ */

/* 1. 去外壳：terminal / editor 去 card 边框、背景、阴影 */

/* 2. 顶栏 bar 加圆角，与内容视觉一体 */

/* 3. 按钮圆角统一（原 6px → 8px） */
.primary-btn,
.loop-btn,
.ghost-btn,
.btn,
.tpl-chip,
.draft-select,

/* 4. side-tabs 图标化 + 与内容一体 */

/* ═══════════════════════════════════════════════════════════
   [dark-compact] 紧凑深色：步骤小字 + 气泡收紧
   ═══════════════════════════════════════════════════════════ */

/* 对话区整体收紧 */

/* 步骤行（脚本执行过程）—— 小字日志风 */

/* 用户/AI 气泡收紧，别太占地方 */

/* 系统小提示行紧凑 */

/* 思考行紧凑 */

/* ═══════════════════════════════════════════════════════════
   [button-theme] 按钮配色重做：暖橙强调 + 灰阶次按钮
   参考 Claude Code / Codex 克制配色
   ═══════════════════════════════════════════════════════════ */

/* ——— 次按钮：透明底 + 细边框，hover 时淡淡提亮 ——— */

.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 8%);
}

.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ——— 芯片 / 下拉 / tab ——— */

/* ——— primary 系列（运行/主操作）：暖橙实底 ——— */

/* 运行按钮（takeover 态）：暖橙描边，非实心，更克制 */

/* 停止 / 暂停：柔和红描边 */

/* ——— loop-btn 系列 ——— */
/* ——— 决策按钮 ——— */

/* ——— 焦点环统一暖橙 ——— */
.primary-btn:focus-visible,
.ghost-btn:focus-visible,
.tpl-chip:focus-visible,
.draft-select:focus-visible {
  outline: 0 !important;
  box-shadow: 0 0 0 2px rgb(217 119 87 / 35%) !important;
}

/* ═══════════════════════════════════════════════════════════
   [button-theme-v2] 主按钮去实底，静默态灰
   ═══════════════════════════════════════════════════════════ */

/* run 态（P2 主操作）—— 透明底 + 橙描边 */
.primary-btn.run {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
}

/* takeover 态（运行按钮）—— 同样透明底 + 橙描边 */

/* stop 态（暂停）—— 透明底 + 柔红描边 */

/* loop-btn 主态：透明橙描边 */

/* ═══════════════════════════════════════════════════════════
   [side-connected] 树/变更 tab 与内容一体
   ═══════════════════════════════════════════════════════════ */

/* 1. 去掉 tab 与内容之间的间距 */

/* 2. tab 条紧贴内容，去圆角只留顶部，统一底色 */

@keyframes step-spin {
  to {
    transform: rotate(360deg);
  }
}

.chat-step.state-running .step-title {
  color: var(--primary-hover);
  font-weight: 500;
}

.chat-step .step-title {
  font-variant-numeric: tabular-nums;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  max-width: none !important;
  flex: 1 1 auto !important;
  text-align: left !important;
  line-height: 1.4 !important;
  min-width: 0 !important;
  padding-right: 8px !important;
  font-size: 12.5px !important;
  color: var(--text, var(--surface-2)) !important;
  font-weight: 500 !important;
  display: inline-flex !important;
  align-items: center !important;
  margin: 0 !important;
  align-self: center !important;
}

/* ═══════════════════════════════════════════════════════════
   [msg-center-v2] 消息居中 + 精简
   ═══════════════════════════════════════════════════════════ */
/* 强制覆盖旧左右分栏位置 */

/* ═══════════════════════════════════════════════════════════
   [step-dashed] 步骤行：无背景，虚线边框 + 字色
   ═══════════════════════════════════════════════════════════ */

.chat-step:hover {
  background: rgb(255 255 255 / 3%) !important;
  border-color: rgb(255 255 255 / 28%) !important;
  border-left-color: rgb(255 255 255 / 28%) !important;
}

/* 状态色：只改边框和字色 */

.chat-step.state-running .step-state {
  background: rgb(88 166 255 / 14%);
  color: var(--primary-hover);
  padding: 0;
}

.chat-step.state-done .step-state {
  background: rgb(63 185 80 / 12%);
  color: var(--success);
  padding: 0;
}

.chat-step.state-error .step-state {
  background: rgb(248 81 73 / 14%);
  color: var(--danger);
  padding: 0;
}

/* 时间戳跟字色同系 */

/* ═══════════════════════════════════════════════════════════
   [step-center] 步骤内容聚中
   ═══════════════════════════════════════════════════════════ */

/* 步骤标题不再 flex:1 撑开 */

.chat-step .step-time,
.chat-step .step-state {
  font-size: 10.5px !important;
  font-weight: 600 !important;
  letter-spacing: 0.2px !important;
  padding: 1px 9px !important;
  border-radius: var(--radius-10) !important;
  background: rgb(255 255 255 / 4%) !important;
  color: var(--text-3, var(--text-3)) !important;
  flex-shrink: 0;
  line-height: 1.5 !important;
  border: 0 !important;
  flex: 0 0 auto !important;
  align-self: flex-start !important;
  margin-top: 0 !important;
}

/* ═══════════════════════════════════════════════════════════
   [waiting-bubble] AI 等待气泡 + typing 动画
   ═══════════════════════════════════════════════════════════ */

@keyframes waiting-bounce {
  0%,
  80%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }

  40% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* ═══════════════════════════════════════════════════════════
   [user-step-style] 用户提问样式与步骤条一致
   ═══════════════════════════════════════════════════════════ */
.chat-msg-user {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  width: auto;
  max-width: 92%;
  margin: 4px auto;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border, var(--border));
  border-radius: var(--radius-6);
  font: 11px/1.5 var(--mono, monospace);
  color: var(--term-text-2, var(--text-2));
  justify-content: flex-start;
  text-align: left;
  align-self: flex-end;
  margin-right: 40px;
  margin-left: 0;
  border-left: 3px solid var(--primary, var(--primary));
  border-color: var(--surface-2);
}

.chat-msg-user .bubble-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px 0;
  padding: 0;
  font-size: 11px;
  color: var(--text-3, var(--text-3));
  font-weight: 500;
  letter-spacing: 0;
  flex: 0 0 auto;
  white-space: nowrap;
  text-align: left;
  justify-content: flex-start;
  border-bottom: 0;
}

.chat-msg-user .bubble-body p {
  display: inline;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-msg-user .bubble-body strong {
  color: var(--term-text, var(--text));
  font-weight: 500;
}

/* ═══════════════════════════════════════════════════════════
   [align-left] 容器居中 + 内容左对齐
   ═══════════════════════════════════════════════════════════ */

/* 步骤条：宽度自适应居中；内容左对齐 */

/* 用户消息：同款 */

/* AI 消息：同款 */

.chat-msg-ai .bubble-head,

/* chat-list 容器保持居中排列、不强制 text-align */

/* 等待气泡也遵循 */

/* ═══════════════════════════════════════════════════════════
   [no-shell] 彻底去掉卡片外壳边框
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   [bg-tune] 背景层次：编辑器/终端统一深色，融入整体
   ═══════════════════════════════════════════════════════════ */

/* 编辑器区：稍亮 surface，形成层次 */

.editor .editor-body,
.editor .cm-host,
.editor .cm-editor,
.editor .cm-scroller,

/* 顶栏淡背景 */
.editor .editor-bar {
  background: var(--surface-2, var(--surface-2)) !important;
  padding: 6px 12px !important;
  min-height: 36px !important;
}

/* [toolbar-refactor] tpl-bar 撑开 */

/* ═══════════════════════════════════════════════════════════
   [purple-run] tpl-bar 一行 + 运行按钮紫色
   ═══════════════════════════════════════════════════════════ */

/* tpl-bar 一行紧凑 */

/* 运行按钮紫色 */
.primary-btn.takeover {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
  font-weight: 600;
  border-color: var(--primary);
}

/* 暂停按钮紫红系（与运行按钮一致色系但区分） */
.primary-btn.stop {
  background: transparent;
  color: #f0abfc;
  border: 1px solid #f0abfc;
  box-shadow: none;
  font-weight: 600;
  border-color: #f0abfc;
}

/* tpl-chip hover 也走紫色 */

/* ═══════════════════════════════════════════════════════════
   [hide-scrollbar] 隐藏所有滚动条
   ═══════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   [purple-fix] 运行按钮紫色改偏红
   ═══════════════════════════════════════════════════════════ */

.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(88 166 255 / 14%);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
  box-shadow: 0 0 0 3px rgb(88 166 255 / 10%);
}

.primary-btn.stop:hover:not(:disabled) {
  background: rgb(88 166 255 / 14%);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
}

/* [pending-loading] 等待/执行中状态均显示 loading */
.chat-step.state-running .step-dot,
.chat-step.state-pending .step-dot {
  width: 10px;
  height: 10px;
  background: transparent;
  border: 2px solid rgb(255 255 255 / 20%);
  border-top-color: var(--primary);
  border-right-color: var(--primary);
  border-radius: var(--radius-full);
  animation: step-spin 0.75s linear infinite;
  box-shadow: none;
}

/* ═══════════════════════════════════════════════════════════
   [ui-polish-v3] UI 精修：统一间距/字号/圆角/对比度
   位置：最后加载，覆盖前面所有补丁块
   ═══════════════════════════════════════════════════════════ */

/* ─── 统一字号 ─── */

.chat-step .step-title,
.chat-step .step-time,
.chat-step .step-state,

.chat-msg-user .bubble-head,
.chat-msg-user .bubble-body,
.chat-msg-ai .bubble-head,

/* ─── 统一间距 ─── */

.chat-step,
.chat-msg-user,
.chat-msg-ai,

/* ─── 统一 padding ─── */
.chat-step,
.chat-msg-user,

/* ─── 统一圆角（虚线块用小圆角）─── */

/* ─── 统一边框（虚线 + 同色）─── */

/* ─── 统一图标尺寸 ─── */

/* ─── 步骤状态色（统一色系）─── */
.chat-step.state-pending {
  border-color: rgb(255 255 255 / 16%);
  color: var(--text-3, var(--text-3));
  border-left-color: rgb(255 255 255 / 14%);
  background: rgb(255 255 255 / 2%);
  border-left: 3px solid var(--text-3, var(--text-3));
}

.chat-step.state-running {
  border-color: rgb(88 166 255 / 55%);
  color: var(--primary-hover);
  border-left-color: var(--primary);
  background: rgb(88 166 255 / 6%);
  border-left: 3px solid var(--primary, var(--primary));
}

.chat-step.state-done {
  border-color: rgb(63 185 80 / 45%);
  color: var(--success);
  border-left-color: rgb(63 185 80 / 55%);
  background: rgb(63 185 80 / 5%);
  border-left: 3px solid var(--success, var(--success));
}

.chat-step.state-error {
  border-color: rgb(248 81 73 / 55%);
  color: var(--danger);
  border-left-color: rgb(248 81 73 / 55%);
  background: rgb(248 81 73 / 6%);
  border-left: 3px solid var(--danger, #ef4444);
}

/* ─── 时间戳弱化 ─── */
.chat-step .step-time,
.chat-msg-user .bubble-head,

/* ─── 顶栏统一高度 ─── */
.editor-bar,

/* ─── 底部工具栏对齐 ─── */

/* ─── 编辑器区顶部留白 ─── */

/* ─── 终端区与编辑器区分隔 ─── */

/* ═══════════════════════════════════════════════════════════
   [step-multiline] 步骤标题多行展示（完整 desc/why/plan）
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   [msg-align] 用户右 / AI 左 / 步骤条居中
   ═══════════════════════════════════════════════════════════ */

.chat-msg-user .bubble-head,
.chat-msg-user .bubble-body {
  display: flex;
  color: var(--text, var(--text));
  font-size: 12.5px;
  line-height: 1.6;
  word-break: break-word;
  max-width: 60ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
  text-align: right;
  align-items: center;
  gap: 8px;
}

.chat-step,

/* ═══════════════════════════════════════════════════════════
   [center-v2] 全部消息居中 + 内容左对齐（撤销右/左分布）
   色系：中性灰为主 + 单一强调色（紫）+ 语义色仅状态
   ═══════════════════════════════════════════════════════════ */

/* 撤销 [msg-align] 的左右分布 */
.chat-msg-user,
.chat-msg-ai {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  width: auto;
  max-width: min(720px, 92%);
  margin: 4px auto;
  text-align: left;
  align-self: center;
  margin-left: 0;
  margin-right: 0;
  background: var(--term-chip-bg, rgb(255 255 255 / 3%));
  border: 1px solid var(--border, #333);
  border-left: 3px solid var(--primary, var(--primary));
  border-radius: var(--radius-8);
  padding: 7px 13px;
  border-color: var(--border);
}

/* 统一容器宽度和居中 */
.chat-msg-user,
.chat-msg-ai,
.chat-step,
.chat-waiting {
  display: flex !important;
  align-items: stretch !important;
  gap: 6px !important;
  padding: 10px 14px !important;
  margin: 0 !important;
  background: transparent !important;
  border: 1px solid var(--border, #e5e9f0) !important;
  justify-content: flex-start !important;
  width: 100% !important;
  text-align: left !important;
  border-left: 3px solid var(--primary, var(--primary)) !important;
  border-radius: var(--radius-8) !important;
  align-self: stretch !important;
  margin-left: auto !important;
  margin-right: auto !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
  position: relative !important;
  color: var(--text, var(--text)) !important;
  flex-direction: column !important;
  box-shadow: none !important;
  font-size: 13px !important;
  border-top: 0 !important;
  border-right: 0 !important;
  border-bottom: 0 !important;
  border-left-width: 3px !important;
  border-left-style: solid !important;
}

/* 消息块：中性边框，去掉彩色底 */

/* 头行弱化 */

/* 步骤条：中性底 + 虚线，状态靠左竖线区分 */

/* 状态色：只改左边竖线和 state 文字 */

.chat-step.state-error .step-title {
  color: var(--danger);
}

/* 等待气泡：与步骤条一致 */

/* chat-list 统一 gap */

/* 隐藏旧左右气泡 */

/* ═══════════════════════════════════════════════════════════
   [center-uniform] 统一宽度居中 + 左对齐
   ═══════════════════════════════════════════════════════════ */

/* chat-list 容器：限制最大宽度居中 */

/* 所有消息块：统一宽度占满 chat-list */

/* user 和 ai 消息块：内部对齐由 head+body 控制 */
.chat-msg-user .bubble-head,

.chat-msg-user .bubble-body,

/* 步骤条：完整展示 desc/why/plan，多行不折叠 */

.chat-step .step-time,
.chat-step .step-state,
.chat-step .step-icon,

/* 用户消息：淡灰底 */

/* AI 消息：稍深底 */

/* ═══════════════════════════════════════════════════════════
   [step-tidy] 步骤条紧凑化：标题加粗 + 次级弱化 + 时间/状态右对齐
   ═══════════════════════════════════════════════════════════ */

/* 布局：图标[dot+icon] + 内容[title flex:1] + 右侧[time+state] */

/* step-dot + step-icon 固定左列，紧贴 */
.chat-step .step-dot,
.chat-step .step-icon {
  font-size: 11px !important;
  flex-shrink: 0;
  margin-top: 5px !important;
  line-height: 1 !important;
  flex: 0 0 auto !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  margin: 0 !important;
  padding: 0 !important;
  width: 20px !important;
  height: 20px !important;
}

/* 内容区：占满 */

/* 首行 desc：加粗为标题 */
.chat-step .step-title strong {
  display: block !important;
  font-weight: 600 !important;
  font-size: 12.5px !important;
  color: var(--text, var(--text)) !important;
  margin-bottom: 2px !important;
}

/* 时间 + 状态：固定右侧，同基线 */

/* why/plan 行弱化 */
.chat-step.state-done .step-title {
  color: var(--text-2, #b0b0b0);
}

.chat-step.state-done .step-title strong {
  color: var(--text, #e0e0e0);
}

/* 状态徽章色 */

/* ═══════════════════════════════════════════════════════════
   [toolbar-clean] 工具栏精简 + 清空/运行按钮样式优化
   ═══════════════════════════════════════════════════════════ */

/* 隐藏残留 kbd-hint（防其他位置） */
.tpl-bar .kbd-hint,

/* 清空按钮：幽灵样式，hover 才显形 */

/* 运行按钮：紫描边实底 hover */

/* 图标基线 */

/* tpl-bar 布局：模板 chip 靠左，清空/运行靠右 */

/* ═══════════════════════════════════════════════════════════
   [msg-indent-btns] 用户消息略偏左 + 间距加大 + 按钮精修
   ═══════════════════════════════════════════════════════════ */

/* ─── 用户消息：右侧缩进，视觉偏左 ─── */

/* ─── AI 消息：保持占满 ─── */

/* ─── 消息间距加大 ─── */

/* 消息块内部间距宽松 */

/* 步骤条更宽松 */

/* ─── 按钮精修：统一高度/圆角/字号 ─── */

/* 模板 chip：更圆润 */

/* 清空按钮：幽灵型，加细边框 */

/* 运行/暂停按钮：统一高度 28px */

/* 运行按钮（takeover 态）：紫描边 hover 变实底 */

/* 暂停按钮（stop 态）：紫红描边 + 淡底 */

/* ═══════════════════════════════════════════════════════════
   [step-collapse] 步骤条折叠：默认 desc，点击展开详情
   ═══════════════════════════════════════════════════════════ */

.chat-step .step-caret.open {
  transform: rotate(180deg) !important;
}

/* step-title 单行省略（收起态） */

/* chat-step 展开时 flex-wrap 允许 */
.chat-step.expanded {
  flex-wrap: wrap !important;
}

/* ═══════════════════════════════════════════════════════════
   [linear-ui] Linear / VSCode 风格：中性灰 + 单一紫强调
   覆盖前面所有补丁块，最终生效
   ═══════════════════════════════════════════════════════════ */

/* ─── 全局背景 ─── */

/* [user-req] 主区灰底 */

.chat-step.state-error .step-dot {
  background: var(--danger);
}

/* ─── 用户消息：中性灰卡 + 右侧缩进 ─── */

/* ─── AI 消息：紫边卡 ─── */

/* ─── 等待气泡：紫左竖条 ─── */

/* ─── tpl-bar 工具栏：Linear 风 ─── */

/* ─── 侧栏 tab ─── */

/* ─── 滚动条：Linear 极细 ─── */

/* ═══════════════════════════════════════════════════════════
   [editor-tune] 编辑器背景独立 + 间距收敛 + 字号上调
   ═══════════════════════════════════════════════════════════ */

/* ─── 编辑器区背景：稍亮于整体，形成层次 ─── */
.editor {
  background: var(--surface, var(--surface)) !important;
}

.editor .editor-body,
.editor .cm-host,
.editor .cm-editor,
.editor .cm-scroller,
.editor .cm-gutters {
  background: var(--surface, var(--surface)) !important;
  color: var(--text-2, var(--text-2)) !important;
}

.editor .cm-activeLine {
  background: rgb(255 255 255 / 3%) !important;
}

.editor .cm-activeLineGutter {
  background: rgb(255 255 255 / 3%) !important;
}

/* 焦点时强调 */
.editor:focus-within {
  border-color: rgb(88 166 255 / 50%) !important;
  box-shadow: 0 0 0 3px rgb(88 166 255 / 8%) !important;
}

/* ─── 编辑器字号 ─── */
.editor .cm-content,
.editor .cm-gutters,
.editor .cm-scroller {
  font-size: 12.5px !important;
  line-height: 1.6 !important;
}

/* ─── 终端 / 消息区字号 ─── */

/* ─── 步骤条：字号 + 间距 ─── */

/* ─── 等待气泡字号 ─── */

/* ─── tpl-bar 工具栏字号 ─── */

/* ─── 侧栏字号 ─── */
.pane-side .tree-title,

/* ═══════════════════════════════════════════════════════════
   [lifecycle-css] 生命周期时间线样式
   ═══════════════════════════════════════════════════════════ */
.detail-stages {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0 2px 12px;
  background: transparent;
  border-radius: 0;
  min-width: 0;
  position: relative;
}

@keyframes stage-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.4;
  }
}
/* 展开区行间距 */

/* ═══════════════════════════════════════════════════════════
   [linear-polish] 步骤条 Linear 风：紧凑单行 + 状态圆点 + 弱化时间
   ═══════════════════════════════════════════════════════════ */

/* ─── chat-list 更窄居中 ─── */

/* ─── 步骤条主体：单行紧凑 ─── */

/* 状态色：只涂 dot + state 文字，无背景 */

/* ─── 展开区：Linear 时间线 ─── */

/* ─── 生命周期时间线：竖线连接 ─── */

/* 时间线节点 */
/* ─── 输出 pre：更紧凑 ─── */

/* ═══════════════════════════════════════════════════════════
   [revert-3] 撤销 linear-polish 的三处紧凑化
   ═══════════════════════════════════════════════════════════ */

/* 1. 步骤条 padding 恢复：更大内边距 */

/* 2. 时间：恢复正常透明度 */

/* 3. 输出 pre：恢复正常行高/内边距 */

/* 4. 状态徽章恢复淡底 */

.chat-step.state-pending .step-state {
  background: rgb(255 255 255 / 5%);
  color: var(--text-3, var(--text-3));
}

/* 5. chat-list 恢复原宽 */

/* ═══════════════════════════════════════════════════════════
   [unify-spacing] 消息统一风格 + 加大间距
   ═══════════════════════════════════════════════════════════ */

/* ─── 消息间距加大 ─── */

/* ─── 用户消息：与步骤条同款（中性卡 + 左竖线 + 无紫底）─── */

/* ─── AI 消息：同款（紫左竖线）─── */

.chat-msg-ai .bubble-head {
  color: var(--primary-hover);
  opacity: 0.75;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
  text-align: left;
  padding-bottom: 4px;
  margin-bottom: 4px;
  border-bottom: 0;
  font-size: 11px;
  margin: 0 0 6px 0;
  padding: 0;
  font-weight: 500;
  border-bottom-color: rgb(88 166 255 / 15%);
}

.chat-msg-ai .bubble-body {
  align-self: stretch;
  text-align: left;
  font-size: 12.5px;
  word-break: break-word;
  color: var(--text, var(--text));
  line-height: 1.6;
  padding-left: 0;
}

/* ─── 步骤条：同款间距 ─── */

/* ─── 等待气泡：同款 ─── */

/* ─── 展开区：与卡片内边距对齐 ─── */

/* ═══════════════════════════════════════════════════════════
   [card-bar-style] 卡片样式：粗左竖条 + 无边框 + 时间右对齐
   ═══════════════════════════════════════════════════════════ */

/* ─── 通用卡片基础：无边框 + 圆角 + 无左竖线边框 ─── */

/* 粗左竖条（用伪元素，圆角与卡片一致） */

/* ─── 内容左对齐同一列 ─── */

/* ─── 头行：左信息 + 右时间 ─── */

/* 时间推到右侧 */
.chat-msg-user .bubble-head::after,
.chat-msg-ai .bubble-head::after {
  content: '';
  flex: 1 1 auto;
  order: 0;
}

.chat-msg-user .bubble-head > :last-child,
.chat-msg-ai .bubble-head > :last-child {
  margin-left: auto;
  order: 1;
}

/* ─── 步骤条：标题左 + 时间/状态右 ─── */

/* ─── 消息体字号 ─── */

/* ═══════════════════════════════════════════════════════════
   [time-right-tight] 时间右对齐 + 段间距 0 + AI 消息加背景
   ═══════════════════════════════════════════════════════════ */

/* ─── head：name 左 + time 右 ─── */

.chat-msg-user .bubble-time,
.chat-msg-ai .bubble-time {
  flex: 0 0 auto;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  font-size: 11px;
  color: var(--text-3, #94a3b8);
}

/* ─── 消息体：段落无 margin + 紧凑行高 ─── */
.chat-msg-user .bubble-body .md-p,
.chat-msg-ai .bubble-body .md-p,
.bubble-body .md-p {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  padding: 0;
  line-height: 1.55;
}

.chat-msg-user .bubble-body .md-ul,
.chat-msg-ai .bubble-body .md-ul,
.bubble-body .md-ul {
  margin: 0;
  padding-left: 18px;
  line-height: 1.55;
}

.chat-msg-user .bubble-body p + p,
.chat-msg-ai .bubble-body p + p {
  margin-top: 2px;
}

/* 空 p 不占位 */
.chat-msg-user .bubble-body .md-p:empty,
.chat-msg-ai .bubble-body .md-p:empty {
  display: none;
}

/* ─── AI 消息：明显紫底 + 无边框 ─── */

/* ─── 用户消息：保持中性底色 ─── */

/* ═══════════════════════════════════════════════════════════
   [unified-bg] 所有消息卡统一默认底色
   ═══════════════════════════════════════════════════════════ */

.chat-msg-user::before,
.chat-msg-ai::before,
.chat-step::before,

/* AI 卡强制回默认底 */

.chat-msg-ai .bubble-body strong {
  color: var(--primary-hover);
  font-weight: 600;
}

/* ═══════════════════════════════════════════════════════════
   [toast-style-msg] 消息卡对齐 toast 风：圆图标 + 左竖条 + 圆角卡
   ═══════════════════════════════════════════════════════════ */

/* ─── 图标：紫色圆底 ─── */

/* ─── head 布局：icon + name 左 + time 右 ─── */

.chat-msg-user .bubble-name,
.chat-msg-ai .bubble-name {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--text, var(--surface-2));
  letter-spacing: 0.2px;
}

/* ─── 卡片整体：toast 风（深底 + 圆角 + 左竖条）─── */

/* 左竖条：4px 圆角 */

.chat-msg-user::before {
  background: rgb(88 166 255 / 55%);
}

.chat-msg-ai::before {
  background: var(--primary);
}

.chat-step.state-pending::before {
  background: rgb(255 255 255 / 14%);
}

.chat-step.state-running::before {
  background: var(--primary);
}

.chat-step.state-done::before {
  background: var(--success);
}

.chat-step.state-error::before {
  background: var(--danger);
}

/* ─── 消息体字号 ─── */

/* ═══════════════════════════════════════════════════════════
   [toast-exact] 消息卡逐字复制 ToastHost 的 CSS 值
   参考: ToastHost.vue .toast / .toast-icon
   ═══════════════════════════════════════════════════════════ */

/* ─── 卡片 = .toast ─── */

/* ─── border-left 按类型（对齐 .toast.info / .success / .warn / .error）─── */

/* 清掉旧的伪元素左竖条（toast 用 border-left，不用伪元素） */

.chat-msg-ai .bubble-icon {
  background: var(--primary-bg, var(--primary-hover));
  color: var(--primary, var(--primary));
}

.chat-msg-user .bubble-icon {
  background: var(--primary-bg, var(--primary-hover));
  color: var(--primary, var(--primary));
  align-self: center;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* ─── head：icon + name 左，time 右（横排对齐 .toast display flex gap 10）─── */

/* ─── body：正文 ─── */

/* ─── 步骤条：一行紧凑，对齐 toast 结构 ─── */

/* ─── chat-list 容器 ─── */

/* [chatlist-transparent] chat-list 容器透明无背景 */
.chat-list,

/* [no-shadow] 消息卡去阴影（toast 阴影在满宽长条上变黑影） */

/* [left-border-only] 卡片只留左竖条，其他三边无边框 */

/* [transparent-card] 消息卡背景透明，只保留左竖条 */

/* ═══════════════════════════════════════════════════════════
   [status-bg] 卡片背景 = 半透明状态色
   ═══════════════════════════════════════════════════════════ */

/* 用户消息：淡紫底 */

/* AI 消息：淡紫底（略深） */

/* 等待：淡紫底 */

/* 步骤条：按状态 */

/* ═══════════════════════════════════════════════════════════
   [loading-right] loading 右侧 + 明显旋转圈 + 图标描述居中
   ═══════════════════════════════════════════════════════════ */

/* 步骤条：单行横向，左侧 icon+title，中间空白，右侧 time+loading+state+caret */

/* 隐藏旧 dot */

/* 描述前图标：垂直居中 + 稍大 */

.chat-step .step-icon::before {
  content: '' !important;
}

/* 标题：与 icon 居中对齐 */

/* 时间 */

/* 右侧 loading 旋转圈 */
.chat-step .step-loading {
  flex: 0 0 auto !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 16px !important;
  height: 16px !important;
  color: var(--primary, var(--primary)) !important;
  animation: step-loading-spin 0.9s linear infinite !important;
}

.chat-step .step-loading svg {
  width: 14px !important;
  height: 14px !important;
  display: block !important;
}

@keyframes step-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 状态徽章 */

/* caret */

.chat-step:hover .step-caret {
  opacity: 0.9 !important;
}

/* ═══════════════════════════════════════════════════════════
   [attachments-css] 附件 tag 区
   ═══════════════════════════════════════════════════════════ */
.attach-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, var(--border));
  background: var(--surface-2, var(--surface-2));
  max-height: 120px;
  overflow-y: auto;
}

.attach-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-6);
  background: var(--surface, var(--surface));
  border: 1px solid var(--border, var(--border));
  font-size: 11.5px;
  color: var(--text, var(--text));
  max-width: 260px;
  justify-content: center;
}

.attach-tag.kind-image {
  border-color: rgb(88 166 255 / 30%);
}

.attach-img {
  width: 22px;
  height: 22px;
  object-fit: cover;
  border-radius: var(--radius-4);
  flex-shrink: 0;
  background: rgb(0 0 0 / 20%);
}

.attach-ico {
  font-size: 14px;
  line-height: 1;
}

.attach-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.attach-size {
  flex: 0 0 auto;
  color: var(--text-3, var(--text-3));
  font: 10px/1 var(--mono, monospace);
}

.attach-del {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-3, var(--text-3));
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.attach-del:hover {
  color: var(--danger);
  background: rgb(248 81 73 / 12%);
}

/* [tree-drop-css] 编辑器拖拽高亮 */
.editor.is-dragging {
  border-color: rgb(88 166 255 / 60%) !important;
  box-shadow: 0 0 0 3px rgb(88 166 255 / 12%) !important;
  background: rgb(88 166 255 / 4%) !important;
}

.editor.is-dragging::after {
  content: '松开以附加文件' !important;
  position: absolute !important;
  inset: 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: rgb(88 166 255 / 8%) !important;
  color: var(--primary-hover) !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  pointer-events: none !important;
  z-index: 10 !important;
  border-radius: inherit !important;
}

/* ═══════════════════════════════════════════════════════════
   [inline-loading] 提问卡内联 loading + 附件 tag 居中
   ═══════════════════════════════════════════════════════════ */

/* ─── 用户卡 body 内联 loading ─── */

.chat-msg-user .bubble-text {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  word-break: break-word;
  color: var(--text, var(--text));
}

.chat-msg-user .bubble-text > p {
  display: inline;
  margin: 0;
}

.chat-msg-user .bubble-loading {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--primary);
  animation: bubble-loading-spin 0.9s linear infinite;
}

.chat-msg-user .bubble-loading svg {
  width: 13px;
  height: 13px;
  display: block;
}

@keyframes bubble-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ─── 附件 tag 内容居中（图标 + 名 + 大小 + 删除）─── */

.attach-tag .attach-ico,
.attach-tag .attach-img {
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.attach-tag .attach-name,
.attach-tag .attach-size,
.attach-tag .attach-del {
  align-self: center;
  line-height: 1.2;
}

/* ─── 用户卡 head 图标与文字垂直居中 ─── */

.chat-msg-user .bubble-name,
.chat-msg-user .bubble-time {
  line-height: 1.2;
}

/* [step-vertical-center] 步骤条图标/文字/时间/状态垂直居中 */

.chat-step .step-icon,
.chat-step .step-dot {
  width: 5px !important;
  height: 5px !important;
  border-radius: var(--radius-full);
  background: #6a737d;
  flex-shrink: 0;
  margin-top: 4px !important;
  display: inline-flex !important;
  flex: 0 0 auto !important;
  align-self: center !important;
  align-items: center !important;
  justify-content: center !important;
  line-height: 1 !important;
  margin: 0 !important;
  padding: 0 !important;
}

.chat-step.expanded .step-title {
  white-space: normal !important;
  overflow: visible !important;
  text-overflow: clip !important;
  display: block !important;
}

.chat-step .step-time,
.chat-step .step-state,
.chat-step .step-caret {
  flex: 0 0 auto !important;
  font-size: 9px !important;
  color: var(--text-3, var(--text-3)) !important;
  margin-left: 2px !important;
  margin-top: 0 !important;
  transition: transform 0.15s ease !important;
  opacity: 0.4 !important;
  margin: 0 !important;
  align-self: center !important;
  line-height: 1.2 !important;
}

/* ═══════════════════════════════════════════════════════════
   [msg-dark-bg] 聊天卡片背景统一深灰黑
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   [editor-tight] 编辑器边距收窄 + 圆角
   ═══════════════════════════════════════════════════════════ */

/* 编辑器卡片圆角 + 顶部圆角 */

/* 顶栏收窄 */
.editor .editor-bar,
.editor .tpl-chip {
  padding: 2px 8px !important;
  font-size: 11px !important;
}

.editor .editor-bar .bar-actions {
  gap: 4px !important;
}

/* 编辑器内容区收窄 */
.editor .editor-body,
.editor .cm-host {
  padding: 0 !important;
  margin: 0 !important;
}

/* CodeMirror 内容内边距 */
.editor .cm-content {
  background: var(--surface, var(--surface)) !important;
  padding: 8px 12px !important;
}

.editor .cm-lineNumbers .cm-gutterElement {
  padding: 0 8px 0 4px !important;
  min-width: 36px !important;
  font-size: 11px !important;
}

/* 底栏收窄 */
.editor .editor-foot {
  padding: 3px 10px !important;
}

/* [tight-margin-sp] 内层容器边距收窄 */

/* ═══════════════════════════════════════════════════════════
   [ui-polish-v4] 4 项微调
   ═══════════════════════════════════════════════════════════ */

/* 1. 编辑框 ↔ 树 边距收窄 */

/* 树容器只留左细线，不占空 */

/* 2. 按钮 hover 统一（所有按钮过渡 + 暖橙描边反馈） */
.primary-btn,
.ghost-btn,
.loop-btn,
.tpl-chip,
.draft-select,
.side-tab,
.refresh,
.undo-btn,
.save-btn {
  transition:
    background 0.14s ease,
    color 0.14s ease,
    border-color 0.14s ease,
    opacity 0.14s ease !important;
}

/* 灰阶次按钮 hover 加暖橙字色 */
.ghost-btn:hover:not(:disabled),
.loop-btn:hover:not(:disabled),
.tpl-chip:hover,

/* 运行 / 主操作 hover 轻微提亮 */
.primary-btn.takeover:hover:not(:disabled),
.primary-btn.run:hover:not(:disabled) {
  background: rgb(217 119 87 / 14%);
  color: var(--primary);
  border-color: var(--primary);
  box-shadow: none;
}

/* 3. loop-btn 里 icon + 文字间距 */

/* 4. 输入器 header 加 padding */

.editor .tpl-bar {
  padding: 5px 12px !important;
  gap: 4px !important;
}

/* ═══════════════════════════════════════════════════════════
   [fix-run-btn] 最后生效：运行按钮各态锁死 + 取消按钮图标显式
   ═══════════════════════════════════════════════════════════ */

/* 运行按钮（takeover / run / head-run）：全部锁死为透明底 + 橙描边 */
.pane-main .editor .primary-btn.head-run,
.pane-main .editor .primary-btn.takeover,

.pane-main .editor .primary-btn.head-run:hover:not(:disabled),
.pane-main .editor .primary-btn.takeover:hover:not(:disabled),
.pane-main .editor .primary-btn.run:hover:not(:disabled),
.pane-main .editor .primary-btn.head-run:focus-visible,
.pane-main .editor .primary-btn.takeover:focus-visible,

/* 按钮里 icon 和文字保持可见 */
.pane-main .editor .primary-btn.head-run .ico-svg,
.pane-main .editor .primary-btn.takeover .ico-svg,
.pane-main .editor .primary-btn.run .ico-svg,
.pane-main .editor .primary-btn.head-run span,
.pane-main .editor .primary-btn.takeover span,

/* 暂停（stop 态）：红描边 */
.pane-main .editor .primary-btn.stop,

.pane-main .editor .primary-btn.stop .ico-svg,

/* 禁用态：稍微降不透明度，仍可读 */
.pane-main .editor .primary-btn.head-run:disabled,
.pane-main .editor .primary-btn.takeover:disabled,
.pane-main .editor .primary-btn.run:disabled,

/* 取消按钮图标显式可见 */
/* ═══════════════════════════════════════════════════════════
   [ghost-nowrap] ghost-btn 硬锁横排
   ═══════════════════════════════════════════════════════════ */

.ghost-btn > .ico-svg,
.ghost-btn > svg {
  display: inline-block;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin: 0;
  vertical-align: middle;
  fill: none;
  stroke: currentColor;
}

.ghost-btn > span {
  display: inline-block;
  white-space: nowrap;
}

/* [live-typewriter] terminal 内打字机实时输出 */

@keyframes live-cursor-blink {
  50% {
    opacity: 0;
  }
}

/* [terminal-status] 循环状态条 + 服务端调用日志 */

@keyframes flow-spin {
  to {
    transform: rotate(360deg);
  }
}

/* [script-meta-row] 脚本元信息第二行 */

/* [flow-spinner-v2] 流程 loading 视觉优化 */

.meta-row:empty,

/* [flow-tag-v3] flow-timeline 去底、去边框；tag 显"阶段名 + 状态" */

/* [meta-row-v2] 脚本元信息卡片美化 */

/* ─── 拖拽条：极细 + hover 显色 ─── */
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

/* ═══════════════════════════════════════════════════════════
   [tpl-bar-final] 编辑器工具栏权威样式（覆盖此前所有 patch）
   设计：与 header 一致 - surface 背景 + border-b + 8px padding
   ═══════════════════════════════════════════════════════════ */

.tpl-bar .ghost-btn,

/* ═══════════════════════════════════════════════════════════
   [editor-foot-final] 编辑器底栏权威样式
   ═══════════════════════════════════════════════════════════ */

.editor-foot .persist-warning,
.editor-foot .req-err-badge,
.editor-foot .dry-badge,

/* ═══════════════════════════════════════════════════════════
   [chat-final] chat 区权威样式
   参考：One Dark Pro / Claude / ChatGPT 聊天 UI
   ═══════════════════════════════════════════════════════════ */

/* ─── 用户消息（右对齐） ─── */
.chat-msg-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.chat-msg-user .bubble-head {
  font-size: 11px;
  color: var(--text-3);
  padding: 0 4px;
  margin: 0;
}

.chat-msg-user .bubble-body {
  background: var(--primary-bg);
  border: 1px solid rgb(88 166 255 / 28%);
  border-radius: var(--radius-10) 10px 2px 10px;
  padding: 8px 12px;
  max-width: 75%;
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}

/* ─── AI 消息（左对齐） ─── */
.chat-msg-ai {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
}

.chat-msg-ai .bubble-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
  padding: 0 4px;
  margin: 0;
}

.chat-msg-ai .bubble-body {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-10) 10px 10px 2px;
  padding: 10px 14px;
  max-width: 100%;
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  width: 100%;
}

/* ─── 步骤条（chat-step） ─── */
.chat-step {
  display: flex !important;
  flex-direction: row !important;
  align-items: flex-start !important;
  gap: 8px !important;
  padding: 6px 10px !important;
  background: transparent !important;
  border: 0 !important;
  border-left: 2px solid var(--border) !important;
  border-radius: 0 !important;
  font-size: 12px !important;
  color: var(--text-3) !important;
  transition: border-color 0.15s !important;
}

.chat-step:hover {
  background: rgb(201 209 217 / 3%) !important;
}

.chat-step.state-running {
  border-left-color: var(--primary);
  color: var(--text-2);
}

.chat-step.state-done {
  border-left-color: var(--success);
}

.chat-step.state-error {
  border-left-color: var(--danger);
}

.chat-step .step-dot {
  display: none !important;
}

.chat-step .step-icon,
.chat-step .step-caret {
  flex-shrink: 0 !important;
  font-size: 12px !important;
  line-height: 1.5 !important;
  color: inherit !important;
}

.chat-step .step-title {
  flex: 1 !important;
  min-width: 0 !important;
  color: inherit !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}

.chat-step .step-state {
  flex-shrink: 0 !important;
  font-size: 11px !important;
  color: var(--text-3) !important;
}

.chat-step .step-time {
  flex-shrink: 0 !important;
  font-size: 10px !important;
  color: var(--text-3) !important;
  opacity: 0.6 !important;
  font-family: var(--mono, monospace) !important;
}

/* ─── 代码块（md-code） ─── */
.md-code {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-6);
  overflow: hidden;
  margin: 8px 0;
}

.md-code summary {
  list-style: none;
  cursor: pointer;
}

.md-code summary::-webkit-details-marker {
  display: none;
}

.md-code-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--mono, monospace);
}

.md-code-lang {
  font-size: 11px;
  color: var(--text-3);
}

.md-code-acts {
  display: flex;
  gap: 4px;
}

.md-code-acts button {
  padding: 2px 8px;
  font-size: 10px;
  color: var(--text-3);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-4);
  cursor: pointer;
  transition: 0.15s;
}

.md-code-acts button:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-bg);
}

.md-code pre {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  background: var(--bg);
  color: var(--text);
  font: 12px/1.55 var(--mono, monospace);
}

/* ─── 行内元素 ─── */
.bubble-body code:not(.md-code pre code) {
  padding: 1px 6px;
  background: var(--surface-3, rgb(48 54 61));
  color: var(--primary-hover);
  border-radius: var(--radius-4);
  font-size: 12px;
}

.bubble-body .md-h {
  margin: 12px 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.bubble-body .md-p {
  margin: 6px 0;
  line-height: 1.7;
}

.bubble-body .md-ul {
  margin: 6px 0;
  padding-left: 20px;
}

.bubble-body strong {
  color: var(--text);
  font-weight: 700;
}

/* ─── 实时流（打字机） ─── */

@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* ─── 空态（tree-empty） ─── */

/* [user-req] flow-timeline 背景透明 */

/* [user-req] flow-timeline 背景透明 */

/* ═══════════════════════════════════════════════════════════
   [left-unify] 左侧主区权威样式
   设计语言：Trae / Cursor / VS Code 深色一致
   ═══════════════════════════════════════════════════════════ */

/* ── 主区容器 ─────────────────────────────────────────────── */
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

/* ── 顶部 flow-timeline（步骤条） ────────────────────────── */
.flow-timeline {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 8px 16px !important;
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
  font-size: 11px !important;
  min-height: 36px !important;
}

.flow-step {
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 3px 10px !important;
  border-radius: var(--radius-12) !important;
  background: var(--surface-2) !important;
  border: 1px solid var(--border) !important;
  color: var(--text-3) !important;
  font-size: 11px !important;
  line-height: 1.4 !important;
  transition: all 0.15s ease !important;
}

.flow-step.run {
  background: rgb(88 166 255 / 12%) !important;
  border-color: rgb(88 166 255 / 40%) !important;
  color: var(--primary) !important;
}

.flow-step.done {
  background: rgb(63 185 80 / 10%) !important;
  border-color: rgb(63 185 80 / 30%) !important;
  color: var(--success) !important;
}

.flow-step.error {
  background: rgb(248 81 73 / 10%) !important;
  border-color: rgb(248 81 73 / 30%) !important;
  color: var(--danger) !important;
}

.flow-icon {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 12px !important;
  height: 12px !important;
  flex-shrink: 0 !important;
}

.flow-spinner {
  display: inline-block !important;
  width: 10px !important;
  height: 10px !important;
  border: 2px solid currentColor !important;
  border-right-color: transparent !important;
  border-radius: var(--radius-full) !important;
  animation: flow-spin 0.7s linear infinite !important;
}

@keyframes flow-spin {
  to {
    transform: rotate(360deg);
  }
}

.flow-glyph {
  font-size: 12px !important;
  line-height: 1 !important;
}

.flow-label {
  font-family: var(--mono, monospace) !important;
  font-size: 11px !important;
  white-space: nowrap !important;
}

.flow-detail {
  font-size: 10px !important;
  opacity: 0.7 !important;
  font-family: var(--mono, monospace) !important;
}

/* ── 终端区 term-body ──────────────────────────────────────── */
.terminal {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
  background: var(--bg) !important;
}

.term-body {
  display: flex !important;
  flex-direction: column !important;
  gap: 0 !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
}

/* ── ts-bar（循环状态条） ────────────────────────────────── */
.ts-bar {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 6px 16px !important;
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  font-family: var(--mono, monospace) !important;
  font-size: 11px !important;
  color: var(--text-3) !important;
  flex-shrink: 0 !important;
}

.ts-bar:empty {
  display: none !important;
}

.ts-chip {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 2px 8px !important;
  border-radius: var(--radius-4) !important;
  background: rgb(201 209 217 / 4%) !important;
  border: 1px solid rgb(201 209 217 / 6%) !important;
  color: var(--text-3) !important;
  font-size: 11px !important;
  line-height: 1.4 !important;
  white-space: nowrap !important;
}

.ts-chip b {
  color: var(--text-2) !important;
  font-weight: 600 !important;
  margin-right: 2px !important;
}

.ts-chip.is-active b {
  color: var(--success) !important;
}

/* ── chat-list（消息列表） ───────────────────────────────── */
.chat-list {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 14px !important;
  padding: 16px 24px 24px !important;
  font: 13px/1.65 var(--mono, monospace) !important;
  color: var(--text) !important;
  background: transparent !important;
  max-width: 900px !important;
  margin: 0 auto !important;
  width: 100% !important;
}

/* ── live-stream（打字机） ──────────────────────────────── */
.live-stream {
  display: flex !important;
  flex-direction: column !important;
  gap: 6px !important;
  padding: 10px 14px !important;
  background: var(--surface) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-8) !important;
  margin: 8px 0 !important;
}

.live-pre {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  color: var(--text-2) !important;
  font: 12px/1.55 var(--mono, monospace) !important;
  white-space: pre-wrap !important;
  word-break: break-all !important;
}

.live-pre.err {
  color: var(--danger) !important;
}

.live-cursor {
  display: inline-block !important;
  width: 6px !important;
  height: 12px !important;
  background: var(--primary) !important;
  vertical-align: middle !important;
  margin-left: 2px !important;
  animation: cursor-blink 1s steps(2) infinite !important;
}

@keyframes cursor-blink {
  50% {
    opacity: 0;
  }
}

/* ── 空态 tree-empty ───────────────────────────────────── */
.tree-empty {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 14px !important;
  padding: 40px 24px !important;
  color: var(--text-3) !important;
  text-align: center !important;
  flex: 1 1 0 !important;
}

.empty-title {
  font-size: 14px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
}

.empty-sub {
  font-size: 12px !important;
  color: var(--text-3) !important;
}

.empty-cards {
  display: flex !important;
  flex-wrap: wrap !important;
  justify-content: center !important;
  gap: 10px !important;
  margin-top: 10px !important;
}

.empty-card {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 12px 18px !important;
  min-width: 110px !important;
  background: var(--surface) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-10) !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
  color: var(--text-2) !important;
  font-family: inherit !important;
}

.empty-card:hover {
  border-color: var(--primary) !important;
  background: var(--surface-2) !important;
  color: var(--text) !important;
  transform: translateY(-1px) !important;
}

.empty-card-ico {
  font-size: 20px !important;
  margin-bottom: 4px !important;
  line-height: 1 !important;
}

.empty-card-title {
  font-size: 12px !important;
  font-weight: 600 !important;
  color: var(--text) !important;
}

.empty-card-desc {
  font-size: 10px !important;
  color: var(--text-3) !important;
  line-height: 1.4 !important;
  max-width: 120px !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

/* ── editor（编辑器区） ─────────────────────────────────── */
.editor.card {
  flex: 0 0 300px !important;
  min-height: 0 !important;
  background: var(--surface) !important;
  border-top: 1px solid var(--border) !important;
  border-radius: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

.editor-body {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
  position: relative !important;
}

.cm-host {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  height: 100% !important;
  overflow: hidden !important;
}

/* ── tpl-bar（工具栏） ──────────────────────────────────── */
.tpl-bar {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 8px 14px !important;
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
  min-height: 40px !important;
}

.tpl-chip {
  display: inline-flex !important;
  align-items: center !important;
  padding: 4px 10px !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  color: var(--text-3) !important;
  background: transparent !important;
  border: 1px solid transparent !important;
  border-radius: var(--radius-6) !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
}

.tpl-chip:hover {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border) !important;
}

.tpl-spacer {
  flex: 1 1 auto !important;
  min-width: 8px !important;
}

/* ── meta-row（脚本元信息） ─────────────────────────────── */
.meta-row {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 6px !important;
  padding: 6px 14px !important;
  background: var(--surface-2) !important;
  border-top: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
}

.meta-item {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 2px 8px !important;
  border-radius: var(--radius-4) !important;
  background: var(--surface) !important;
  border: 1px solid var(--border) !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  color: var(--text-3) !important;
  max-width: 100% !important;
}

.meta-item b {
  color: var(--text-2) !important;
  font-weight: 600 !important;
  flex-shrink: 0 !important;
}

.meta-item span {
  color: var(--text-3) !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}

/* ── editor-foot（底栏） ────────────────────────────────── */
.editor-foot {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 6px 14px !important;
  background: var(--surface) !important;
  border-top: 1px solid var(--border) !important;
  flex-shrink: 0 !important;
  min-height: 28px !important;
  font-size: 11px !important;
}

.editor-foot .foot-spacer {
  flex: 1 !important;
  min-width: 8px !important;
}

.editor-foot .persist-warning,
.editor-foot .req-err-badge,
.editor-foot .dry-badge,
.editor-foot .git-after {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  padding: 2px 8px !important;
  border-radius: var(--radius-4) !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  cursor: help !important;
  white-space: nowrap !important;
  line-height: 1.4 !important;
}

.editor-foot .persist-warning {
  color: var(--warning) !important;
  background: var(--warning-bg) !important;
}

.editor-foot .req-err-badge {
  color: var(--danger) !important;
  background: var(--danger-bg) !important;
  font-weight: 600 !important;
}

.editor-foot .dry-badge {
  color: var(--warning) !important;
  background: var(--warning-bg) !important;
}

.editor-foot .git-after {
  color: var(--success) !important;
  background: var(--success-bg) !important;
  font-weight: 600 !important;
}

/* ── file-picker（@ 文件选择器） ────────────────────────── */
.file-picker {
  position: absolute !important;
  z-index: 100 !important;
  min-width: 280px !important;
  max-width: 480px !important;
  max-height: 240px !important;
  background: var(--surface-2) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-8) !important;
  box-shadow: 0 8px 24px rgb(0 0 0 / 40%) !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

.fp-input {
  padding: 8px 12px !important;
  border: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  background: transparent !important;
  color: var(--text) !important;
  font: 12px/1.4 var(--mono, monospace) !important;
  outline: 0 !important;
}

.fp-list {
  overflow-y: auto !important;
  padding: 4px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 1px !important;
}

.fp-item {
  padding: 5px 10px !important;
  border-radius: var(--radius-4) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  color: var(--text-2) !important;
  cursor: pointer !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

.fp-item:hover,
.fp-item.active {
  background: var(--primary-bg) !important;
  color: var(--primary) !important;
}

.fp-empty {
  padding: 12px !important;
  text-align: center !important;
  color: var(--text-3) !important;
  font-size: 12px !important;
}

/* ── 拖拽浮层 overlay ──────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════
   [tplbar-btn-final] 工具栏按钮权威样式
   ═══════════════════════════════════════════════════════════ */

.tpl-bar .ghost-btn,
.tpl-bar .primary-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  height: 28px !important;
  min-width: 28px !important;
  padding: 0 10px !important;
  border-radius: 6px !important;
  border: 1px solid transparent !important;
  background: transparent !important;
  color: var(--text-3) !important;
  font-size: 12px !important;
  font-family: inherit !important;
  font-weight: 500 !important;
  line-height: 1 !important;
  cursor: pointer !important;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s !important;
  white-space: nowrap !important;
  flex-shrink: 0 !important;
}

.tpl-bar .ghost-btn:hover:not(:disabled),
.tpl-bar .primary-btn:hover:not(:disabled) {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border) !important;
}

.tpl-bar .ghost-btn:disabled,
.tpl-bar .primary-btn:disabled {
  opacity: 0.35 !important;
  cursor: not-allowed !important;
}

.tpl-bar .ghost-btn > svg,
.tpl-bar .ghost-btn > .ico-svg,
.tpl-bar .primary-btn > svg,
.tpl-bar .primary-btn > .ico-svg {
  display: inline-block !important;
  width: 14px !important;
  height: 14px !important;
  flex-shrink: 0 !important;
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 2 !important;
}

.tpl-bar .ghost-btn > span,
.tpl-bar .primary-btn > span {
  display: inline-block !important;
  white-space: nowrap !important;
  line-height: 1 !important;
}

.tpl-bar .ghost-btn.ghost,
.tpl-bar .ghost-btn.head-run {
  color: var(--text-2) !important;
}

.tpl-bar .ghost-btn.ghost:hover:not(:disabled),
.tpl-bar .ghost-btn.head-run:hover:not(:disabled) {
  color: var(--text) !important;
  background: var(--surface-2) !important;
  border-color: var(--border-2) !important;
}

.tpl-bar .primary-btn.stop,
.tpl-bar .primary-btn.stop.head-run {
  color: var(--primary) !important;
  border-color: var(--primary) !important;
  background: transparent !important;
  font-weight: 600 !important;
}

.tpl-bar .primary-btn.stop:hover:not(:disabled),
.tpl-bar .primary-btn.stop.head-run:hover:not(:disabled) {
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  background: var(--primary-bg) !important;
}

.tpl-bar .primary-btn.cancel {
  color: var(--danger) !important;
  border-color: var(--danger) !important;
}

.tpl-bar .skill-trigger {
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
  height: 28px !important;
  padding: 0 10px 0 8px !important;
  border-radius: 6px !important;
  border: 1px solid var(--border) !important;
  background: var(--surface-2) !important;
  color: var(--text-2) !important;
  font-size: 12px !important;
  font-family: inherit !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
  flex-shrink: 0 !important;
}

.tpl-bar .skill-trigger:hover {
  color: var(--text) !important;
  border-color: var(--border-2) !important;
}

.tpl-bar .skill-trigger-label {
  display: inline-block !important;
  color: inherit !important;
  white-space: nowrap !important;
}

.tpl-bar .skill-badge {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 18px !important;
  height: 18px !important;
  padding: 0 5px !important;
  border-radius: 10px !important;
  background: var(--primary) !important;
  color: var(--bg) !important;
  font-size: 10px !important;
  font-weight: 700 !important;
  font-family: var(--mono, monospace) !important;
  line-height: 1 !important;
}

.tpl-bar .skill-badge-empty {
  background: var(--surface) !important;
  color: var(--text-3) !important;
  box-shadow: inset 0 0 0 1px var(--border) !important;
}

.tpl-bar .skill-count {
  display: inline-block !important;
  color: var(--text-3) !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  margin-left: 2px !important;
}

.tpl-bar .tpl-chip {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  height: 26px !important;
  padding: 0 12px !important;
  border-radius: 6px !important;
  border: 1px solid transparent !important;
  background: transparent !important;
  color: var(--text-3) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
  flex-shrink: 0 !important;
}

.tpl-bar .tpl-chip:hover {
  color: var(--text) !important;
  background: var(--surface-2) !important;
}

.tpl-bar .tpl-spacer {
  flex: 1 1 auto !important;
  min-width: 12px !important;
}

.tpl-bar .kbd-hint {
  flex-shrink: 0 !important;
  color: var(--text-3) !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  opacity: 0.6 !important;
}

/* [btnforce] tpl-bar 按钮终极覆盖——必须放最尾 */
.tpl-bar button.ghost-btn,
.tpl-bar button.primary-btn,
.tpl-bar button.tpl-chip,
.tpl-bar button.skill-trigger {
  display: inline-flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  white-space: nowrap !important;
  word-break: keep-all !important;
  writing-mode: horizontal-tb !important;
  height: 28px !important;
  line-height: 1 !important;
  padding: 0 10px !important;
  box-sizing: border-box !important;
  vertical-align: middle !important;
}

.tpl-bar button.ghost-btn > svg,
.tpl-bar button.primary-btn > svg,
.tpl-bar button.skill-trigger > svg,
.tpl-bar button.ghost-btn > .ico,
.tpl-bar button.primary-btn > .ico,
.tpl-bar button.ghost-btn > .ico-svg,
.tpl-bar button.primary-btn > .ico-svg {
  display: inline-block !important;
  width: 14px !important;
  height: 14px !important;
  flex: 0 0 14px !important;
  margin: 0 !important;
  padding: 0 !important;
  vertical-align: middle !important;
  stroke: currentColor !important;
  fill: none !important;
}

.tpl-bar button.ghost-btn > span,
.tpl-bar button.primary-btn > span,
.tpl-bar button.skill-trigger > span {
  display: inline-block !important;
  flex: 0 0 auto !important;
  white-space: nowrap !important;
  line-height: 1 !important;
  margin: 0 !important;
  padding: 0 !important;
}

/* [btnfix2] tpl-bar 按钮最后一层——用属性选择器 + 高优先级 */
.tpl-bar button.ghost-btn,
.tpl-bar button.primary-btn,
.tpl-bar button.skill-trigger {
  display: inline-flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  width: auto !important;
  min-width: auto !important;
  max-width: none !important;
  height: 28px !important;
  white-space: nowrap !important;
  overflow: visible !important;
  box-sizing: border-box !important;
  padding: 0 10px !important;
  line-height: 1 !important;
}

/* 强制子元素不堆叠 */
.tpl-bar button.ghost-btn > *,
.tpl-bar button.primary-btn > *,
.tpl-bar button.skill-trigger > * {
  display: inline-flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: center !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  flex-shrink: 0 !important;
  white-space: nowrap !important;
  vertical-align: middle !important;
  line-height: 1 !important;
}

/* SVG 图标固定尺寸 */
.tpl-bar button.ghost-btn > svg,
.tpl-bar button.primary-btn > svg,
.tpl-bar button.skill-trigger > svg {
  width: 14px !important;
  height: 14px !important;
  flex: 0 0 14px !important;
  stroke: currentColor !important;
  fill: none !important;
}

/* 文字 span 不换行 */
.tpl-bar button.ghost-btn > span,
.tpl-bar button.primary-btn > span,
.tpl-bar button.skill-trigger > span {
  display: inline-block !important;
  flex: 0 0 auto !important;
  width: auto !important;
  white-space: nowrap !important;
  color: inherit !important;
  font-size: 12px !important;
}

/* ═══════════════════════════════════════════════════════════
   [vlayout] flow-timeline 竖排 + terminal 背景透明
   ═══════════════════════════════════════════════════════════ */

/* 1. 背景透明：terminal / term-body / flow-timeline 及子级 */
.terminal,
.term-body,
.flow-timeline {
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
}

/* 2. flow-timeline 内容：从横排改竖排 */
.flow-timeline {
  display: flex !important;
  flex-direction: column !important;
  flex-wrap: nowrap !important;
  align-items: stretch !important;
  gap: 6px !important;
  padding: 12px 16px !important;
  border-bottom: 1px solid var(--border) !important;
  min-height: auto !important;
}

/* 3. 每个 flow-step 铺满整行 */
.flow-step {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: 8px !important;
  padding: 6px 10px !important;
  width: 100% !important;
  border-radius: var(--radius-6) !important;
}

/* 4. term-body / chat-list 布局 */
.term-body {
  display: flex !important;
  flex-direction: column !important;
  gap: 0 !important;
}

/* ═══════════════════════════════════════════════════════════
   [vlayout-flex] 竖排后 chat-list 撑满
   ═══════════════════════════════════════════════════════════ */

/* flow-timeline 撑满 terminal */
.flow-timeline {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
}

/* flow-step / term-body 固定高度（按内容） */
.flow-step {
  flex: 0 0 auto !important;
}

.term-body {
  flex: 0 0 auto !important;
}

.term-body:empty {
  display: none !important;
}

/* chat-list 撑满剩余 */
.chat-list {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow-y: auto !important;
}

/* [single-stage] 单阶段显示：去外框 */
.flow-timeline .flow-step {
  background: transparent !important;
  border: 0 !important;
  padding: 8px 12px !important;
  border-radius: 0 !important;
  font-size: 12px !important;
  color: var(--text-2) !important;
  gap: 10px !important;
}
.flow-timeline .flow-step.run {
  color: var(--primary) !important;
}
.flow-timeline .flow-step.ok {
  color: var(--success) !important;
}
.flow-timeline .flow-step.err {
  color: var(--danger) !important;
}
.flow-timeline .flow-step .flow-icon {
  font-size: 14px !important;
  width: 16px !important;
  height: 16px !important;
}
.flow-timeline .flow-step .flow-label {
  font-size: 12px !important;
}

/* ═══════════════════════════════════════════════════════════
   [left-out] 脚本输出区：贴左 + 去边框
   ═══════════════════════════════════════════════════════════ */

/* chat-list 贴左 + 去边距 */
.chat-list {
  padding: 8px 0 8px 12px !important;
  margin: 0 !important;
  max-width: none !important;
  align-items: stretch !important;
  text-align: left !important;
  border: 0 !important;
  border-radius: 0 !important;
}

/* live-stream 去卡片外壳 */
.live-stream {
  padding: 0 !important;
  margin: 0 !important;
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
}

/* live-pre 贴左，保留色（不覆盖 color / font） */
.live-pre {
  padding: 0 !important;
  margin: 0 !important;
  background: transparent !important;
  border: 0 !important;
  text-align: left !important;
  font-family: var(--mono, monospace) !important;
  font-size: 12px !important;
  line-height: 1.55 !important;
  white-space: pre-wrap !important;
  word-break: break-all !important;
}

/* 输出里所有元素贴左 */
.chat-list > *,
.live-stream > * {
  margin-left: 0 !important;
  text-align: left !important;
}

/* [head-meta-style] 顶部 script-header + 输出着色 */
.script-header {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 4px 0 8px 0 !important;
  border-bottom: 1px solid var(--border) !important;
  margin-bottom: 6px !important;
}

.script-header .sm-item {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  color: var(--text-2) !important;
  background: var(--surface-2) !important;
  border: 1px solid var(--border) !important;
  border-radius: 4px !important;
  padding: 2px 6px !important;
  max-width: 320px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
.script-header .sm-item b {
  color: var(--text-3) !important;
  font-weight: 600 !important;
  flex-shrink: 0 !important;
}
.script-header .sm-item em {
  color: var(--text) !important;
  font-style: normal !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
.script-header .sm-state {
  display: inline-flex !important;
  align-items: center !important;
  margin-left: auto !important;
  padding: 2px 8px !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  font-weight: 600 !important;
  border-radius: 10px !important;
  background: var(--surface-2) !important;
  color: var(--text-3) !important;
  border: 1px solid var(--border) !important;
}
.script-header .sm-state.is-waiting,
.script-header .sm-state.is-executing,
.script-header .sm-state.is-parsing,
.script-header .sm-state.is-feedback {
  color: var(--primary) !important;
  border-color: var(--primary) !important;
  background: var(--primary-bg) !important;
}
.script-header .sm-state.is-done {
  color: var(--success) !important;
  border-color: var(--success) !important;
  background: var(--success-bg) !important;
}
.script-header .sm-state.is-interrupted,
.script-header .sm-state.is-stopped,
.script-header .sm-state.is-budget-limited {
  color: var(--danger) !important;
  border-color: var(--danger) !important;
  background: var(--danger-bg) !important;
}

/* 输出着色 */
.live-pre .out-step {
  color: var(--primary) !important;
  font-weight: 600 !important;
}
.live-pre .out-ok {
  color: var(--success) !important;
}
.live-pre .out-err {
  color: var(--danger) !important;
}
.live-pre .out-warn {
  color: var(--warning) !important;
}

/* [top-row] 顶部横排一行 */
.flow-timeline {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: 8px !important;
  padding: 8px 14px !important;
  border-bottom: 1px solid var(--border) !important;
  min-height: 36px !important;
  overflow-x: auto !important;
  overflow-y: hidden !important;
  background: transparent !important;
}

.flow-timeline .script-header {
  display: inline-flex !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  flex: 0 0 auto !important;
}

.flow-timeline .script-header .sm-state {
  margin-left: 0 !important;
}

.flow-timeline .script-header .sm-time {
  display: inline-flex !important;
  align-items: center !important;
  padding: 2px 8px !important;
  font-size: 11px !important;
  font-family: var(--mono, monospace) !important;
  color: var(--text-3) !important;
  background: var(--surface-2) !important;
  border: 1px solid var(--border) !important;
  border-radius: 4px !important;
}

.flow-timeline .flow-step {
  display: inline-flex !important;
  flex: 0 0 auto !important;
  width: auto !important;
  padding: 4px 10px !important;
  background: transparent !important;
  border: 0 !important;
  color: var(--text-2) !important;
  font-size: 12px !important;
  gap: 8px !important;
}
.flow-timeline .flow-step.run {
  color: var(--primary) !important;
}
.flow-timeline .flow-step.ok {
  color: var(--success) !important;
}
.flow-timeline .flow-step.err {
  color: var(--danger) !important;
}

.flow-timeline .flow-icon {
  font-size: 14px !important;
  width: 16px !important;
  height: 16px !important;
  flex-shrink: 0 !important;
}

/* [loading-spin] 加载动画 + 空态居中 */
.script-header .sm-loading {
  display: inline-block !important;
  width: 12px !important;
  height: 12px !important;
  border: 2px solid var(--border-2) !important;
  border-top-color: var(--primary) !important;
  border-radius: 50% !important;
  animation: sm-spin 0.7s linear infinite !important;
  flex-shrink: 0 !important;
}

@keyframes sm-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 空态强制居中 */
.chat-list .tree-empty {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  margin: auto !important;
  padding: 40px 24px !important;
  gap: 16px !important;
}

.chat-list .tree-empty .empty-title {
  font-size: 15px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
}

.chat-list .tree-empty .empty-sub {
  font-size: 12px !important;
  color: var(--text-3) !important;
}

.chat-list .tree-empty .empty-cards {
  display: flex !important;
  flex-wrap: wrap !important;
  justify-content: center !important;
  gap: 10px !important;
  margin-top: 8px !important;
}

/* [dot-icon] flow-step 图标改圆点 + 内容居中 */
.flow-timeline {
  justify-content: center !important;
  align-items: center !important;
}

/* 隐藏 emoji，用圆点替代 */
.flow-timeline .flow-icon,
.flow-timeline .flow-spinner,
.flow-timeline .flow-glyph {
  font-size: 0 !important;
  line-height: 0 !important;
  width: 8px !important;
  height: 8px !important;
  min-width: 8px !important;
  position: relative !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  overflow: hidden !important;
  border: 0 !important;
  background: transparent !important;
}

.flow-timeline .flow-icon::before,
.flow-timeline .flow-glyph::before {
  content: '' !important;
  display: block !important;
  width: 6px !important;
  height: 6px !important;
  border-radius: 50% !important;
  background: currentColor !important;
  opacity: 0.55 !important;
}

.flow-timeline .flow-step.run .flow-icon::before,
.flow-timeline .flow-step.run .flow-glyph::before {
  opacity: 1 !important;
  box-shadow: 0 0 6px currentColor !important;
  animation: dot-pulse 1.4s ease-in-out infinite !important;
}

.flow-timeline .flow-step.ok .flow-icon::before,
.flow-timeline .flow-step.ok .flow-glyph::before {
  opacity: 1 !important;
}

.flow-timeline .flow-step.err .flow-icon::before,
.flow-timeline .flow-step.err .flow-glyph::before {
  opacity: 1 !important;
}

@keyframes dot-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.7);
    opacity: 0.6;
  }
}

/* spinner 元素若存在也变圆点 */
.flow-timeline .flow-spinner {
  border: 0 !important;
  animation: dot-pulse 1.4s ease-in-out infinite !important;
}

/* flow-step 内部水平垂直居中 */
.flow-timeline .flow-step {
  align-items: center !important;
  justify-content: center !important;
}

/* script-header 内元素垂直居中 */
.flow-timeline .script-header {
  align-items: center !important;
  justify-content: center !important;
}

/* [layout-final] flow-timeline 竖排：header/step 居中，chat-list 撑满贴左 */
.flow-timeline {
  display: flex !important;
  flex-direction: column !important;
  flex-wrap: nowrap !important;
  align-items: stretch !important;
  justify-content: flex-start !important;
  gap: 0 !important;
  padding: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  min-height: 0 !important;
  overflow: hidden !important;
  background: transparent !important;
  flex: 1 1 0 !important;
}

/* script-header：整行 + 内容居中 */
.flow-timeline .script-header {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 8px !important;
  padding: 8px 14px !important;
  margin: 0 !important;
  border: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  flex: 0 0 auto !important;
  width: 100% !important;
}

/* flow-step：整行 + 内容居中 */
.flow-timeline .flow-step {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 8px !important;
  padding: 6px 14px !important;
  margin: 0 !important;
  border: 0 !important;
  flex: 0 0 auto !important;
  width: 100% !important;
  background: transparent !important;
}

/* term-body：整行，无内容时隐藏 */
.flow-timeline .term-body {
  display: flex !important;
  flex-direction: column !important;
  flex: 0 0 auto !important;
  width: 100% !important;
  padding: 0 !important;
  margin: 0 !important;
}

/* chat-list：撑满剩余，内容贴左 */
.flow-timeline .chat-list {
  display: flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  justify-content: flex-start !important;
  text-align: left !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  width: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 10px 14px !important;
  gap: 8px !important;
  overflow-y: auto !important;
  background: transparent !important;
}

/* 空态：居中 */
.flow-timeline .chat-list .tree-empty {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  margin: auto !important;
  width: 100% !important;
  padding: 40px 24px !important;
}

/* 输出：贴左 */
.flow-timeline .chat-list .live-stream {
  align-self: stretch !important;
  text-align: left !important;
  margin: 0 !important;
}
.flow-timeline .chat-list .live-pre {
  text-align: left !important;
  padding: 0 !important;
  margin: 0 !important;
}

.draft-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-bottom: 1px solid var(--border, rgb(255 255 255 / 8%));
}
.draft-btn {
  padding: 0 6px;
  min-width: 22px;
  height: 20px;
  line-height: 1;
}

/* [ui-opt-p0] 空状态增强 + 草稿栏收紧 */
/* 空状态：视觉加强 —— 卡片更大、图标更醒目、留白更足 */
.chat-list .tree-empty {
  padding: 64px 24px !important;
  gap: 24px !important;
}
.chat-list .tree-empty .empty-title {
  font-size: 16px !important;
  font-weight: 600 !important;
  letter-spacing: 0.2px;
}
.chat-list .tree-empty .empty-sub {
  font-size: 12.5px !important;
  opacity: 0.9;
}
.chat-list .tree-empty .empty-cards {
  margin-top: 12px !important;
  gap: 14px !important;
}
.chat-list .tree-empty .empty-card {
  padding: 18px 26px !important;
  min-width: 138px !important;
  background: linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%) !important;
  border-color: var(--border-2, var(--border)) !important;
  box-shadow: 0 2px 6px rgb(0 0 0 / 18%);
}
.chat-list .tree-empty .empty-card:hover {
  border-color: var(--primary) !important;
  box-shadow: 0 6px 18px rgb(77 107 254 / 22%);
  transform: translateY(-2px) !important;
}
.chat-list .tree-empty .empty-card-ico {
  font-size: 28px !important;
  margin-bottom: 6px !important;
  filter: drop-shadow(0 2px 6px rgb(0 0 0 / 25%));
}
.chat-list .tree-empty .empty-card-title {
  font-size: 13px !important;
  letter-spacing: 0.3px;
}
.chat-list .tree-empty .empty-card-desc {
  font-size: 11px !important;
  max-width: 140px !important;
}

/* 草稿槽工具栏：视觉收紧（下拉更小、按钮更紧凑） */
.draft-toolbar {
  padding: 4px 10px !important;
  gap: 6px !important;
  border-bottom: 1px solid var(--border) !important;
  background: var(--surface);
}
.draft-toolbar .draft-select {
  padding: 2px 8px !important;
  font-size: 12px !important;
  height: 22px !important;
  border-radius: var(--radius-6) !important;
}
.draft-toolbar .draft-btn {
  height: 22px !important;
  min-width: 22px !important;
  padding: 0 6px !important;
  border-radius: var(--radius-6) !important;
  font-size: 12px !important;
}
</style>
