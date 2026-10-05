// [lesson-autocapture-v1] 从 DONE 总结提取踩坑记录，自动追加到 .ai-runner/lessons.md
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import { isNearDuplicateTitle } from './lesson-title-similarity.js'

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

/**
 * 位置 at 是否落在行内代码（反引号对内）里
 * [WHY] 标题/正文的分界冒号不能取行内代码里的那个。
 * [lesson-inline-code-runs-v1] 数**反引号连续段**（runs）的奇偶，而不是单个反引号的奇偶：
 *   CommonMark 允许用 `` `` `` 这类**多反引号定界**代码段，定界符本身贡献 2 个反引号 ⇒
 *   旧口径（数单个反引号）会把「双反引号段内的冒号」误判成段外，于是标题仍可能从代码中间劈开。
 *   段数奇偶对单/双/三反引号定界一律成立。写入边界另有 sanitizeTitle 兜底。
 * @param s - 待检字符串
 * @param at - 待检字符下标
 * @returns true = 位于未闭合的反引号对内
 */
function insideInlineCode(s: string, at: number): boolean {
  let runs = 0
  let prevIsTick = false
  const stop = Math.min(at, s.length)
  for (let i = 0; i < stop; i += 1) {
    const isTick = s[i] === '`'
    if (isTick && !prevIsTick) runs += 1
    prevIsTick = isTick
  }
  return runs % 2 === 1
}

/**
 * 从右往左找第一个「不在行内代码里」的冒号（半角或全角）
 * [WHY] 无粗体列表按末冒号切标题；但 `docs:verify` 这类含冒号的行内代码令牌会被
 *   从中间劈开，产出反引号不配对、正文首截并进标题的破损条目（实测发生过两次）。
 * @param s - 已剥掉前导粗体标记的整行
 * @returns 下标；找不到返回 -1
 */
function lastSeparatorColon(s: string): number {
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const c = s[i]
    if (c !== ':' && c !== '\uFF1A') continue
    if (insideInlineCode(s, i)) continue
    return i
  }
  return -1
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
  // [lesson-colon-in-code-v1] 但行内代码里的冒号不算分界：`docs:verify` 被从中间劈开
  //   会产出「反引号不配对 + 正文首截并进标题」的破损条目（实测已发生两次）。
  const cut = lastSeparatorColon(s)
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
 * 落盘前把标题规范成「单行 + 反引号配对」
 * [WHY] 台账的解析契约是「按 `## ` 切条 + 状态写在标题后首个非空行」。标题一旦跨行或
 *   反引号悬空，后续解析会把正文首段当成标题延续，lessons-hygiene 守卫也会直接变红
 *   （实测：应用端两次 DONE 采集因此把 `pnpm verify` 由绿转红）。
 *   提取侧的两条路径都可能产出破损标题（`###` 折行只取一行 / 行内代码被冒号劈开），
 *   在写入边界兜一层不变量比逐个修补提取路径更稳。
 * [CONSTRAINT] 只规范化，不改语义：折行并回一行、悬空反引号就地补闭合。
 * [CHANGE-IMPACT] 由 post-run-lesson-extract.node-test.ts 的破损标题用例守卫。
 * @param t - 提取出的原始标题
 * @returns 合法的单行标题（反引号数为偶数）
 */
