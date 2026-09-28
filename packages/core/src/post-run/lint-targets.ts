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
 * 从变更列表中挑出需要跑 eslint 的源文件
 * [WHY] 全量 eslint 慢；只对变更文件跑可显著提速
 * [CONSTRAINT] 排除 deleted；只留 LINT_EXTS 命中的扩展名
 * [CHANGE-IMPACT] 结果被 run.ts 传给 runEslint；与 pickTscTargets 复用同一 changes 输入
 * @param changes 本轮检测到的变更列表
 */
export function pickLintTargets(changes: Change[]): string[] {
  return changes.filter(c => c.type !== 'deleted').map(c => c.path).filter(p => LINT_EXTS.has(path.extname(p).toLowerCase()))
}
