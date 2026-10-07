// [docs-retrieval-v1] docs 检索器：把 docs/*.md 白名单切块，供 BM25 检索。
// [WHY] SYSTEM.md/AGENTS.md 是确定性注入（每会话必读）；docs 是「按需查」的正式文档。
//       给 docs 加检索入口，让 AI 按任务查到具体章节，替代人肉 readText。
// [CONSTRAINT] 纯读；异常返空不抛；不复用 LessonDoc（其 state 是必填联合，docs 塞 pending 是撒谎）。
// [CONSTRAINT] scope 只做 lessons | docs（无 all）——all 会让 lessons+docs 混语料双向污染 IDF。
// [CHANGE-IMPACT] 被 routes/lessons.ts 的 POST /lessons/match 的 scope='docs' 消费。

import fs from 'node:fs'
import path from 'node:path'
import {
  DF_RATIO_MAX,
  MAX_MATCHED,
  pickMatchedSpans,
  SCORE_FLOOR,
  scoreField,
  termFreq,
  tokenize,
} from './bm25.js'

export interface DocChunk {
  title: string
  body: string
  src: string
  srcKind: 'doc'
  hash: string
}

export interface ScoredDocChunk extends DocChunk {
  score: number
  matched: string[]
}

/**
 * [docs-index-whitelist-v1] 只收 docs/*.md 一级；排除 plan/archive 子目录、工单、日期后缀文件。
 * [WHY] 全量索引会污染检索（工单是一次性任务书，混入会把「知识」拉低成「任务书」）。
 * [CONSTRAINT] 白名单以「路径规则」表达，不靠首行——FRONTEND-REVIEW 首行也含「报告」二字。
 */
export function isDocWhitelisted(rel: string): boolean {
  if (!rel.startsWith('docs/')) return false
  const rest = rel.slice(5)
  if (rest.includes('/')) return false
  if (!rest.endsWith('.md')) return false
  if (/workorder|WO-/i.test(rest)) return false
  if (/\d{4}-\d{2}-\d{2}/.test(rest)) return false
  return true
}

// [docs-chunk-hash-v1] 简易内容 hash（djb2）——溯源用；不引 node:crypto（避免沙箱依赖面）。
function contentHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

// [docs-split-v1] 按 '## '/'### ' 切块；跳代码围栏。title = 'basename › section'。
function splitDocChunks(basename: string, md: string): Array<{ title: string, body: string }> {
  const lines = String(md || '').split(/\r?\n/)
  const out: Array<{ title: string, body: string }> = []
  let fence = false
  let curTitle = ''
  let curBody: string[] = []
  const flush = () => {
    if (curTitle) out.push({ title: `${basename} › ${curTitle}`, body: curBody.join('\n').trim() })
    curTitle = ''
    curBody = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence
    if (!fence && /^#{2,3}\s/.test(line)) {
      flush()
      curTitle = line.replace(/^#{2,3}\s+/, '').trim()
      continue
    }
    if (curTitle) curBody.push(line)
  }
  flush()
  return out
}

export function listDocChunks(root: string): DocChunk[] {
  const docsDir = path.join(root, 'docs')
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(docsDir, { withFileTypes: true }) }
  catch { return [] }
  const out: DocChunk[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const rel = `docs/${e.name}`
    if (!isDocWhitelisted(rel)) continue
    let md = ''
    try { md = fs.readFileSync(path.join(docsDir, e.name), 'utf8') } catch { continue }
    for (const s of splitDocChunks(e.name, md)) {
      out.push({ title: s.title, body: s.body, src: rel, srcKind: 'doc', hash: contentHash(s.body) })
    }
  }
  return out
}

const TITLE_WEIGHT = 3
const BODY_WEIGHT = 1

/**
 * 按 query 检索最相关的 docs 块。
 * [CONSTRAINT] 与 rankLessons 同 BM25 双字段口径（title×3 + body×1）；同语料内自洽。
 */
export function rankDocChunks(query: string, chunks: DocChunk[], limit = 3): ScoredDocChunk[] {
  if (!query || !chunks.length) return []
  const raw = Array.from(new Set(tokenize(query)))
  const qLower = String(query).toLowerCase()
  if (!raw.length) return []

  const titleStats: Array<{ tf: Map<string, number>, len: number }> = []
  const bodyStats: Array<{ tf: Map<string, number>, len: number }> = []
  const df = new Map<string, number>()
  let titleLenSum = 0
  let bodyLenSum = 0

  for (const d of chunks) {
    const tt = tokenize(d.title)
    const bt = tokenize(d.body)
    titleStats.push({ tf: termFreq(tt), len: tt.length })
    bodyStats.push({ tf: termFreq(bt), len: bt.length })
    titleLenSum += tt.length
    bodyLenSum += bt.length
    for (const t of new Set([...tt, ...bt])) df.set(t, (df.get(t) || 0) + 1)
  }

  const total = chunks.length
  const queryTerms = raw.filter(t => (df.get(t) || 0) / total <= DF_RATIO_MAX)
  if (!queryTerms.length) return []

  const avgTitle = titleLenSum / total
  const avgBody = bodyLenSum / total

  const scored: ScoredDocChunk[] = []
  for (let i = 0; i < chunks.length; i += 1) {
    const ts = scoreField(queryTerms, titleStats[i], df, total, avgTitle)
    const bs = scoreField(queryTerms, bodyStats[i], df, total, avgBody)
    const score = ts * TITLE_WEIGHT + bs * BODY_WEIGHT
    if (score < SCORE_FLOOR) continue
    const pool = new Set([...titleStats[i].tf.keys(), ...bodyStats[i].tf.keys()])
    const matched = pickMatchedSpans(qLower, queryTerms, pool, MAX_MATCHED)
    scored.push({ ...chunks[i], score, matched })
  }

  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return scored.slice(0, limit)
}
