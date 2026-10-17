/**
 * 工作日志面板的 git 只读浏览簇：提交历史弹窗、提交详情弹窗、分支下拉与切换。
 * [WHY] 这三块的共同职责是「向后端查询并展示」，与 WorklogPane 的变更列表/预览/提交动作正交；
 *   留在组件里会让 script 段持续膨胀（§4 组件 ≤ 1000 行），且它们是模板专用状态，无对外副作用。
 * [CONSTRAINT] branchRef 由调用方持有：load() 成功后要回写当前分支，本模块只消费不拥有。
 */
import { ref } from 'vue'

/** 提交历史条目 */
export interface CommitEntry {
  sha: string
  short: string
  author: string
  date: string
  subject: string
}

/** 提交详情（含文件清单） */
export interface CommitDetail {
  sha: string
  short: string
  author: string
  email: string
  date: string
  subject: string
  body: string
  files: Array<{ status: string, path: string }>
}

interface Deps {
  toast: (msg: string, type?: 'info' | 'success' | 'warn' | 'error', duration?: number, opts?: { key?: string }) => void
  load: () => Promise<void>
  branchRef: { value: string }
  toastLong: number
  toastMedium: number
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** ISO8601 → 本地易读时间；非法输入原样返回 */
export function fmtCommitDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function useGitBrowse(deps: Deps) {
  const { toast, load, branchRef, toastLong } = deps

  const commitsOpen = ref(false)
  const commitsLoading = ref(false)
  const commitsData = ref<CommitEntry[]>([])

  const detailOpen = ref(false)
  const detailLoading = ref(false)
  const detailData = ref<CommitDetail | null>(null)

  const branchesOpen = ref(false)
  const branchesLoading = ref(false)
  const branchesList = ref<string[]>([])
  const switchingBranch = ref(false)

  /** [git-history-dialog-v1] 懒加载：已拉过则不重复请求 */
  async function openCommits(): Promise<void> {
    commitsOpen.value = true
    if (commitsData.value.length || commitsLoading.value) return
    commitsLoading.value = true
    try {
      const r = await fetch('/__ai/git/commits?limit=100', { cache: 'no-store' })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, commits?: CommitEntry[], reason?: string }
      if (!r.ok || !j.ok) { toast(j.reason || `加载提交历史失败（HTTP ${r.status}）`, 'error', toastLong); return }
      commitsData.value = Array.isArray(j.commits) ? j.commits : []
    } catch (e) { toast(errMsg(e), 'error', toastLong) }
    finally { commitsLoading.value = false }
  }

  /** [git-history-dialog-v1] 关闭不清空，二次打开免请求 */
  function closeCommits(): void { commitsOpen.value = false }

  async function openDetail(sha: string): Promise<void> {
    detailOpen.value = true
    detailLoading.value = true
    detailData.value = null
    try {
      const r = await fetch(`/__ai/git/commit-detail?sha=${encodeURIComponent(sha)}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, detail?: CommitDetail, reason?: string }
      if (!r.ok || !j.ok || !j.detail) { toast(j.reason || `加载详情失败（HTTP ${r.status}）`, 'error', toastLong); return }
      detailData.value = j.detail
    } catch (e) { toast(errMsg(e), 'error', toastLong) }
    finally { detailLoading.value = false }
  }

  function closeDetail(): void { detailOpen.value = false }

  /** 点击分支按钮：已展开则收起，未展开则展开并刷新列表（分支可能已被外部改动） */
  function toggleBranches(): void {
    if (branchesOpen.value) { branchesOpen.value = false; return }
    void openBranches()
  }

  async function openBranches(): Promise<void> {
    branchesOpen.value = true
    branchesLoading.value = true
    try {
      const r = await fetch('/__ai/git/branches', { cache: 'no-store' })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, current?: string, list?: string[], reason?: string }
      if (!r.ok || !j.ok) { toast(j.reason || `加载分支失败（HTTP ${r.status}）`, 'error', toastLong); return }
      branchesList.value = Array.isArray(j.list) ? j.list : []
    } catch (e) { toast(errMsg(e), 'error', toastLong) }
    finally { branchesLoading.value = false }
  }

  /** [git-switch-branch-v1] dirty 保护由后端强制；成功后清空历史缓存并整面板刷新 */
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
      if (!r.ok || !j.ok) { toast(j.reason || `切换失败（HTTP ${r.status}）`, 'error', toastLong); return }
      toast(`已切到 ${j.branch}`, 'success', deps.toastMedium)
      branchesOpen.value = false
      commitsData.value = []
      await load()
    } catch (e) { toast(errMsg(e), 'error', toastLong) }
    finally { switchingBranch.value = false }
  }

  return {
    commitsOpen,
    commitsLoading,
    commitsData,
    detailOpen,
    detailLoading,
    detailData,
    branchesOpen,
    branchesLoading,
    branchesList,
    switchingBranch,
    openCommits,
    closeCommits,
    openDetail,
    closeDetail,
    toggleBranches,
    openBranches,
    switchBranch,
  }
}
