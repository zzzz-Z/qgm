// [preview-manager-v1] 从 ScriptPanel.vue 抽出：变更预览（文件内容） / 撤回
// [preview-content-v1] 预览从「行级 diff」改为「文件内容」：只拉目标文件的当前内容；
//   deleted 文件读不到当前内容，回退到该变更归属轮的 before 快照（归属轮取不到时再退本轮 runId）。
import type { Ref } from 'vue'

/** 变更条目最小形状（只声明本模块用到的字段） */
interface ChangeLite {
  path: string
  type: string
  /** 归属轮；累积视图下 deleted 文件的 before 内容要按它取，而非本轮 */
  runId?: string
}

/** 执行结果最小形状（只声明 runId） */
interface ResultLite { runId?: string }

/** 撤回返回值形状 */
interface RollbackResult { ok?: boolean, error?: string }

/** 预览管理器依赖面：三个 ref 由调用方持有（模板与 watch 亦用） */
export interface PreviewManagerDeps {
  changes: Ref<ChangeLite[]>
  result: Ref<ResultLite | null>
  previewFile: Ref<string | null>
  /** 已加载的文件内容；空串表示尚未加载或文件为空 */
  previewContent: Ref<string>
  /** 内容拉取中；模板据此显示占位而非把空内容当「文件为空」 */
  previewLoading: Ref<boolean>
  rollback: (file: string) => Promise<RollbackResult | null | undefined>
  rollbackAll: () => Promise<unknown>
}

/**
 * 创建预览管理器
 * @param deps - 依赖面
 */
export function createPreviewManager(deps: PreviewManagerDeps) {
  const { changes, result, previewFile, previewContent, previewLoading, rollback, rollbackAll } = deps
  const { toast } = useToast()
  // [preview-seq-v1] 请求序号：快速切 A/B 时旧响应会覆盖新内容；关闭后再返回会复活弹窗
  let previewSeq = 0

  /** 切换内容预览：同文件再点关闭；否则拉取内容并写入 */
  async function onPreviewFile(p: string): Promise<void> {
    if (previewFile.value === p) {
      previewFile.value = null
      // [preview-clear-v1] 关闭时清内容，防下次点新文件先用旧文件内容渲染
      previewContent.value = ''
      return
    }
    const seq = ++previewSeq
    previewFile.value = p
    previewContent.value = ''
    previewLoading.value = true
    try {
      const change = changes.value.find(x => x.path === p)
      if (change?.type === 'deleted') {
        // [preview-content-v1] 已删除的文件没有当前内容，用归属轮的改动前快照
        const beforeRunId = change.runId || result.value?.runId
        if (!beforeRunId) return
        const res = await fetch('/__ai/files/before', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: beforeRunId, file: p }) })
        const data = await res.json()
        if (seq !== previewSeq) return
        previewContent.value = data.content ?? ''
      } else {
        const res = await fetch('/__ai/files/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [p] }) })
        const data = await res.json()
        if (seq !== previewSeq) return
        previewContent.value = data.files?.[0]?.content || ''
      }
    } catch (e) {
      if (seq === previewSeq) {
        log.error('Content load failed', e)
        previewContent.value = ''
      }
    } finally {
      if (seq === previewSeq) previewLoading.value = false
    }
  }

  /** 撤回单个文件；同文件的预览自动关闭 */
  async function onRollback(file: string): Promise<void> {
    try {
      const data = await rollback(file)
      if (data && !data.ok) toast(`撤回失败：${data.error || '未知'}`, 'error')
    } catch (e) {
      toast(`撤回异常：${String(e)}`, 'error')
    }
    if (previewFile.value === file) previewFile.value = null
  }

  /** 撤回全部变更并关闭预览 */
  async function onRollbackAll(): Promise<void> {
    try {
      await rollbackAll()
    } catch (e) {
      toast(`全部撤回异常：${String(e)}`, 'error')
    }
    previewFile.value = null
  }

  return { onPreviewFile, onRollback, onRollbackAll }
}
