<script setup lang="ts">
import { useWorklogCommit } from './worklog-commit'
import { useToast } from '../../composables/ui/useToast'
import { TOAST_LONG, TOAST_MEDIUM } from '../../utils/toast-durations'
// @desc VSCode 源码管理风格侧栏：提交框 + 变更文件列表 + 点击展开行级 diff
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

const props = defineProps<{ active: boolean }>()

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
/**
 * 渲染某文件的原始 diff 为高亮 HTML；单独包一层 pre 供展开区展示
 * [wdiff-cache-v1] 内容级缓存：同一 diff 文本只渲染一次 markdown-it；提交框输入触发重渲染时零开销
 * [CONSTRAINT] 缓存以 diff 文本为键，diff 变化自动失效；上限 200 条防长会话内存增长
 */
const _diffHtmlCache = new Map<string, string>()
const DIFF_CACHE_MAX = 200

const loading = ref(false)
const result = ref<WorklogResult | null>(null)
const error = ref('')
const commitMsg = ref('')
const expanded = ref<Set<string>>(new Set())
// [git-commit-real-v1] 真实提交：/git/commit-loop 落盘后刷新列表
// [CONSTRAINT] committing 防重复点击；成功后清空消息框
const committing = ref(false)
// [git-head-display-v1] 当前 HEAD（短 sha）；空串时模板隐藏
const headRef = ref('')

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
  generateLocalCommitMsg,
  cleanup: cleanupWorklogCommit,
} = useWorklogCommit({
  result,
  commitMsg,
  load,
  getError: () => error.value,
  splitPath,
})

const fileMap = computed<Record<string, WorklogFileEntry>>(() => {
  const m: Record<string, WorklogFileEntry> = {}
  for (const f of result.value?.files || []) m[f.path] = f
  return m
})
// [worklog-rows-v1] 预生成行数据：splitPath / statusLetter / statusClass 每行仅算一次，
// 提交框每输入一字触发重渲染时不再重复调用（报告 §5.1.4）。
// [worklog-rows-template-v1] 预生成行数据：保留 f 全部字段，附加派生的 name/dir/stCls/stLetter。
// expanded 不预生成：它是响应式 Set，直接读 expanded.has(f.path) 保活。
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

