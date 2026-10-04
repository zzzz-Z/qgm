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
/**
 * 把索引序列化为 {rel: FileIndex} JSON 落盘到 dir/_index.json
 * [CONSTRAINT] Map 转普通对象时键顺序按插入序保留；写入不做缩进优化（体积优先）
 * [CHANGE-IMPACT] 与 readIndex 严格配对；文件名 _index.json 硬编码，改名会导致历史 run 无法回读
 * @param idx 索引 Map（来自 scanIndex）
 * @param dir 目标目录；调用方负责保证已存在
 */
export function saveIndex(runId: string, idx: Map<string, FileIndex>, dir: string): void {
  const out: Record<string, FileIndex> = {}
  for (const [k, v] of idx) out[k] = v
  fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify(out))
}
/**
 * 从 dir/_index.json 反序列化索引
 * [CONSTRAINT] 文件缺失或 JSON 损坏时返回 null；调用方据此判"无历史索引"
 * [CHANGE-IMPACT] 与 saveIndex 严格配对；返回的 Map 键为 POSIX 路径
 */
export function readIndex(dir: string): Map<string, FileIndex> | null {
  const file = path.join(dir, '_index.json')
  if (!fs.existsSync(file)) return null
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    return new Map(Object.entries(obj))
  } catch { return null }
}
