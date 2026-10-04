import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

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

let RUNS_DIR = path.join(ROOT, '.ai-runner/runs')
// eslint-disable-next-line import/no-mutable-exports -- ESM live bindings, setRoot 内重新赋值
export let SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')

let LOGS_DIR = path.join(ROOT, '.ai-runner/logs')

let BACKUP_DIR = path.join(ROOT, '.ai-runner/backup')

/**
 * 设置项目根目录并同步派生目录常量
 * [WHY] strip-types 环境下部分模块无法 import config，靠 env.AI_RUNNER_ROOT 传值；此处写 env 作权威源
 * [CONSTRAINT] 会同时重算 RUNS_DIR / SCRIPTS_DIR / LOGS_DIR / BACKUP_DIR；ESM live binding 让已 import 方读到新值
 * [CHANGE-IMPACT] 影响所有依赖派生目录的模块（snapshot / timeline / run 等）；应在启动早期调用一次
 * @param r 项目根目录；会被规范化为绝对路径
 */
export function setRoot(rootPath: string): void {
  ROOT = path.resolve(rootPath)
  // 写 env，供 strip-types 无法 import 的模块读
  process.env.AI_RUNNER_ROOT = ROOT
  // [has-workspace-v1] setRoot 即视为"已选择工作区"；与 clearWorkspace 成对
  hasWorkspace = true
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

/**
 * 用户级工作区配置目录（持久化位置）
 * [WHY] 生产环境重启后需恢复用户选择的工作区；存 home 而非工作区自身，避免"没工作区时无处存"的鸡生蛋问题
 * [CONSTRAINT] 依赖 os.homedir()；SSR / 无 HOME 环境回落空串由各函数 try/catch 兜底
 */
const WORKSPACE_CONF_DIR = path.join(os.homedir(), '.ai-runner')
/** 工作区配置文件绝对路径 */
const WORKSPACE_CONF_FILE = path.join(WORKSPACE_CONF_DIR, 'workspace.json')

/**
 * 持久化当前工作区（用户选择成功后调用）
 * [WHY] 跨进程重启恢复用户选择；不持久化则每次启动都要重选
 * [CONSTRAINT] 目录不存在自动创建；写入失败静默（配额 / 只读 fs 场景不阻断主流程）
 * [CHANGE-IMPACT] 与 loadPersistedWorkspace 严格配对；键名 root 变更会导致旧配置读取失败
 */
export function persistWorkspace(): void {
  try {
    fs.mkdirSync(WORKSPACE_CONF_DIR, { recursive: true })
    fs.writeFileSync(WORKSPACE_CONF_FILE, JSON.stringify({ root: ROOT, at: Date.now() }))
  } catch { /* ignore: 持久化失败不阻断主流程 */ }
}

/**
 * 从用户配置目录恢复工作区
 * [WHY] standalone 启动早期调用；返回路径合法性由本函数保证（存在且为目录）
 * [CONSTRAINT] 任何异常（文件缺失 / JSON 损坏 / 目录不存在）统一返回 null；调用方据此判定"用户未选过"
 * @returns 合法的绝对路径；不可用时 null
 */
export function loadPersistedWorkspace(): string | null {
  try {
    const raw = fs.readFileSync(WORKSPACE_CONF_FILE, 'utf8')
    const j = JSON.parse(raw)
    const r = String(j?.root || '')
    if (!r) return null
    if (!fs.existsSync(r)) return null
    if (!fs.statSync(r).isDirectory()) return null
    return r
  } catch { return null }
}

/**
 * 清除持久化的工作区配置
 * [WHY] 用户主动退出工作区或配置损坏时复位；不清则下次启动会误恢复
 * [CONSTRAINT] 文件不存在时静默（force: true）；与 persistWorkspace 配对
 */
export function clearPersistedWorkspace(): void {
  try { fs.rmSync(WORKSPACE_CONF_FILE, { force: true }) } catch { /* ignore */ }
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
