// [fs-watch-v1] 工作区文件与 git 状态变化监听：recursive watcher + 噪音排除 + debounce
// [WHY] 前端文件树与 git 面板是拉取式（仅挂载 / 切 tab 时 load）；用户希望改盘即刷新
// [CONSTRAINT] 仅推 files:changed / git:changed 两类帧，不含 sid——全局事件，不进 replay 缓冲
// [CONSTRAINT] 事件路径一律归一化为「相对 root 的 posix 路径」；macOS/Linux 的 filename 形态不同
// [CHANGE-IMPACT] close() 必须被调用，否则 watcher 常驻进程；attach-ws 的 dispose 里串联
import fs from 'node:fs'
import path from 'node:path'

/** 默认忽略的目录名（路径任一段命中即排除） */
const DEFAULT_IGNORED = [
  'node_modules',
  'dist',
  '.git',
  '.ai-runner',
  '.workbuddy',
  '.trae',
  'coverage',
  '.vite',
  '.vite-temp',
  'test-results',
  'playwright-report',
]

export interface FsWatcherOptions {
  /** 追加忽略的目录名（与 DEFAULT_IGNORED 取并集） */
  ignored?: string[]
  /** debounce 窗口（毫秒），默认 300 */
  debounceMs?: number
  /** 过滤回调：返回 false 表示该路径不进事件批次 */
  shouldReport?: (relPath: string) => boolean
}

export interface FsWatcherHandles {
  /** 文件变更回调（已去重合并的路径数组，posix 相对 root） */
  onFilesChanged: (cb: (paths: string[]) => void) => void
  /** git 工作区变更回调（.git/index / HEAD 变动） */
  onGitChanged: (cb: () => void) => void
  /** 关闭所有 watcher 与挂起的 debounce 定时器 */
  close: () => void
}

/** 归一化：绝对或相对路径 → 相对 root 的 posix 路径；越界（../）返回 null */
function normalizeRel(root: string, p: string | Buffer | null): string | null {
  if (p === null) return null
  try {
    const abs = path.isAbsolute(String(p)) ? String(p) : path.resolve(root, String(p))
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel
  } catch { return null }
}

/** 路径任一段命中 ignoreSet 即排除 */
function isIgnored(rel: string, ignoreSet: Set<string>): boolean {
  for (const seg of rel.split('/')) { if (ignoreSet.has(seg)) return true
  }
  return false
}

/**
 * 建立工作区监听。
 * [WHY] 双 watcher：recursive 监听源码；非 recursive 监听 .git 顶层（index/HEAD 变动即触发 git:changed）
 * [CONSTRAINT] 目录不存在或平台不支持 recursive 时静默降级为 no-op 句柄，不抛错
 */
export function createFsWatcher(root: string, opts: FsWatcherOptions = {}): FsWatcherHandles {
  const ignoreSet = new Set([...DEFAULT_IGNORED, ...(opts.ignored || [])])
  const debounceMs = opts.debounceMs ?? 300
  const shouldReport = opts.shouldReport

  const filesCbs: Array<(paths: string[]) => void> = []
  const gitCbs: Array<() => void> = []
  const pending = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  function scheduleFlush(): void {
    if (closed || flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (closed || pending.size === 0) return
      const batch = [...pending]
      pending.clear()
      for (const cb of filesCbs) { try { cb(batch) } catch { /* swallow: 单个回调异常不阻断其余 */ } }
    }, debounceMs)
  }

  function onFsEvent(_evt: string, filename: string | Buffer | null): void {
    if (closed) return
    const rel = normalizeRel(root, filename)
    if (!rel) return
    if (isIgnored(rel, ignoreSet)) return
    if (shouldReport && !shouldReport(rel)) return
    pending.add(rel)
    scheduleFlush()
  }

  function onGitEvent(_evt: string, filename: string | Buffer | null): void {
    if (closed) return
    const name = filename ? String(filename) : ''
    // .git 顶层：只关心 index / HEAD / ORIG_HEAD / MERGE_HEAD 这几类真实改动
    if (name && !/^(?:index|HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD)$/.test(name)) return
    for (const cb of gitCbs) { try { cb() } catch { /* swallow: 单回调异常不阻断 */ } }
  }

  let fsWatcher: fs.FSWatcher | null = null
  let gitWatcher: fs.FSWatcher | null = null

  try {
    fsWatcher = fs.watch(root, { recursive: true }, onFsEvent)
    fsWatcher.on('error', () => { /* swallow: 底层 inotify 超限 / 目录被删，下一次调用重建 */ })
  } catch { fsWatcher = null }

  const gitDir = path.join(root, '.git')
  if (fs.existsSync(gitDir)) {
    try {
      gitWatcher = fs.watch(gitDir, { recursive: false }, onGitEvent)
      gitWatcher.on('error', () => { /* swallow: .git 被删（裸仓库切换） */ })
    } catch { gitWatcher = null }
  }

  return {
    onFilesChanged: (cb) => { filesCbs.push(cb) },
    onGitChanged: (cb) => { gitCbs.push(cb) },
    close: () => {
      closed = true
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      pending.clear()
      try { fsWatcher?.close() } catch { /* ignore */ }
      try { gitWatcher?.close() } catch { /* ignore */ }
    },
  }
}
