<script setup lang="ts">
// @desc VSCode 源码管理风格侧栏：提交框 + 变更文件列表 + 点击展开行级 diff
// @why 用户要求把工作日志从弹窗改为 SidePane tab，视觉参照 VSCode 源代码管理面板
// @change-impact 依赖 /__ai/git/worklog 端点；父组件 SidePane 通过 v-show 切换本面板可见性
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { renderMarkdown } from '../../composables/useMarkdown'
// [commit-msg-ai-v1] 用户要求生成按钮改为"发 git diff 给 AI → 拿回复"；需发送与收包 API
import { copyAndFill } from '../../composables/ai/useAiWindow'
import { getTransport } from '../../composables/ai/useAiTransport'

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

const loading = ref(false)
const result = ref<WorklogResult | null>(null)
const error = ref('')
const commitMsg = ref('')
const expanded = ref<Set<string>>(new Set())
// [commit-msg-ai-v1] AI 生成 commit msg 的独立状态；与 commitMsg 解耦，避免污染用户输入
const aiGenerating = ref(false)
const aiCommitMsg = ref('')
const aiError = ref('')
// [commit-msg-ai-v1] 请求门控：置 true 时接受下一条 onReply 作为本次回复；收到即置 false
// [CONSTRAINT] 用门控而非 sid 过滤，因为 sid 在无头通道与油猴通道下语义可能不一致
const pendingCommitRequest = ref(false)
let pendingTimer: ReturnType<typeof setTimeout> | null = null

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

const fileMap = computed<Record<string, WorklogFileEntry>>(() => {
  const m: Record<string, WorklogFileEntry> = {}
  for (const f of result.value?.files || []) m[f.path] = f
  return m
})

const changeCount = computed(() => result.value?.files.length || 0)

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
 * [worklog-diff-direct-v1] 把 /git/diff 返回的原始 diff 文本按文件切分
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

/** 渲染某文件的原始 diff 为高亮 HTML；单独包一层 pre 供展开区展示 */
function fileDiffHtml(p: string): string {
  const f = fileMap.value[p]
  if (!f || !f.diff) return ''
  const Q = String.fromCharCode(96)
  const FENCE = Q + Q + Q
  const md = `${FENCE}diff\n${f.diff}\n${FENCE}`
  return renderDiff(md)
}

