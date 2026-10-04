import type { Change, RunResponse } from '../../types'

/**
 * 判断本轮是否需要把 changes 内容回传给 AI
 * [WHY] 单文件微改动（错误行附近的修复）无需整文件回传，可显著压缩 prompt
 * [CONSTRAINT] 无变更 / 多文件变更一律 include；单文件时只要错误行落在此文件内即跳过
 * [CHANGE-IMPACT] 决定 buildErrorContext 与 buildFullContext 的分支；影响 AI 收到的上下文规模
 * @param changes 本轮变更列表
 * @param errorLocs 错误位置映射（键为规范化路径，值为行号集合）
 */
export function shouldIncludeChanges(
  changes: Change[],
  errorLocs: Map<string, Set<number>>,
): boolean {
  if (!changes.length) return true
  if (changes.length > 1) return true
  const c = changes[0]
  const locs = errorLocs.get(c.path) || errorLocs.get(`./${c.path}`)
  if (locs && locs.size > 0) {
    // [afterlines-guard-v1] 报告 §3 P2：afterLines 缺失时 total=0 会让任何 n<=200 误判"文件内"，
    // 导致已有的 changes 被错误排除。改为缺失即保守返回 true（含 changes）。
    const total = c.afterLines
    if (typeof total !== 'number') return true
    for (const n of locs) {
      if (n <= total + 200) return false
    }
  }
  return true
}

/**
 * 判断某次运行是否为"只读结果"（成功但无变更且不在循环中）
 * [WHY] UI 据此走"只读展示"分支，不显示回滚 / 保存按钮
 * [CONSTRAINT] 五个条件任一不满足即 false：无结果 / 非 ok / runId 空 / 有变更 / 循环活动中
 * [CHANGE-IMPACT] 决定 UI 按钮可见性；改动条件会影响用户可执行的操作集
 * @param r 最近一次运行结果；null 表示无结果
 * @param isLoopActive 当前是否处于循环运行中
 */
export function isReadonlyResult(result: RunResponse | null, isLoopActive: boolean): boolean {
  if (!result || !result.ok) return false
  if (result.runId === '') return false
  if ((result.changes || []).length > 0) return false
  if (isLoopActive) return false
  return true
}
