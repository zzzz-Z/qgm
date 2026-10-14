<script setup lang="ts">
import { useWorklogCommit } from './worklog-commit'
import { useToast } from '../../composables/ui/useToast'
// [workspace-epoch-v1] 显式 import：watch(workspaceEpoch) 在 vitest 下无 auto-import 兜底
import { useWorkspaces } from '../../composables/data/useWorkspaces'
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
// [git-stage-v1] /__ai/git/status 返回：XY 位区分已暂存/未暂存，供双栏展示
interface GitStatusFile {
  path: string
  status: string
  staged: boolean
  unstaged: boolean
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
// [worklog-diff-preview-v1] 变更列表点击走 diff 模式：拿 git 补丁渲染，不再回读文件内容
const previewHunks = ref<string[]>([])
/** 预览模式：有 diff 走 diff，否则退回 content（如新增/删除文件或 diff 缺失） */
const previewMode = ref<'diff' | 'content'>('content')
/** 变更类型：驱动 DiffViewer 的徽标 */
const previewChangeType = ref<'added' | 'modified' | 'deleted'>('modified')
// [git-commit-real-v1] 真实提交：/git/commit-loop 落盘后刷新列表
// [CONSTRAINT] committing 防重复点击；成功后清空消息框
const committing = ref(false)
// [git-head-display-v1] 当前 HEAD（短 sha）；空串时模板隐藏
const headRef = ref('')
// [git-branch-display-v1] 当前分支名（顶部展示，对齐 VSCode 源控面板）
const branchRef = ref('')
// [git-history-dialog-v1] 提交历史弹窗：按钮触发，拉 /__ai/git/commits
const commitsOpen = ref(false)
const commitsLoading = ref(false)
const commitsData = ref<Array<{ sha: string, short: string, author: string, date: string, subject: string }>>([])
// [git-switch-branch-v1] 分支切换弹窗
const branchesOpen = ref(false)
const branchesLoading = ref(false)
const branchesList = ref<string[]>([])
const switchingBranch = ref(false)
// [git-commit-detail-v1] 提交详情弹窗
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailData = ref<{
  sha: string
  short: string
  author: string
  email: string
  date: string
  subject: string
  body: string
  files: Array<{ status: string, path: string }>
} | null>(null)
// [vcs-svn-log-v1] 版本控制类型：'git' 为乐观默认（git 用户不该看到模式切换的闪烁）；
//   仅当 git 链路失败且 /vcs/log 报 vcs='svn' 时才翻成 'svn'
const vcsMode = ref<'git' | 'svn'>('git')
/** SVN 提交历史（每条含该次提交涉及的路径） */
const svnEntries = ref<SvnLogEntry[]>([])
/** 当前展开的 revision；null 表示全部收起 */
const svnExpanded = ref<number | null>(null)
// [git-stage-v1] 从 /__ai/git/status 拉到的 XY 状态；提交/暂存操作后刷新
const stagingStatus = ref<GitStatusFile[]>([])

const { toast } = useToast()
// [use-worklog-commit-v1] commit msg 生成簇已抽到 useWorklogCommit
const {
  aiGenerating,
  aiCommitMsg,
  aiError,
  pendingCommitRequest,
  pendingCommitSid,
  waitingSince,
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
// [workspace-epoch-v1] 执行 root 变更计数（详见下方 watch 处说明）
const { workspaceEpoch } = useWorkspaces()

// [worklog-rows-v1] 预生成行数据：splitPath / statusLetter / statusClass 每行仅算一次，
// 提交框每输入一字触发重渲染时不再重复调用（报告 §5.1.4）。
// [worklog-rows-template-v1] 预生成行数据：保留 f 全部字段，附加派生的 name/dir/stCls/stLetter。
// [worklog-content-preview-v1] 行数据不再承载展开态：点击改为打开内容预览浮层。
// [git-stage-v1] 统计映射：path -> {added, removed, diff}，来自 worklog 的 numstat + 原始 patch
// [worklog-diff-preview-v1] 同时挂 diff：openPreview 靠它判断走 diff 模式还是退回 content 模式
const statByPath = computed(() => {
  const m = new Map<string, { added: number, removed: number, diff: string }>()
  for (const f of result.value?.files || []) m.set(f.path, { added: f.added || 0, removed: f.removed || 0, diff: f.diff || '' })
  return m
})
/** 已暂存栏（提交源） */
const stagedRows = computed(() => rowsFor(stagingStatus.value, true))
/** 未暂存栏 */
const unstagedRows = computed(() => rowsFor(stagingStatus.value, false))
const changeCount = computed(() => stagedRows.value.length + unstagedRows.value.length)
// [worklog-stat-v1] 汇总 +/-：分组头展示；数据源同 result.files，与每行数值一致
const addTotal = computed(() => (result.value?.files || []).reduce((s, f) => s + (f.added || 0), 0))
const delTotal = computed(() => (result.value?.files || []).reduce((s, f) => s + (f.removed || 0), 0))

// [worklog-lazy-v1] immediate：组件在 tab 激活时才异步挂载，挂载即 active=true，非 immediate watch 不会触发
watch(() => props.active, (v) => { if (v && !result.value && !loading.value) void load() }, { immediate: true })
// [workspace-epoch-v1] 切/建/删工作区后执行 root 变化：本组件由 v-show 保活（不重挂载），而上面的
//   immediate watch 带 `!result.value` 闸门 —— 旧 root 已加载过结果 ⇒ 切 root 后不会重拉，
//   提交历史/暂存区会一直停在旧 root。故显式监听 epoch 无条件刷新。
// [CONSTRAINT] 非活动时不发请求（与本组件「非活动不发请求」约定一致）：清空结果让下次激活重拉。
watch(workspaceEpoch, () => {
  if (props.active) { void load(); return }
  result.value = null
  error.value = ''
})

onMounted(() => {
  try {
    const t = getTransport()
    unsubscribeReply = t.onReply((raw: unknown, _sid: string) => {
      // [gitmsg-window-v1] 闸门改为「时间窗」而不是「一次性 pending 标志」：
      //   超时只提示不关闸，AI 生成 msg 晚到时仍能被消费。10 分钟窗口兜底防永久挂着。
      const WINDOW_MS = 600_000
      const elapsed = waitingSince.value ? Date.now() - waitingSince.value : -1
      const inWindow = waitingSince.value > 0 && elapsed >= 0 && elapsed < WINDOW_MS
      // [worklog-reply-shape-v2] 兼容 script kind：
      //   AI 的 commit message 回复可能被 tampermonkey 判成 `script` kind（prompt 里带 ```diff 围栏触发），
      //   此时内容在 reply.item.code 而非 reply.text。扩展取值来源，两个字段都试。
      const replyShape = raw as { kind?: string, text?: string, item?: { code?: string } } | null
      const textFromText = replyShape && typeof replyShape.text === 'string' ? replyShape.text : ''
      const textFromItem = replyShape && replyShape.item && typeof replyShape.item.code === 'string' ? replyShape.item.code : ''
      const text = (textFromText || textFromItem).trim()
      // 闸门：不在窗口内直接忽略（不管 pending 标志，因为超时不清 pending 会让它常驻）
      if (!inWindow) return
      if (!text) return
      // [gitmsg-sentinel-v1] 靠 prompt 里约定的 GITMSG 哨兵前缀精确提取：
      //   不再依赖 kind（页面侧扫描推断不准），也不再依赖「看起来像 commit」的模糊匹配。
      //   只要回复里出现 GITMSG: 就提取其后内容作为 commit message。
      // [gitmsg-sentinel-v1] indexOf 定位哨兵，不用正则（eslint 拦 super-linear-backtracking）
      const SENTINEL = 'GITMSG:'
      const sentinelIdx = text.indexOf(SENTINEL)
      if (sentinelIdx < 0) return
      const afterSentinel = text.slice(sentinelIdx + SENTINEL.length).trim()
      const msg = extractCommitMessage(afterSentinel) || extractCommitLine(afterSentinel)
      if (!msg) return
      aiCommitMsg.value = msg
      commitMsg.value = msg
      aiGenerating.value = false
      pendingCommitRequest.value = false
      pendingCommitSid.value = ''
      // 消费后关闭窗口（避免重复消费）
      waitingSince.value = 0
      cleanupWorklogCommit()
    })
  } catch { /* transport 未就绪时静默；用户可手动编辑 */ }
})
onUnmounted(() => {
  if (unsubscribeReply) { try { unsubscribeReply() } catch { /* ignore */ } unsubscribeReply = null }
  cleanupWorklogCommit()
})

/**
 * [git-stage-v1] 根据 XY 位把文件按所属栏补齐展示字段。
 * [WHY] 一个文件可同时出现在两栏（MM 状态：部分改动已暂存、部分未暂存），与 VSCode 一致。
 * @param files status 源
 * @param wantStaged true=取已暂存栏，false=取未暂存栏
 */
function rowsFor(files: GitStatusFile[], wantStaged: boolean): Array<{
  path: string
  status: string
  name: string
  dir: string
  stCls: string
  stLetter: string
  added: number
  removed: number
  diff: string
}> {
  const stats = statByPath.value
  const out: Array<{
    path: string
    status: string
    name: string
    dir: string
    stCls: string
    stLetter: string
    added: number
    removed: number
    diff: string
  }> = []
  for (const f of files) {
    const inThis = wantStaged ? f.staged : f.unstaged
    if (!inThis) continue
    const sp = splitPath(f.path)
    const st = stats.get(f.path)
    out.push({
      path: f.path,
      status: f.status,
      name: sp.name,
      dir: sp.dir,
      stCls: statusClass(f.status),
      stLetter: statusLetter(f.status),
      added: st?.added || 0,
      removed: st?.removed || 0,
      diff: st?.diff || '',
    })
  }
  return out
}
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
/**
 * 打开文件预览浮层（内容模式）。
 * [WHY] 工作日志的变更列表点击即看「这个文件现在长什么样」；行级 diff 显示交由 preview 浮层内部模式切换。
 * [CONSTRAINT] 传整个 file entry（含 path/diff/status），浮层需要 status 判新增/删除；此处保持向后兼容，
 *   调用方传字符串也接受（视为仅路径、无 diff 数据）。
 * @param file file entry 或文件路径字符串
 */
/**
 * 打开文件预览浮层。
 * [worklog-diff-preview-v1] 变更列表点击改为走 diff 模式：把 git 补丁丢给 @git-diff-view 渲染，
 *   回答「这一轮到底改了什么」，而不是「改完后长什么样」。
 * [CONSTRAINT] 补丁缺失时退回 content 模式（读当前内容），避免浮层空白。
 * @param file file entry（含 path/status/diff）或路径字符串
 */
async function openPreview(file: { path: string, status?: string, diff?: string } | string): Promise<void> {
  const p = typeof file === 'string' ? file : file.path
  if (!p) return
  const status = typeof file === 'object' && file.status ? file.status : 'modified'
  const patch = typeof file === 'object' && typeof file.diff === 'string' ? file.diff : ''
  const seq = ++_previewSeq
  previewPath.value = p
  previewChangeType.value = status === 'added' ? 'added' : status === 'deleted' ? 'deleted' : 'modified'

  if (patch) {
    previewMode.value = 'diff'
    // [diff-hunks-format-v1] 实测：@git-diff-view 的 hunks 参数吃「完整 unified diff 字符串」数组，
    //   只留 @@ 段会触发 "No hunks found"（拆段反而拿不到 split 结果）。单元素整段透传。
    previewHunks.value = [patch]
    previewContent.value = ''
    previewLoading.value = false
    return
  }

  previewMode.value = 'content'
  previewHunks.value = []
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
/**
 * [git-stage-v1] 把路径加入暂存区（VSCode 未暂存栏的 + 动作）。
 */
async function stageFiles(paths: string[]): Promise<void> {
  if (!paths.length) return
  try {
    const r = await fetch('/__ai/git/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, reason?: string }
    if (!r.ok || !j.ok) { toast(j.reason || `暂存失败（HTTP ${r.status}）`, 'error', TOAST_LONG); return }
    await load()
  } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', TOAST_LONG) }
}
/** [git-stage-v1] 从暂存区撤下（VSCode 已暂存栏的 - 动作，保留工作区内容）。 */
async function unstageFiles(paths: string[]): Promise<void> {
  if (!paths.length) return
  try {
    const r = await fetch('/__ai/git/unstage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, reason?: string }
    if (!r.ok || !j.ok) { toast(j.reason || `取消暂存失败（HTTP ${r.status}）`, 'error', TOAST_LONG); return }
    await load()
  } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', TOAST_LONG) }
}
/** [git-stage-v1] 全量暂存：把未暂存栏全部加入暂存区 */
async function stageAll(): Promise<void> {
  await stageFiles(unstagedRows.value.map(r => r.path))
}
/** [git-stage-v1] 全量取消暂存 */
async function unstageAll(): Promise<void> {
  await unstageFiles(stagedRows.value.map(r => r.path))
}
async function load(): Promise<void> {
  // [load-seq-guard-v1] 捕获本次请求序号；后续每个 await 后校验，过期即丢弃
  const mySeq = ++_loadSeq
  loading.value = true
  error.value = ''
  try {
    const [wlRes, headRes, stRes, brRes] = await Promise.all([
      fetch('/__ai/git/worklog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // [worklog-history-v1] 打开提交历史：模板渲染 history 列表
        body: JSON.stringify({ includeHistory: true }),
      }),
      fetch('/__ai/git/head', { cache: 'no-store' }),
      // [git-stage-v1] 三请求并发：暂存区状态独立端点在 VSCode 语义下更清晰
      fetch('/__ai/git/status', { cache: 'no-store' }),
      // [git-branch-display-v1] 分支名与 head 并发拉取
      fetch('/__ai/git/branch', { cache: 'no-store' }),
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
    // [git-branch-display-v1] branch 独立消费；失败仅清空显示
    try {
      const bj = await brRes.json().catch(() => ({})) as { ok?: boolean, branch?: string }
      if (mySeq !== _loadSeq) return
      branchRef.value = bj && bj.ok && bj.branch ? String(bj.branch) : ''
    } catch { /* ignore */ }
    if (mySeq !== _loadSeq) return
    result.value = j
    // [git-stage-v1] status 拉取失败只影响双栏显示，不阻断 worklog
    try {
      const sj = await stRes.json().catch(() => ({})) as { ok?: boolean, files?: GitStatusFile[] }
      if (mySeq !== _loadSeq) return
      stagingStatus.value = sj.ok && Array.isArray(sj.files) ? sj.files : []
    } catch { /* ignore */ }
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
  // [git-stage-v1] 提交前需有已暂存项；空暂存区给出明确提示（与 VSCode 一致）
  if (!stagedRows.value.length) {
    toast('暂存区为空，请先暂存要提交的文件', 'warn', TOAST_MEDIUM)
    return
  }
  if (!commitMsg.value.trim() || committing.value) return
  committing.value = true
  try {
    const r = await fetch('/__ai/git/commit-staged', {
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
/** [git-switch-branch-v1] 打开分支切换弹窗；每次打开都刷新列表（分支可能已变） */
async function openBranches(): Promise<void> {
  branchesOpen.value = true
  branchesLoading.value = true
  try {
    const r = await fetch('/__ai/git/branches', { cache: 'no-store' })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, current?: string, list?: string[], reason?: string }
    if (!r.ok || !j.ok) { toast(j.reason || `加载分支失败（HTTP ${r.status}）`, 'error', TOAST_LONG); return }
    branchesList.value = Array.isArray(j.list) ? j.list : []
  } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', TOAST_LONG) }
  finally { branchesLoading.value = false }
}
function closeBranches(): void { branchesOpen.value = false }
/** [git-switch-branch-v1] 切换分支（dirty 保护由后端强制） */
async function switchBranch(b: string): Promise<void> {
  if (switchingBranch.value || b === branchRef.value) return
  switchingBranch.value = true
  try {
    const r = await fetch('/__ai/git/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: b }),
    })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, branch?: string, dirty?: boolean, reason?: string }
    if (!r.ok || !j.ok) { toast(j.reason || `切换失败（HTTP ${r.status}）`, 'error', TOAST_LONG); return }
    toast(`已切到 ${j.branch}`, 'success', TOAST_MEDIUM)
    branchesOpen.value = false
    // 切完刷新所有：分支名、HEAD、状态
    commitsData.value = []
    await load()
  } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', TOAST_LONG) }
  finally { switchingBranch.value = false }
}
/** [git-commit-detail-v1] 打开提交详情弹窗 */
async function openDetail(sha: string): Promise<void> {
  detailOpen.value = true
  detailLoading.value = true
  detailData.value = null
  try {
    const r = await fetch(`/__ai/git/commit-detail?sha=${encodeURIComponent(sha)}`, { cache: 'no-store' })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, detail?: typeof detailData.value, reason?: string }
    if (!r.ok || !j.ok || !j.detail) { toast(j.reason || `加载详情失败（HTTP ${r.status}）`, 'error', TOAST_LONG); return }
    detailData.value = j.detail
  } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', TOAST_LONG) }
  finally { detailLoading.value = false }
}
function closeDetail(): void { detailOpen.value = false }
/**
 * [git-history-dialog-v1] 打开提交历史弹窗；懒加载，只拉一次。
 * [WHY] 底部常驻列表已删除；用户需要时才拉，避免开 tab 就打 log。
 */
async function openCommits(): Promise<void> {
  commitsOpen.value = true
  if (commitsData.value.length || commitsLoading.value) return
  commitsLoading.value = true
  try {
    const r = await fetch('/__ai/git/commits?limit=100', { cache: 'no-store' })
    const j = await r.json().catch(() => ({})) as { ok?: boolean, commits?: Array<{ sha: string, short: string, author: string, date: string, subject: string }>, reason?: string }
    if (!r.ok || !j.ok) { toast(j.reason || `加载提交历史失败（HTTP ${r.status}）`, 'error', TOAST_LONG); return }
    commitsData.value = Array.isArray(j.commits) ? j.commits : []
  } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', TOAST_LONG) }
  finally { commitsLoading.value = false }
}
/** [git-history-dialog-v1] 关闭弹窗（不清空数据，二次打开免请求） */
function closeCommits(): void { commitsOpen.value = false }
/** [git-history-dialog-v1] ISO8601 → 本地易读时间 */
function fmtCommitDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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
      <!-- [git-branch-display-v1] 分支名 + 短 sha：对齐 VSCode 源控面板顶部信息条 -->
      <div v-if="branchRef || headRef" class="wl-head-row">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 6a3 3 0 1 1-3 3" /><path d="M15 9a9 9 0 0 1-9 9" /></svg>
        <button type="button" class="wl-head-branch" :title="`点击切换分支（当前 ${branchRef || '(detached)'}）`" @click="openBranches">
          {{ branchRef || '(detached)' }}
        </button>
        <code v-if="headRef" class="wl-head-sha">{{ headRef }}</code>
      </div>
      <!-- [commit-toolbar-v1] 按钮排：提交 / 复制日志 / 生成 / 刷新，统一 30×30 方形，置于输入框上方 -->
      <div class="wl-commit-toolbar">
        <button
          v-tooltip="'提交'"
          class="wl-commit-btn"
          type="button"
          :disabled="loading || !result || !commitMsg.trim()"
          aria-label="提交"
          @click="doCommit"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
        <button
          v-tooltip="'根据变更生成 commit message'"
          class="wl-commit-gen"
          type="button"
          :disabled="loading || !result || !result.files?.length"
          aria-label="生成 commit message"
          @click="generateCommitMsg"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v3" /><path d="M12 18v3" /><path d="M3 12h3" /><path d="M18 12h3" />
            <path d="m5.6 5.6 2.1 2.1" /><path d="m16.3 16.3 2.1 2.1" />
            <path d="m5.6 18.4 2.1-2.1" /><path d="m16.3 7.7 2.1-2.1" />
          </svg>
        </button>
        <button
          v-tooltip="'刷新工作日志'"
          class="wl-commit-refresh"
          type="button"
          :disabled="loading"
          aria-label="刷新工作日志"
          @click="load"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <!-- [git-history-dialog-v1] 查看提交历史：打开弹窗展示完整列表 -->
        <button
          v-tooltip="'查看提交历史'"
          class="wl-commit-refresh"
          type="button"
          aria-label="查看提交历史"
          @click="openCommits"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
          </svg>
        </button>
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
        <!-- [git-stage-v1] 已暂存栏（VSCode 源控面板分组） -->
        <template v-if="stagedRows.length">
          <div class="wl-group">
            <span class="wl-group-title">已暂存</span>
            <span class="wl-group-count">{{ stagedRows.length }}</span>
            <button class="wl-group-action" type="button" title="全部取消暂存" aria-label="全部取消暂存" @click="unstageAll">
              −
            </button>
          </div>
          <ul class="wl-list" role="list">
            <li v-for="f in stagedRows" :key="`s-${f.path}`" class="wl-item">
              <div class="wl-item-head" role="button" :aria-label="`预览 ${f.path}`" tabindex="0" @click="openPreview(f)" @keydown.enter.prevent="openPreview(f)" @keydown.space.prevent="openPreview(f)">
                <span class="wl-doc" :class="f.stCls">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                </span>
                <span class="wl-name">{{ f.name }}</span>
                <span class="wl-dir">{{ f.dir }}</span>
                <span v-if="f.added || f.removed" class="wl-stat">
                  <span v-if="f.added" class="wl-add">+{{ f.added }}</span>
                  <span v-if="f.removed" class="wl-del">−{{ f.removed }}</span>
                </span>
                <span class="wl-st" :class="f.stCls">{{ f.stLetter }}</span>
                <button class="wl-row-action" type="button" title="取消暂存" aria-label="取消暂存" @click.stop="unstageFiles([f.path])">
                  −
                </button>
              </div>
            </li>
          </ul>
        </template>

        <!-- [git-stage-v1] 未暂存栏 -->
        <template v-if="unstagedRows.length">
          <div class="wl-group">
            <span class="wl-group-title">更改</span>
            <span v-if="addTotal || delTotal" class="wl-group-stat">
              <span class="wl-add">+{{ addTotal }}</span>
              <span class="wl-del">−{{ delTotal }}</span>
            </span>
            <span class="wl-group-count">{{ unstagedRows.length }}</span>
            <button class="wl-group-action" type="button" title="全部暂存" aria-label="全部暂存" @click="stageAll">
              +
            </button>
          </div>
          <ul class="wl-list" role="list">
            <li v-for="f in unstagedRows" :key="`u-${f.path}`" class="wl-item">
              <div class="wl-item-head" role="button" :aria-label="`预览 ${f.path}`" tabindex="0" @click="openPreview(f)" @keydown.enter.prevent="openPreview(f)" @keydown.space.prevent="openPreview(f)">
                <span class="wl-doc" :class="f.stCls">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                </span>
                <span class="wl-name">{{ f.name }}</span>
                <span class="wl-dir">{{ f.dir }}</span>
                <span v-if="f.added || f.removed" class="wl-stat">
                  <span v-if="f.added" class="wl-add">+{{ f.added }}</span>
                  <span v-if="f.removed" class="wl-del">−{{ f.removed }}</span>
                </span>
                <span class="wl-st" :class="f.stCls">{{ f.stLetter }}</span>
                <button class="wl-row-action" type="button" title="暂存" aria-label="暂存" @click.stop="stageFiles([f.path])">
                  +
                </button>
              </div>
            </li>
          </ul>
        </template>
      </template>

      <!-- [git-switch-branch-v1] 分支切换弹窗 -->
      <Teleport v-if="branchesOpen" to="body">
        <div class="wl-hist-mask" @click.self="closeBranches">
          <div class="wl-hist-box" role="dialog" aria-label="切换分支">
            <div class="wl-hist-head">
              <span class="wl-hist-title">切换分支</span>
              <span class="wl-hist-count">{{ branchesList.length }}</span>
              <button class="wl-hist-close" type="button" aria-label="关闭" @click="closeBranches">
                ×
              </button>
            </div>
            <div v-if="branchesLoading" class="wl-hist-loading">
              加载中…
            </div>
            <ul v-else-if="branchesList.length" class="wl-hist-list" role="list">
              <li v-for="b in branchesList" :key="b" class="wl-hist-item">
                <button
                  type="button"
                  class="wl-hist-row"
                  :class="{ 'is-active': b === branchRef }"
                  :disabled="switchingBranch || b === branchRef"
                  :aria-label="b === branchRef ? `当前分支 ${b}` : `切换到 ${b}`"
                  @click="switchBranch(b)"
                >
                  <code class="wl-hist-sha">{{ b === branchRef ? '✓' : '' }}</code>
                  <span class="wl-hist-subject">{{ b }}</span>
                  <span class="wl-hist-meta">{{ b === branchRef ? '当前' : '' }}</span>
                </button>
              </li>
            </ul>
            <div v-else class="wl-hist-empty">
              暂无本地分支
            </div>
          </div>
        </div>
      </Teleport>

      <!-- [git-commit-detail-v1] 提交详情弹窗 -->
      <Teleport v-if="detailOpen" to="body">
        <div class="wl-hist-mask" @click.self="closeDetail">
          <div class="wl-hist-box" role="dialog" aria-label="提交详情">
            <div class="wl-hist-head">
              <span class="wl-hist-title">提交详情</span>
              <button class="wl-hist-close" type="button" aria-label="关闭" @click="closeDetail">
                ×
              </button>
            </div>
            <div v-if="detailLoading" class="wl-hist-loading">
              加载中…
            </div>
            <div v-else-if="detailData" class="wl-detail">
              <div class="wl-detail-meta">
                <code>{{ detailData.short }}</code>
                <span>{{ detailData.author }} &lt;{{ detailData.email }}&gt;</span>
                <span>{{ fmtCommitDate(detailData.date) }}</span>
              </div>
              <div class="wl-detail-subject">
                {{ detailData.subject }}
              </div>
              <pre v-if="detailData.body" class="wl-detail-body">{{ detailData.body }}</pre>
              <div class="wl-detail-files">
                <div class="wl-detail-files-head">
                  改动文件 ({{ detailData.files.length }})
                </div>
                <ul class="wl-hist-list" role="list">
                  <li v-for="(f, i) in detailData.files" :key="i" class="wl-hist-item">
                    <code class="wl-hist-sha">{{ f.status }}</code>
                    <span class="wl-hist-subject">{{ f.path }}</span>
                  </li>
                </ul>
              </div>
            </div>
            <div v-else class="wl-hist-empty">
              无数据
            </div>
          </div>
        </div>
      </Teleport>

      <!-- [git-history-dialog-v1] 提交历史弹窗：Teleport 到 body，Esc / 点遮罩关闭 -->
      <Teleport v-if="commitsOpen" to="body">
        <div class="wl-hist-mask" @click.self="closeCommits">
          <div class="wl-hist-box" role="dialog" aria-label="提交历史">
            <div class="wl-hist-head">
              <span class="wl-hist-title">提交历史</span>
              <span class="wl-hist-count">{{ commitsData.length }}</span>
              <button class="wl-hist-close" type="button" aria-label="关闭" @click="closeCommits">
                ×
              </button>
            </div>
            <div v-if="commitsLoading" class="wl-hist-loading">
              加载中…
            </div>
            <ul v-else-if="commitsData.length" class="wl-hist-list" role="list">
              <li v-for="c in commitsData" :key="c.sha" class="wl-hist-item">
                <button type="button" class="wl-hist-row" :aria-label="`查看 ${c.short} 详情`" @click="openDetail(c.sha)">
                  <code class="wl-hist-sha">{{ c.short }}</code>
                  <span class="wl-hist-subject" :title="c.subject">{{ c.subject || '(无提交信息)' }}</span>
                  <span class="wl-hist-meta">{{ c.author }} · {{ fmtCommitDate(c.date) }}</span>
                </button>
              </li>
            </ul>
            <div v-else class="wl-hist-empty">
              暂无提交记录
            </div>
          </div>
        </div>
      </Teleport>

      <FileContentOverlay
        v-if="previewPath"
        :file-name="previewPath"
        :mode="previewMode"
        :content="previewContent"
        :hunks="previewHunks"
        :change-type="previewChangeType"
        :loading="previewLoading"
        @close="previewPath = null"
      />
    </div>
  </div>
</template>

<style scoped lang="scss" src="./worklog-pane.scss"></style>