async function load(): Promise<void> {
  // [worklog-diff-direct-v1] 并行请求 worklog 与原始 diff；后者填充 files[].diff
  // [WHY] worklog 的 markdown 链路在某些环境看不到详细段；/git/diff 直出 unified diff 规避该问题
  // [CONSTRAINT] 两个请求都失败才算加载失败；diff 请求失败时仅警告不阻断（保留文件列表）
  // [CHANGE-IMPACT] 每次 load() 发起 2 个 HTTP 请求；result.files[].diff 从 /git/diff 填充而非 worklog
  loading.value = true
  error.value = ''
  try {
    const [wlRes, diffRes] = await Promise.all([
      fetch('/__ai/git/worklog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeHistory: false }),
      }),
      fetch('/__ai/git/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ])
    const j = await wlRes.json().catch(() => ({})) as WorklogResult
    if (!wlRes.ok || !j.ok) {
      error.value = j.reason || (`HTTP ${wlRes.status}`)
      result.value = null
      return
    }
    // diff 端点独立消费；失败仅告警不阻断
    try {
      const dj = await diffRes.json().catch(() => ({})) as { ok?: boolean, diff?: string, reason?: string }
      if (dj && dj.ok && dj.diff) {
        const byPath = splitDiffByPath(dj.diff)
        for (const f of j.files || []) {
          if (byPath[f.path]) f.diff = byPath[f.path]
        }
      }
    } catch { /* ignore: diff 请求失败时仅保留 worklog 结果 */ }
    result.value = j
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    result.value = null
  } finally {
    loading.value = false
  }
}

/** 提交：把 commitMsg 复制到剪贴板（后端不做实际 git commit，避免越权） */
async function doCommit(): Promise<void> {
  if (!result.value || !commitMsg.value.trim()) return
  try {
    await navigator.clipboard.writeText(commitMsg.value)
  } catch { /* ignore: 剪贴板不可用时静默 */ }
}

/**
 * [commit-msg-gen-v2] 基于 git diff 内容生成 Conventional Commits 风格 message
 * [WHY] v1 一律 chore: update N files 无语义；v2 按文件类型分组 + diff 关键词推断 type/scope
 * [CONSTRAINT] 纯前端启发式：不解析 AST，仅依据扩展名 + diff 行首字符与 fix/bug 关键词；不联网、不调 LLM
 * [CHANGE-IMPACT] 生成结果直接覆盖 commitMsg；用户手动编辑后再点会覆盖，属预期行为
 */
/**
 * [commit-msg-ai-v1] 生成按钮入口：把 git diff 全量内容拼成提问发送给 AI 网页
 * [WHY] 用户要求由 AI 生成 commit msg，本地启发式仅作 fallback（generateLocalCommitMsg）
 * [CONSTRAINT] 依赖 transport 通道（无头 / 油猴）已建立；发送失败时降级到本地启发式
 * [CHANGE-IMPACT] 会写 pendingCommitRequest/aiGenerating/aiCommitMsg；由 onReply 订阅消费
 */
async function generateCommitMsg(): Promise<void> {
  // [commit-msg-refresh-v1] 先主动拉取最新 git diff，避免使用陈旧缓存
  // [WHY] 用户点按钮时看到 loading 但实际未执行 git diff 命令；根因是直接读 result.value 缓存
  // [CONSTRAINT] load() 内已处理 loading/error；失败时走 error 分支不上屏
  // [CHANGE-IMPACT] 每次点击都会新增一次 POST /__ai/git/worklog 请求；result.value 随之刷新
  aiError.value = ''
  aiGenerating.value = true
  await load()
  if (error.value) {
    aiGenerating.value = false
    aiError.value = `拉取 git diff 失败：${error.value}`
    return
  }
  if (!result.value || !result.value.files.length) {
    aiGenerating.value = false
    aiError.value = '无变更可生成'
    return
  }
  const Q = String.fromCharCode(96)
  const FENCE = Q + Q + Q
  const prompt = [
    '@ask',
    `请根据我提供的代码变更，生成标准 Git commit message。
    【输入】
    变更内容（git diff / 文件列表 / 变更说明）：
    {{changes}}

    可选信息：
    - 关联 issue：{{issue}}
    - 期望 scope：{{scope}}
    - 输出语言：{{中文}}
    - 是否允许生成多条：{{是}}

    【规则】
    1. 只输出 commit message 本身，不要解释、不要 markdown 代码块、不要前后缀。
    2. 格式：
      <type>(<scope>): <subject>

   <body>

   <footer>
   body 和 footer 可选；如果标题已足够，可只输出标题。
    3. type 只能使用：feat、fix、docs、style、refactor、perf、test、build、ci、chore、revert。
    4. scope 可选，使用小写模块名，如 auth、api、ui；无法判断时省略括号。
    5. subject 用一句话概括，英文使用祈使句现在时，首字母小写，结尾不加句号；中文简洁，不加句号；总长尽量不超过 50 字符。
    6. body 说明“为什么改”和“改了什么”，不要写“怎么改”的流水账；每行不超过 72 字符；可用 - 列表。
    7. footer 用于：
      - BREAKING CHANGE: 描述不兼容变更
      - Closes #123 / Refs #123
    8. 破坏性变更：标题写成 type(scope)!: subject，并在 footer 写 BREAKING CHANGE:。
    9. 不要编造 issue 编号、scope、影响范围。信息不足时省略对应部分。
    10. 如果变更包含多个不相关逻辑变更，优先生成多条 commit message，用单独一行 --- 分隔；否则只生成一条。
    11. 如果输出语言为中文，type 和 scope 仍用英文，subject/body 可用中文。

    【示例】
    feat(auth): add refresh token rotation

    - rotate refresh tokens on every use
    - invalidate the previous token to prevent replay attacks

    Closes #123

    【现在开始】
    根据以下变更生成 commit message：
    {{changes}}`,
    '',
    '变更内容（完整 git diff）：',
    '',
    `${FENCE}diff`,
    result.value.markdown,
    FENCE,
  ].join('\n')

  aiCommitMsg.value = ''
  pendingCommitRequest.value = true
  // [timeout] 60 秒未收到回复则视为超时，避免按钮永远 loading
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    if (pendingCommitRequest.value) {
      pendingCommitRequest.value = false
      aiGenerating.value = false
      aiError.value = 'AI 回复超时（60 秒）'
      pendingTimer = null
    }
  }, 60_000)

  const r = await copyAndFill(prompt)
  if (r === 'failed') {
    pendingCommitRequest.value = false
    aiGenerating.value = false
    aiError.value = '发送失败：请检查 AI 窗口是否已就绪'
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    // [fallback] 发送失败时用本地启发式兜底，至少给用户一个草稿
    generateLocalCommitMsg()
  }
}

