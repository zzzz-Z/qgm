// [arch-hono/files-v1] files 路由 Hono 版（tree/children/before/diff-from-baseline）
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { EXCLUDE_DIRS, ROOT } from '../config.js'
import { readManifest, runDir, runsDir } from '../state/snapshot.js'
import { diffIndexes, readIndex, readIndexBefore, scanIndex } from '../utils/file-index.js'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

/** 文件树遍历时排除的目录名集合 */
const TREE_EXCLUDE = new Set([
  ...EXCLUDE_DIRS,
  'coverage',
  'build',
  'out',
  'tmp',
  'temp',
  'logs',
])

/**
 * 递归构建文件树（排序 + 排除 + 深度截断）
 * [WHY] 目录优先 + 名字排序让前端展示稳定；叶子层用 hasChildren 标记"还有下一层"，
 * 让懒加载 UI 无需再发请求即可知道是否显示展开箭头
 * [CONSTRAINT] 隐藏项（以 . 开头）与 TREE_EXCLUDE 命中项被过滤；
 * 符号链接仅当目标为目录/文件时纳入（断链会被跳过）
 * [CHANGE-IMPACT] 返回结构被前端 FileNode 类型消费；叶子层的 hasChildren 字段是懒加载 UI 的关键
 * @param dir 绝对路径起点
 * @param rel 与 dir 对应的相对路径（用于生成 node.path）
 * @param depth 当前递归深度（调用方传 0）
 * @param maxDepth 最大深度；depth+1 >= maxDepth 时该子目录标记为叶子
 */