// [diff-highlight] 只对代码围栏内的 diff 文本做前缀着色，用 span 包裹，不引入新 HTML 源
// [CONSTRAINT] markdown-it 已做 escape，因此 span 内只包含转义后的 & < >，无 XSS 风险
// [CHANGE-IMPACT] 与 WorklogDialog 的 diffHighlight 语义一致；后续若抽公共 util 可合并
function diffHighlight(html: string): string {
  return html.replace(/<pre class="md-pre"><code>([\s\S]*?)<\/code><\/pre>/g, (_, body: string) => {
    const lines = body.split('\n')
    const out = lines.map((line) => {
      if (/^@@/.test(line)) return `<span class="diff-hunk">${line}</span>`
      if (/^\+\+\+/.test(line)) return `<span class="diff-file">${line}</span>`
      if (/^---/.test(line)) return `<span class="diff-file">${line}</span>`
      if (/^diff --git /.test(line)) return `<span class="diff-file">${line}</span>`
      if (/^\+/.test(line)) return `<span class="diff-add">${line}</span>`
      if (/^-/.test(line)) return `<span class="diff-del">${line}</span>`
      return line
    })
    return `<pre class="md-pre"><code>${out.join('\n')}</code></pre>`
  })
}
function renderDiff(md: string): string {
  return diffHighlight(renderMarkdown(md))
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
function splitPath(p: string): { dir: string, name: string } {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}
function toggleFile(p: string): void {
  const n = new Set(expanded.value)
  if (n.has(p)) n.delete(p)
  else n.add(p)
  expanded.value = n
}
/**
 * 把 /git/diff 返回的原始 diff 文本按文件切分
 * [WHY] 后端 /git/diff 直出 unified diff 原文，前端按 ^diff --git 切块后与 worklog 的 files 列表对齐
 * [CONSTRAINT] 只做字符串切分与正则匹配，不依赖 markdown-it；重复文件路径后者覆盖前者
 * [CHANGE-IMPACT] 结果填充到 files[].diff，供 fileDiffHtml 渲染行级高亮
 */
function splitDiffByPath(rawDiff: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!rawDiff) return out
  const chunks = rawDiff.split(/^diff --git /m).slice(1)
  for (const c of chunks) {
    const body = `diff --git ${c}`
    const m = body.match(/^\+\+\+ b\/(.+)$/m) || body.match(/^--- a\/(.+)$/m)
    if (!m) continue
    out[m[1].trim()] = body
  }
  return out
}
function fileDiffHtml(p: string): string {
  const f = fileMap.value[p]
  if (!f || !f.diff) return ''
  const cached = _diffHtmlCache.get(f.diff)
  if (cached !== undefined) return cached
  const Q = String.fromCharCode(96)
  const FENCE = Q + Q + Q
  const md = `${FENCE}diff\n${f.diff}\n${FENCE}`
  const html = renderDiff(md)
  if (_diffHtmlCache.size >= DIFF_CACHE_MAX) {
    const firstKey = _diffHtmlCache.keys().next().value
    if (firstKey !== undefined) _diffHtmlCache.delete(firstKey)
  }
  _diffHtmlCache.set(f.diff, html)
  return html
}
async function load(): Promise<void> {
  // [load-seq-guard-v1] 捕获本次请求序号；后续每个 await 后校验，过期即丢弃
  const mySeq = ++_loadSeq
  // 并行请求 worklog 与原始 diff；后者填充 files[].diff
  // [WHY] worklog 的 markdown 链路在某些环境看不到详细段；/git/diff 直出 unified diff 规避该问题
  loading.value = true
  error.value = ''
  try {
    const [wlRes, diffRes, headRes] = await Promise.all([
      fetch('/__ai/git/worklog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // [worklog-history-v1] 打开提交历史：模板渲染 history 列表
        body: JSON.stringify({ includeHistory: true }),
      }),
      fetch('/__ai/git/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      fetch('/__ai/git/head', { cache: 'no-store' }),
    ])
    if (mySeq !== _loadSeq) return
    const j = await wlRes.json().catch(() => ({})) as WorklogResult
    if (mySeq !== _loadSeq) return
    if (!wlRes.ok || !j.ok) {
      error.value = j.reason || (`HTTP ${wlRes.status}`)
      result.value = null
      return
    }
    // diff 端点独立消费；失败仅告警不阻断
    try {
      const dj = await diffRes.json().catch(() => ({})) as { ok?: boolean, diff?: string, reason?: string }
      if (mySeq !== _loadSeq) return
      if (dj && dj.ok && dj.diff) {
        const byPath = splitDiffByPath(dj.diff)
        for (const f of j.files || []) {
          if (byPath[f.path]) f.diff = byPath[f.path]
        }
      }
    } catch { /* ignore: diff 请求失败时仅保留 worklog 结果 */ }
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
  } catch { /* ignore: 剪贴板不可用时静默 */ }
}
</script>

<template>
  <div class="wl-pane">
    <!-- [source-control] 顶部：提交消息框 + 生成按钮 + 分体式提交按钮（VSCode 风格） -->
    <div class="wl-commit">
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
      <div v-else-if="changeCount === 0" class="wl-empty">
        无变更
      </div>
      <template v-else>
        <div class="wl-group">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
          <span class="wl-group-title">更改</span>
          <span class="wl-group-count">{{ changeCount }}</span>
        </div>
        <ul class="wl-list" role="list">
          <li v-for="f in rows" :key="f.path" class="wl-item">
            <div class="wl-item-head" role="button" :aria-label="`展开/折叠 ${f.path} 的 diff`" :aria-expanded="expanded.has(f.path)" tabindex="0" @click="toggleFile(f.path)" @keydown.enter.prevent="toggleFile(f.path)" @keydown.space.prevent="toggleFile(f.path)">
              <span class="wl-chev" :class="{ open: expanded.has(f.path) }">
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
              <span class="wl-st" :class="f.stCls">{{ f.stLetter }}</span>
            </div>
            <div v-if="expanded.has(f.path)" class="wl-diff" v-html="fileDiffHtml(f.path)" />
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
    </div>
  </div>
</template>

<style scoped lang="scss" src="./worklog-pane.scss"></style>
