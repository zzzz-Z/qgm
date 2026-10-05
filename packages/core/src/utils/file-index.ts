import fs from 'node:fs'
import path from 'node:path'
// AIRUNNER-BATCH4-2A-INLINE-CONST
// 从 src/config.ts 内联；strip-types 无法解析 .js 后缀 import（T6）；改常量需同步 config.ts

/** 项目根目录（进程启动时的 cwd） */
/** 文件索引条目：相对路径 + 元数据 */
export interface FileIndex {
  inode: number
  mtimeMs: number
  size: number
}

/** 索引差异条目；[CONSTRAINT] type 与 config.ts 的 Change 类型对齐 */
export interface IndexDiffEntry {
  path: string
  type: 'added' | 'modified' | 'deleted'
}

/**
 * 项目根目录（动态读取 env，兼容 setRoot 运行时切换）
 * [root-track-v1] 原为 module-level const：setRoot 后仍指向启动 cwd（隐藏 bug，与 git.ts 同类）
 */
function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.cwd()
}
/** 遍历项目时跳过的目录 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache'])
/** 遍历时跳过的路径前缀 */
const EXCLUDE_PREFIX = ['.ai-runner']
/** 判定二进制文件的扩展名集合 */
const BINARY_EXT = new Set([
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

/**
 * 判断相对路径是否命中排除规则（点目录 / EXCLUDE_DIRS / EXCLUDE_PREFIX）
 * [CONSTRAINT] 按平台路径分隔符切分后逐段匹配；Windows 下依赖 node path 的 sep 常量正确解出多级目录
 * [CHANGE-IMPACT] 修改排除集合会改变 scanIndex 遍历到的文件集，进而影响 diff 判定
 * @param rel 相对项目根的路径
 */
function isExcludedIdx(rel: string): boolean {
  if (EXCLUDE_PREFIX.some(p => rel === p || rel.startsWith(`${p}/`))) return true
  const parts = rel.split(path.sep)
  return parts.some(seg => EXCLUDE_DIRS.has(seg))
}
/**
 * 递归扫描项目，返回相对路径 → 元数据（inode / mtime / size）的映射
 * [WHY] 元数据是 diff 的廉价输入：inode+mtime+size 三者任一变化才算疑似改动，避免全量读文件
 * [CONSTRAINT] 跳过点目录 / EXCLUDE / 大于 500KB / 二进制扩展名；路径统一用正斜杠
 * [CHANGE-IMPACT] 与 diffIndexes 严格配对；改过滤条件会导致历史 run 的索引与新版不兼容
 */
export function scanIndex(): Map<string, FileIndex> {
  const map = new Map<string, FileIndex>()
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = fs.readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      const rel = path.relative(getRoot(), full)
      if (isExcludedIdx(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (stat.isFile()) {
        if (stat.size > 500_000) continue
        if (BINARY_EXT.has(path.extname(name).toLowerCase())) continue
        map.set(rel.split(path.sep).join('/'), { inode: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size })
      }
    }
  }
  walk(getRoot())
  return map
}
/**
 * 对比前后两份索引，产出变更列表（按 path 升序）
 * [WHY] 仅凭 inode / mtimeMs / size 判定，不读内容；如需内容级精确比较请用 snapshot.diffMeta
 * [CONSTRAINT] 三者任一变化即视为 modified，可能包含"mtime 被 touch 但内容相同"的假阳性
 * [CHANGE-IMPACT] 返回结构被 run.ts 消费驱动 tsc / lint 目标选择
 * @param before 运行前索引（scanIndex 结果）
 * @param after 运行后索引
 */
export function diffIndexes(
  before: Map<string, FileIndex>,
  after: Map<string, FileIndex>,
): IndexDiffEntry[] {
  const out: IndexDiffEntry[] = []
  const all = new Set<string>([...before.keys(), ...after.keys()])
  for (const p of all) {
    const b = before.get(p)
    const a = after.get(p)
    if (!b && a) { out.push({ path: p, type: 'added' })
    }
    else if (b && !a) { out.push({ path: p, type: 'deleted' })
    }
    else if (b && a && (b.inode !== a.inode || b.mtimeMs !== a.mtimeMs || b.size !== a.size)) {
      out.push({ path: p, type: 'modified' })
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}
/** 运行**后**索引文件名（该 run 结束时的磁盘状态） */
const INDEX_FILE = '_index.json'
/**
 * [cumulative-baseline-v1] 运行**前**索引文件名（该 run 开始时的磁盘状态）。
 * [WHY] _index.json 只能回答「自该轮结束以来的改动」；累积视图要的是
 *   「自该轮开始前以来的改动」，两者差一轮，必须分别留存。
 * [CONSTRAINT] 与 _index.json 同目录、同结构，仅文件名不同；改名会使历史 run 无法回读
 */
const INDEX_BEFORE_FILE = '_index.before.json'

/** 把索引 Map 序列化为 {rel: FileIndex} 并写入 dir/<file> */
function writeIndexTo(dir: string, file: string, idx: Map<string, FileIndex>): void {
  const out: Record<string, FileIndex> = {}
  for (const [k, v] of idx) out[k] = v
  fs.writeFileSync(path.join(dir, file), JSON.stringify(out))
}

/** 从 dir/<file> 反序列化索引；缺失或 JSON 损坏返回 null */
function readIndexFrom(dir: string, file: string): Map<string, FileIndex> | null {
  const target = path.join(dir, file)
  if (!fs.existsSync(target)) return null
  try {
    const obj = JSON.parse(fs.readFileSync(target, 'utf8'))
    return new Map(Object.entries(obj))
  } catch { return null }
}

/**
 * 把索引序列化为 {rel: FileIndex} JSON 落盘到 dir/_index.json
 * [CONSTRAINT] Map 转普通对象时键顺序按插入序保留；写入不做缩进优化（体积优先）
 * [CHANGE-IMPACT] 与 readIndex 严格配对；文件名 _index.json 硬编码，改名会导致历史 run 无法回读
 * @param runId 本次运行的 id（不参与落盘：目录已由调用方按 runId 开好，保留入参只为调用点对称）
 * @param idx 索引 Map（来自 scanIndex）
 * @param dir 目标目录；调用方负责保证已存在
 */
export function saveIndex(runId: string, idx: Map<string, FileIndex>, dir: string): void {
  writeIndexTo(dir, INDEX_FILE, idx)
}
/**
 * [cumulative-baseline-v1] 落盘运行**前**索引（dir/_index.before.json）
 * [WHY] 累积口径的基准必须是「该轮开始前的磁盘状态」；用运行后索引会把基准轮自身的
 *   改动漏掉，也会让「本会话第一轮」成为不可观测的盲区。
 * [CONSTRAINT] 与 readIndexBefore 严格配对；调用方须在 **runScript 之前** 取好 idx
 * [CHANGE-IMPACT] 每个 run 目录多一份索引（约与 _index.json 同量级），随 gcSnapshots(20) 一起回收
 * @param idx 索引 Map（来自运行前的 scanIndex）
 * @param dir 目标 run 目录；调用方负责保证已存在
 */
export function saveIndexBefore(idx: Map<string, FileIndex>, dir: string): void {
  writeIndexTo(dir, INDEX_BEFORE_FILE, idx)
}
/**
 * 从 dir/_index.json 反序列化索引
 * [CONSTRAINT] 文件缺失或 JSON 损坏时返回 null；调用方据此判"无历史索引"
 * [CHANGE-IMPACT] 与 saveIndex 严格配对；返回的 Map 键为 POSIX 路径
 */
export function readIndex(dir: string): Map<string, FileIndex> | null {
  return readIndexFrom(dir, INDEX_FILE)
}
/**
 * [cumulative-baseline-v1] 读回运行**前**索引（dir/_index.before.json）
 * [CONSTRAINT] 该文件是本功能之后才写入的：更早的 run 目录里没有它，返回 null（调用方须给用户
 *   可操作的提示，而不是当成「工作区没变」）
 */
export function readIndexBefore(dir: string): Map<string, FileIndex> | null {
  return readIndexFrom(dir, INDEX_BEFORE_FILE)
}
