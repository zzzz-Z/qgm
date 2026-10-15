// [worklog-svn-v1] WorklogPane 的 SVN 支持簇（提交历史 + 提交 + 生成 commit message）。
// [WHY] WorklogPane.vue 逼近 §4 组件 1000 行红线；SVN 支持自成体系（3 个 /vcs/* 端点
//   + 独立的类型/状态/渲染分支），与 git 侧的暂存/提交逻辑无耦合，拆出后各方职责单一。
// [CONSTRAINT] 依赖面由 WorklogPane 注入，避免本模块反向依赖组件作用域。
import { ref } from 'vue'
import type { Ref } from 'vue'

/** 一次提交里的单个路径变更 */
export interface SvnPathChange {
  /** 单字符动作：A=新增 M=修改 D=删除 R=替换 */
  action: string
  /** file / dir */
  kind: string
  path: string
}

/** SVN 提交历史条目 */
export interface SvnLogEntry {
  revision: number
  author: string
  /** ISO8601 UTC */
  date: string
  msg: string
  paths: SvnPathChange[]
}

/** 工作区单个变更条目（含其 diff 片段） */
export interface SvnChangeEntry {
  path: string
  status: string
  /** 该文件的 unified diff（从整体 diff 拆出；无则为空） */
  diff: string
}

/** /vcs/log 的返回结构 */
export interface VcsLogResult {
  ok: boolean
  vcs?: string
  reason?: string
  entries?: SvnLogEntry[]
}

/** 动作簇依赖面 */
export interface WorklogSvnDeps {
  /** 读 load 序列号：probeSvnLog 内部有 await，过期响应不得覆写最新状态 */
  getLoadSeq: () => number
  /** SVN 接管时清空 git 侧结果（result + error） */
  clearGitResult: () => void
  /** 写错误信息 */
  setError: (msg: string) => void
  /** 提交成功后重拉面板 */
  reload: () => Promise<void>
  /** toast 出口 */
  toast: (msg: string, kind: 'info' | 'success' | 'warn' | 'error', ms: number) => void
  /** 发送 prompt 给受控窗口 */
  copyAndFill: (prompt: string) => Promise<string>
  /** 与 git 侧共享的时间窗（onReply 用它判回包是否在窗口内） */
  waitingSince: Ref<number>
  toastLong: number
  toastMedium: number
}

/**
 * 创建 SVN 支持簇
 * [CONSTRAINT] vcsMode 默认 'git'（乐观默认，git 用户不该看到模式切换闪烁）；
 *   仅当 git 链路失败且 /vcs/log 报 vcs='svn' 时才翻成 'svn'。
 */
