// [preview-manager-v1] 从 ScriptPanel.vue 抽出：变更预览（diff） / 撤回
// [preview-diff-v1] 2026-10-09 用户指定：弹窗内容展示 diff（新增 / 删除）。
//   预览数据因此从「只取变更后内容」改为「按类型取两侧内容」：
//     added    → 只需 after（before 天然为空，整份都是新增）
//     deleted  → 只需 before（after 天然为空，整份都是删除）
//     modified → 两侧都要：after 取当前磁盘内容，before 取**该变更归属轮**的运行前快照
//   [CONSTRAINT] before 侧来自服务端 run 目录的 `<file>.before`（POST /__ai/files/before）。
//     [git-first-rollback-v1]：运行以 git 为回滚基准时（manifest.gitRef）服务端**刻意不落 .before**
//     ⇒ 该端点返回 exists=false。此时**不得**把 before 当空串（那会把整份文件渲染成「全部新增」，
//     是一份看起来正常、实际完全错误的 diff）；改为 before=after（只有上下文行、零 +/-），
//     并置 baselineMissing 让弹窗写明原因 —— 数据来源缺失必须可见。
import type { Ref } from 'vue'
import type { ChangeType } from '../../types'
// [explicit-import-for-testability-v1] useToast / log 显式 import 而非依赖 auto-import：本模块已进入
//   node-test（tests/preview-diff.node-test.ts），test:tsc 无 auto-import 声明文件 ⇒ 靠全局标识符会 TS2304
import { useToast } from '../../composables/ui/useToast'
import { log } from '../../utils/log'

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

/** 运行前快照读取结果：exists=false 表示该轮没有落内容副本（git 基准 / 快照被回收） */
interface BeforeResult { content: string, exists: boolean }

/** 合法的变更类型集合（用于外部数据兜底收窄） */
const CHANGE_TYPES: readonly string[] = ['added', 'modified', 'deleted']

/** 预览管理器依赖面：这些 ref 由调用方持有（模板与 watch 亦用） */
export interface PreviewManagerDeps {
  changes: Ref<ChangeLite[]>
  result: Ref<ResultLite | null>
  previewFile: Ref<string | null>
  /** 预览文件的变更类型（决定 diff 口径与徽标） */
  previewType: Ref<ChangeType>
  /** 变更前内容（归属轮运行前快照） */
  previewBefore: Ref<string>
  /** 变更后内容（当前磁盘内容）；空串表示尚未加载或文件为空 */
  previewAfter: Ref<string>
  /** [preview-diff-v1] 变更前快照缺失 ⇒ 弹窗只有上下文行，需显式说明 */
  previewBaselineMissing: Ref<boolean>
  /** 内容拉取中；模板据此显示占位而非把空内容当「文件为空」 */
  previewLoading: Ref<boolean>
  rollback: (file: string) => Promise<RollbackResult | null | undefined>
  rollbackAll: () => Promise<unknown>
}

/**
 * 变更类型兜底收窄
 * [WHY] type 来自 manifest / summary 帧，历史数据可能缺字段；缺省按 modified 处理——
 *   它既不假设「整份新增」也不假设「整份删除」，是唯一安全的默认（错误可见而非被掩盖）
 * @param t 原始类型字符串
 */
function normType(t?: string): ChangeType {
  const s = String(t || '')
  return (CHANGE_TYPES.includes(s) ? s : 'modified') as ChangeType
}

/**
 * 读取某轮运行前的文件快照
 * @param runId 归属轮
 * @param file 相对仓库根路径
 */
async function readBefore(runId: string, file: string): Promise<BeforeResult> {
  const res = await fetch('/__ai/files/before', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, file }) })
  const data = await res.json()
  return { content: String(data?.content ?? ''), exists: data?.exists === true }
}

/**
 * 读取文件当前内容（磁盘态）
 * @param file 相对仓库根路径
 */
