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
import { createRequire } from 'node:module'
import { jaccardSimilarity, LESSON_DUP_THRESHOLD, lessonTitleBigrams, normLessonTitle } from '../../../packages/core/src/post-run/lesson-title-similarity.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const FILE = path.join(ROOT, '.ai-runner', 'lessons.md')
const NL = String.fromCharCode(10)
// [lesson-dedup-shared-v1] 阈值从共享模块取，与写入侧同源（不得本地再写一份 0.35）
const THRESHOLD = LESSON_DUP_THRESHOLD

interface LessonItem {
  title: string
  status: string
}

/**
 * 解析成条目数组：`## 标题` + 标题后首个非空行作为状态行。
 * [CONSTRAINT] 与 `scripts/lessons-status.cjs` 同口径——只认首个非空行，
 *   正文里出现的 `[VERIFIED]` 是散文引用，不算状态。
 */
// [lessons-parse-shared-v1] 解析实现从共享模块引入：与 lessons-status.cjs 同源。
const require = createRequire(import.meta.url)
const { parseLessons: sharedParseLessons } = require('../../../scripts/lessons-parse.cjs') as {
  parseLessons: (raw: string) => Array<{ title: string, status: string }>
}

function parseLessons(raw: string): LessonItem[] {
  return sharedParseLessons(raw).map(x => ({ title: x.title, status: x.status }))
}

/**
 * 标题归一化：剥掉代码标记与一切非「字母/数字/CJK」字符，再小写。
 * [CONSTRAINT] 故意保留 CJK——近重复恰恰表现为「中文主体相同、只差一个语气词/标点」。
 */
// [lesson-dedup-shared-v1] 三件套已抽到共享模块：写入侧与守卫侧同源，消除「两套口径」。
const normTitle = normLessonTitle
const bigrams = lessonTitleBigrams
const jaccard = jaccardSimilarity

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

describe('lessons 解析器共享与围栏跳过', () => {
  it('跳过代码围栏：围栏内的 ## 行不算条目', () => {
    const fenced = [
      '## 真条目',
      '正文',
      '```text',
      '## 示例标题（在围栏里）',
      '示例正文',
      '```',
      '## 另一真条目',
      '正文2',
    ].join(NL)
    expect(parseLessons(fenced).map(x => x.title)).toEqual(['真条目', '另一真条目'])
  })

  it('与 scripts/lessons-status.cjs 同源（共享解析模块）', () => {
    const shared = path.join(ROOT, 'scripts', 'lessons-parse.cjs')
    expect(fs.existsSync(shared), `${shared} 不存在`).toBe(true)
    const statusSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lessons-status.cjs'), 'utf8')
    expect(statusSrc.includes('./lessons-parse.cjs')).toBe(true)
  })
})