/**
 * [commit-msg-ai-v1] 从 AI 回复文本中提取单行 commit message
 * [WHY] AI 可能返回多余的解释 / 代码块 / 反引号；只取第一条非空、非围栏、非标题行
 * [CONSTRAINT] 去掉首尾反引号与常见前缀；无可用行时返回原文本首段
 * [CHANGE-IMPACT] 结果写入 commitMsg 与 aiCommitMsg；两处渲染共享同一份清洗逻辑
 */
function extractCommitLine(text: string): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const Q = String.fromCharCode(96)
  const lines = raw.split('\n')
  for (const ln of lines) {
    const s = ln.trim()
    if (!s) continue
    if (s.startsWith(Q + Q + Q)) continue
    if (/^[-*+]\s/.test(s)) continue
    if (/^#+\s/.test(s)) continue
    // 去首尾反引号
    const cleaned = s.replace(new RegExp(`^${Q}+|${Q}+$`, 'g'), '').trim()
    if (cleaned) return cleaned
  }
  return raw.split('\n')[0].trim()
}

/**
 * [commit-msg-ai-v1] 订阅 transport onReply：pendingCommitRequest 为 true 时消费下一条作为 commit message
 * [WHY] 用户要求生成按钮改为'发 git diff 给 AI → 拿回复'；用一次性门控避免拦截其它无关回复
 * [CONSTRAINT] 仅 kind 为 plain/multi/done 且 text 非空时消费；消费后立即关闭门控避免重复触发
 * [CHANGE-IMPACT] 写 aiCommitMsg/commitMsg/aiGenerating；成功后会触发一次 load() 拉取最新状态
 */
let unsubscribeReply: (() => void) | null = null
onMounted(() => {
  try {
    const t = getTransport()
    unsubscribeReply = t.onReply((raw: unknown) => {
      if (!pendingCommitRequest.value) return
      const reply = raw as { kind?: string, text?: string } | null
      if (!reply) return
      const kind = String(reply.kind || 'plain')
      if (kind !== 'plain' && kind !== 'multi' && kind !== 'done') return
      const text = String(reply.text || '').trim()
      if (!text) return
      const line = extractCommitLine(text)
      if (!line) return
      aiCommitMsg.value = line
      commitMsg.value = line
      aiGenerating.value = false
      pendingCommitRequest.value = false
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    })
  } catch { /* transport 未就绪时静默；用户可手动编辑 */ }
})
onUnmounted(() => {
  if (unsubscribeReply) { try { unsubscribeReply() } catch { /* ignore */ } unsubscribeReply = null }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
})

/**
 * [commit-msg-ai-v1] 本地启发式 fallback（发送失败时使用），保留原 v2 逻辑
 * [WHY] 网络/窗口不可用时至少给用户草稿；不覆盖已成功获取的 AI 结果
 */
