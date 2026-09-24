import path from 'node:path'

// pkg-structure

// eslint-disable-next-line import/no-mutable-exports -- 可变绑定：setRoot 会改写
export let ROOT = process.cwd()
// eslint-disable-next-line import/no-mutable-exports -- ESM live bindings, setRoot 内重新赋值
export let RUNS_DIR = path.join(ROOT, '.ai-runner/runs')
// eslint-disable-next-line import/no-mutable-exports -- ESM live bindings, setRoot 内重新赋值
export let SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')
// eslint-disable-next-line import/no-mutable-exports -- ESM live bindings, setRoot 内重新赋值
export let LOGS_DIR = path.join(ROOT, '.ai-runner/logs')
// eslint-disable-next-line import/no-mutable-exports -- ESM live bindings, setRoot 内重新赋值
export let BACKUP_DIR = path.join(ROOT, '.ai-runner/backup')

/**
 * 设置 Root
 * @param r - r
 */
export function setRoot(r: string): void {
  ROOT = path.resolve(r)
  // 写 env，供 strip-types 无法 import 的模块读
  process.env.AI_RUNNER_ROOT = ROOT
  // ESM live bindings：import 方在 setRoot 后读到的是新值
  RUNS_DIR = path.join(ROOT, '.ai-runner/runs')
  SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')
  LOGS_DIR = path.join(ROOT, '.ai-runner/logs')
  BACKUP_DIR = path.join(ROOT, '.ai-runner/backup')
}
/**
 * 获取 Root
 */
export function getRoot(): string {
  return ROOT
}
/** 项目识别前缀，用于日志与缓存命名空间 */
export const PREFIX = '/__ai'

/** 遍历项目时跳过的目录（依赖、构建产物、版本控制等） */
export const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache'])
/** 遍历时跳过的路径前缀（隐藏目录等） */
export const EXCLUDE_PREFIX = ['.ai-runner']
/** 判定二进制文件的扩展名集合（跳过内容读取） */
export const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.zip',
  '.gz',
  '.tar',
  '.pdf',
  '.xls',
  '.xlsx',
  '.doc',
  '.docx',
])

/** 文件变更类型：新增 / 修改 / 删除 */
export type ChangeType = 'added' | 'modified' | 'deleted'

/** 单个文件变更记录：类型、路径、差异内容 */
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

/** 一轮运行产出的变更清单（文件 + 统计） */
export interface Manifest {
  changes: Change[]
  createdAt: number
}

/** 单次脚本运行的日志条目（时间、退出码、变更数） */
export interface RunLogEntry {
  ts: number
  runId: string
  desc?: string
  why?: string
  script: string
  exit: number
  durationMs: number
  changeCount: number
  changes: Change[]
  errorFiles: string[]
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
}
