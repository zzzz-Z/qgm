// AIRUNNER-BATCH10-4-SPLIT-LINT: 从 lint.ts 抽出的纯函数（pickLintTargets + 常量）；无外部依赖
import path from 'node:path'

export type ChangeType = 'added' | 'modified' | 'deleted'
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

export const LINT_EXTS = new Set(['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs'])

export function pickLintTargets(changes: Change[]): string[] {
  return changes.filter(c => c.type !== 'deleted').map(c => c.path).filter(p => LINT_EXTS.has(path.extname(p).toLowerCase()))
}