export function useWorklogSvn(deps: WorklogSvnDeps) {
  const { getLoadSeq, clearGitResult, setError, reload, toast, copyAndFill, waitingSince, toastLong, toastMedium } = deps
  const vcsMode = ref<'git' | 'svn'>('git')
  const svnEntries = ref<SvnLogEntry[]>([])
  const svnExpanded = ref<number | null>(null)
  // [vcs-svn-history-collapse-v1] 提交历史整段收起/展开（默认展开，与 git 侧「已暂存/更改」常显一致）
  const svnHistoryOpen = ref(true)
  const svnCommitMsg = ref('')
  const svnCommitting = ref(false)
  const svnGenerating = ref(false)
  const genTarget = ref<'git' | 'svn'>('git')
  const svnChanges = ref<SvnChangeEntry[]>([])
  const svnChangesLoading = ref(false)
  const svnReverting = ref(false)

  /**
   * 探测 VCS 并在确为 SVN 工作副本时接管展示。
   * [CONSTRAINT] 必须带 mySeq 校验：内部有 await，期间用户可能已触发新一轮 load。
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
      if (mySeq !== getLoadSeq()) return false
      const j = await r.json().catch(() => ({})) as VcsLogResult
      if (mySeq !== getLoadSeq()) return false
      if (j.vcs !== 'svn') return false
      vcsMode.value = 'svn'
      svnEntries.value = Array.isArray(j.entries) ? j.entries : []
      // 默认展开最新一次提交：用户打开面板最想看的就是「最近改了什么」
      svnExpanded.value = svnEntries.value.length ? svnEntries.value[0].revision : null
      clearGitResult()
      if (!j.ok) setError(j.reason || 'svn log 失败')
      void loadSvnChanges()
      return true
    } catch {
      return false
    }
  }

  /**
   * 按 `Index: <path>` 头把整体 diff 拆成每文件片段。
   * [WHY] /vcs/diff 一次给回整份 diff，而预览/撤销是按文件粒度操作的；
   *   在这里一次性拆开，前端就不用为每个文件再打一次端点。
   * [CONSTRAINT] 用 `^Index: ` 锚定（svn 输出恒有该头），不用 `diff --git` —— 后者受路径前缀影响。
   */
  function splitSvnDiff(diff: string): Map<string, string> {
    const map = new Map<string, string>()
    if (!diff) return map
    const parts = diff.split(/^Index: /m)
    for (const part of parts) {
      if (!part.trim()) continue
      const nl = part.indexOf('\n')
      const path = (nl < 0 ? part : part.slice(0, nl)).trim()
      if (path) map.set(path, `Index: ${part}`)
    }
    return map
  }

  /**
   * 拉工作区改动（文件清单 + 每文件 diff 片段），填充 svnChanges。
   * [CONSTRAINT] 失败只清空列表，不清 vcsMode/历史——变更列表缺失不应让整面板报错。
   */
  async function loadSvnChanges(): Promise<void> {
    if (svnChangesLoading.value) return
    svnChangesLoading.value = true
    try {
      const r = await fetch('/__ai/vcs/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, files?: Array<{ path: string, status: string }>, diff?: string }
      if (!r.ok || !j.ok) { svnChanges.value = []; return }
      const files = Array.isArray(j.files) ? j.files : []
      const diffMap = splitSvnDiff(String(j.diff || ''))
      svnChanges.value = files.map(f => ({ path: f.path, status: f.status, diff: diffMap.get(f.path) || '' }))
    } catch {
      svnChanges.value = []
    } finally {
      svnChangesLoading.value = false
    }
  }

  /**
   * 撤销指定路径（空数组 = 整个工作副本）的本地改动。
   * [CONSTRAINT] 撤销后必须重拉变更列表并触发父组件 reload（历史不变但状态要刷新）。
   */
  async function doSvnRevert(paths: string[]): Promise<void> {
    if (svnReverting.value) return
    svnReverting.value = true
    try {
      const r = await fetch('/__ai/vcs/revert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths }),
      })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, reason?: string, reverted?: string[] }
      if (!r.ok || !j.ok) { toast(j.reason || `撤销失败（HTTP ${r.status}）`, 'error', toastLong); return }
      toast(paths.length ? `已撤销 ${paths.length} 个文件` : '已撤销全部改动', 'success', toastMedium)
      await loadSvnChanges()
      await reload()
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', toastLong) }
    finally { svnReverting.value = false }
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

  /**
   * [vcs-svn-ui-align-v1] 工作区变更的 wc-status item → 单字母（与 git 侧 statusLetter 同口径）。
   * [WHY] svn status --xml 的 item 是英文（modified/added/...），直接显示与 git 侧的单字母风格割裂；
   *   映射到 M/A/D/R/C/? 后，两侧列表看起来一致。
   * [CONSTRAINT] unversioned 用 '?'（git 未跟踪用 ??），missing 用 '!'（svn 独有的「文件被删但未 svn delete」）。
   */
  function svnStLetter(s: string): string {
    if (s === 'added' || s === 'replaced') return s === 'added' ? 'A' : 'R'
    if (s === 'deleted' || s === 'missing') return s === 'deleted' ? 'D' : '!'
    if (s === 'conflicted') return 'C'
    if (s === 'unversioned') return '?'
    return 'M'
  }

  /** 工作区变更的 wc-status item → 配色类（语义同 git 侧 statusClass） */
  function svnStCls(s: string): string {
    if (s === 'added' || s === 'replaced') return 'st-add'
    if (s === 'deleted' || s === 'missing') return 'st-del'
    if (s === 'conflicted') return 'st-move'
    return 'st-mod'
  }

  /**
   * 提交 SVN 本地改动。
   * [CONSTRAINT] 无变更时后端归一化为 ok:true + revision:null（幂等），此处按此语义提示。
   */
  async function doSvnCommit(): Promise<void> {
    if (!svnCommitMsg.value.trim() || svnCommitting.value) return
    svnCommitting.value = true
    try {
      const r = await fetch('/__ai/vcs/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: svnCommitMsg.value.trim() }),
      })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, revision?: number | null, reason?: string }
      if (!r.ok || !j.ok) { toast(j.reason || `提交失败（HTTP ${r.status}）`, 'error', toastLong); return }
      toast(j.revision ? `已提交 r${j.revision}` : '无可提交的改动', 'success', toastMedium)
      svnCommitMsg.value = ''
      await reload()
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', toastLong) }
    finally { svnCommitting.value = false }
  }

  /**
   * 生成 SVN commit message。
   * [WHY] git 侧已有 generateCommitMsg（基于 /git/worklog 的 markdown）；SVN 侧此前只有提交历史。
   * [CONSTRAINT] 复用 git 侧的 GITMSG 哨兵 + waitingSince 窗口闸门，
   *   通过 genTarget 标记本轮期待 SVN 回包（onReply 按此路由到 svnCommitMsg）。
   */
  async function generateSvnCommitMsg(): Promise<void> {
    if (svnGenerating.value) return
    svnGenerating.value = true
    try {
      const r = await fetch('/__ai/vcs/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, vcs?: string, files?: Array<{ path: string, status: string }>, diff?: string, reason?: string }
      if (!r.ok || !j.ok) {
        svnGenerating.value = false
        toast(j.reason || `读取 SVN 改动失败（HTTP ${r.status}）`, 'error', toastLong)
        return
      }
      const files = Array.isArray(j.files) ? j.files : []
      if (!files.length) {
        svnGenerating.value = false
        toast('无变更可生成', 'warn', toastMedium)
        return
      }
      const Q = String.fromCharCode(96)
      const F3 = Q + Q + Q
      const NL = String.fromCharCode(10)
      const fileList = files.map(f => `${f.status}  ${f.path}`).join(NL)
      const prompt = [
        'ASK',
        '请根据我提供的 SVN 变更，生成标准(中文) commit message。',
        `【重要】回复必须以哨兵前缀 ${Q}GITMSG:${Q} 开头（单独一行，冒号后直接跟 commit message），`,
        '  客户端靠这个前缀精确提取你的输出。例如：',
        `  ${Q}GITMSG: feat(svn): add xxx${Q}`,
        `  若有多行 body，则首行仍是 ${Q}GITMSG: <head>${Q}，后续行为 body。`,
        '【规则】',
        '1. 只输出 commit message 本身（带哨兵前缀），不要解释、不要 markdown 代码块。',
        '2. 格式：GITMSG: <type>(<scope>): <subject>。',
        '3. type 只能用：feat、fix、docs、style、refactor、perf、test、build、ci、chore、revert。',
        '4. subject 一句话概括，英文祈使句现在时，不加句号。',
        '5. 不要编造 issue 编号、scope、影响范围。',
        '',
        '变更文件清单：',
        fileList,
        '',
        `diff（${F3}diff 围栏）：`,
        `${F3}diff`,
        String(j.diff || ''),
        F3,
      ].join(NL)

      genTarget.value = 'svn'
      waitingSince.value = Date.now()
      const r2 = await copyAndFill(prompt)
      if (r2 === 'failed') {
        svnGenerating.value = false
        genTarget.value = 'git'
        toast('发送失败：请检查 AI 窗口是否已就绪', 'error', toastLong)
      }
    } catch (e) { svnGenerating.value = false; toast(e instanceof Error ? e.message : String(e), 'error', toastLong) }
  }

  return {
    vcsMode,
    svnEntries,
    svnExpanded,
    svnHistoryOpen,
    svnCommitMsg,
    svnCommitting,
    svnGenerating,
    genTarget,
    probeSvnLog,
    toggleSvn,
    fmtSvnDate,
    svnActClass,
    svnStLetter,
    svnStCls,
    doSvnCommit,
    generateSvnCommitMsg,
    svnChanges,
    svnChangesLoading,
    svnReverting,
    loadSvnChanges,
    doSvnRevert,
  }
}
