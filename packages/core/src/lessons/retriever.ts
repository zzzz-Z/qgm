// [lessons-retrieval-v1] lessons 检索器：按当前任务挑相关条目，替代「从文件尾截断注入」。
// [WHY] lessons.md 113 KB / 155 条，注入预算 6000 字符且从尾截断 ⇒ 实际进上下文 ≈ 5.3%，
//       95 条 [VERIFIED] 基本不在场。改为服务端 BM25 检索（复用 retrieval/bm25.ts）。
// [CONSTRAINT] 纯读取、不写盘；文件缺失/解析异常 → 返回空数组，不抛错（首问不得因它中断）。
//              不得 require 仓库根 scripts/*.cjs（运行产物无此文件）。
// [CHANGE-IMPACT] 被 routes/lessons.ts 的 POST /lessons/match 消费。

import fs from 'node:fs'
import path from 'node:path'
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

export interface LessonDoc {
  title: string
  body: string
  state: 'verified' | 'rejected' | 'stale' | 'pending'
}

export interface ScoredLesson {
  title: string
  body: string
  state: string
  score: number
  matched: string[]
}

// [lessons-split-v1] 严格 '## '（## + 空格）分条，跳过代码围栏——与 scripts/lessons-parse.cjs 同口径。
// 不得新造第四种切分口径（既有：lessons-parse.cjs 严格、client load-lessons 的 /^##\s/、attach-ws 的 ^## ）。
function splitLessonSections(md: string): Array<{ title: string, body: string }> {
  const lines = String(md || '').split(/\r?\n/)
  const out: Array<{ title: string, body: string }> = []
  let fence = false
  let curTitle = ''
  let curBody: string[] = []
  const flush = () => {
    if (curTitle) out.push({ title: curTitle, body: curBody.join('\n').trim() })
    curTitle = ''
    curBody = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence
    if (!fence && line.slice(0, 3) === '## ') {
      flush()
      curTitle = line.slice(3).trim()
      continue
    }
    if (curTitle) curBody.push(line)
  }
  flush()
  return out
}

// [lessons-state-v1] 取条目「首个非空行」是否匹配 [VERIFIED|REJECTED|STALE]；
// 语义与 client load-lessons.ts 的 isPendingEntry 一致（pending = 未标注）。
function stateOf(body: string): LessonDoc['state'] {
  const first = body.split('\n').find(l => l.trim() !== '') || ''
  const t = first.trim()
  if (/^\[VERIFIED\]/i.test(t)) return 'verified'
  if (/^\[REJECTED\]/i.test(t)) return 'rejected'
  if (/^\[STALE\]/i.test(t)) return 'stale'
  return 'pending'
}

/**
 * 读取并分条 .ai-runner/lessons.md。
 * [CONSTRAINT] 文件缺失 / 读取失败 → 返回 []，不抛错。
 */
export function listLessonDocs(root: string): LessonDoc[] {
  const abs = path.join(root, '.ai-runner', 'lessons.md')
  let md = ''
  try {
    if (!fs.existsSync(abs)) return []
    md = fs.readFileSync(abs, 'utf8')
  } catch { return [] }
  const sections = splitLessonSections(md)
  return sections.map(s => ({ title: s.title, body: s.body, state: stateOf(s.body) }))
}

const TITLE_WEIGHT = 3
const BODY_WEIGHT = 1

/**
 * 按 query 检索最相关的 lessons 条目。
 * [WHY] 字段 = 标题（权重 3）+ 正文（权重 1）；自写双字段循环，不套 rankSkills
 *       （后者是 name/keywords/desc 三字段，套用会引入空字段噪声）。
 * [CONSTRAINT] 复用 retrieval/bm25.ts 的 tokenize/termFreq/idfOf/scoreField/DF_RATIO_MAX/SCORE_FLOOR/K1/B。
 */
export function rankLessons(query: string, docs: LessonDoc[], limit = 3): ScoredLesson[] {
  if (!query || !docs.length) return []
  const raw = Array.from(new Set(tokenize(query)))
  const qLower = String(query).toLowerCase()
  if (!raw.length) return []

  const titleStats: Array<{ tf: Map<string, number>, len: number }> = []
  const bodyStats: Array<{ tf: Map<string, number>, len: number }> = []
  const df = new Map<string, number>()
  let titleLenSum = 0
  let bodyLenSum = 0

  for (const d of docs) {
    const tt = tokenize(d.title)
    const bt = tokenize(d.body)
    titleStats.push({ tf: termFreq(tt), len: tt.length })
    bodyStats.push({ tf: termFreq(bt), len: bt.length })
    titleLenSum += tt.length
    bodyLenSum += bt.length
    for (const t of new Set([...tt, ...bt])) df.set(t, (df.get(t) || 0) + 1)
  }

  const total = docs.length
  const queryTerms = raw.filter(t => (df.get(t) || 0) / total <= DF_RATIO_MAX)
  if (!queryTerms.length) return []

  const avgTitle = titleLenSum / total
  const avgBody = bodyLenSum / total

  const scored: ScoredLesson[] = []
  for (let i = 0; i < docs.length; i += 1) {
    const ts = scoreField(queryTerms, titleStats[i], df, total, avgTitle)
    const bs = scoreField(queryTerms, bodyStats[i], df, total, avgBody)
    const score = ts * TITLE_WEIGHT + bs * BODY_WEIGHT
    if (score < SCORE_FLOOR) continue
    const pool = new Set([...titleStats[i].tf.keys(), ...bodyStats[i].tf.keys()])
    const matched = pickMatchedSpans(qLower, queryTerms, pool, MAX_MATCHED)
    scored.push({ title: docs[i].title, body: docs[i].body, state: docs[i].state, score, matched })
  }

  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return scored.slice(0, limit)
}

// 保持常量可被测试引用（与 skills 侧对称）
export { B, DF_RATIO_MAX, K1, MAX_MATCHED, SCORE_FLOOR }