function buildFileTree(dir: string, rel = '', depth = 0, maxDepth = 5): FileNode[] {
  const out: FileNode[] = []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  const isDir = (ent: fs.Dirent): boolean => {
    if (ent.isDirectory()) return true
    if (ent.isSymbolicLink()) {
      try { return fs.statSync(path.join(dir, ent.name)).isDirectory() } catch { return false }
    }
    return false
  }
  entries.sort((a, b) => {
    const ad = isDir(a)
    const bd = isDir(b)
    if (ad !== bd) return ad ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const ent of entries) {
    const name = ent.name
    if (name.startsWith('.')) continue
    if (TREE_EXCLUDE.has(name)) continue
    const full = path.join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    const dirFlag = isDir(ent)
    if (dirFlag) {
      const isLeaf = depth + 1 >= maxDepth
      let hasChildren = false
      if (isLeaf) {
        try {
          const sub = fs.readdirSync(full, { withFileTypes: true })
          hasChildren = sub.some(n => !n.name.startsWith('.') && !TREE_EXCLUDE.has(n.name))
        } catch { /* ignore */ }
      }
      const children = isLeaf ? undefined : buildFileTree(full, r, depth + 1, maxDepth)
      const node: FileNode & { hasChildren?: boolean } = { name, path: r, type: 'directory' }
      if (children !== undefined) node.children = children
      if (isLeaf) node.hasChildren = hasChildren
      out.push(node)
    } else {
      if (ent.isSymbolicLink()) {
        try { if (!fs.statSync(full).isFile()) continue } catch { continue }
      }
      out.push({ name, path: r, type: 'file' })
    }
  }
  return out
}

/** files 路由的 Hono 实例 */
export const filesHono = new Hono()

// GET /files?depth=N → 项目文件树（默认 1，上限 6）
filesHono.get('/files', (c) => {
  const depth = Math.min(Number(c.req.query('depth')) || 1, 6)
  const tree = buildFileTree(ROOT, '', 0, depth)
  return c.json({ tree })
})

filesHono.get('/files/tree', (c) => {
  const rel = c.req.query('path') || ''
  const abs = path.resolve(ROOT, rel)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return c.json({ error: '路径越界' }, 403)
  if (!fs.existsSync(abs)) return c.json({ error: '路径不存在' }, 404)
  const tree = buildFileTree(abs, rel, 0, 32)
  return c.json({ tree })
})

filesHono.get('/files/children', (c) => {
  const rel = c.req.query('path') || ''
  const abs = path.resolve(ROOT, rel)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return c.json({ error: '路径越界' }, 403)
  const children = buildFileTree(abs, rel, 0, 1)
  return c.json({ children })
})

// POST /files/before { runId, file } → 读取变更前的文件快照
filesHono.post('/files/before', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string, file?: string } | null
  const { runId, file } = body || {}
  if (!runId || !file) return c.json({ error: '缺 runId 或 file' }, 400)
  const dir = runDir(String(runId))
  const bak = path.join(dir, `${file}.before`)
  if (!fs.existsSync(bak)) return c.json({ content: '', exists: false })
  try {
    const content = fs.readFileSync(bak, 'utf8')
    return c.json({ content, exists: true })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** 窗口内的一轮历史运行：runId + 创建时刻 + 该轮变更过的路径集合 */
interface RunTouch {
  runId: string
  createdAt: number
  paths: Set<string>
}

/**
 * [cumulative-baseline-v1] 枚举历史 run 的「触碰面」（runId + 变更路径集合），按时间升序
 * [WHY] 累积视图的每条变更必须能回答「谁改的」——回滚要落到具体的 runId，
 *   而 /rollback 只认该 run 的 manifest。manifest 里的 changes 就是现成的触碰记录。
 * [CONSTRAINT] 只认 manifest 可读的 run 目录；排序用 (createdAt, runId) 双键，
 *   避免同毫秒的两次运行顺序不稳导致归属漂移
 * [CHANGE-IMPACT] 与 resolveOwners 的窗口切片配对；GC 掉 manifest 会让对应 run 退出窗口
 */
function listRunTouches(): RunTouch[] {
  let names: string[] = []
  try { names = fs.readdirSync(runsDir()).filter(n => !n.startsWith('.')) } catch { return [] }
  const out: RunTouch[] = []
  for (const name of names) {
    const m = readManifest(name)
    if (!m) continue
    out.push({ runId: name, createdAt: m.createdAt, paths: new Set(m.changes.map(ch => ch.path)) })
  }
  return out.sort((a, b) => (a.createdAt - b.createdAt) || a.runId.localeCompare(b.runId))
}

/**
 * 判定某 run 是否还能把该文件回滚（内容来源是否仍可用）
 * [WHY] 与 /rollback 的 restoreOne 判定完全同构：added 只需删除、不需要历史内容；
 *   其余要么有 gitRef、要么有 .before 副本。前端据此禁用按钮，避免点了才报 500。
 * [CONSTRAINT] type 取自**该 run 的 manifest**（不是累积口径的 net type）——restoreOne 用的也是它
 * @param runId 归属轮
 * @param file 相对仓库根路径
 */
function canRollback(runId: string, file: string): boolean {
  const m = readManifest(runId)
  if (!m) return false
  const entry = m.changes.find(ch => ch.path === file)
  if (!entry) return false
  if (entry.type === 'added') return true
  if (m.gitRef) return true
  return fs.existsSync(path.join(runDir(runId), `${file}.before`))
}

/**
 * 为累积变更解析「归属轮」：窗口内**最早**触碰该文件的 run
 * [WHY] 回滚语义是「恢复到某 run 运行前」。取最早触碰者 → 恢复点就是基准态，
 *   等于「撤销该文件的全部累计改动」；取最新触碰者只能撤掉最后一轮，那是单轮视图已有的能力。
 * [CONSTRAINT] 窗口 = 基准 run 之后（mode='after'）或含基准 run（mode='before'）；
 *   基准在所有 manifest 中都找不到时退化为全窗口（GC 后的降级路径）
 * [CHANGE-IMPACT] 窗口切错会让归属漂到基准之前，回滚会把更早的改动一起吃掉
 * @param paths 待归属的路径集合（累积 diff 的产物）
 * @param baselineRunId 基准 run
 * @param includeBaseline true 表示基准轮自身的改动也算进累积集（对应 mode='before'）
 */
function resolveOwners(
  paths: string[],
  baselineRunId: string,
  includeBaseline: boolean,
): Map<string, { runId: string, rollbackable: boolean }> {
  const all = listRunTouches()
  const cut = all.findIndex(r => r.runId === baselineRunId)
  const window = cut < 0 ? all : (includeBaseline ? all.slice(cut) : all.slice(cut + 1))
  const want = new Set(paths)
  const owners = new Map<string, { runId: string, rollbackable: boolean }>()
  for (const run of window) {
    for (const p of run.paths) {
      if (!want.has(p) || owners.has(p)) continue
      owners.set(p, { runId: run.runId, rollbackable: canRollback(run.runId, p) })
    }
    if (owners.size === want.size) break
  }
  return owners
}

/**
 * 计算「基准 → 现在」的变更集
 * [CONSTRAINT] mode 默认 `after`（读基准轮的运行后索引），保持既有调用方语义不变；
 *   `before` 读运行前索引，才是「自该轮开始前以来」的累积口径
 * [CHANGE-IMPACT] withOwner 打开时每条会多带 runId / rollbackable，供 UI 直接驱动回滚
 */
filesHono.post('/diff-from-baseline', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { baselineRunId?: string, mode?: string, withOwner?: boolean }
    | null
  const baselineRunId = String(body?.baselineRunId || '')
  if (!baselineRunId) return c.json({ error: '缺 baselineRunId' }, 400)
  const dir = runDir(baselineRunId)
  if (!fs.existsSync(dir)) return c.json({ error: '基准记录不存在' }, 404)
  const useBefore = String(body?.mode || 'after') === 'before'
  const baseIdx = useBefore ? readIndexBefore(dir) : readIndex(dir)
  if (!baseIdx) {
    return c.json({
      error: useBefore
        ? '基准缺少运行前索引（该轮早于累积基线能力，请重新运行一轮以重新锚定基准）'
        : '基准索引缺失',
    }, 404)
  }
  const curIdx = scanIndex()
  const entries = diffIndexes(baseIdx, curIdx)
  if (body?.withOwner !== true) {
    return c.json({ baselineRunId, changes: entries.map(e => ({ path: e.path, type: e.type })) })
  }
  const owners = resolveOwners(entries.map(e => e.path), baselineRunId, useBefore)
  return c.json({
    baselineRunId,
    changes: entries.map((e) => {
      const o = owners.get(e.path)
      return { path: e.path, type: e.type, runId: o?.runId, rollbackable: o?.rollbackable === true }
    }),
  })
})

/**
 * [round-changes-v1] 取「某一轮（缺省=最新一轮）」的权威改动列表
 * [WHY] 本轮视图的数据源原本只有浏览器 summary 帧的 `changes` 一条路：只要那一帧没被前端接住
 *   （刷新丢帧 / 多标签 / 执行方不是本页 useRunner），本轮就恒为空，而累积视图走独立的磁盘 diff
 *   照常有数据 —— 用户看到的是「本轮永远空」这种无法自解释的现象。
 *   服务端每轮的 run manifest（saveSnapshot 落盘）本就保存了该轮改动，是比 summary 更权威的源，
 *   且它**不依赖累积基准**，不会把单点故障变成双点。
 * [CONSTRAINT] 只读、不改状态；manifest 缺失 / 无历史运行时返回空列表（不报错），让调用方静默降级。
 *   语义是「单轮」而非「累积」：取的是该 run 自己的 changes，与累积的「归属轮=最早触碰者」口径无关，
 *   因此不是把本轮退化成累积的子集（[cumulative-baseline-v1] 区分保持不变）。
 * [CHANGE-IMPACT] 新增端点；客户端本轮视图在 summary 为空时用它兜底
 * @param body.runId 目标轮；缺省取 listRunTouches() 的末项（时间升序 ⇒ 最新一轮）
 */
filesHono.post('/run-changes', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: string } | null
  let runId = String(body?.runId || '')
  if (!runId) {
    const all = listRunTouches()
    const last = all[all.length - 1]
    if (!last) return c.json({ ok: false, reason: '尚无历史运行记录', changes: [] })
    runId = last.runId
  }
  const m = readManifest(runId)
  if (!m) return c.json({ ok: false, runId, reason: '该轮无 manifest 记录（可能已被 GC）', changes: [] })
  return c.json({ ok: true, runId, changes: m.changes.map(ch => ({ path: ch.path, type: ch.type })) })
})
