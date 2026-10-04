// [skills-registry-v2] 技能注册表：**磁盘是唯一事实来源**，registry 只做「来源标注」。
// [WHY] 旧设计把 .ai-runner/skills/.registry.json 当「已装清单」且由 AI 手工维护 →
//   与磁盘静默漂移（2026-10-04 实测：磁盘 15 个技能 / registry 14 条，缺 pnpm）→
//   AI 查表得**假阴性**（「pnpm 没装」）→ 重复联网安装 → 反复撞 /run 60s 硬超时。
//   现在由 reconcileRegistry() 每次用磁盘收敛：集合恒等，「已装却查不到」在结构上不可能。
// [CONSTRAINT] reconcile 的结果保证：registry 名字集合 ≡ 磁盘上「含 SKILL.md 的技能目录」集合。
//   已有条目的 source/url 永不改写（只补新条目），避免把可信来源降级成 (unknown)。
// [CHANGE-IMPACT] 被 GET /skills（读路径顺手收敛）与 POST /skills/install（写后收敛）共用。
import fs from 'node:fs'
import path from 'node:path'

/** 单条技能来源记录 */
export interface SkillEntry {
  name: string
  source: string
  url: string
}

/** 注册表结构 */
export interface SkillRegistry {
  entries: SkillEntry[]
}

/** 技能根目录（相对仓库根） */
export const SKILLS_DIR_REL = '.ai-runner/skills'
/** 本地库目录名：远端下载的原始副本，供离线重装（local-first 的第二层） */
export const STORE_DIR_NAME = '.store'
const REGISTRY_NAME = '.registry.json'
// [来源行] 与 skill-discovery 协议约定一致：SKILL.md / SOURCE.md 里的 `来源: owner/repo`
const SOURCE_SCAN_LINES = 64
// [来源形状] 只接受 owner/repo 形状的来源值 —— 见 inferSource 的 CONSTRAINT
const SOURCE_VALUE_RE = /^[\w.-]+\/[\w.-]+$/
const REGISTRY_NOTE = '技能来源标注。已装清单以磁盘 .ai-runner/skills/*/SKILL.md 为唯一事实来源'
  + '（services: GET /__ai/skills）；本表由 reconcileRegistry 自动对齐磁盘，不要手工编辑。'

/** 技能根目录绝对路径 */
export function skillsDir(root: string): string {
  return path.join(root, SKILLS_DIR_REL)
}

/** 本地库根目录（远端副本仓库） */
export function storeDir(root: string): string {
  return path.join(skillsDir(root), STORE_DIR_NAME)
}

/** registry 文件绝对路径 */
export function registryFile(root: string): string {
  return path.join(skillsDir(root), REGISTRY_NAME)
}

function isEntry(v: unknown): v is SkillEntry {
  return !!v && typeof v === 'object' && typeof (v as SkillEntry).name === 'string'
}

/**
 * 读取 registry；文件缺失/损坏一律返回空表（不抛错）。
 * [CONSTRAINT] 解析失败不阻断调用方——registry 只是标注，缺失不该让清单不可用。
 */
export function loadRegistry(root: string): SkillRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(root), 'utf8')) as { entries?: unknown }
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : []
    return { entries }
  } catch {
    return { entries: [] }
  }
}

/**
 * 原子写入 registry（tmp + rename）。
 * [CONSTRAINT] 条目按 name 排序，保证同集合不同顺序也产生逐字节相同的文件（便于 sha 复核）。
 */
