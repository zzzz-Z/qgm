// AIRUNNER-BATCH10-4-SPLIT-LINT: 从 lint.ts 抽出的纯函数（pickLintTargets + 常量）；无外部依赖
import path from 'node:path'

/** 文件变更类型：新增 / 修改 / 删除 */
export type ChangeType = 'added' | 'modified' | 'deleted'
/** 单个文件变更记录：类型、路径、差异内容 */
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

/** lint 时纳入的源文件扩展名集合 */
export const LINT_EXTS = new Set(['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * 选取 Lint Targets
 * @param changes - changes
 */
export function pickLintTargets(changes: Change[]): string[] {
  return changes.filter(c => c.type !== 'deleted').map(c => c.path).filter(p => LINT_EXTS.has(path.extname(p).toLowerCase()))
}
