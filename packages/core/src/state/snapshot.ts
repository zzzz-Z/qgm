import fs from 'node:fs'
import path from 'node:path'
import type { Change, Manifest, RunLogEntry } from '../config.js'
import { resolveScopedRoot } from '../workspace-scope.js'

/** 文件快照元数据：路径、大小、修改时间、哈希 */
export interface FileMeta {
  size: number
  mtimeMs: number
  ino: number
}

/** 工作区快照数据：文件集合 + 统计 */
export interface SnapshotData {
  contents: Map<string, string>
  meta: Map<string, FileMeta>
}

// [control-log-v1] 新增两个控制面通道（详见 routes/control-log.ts 的 WHY）：
//   `reject` = /run 的前置拒收（体积 / 截断 / 契约 / 语法）—— 此前**零留痕**，
//     而这类 4xx 发生在 NDJSON 流开始之前，写不进按流写的 runner.jsonl；
//   `board`  = /tasks 的写请求 —— 用于判定「AI 声称已 start/complete 但看板没变」是否真的发生过。
// [send-trace-v1] `send` = **出站 fill** 的留痕（页面通道每次投递一条，见 routes/send-log.ts 的 WHY）：
//   runner/reject 都是「脚本已到服务端」之后的事，而「应用往 AI 页面发了多少条提问」在服务端此前
//   完全不可见 —— 频控阈值、同轮双发、多块放大都没法验收，只能靠 run 数间接推算。
// [arrive-log-v1] `arrive` = **脚本到达前端**的留痕（页面通道每推一条上报一次，见 routes/arrive-log.ts 的 WHY）：
//   收件箱是内存态、到达播报已删，这一段此前零落盘 ⇒ 「没推送」与「推了被吞」在服务端同形，只能猜。
export type LogChannel = 'runner' | 'pipeline' | 'decisions' | 'reject' | 'board' | 'send' | 'wiki' | 'arrive' | 'headless'
// AIRUNNER-BATCH4-3A-INLINE-CONST
// 从 src/config.ts 内联常量；strip-types 无法解析 .js 后缀 import（T6）。
// 可变路径用 getter（config.setRoot 会写 AI_RUNNER_ROOT 到 env；避免 ESM 常量快照）。

/** 获取项目根目录 */
const getRoot = (): string => resolveScopedRoot() // [multi-workspace-v1] ALS 作用域优先，env/cwd 回落
/** 获取运行记录目录（.ai-runner/runs） */
const getRunsDir = (): string => path.join(getRoot(), '.ai-runner/runs')
/** 获取临时脚本目录（.ai-runner/scripts） */
const getScriptsDir = (): string => path.join(getRoot(), '.ai-runner/scripts')
/** 获取日志目录（.ai-runner/logs） */
const getLogsDir = (): string => path.join(getRoot(), '.ai-runner/logs')
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

/** 单个快照文件的最大字节数（超过跳过） */
const MAX_SNAPSHOT_SIZE = 500_000
/** 日志保留天数 */
const LOG_KEEP_DAYS = 30

/**
 * 判断相对路径是否命中排除规则（点目录、EXCLUDE_DIRS、EXCLUDE_PREFIX）
 * [CONSTRAINT] 按平台路径分隔符切分后逐段匹配；Windows 下依赖 node path 的 sep 常量正确解出多级目录
 * [CHANGE-IMPACT] 修改排除集合会改变 scanMeta / snapshot 遍历到的文件集，进而影响 diff 判定
 * @param rel 相对项目根的路径（正斜杠或平台分隔符）
 */
export function isExcluded(rel: string): boolean {
  if (EXCLUDE_PREFIX.some(p => rel === p || rel.startsWith(`${p}/`))) return true
  const parts = rel.split(path.sep)
  return parts.some(seg => EXCLUDE_DIRS.has(seg))
}

