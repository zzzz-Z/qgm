<script setup lang="ts">
import { useWorklogCommit } from './worklog-commit'
import { useToast } from '../../composables/ui/useToast'
import { TOAST_LONG, TOAST_MEDIUM } from '../../utils/toast-durations'

// @desc VSCode 源码管理风格侧栏：提交框 + 变更文件列表 + 点击预览文件内容
// @why 用户要求把工作日志从弹窗改为 SidePane tab，视觉参照 VSCode 源代码管理面板
// @change-impact 依赖 /__ai/git/worklog 端点；父组件 SidePane 通过 v-show 切换本面板可见性
// 用户要求生成按钮改为"发 git diff 给 AI → 拿回复"；需发送与收包 API

interface WorklogFileEntry {
  path: string
  status: string
  added: number
  removed: number
  diff?: string
}
interface WorklogResult {
  ok: boolean
  reason?: string
  since: string
  until: string
  generatedAt: number
  files: WorklogFileEntry[]
  history: string[]
  stat: string
  markdown: string
}
// [vcs-svn-log-v1] /vcs/log 的返回结构（SVN 提交历史）
interface SvnPathChange {
  /** 单字符动作：A=新增 M=修改 D=删除 R=替换 */
  action: string
  /** file / dir */
  kind: string
  path: string
}
interface SvnLogEntry {
  revision: number
  author: string
  /** ISO8601 UTC */
  date: string
  msg: string
  paths: SvnPathChange[]
}
interface VcsLogResult {
  ok: boolean
  vcs?: string
  reason?: string
  entries?: SvnLogEntry[]
}

const props = defineProps<{ active: boolean }>()

/** [worklog-content-preview-v1] 内容预览浮层；仅打开预览时加载（含 hljs 高亮链） */
const FileContentOverlay = defineAsyncComponent(() => import('../diff/FileContentOverlay.vue'))
// [ui-p2b-skeleton-wire-v2] V6 加载骨架行数/宽度档位（同 FileTree，但样式独立 scoped）
const SKELETON_ROWS = 4
const SKELETON_WIDTHS = ['sk-w-70', 'sk-w-55', 'sk-w-85', 'sk-w-40']
/**
 * 订阅 transport onReply：pendingCommitRequest 为 true 时消费下一条作为 commit message
 * [WHY] 用户要求生成按钮改为'发 git diff 给 AI → 拿回复'；用一次性门控避免拦截其它无关回复
 * [CONSTRAINT] 仅 kind 为 plain/multi/done 且 text 非空时消费；消费后立即关闭门控避免重复触发
 * [CHANGE-IMPACT] 写 aiCommitMsg/commitMsg/aiGenerating；成功后会触发一次 load() 拉取最新状态
 */
let unsubscribeReply: (() => void) | null = null
// [load-seq-guard-v1] 并发 load 序列号：watch / @click / generateCommitMsg 三处可触发，
// 无守卫时旧响应会覆盖新结果（用户快速连点或 AI 生成期间手动刷新均会触发）
let _loadSeq = 0
/** [preview-seq-guard-v1] 与 load 同源：快速切换文件时丢弃过期响应 */
let _previewSeq = 0

const loading = ref(false)
const result = ref<WorklogResult | null>(null)
const error = ref('')
const commitMsg = ref('')
const previewPath = ref<string | null>(null)
/** 预览文件内容；空串表示未加载/文件为空 */
const previewContent = ref('')
const previewLoading = ref(false)
// [git-commit-real-v1] 真实提交：/git/commit-loop 落盘后刷新列表
// [CONSTRAINT] committing 防重复点击；成功后清空消息框
const committing = ref(false)
// [git-head-display-v1] 当前 HEAD（短 sha）；空串时模板隐藏
const headRef = ref('')
// [vcs-svn-log-v1] 版本控制类型：'git' 为乐观默认（git 用户不该看到模式切换的闪烁）；
//   仅当 git 链路失败且 /vcs/log 报 vcs='svn' 时才翻成 'svn'
const vcsMode = ref<'git' | 'svn'>('git')
/** SVN 提交历史（每条含该次提交涉及的路径） */
const svnEntries = ref<SvnLogEntry[]>([])
/** 当前展开的 revision；null 表示全部收起 */
const svnExpanded = ref<number | null>(null)

