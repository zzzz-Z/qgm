// [worklog-git-actions-v1] WorklogPane 的 git 动作簇（stage / unstage / discard）。
// [WHY] WorklogPane.vue 逼近 §4 组件 1000 行红线；这 6 个动作自成体系（4 个 HTTP 端点 + confirm 前置），
//   与面板的渲染 / 预览 / 提交逻辑无耦合，拆出后各方职责单一。
// [CONSTRAINT] 三个依赖（toast / load / confirmDialog）由调用方注入，避免本模块反向依赖组件作用域。
import type { Ref } from 'vue'

/** toast 类型（与 useToast 内部 ToastType 同构；后者未导出，此处独立声明） */
type ToastKind = 'info' | 'success' | 'warn' | 'error'

/** 单行变更记录（仅本模块需要的字段） */
export interface GitRow { path: string }

/** 动作簇依赖面 */
export interface GitActionsDeps {
  /** 统一 toast 出口（组件作用域的 useToast 实例） */
  toast: (msg: string, kind: ToastKind, ms: number) => void
  /** 动作成功后重拉面板数据 */
  reload: () => Promise<void>
  /** 破坏性动作前置确认；返回 true 表示用户确认 */
  confirm: (msg: string) => Promise<boolean>
  /** 未暂存行（stageAll / discardAll 消费） */
  unstagedRows: Ref<GitRow[]>
  /** 已暂存行（unstageAll 消费） */
  stagedRows: Ref<GitRow[]>
  /** toast 时长常量（从组件传入，避免本模块重复定义） */
  toastLong: number
  toastMedium: number
}

/**
 * 创建 git 动作簇
 * [CONSTRAINT] 所有写操作成功后统一 reload，让面板与磁盘真实状态一致
 * @param deps - 依赖面
 */
export function createGitActions(deps: GitActionsDeps) {
  const { toast, reload, confirm, unstagedRows, stagedRows, toastLong, toastMedium } = deps

  /** [git-stage-v1] 把路径加入暂存区（VSCode 未暂存栏的 + 动作）。 */
  async function stageFiles(paths: string[]): Promise<void> {
    if (!paths.length) return
    try {
      const r = await fetch('/__ai/git/stage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths }),
      })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, reason?: string }
      if (!r.ok || !j.ok) { toast(j.reason || `暂存失败（HTTP ${r.status}）`, 'error', toastLong); return }
      await reload()
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', toastLong) }
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
      if (!r.ok || !j.ok) { toast(j.reason || `取消暂存失败（HTTP ${r.status}）`, 'error', toastLong); return }
      await reload()
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', toastLong) }
  }

  /** [git-stage-v1] 全量暂存：把未暂存栏全部加入暂存区 */
  async function stageAll(): Promise<void> {
    await stageFiles(unstagedRows.value.map(r => r.path))
  }

  /** [git-stage-v1] 全量取消暂存 */
  async function unstageAll(): Promise<void> {
    await unstageFiles(stagedRows.value.map(r => r.path))
  }

  /**
   * [git-discard-v1] 丢弃工作区改动（VSCode「放弃更改」）。
   * [WHY] 破坏性且不可撤销（未跟踪文件会被直接删除），必须走 confirm 前置确认。
   * [CONSTRAINT] 已暂存的改动不在本动作范围内，须先取消暂存。
   */
  async function discardFiles(paths: string[]): Promise<void> {
    if (!paths.length) return
    const label = paths.length === 1 ? paths[0] : `${paths.length} 个文件`
    if (!(await confirm(`放弃 ${label} 的改动？此操作不可撤销。`))) return
    try {
      const r = await fetch('/__ai/git/discard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths }),
      })
      const j = await r.json().catch(() => ({})) as { ok?: boolean, reason?: string }
      if (!r.ok || !j.ok) { toast(j.reason || `放弃更改失败（HTTP ${r.status}）`, 'error', toastLong); return }
      toast(`已放弃 ${paths.length} 个文件的改动`, 'success', toastMedium)
      await reload()
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error', toastLong) }
  }

  /** [git-discard-v1] 全部放弃：把未暂存栏整体丢弃 */
  async function discardAll(): Promise<void> {
    await discardFiles(unstagedRows.value.map(r => r.path))
  }

  return { stageFiles, unstageFiles, stageAll, unstageAll, discardFiles, discardAll }
}
