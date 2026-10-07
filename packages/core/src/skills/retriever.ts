// [skill-retrieval-v2] BM25 with stopwords, df cutoff, score floor
// [WHY] v1 无停用词表、无分数下限，with/use 等零区分度词也能让技能入选（review 实测）。
// [CONSTRAINT] 纯函数，不碰文件系统；停用词与阈值是效果唯一旋钮，改动需重跑真实语料回归。
// [retrieval-bm25-v1] BM25 核心（分词/停用词/阈值/打分）已抽到 ../retrieval/bm25.ts，与 lessons 检索共用。

import {
  B,
  DF_RATIO_MAX,
  K1,
  MAX_MATCHED,
  pickMatchedSpans,
  SCORE_FLOOR,
  scoreField,
  termFreq,
  tokenize,
} from '../retrieval/bm25.js'

export type { FieldStats } from '../retrieval/bm25.js'

export interface SkillDoc {
  name: string
  description: string
  path: string
  /** [skill-keywords-v1] 可选关键词，允许中英混排；用于补足 description 的语言缺口 */
  keywords?: string
}

export interface ScoredSkill {
  name: string
  path: string
  description: string
  score: number
  matched: string[]
}

const NAME_WEIGHT = 3
// [skill-keywords-v1] keywords 是人工标注的高信号词，权重居中：name 3 > keywords 2 > description 1
const KEYWORDS_WEIGHT = 2

export function rankSkills(query: string, docs: SkillDoc[], limit = 3): ScoredSkill[] {
  if (!query || !docs.length) return []
  const raw = Array.from(new Set(tokenize(query)))
  const qLower = String(query).toLowerCase()
  if (!raw.length) return []

  const nameStats: Array<{ tf: Map<string, number>, len: number }> = []
  const descStats: Array<{ tf: Map<string, number>, len: number }> = []
  const kwStats: Array<{ tf: Map<string, number>, len: number }> = []
  const df = new Map<string, number>()
  let nameLenSum = 0
  let descLenSum = 0
  let kwLenSum = 0

  for (const d of docs) {
    const nt = tokenize(d.name)
    const dt = tokenize(d.description)
    const kt = d.keywords ? tokenize(d.keywords) : []
    nameStats.push({ tf: termFreq(nt), len: nt.length })
    descStats.push({ tf: termFreq(dt), len: dt.length })
    kwStats.push({ tf: termFreq(kt), len: kt.length })
    nameLenSum += nt.length
    descLenSum += dt.length
    kwLenSum += kt.length
    for (const t of new Set([...nt, ...dt, ...kt])) df.set(t, (df.get(t) || 0) + 1)
  }

  const total = docs.length
  // [df-cutoff-v1] 丢弃出现在过多文档中的词：它们无区分度，且平滑后 idf 仍为正。
  const queryTerms = raw.filter(t => (df.get(t) || 0) / total <= DF_RATIO_MAX)
  if (!queryTerms.length) return []

  const avgName = nameLenSum / total
  const avgDesc = descLenSum / total
  const avgKw = kwLenSum / total

  const scored: ScoredSkill[] = []
  for (let i = 0; i < docs.length; i += 1) {
    const ns = scoreField(queryTerms, nameStats[i], df, total, avgName)
    const ds = scoreField(queryTerms, descStats[i], df, total, avgDesc)
    const ks = scoreField(queryTerms, kwStats[i], df, total, avgKw)
    const score = ns * NAME_WEIGHT + ks * KEYWORDS_WEIGHT + ds
    if (score < SCORE_FLOOR) continue
    const pool = new Set([...nameStats[i].tf.keys(), ...descStats[i].tf.keys(), ...kwStats[i].tf.keys()])
    const matched = pickMatchedSpans(qLower, queryTerms, pool, MAX_MATCHED)
    scored.push({ name: docs[i].name, path: docs[i].path, description: docs[i].description, score, matched })
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, limit)
}

// 保持既有导入方（测试）从本模块取 tokenize 的能力
export { B, DF_RATIO_MAX, K1, MAX_MATCHED, SCORE_FLOOR, tokenize }
