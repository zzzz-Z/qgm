import path from 'node:path'
import { getScopeRoot } from './workspace-scope.js'

// pkg-structure

// eslint-disable-next-line import/no-mutable-exports -- 可变绑定：setRoot 会改写
export let ROOT = process.cwd()

/**
 * 是否已绑定工作区
 * [WHY] 生产环境（standalone）默认无工作区，用户须显式选择；开发环境（vite-plugin）启动时自动绑定 process.cwd()
 * [CONSTRAINT] 与 ROOT 解耦：无工作区时 ROOT 仍保持 process.cwd()，避免 join('', ...) 静默退化为相对路径
 * [CHANGE-IMPACT] 路由层需消费本标志实现"无工作区"拒绝策略；下游 60+ getRoot() 消费点行为不变
 */
// eslint-disable-next-line import/no-mutable-exports -- 可变绑定：setRoot / clearWorkspace 会改写
export let hasWorkspace = false

// eslint-disable-next-line import/no-mutable-exports -- ESM live bindings, setRoot 内重新赋值
export let SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')

/**
 * 设置项目根目录并同步派生目录常量
 * [WHY] strip-types 环境下部分模块无法 import config，靠 env.AI_RUNNER_ROOT 传值；此处写 env 作权威源
 * [CONSTRAINT] 会同时重算 SCRIPTS_DIR；ESM live binding 让已 import 方读到新值
 * [CHANGE-IMPACT] 影响所有依赖派生目录的模块（snapshot / timeline / run 等）；应在启动早期调用一次
 * @param rootPath 项目根目录；会被规范化为绝对路径
 */
export function setRoot(rootPath: string): void {
  ROOT = path.resolve(rootPath)
  // 写 env，供 strip-types 无法 import 的模块读
  process.env.AI_RUNNER_ROOT = ROOT
  // [has-workspace-v1] setRoot 即视为"已选择工作区"；与 clearWorkspace 成对
  hasWorkspace = true
  // ESM live bindings：import 方在 setRoot 后读到的是新值
  SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')
}
/**
 * 获取 Root
 * [multi-workspace-v1] 作用域化：/run 在 runWithWorkspace 内执行时解析为该请求的工作区 root，
 *   否则回落活跃 ROOT——103 处既有调用点零改动即获得按请求隔离（并发运行不串台）
 */
export function getRoot(): string {
  return getScopeRoot(ROOT)
}

/**
 * 清除工作区绑定（回到"未选择"状态）
 * [WHY] 用户主动退出工作区或生产环境启动时复位；与 setRoot 成对
 * [CONSTRAINT] 不重置 ROOT / process.env.AI_RUNNER_ROOT：保持 cwd 与旧 env 供下游 fallback，仅翻转 hasWorkspace
 * [CHANGE-IMPACT] 路由层随即拒绝所有工作区相关请求；再次 setRoot 即恢复
 */
export function clearWorkspace(): void {
  hasWorkspace = false
}

/**
 * 读取当前工作区绑定状态
 * [WHY] 路由层守卫需在请求入口判定"是否已选工作区"，避免每个消费者都 import 可变绑定
 * [CONSTRAINT] 与 hasWorkspace ESM live binding 语义一致
 */
export function getHasWorkspace(): boolean {
  return hasWorkspace
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
  /**
   * [git-first-rollback-v1] 运行前状态的固化 ref（`refs/ai-runner/pre/<runId>`）。
   * 存在时 `.before` 刻意不落盘——内容已由该 ref 覆盖，回滚走 `git restore --source`；
   * 缺失（非 git 仓库 / 快照失败）则回落 `.before` 内容副本。
   */
  gitRef?: string
}

/** 单次脚本运行的日志条目（时间、退出码、变更数） */
export interface RunLogEntry {
  ts: number
  runId: string
  desc?: string
  why?: string
  script: string
  exit: number
  // [run-timeout-visible-v1] 超时被杀（code=-1/143）与真失败可区分；判断「是否需重试」看它
  timedOut?: boolean
  durationMs: number
  changeCount: number
  changes: Change[]
  errorFiles: string[]
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
}