const { toast } = useToast()
// [use-worklog-commit-v1] commit msg 生成簇已抽到 useWorklogCommit
const {
  aiGenerating,
  aiCommitMsg,
  aiError,
  pendingCommitRequest,
  pendingCommitSid,
  extractCommitLine,
  extractCommitMessage,
  generateCommitMsg,
  cleanup: cleanupWorklogCommit,
} = useWorklogCommit({
  result,
  commitMsg,
  load,
  getError: () => error.value,
  splitPath,
})

// [worklog-rows-v1] 预生成行数据：splitPath / statusLetter / statusClass 每行仅算一次，
// 提交框每输入一字触发重渲染时不再重复调用（报告 §5.1.4）。
// [worklog-rows-template-v1] 预生成行数据：保留 f 全部字段，附加派生的 name/dir/stCls/stLetter。
// [worklog-content-preview-v1] 行数据不再承载展开态：点击改为打开内容预览浮层。
const rows = computed(() => (result.value?.files || []).map((f) => {
  const sp = splitPath(f.path)
  return {
    ...f,
    name: sp.name,
    dir: sp.dir,
    stCls: statusClass(f.status),
    stLetter: statusLetter(f.status),
  }
}))
const changeCount = computed(() => result.value?.files?.length || 0)
// [worklog-stat-v1] 汇总 +/-：分组头展示；数据源同 result.files，与每行数值一致
const addTotal = computed(() => (result.value?.files || []).reduce((s, f) => s + (f.added || 0), 0))
const delTotal = computed(() => (result.value?.files || []).reduce((s, f) => s + (f.removed || 0), 0))

// [worklog-lazy-v1] immediate：组件在 tab 激活时才异步挂载，挂载即 active=true，非 immediate watch 不会触发
watch(() => props.active, (v) => { if (v && !result.value && !loading.value) void load() }, { immediate: true })

onMounted(() => {
  try {
    const t = getTransport()
    unsubscribeReply = t.onReply((raw: unknown, sid: string) => {
      if (!pendingCommitRequest.value) return
      // [worklog-sid-gate-v2] 移除 sid 比对：tampermonkey 回包 sid=sessionId（会话 hash），
      // 而 pendingCommitSid=getActiveWinSid()（槽位 id），两值来源不同必然失配 → 回填永久失效。
      // 一次性 pendingCommitRequest 标志即正确闸门：消费后立即置 false，不会重复触发。
      void sid
      const reply = raw as { kind?: string, text?: string } | null
      if (!reply) return
      const kind = String(reply.kind || 'plain')
      if (kind !== 'plain' && kind !== 'multi' && kind !== 'done') return
      const text = String(reply.text || '').trim()
      if (!text) return
      // [commit-message-multiline-v1] 用多行提取：保留 AI 生成的 body/footer
      const msg = extractCommitMessage(text) || extractCommitLine(text)
      if (!msg) return
      aiCommitMsg.value = msg
      commitMsg.value = msg
      aiGenerating.value = false
      pendingCommitRequest.value = false
      pendingCommitSid.value = ''
      cleanupWorklogCommit()
    })
  } catch { /* transport 未就绪时静默；用户可手动编辑 */ }
})
onUnmounted(() => {
  if (unsubscribeReply) { try { unsubscribeReply() } catch { /* ignore */ } unsubscribeReply = null }
  cleanupWorklogCommit()
})

