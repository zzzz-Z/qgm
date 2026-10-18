// [skill-list-v1] GET /skills：扫描 .ai-runner/skills/*/SKILL.md，返回 frontmatter 元数据
// [WHY] 首问提示词只需 name+description 用于技能发现；正文按需由 AI 经 loadSkill 加载（渐进式披露）
// [CONSTRAINT] 只读 SKILL.md 前 64 行 frontmatter；目录缺失返回空数组而非 4xx，避免首问强依赖
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
// [skill-retrieval-v1] 按任务查询检索技能，替代「注入清单 + 提示 AI 自行 loadSkill」
import { rankSkills } from '../skills/retriever.js'
// [skill-frontmatter-v1] unquote / parseFrontmatter 已抽到 ../skills/frontmatter.ts。
//   此处 re-export 仅为保住既有导入路径（tests/skills-frontmatter.node-test.ts）。
//   抽出的原因：安装侧（skills/installer.ts）要复用同一解析器做落盘前校验，
//   而 routes 层被 skills/ 反向 import 会成环。
import { parseFrontmatter, unquote } from '../skills/frontmatter.js'
// [skills-install-v1] 本地优先安装：顺序由代码强制，不靠提示词自觉
import { installSkill, parseInstallSpec } from '../skills/installer.js'
// [skills-registry-v2] registry 由磁盘收敛，消灭「已装却在表里查不到」的假阴性
import { reconcileRegistry, skillsDir } from '../skills/registry.js'

export { parseFrontmatter, unquote }

interface SkillMeta {
  name: string
  description: string
  path: string
  /** [skill-keywords-v1] 可选中文/英文关键词，补足 description 的语言缺口 */
  keywords?: string
}

/** skills 路由 Hono 实例 */
export const skillsHono = new Hono()

/**
 * 扫描 .ai-runner/skills/<name>/SKILL.md，返回元数据列表。
 * [WHY] 列表与检索共用同一扫描逻辑，避免两处漂移；**磁盘是「已装清单」的唯一事实来源**
 *       （SYSTEM.md §11）。registry 只是来源标注，绝不用它判「装没装」。
 * [CONSTRAINT] 目录缺失或读取失败一律返回空数组，不抛错——首问不应因技能目录异常而中断。
 * [CHANGE-IMPACT] 被 GET /skills、POST /skills/match 与安装侧 self-check 共用。
 */
/**
 * [skill-meta-cache-v1] 按 SKILL.md 的 (路径, mtimeMs) 缓存已解析的 frontmatter。
 * [WHY] 每次 GET /skills 或 POST /skills/match 都要遍历目录并读每个 SKILL.md 全文，
 *   而 parseFrontmatter 只扫前几十行；34 个技能即单次请求 34 次读盘，且 match 里正文
 *   还要再读一遍。缓存后命中路径只需 stat（读元数据、不读内容）。
 * [CONSTRAINT] 粒度是单文件 + mtime：编辑某个 SKILL.md 只失效该条，新增/删除由
 *   readdirSync 自然发现。不用整体缓存是因为「改内容」不改目录 mtime，整体缓存会漏。
 */
const _skillMetaCache = new Map<string, { mtimeMs: number, meta: Record<string, string> | null }>()

/**
 * 清空 frontmatter 缓存（工作区切换 / 安装后强制刷新时调用）。
 * [CONSTRAINT] 与 load-rules 的 clearRulesCache 同模式：模块级单例必须有显式出口。
 */
export function clearSkillMetaCache(): void {
  _skillMetaCache.clear()
}