/**
 * 判定某文件是否纳入快照（过滤大文件与二进制）
 * [WHY] 二进制内容无 diff 语义、大文件会拖爆内存；两重过滤在 walk 早期生效，代价最小
 * [CONSTRAINT] 阈值 MAX_SNAPSHOT_SIZE 硬编码；BINARY_EXT 只判扩展名（无 magic number 嗅探）
 * @param name 文件名（用于取扩展名）
 * @param stat node fs 的 Stat 对象；读取其 size 字段（字节数）
 */
function acceptSnapshotFile(name: string, stat: fs.Stats): boolean {
  if (!stat.isFile()) return false
  if (stat.size > MAX_SNAPSHOT_SIZE) return false
  if (BINARY_EXT.has(path.extname(name).toLowerCase())) return false
  return true
}

/** 仅扫描元数据（不读内容），用于增量比对定位候选变更 */
export function scanMeta(): Map<string, FileMeta> {
  const meta = new Map<string, FileMeta>()
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      const rel = path.relative(getRoot(), full)
      if (isExcluded(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (acceptSnapshotFile(ent.name, stat)) {
        meta.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
      }
    }
  }
  walk(getRoot())
  return meta
}

/** 全量快照：内容 + 元数据（运行前调用一次，供备份与比对基准） */
export function snapshot(): SnapshotData {
  const contents = new Map<string, string>()
  const meta = new Map<string, FileMeta>()
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      const rel = path.relative(getRoot(), full)
      if (isExcluded(rel)) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full) }
      else if (acceptSnapshotFile(ent.name, stat)) {
        meta.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
        try { contents.set(rel, fs.readFileSync(full, 'utf8')) } catch { /* ignore */ }
      }
    }
  }
  walk(getRoot())
  return { contents, meta }
}

/**
 * 增量 diff：元数据（size/mtime/ino）未变的文件直接跳过，
 * 仅对疑似变更的文件读内容做精确比较（mtime 被 touch 但内容相同不算变更）。
 */