/** 状态字母与颜色分类：M=modified A=added D=deleted R=renamed C=copied */
function statusLetter(s: string): string {
  if (s === 'added') return 'A'
  if (s === 'deleted') return 'D'
  if (s === 'renamed') return 'R'
  if (s === 'copied') return 'C'
  return 'M'
}
function statusClass(s: string): string {
  if (s === 'added') return 'st-add'
  if (s === 'deleted') return 'st-del'
  if (s === 'renamed' || s === 'copied') return 'st-move'
  return 'st-mod'
}
// ── [vcs-svn-log-v1] SVN 提交历史 ──
/**
 * 探测 VCS 并在确为 SVN 工作副本时接管展示。
 * [WHY] `/git/worklog` 以 gitAvailable() 为前提，非 git 下一律返「非 git 仓库」；
 *   SVN 工作副本要能看到提交记录，必须换用 `/vcs/log`。本函数只在 git 链路失败后被调用。
 * [CONSTRAINT] 必须带 mySeq 校验：内部有 await，期间用户可能已触发新一轮 load，
 *   过期响应不得覆写最新状态。
 * @param mySeq 调用方本次 load 的序号
 * @returns true 表示已按 SVN 模式接管（调用方应立即返回，不要再写 error）
 */
async function probeSvnLog(mySeq: number): Promise<boolean> {
  try {
    const r = await fetch('/__ai/vcs/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 20 }),
    })
    if (mySeq !== _loadSeq) return false
    const j = await r.json().catch(() => ({})) as VcsLogResult
    if (mySeq !== _loadSeq) return false
    if (j.vcs !== 'svn') return false
    vcsMode.value = 'svn'
    svnEntries.value = Array.isArray(j.entries) ? j.entries : []
    // 默认展开最新一次提交：用户打开面板最想看的就是「最近改了什么」
    svnExpanded.value = svnEntries.value.length ? svnEntries.value[0].revision : null
    result.value = null
    error.value = ''
    if (!j.ok) error.value = j.reason || 'svn log 失败'
    return true
  } catch {
    return false
  }
}
/** 展开/收起某次提交的变更文件 */
function toggleSvn(rev: number): void {
  svnExpanded.value = svnExpanded.value === rev ? null : rev
}
/** SVN 的 date 是 ISO8601 UTC；这里转成易读的本地时间 */
function fmtSvnDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** SVN 动作字母 → 配色类（A/M/D/R，语义与 git 侧一致） */
function svnActClass(a: string): string {
  if (a === 'A') return 'st-add'
  if (a === 'D') return 'st-del'
  if (a === 'R') return 'st-move'
  return 'st-mod'
}
function splitPath(p: string): { dir: string, name: string } {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}
/**
 * 打开文件内容预览。
 * [WHY] 取代原先的「点击展开行级 diff」：用户要的是看这个文件现在长什么样
 * [CONSTRAINT] 已删除的文件读回空串，预览区显示为空（git 变更里 deleted 项无内容可看）
 * @param p 文件相对路径
 */
