// [preview-manager-v1] 从 ScriptPanel.vue 抽出：变更预览 / 撤回 / 变更类型查询
import { useToast } from '../../composables/ui/useToast'
import { log } from '../../utils/log'
import type { Ref } from 'vue'

/** 变更条目最小形状（只声明本模块用到的字段） */
interface ChangeLite { path: string, type: string }

/** 执行结果最小形状（只声明 runId） */
interface ResultLite { runId?: string }

/** 撤回返回值形状 */
interface RollbackResult { ok?: boolean, error?: string }

/** 预览管理器依赖面：三个 ref 由调用方持有（模板与 watch 亦用） */
export interface PreviewManagerDeps {
  changes: Ref<ChangeLite[]>
  result: Ref<ResultLite | null>
  previewFile: Ref<string | null>
  previewBefore: Ref<string | null>
  previewAfter: Ref<string>
  rollback: (file: string) => Promise<RollbackResult | null | undefined>
  rollbackAll: () => Promise<unknown>
}

/**
 * 创建预览管理器
 * @param deps - 依赖面
 */
export function createPreviewManager(deps: PreviewManagerDeps) {
  const { changes, result, previewFile, previewBefore, previewAfter, rollback, rollbackAll } = deps
  const { toast } = useToast()

  /** 从变更列表中查某文件的类型，缺省 modified */
  function getChangeType(path: string): 'modified' | 'added' | 'deleted' {
    const c = changes.value.find(x => x.path === path)
    return (c ? c.type : 'modified') as 'modified' | 'added' | 'deleted'
  }

  /** 切换 diff 预览：同文件再点关闭；否则读 after / before 并写入 */
  async function onPreviewFile(path: string): Promise<void> {
    if (previewFile.value === path && previewBefore.value !== null) { previewFile.value = null; return }
    previewFile.value = path
    try {
      const resAfter = await fetch('/__ai/files/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [path] }) })
      const dataAfter = await resAfter.json()
      previewAfter.value = dataAfter.files?.[0]?.content || ''
      if (!result.value?.runId) { previewBefore.value = ''; return }
      const resBefore = await fetch('/__ai/files/before', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: result.value.runId, file: path }) })
      const dataBefore = await resBefore.json()
      previewBefore.value = dataBefore.content ?? ''
    } catch (e) { log.error('Diff load failed', e); previewBefore.value = '' }
  }

  /** 撤回单个文件；同文件的预览自动关闭 */
  async function onRollback(file: string): Promise<void> {
    const data = await rollback(file)
    if (data && !data.ok) toast(`撤回失败：${data.error || '未知'}`, 'error')
    if (previewFile.value === file) previewFile.value = null
  }

  /** 撤回全部变更并关闭预览 */
  async function onRollbackAll(): Promise<void> {
    await rollbackAll()
    previewFile.value = null
  }

  return { getChangeType, onPreviewFile, onRollback, onRollbackAll }
}
