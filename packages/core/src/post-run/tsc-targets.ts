// AIRUNNER-BATCH10-3B-SPLIT-TARGETS: 从 tsc.ts 抽出的纯函数（pickTscTargets + 常量）；无外部依赖，strip-types 可加载
import path from 'node:path'

/** 文件变更类型：新增 / 修改 / 删除 */
export type ChangeType = 'added' | 'modified' | 'deleted'
/** 单个文件变更记录：类型、路径、差异内容 */
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

/** tsc 检查时纳入的源文件扩展名集合 */
export const TSC_EXTS = new Set(['.ts', '.tsx', '.vue', '.mts', '.cts'])

// pickTscTargets 排除测试文件：e2e/spec/test 归 playwright / node:test 管，不走根 tsconfig
export const TSC_SKIP_DIRS = ['client/e2e/', 'e2e/', 'test/', 'tests/']
/** tsc 检查时跳过的文件路径正则（测试、声明文件等） */
export const TSC_SKIP_RE = /\.(?:spec|test)\.(?:ts|tsx|mts|cts|vue)$/

/**
 * 选取 Tsc Targets
 * @param changes - changes
 */
export function pickTscTargets(changes: Change[]): string[] {
  return changes
    .filter(c => c.type !== 'deleted')
    .map(c => c.path)
    .filter(p => TSC_EXTS.has(path.extname(p).toLowerCase()) || path.extname(p).toLowerCase() === '.vue')
    .filter(p => !TSC_SKIP_DIRS.some(d => p.startsWith(d)))
    .filter(p => !TSC_SKIP_RE.test(p))
}