async function openPreview(p: string): Promise<void> {
  const seq = ++_previewSeq
  previewPath.value = p
  previewContent.value = ''
  previewLoading.value = true
  try {
    const r = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [p] }),
    })
    const j = await r.json().catch(() => ({})) as { files?: Array<{ path?: string, content?: string }> }
    if (seq !== _previewSeq) return
    const list = j.files || []
    const hit = list.find(x => x.path === p) || list[0] || {}
    previewContent.value = String(hit.content || '')
  } catch {
    if (seq === _previewSeq) previewContent.value = ''
  } finally {
    if (seq === _previewSeq) previewLoading.value = false
  }
}
async function load(): Promise<void> {
  // [load-seq-guard-v1] 捕获本次请求序号；后续每个 await 后校验，过期即丢弃
  const mySeq = ++_loadSeq
  loading.value = true
  error.value = ''
  try {
    const [wlRes, headRes] = await Promise.all([
      fetch('/__ai/git/worklog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // [worklog-history-v1] 打开提交历史：模板渲染 history 列表
        body: JSON.stringify({ includeHistory: true }),
      }),
      fetch('/__ai/git/head', { cache: 'no-store' }),
    ])
    if (mySeq !== _loadSeq) return
    const j = await wlRes.json().catch(() => ({})) as WorklogResult
    if (mySeq !== _loadSeq) return
    if (!wlRes.ok || !j.ok) {
      // [vcs-svn-log-v1] git 链路不可用 ⇒ 再探测是否为 SVN 工作副本。
      //   刻意只在失败时才多打一次 /vcs/log：git 仓库的正常路径不多请求、不改分支，
      //   保证本次改动对既有 git 行为零影响。
      if (await probeSvnLog(mySeq)) return
      error.value = j.reason || (`HTTP ${wlRes.status}`)
      result.value = null
      return
    }
    // head 独立消费；失败仅清空显示
    try {
      const hj = await headRes.json().catch(() => ({})) as { ok?: boolean, head?: string }
      if (mySeq !== _loadSeq) return
      headRef.value = hj && hj.ok && hj.head ? String(hj.head).slice(0, 12) : ''
    } catch { /* ignore */ }
    if (mySeq !== _loadSeq) return
    result.value = j
  } catch (e) {
    if (mySeq !== _loadSeq) return
    error.value = e instanceof Error ? e.message : String(e)
    result.value = null
  } finally {
    // [load-seq-guard-v1] 仅最新请求负责复位 loading 指示器
    if (mySeq === _loadSeq) loading.value = false
  }
}
/** 提交：调 /git/commit-loop 落盘，成功 toast + 刷新（原实现仅复制剪贴板） */
async function doCommit(): Promise<void> {
  if (!result.value || !commitMsg.value.trim() || committing.value) return
  committing.value = true
  try {
    const r = await fetch('/__ai/git/commit-loop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: commitMsg.value.trim() }),
    })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, commit?: string, empty?: boolean, reason?: string }
    if (!r.ok || !j.ok) {
      toast(j.reason || `提交失败（HTTP ${r.status}）`, 'error', TOAST_LONG)
      return
    }
    if (j.empty) {
      toast('无变更可提交', 'warn', TOAST_MEDIUM)
      return
    }
    toast(`已提交 ${j.commit ? j.commit.slice(0, 8) : ''}`.trim(), 'success', TOAST_MEDIUM)
    commitMsg.value = ''
    await load()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error', TOAST_LONG)
  } finally {
    committing.value = false
  }
}
/** 复制完整工作日志 Markdown，供窄区按钮消费 */
async function copyFullLog(): Promise<void> {
  if (!result.value || !result.value.markdown) return
  try {
    await navigator.clipboard.writeText(result.value.markdown)
    toast('已复制完整工作日志', 'success', TOAST_MEDIUM)
  } catch {
    toast('复制失败：剪贴板不可用', 'error', TOAST_MEDIUM)
  }
}
</script>