function sanitizeTitle(t: string): string {
  const one = String(t || '').replace(/\s*\n\s*/g, ' ').trim()
  const ticks = (one.match(/`/g) || []).length
  return ticks % 2 === 1 ? `${one}\`` : one
}

/**
 * 剥掉正文**开头连续**的 `补充（YYYY-MM-DD）：` 前缀。
 * [WHY] 同一段补充正文会经过两条加前缀的路径：同批并入（nearFresh）在正文里自带前缀、
 *   写入层（merged 分支）再加一次 ⇒ 出现 `补充（A）：补充（A）：…` 双前缀；
 *   更糟的是并入段被插到标题正下方，把**状态行**（首个非空行）挤到非首位 ——
 *   `lessons-hygiene` 的「状态行只在标题后首个非空行」会直接变红（实测 2026-10-05）。
 *   前缀只允许有一个，且只能出现在正文段首 ⇒ 写入边界统一加，入口先把既有前缀剥掉。
 * [CONSTRAINT] 只剥开头、只剥同形（日期版），正文内部出现的同字样不动。
 * @param s 原始正文
 * @returns 去掉前缀并 trim 后的正文
 */
function stripSupplementPrefix(s: string): string {
  let t = String(s || '')
  for (let i = 0; i < 3; i += 1) {
    const m = t.match(/^\s*补充（\d{4}-\d{2}-\d{2}）：\s*/)
    if (!m) break
    t = t.slice(m[0].length)
  }
  return t.trim()
}

/**
 * 追加到 .ai-runner/lessons.md；标题已存在则跳过。
 * [WHY] 去重按标题而非全文——同一教训的不同措辞会重复出现，标题唯一性能抓住主要重复。
 * [CONSTRAINT] 文件不存在时静默跳过（不自动创建），避免在非项目根 cwd 下写脏数据。
 * [CHANGE-IMPACT] 返回**处理的条目数**（新增 + 并入既有 + 并入同批），0 表示全部重复或写入失败。
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

  const existingTitles: string[] = []
  for (const line of cur.split('\n')) {
    const h = parseHeading(line)
    if (h && h.level === 2) existingTitles.push(h.title)
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const fresh: ExtractedLesson[] = []
  const merged = new Map<string, string[]>()
  let handled = 0
  for (const item of items) {
    const title = sanitizeTitle(item.title)
    if (!title || seen.has(norm(title))) continue
    handled += 1
    // [scenario-B-merge-v1] merged 的 key 只能是**原文件已有**的标题：
    //   写入阶段按行扫 `## <key>` 命中，key 若是本轮新标题，原文件里没有那行，
    //   并入内容就无处可写、静默蒸发（旧实现即如此）。
    const nearExisting = existingTitles.find(t => isNearDuplicateTitle(t, title))
    if (nearExisting) {
      const arr = merged.get(nearExisting) || []
      arr.push(item.body || '(待补充)')
      merged.set(nearExisting, arr)
      continue
    }
    // 同批内的近重复：就地并入已在 fresh 里的那条，不另开条目也不丢正文。
    const nearFresh = fresh.find(f => isNearDuplicateTitle(f.title, title))
    if (nearFresh) {
      nearFresh.body = [nearFresh.body, `补充（${stamp}）：${stripSupplementPrefix(item.body || '(待补充)')}`]
        .filter(Boolean)
        .join('\n\n')
      continue
    }
    fresh.push({ title, body: item.body })
  }
  if (merged.size) {
    for (const [k, v] of merged) console.warn(`[lessons] 近重复并入既有条目「${k}」：${v.length} 条`)
  }
  if (!handled) return 0
  let base = cur.trimEnd()
  if (merged.size) {
    const lines = base.split('\n')
    const out: string[] = []
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i])
      if (!lines[i].startsWith('## ')) continue
      const title = lines[i].slice(3).trim()
      const bodies = merged.get(title)
      if (!bodies) continue
      let end = lines.length
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].startsWith('## ')) { end = j; break }
      }
      // [lesson-merge-append-v1] 补充段一律**追加在条目正文之后**，绝不插到标题正下方：
      //   台账契约是「状态行 = 标题后首个非空行」，插到标题下会把 [VERIFIED]/[REJECTED]
      //   挤成散文引用（`lessons-hygiene` 红，实测 2026-10-05）；前缀在写入边界统一加。
      const body = lines.slice(i + 1, end)
      while (body.length && !body[body.length - 1].trim()) body.pop()
      out.push(...body)
      for (const b of bodies) out.push('', `补充（${stamp}）：${stripSupplementPrefix(b)}`)
      out.push('')
      i = end - 1
    }
    base = out.join('\n')
  }
  const entries = fresh.map(x => `## ${x.title}\n\n${x.body || '(待补充)'}\n`)
  const next = entries.length ? `${base}\n\n${entries.join('\n')}` : `${base}\n`
  try {
    fs.mkdirSync(path.join(root, '.ai-runner'), { recursive: true })
    fs.writeFileSync(file, next, 'utf8')
    return handled
  } catch (error) {
    // [append-lessons-write-fail-v1] 写盘失败必须与「全部重复」区分：
    //   旧实现 catch { return 0 } 把两种语义压成同一个返回值，
    //   调用方（lessons-add）只能报「标题重复」，真因被掩盖。
    throw new Error(`appendLessons write failed: ${String((error as Error)?.message ?? error)}`)
  }
}