function generateLocalCommitMsg(): void {
  if (!result.value || !result.value.files.length) return
  const files = result.value.files

  const isTest = (p: string): boolean => /\.(?:test|spec)\.[jt]sx?$/.test(p)
  const isDoc = (p: string): boolean => /\.(?:md|mdx)$/.test(p)
  const isStyle = (p: string): boolean => /\.(?:css|scss|sass|less)$/.test(p)
  const isConfig = (p: string): boolean => /\.(?:json|ya?ml|toml)$/.test(p)
  const isSource = (p: string): boolean => /\.(?:ts|tsx|js|jsx|vue|cjs|mjs)$/.test(p) && !isTest(p)

  const tests = files.filter(f => isTest(f.path))
  const docs = files.filter(f => isDoc(f.path))
  const styles = files.filter(f => isStyle(f.path))
  const configs = files.filter(f => isConfig(f.path))
  const sources = files.filter(f => isSource(f.path))

  let type = 'chore'
  if (files.length === tests.length) type = 'test'
  else if (files.length === docs.length) type = 'docs'
  else if (files.length === styles.length) type = 'style'
  else if (files.length === configs.length) type = 'chore'
  else if (sources.some(f => f.status === 'added')) type = 'feat'
  else if (sources.some(f => f.diff && /^[+-].*(?:fix|Fix|FIX|bug|Bug|BUG|hotfix)/m.test(f.diff))) type = 'fix'
  else if (sources.length > 0 && sources.every(f => f.status === 'deleted')) type = 'remove'
  else if (sources.length > 0) type = 'refactor'

  const dirs = new Set(files.map(f => splitPath(f.path).dir).filter(Boolean))
  let scope = ''
  if (dirs.size === 1) {
    const seg = ([...dirs][0].replace(/\/+$/, '').split('/').pop() || '')
    if (seg && seg !== '.') scope = seg
  }

  let summary = ''
  if (files.length === 1) {
    const f = files[0]
    const name = splitPath(f.path).name
    const action = f.status === 'added' ? 'add' : f.status === 'deleted' ? 'remove' : 'update'
    summary = `${action} ${name}`
  } else {
    const parts: string[] = []
    if (sources.length) parts.push(`${sources.length} src`)
    if (tests.length) parts.push(`${tests.length} test`)
    if (docs.length) parts.push(`${docs.length} doc`)
    if (styles.length) parts.push(`${styles.length} style`)
    if (configs.length) parts.push(`${configs.length} config`)
    summary = parts.length ? parts.join(', ') : `${files.length} files`
  }

  commitMsg.value = scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`
}

/** [commit-split-btn-v1] 复制完整工作日志 Markdown，供窄区按钮消费 */
async function copyFullLog(): Promise<void> {
  if (!result.value || !result.value.markdown) return
  try {
    await navigator.clipboard.writeText(result.value.markdown)
  } catch { /* ignore: 剪贴板不可用时静默 */ }
}

watch(() => props.active, (v) => { if (v && !result.value && !loading.value) void load() })
</script>

<template>
  <div class="wl-pane">
    <!-- [source-control] 顶部：提交消息框 + 生成按钮 + 分体式提交按钮（VSCode 风格） -->
    <div class="wl-commit">
      <div class="wl-commit-row">
        <input
          v-model="commitMsg"
          class="wl-commit-input"
          type="text"
          placeholder="消息（⌘Enter 提交）"
          :disabled="loading"
          @keydown.meta.enter.prevent="doCommit"
          @keydown.ctrl.enter.prevent="doCommit"
        >
        <!-- [commit-msg-gen-v2] 根据变更生成 commit message -->
        <button
          class="wl-commit-gen"
          type="button"
          :disabled="loading || !result || !result.files.length"
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
      <!-- [commit-split-btn-v1] 分体式：主区提交、窄区复制完整日志；分隔线用半透明白 -->
      <!-- [commit-msg-ai-v1] AI 生成结果展示：生成中 / 成功 / 失败 -->
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
      <div v-if="loading" class="wl-empty">
        加载中…
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
          <li v-for="f in result!.files" :key="f.path" class="wl-item">
            <div class="wl-item-head" @click="toggleFile(f.path)">
              <span class="wl-chev" :class="{ open: expanded.has(f.path) }">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
              </span>
              <span class="wl-doc" :class="statusClass(f.status)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
              <span class="wl-name">{{ splitPath(f.path).name }}</span>
              <span class="wl-dir">{{ splitPath(f.path).dir }}</span>
              <span class="wl-st" :class="statusClass(f.status)">{{ statusLetter(f.status) }}</span>
            </div>
            <div v-if="expanded.has(f.path)" class="wl-diff" v-html="fileDiffHtml(f.path)" />
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.wl-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
  color: var(--text);
}

/* ── 顶部提交区（VSCode 风格） ── */
/* [commit-ui-v2] 拆为三行：输入 + 生成、分体提交按钮；列布局容纳 */
.wl-commit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 10px;
  flex-shrink: 0;
}
.wl-commit-row {
  display: flex;
  gap: 6px;
}
.wl-commit-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text);
  background: var(--surface-2, #161b22);
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
}
.wl-commit-input:focus {
  border-color: var(--primary, #2563eb);
}
.wl-commit-input::placeholder {
  color: var(--text-3);
}
/* [commit-msg-gen-v2] 生成 commit message 按钮：与输入框同高，方形 */
.wl-commit-gen {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  padding: 0;
  color: var(--text-3);
  background: var(--surface-2, #161b22);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease,
    background 0.12s ease;
}
.wl-commit-gen:hover:not(:disabled) {
  color: var(--primary, #2563eb);
  border-color: var(--primary, #2563eb);
}
.wl-commit-gen:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* [commit-split-btn-v1] 分体按钮：主区 + 窄区共享底色；中间分隔线用半透明白 */
.wl-commit-btn-row {
  display: flex;
  width: 100%;
}
.wl-commit-btn {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  font-size: 12.5px;
  font-weight: 600;
  color: #fff;
  background: var(--primary, #2563eb);
  border: 0;
  border-radius: 6px 0 0 6px;
  cursor: pointer;
  transition: filter 0.12s ease;
}
.wl-commit-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
.wl-commit-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.wl-commit-more {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: #fff;
  background: var(--primary, #2563eb);
  border: 0;
  border-left: 1px solid rgb(255 255 255 / 22%);
  border-radius: 0 6px 6px 0;
  cursor: pointer;
  transition: filter 0.12s ease;
}
.wl-commit-more:hover:not(:disabled) {
  filter: brightness(1.1);
}
.wl-commit-more:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* [commit-msg-ai-v1] AI 生成结果区：生成中 / 成功 / 失败三态 */
.wl-ai-result {
  padding: 6px 10px 0;
  font-size: 12px;
  line-height: 1.5;
}
.wl-ai-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
}
.wl-ai-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-2, #30363d);
  border-top-color: var(--primary, #2563eb);
  border-radius: 50%;
  animation: wl-ai-spin 0.8s linear infinite;
}
@keyframes wl-ai-spin {
  to {
    transform: rotate(360deg);
  }
}
.wl-ai-error {
  color: var(--danger, #f85149);
}
.wl-ai-ok {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: rgb(88 166 255 / 8%);
  border: 1px solid rgb(88 166 255 / 22%);
  border-radius: 6px;
  color: var(--text);
}
.wl-ai-label {
  flex: 0 0 auto;
  padding: 1px 6px;
  font:
    700 10px/1.4 ui-monospace,
    monospace;
  letter-spacing: 0.5px;
  color: #fff;
  background: var(--primary, #2563eb);
  border-radius: 3px;
}
.wl-ai-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  color: var(--text);
}
.wl-ai-apply {
  flex: 0 0 auto;
  padding: 2px 8px;
  font-size: 11.5px;
  color: var(--primary, #2563eb);
  background: transparent;
  border: 1px solid var(--primary, #2563eb);
  border-radius: 4px;
  cursor: pointer;
}
.wl-ai-apply:hover {
  background: rgb(88 166 255 / 12%);
}

/* [scope-refresh-moved] 原「范围 + 刷新」区已删除；刷新按钮迁至 wl-commit-row
 * [WHY] 用户要求删掉起点 ref 输入框并把刷新按钮放到生成按钮旁，视觉更紧凑
 * [CHANGE-IMPACT] 刷新按钮复用 .wl-commit-gen 的方形视觉规范（30px）
 */
.wl-commit-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  padding: 0;
  color: var(--text-3);
  background: var(--surface-2, #161b22);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease,
    background 0.12s ease;
}
.wl-commit-refresh:hover:not(:disabled) {
  color: var(--primary, #2563eb);
  border-color: var(--primary, #2563eb);
}
.wl-commit-refresh:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── 滚动区 ── */
.wl-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0 12px;
}
.wl-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
}
.wl-error {
  color: var(--danger, #f85149);
}

/* ── 分组标题「更改」 ── */
.wl-group {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.3px;
  text-transform: uppercase;
  cursor: default;
}
.wl-group-count {
  margin-left: auto;
  padding: 1px 6px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-2);
  background: var(--surface-2, #21262d);
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}

/* ── 文件列表 ── */
.wl-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.wl-item {
  border: 0;
}
.wl-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
}
.wl-item-head:hover {
  background: rgb(127 127 127 / 10%);
}
.wl-chev {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  color: var(--text-3);
  transition: transform 0.12s ease;
}
.wl-chev.open {
  transform: rotate(90deg);
}
.wl-doc {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--text-3);
}
.wl-doc.st-mod {
  color: var(--warning, #d29922);
}
.wl-doc.st-add {
  color: var(--success, #3fb950);
}
.wl-doc.st-del {
  color: var(--danger, #f85149);
}
.wl-doc.st-move {
  color: var(--primary, #2563eb);
}
.wl-name {
  flex: 0 0 auto;
  color: var(--text);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wl-dir {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-3);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: 4px;
}
.wl-st {
  flex: 0 0 auto;
  margin-left: 4px;
  font:
    700 11px/1 ui-monospace,
    monospace;
  letter-spacing: 0.3px;
}
.wl-st.st-mod {
  color: var(--warning, #d29922);
}
.wl-st.st-add {
  color: var(--success, #3fb950);
}
.wl-st.st-del {
  color: var(--danger, #f85149);
}
.wl-st.st-move {
  color: var(--primary, #2563eb);
}

/* ── 展开区 diff ── */
.wl-diff {
  padding: 4px 10px 10px;
  border-top: 1px dashed var(--border);
  background: var(--surface-2, #0d1117);
  max-height: 420px;
  overflow: auto;
}
.wl-diff :deep(.md-pre) {
  margin: 6px 0;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  font:
    11.5px/1.55 ui-monospace,
    'SF Mono',
    Menlo,
    monospace;
  tab-size: 4;
  white-space: pre;
  overflow-x: auto;
}
.wl-diff :deep(.diff-add) {
  display: inline-block;
  width: 100%;
  background: rgb(46 160 67 / 15%);
  color: #3fb950;
}
.wl-diff :deep(.diff-del) {
  display: inline-block;
  width: 100%;
  background: rgb(248 81 73 / 15%);
  color: #f85149;
}
.wl-diff :deep(.diff-hunk) {
  display: inline-block;
  width: 100%;
  background: rgb(88 166 255 / 12%);
  color: #58a6ff;
}
.wl-diff :deep(.diff-file) {
  display: inline-block;
  width: 100%;
  color: var(--text);
  font-weight: 700;
}
</style>