<template>
  <div class="wl-pane">
    <!-- [vcs-svn-log-v1] SVN 工作副本：git 专属的提交区整体不可用，替换为只读标识 + 刷新入口
         （刷新必须留在这里：切到 SVN 模式后，原来的刷新按钮随提交行一起被隐藏了） -->
    <div v-if="vcsMode === 'svn'" class="wl-commit">
      <div class="wl-vcs-bar">
        <span class="wl-head-label">SVN</span>
        <span class="wl-vcs-hint">只读 · 提交历史</span>
        <button
          class="wl-commit-refresh"
          type="button"
          :disabled="loading"
          title="刷新提交历史"
          aria-label="刷新提交历史"
          @click="load"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
    </div>
    <!-- [source-control] 顶部：提交消息框 + 生成按钮 + 分体式提交按钮（VSCode 风格） -->
    <div v-else class="wl-commit">
      <!-- [git-head-display-v1] 当前 HEAD：空串时隐藏；有值时显示短 sha 徽章 -->
      <div v-if="headRef" class="wl-head-row">
        <span class="wl-head-label">HEAD</span>
        <code class="wl-head-sha">{{ headRef }}</code>
      </div>
      <div class="wl-commit-row">
        <textarea
          v-model="commitMsg"
          class="wl-commit-input"
          rows="3"
          placeholder="消息（⌘Enter 提交）"
          :disabled="loading"
          @keydown.meta.enter.prevent="doCommit"
          @keydown.ctrl.enter.prevent="doCommit"
        />
        <!-- 根据变更生成 commit message -->
        <button
          class="wl-commit-gen"
          type="button"
          :disabled="loading || !result || !result.files?.length"
          title="根据变更生成 commit message"
          aria-label="生成 commit message"
          @click="generateCommitMsg"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v3" /><path d="M12 18v3" /><path d="M3 12h3" /><path d="M18 12h3" />
            <path d="m5.6 5.6 2.1 2.1" /><path d="m16.3 16.3 2.1 2.1" />
            <path d="m5.6 18.4 2.1-2.1" /><path d="m16.3 7.7 2.1-2.1" />
          </svg>
        </button>
        <!-- [scope-refresh-moved] 刷新按钮从范围区迁至生成按钮旁；同时删除起点 ref 输入框
             [WHY] 用户要求精简顶部区域，刷新入口与生成入口同排更符合 VSCode 习惯
             [CHANGE-IMPACT] 复用 .wl-commit-refresh 样式；点击仍触发 load() 拉取最新 diff -->
        <button
          class="wl-commit-refresh"
          type="button"
          :disabled="loading"
          title="刷新工作日志"
          aria-label="刷新工作日志"
          @click="load"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
      <!-- 分体式：主区提交、窄区复制完整日志；分隔线用半透明白 -->
      <!-- AI 生成结果展示：生成中 / 成功 / 失败 -->
      <div v-if="aiGenerating || aiCommitMsg || aiError" class="wl-ai-result">
        <div v-if="aiGenerating" class="wl-ai-loading">
          <span class="wl-ai-spinner" aria-hidden="true" />
          <span>AI 生成中…</span>
        </div>
        <div v-else-if="aiError" class="wl-ai-error">
          {{ aiError }}
        </div>
        <div v-else class="wl-ai-ok">
          <span class="wl-ai-label">AI</span>
          <span class="wl-ai-text">{{ aiCommitMsg }}</span>
          <button
            class="wl-ai-apply"
            type="button"
            title="填入消息框"
            @click="commitMsg = aiCommitMsg"
          >
            填入
          </button>
        </div>
      </div>
      <div class="wl-commit-btn-row">
        <button
          class="wl-commit-btn"
          type="button"
          :disabled="loading || !result || !commitMsg.trim()"
          @click="doCommit"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>提交</span>
        </button>
        <button
          class="wl-commit-more"
          type="button"
          :disabled="loading || !result || !result.markdown"
          title="复制完整工作日志"
          aria-label="复制完整工作日志"
          @click="copyFullLog"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>
    </div>

    <div class="wl-scroll">
      <!-- [ui-p2b-skeleton-wire-v2] V6：加载态改骨架屏（3 行灰条） -->
      <div v-if="loading" class="skeleton-list" aria-busy="true" aria-label="正在加载变更">
        <div v-for="sk in SKELETON_ROWS" :key="sk" class="skeleton-row">
          <span class="skeleton-icon" />
          <span class="skeleton-line" :class="SKELETON_WIDTHS[sk % SKELETON_WIDTHS.length]" />
        </div>
      </div>
      <div v-else-if="error" class="wl-empty wl-error">
        {{ error }}
      </div>
      <!-- [vcs-svn-log-v1] SVN 工作副本：展示提交历史 + 每次提交涉及的文件 -->
      <template v-else-if="vcsMode === 'svn'">
        <div class="wl-group">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
          <span class="wl-group-title">提交历史</span>
          <span class="wl-group-count">{{ svnEntries.length }}</span>
        </div>
        <div v-if="!svnEntries.length" class="wl-empty">
          暂无提交记录
        </div>
        <ul v-else class="wl-svn-list" role="list">
          <li v-for="e in svnEntries" :key="`svn-${e.revision}`" class="wl-svn-item">
            <div
              class="wl-svn-head"
              role="button"
              tabindex="0"
              :aria-label="`展开 r${e.revision} 的变更文件`"
              @click="toggleSvn(e.revision)"
              @keydown.enter.prevent="toggleSvn(e.revision)"
              @keydown.space.prevent="toggleSvn(e.revision)"
            >
              <span class="wl-chev" :class="{ open: svnExpanded === e.revision }">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
              </span>
              <code class="wl-svn-rev">r{{ e.revision }}</code>
              <span class="wl-svn-msg" :title="e.msg">{{ e.msg || '(无提交信息)' }}</span>
              <span class="wl-svn-meta">{{ e.author }} · {{ fmtSvnDate(e.date) }}</span>
              <span class="wl-svn-nfiles">{{ e.paths.length }}</span>
            </div>
            <ul v-if="svnExpanded === e.revision" class="wl-svn-paths" role="list">
              <li v-for="(p, i) in e.paths" :key="`svn-${e.revision}-${i}`" class="wl-svn-path">
                <span class="wl-svn-act" :class="svnActClass(p.action)">{{ p.action }}</span>
                <span class="wl-svn-path-text" :title="p.path">{{ p.path }}</span>
                <span v-if="p.kind === 'dir'" class="wl-svn-kind">目录</span>
              </li>
            </ul>
          </li>
        </ul>
      </template>
      <div v-else-if="changeCount === 0" class="wl-empty">
        无变更
      </div>
      <template v-else>
        <div class="wl-group">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
          <span class="wl-group-title">更改</span>
          <span v-if="addTotal || delTotal" class="wl-group-stat">
            <span class="wl-add">+{{ addTotal }}</span>
            <span class="wl-del">−{{ delTotal }}</span>
          </span>
          <span class="wl-group-count">{{ changeCount }}</span>
        </div>
        <ul class="wl-list" role="list">
          <li v-for="f in rows" :key="f.path" class="wl-item">
            <div class="wl-item-head" role="button" :aria-label="`预览 ${f.path} 的内容`" tabindex="0" @click="openPreview(f.path)" @keydown.enter.prevent="openPreview(f.path)" @keydown.space.prevent="openPreview(f.path)">
              <span class="wl-chev">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
              </span>
              <span class="wl-doc" :class="f.stCls">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
              <span class="wl-name">{{ f.name }}</span>
              <span class="wl-dir">{{ f.dir }}</span>
              <span v-if="f.added || f.removed" class="wl-stat">
                <span v-if="f.added" class="wl-add">+{{ f.added }}</span>
                <span v-if="f.removed" class="wl-del">−{{ f.removed }}</span>
              </span>
              <span class="wl-st" :class="f.stCls">{{ f.stLetter }}</span>
            </div>
            <!-- [worklog-content-preview-v1] 行级 diff 展开已由内容预览浮层取代 -->
          </li>
        </ul>
      </template>
      <!-- [worklog-history-v1] 提交历史：最近若干条，来自 /git/worklog includeHistory -->
      <div v-if="result && result.history && result.history.length" class="wl-history">
        <div class="wl-group">
          <span class="wl-group-title">最近提交</span>
          <span class="wl-group-count">{{ result.history.length }}</span>
        </div>
        <ul class="wl-history-list" role="list">
          <li v-for="(h, i) in result.history" :key="`h-${i}`" class="wl-history-item">
            {{ h }}
          </li>
        </ul>
      </div>

      <FileContentOverlay
        v-if="previewPath"
        :file-name="previewPath"
        mode="content"
        :content="previewContent"
        :loading="previewLoading"
        @close="previewPath = null"
      />
    </div>
  </div>
</template>

<style scoped lang="scss" src="./worklog-pane.scss"></style>