export function saveRegistry(root: string, reg: SkillRegistry): void {
  const file = registryFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload = {
    note: REGISTRY_NOTE,
    entries: [...reg.entries].sort((a, b) => a.name.localeCompare(b.name)),
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/**
 * 列出磁盘上「含 SKILL.md 的技能目录」名（点开头条目不计入）。
 * [WHY] 与 listSkillMetas 共用同一事实来源的**目录谓词**：reconcile 用目录，清单用 frontmatter。
 *   本函数刻意不解析 frontmatter——它定义的是「磁盘上存在这个技能」这一集合。
 */
export function listInstalledNames(root: string): string[] {
  const dir = skillsDir(root)
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    if (fs.existsSync(path.join(dir, ent.name, 'SKILL.md'))) out.push(ent.name)
  }
  return out.sort()
}

/**
 * 从技能的 SKILL.md / SOURCE.md 头部推断来源仓库（`来源:` / `source:` 行）。
 * [CONSTRAINT] 候选值必须形如 `owner/repo`，否则**宁可记 (unknown)**。
 *   理由（活端点实测踩到）：`pnpm/SKILL.md` 的 frontmatter 里有
 *   `source: Generated from https://github.com/pnpm/pnpm, …` —— 宽松匹配会把来源写成
 *   `Generated`。**写出一个「像来源却不是来源」的值，比缺失更糟**：下游会把它当成事实。
 */
export function inferSource(root: string, name: string): string {
  const dir = path.join(skillsDir(root), name)
  for (const file of ['SOURCE.md', 'SKILL.md']) {
    let text: string
    try { text = fs.readFileSync(path.join(dir, file), 'utf8') } catch { continue }
    const head = text.split(/\r?\n/).slice(0, SOURCE_SCAN_LINES).join('\n')
    const m = head.match(/^[ \t]*(?:>[ \t]*)?(?:来源|source)[ \t]*[:：][ \t]*(\S+)/im)
    if (m && m[1] && SOURCE_VALUE_RE.test(m[1])) return m[1]
  }
  return '(unknown)'
}

/** 来源值是否「可信」：owner/repo 形状，或两个显式占位符 */
function isPlausibleSource(s: unknown): boolean {
  return typeof s === 'string' && (SOURCE_VALUE_RE.test(s) || s === '(local)' || s === '(unknown)')
}

/**
 * 用磁盘技能名集合收敛 registry（幂等）。
 * [WHY] 漂移的代价是不对称的：**假阴性 → 重复联网安装**（贵且会撞超时），
 *   假阳性只是表里多一条废记录。所以以磁盘为准，表向磁盘对齐。
 * [CONSTRAINT] 集合无变化时**不落盘**（GET /skills 走此路径，避免每次首问都产生写）；
 *   已有条目的 source 若「不像来源」也会被重推 —— 否则一次错误推断会被永久保留
 *   （这正是把脏值 `Generated` 修回 `(unknown)` 的路径）。
 * @param root 仓库根目录
 * @param diskNames 磁盘上存在的技能名（由 listInstalledNames 提供）
 */
export function reconcileRegistry(root: string, diskNames: string[]): { added: string[], repaired: string[], removed: string[], total: number } {
  const reg = loadRegistry(root)
  const disk = new Set(diskNames)
  const known = new Map(reg.entries.map(e => [e.name, e]))
  const added: string[] = []
  const repaired: string[] = []
  const next: SkillEntry[] = []
  for (const name of diskNames) {
    const hit = known.get(name)
    if (hit && isPlausibleSource(hit.source)) { next.push(hit); continue }
    if (hit) repaired.push(name)
    else added.push(name)
    next.push({ name, source: inferSource(root, name), url: hit?.url || '(unknown)' })
  }
  const removed = reg.entries.filter(e => !disk.has(e.name)).map(e => e.name)
  if (added.length > 0 || removed.length > 0 || repaired.length > 0) saveRegistry(root, { entries: next })
  return { added: added.sort(), repaired: repaired.sort(), removed: removed.sort(), total: next.length }
}

/**
 * 写入/更新单条来源记录（安装成功后调用）。
 * [CONSTRAINT] 不在此处收敛整个表；调用方装完后统一 reconcile。
 */
export function upsertEntry(root: string, entry: SkillEntry): void {
  const reg = loadRegistry(root)
  const next = reg.entries.filter(e => e.name !== entry.name)
  next.push(entry)
  saveRegistry(root, { entries: next })
}