export function listSkillMetas(root: string): SkillMeta[] {
  const dir = skillsDir(root)
  const out: SkillMeta[] = []
  if (!fs.existsSync(dir)) return out
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    // 跳过 .registry.json / .store 等点开头条目（.store 是本地库，不是技能）
    if (ent.name.startsWith('.')) continue
    const skillFile = path.join(dir, ent.name, 'SKILL.md')
    // [skill-meta-cache-v1] stat 一次拿 mtime：命中缓存时省掉 readFileSync
    let mtimeMs: number
    // [skill-meta-cache-v1] 用 Math.floor 归一化：文件系统 mtime 的实际精度是毫秒级，
    //   而 utimesSync 等 API 会引入亚毫秒抖动（实测 ~0.018ms）——直接比浮点会让缓存永不命中。
    try { mtimeMs = Math.floor(fs.statSync(skillFile).mtimeMs) } catch { continue }
    const cached = _skillMetaCache.get(skillFile)
    let meta: Record<string, string> | null
    if (cached && cached.mtimeMs === mtimeMs) {
      meta = cached.meta
    } else {
      try {
        meta = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'))
      } catch { meta = null }
      _skillMetaCache.set(skillFile, { mtimeMs, meta })
    }
    if (!meta) {
      // [frontmatter-warn-v1] 解析失败过去是静默跳过，技能会从清单与检索中同时消失且无信号。
      console.warn(`[skills] frontmatter 解析失败，该技能将从清单与检索中缺席: ${ent.name}/SKILL.md`)
      continue
    }
    // [frontmatter-validate-v1] name / description 缺失时不得静默入表：
    //   name 空 → 注入标题退化为空；description 空 → BM25 的 descStats 恒为 0，等价自动降权。
    if (!meta.name || !meta.description) {
      console.warn(`[skills] frontmatter 缺 name 或 description，该技能将从清单与检索中缺席: ${ent.name}/SKILL.md`)
      continue
    }
    out.push({ name: meta.name, description: meta.description, keywords: meta.keywords, path: `.ai-runner/skills/${ent.name}/SKILL.md` })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * GET /skills：返回已装技能清单（磁盘为准），并顺手把 registry 收敛到磁盘。
 * [skills-registry-v2] 收敛写在读路径上是刻意的：漂移的代价是**假阴性**（已装却查不到 → 重复联网安装），
 *   而收敛是幂等的（集合无变化时不落盘）。宁可 GET 偶有一次写，也不要让 AI 拿到错误的本地视图。
 * [CONSTRAINT] 收敛失败不影响清单返回。
 */
skillsHono.get('/skills', (c) => {
  const root = getRoot()
  const skills = listSkillMetas(root)
  let registry: { added: string[], repaired: string[], removed: string[], total: number } | null = null
  try {
    registry = reconcileRegistry(root, skills.map(s => s.name))
  } catch { /* registry 异常不阻断清单 */ }
  return c.json({ ok: true, skills, registry })
})

// 正文注入上限：只取「何时用 + 核心约束」，完整正文仍在文件里
const BODY_MAX_LINES = 60
// [body-budget-v1] 字符级护栏：仅按行截断时，一行 20 万字符会被整段注入。
// 三个常量任一改动都会改变首问 context 开销，调整需重跑体积回归。
const BODY_MAX_CHARS = 3000
const LINE_MAX_CHARS = 400
// [total-budget-v1] 单次检索的总注入上限；超出时按 score 顺序丢弃尾部技能
// （丢整条而非截半条：半条正文比没有更误导）。
const TOTAL_MAX_CHARS = 6000

/**
 * 读取 SKILL.md 正文并截断；frontmatter 已被元数据消费，此处从正文起。
 * [WHY] 全量注入 14 个技能约 100KB，会挤占首问上下文；截断只保触发条件与硬约束。
 * [CONSTRAINT] 读取失败返回空串，不阻断检索端点。
 * [CHANGE-IMPACT] BODY_MAX_LINES 直接决定首问 context 开销。
 */
function readSkillBody(root: string, relPath: string): string {
  try {
    const abs = path.join(root, relPath)
    const text = fs.readFileSync(abs, 'utf8')
    const lines = text.split(/\r?\n/)
    let start = 0
    if (lines[0] && lines[0].trim() === '---') {
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].trim() === '---') { start = i + 1; break }
      }
    }
    const bodyLines = lines.slice(start).join(String.fromCharCode(10)).trim().split(/\r?\n/).slice(0, BODY_MAX_LINES)
    const capped = bodyLines.map(l => (l.length > LINE_MAX_CHARS ? `${l.slice(0, LINE_MAX_CHARS)}\u2026` : l))
    const joined = capped.join(String.fromCharCode(10))
    return joined.length > BODY_MAX_CHARS ? `${joined.slice(0, BODY_MAX_CHARS)}\u2026` : joined
  } catch { return '' }
}