export function diffMeta(
  before: Map<string, string>,
  beforeMeta: Map<string, FileMeta>,
  afterMeta: Map<string, FileMeta>,
): Change[] {
  const out: Change[] = []
  const all = new Set<string>([...beforeMeta.keys(), ...afterMeta.keys()])
  for (const p of all) {
    const bm = beforeMeta.get(p)
    const am = afterMeta.get(p)
    if (!bm && am) {
      let after = ''
      try { after = fs.readFileSync(path.join(getRoot(), p), 'utf8') } catch { /* ignore */ }
      out.push({ path: p, type: 'added', afterLines: countLines(after) })
    }
    else if (bm && !am) {
      out.push({ path: p, type: 'deleted' })
    }
    else if (bm && am && (bm.size !== am.size || bm.mtimeMs !== am.mtimeMs || bm.ino !== am.ino)) {
      let after = ''
      try { after = fs.readFileSync(path.join(getRoot(), p), 'utf8') } catch { /* ignore */ }
      if (before.get(p) !== after) {
        out.push({ path: p, type: 'modified', afterLines: countLines(after) })
      }
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

/**
 * 统计字符串行数（换行符计数 + 1）
 * [CONSTRAINT] 空串返回 0；不含末尾换行的单行文本返回 1；不处理 CRLF 差异
 * [WHY] 手写而非 split('换行').length，避免大文件场景产生中间数组
 */
function countLines(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) { if (text.charCodeAt(i) === 10) n++
  }
  return n
}
/** 日志文件保留天数（超过清理） *//**
                      * 清理超过 LOG_KEEP_DAYS 的日志（仅 .jsonl）；由 ensureDirs 触发
                      * [CONSTRAINT] 单项失败不中断其余清理；目录不存在时静默返回
                      * [CHANGE-IMPACT] 修改 LOG_KEEP_DAYS 会影响历史日志保留窗口，但不动既存文件
                      */
function gcLogs() {
  try {
    const cutoff = Date.now() - LOG_KEEP_DAYS * 86400000
    for (const name of fs.readdirSync(getLogsDir())) {
      if (!name.endsWith('.jsonl')) continue
      const p = path.join(getLogsDir(), name)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch { /* swallow: 单条日志 stat/unlink 失败不中断其余清理 */ }
    }
  } catch { /* swallow: 日志目录不存在 / 读取失败，GC 失败无副作用 */ }
}
/**
 * 幂等创建 .ai-runner 下的 runs / scripts / logs 三个目录，并触发一次日志 GC
 * [CONSTRAINT] 使用 recursive:true，已存在时不抛错
 * [CHANGE-IMPACT] 由 run 路由 / server 启动路径调用；删除会破坏首次运行时目录缺失的兜底
 */
export function ensureDirs() {
  fs.mkdirSync(getRunsDir(), { recursive: true })
  fs.mkdirSync(getScriptsDir(), { recursive: true })
  fs.mkdirSync(getLogsDir(), { recursive: true })
  gcLogs()
}

/**
 * 计算某次运行对应的快照目录绝对路径
 * [CONSTRAINT] 不做存在性校验，调用方负责 mkdir；与 getRunsDir 相对布局配套
 * [rundir-traversal-guard-v1] runId 有两个来源：内部生成（`<ts>-<rand>`）与 HTTP body
 *   （/rollback /rollback-all /save /diff-from-baseline 的 runId 参数直传到此）。
 *   裸 path.join 时 `../` 可逃出 runs/，而调用方（rollback-all/save）随后会
 *   `fs.rmSync(dir, { recursive: true, force: true })` —— 路径穿越 + 递归强删叠加，
 *   误传/恶意 runId 可删掉 runs 外的任意目录。故先压成安全字符集，再校验解析结果
 *   必须落在 runs/ 内；非法即抛（路由层由 Hono 兜成 500，不静默放行）。
 */
export function runDir(runId: string) {
  const safe = String(runId).replace(/[^\w.-]/g, '')
  const dir = path.join(getRunsDir(), safe)
  const rel = path.relative(getRunsDir(), dir)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw new Error(`非法 runId（越出运行记录目录）: ${JSON.stringify(runId)}`)
  }
  return dir
}

/**
 * [cumulative-baseline-v1] 运行记录根目录（.ai-runner/runs）
 * [WHY] 累积视图要枚举历史 run 的 manifest 找「归属轮」；gcSnapshots 只做回收，
 *   没有对外暴露遍历入口，故补一个只读访问器（与 runDir 同源，避免调用方自行拼路径）
 * [CONSTRAINT] 不保证目录存在；调用方须自行兜住 readdirSync 失败
 */
export function runsDir(): string {
  return getRunsDir()
}

/**
 * 保留最近 keep 个快照目录，其余按 mtime 逆序删除
 * [CONSTRAINT] keep=0 时清空全部；单项 stat 失败视为不可用条目，直接从候选集剔除
 * [CHANGE-IMPACT] 会删除磁盘文件，误传 keep 会导致历史快照丢失
 * @param keep 保留数量（正整数）
 */
export function gcSnapshots(keep: number) {
  try {
    const entries = fs.readdirSync(getRunsDir())
      .filter(n => !n.startsWith('.'))
      .map((n) => {
        try { return { name: n, mtime: fs.statSync(path.join(getRunsDir(), n)).mtimeMs } }
        catch { return null }
      })
      .filter((x): x is { name: string, mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
    for (let i = keep; i < entries.length; i++) {
      fs.rmSync(path.join(getRunsDir(), entries[i].name), { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}

/**
 * 保存变更前内容到快照目录，供 rollback 还原
 * [WHY] 只对 modified / deleted 文件落盘：added 无历史内容、其他类型无意义
 * [CONSTRAINT] before 缺失对应项时静默跳过（首次运行 / 快照被 GC 的边界）
 * [CHANGE-IMPACT] 备份路径为 dir/{path}.before，rollback 侧按同规则回读，命名不可改
 * [git-first-rollback-v1] `opts.gitRef` 存在时**刻意不落 .before**：运行前内容已由 git ref 覆盖
 *   （rollback 侧走 gitRestoreFile），再落一份等于同内容存两处。`_manifest.json` 仍照写——
 *   它是回滚索引（changes 列表 + gitRef），不是内容副本，代价可忽略。
 * @param runId 本次运行的唯一 id（与 runDir 一致）
 * @param before 运行前全量内容（snapshot() 结果）
 * @param changes 本次运行检测到的变更列表
 * @param opts 可选参数；省略即走内容副本
 * @param opts.gitRef 存在表示内容来源为 git 运行前 ref（跳过 .before 落盘）
 */
export function saveSnapshot(
  runId: string,
  before: Map<string, string>,
  changes: Change[],
  opts?: { gitRef?: string },
) {
  const dir = runDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  const gitRef = opts?.gitRef
  if (!gitRef) {
    for (const c of changes) {
      if (c.type === 'added') continue
      const content = before.get(c.path)
      if (content === undefined) continue
      const bak = path.join(dir, `${c.path}.before`)
      fs.mkdirSync(path.dirname(bak), { recursive: true })
      fs.writeFileSync(bak, content)
    }
  }
  const manifest: Manifest = { changes, createdAt: Date.now(), ...(gitRef ? { gitRef } : {}) }
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2))
}

/**
 * 读取指定运行的 manifest.json 并解析
 * [CONSTRAINT] 文件缺失或 JSON 损坏时返回 null；不抛错，调用方据此判"不可用"
 * [CHANGE-IMPACT] 与 saveSnapshot 写入的 _manifest.json 严格配对
 */
export function readManifest(runId: string): Manifest | null {
  const file = path.join(runDir(runId), '_manifest.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest
  } catch {
    return null
  }
}

// [channel-log-v1] PLAN 7.D2 三通道结构化日志（runner/pipeline/decisions）
/** 日志通道枚举：runner / pipeline / decisions 等 */
/**
 * 追加一条三通道结构化日志到 logs/{channel}.jsonl
 * [CONSTRAINT] 自动注入 ts 字段，调用方 entry 若含 ts 会被覆盖；单行 JSON 便于后续流式解析
 * [CHANGE-IMPACT] 每行必须单行（不得含换行符），否则 jsonl 结构破坏
 * [WHY generic] 形参从 `Record<string, unknown>` 放宽成泛型：日志体来自具名 interface
 *   （如 `RejectLogEntry` / `BoardLogEntry`），interface 没有索引签名，无法赋给
 *   `Record<string, unknown>` —— 收紧形参只会把「加一条日志」变成「改一处类型声明再补一次 cast」，
 *   而本函数的契约本就不约束字段形状（只要求可 JSON 序列化 + 单行）。
 * @param channel 通道名（runner / pipeline / decisions / reject / board）
 * @param entry 日志体；写入时会被展开到 { ts, ...entry }
 */
export function writeChannelLog<T extends object>(channel: LogChannel, entry: T): void {
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true })
    const file = path.join(getLogsDir(), `${channel}.jsonl`)
    const payload = { ts: Date.now(), ...entry }
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`)
  } catch { /* ignore */ }
}
/**
 * 追加一条运行日志到 logs/YYYY-MM-DD.jsonl（按 UTC 日期分片）
 * [CONSTRAINT] 日期用 ISO 串截取前 10 位（UTC），与本地时区无关；跨天零点切换文件
 * [CHANGE-IMPACT] 与 gcLogs 的 30 天保留策略配对：分片名变化会影响清理粒度
 */
export function writeRunLog(entry: RunLogEntry) {
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const file = path.join(getLogsDir(), `${date}.jsonl`)
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch { /* ignore */ }
}