async function readAfter(file: string): Promise<string> {
  const res = await fetch('/__ai/files/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [file] }) })
  const data = await res.json()
  return String(data?.files?.[0]?.content || '')
}

/**
 * 创建预览管理器
 * @param deps - 依赖面
 */
export function createPreviewManager(deps: PreviewManagerDeps) {
  const { changes, result, previewFile, previewType, previewBefore, previewAfter, previewBaselineMissing, previewLoading, rollback, rollbackAll } = deps
  const { toast } = useToast()
  // [preview-seq-v1] 请求序号：快速切 A/B 时旧响应会覆盖新内容；关闭后再返回会复活弹窗
  let previewSeq = 0

  /**
   * 关闭预览并清空两侧内容
   * [preview-clear-v1] 不清内容则下次点新文件会先用旧文件内容渲染一帧
   * [preview-seq-v1] 递增序号让在途响应作废（关闭后迟到的响应不许复活弹窗）
   */
  function closePreview(): void {
    previewSeq++
    previewFile.value = null
    previewBefore.value = ''
    previewAfter.value = ''
    previewBaselineMissing.value = false
    previewLoading.value = false
  }

  /** 切换内容预览：同文件再点关闭；否则取两侧内容并写入 */
  async function onPreviewFile(p: string): Promise<void> {
    if (previewFile.value === p) {
      closePreview()
      return
    }
    const seq = ++previewSeq
    const change = changes.value.find(x => x.path === p)
    const type = normType(change?.type)
    previewFile.value = p
    previewType.value = type
    previewBefore.value = ''
    previewAfter.value = ''
    previewBaselineMissing.value = false
    previewLoading.value = true
    try {
      // added 只有「后」、deleted 只有「前」，另一侧根本不发请求（省一次往返，也避免把
      // 「快照缺失」误判成异常态）
      const afterTask: Promise<string> = type === 'deleted' ? Promise.resolve('') : readAfter(p)
      const beforeTask: Promise<BeforeResult> = type === 'added'
        ? Promise.resolve<BeforeResult>({ content: '', exists: true })
        : readBeforeFor(change, p)
      const [after, before] = await Promise.all([afterTask, beforeTask])
      if (seq !== previewSeq) return
      previewAfter.value = after
      if (type === 'added') return
      if (before.exists) {
        previewBefore.value = before.content
        return
      }
      // [preview-diff-v1] 快照缺失：不伪造 +，按「全上下文」展示并标记，由弹窗写明原因
      previewBefore.value = after
      previewBaselineMissing.value = true
    } catch (e) {
      if (seq === previewSeq) {
        log.error('Content load failed', e)
        previewBefore.value = ''
        previewAfter.value = ''
      }
    } finally {
      if (seq === previewSeq) previewLoading.value = false
    }
  }

  /**
   * 取变更前快照：优先用条目自带的归属轮，累积视图缺归属时退回本轮 runId
   * [CONSTRAINT] 两个 runId 都没有 ⇒ 直接判 exists=false（无依据时不发请求，也不猜）
   */
  function readBeforeFor(change: ChangeLite | undefined, file: string): Promise<BeforeResult> {
    const runId = change?.runId || result.value?.runId
    if (!runId) return Promise.resolve({ content: '', exists: false })
    return readBefore(runId, file)
  }

  /** 撤回单个文件；同文件的预览自动关闭 */
  async function onRollback(file: string): Promise<void> {
    try {
      const data = await rollback(file)
      if (data && !data.ok) toast(`撤回失败：${data.error || '未知'}`, 'error')
    } catch (e) {
      toast(`撤回异常：${String(e)}`, 'error')
    }
    if (previewFile.value === file) closePreview()
  }

  /** 撤回全部变更并关闭预览 */
  async function onRollbackAll(): Promise<void> {
    try {
      await rollbackAll()
    } catch (e) {
      toast(`全部撤回异常：${String(e)}`, 'error')
    }
    closePreview()
  }

  return { onPreviewFile, onRollback, onRollbackAll, closePreview }
}