/**
 * POST /skills/match：按任务文本检索最相关的技能，返回正文（截断）。
 * [WHY] 首问注入必须命中「当前任务需要哪个技能」，被动清单已被证明无效
 *       （loaded-skill.md 从未生成，skill-stats.loads 恒空）。
 * [CONSTRAINT] 查询为空或无命中返回空 matches；不抛错，不阻断首问。
 * [CHANGE-IMPACT] 被客户端 buildSkillsBlock 调用；limit 与 BODY_MAX_LINES 共同决定注入体积。
 */
skillsHono.post('/skills/match', async (c) => {
  let query = ''
  let requestedLimit: number | null = null
  let limit = 3
  try {
    const body = await c.req.json()
    query = String(body && body.query ? body.query : '')
    const n = Number(body && body.limit)
    if (Number.isFinite(n) && n > 0) {
      requestedLimit = Math.floor(n)
      // [limit-visible-v1] 超上限时钳到 MAX_MATCH_LIMIT（原实现静默降为默认值 3，
      //   调用方传 20 拿到 3 条会误判「只有 3 条相关」）。
      limit = Math.min(requestedLimit, 10)
    }
  } catch { /* 请求体非 JSON，按空查询处理 */ }

  const root = getRoot()
  const metas = listSkillMetas(root)
  const ranked = rankSkills(query, metas, limit)

  // [total-budget-v1] 按 score 顺序累加，超出总预算则丢弃尾部整条技能。
  // ranked 已按 score 降序，故高分技能优先保留。
  const matches: Array<{ name: string, path: string, score: number, matched: string[], body: string }> = []
  let truncatedByBudget = false
  let used = 0
  for (const r of ranked) {
    const body = readSkillBody(root, r.path)
    if (used + body.length > TOTAL_MAX_CHARS && matches.length > 0) {
      // [budget-truncated-visible-v1] 记录「被体积预算砍掉」，供调用方区分「只这么多相关」
      //   与「相关很多但装不下」。
      truncatedByBudget = true
      break
    }
    used += body.length
    matches.push({
      name: r.name,
      path: r.path,
      score: Number(r.score.toFixed(3)),
      matched: r.matched,
      body,
    })
  }

  return c.json({ ok: true, query, matches, requestedLimit, appliedLimit: limit, truncatedByBudget })
})

/**
 * POST /skills/install：**本地优先**安装技能（已装 → 本地库 → 联网）。
 * [WHY] 顺序本身必须被强制。旧流程只在协议文档里用散文写「先查 registry」，而 registry 会与磁盘漂移
 *   （实测磁盘 15 / 表 14 缺 pnpm）→ 假阴性 → AI 认为没装 → 在 /run 沙盒手搓 curl 拉 21 个文件 →
 *   必撞 60s 硬超时（实测 66.2s / exit -1）→ 反复重试。把顺序焊进代码后，前两层命中时
 *   `network` 恒为 0，AI 结构性上无从「跳过本地直接联网」。
 * [CONSTRAINT] 规格非法 400；运行时失败 200 + ok:false（AI 看字段判成败，不看 HTTP 状态）。
 *   联网只发生在第三层，且跑在服务端 —— 不受 /run 的 60s 沙盒超时约束。
 * [CHANGE-IMPACT] 与读侧对称：读 = GET /skills + POST /skills/match，写 = 本端点。
 */
skillsHono.post('/skills/install', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = parseInstallSpec(body)
  if (!parsed.ok) return c.json({ ok: false, error: parsed.error, where: 'spec' }, 400)
  return c.json(await installSkill(getRoot(), parsed.spec))
})
