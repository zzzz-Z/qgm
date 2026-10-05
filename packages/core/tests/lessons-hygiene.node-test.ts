// [lessons-hygiene-v1] lessons.md 卫生守卫。
// WHY: 采集是自动的（DONE 总结 → attach-ws.ts），复核是人工的 ⇒ 无闸门时待复核会单调膨胀，
//   且同一坑被反复记录成「不同标题的近重复」（实测 2026-10-05 前：117 条里 84 条待复核、
//   同族最多 7 条）。D-0a/D-0b 修的是「写入链路」（标题腰斩 + 精确标题去重），
//   本守卫补的是「存量形状」：近重复、结构破损、待复核比例失控、防误归因条目被误删。
// CHANGE-IMPACT: 阈值是 ratchet——收紧只会让后续新条目更难通过，不会让既有存量变红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const FILE = path.join(ROOT, '.ai-runner', 'lessons.md')
const NL = String.fromCharCode(10)
const STATES = ['VERIFIED', 'REJECTED', 'STALE']
const THRESHOLD = 0.35

interface LessonItem {
  title: string
  status: string
}

/**
 * 解析成条目数组：`## 标题` + 标题后首个非空行作为状态行。
 * [CONSTRAINT] 与 `scripts/lessons-status.cjs` 同口径——只认首个非空行，
 *   正文里出现的 `[VERIFIED]` 是散文引用，不算状态。
 */
function parseLessons(raw: string): LessonItem[] {
  const lines = String(raw || '').replace(/\r\n/g, NL).split(NL)
  const items: LessonItem[] = []
  let cur: LessonItem | null = null
  let expecting = false
  for (const line of lines) {
    if (line.slice(0, 3) === '## ') {
      cur = { title: line.slice(3).trim(), status: 'UNVERIFIED' }
      if (cur.title) items.push(cur)
      expecting = true
      continue
    }
    if (!cur || !expecting) continue
    if (!line.trim()) continue
    expecting = false
    const m = line.trim().match(/^\[([a-z]+)\]/i)
    if (m && STATES.includes(m[1].toUpperCase())) cur.status = m[1].toUpperCase()
  }
  return items
}

/**
 * 标题归一化：剥掉代码标记与一切非「字母/数字/CJK」字符，再小写。
 * [CONSTRAINT] 故意保留 CJK——近重复恰恰表现为「中文主体相同、只差一个语气词/标点」。
 */
function normTitle(t: string): string {
  return String(t)
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4E00-\u9FA5]+/g, '')
}

/** 归一化标题的字符二元组集合，用来算 Jaccard（比整串相等宽容、比中文分词稳定）。 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) {
    if (b.has(x)) inter += 1
  }
  return inter / (a.size + b.size - inter)
}

const raw = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null
const items = raw === null ? [] : parseLessons(raw)

describe('lessons.md 卫生', () => {
  it('文件存在且可解析出条目', () => {
    expect(raw, `${FILE} 不存在`).not.toBeNull()
    expect(items.length).toBeGreaterThan(20)
  })

  it('无近重复标题（归一化二元组 Jaccard ≥ 0.35 即视为同族残留）', () => {
    // [阈值依据 2026-10-05] 实测：当时 56 条的合法条目两两最高 Jaccard = 0.267；
    //   真实近重复对（vitest 缓存 / 上游截断 / shell 切词，均为已合并的族）为 0.44–0.86。
    //   取 0.35 使判据承重（注入真实近重复标题会红）且不误报。
    const groups = items.map(x => ({ title: x.title, grams: bigrams(normTitle(x.title)) }))
    const dup: string[] = []
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        if (groups[i].grams.size < 6 || groups[j].grams.size < 6) continue
        const r = jaccard(groups[i].grams, groups[j].grams)
        if (r >= THRESHOLD) dup.push(`${r.toFixed(2)}  「${groups[i].title}」 ↔ 「${groups[j].title}」`)
      }
    }
    expect(dup, `近重复标题（请合并为单条 SSOT，或改写标题以示区分）：${NL}${dup.join(NL)}`).toEqual([])
  })

  it('无破损标题（反引号未闭合 = splitTitleBody 腰斩的残留）', () => {
    const bad: string[] = []
    for (const line of String(raw || '').replace(/\r\n/g, NL).split(NL)) {
      if (line.slice(0, 3) !== '## ') continue
      if ((line.match(/`/g) || []).length % 2 === 1) bad.push(line.slice(0, 80))
    }
    expect(bad, `标题反引号数为奇数：${NL}${bad.join(NL)}`).toEqual([])
  })

  it('待复核比例 ≤ 30%（ratchet：治理后不得再堆积到「日志化」）', () => {
    const pending = items.filter(x => x.status === 'UNVERIFIED')
    const ratio = pending.length / Math.max(1, items.length)
    const head = pending.slice(0, 5).map(x => `  - ${x.title}`).join(NL)
    expect(
      ratio,
      `待复核 ${pending.length}/${items.length} = ${(ratio * 100).toFixed(1)}%，超 30% 上限。前 5 条：${NL}${head}`,
    ).toBeLessThanOrEqual(0.3)
  })

  it('防误归因的 [REJECTED] 条目未被清空（≥ 3 条）', () => {
    const rejected = items.filter(x => x.status === 'REJECTED')
    expect(rejected.length, 'REJECTED 条目被清空 = 拆掉了防误归因护栏').toBeGreaterThanOrEqual(3)
  })

  it('状态行只在标题后的首个非空行（正文里的 [VERIFIED] 引用不算数）', () => {
    const lines = String(raw || '').replace(/\r\n/g, NL).split(NL)
    let cur = ''
    let expecting = false
    const late: string[] = []
    for (const line of lines) {
      if (line.slice(0, 3) === '## ') {
        cur = line.slice(3).trim()
        expecting = true
        continue
      }
      if (!cur || !line.trim()) continue
      const isState = /^\[(?:VERIFIED|REJECTED|STALE)\]/i.test(line.trim())
      if (expecting) {
        expecting = false
        continue
      }
      if (isState) late.push(cur.slice(0, 60))
    }
    expect(late, `状态行出现在非首行（会被当成散文引用，状态丢失）：${NL}${late.join(NL)}`).toEqual([])
  })
})
