// [lesson-autocapture-v1] 从 DONE 总结提取踩坑记录，自动追加到 .ai-runner/lessons.md
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'

export interface ExtractedLesson {
  title: string
  body: string
}

interface Heading { level: number, title: string, index: number }

// [no-regex-v1] 用逐行状态机而非正则：eslint 的 no-super-linear-backtracking
// 会拦截任何含相邻无界量词的表达式，而 Markdown 解析天然需要宽容匹配
function parseHeading(line: string): Heading | null {
  let level = 0
  while (level < line.length && line[level] === '#') level += 1
  if (level < 1 || level > 6) return null
  if (level >= line.length || line[level] !== ' ') return null
  const title = line.slice(level + 1).trim()
  if (!title) return null
  return { level, title, index: -1 }
}

function stripBullet(line: string): string | null {
  const t = line.trimStart()
  if (t.startsWith('- ') || t.startsWith('* ')) return t.slice(2).trim()
  return null
}

function splitTitleBody(raw: string): { title: string, body: string } | null {
  const s0 = raw.trim()
  // [lesson-title-boundary-v1-fix] 先记「有没有前导粗体」再剥，否则闭合探测恒假——
  //   旧写法 `if (s.startsWith('**')) s = s.slice(2)` 之后紧跟 `s.startsWith('**') ? ...`，
  //   前导标记已被剥掉 ⇒ close 恒为 -1 ⇒ 闭合粗体分支是死代码，一路落到「末冒号」。
  //   后果：正文含冒号（「原因：…」这类常态）时，末冒号切进正文，把正文前半截并进标题。
  const bolded = s0.startsWith('**')
  const s = bolded ? s0.slice(2) : s0
  const close = bolded ? s.indexOf('**') : -1
  if (close > 0) {
    const t = s.slice(0, close).trim()
    const b = s.slice(close + 2).replace(/^[\s:\uFF1A]+/, '').trim()
    if (t) return { title: t, body: b }
  }
  // 无闭合粗体时按**末**冒号切（原取首冒号会把 `shell: false` 这类标题腰斩）
  const ascii = s.lastIndexOf(':')
  const wide = s.lastIndexOf('\uFF1A')
  const cut = Math.max(ascii, wide)
  if (cut <= 0) return null
  const title = s.slice(0, cut).replace(/\*+$/, '').trim()
  const body = s.slice(cut + 1).trim()
  if (!title) return null
  return { title, body }
}

/**
 * 从 DONE 总结中提取「踩坑记录」段落的条目。
 * [WHY] lessons.md 之前只能人工追加，长期停在 seed 状态；DONE 总结里本就有踩坑信息，
 *       直接解析可让知识沉淀零成本。
 * [CONSTRAINT] 仅识别明确的「踩坑记录」标题，无该段落即返回空数组，绝不猜测。
 * [CHANGE-IMPACT] 只读解析，无副作用；调用方负责落盘与去重。
 * @param text DONE 回复的完整 Markdown
 */
export function extractLessons(text: string): ExtractedLesson[] {
  const src = String(text || '')
  if (!src) return []
  const all = src.split(/\r?\n/)

  let start = -1
  let level = 0
  for (let i = 0; i < all.length; i += 1) {
    const h = parseHeading(all[i])
    if (h && h.level >= 2 && h.level <= 3 && h.title === '踩坑记录') {
      start = i
      level = h.level
      break
    }
  }
  if (start < 0) return []

  let end = all.length
  for (let i = start + 1; i < all.length; i += 1) {
    const h = parseHeading(all[i])
    if (h && h.level <= level) { end = i; break }
  }
  const seg = all.slice(start + 1, end)

  const subs: { at: number, title: string }[] = []
  for (let i = 0; i < seg.length; i += 1) {
    const h = parseHeading(seg[i])
    if (h && h.level === 3) subs.push({ at: i, title: h.title })
  }

  const items: ExtractedLesson[] = []

  if (subs.length) {
    for (let i = 0; i < subs.length; i += 1) {
      const from = subs[i].at + 1
      const to = i + 1 < subs.length ? subs[i + 1].at : seg.length
      const body = seg.slice(from, to).join('\n').trim()
      items.push({ title: subs[i].title, body })
    }
    return items
  }

  for (const line of seg) {
    const raw = stripBullet(line)
    if (!raw) continue
    const tb = splitTitleBody(raw)
    if (tb) items.push(tb)
  }
  return items
}

function readLessons(file: string): string {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/**
 * 追加到 .ai-runner/lessons.md；标题已存在则跳过。
 * [WHY] 去重按标题而非全文——同一教训的不同措辞会重复出现，标题唯一性能抓住主要重复。
 * [CONSTRAINT] 文件不存在时静默跳过（不自动创建），避免在非项目根 cwd 下写脏数据。
 * [CHANGE-IMPACT] 返回实际追加条数；0 表示全部重复或写入失败。
 * @param items extractLessons 的返回值
 * @param rootDir 可选，覆盖 getRoot() 返回值（测试用）
 */
export function appendLessons(items: ExtractedLesson[], rootDir?: string): number {
  if (!items.length) return 0
  const root = rootDir || getRoot()
  const file = path.join(root, '.ai-runner', 'lessons.md')
  const cur = readLessons(file)
  if (!cur) return 0

  // [lesson-dedup-norm-v1] 归一化标题去重：去空白/反引号/冒号/标点后比对，
  // 避免「差一字 / 换个冒号位置」即视为新条（原精确匹配抓不住近重复）。
  const norm = (t: string): string => String(t || '').toLowerCase().replace(/[\s`:'"\uFF1A\u3001\u3002,.;!?()[\]{}|/<>~\-\u2014_*]+/g, '')
  const seen = new Set<string>()
  for (const line of cur.split('\n')) {
    const h = parseHeading(line)
    if (h && h.level === 2) seen.add(norm(h.title))
  }

  const fresh = items.filter(x => x.title && !seen.has(norm(x.title)))
  if (!fresh.length) return 0

  const entries = fresh.map(x => `## ${x.title}\n\n${x.body || '(待补充)'}\n`)
  const next = `${cur.trimEnd()}\n\n${entries.join('\n')}`
  try {
    fs.mkdirSync(path.join(root, '.ai-runner'), { recursive: true })
    fs.writeFileSync(file, next, 'utf8')
    return fresh.length
  } catch { return 0 }
}
